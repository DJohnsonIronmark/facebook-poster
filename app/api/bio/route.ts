import { NextRequest, NextResponse } from 'next/server';
import { canSeePage, filterByPage, noPageAccess, pageIdsForInstagram, requireScopedUser } from '@/lib/access';
import { revalidatePath } from 'next/cache';
import { requireAuth, requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { IG_USER_ID_RE } from '@/lib/instagram/rules';
import { cleanBioButtons, cleanBioSlug, cleanBioTitle, slugFromUsername } from '@/lib/bio/rules';
import { BIO_COLUMNS, type BioSettings } from '@/lib/bio/server';

// Link in bio settings, one per Instagram account linked on the Pages tab.
// GET (signed-in): accounts + their settings. PUT (admin/manager): create or update one account's page.

const MISSING_TABLE = new Set(['42P01', 'PGRST205', '42703']);

export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const supabase = createServiceClient();
  const { data: allPages, error } = await supabase
    .from('facebook_pages').select('location_name, ig_user_id, ig_username, facebook_page_id').not('ig_user_id', 'is', null).order('location_name');
  if (error) {
    console.error('bio GET pages', error);
    return NextResponse.json({ error: 'Failed to load Instagram accounts' }, { status: 500 });
  }
  const scoped = await requireScopedUser();
  if (scoped.error) return scoped.error;
  const pages = filterByPage(scoped.scope, (allPages || []) as { facebook_page_id: string; location_name: string; ig_user_id: string; ig_username: string | null }[]);

  const { data: settings, error: settingsErr } = await supabase.from('fb_bio_pages').select(BIO_COLUMNS);
  if (settingsErr) {
    if (MISSING_TABLE.has(String(settingsErr.code))) {
      return NextResponse.json({ accounts: [], migrationNeeded: true });
    }
    console.error('bio GET settings', settingsErr);
    return NextResponse.json({ error: 'Failed to load link in bio pages' }, { status: 500 });
  }
  const byIg = new Map(((settings || []) as BioSettings[]).map((s) => [s.ig_user_id, s]));

  const accounts = new Map<string, { ig_user_id: string; ig_username: string | null; page_names: string[]; settings: BioSettings | null; suggested_slug: string | null }>();
  for (const p of (pages || []) as { location_name: string; ig_user_id: string; ig_username: string | null }[]) {
    const a = accounts.get(p.ig_user_id) || {
      ig_user_id: p.ig_user_id, ig_username: null, page_names: [], settings: byIg.get(p.ig_user_id) || null, suggested_slug: null,
    };
    a.ig_username = a.ig_username || p.ig_username;
    a.page_names.push(p.location_name);
    a.suggested_slug = slugFromUsername(a.ig_username);
    accounts.set(p.ig_user_id, a);
  }
  return NextResponse.json({ accounts: Array.from(accounts.values()) });
}

export async function PUT(request: NextRequest) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;

  const body = await request.json().catch(() => ({}));
  const igUserId = String(body?.ig_user_id ?? '').trim();
  if (!IG_USER_ID_RE.test(igUserId)) return NextResponse.json({ error: 'Invalid Instagram account' }, { status: 400 });
  {
    const scoped = await requireScopedUser(['admin', 'manager']);
    if (scoped.error) return scoped.error;
    const linked = await pageIdsForInstagram(scoped.supabase, igUserId);
    if (!linked.some((id) => canSeePage(scoped.scope, id))) return noPageAccess();
  }
  const slug = cleanBioSlug(body?.slug);
  if (!slug.ok) return NextResponse.json({ error: slug.error }, { status: 400 });
  const title = cleanBioTitle(body?.title);
  if (!title.ok) return NextResponse.json({ error: title.error }, { status: 400 });
  const buttons = cleanBioButtons(body?.buttons);
  if (!buttons.ok) return NextResponse.json({ error: buttons.error }, { status: 400 });
  const enabled = body?.enabled === true;

  const supabase = createServiceClient();
  const { data: linked } = await supabase.from('facebook_pages').select('id').eq('ig_user_id', igUserId).limit(1);
  if (!linked || linked.length === 0) {
    return NextResponse.json({ error: 'No page on the Pages tab is linked to this Instagram account' }, { status: 400 });
  }

  const { data: previous } = await supabase.from('fb_bio_pages').select('slug').eq('ig_user_id', igUserId).maybeSingle();
  const { data, error } = await supabase
    .from('fb_bio_pages')
    .upsert({
      ig_user_id: igUserId,
      slug: slug.value,
      title: title.value,
      buttons: buttons.value,
      enabled,
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'ig_user_id' })
    .select(BIO_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'That page address is already used by another account' }, { status: 409 });
    console.error('bio PUT', error);
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }

  revalidatePath(`/l/${slug.value}`);
  if (previous?.slug && previous.slug !== slug.value) revalidatePath(`/l/${previous.slug}`);
  return NextResponse.json({ settings: data });
}
