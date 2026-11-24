import type { SupabaseClient } from '@supabase/supabase-js';
import { GraphError, graph, pageToken } from '@/lib/inbox/server';
import { isSwitchOn } from '@/lib/instagram/rules';

// Server-only: daily collection of Facebook + Instagram analytics (Vercel Cron → /api/cron/analytics).
// For every Facebook / Instagram post the app published in the last LOOKBACK_DAYS it stores the
// latest lifetime metrics (fb_post_metrics), and each page's / Instagram account's follower count
// for the day (fb_account_metrics). Uses the page tokens saved by "Connect pages".
//
// Meta renames and retires insight metrics often, so metrics are requested together and, if Meta
// rejects the set, one at a time; whatever comes back is stored (all of it in `raw`).
//
// Env: ANALYTICS_ENABLED (default off). While on, "Connect pages" also asks for read_insights and
// instagram_manage_insights (reconnect pages once).

export const ANALYTICS_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights'];
const LOOKBACK_DAYS = 90;
const MAX_POSTS_PER_RUN = 400;
const STOP_AFTER_MS = 240_000;

export function analyticsEnabled(): boolean {
  return isSwitchOn(process.env.ANALYTICS_ENABLED);
}

type Metrics = Record<string, number>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Insights values → { metric: number } (lifetime values; objects such as reactions-by-type are summed) */
function readInsights(data: any): Metrics {
  const out: Metrics = {};
  for (const m of data?.data || []) {
    const v = m?.values?.[0]?.value ?? m?.total_value?.value;
    if (typeof v === 'number') out[m.name] = v;
    else if (v && typeof v === 'object') out[m.name] = Object.values(v).reduce((s: number, x) => s + (typeof x === 'number' ? x : 0), 0);
  }
  return out;
}

/** Ask for several insight metrics; if Meta rejects the set, ask one by one and keep what works */
async function insights(objectId: string, token: string, metrics: string[], extra: Record<string, string> = {}): Promise<Metrics> {
  try {
    return readInsights(await graph(`${objectId}/insights`, token, { metric: metrics.join(','), ...extra }));
  } catch (e) {
    if (e instanceof GraphError && e.tokenInvalid) throw e;
    const out: Metrics = {};
    for (const m of metrics) {
      try { Object.assign(out, readInsights(await graph(`${objectId}/insights`, token, { metric: m, ...extra }))); }
      catch (inner) { if (inner instanceof GraphError && inner.tokenInvalid) throw inner; }
    }
    return out;
  }
}

const FB_POST_METRICS = ['post_media_view', 'post_total_media_view_unique', 'post_impressions_unique', 'post_clicks', 'post_video_views', 'post_reactions_by_type_total'];
const IG_MEDIA_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];

interface PostRow {
  id: string;
  platform: 'facebook' | 'instagram';
  facebook_page_id: string;
  facebook_post_id: string;
  published_at: string | null;
  media_type: string | null;
  post_content: string | null;
}

interface MetricRow {
  platform: string; platform_post_id: string; post_id: string; facebook_page_id: string;
  published_at: string | null; media_type: string | null; caption: string | null; permalink: string | null;
  views: number | null; reach: number | null; reactions: number | null; comments: number | null; shares: number | null;
  saves: number | null; clicks: number | null; video_views: number | null; engagements: number | null;
  raw: Record<string, unknown>; last_error: string | null; fetched_at: string;
}

const sum = (...xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce((s: number, x) => s + (x || 0), 0) : null);

async function facebookPostMetrics(post: PostRow, token: string): Promise<Partial<MetricRow>> {
  let postId = post.facebook_post_id;
  const raw: Record<string, unknown> = {};
  // Videos are stored by their video id: resolve the feed post id for post-level insights
  if (!postId.includes('_')) {
    try {
      const v = await graph(postId, token, { fields: 'post_id,length' });
      if (v?.post_id) postId = String(v.post_id);
      const vi = await insights(post.facebook_post_id, token, ['total_video_views', 'total_video_views_unique'], {}).catch(() => ({}));
      Object.assign(raw, vi);
    } catch { /* keep the video id */ }
  }
  const fields = await graph(postId, token, {
    fields: 'permalink_url,created_time,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)',
  });
  const ins = await insights(postId, token, FB_POST_METRICS, { period: 'lifetime' });
  Object.assign(raw, ins);
  const reactions = num(fields?.reactions?.summary?.total_count) ?? num(ins.post_reactions_by_type_total);
  const comments = num(fields?.comments?.summary?.total_count);
  const shares = num(fields?.shares?.count) ?? 0;
  const clicks = num(ins.post_clicks);
  return {
    permalink: typeof fields?.permalink_url === 'string' ? fields.permalink_url.slice(0, 500) : null,
    views: num(ins.post_media_view),
    reach: num(ins.post_total_media_view_unique) ?? num(ins.post_impressions_unique),
    reactions, comments, shares, saves: null, clicks,
    video_views: num(ins.post_video_views) ?? num(raw.total_video_views),
    engagements: sum(reactions, comments, shares, clicks),
    raw,
  };
}

async function instagramPostMetrics(post: PostRow, token: string): Promise<Partial<MetricRow>> {
  const fields = await graph(post.facebook_post_id, token, { fields: 'permalink,like_count,comments_count,media_type,media_product_type,timestamp' });
  const ins = await insights(post.facebook_post_id, token, IG_MEDIA_METRICS);
  const reactions = num(ins.likes) ?? num(fields?.like_count);
  const comments = num(ins.comments) ?? num(fields?.comments_count);
  const shares = num(ins.shares);
  const saves = num(ins.saved);
  return {
    permalink: typeof fields?.permalink === 'string' ? fields.permalink.slice(0, 500) : null,
    views: num(ins.views),
    reach: num(ins.reach),
    reactions, comments, shares, saves, clicks: null,
    video_views: post.media_type === 'video' ? num(ins.views) : null,
    engagements: num(ins.total_interactions) ?? sum(reactions, comments, shares, saves),
    raw: { ...ins, media_product_type: fields?.media_product_type ?? null },
  };
}

// ---------------------------------------------------------------------------------------------
// Every connected page's own recent posts (wherever they were published: Hootsuite, Business
// Suite, the app...), not just the app's. Insights are fetched 50 posts per Graph batch call.

const PAGE_POST_LIMIT = 100;     // most recent posts per page / Instagram account per run
const BATCH = 50;                // Graph batch API maximum

/** Graph batch of GET relative URLs → parsed bodies (null for failed items) */
async function batchGet(token: string, urls: string[]): Promise<(any | null)[]> {
  const out: (any | null)[] = [];
  for (let i = 0; i < urls.length; i += BATCH) {
    const chunk = urls.slice(i, i + BATCH);
    const res = await graph('', token, { batch: JSON.stringify(chunk.map((u) => ({ method: 'GET', relative_url: u }))), include_headers: 'false' }, 'POST', 90_000);
    for (let k = 0; k < chunk.length; k++) {
      const r = Array.isArray(res) ? res[k] : null;
      if (!r || r.code !== 200 || typeof r.body !== 'string') { out.push(null); continue; }
      try { out.push(JSON.parse(r.body)); } catch { out.push(null); }
    }
  }
  return out;
}

/** Follow paging.next until items are older than `sinceMs` or `limit` items are collected */
async function listRecent(first: string, token: string, params: Record<string, string>, timeOf: (x: any) => string | undefined, sinceMs: number, limit: number): Promise<any[]> {
  const items: any[] = [];
  let data = await graph(first, token, params);
  for (let page = 0; page < 10; page++) {
    for (const x of data?.data || []) {
      const t = Date.parse(timeOf(x) || '');
      if (Number.isFinite(t) && t < sinceMs) return items;
      items.push(x);
      if (items.length >= limit) return items;
    }
    const next = data?.paging?.next;
    if (typeof next !== 'string' || !next.startsWith('https://graph.facebook.com/')) break;
    const res = await fetch(next, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!res.ok) break;
    data = await res.json();
  }
  return items;
}

const FB_BATCH_METRICS = 'post_media_view,post_total_media_view_unique,post_clicks,post_video_views';
const IG_BATCH_METRICS = 'views,reach,likes,comments,shares,saved,total_interactions';

function fbMediaType(p: any): string {
  const t = String(p?.attachments?.data?.[0]?.media_type || '').toLowerCase();
  return t === 'video' ? 'video' : t === 'photo' || t === 'album' ? 'photo' : 'text';
}

async function collectPagePosts(
  supabase: SupabaseClient, pageId: string, igUserId: string | null, token: string, summary: CollectSummary,
): Promise<void> {
  const sinceMs = Date.now() - LOOKBACK_DAYS * 86400_000;
  const now = new Date().toISOString();

  // Facebook: the page's published posts
  const fbPosts = await listRecent(`${pageId}/published_posts`, token, {
    fields: 'id,created_time,message,permalink_url,attachments{media_type},shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)',
    limit: '50',
  }, (x) => x.created_time, sinceMs, PAGE_POST_LIMIT);
  if (fbPosts.length > 0) {
    const ins = await batchGet(token, fbPosts.map((x) => `${x.id}/insights?metric=${FB_BATCH_METRICS}&period=lifetime`));
    const rows = fbPosts.map((x, i) => {
      const m = ins[i] ? readInsights(ins[i]) : {};
      const reactions = num(x?.reactions?.summary?.total_count);
      const comments = num(x?.comments?.summary?.total_count);
      const shares = num(x?.shares?.count) ?? 0;
      const clicks = num(m.post_clicks);
      return {
        platform: 'facebook', platform_post_id: String(x.id), facebook_page_id: pageId,
        published_at: x.created_time || null, media_type: fbMediaType(x),
        caption: typeof x.message === 'string' ? x.message.slice(0, 500) : null,
        permalink: typeof x.permalink_url === 'string' ? x.permalink_url.slice(0, 500) : null,
        views: num(m.post_media_view), reach: num(m.post_total_media_view_unique),
        reactions, comments, shares, saves: null, clicks, video_views: num(m.post_video_views),
        engagements: sum(reactions, comments, shares, clicks),
        raw: { ...m, source: 'page' }, last_error: ins[i] ? null : 'insights unavailable', fetched_at: now,
      };
    }).filter((r) => /^[0-9_]{1,80}$/.test(r.platform_post_id));
    const { error } = await supabase.from('fb_post_metrics').upsert(rows, { onConflict: 'platform,platform_post_id' });
    if (error) throw new Error(`save Facebook posts: ${error.message}`);
    summary.pagePosts += rows.length;
  }

  // Instagram: the linked account's media (stories excluded)
  if (igUserId) {
    const media = (await listRecent(`${igUserId}/media`, token, {
      fields: 'id,caption,permalink,media_type,media_product_type,timestamp,like_count,comments_count',
      limit: '50',
    }, (x) => x.timestamp, sinceMs, PAGE_POST_LIMIT)).filter((x) => x.media_product_type !== 'STORY');
    if (media.length > 0) {
      const ins = await batchGet(token, media.map((x) => `${x.id}/insights?metric=${IG_BATCH_METRICS}`));
      const rows = [];
      for (let i = 0; i < media.length; i++) {
        const x = media[i];
        // A rejected metric set fails the whole item: retry it metric by metric
        let m: Metrics = ins[i] ? readInsights(ins[i]) : {};
        if (!ins[i]) { try { m = await insights(String(x.id), token, IG_BATCH_METRICS.split(',')); } catch { m = {}; } }
        const reactions = num(m.likes) ?? num(x.like_count);
        const comments = num(m.comments) ?? num(x.comments_count);
        const shares = num(m.shares);
        const saves = num(m.saved);
        const isVideo = x.media_type === 'VIDEO' || x.media_product_type === 'REELS';
        rows.push({
          platform: 'instagram', platform_post_id: String(x.id), facebook_page_id: pageId,
          published_at: x.timestamp || null, media_type: isVideo ? 'video' : 'photo',
          caption: typeof x.caption === 'string' ? x.caption.slice(0, 500) : null,
          permalink: typeof x.permalink === 'string' ? x.permalink.slice(0, 500) : null,
          views: num(m.views), reach: num(m.reach), reactions, comments, shares, saves, clicks: null,
          video_views: isVideo ? num(m.views) : null,
          engagements: num(m.total_interactions) ?? sum(reactions, comments, shares, saves),
          raw: { ...m, source: 'page', media_product_type: x.media_product_type ?? null },
          last_error: Object.keys(m).length ? null : 'insights unavailable', fetched_at: now,
        });
      }
      const valid = rows.filter((r) => /^[0-9_]{1,80}$/.test(r.platform_post_id));
      const { error } = await supabase.from('fb_post_metrics').upsert(valid, { onConflict: 'platform,platform_post_id' });
      if (error) throw new Error(`save Instagram posts: ${error.message}`);
      summary.pagePosts += valid.length;
    }
  }
}

export interface CollectSummary {
  posts: number; updated: number; failed: number; accounts: number; skipped: number; errors: string[];
  pages: number; pagePosts: number;
}

export async function collectAnalytics(supabase: SupabaseClient): Promise<CollectSummary> {
  const started = Date.now();
  const summary: CollectSummary = { posts: 0, updated: 0, failed: 0, accounts: 0, skipped: 0, errors: [], pages: 0, pagePosts: 0 };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  const { data: rows, error } = await supabase
    .from('facebook_scheduled_posts')
    .select('id, platform, facebook_page_id, facebook_post_id, published_at, media_type, post_content')
    .eq('status', 'published')
    .in('platform', ['facebook', 'instagram'])
    .not('facebook_post_id', 'is', null)
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(MAX_POSTS_PER_RUN);
  if (error) { summary.errors.push(`load posts: ${error.message}`); return summary; }
  const posts = (rows || []) as PostRow[];
  summary.posts = posts.length;

  const tokens = new Map<string, string | null>();
  const tokenFor = async (pageId: string) => {
    if (!tokens.has(pageId)) tokens.set(pageId, (await pageToken(supabase, pageId))?.token ?? null);
    return tokens.get(pageId) ?? null;
  };

  for (const post of posts) {
    if (Date.now() - started > STOP_AFTER_MS) { summary.skipped++; continue; }
    const token = await tokenFor(String(post.facebook_page_id));
    if (!token) { summary.skipped++; continue; }
    const base = {
      platform: post.platform, platform_post_id: post.facebook_post_id, post_id: post.id,
      facebook_page_id: String(post.facebook_page_id), published_at: post.published_at, media_type: post.media_type,
      caption: post.post_content ? post.post_content.slice(0, 500) : null, fetched_at: new Date().toISOString(),
    };
    try {
      const m = post.platform === 'instagram' ? await instagramPostMetrics(post, token) : await facebookPostMetrics(post, token);
      const { error: upErr } = await supabase.from('fb_post_metrics').upsert({ ...base, ...m, last_error: null }, { onConflict: 'platform,platform_post_id' });
      if (upErr) throw new Error(upErr.message);
      summary.updated++;
    } catch (e) {
      summary.failed++;
      const msg = (e instanceof Error ? e.message : 'failed').slice(0, 300);
      if (summary.errors.length < 10) summary.errors.push(`${post.platform} ${post.facebook_post_id}: ${msg}`);
      // keep earlier numbers; just note the error
      await supabase.from('fb_post_metrics').upsert({ ...base, last_error: msg }, { onConflict: 'platform,platform_post_id', ignoreDuplicates: false });
    }
  }

  // Daily followers for every connected page (and its Instagram account)
  const today = new Date().toISOString().slice(0, 10);
  const { data: conns } = await supabase.from('fb_page_tokens').select('facebook_page_id, ig_user_id').eq('status', 'active');
  const shuffled = [...((conns || []) as { facebook_page_id: string; ig_user_id: string | null }[])].sort(() => Math.random() - 0.5);
  for (const c of shuffled) {
    if (Date.now() - started > STOP_AFTER_MS) break;
    const token = await tokenFor(String(c.facebook_page_id));
    if (!token) continue;
    // Every recent post on the page (and its Instagram account), not just the app's
    try {
      await collectPagePosts(supabase, String(c.facebook_page_id), c.ig_user_id ? String(c.ig_user_id) : null, token, summary);
      summary.pages++;
    } catch (e) {
      if (summary.errors.length < 10) summary.errors.push(`page posts ${c.facebook_page_id}: ${(e instanceof Error ? e.message : 'failed').slice(0, 200)}`);
    }
    try {
      const p = await graph(String(c.facebook_page_id), token, { fields: 'followers_count,fan_count' });
      await supabase.from('fb_account_metrics').upsert({
        platform: 'facebook', account_id: String(c.facebook_page_id), facebook_page_id: String(c.facebook_page_id),
        metric_date: today, followers: num(p?.followers_count) ?? num(p?.fan_count), fetched_at: new Date().toISOString(),
      }, { onConflict: 'platform,account_id,metric_date' });
      summary.accounts++;
      if (c.ig_user_id) {
        const ig = await graph(String(c.ig_user_id), token, { fields: 'followers_count' });
        await supabase.from('fb_account_metrics').upsert({
          platform: 'instagram', account_id: String(c.ig_user_id), facebook_page_id: String(c.facebook_page_id),
          metric_date: today, followers: num(ig?.followers_count), fetched_at: new Date().toISOString(),
        }, { onConflict: 'platform,account_id,metric_date' });
        summary.accounts++;
      }
    } catch (e) {
      if (summary.errors.length < 10) summary.errors.push(`followers ${c.facebook_page_id}: ${(e instanceof Error ? e.message : 'failed').slice(0, 200)}`);
    }
  }
  return summary;
}
