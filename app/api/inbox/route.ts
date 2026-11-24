import { NextRequest, NextResponse } from 'next/server';
import { filterByPage, requireScopedUser } from '@/lib/access';
import { requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchPageInbox, inboxEnabled, listConnectedPages, type ConnectedPage } from '@/lib/inbox/server';
import { filterInbox, type InboxFilter, type InboxItem, type InboxKind } from '@/lib/inbox/normalize';

// GET /api/inbox?page=<facebook_page_id|all>&kinds=comment,message&filter=needs_reply|all|done
// Live comments and messages from Meta for connected pages. Nothing is stored except "done" marks.

export const maxDuration = 60;

const MISSING_TABLE = new Set(['42P01', 'PGRST205']);
const ALL_PAGES_MAX = 20;
const FB_PAGE_ID_RE = /^\d{5,25}$/;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth();
  if (authError) return authError;
  if (!inboxEnabled()) return NextResponse.json({ enabled: false, pages: [], items: [] });

  const params = new URL(request.url).searchParams;
  const pageParam = params.get('page') || '';
  const kinds = (params.get('kinds') || 'comment,message').split(',').filter((k): k is InboxKind => k === 'comment' || k === 'message');
  const filterParam = params.get('filter');
  const filter: InboxFilter = filterParam === 'all' || filterParam === 'done' ? filterParam : 'needs_reply';

  const supabase = createServiceClient();
  let pages: ConnectedPage[];
  try {
    pages = await listConnectedPages(supabase);
  } catch (err) {
    if (MISSING_TABLE.has(String((err as { code?: string }).code))) return NextResponse.json({ enabled: true, migrationNeeded: true, pages: [], items: [] });
    console.error('inbox GET pages', err);
    return NextResponse.json({ error: 'Failed to load connected pages' }, { status: 500 });
  }

  {
    const scoped = await requireScopedUser();
    if (scoped.error) return scoped.error;
    pages = filterByPage(scoped.scope, pages);   // only pages this user can access on Facebook
  }
  if (!pageParam) return NextResponse.json({ enabled: true, pages, items: [] });
  if (pageParam !== 'all' && !FB_PAGE_ID_RE.test(pageParam)) return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
  const active = pages.filter((p) => p.status === 'active');
  const targets = pageParam === 'all' ? active.slice(0, ALL_PAGES_MAX) : active.filter((p) => p.facebook_page_id === pageParam);
  if (targets.length === 0 || kinds.length === 0) return NextResponse.json({ enabled: true, pages, items: [], errors: pageParam === 'all' ? [] : ['This page is not connected for the inbox.'] });

  const results = await mapLimit(targets, 4, (p) => fetchPageInbox(supabase, p.facebook_page_id, kinds));
  const items: InboxItem[] = results.flatMap((r) => r.items);
  const errors = results.flatMap((r) => r.errors);
  if (pageParam === 'all' && active.length > ALL_PAGES_MAX) errors.push(`Showing the first ${ALL_PAGES_MAX} pages; pick a page to see the rest.`);

  const done = new Set<string>();
  const keys = items.map((i) => i.key);
  for (let i = 0; i < keys.length; i += 300) {
    const { data } = await supabase.from('fb_inbox_state').select('item_key').in('item_key', keys.slice(i, i + 300));
    for (const r of (data || []) as { item_key: string }[]) done.add(r.item_key);
  }

  const shown = filterInbox(items, done, filter).slice(0, 300).map((i) => ({ ...i, done: done.has(i.key) }));
  return NextResponse.json({
    enabled: true,
    pages: await refreshedPages(supabase, pages, errors),
    items: shown,
    counts: { needs_reply: filterInbox(items, done, 'needs_reply').length, all: items.length },
    errors,
  });
}

/** Re-read page statuses if a fetch just flagged one for reconnecting. */
async function refreshedPages(supabase: ReturnType<typeof createServiceClient>, pages: ConnectedPage[], errors: string[]): Promise<ConnectedPage[]> {
  if (!errors.some((e) => e.includes('Reconnect'))) return pages;
  try { return await listConnectedPages(supabase); } catch { return pages; }
}
