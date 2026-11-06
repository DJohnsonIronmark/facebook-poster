import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { TOKEN_COOKIE, cookieOptions, listManagedPages, openToken } from '@/lib/facebook/oauth';

// GET - pages the connected Facebook account manages, flagged if already in facebook_pages
export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;

  const token = openToken(request.cookies.get(TOKEN_COOKIE)?.value, user.id);
  if (!token) return NextResponse.json({ connected: false, pages: [] });

  try {
    const pages = await listManagedPages(token);
    const supabase = createServiceClient();
    const { data: existing } = await supabase
      .from('facebook_pages').select('facebook_page_id').in('facebook_page_id', pages.map((p) => p.id));
    const have = new Set((existing || []).map((r: any) => String(r.facebook_page_id)));
    return NextResponse.json({
      connected: true,
      pages: pages.map((p) => ({ ...p, already_added: have.has(p.id) })),
    });
  } catch (err) {
    console.error('[facebook] list pages failed', err);
    const res = NextResponse.json({ connected: false, pages: [], error: 'Facebook session expired. Connect again.' });
    res.cookies.set(TOKEN_COOKIE, '', cookieOptions(0));
    return res;
  }
}

// DELETE - disconnect (drop the token cookie)
export async function DELETE() {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;
  const res = NextResponse.json({ success: true });
  res.cookies.set(TOKEN_COOKIE, '', cookieOptions(0));
  return res;
}
