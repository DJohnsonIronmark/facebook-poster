import { NextRequest, NextResponse } from 'next/server';
import { canSeePage, filterByPage, noPageAccess, requireScopedUser, visiblePageIds } from '@/lib/access';
import { requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { analyticsEnabled } from '@/lib/analytics/collect';

// GET /api/analytics?client=<uuid|all|none>&page=<facebook_page_id>&platform=<facebook|instagram|all>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Facebook / Instagram analytics for posts published in the range (any signed-in role may view).
// Returns totals, a per-day series (by publish date), top posts, follower change per account, and
// every post row (for the CSV export).

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

interface MetricRow {
  platform: string; platform_post_id: string; facebook_page_id: string; published_at: string | null;
  media_type: string | null; caption: string | null; permalink: string | null;
  views: number | null; reach: number | null; reactions: number | null; comments: number | null; shares: number | null;
  saves: number | null; clicks: number | null; video_views: number | null; engagements: number | null;
  last_error: string | null; fetched_at: string;
}

const add = (a: number, b: number | null) => a + (b || 0);

export async function GET(request: NextRequest) {
  const auth = await requireScopedUser();
  if (auth.error) return auth.error;

  const q = new URL(request.url).searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = DATE_RE.test(q.get('from') || '') ? q.get('from')! : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = DATE_RE.test(q.get('to') || '') ? q.get('to')! : today;
  const platform = q.get('platform') === 'facebook' || q.get('platform') === 'instagram' ? q.get('platform')! : 'all';
  const client = q.get('client') || 'all';
  const page = /^[0-9]{5,25}$/.test(q.get('page') || '') ? q.get('page')! : null;
  if (client !== 'all' && client !== 'none' && !UUID_RE.test(client)) return NextResponse.json({ error: 'Invalid client' }, { status: 400 });

  const supabase = createServiceClient();

  // Which pages are in scope (client filter → pages)
  const { data: pageRows } = await supabase.from('facebook_pages').select('facebook_page_id, location_name, client_id');
  const pages = (pageRows || []) as { facebook_page_id: string; location_name: string; client_id: string | null }[];
  const pageName = new Map(pages.map((p) => [String(p.facebook_page_id), p.location_name]));
  let pageIds = pages
    .filter((p) => (client === 'all' ? true : client === 'none' ? !p.client_id : p.client_id === client))
    .map((p) => String(p.facebook_page_id));
  if (page) pageIds = pageIds.filter((id) => id === page);
  // Only pages this user can access on Facebook (admins: all)
  pageIds = visiblePageIds(auth.scope, pageIds);
  if (pageIds.length === 0) {
    return NextResponse.json({ enabled: analyticsEnabled(), from, to, totals: null, series: [], top: [], followers: [], posts: [] });
  }

  let query = supabase.from('fb_post_metrics')
    .select('platform, platform_post_id, facebook_page_id, published_at, media_type, caption, permalink, views, reach, reactions, comments, shares, saves, clicks, video_views, engagements, last_error, fetched_at')
    .in('facebook_page_id', pageIds)
    .gte('published_at', `${from}T00:00:00Z`)
    .lte('published_at', `${to}T23:59:59Z`)
    .order('published_at', { ascending: false })
    .limit(2000);
  if (platform !== 'all') query = query.eq('platform', platform);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load analytics (has the analytics migration been applied?)' }, { status: 500 });
  const rows = (data || []) as MetricRow[];

  const totals = rows.reduce((t, r) => ({
    posts: t.posts + 1,
    views: add(t.views, r.views), reach: add(t.reach, r.reach), engagements: add(t.engagements, r.engagements),
    reactions: add(t.reactions, r.reactions), comments: add(t.comments, r.comments), shares: add(t.shares, r.shares),
    saves: add(t.saves, r.saves), clicks: add(t.clicks, r.clicks), video_views: add(t.video_views, r.video_views),
  }), { posts: 0, views: 0, reach: 0, engagements: 0, reactions: 0, comments: 0, shares: 0, saves: 0, clicks: 0, video_views: 0 });
  const engagementRate = totals.reach > 0 ? totals.engagements / totals.reach : null;

  // Per publish day
  const byDay = new Map<string, { date: string; posts: number; engagements: number; reach: number }>();
  for (const r of rows) {
    if (!r.published_at) continue;
    const d = r.published_at.slice(0, 10);
    const cur = byDay.get(d) || { date: d, posts: 0, engagements: 0, reach: 0 };
    cur.posts++; cur.engagements = add(cur.engagements, r.engagements); cur.reach = add(cur.reach, r.reach);
    byDay.set(d, cur);
  }
  const series = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

  const withName = (r: MetricRow) => ({ ...r, page_name: pageName.get(String(r.facebook_page_id)) || r.facebook_page_id,
    engagement_rate: r.reach && r.reach > 0 && r.engagements !== null ? r.engagements / r.reach : null });
  const top = [...rows].sort((a, b) => (b.engagements || 0) - (a.engagements || 0)).slice(0, 10).map(withName);

  // Followers: first and last snapshot in the range per account
  let fq = supabase.from('fb_account_metrics').select('platform, account_id, facebook_page_id, metric_date, followers')
    .in('facebook_page_id', pageIds).gte('metric_date', from).lte('metric_date', to).order('metric_date', { ascending: true }).limit(5000);
  if (platform !== 'all') fq = fq.eq('platform', platform);
  const { data: frows } = await fq;
  const acc = new Map<string, { platform: string; facebook_page_id: string; page_name: string; start: number | null; end: number | null }>();
  for (const f of (frows || []) as { platform: string; account_id: string; facebook_page_id: string; followers: number | null }[]) {
    const k = `${f.platform}:${f.account_id}`;
    const cur = acc.get(k) || { platform: f.platform, facebook_page_id: f.facebook_page_id, page_name: pageName.get(String(f.facebook_page_id)) || f.facebook_page_id, start: f.followers, end: f.followers };
    cur.end = f.followers;
    acc.set(k, cur);
  }
  const followers = Array.from(acc.values());

  return NextResponse.json({
    enabled: analyticsEnabled(), from, to,
    totals: { ...totals, engagement_rate: engagementRate },
    series, top, followers, posts: rows.map(withName),
  });
}
