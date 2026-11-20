import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { PAGE_CURSOR_RE, TOKEN_COOKIE, cookieOptions, listManagedPagesChunk, openToken } from '@/lib/facebook/oauth';

// GET - one chunk (up to 300) of the pages the connected Facebook account manages, flagged if already
// in facebook_pages. ?after=<cursor> continues; the response's next_after is null when there are no more.
// The browser keeps calling until next_after is null, so there is no fixed page limit.
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;

  const token = openToken(request.cookies.get(TOKEN_COOKIE)?.value, user.id);
  if (!token) return NextResponse.json({ connected: false, pages: [], next_after: null });

  const rawAfter = new URL(request.url).searchParams.get('after');
  const after = rawAfter && rawAfter.length > 0 ? rawAfter : null;
  if (after !== null && !PAGE_CURSOR_RE.test(after)) {
    return NextResponse.json({ error: 'Invalid page cursor' }, { status: 400 });
  }

  try {
    const chunk = await listManagedPagesChunk(token, after);
    const supabase = createServiceClient();
    const ids = chunk.pages.map((p) => p.id);
    const { data: existing } = ids.length > 0
      ? await supabase.from('facebook_pages').select('facebook_page_id').in('facebook_page_id', ids)
      : { data: [] as { facebook_page_id: string }[] };
    const have = new Set((existing || []).map((r: { facebook_page_id: string }) => String(r.facebook_page_id)));
    return NextResponse.json({
      connected: true,
      pages: chunk.pages.map((p) => ({ ...p, already_added: have.has(p.id) })),
      next_after: chunk.after,
    });
  } catch (err) {
    console.error('[facebook] list pages failed', err instanceof Error ? err.message : err);
    if (after !== null) {
      // A later chunk failed: keep the session so the rest can be retried; the pages already shown stay
      return NextResponse.json({ connected: true, pages: [], next_after: after, error: 'Facebook stopped answering while loading your pages.' }, { status: 502 });
    }
    const res = NextResponse.json({ connected: false, pages: [], next_after: null, error: 'Facebook session expired. Connect again.' });
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
