import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UUID_RE } from '@/lib/review/guards';
import { TOKEN_COOKIE, cookieOptions } from '@/lib/facebook/oauth';
import { IG_USER_ID_RE, cleanIgUsername } from '@/lib/instagram/rules';

const PAGE_COLUMNS = 'id, location_name, location_number, facebook_page_id, city, base_url, phone, ig_user_id, ig_username, client_id, created_at';
const FB_PAGE_ID_RE = /^\d{5,25}$/;

interface PageInput {
  facebook_page_id: string;
  location_name: string;
  location_number: string | null;
  city: string | null;
  base_url: string | null;
  phone: string | null;
  ig_user_id: string | null;
  ig_username: string | null;
}

const opt = (v: unknown, max: number) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};

/** Validate one page row; returns the cleaned row or an error message */
function cleanPage(raw: any): PageInput | string {
  const id = String(raw?.facebook_page_id ?? '').trim();
  if (!FB_PAGE_ID_RE.test(id)) return 'Facebook page ID must be the numeric page ID';
  const name = opt(raw?.location_name, 200);
  if (!name) return 'Page name is required';
  const baseUrl = opt(raw?.base_url, 500);
  if (baseUrl) {
    try {
      if (!/^https?:$/.test(new URL(baseUrl).protocol)) return 'Website must start with http:// or https://';
    } catch {
      return 'Website must be a full URL (https://…)';
    }
  }
  // Instagram Business/Creator account linked to the page (optional; required for Instagram posts)
  const igUserId = String(raw?.ig_user_id ?? '').trim();
  if (igUserId && !IG_USER_ID_RE.test(igUserId)) return 'Instagram account ID must be the numeric ID (5–25 digits)';
  const igUsername = cleanIgUsername(raw?.ig_username);
  if (igUsername === null) return 'Instagram username can only use letters, numbers, periods and underscores (max 30)';
  return {
    ig_user_id: igUserId || null,
    ig_username: igUsername || null,
    facebook_page_id: id,
    location_name: name,
    location_number: opt(raw?.location_number, 40),
    city: opt(raw?.city, 120),
    base_url: baseUrl,
    phone: opt(raw?.phone, 40),
  };
}

// GET - all pages (signed-in users)
export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const supabase = createServiceClient();
  const { data, error } = await supabase.from('facebook_pages').select(PAGE_COLUMNS).order('location_name');
  if (error) {
    console.error('pages GET', error);
    return NextResponse.json({ error: 'Failed to fetch pages' }, { status: 500 });
  }
  return NextResponse.json({ pages: data });
}

// POST - add pages, manually or imported from Facebook (admin/manager)
//   { pages: [{ facebook_page_id, location_name, location_number?, city?, base_url?, phone? }],
//     client_id?: uuid, source?: 'manual' | 'facebook' }
export async function POST(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const rows: any[] = Array.isArray(body.pages) ? body.pages : [];
  if (rows.length === 0) return NextResponse.json({ error: 'No pages provided' }, { status: 400 });
  if (rows.length > 500) return NextResponse.json({ error: 'Max 500 pages at once' }, { status: 400 });

  const supabase = createServiceClient();
  let clientId: string | null = null;
  if (body.client_id) {
    if (!UUID_RE.test(String(body.client_id))) return NextResponse.json({ error: 'Invalid client' }, { status: 400 });
    const { data: client } = await supabase.from('fb_clients').select('id').eq('id', body.client_id).maybeSingle();
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 400 });
    clientId = client.id;
  }

  const problems: string[] = [];
  const cleaned: PageInput[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const r = cleanPage(raw);
    if (typeof r === 'string') problems.push(`${raw?.location_name || `Row ${i + 1}`}: ${r}`);
    else if (seen.has(r.facebook_page_id)) problems.push(`${r.location_name}: duplicate in this request`);
    else { seen.add(r.facebook_page_id); cleaned.push(r); }
  });

  // Skip pages already in the table (matched on Facebook page ID)
  const { data: existing } = await supabase
    .from('facebook_pages').select('facebook_page_id, location_name').in('facebook_page_id', cleaned.map((r) => r.facebook_page_id));
  const have = new Map((existing || []).map((r: any) => [String(r.facebook_page_id), r.location_name]));
  const toInsert = cleaned.filter((r) => {
    if (have.has(r.facebook_page_id)) {
      problems.push(`${r.location_name}: already added (as "${have.get(r.facebook_page_id)}")`);
      return false;
    }
    return true;
  });

  let added: any[] = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase
      .from('facebook_pages').insert(toInsert.map((r) => ({ ...r, client_id: clientId }))).select(PAGE_COLUMNS);
    if (error) {
      console.error('pages POST', error);
      return NextResponse.json({ error: 'Failed to add pages' }, { status: 500 });
    }
    added = data || [];
  }

  const res = NextResponse.json({ success: added.length > 0, added, problems });
  // Facebook import is one-shot: drop the Facebook token once pages are imported
  if (body.source === 'facebook' && added.length > 0) res.cookies.set(TOKEN_COOKIE, '', cookieOptions(0));
  return res;
}

// PATCH - edit a page's details (admin/manager). Page ID is not editable; add a new page instead.
export async function PATCH(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Valid page id required' }, { status: 400 });

  const supabase = createServiceClient();
  const { data: current } = await supabase.from('facebook_pages').select('facebook_page_id').eq('id', id).maybeSingle();
  if (!current) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const r = cleanPage({ ...body, facebook_page_id: current.facebook_page_id });
  if (typeof r === 'string') return NextResponse.json({ error: r }, { status: 400 });

  const { data, error } = await supabase
    .from('facebook_pages')
    .update({
      location_name: r.location_name, location_number: r.location_number, city: r.city, base_url: r.base_url, phone: r.phone,
      ig_user_id: r.ig_user_id, ig_username: r.ig_username,
    })
    .eq('id', id)
    .select(PAGE_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: 'Failed to update page' }, { status: 500 });
  return NextResponse.json({ page: data });
}
