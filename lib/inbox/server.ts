import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSwitchOn } from '@/lib/instagram/rules';
import { GRAPH_VERSION, pageDisplayName } from '@/lib/facebook/oauth';
import { decryptToken, encryptToken } from '@/lib/social/crypto';
import {
  conversationItems, facebookCommentItems, instagramCommentItems, type InboxItem, type InboxKind, type InboxPlatform,
} from './normalize';

// Server-only community inbox helpers. Comments/messages are read live from the Graph API with each
// page's own token (stored encrypted in fb_page_tokens) and never written to the database.
//
// Env: COMMUNITY_INBOX_ENABLED (default off), FACEBOOK_APP_ID / FACEBOOK_APP_SECRET, SOCIAL_TOKEN_KEY.

export function inboxEnabled(): boolean {
  return isSwitchOn(process.env.COMMUNITY_INBOX_ENABLED);
}

/**
 * Permissions requested by "Connect for inbox". [UNVERIFIED: whether Ironmark's Meta app already has
 * Advanced Access / App Review for these; without it only people with a role on the Meta app can connect.]
 */
export const INBOX_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'pages_messaging',
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'business_management',
];

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const pageAad = (facebookPageId: string) => `fb-poster:facebook_page:${facebookPageId}:access`;

export class GraphError extends Error {
  constructor(message: string, public status: number, public code: number | null, public tokenInvalid: boolean) {
    super(message);
  }
}

function appSecretProof(token: string): string | null {
  const secret = process.env.FACEBOOK_APP_SECRET;
  return secret ? createHmac('sha256', secret).update(token).digest('hex') : null;
}

/** One Graph call. GET params go in the query string; POST params in a form body. */
export async function graph(
  path: string, token: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET', timeoutMs = 20000,
): Promise<any> {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
  const all: Record<string, string> = { ...params, access_token: token };
  const proof = appSecretProof(token);
  if (proof) all.appsecret_proof = proof;
  let res: Response;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(all).toString(),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = data?.error || {};
    const code = typeof e.code === 'number' ? e.code : null;
    // 190 = invalid/expired token; 102 = session; 10/200-299 = permission missing
    const tokenInvalid = code === 190 || code === 102;
    throw new GraphError(String(e.message || `Graph request failed (${res.status})`).slice(0, 300), res.status, code, tokenInvalid);
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Connecting pages

/** Short-lived user token → long-lived (≈60 days). Page tokens fetched with it don't expire. */
export async function longLivedUserToken(shortToken: string): Promise<string> {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', process.env.FACEBOOK_APP_ID || '');
  url.searchParams.set('client_secret', process.env.FACEBOOK_APP_SECRET || '');
  url.searchParams.set('fb_exchange_token', shortToken);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== 'string') throw new Error('Could not get a long-lived Facebook token');
  return data.access_token;
}

export interface ConnectablePage {
  facebook_page_id: string;
  page_name: string;
  access_token: string;
  ig_user_id: string | null;
  ig_username: string | null;
}

const GRAPH_BATCH_SIZE = 50;     // Graph batch API maximum
const BATCH_CONCURRENCY = 4;
const APP_PAGE_ID_RE = /^\d{5,25}$/;

/** Every facebook_page_id on the Pages tab (paged past PostgREST's default 1,000-row limit). */
async function appPageIds(supabase: SupabaseClient): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data, error } = await supabase.from('facebook_pages').select('facebook_page_id').order('facebook_page_id').range(from, from + PAGE - 1);
    if (error) throw new Error(`Reading pages failed: ${error.message}`);
    for (const r of data || []) ids.push(String((r as { facebook_page_id: string }).facebook_page_id));
    if (!data || data.length < PAGE) break;
  }
  return Array.from(new Set(ids)).filter((id) => APP_PAGE_ID_RE.test(id));
}

/**
 * Page tokens for the pages already on the Pages tab that this Facebook login manages. Asks Graph for
 * those pages directly (batch API, 50 per request) instead of walking the account's whole page list,
 * so it is complete however many pages the account has. `unmanaged` = app pages this login can't manage.
 */
export async function appPagesWithTokens(supabase: SupabaseClient, userToken: string): Promise<{ pages: ConnectablePage[]; unmanaged: number }> {
  const ids = await appPageIds(supabase);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += GRAPH_BATCH_SIZE) chunks.push(ids.slice(i, i + GRAPH_BATCH_SIZE));

  const out: ConnectablePage[] = [];
  const runChunk = async (chunk: string[]) => {
    const batch = chunk.map((id) => ({
      method: 'GET',
      relative_url: `${id}?fields=id,name,name_with_location_descriptor,store_location_descriptor,access_token,instagram_business_account{id,username}`,
    }));
    const results = await graph('', userToken, { batch: JSON.stringify(batch), include_headers: 'false' }, 'POST', 60_000);
    if (!Array.isArray(results)) return;
    for (const r of results) {
      // Each item is { code, body } (body = JSON string) or null; non-200 = no access to that page
      if (!r || r.code !== 200 || typeof r.body !== 'string') continue;
      let p: any;
      try { p = JSON.parse(r.body); } catch { continue; }
      if (!p?.id || typeof p.access_token !== 'string') continue;
      out.push({
        facebook_page_id: String(p.id),
        // With the location descriptor, e.g. "Home Instead (Smithtown, NY)", so locations of one brand differ
        page_name: pageDisplayName(p),
        access_token: p.access_token,
        ig_user_id: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null,
        ig_username: p.instagram_business_account?.username ? String(p.instagram_business_account.username) : null,
      });
    }
  };
  for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + BATCH_CONCURRENCY).map(runChunk));
  }
  return { pages: out, unmanaged: ids.length - out.length };
}

export async function grantedScopes(userToken: string): Promise<string[]> {
  const data = await graph('me/permissions', userToken);
  return (data.data || []).filter((p: any) => p?.status === 'granted').map((p: any) => String(p.permission));
}

/**
 * Stores tokens only for pages already on the Pages tab (appPagesWithTokens already returns only those;
 * the filter here is a second guard). notInApp = given pages that aren't on the Pages tab.
 */
export async function savePageTokens(supabase: SupabaseClient, pages: ConnectablePage[], scopes: string[], email: string): Promise<{ saved: number; notInApp: number }> {
  if (pages.length === 0) return { saved: 0, notInApp: 0 };
  const { data: known } = await supabase.from('facebook_pages').select('facebook_page_id').in('facebook_page_id', pages.map((p) => p.facebook_page_id));
  const inApp = new Set((known || []).map((r: { facebook_page_id: string }) => String(r.facebook_page_id)));
  const rows = pages.filter((p) => inApp.has(p.facebook_page_id)).map((p) => ({
    facebook_page_id: p.facebook_page_id,
    page_name: p.page_name.slice(0, 200),
    ig_user_id: p.ig_user_id,
    ig_username: p.ig_username,
    access_token_enc: encryptToken(p.access_token, pageAad(p.facebook_page_id)),
    scopes: scopes.join(','),
    status: 'active',
    last_error: null,
    connected_by: email,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length > 0) {
    const { error } = await supabase.from('fb_page_tokens').upsert(rows, { onConflict: 'facebook_page_id' });
    if (error) throw new Error(`Saving page tokens failed: ${error.message}`);
  }
  // Fill in the linked Instagram account on the Pages tab where it's blank (never overwrites one set by hand)
  for (const p of pages) {
    if (!inApp.has(p.facebook_page_id) || !p.ig_user_id) continue;
    const { error } = await supabase.from('facebook_pages')
      .update({ ig_user_id: p.ig_user_id, ig_username: p.ig_username })
      .eq('facebook_page_id', p.facebook_page_id)
      .is('ig_user_id', null);
    if (error) console.error('[inbox] filling ig_user_id failed', error.message);
  }
  return { saved: rows.length, notInApp: pages.length - rows.length };
}

// ---------------------------------------------------------------------------------------------
// Reading

export interface ConnectedPage {
  facebook_page_id: string;
  page_name: string;
  ig_user_id: string | null;
  ig_username: string | null;
  status: string;
  scopes: string[];
  last_error: string | null;
  connected_by: string | null;
  updated_at: string;
}

const TOKEN_COLUMNS = 'facebook_page_id, page_name, ig_user_id, ig_username, status, scopes, last_error, connected_by, updated_at';

/**
 * The page names the team uses (facebook_pages.location_name, e.g. "Home Instead (Smithtown, NY)"),
 * keyed by Facebook page ID. Stored tokens keep the name Facebook gave at connect time, which for
 * location pages of one brand is often just the brand.
 */
async function appPageNames(supabase: SupabaseClient, facebookPageIds: string[]): Promise<Map<string, string>> {
  if (facebookPageIds.length === 0) return new Map();
  const { data } = await supabase.from('facebook_pages').select('facebook_page_id, location_name').in('facebook_page_id', facebookPageIds);
  const names = new Map<string, string>();
  for (const r of (data || []) as { facebook_page_id: string; location_name: string | null }[]) {
    const name = String(r.location_name || '').trim();
    if (name && !names.has(String(r.facebook_page_id))) names.set(String(r.facebook_page_id), name);
  }
  return names;
}

export async function listConnectedPages(supabase: SupabaseClient): Promise<ConnectedPage[]> {
  const { data, error } = await supabase.from('fb_page_tokens').select(TOKEN_COLUMNS).neq('status', 'disconnected').order('page_name');
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const rows = (data || []) as any[];
  const names = await appPageNames(supabase, rows.map((r) => String(r.facebook_page_id)));
  return rows
    .map((r) => ({ ...r, page_name: names.get(String(r.facebook_page_id)) || r.page_name, scopes: String(r.scopes || '').split(',').filter(Boolean) }))
    .sort((a, b) => String(a.page_name).localeCompare(String(b.page_name), undefined, { sensitivity: 'base' }));
}

export async function pageToken(supabase: SupabaseClient, facebookPageId: string): Promise<{ token: string; page: ConnectedPage } | null> {
  const { data } = await supabase.from('fb_page_tokens').select(`${TOKEN_COLUMNS}, access_token_enc`).eq('facebook_page_id', facebookPageId).maybeSingle();
  if (!data || data.status !== 'active') return null;
  const token = decryptToken(data.access_token_enc, pageAad(facebookPageId));
  if (!token) return null;
  const { access_token_enc: _enc, ...rest } = data;
  void _enc;
  return { token, page: { ...rest, scopes: String(rest.scopes || '').split(',').filter(Boolean) } as ConnectedPage };
}

export async function markNeedsReauth(supabase: SupabaseClient, facebookPageId: string, message: string) {
  await supabase.from('fb_page_tokens')
    .update({ status: 'needs_reauth', last_error: message.slice(0, 300), updated_at: new Date().toISOString() })
    .eq('facebook_page_id', facebookPageId);
}

const SINCE_DAYS = 14;

export interface PageInboxResult {
  items: InboxItem[];
  errors: string[];
}

/** Live comments + conversations for one connected page. Partial failures are reported, not thrown. */
export async function fetchPageInbox(supabase: SupabaseClient, facebookPageId: string, kinds: InboxKind[]): Promise<PageInboxResult> {
  const conn = await pageToken(supabase, facebookPageId);
  if (!conn) return { items: [], errors: ['This page needs to be connected for the inbox (or reconnected).'] };
  const { token, page } = conn;
  const appName = (await appPageNames(supabase, [page.facebook_page_id])).get(page.facebook_page_id);
  const ctx = { facebook_page_id: page.facebook_page_id, page_name: appName || page.page_name, ig_user_id: page.ig_user_id, ig_username: page.ig_username };
  const since = String(Math.floor(Date.now() / 1000) - SINCE_DAYS * 86400);

  const jobs: { label: string; run: () => Promise<InboxItem[]> }[] = [];
  if (kinds.includes('comment')) {
    jobs.push({
      label: 'Facebook comments',
      run: async () => {
        const data = await graph(`${page.facebook_page_id}/published_posts`, token, {
          fields: 'id,message,permalink_url,full_picture,created_time,comments.filter(stream).order(reverse_chronological).limit(50){id,message,created_time,from{id,name},permalink_url,is_hidden,parent{id}}',
          since,
          limit: '15',
        });
        return facebookCommentItems(ctx, data.data || []);
      },
    });
    if (page.ig_user_id) {
      jobs.push({
        label: 'Instagram comments',
        run: async () => {
          const data = await graph(`${page.ig_user_id}/media`, token, {
            fields: 'id,caption,permalink,timestamp,media_url,thumbnail_url,comments.limit(50){id,text,timestamp,username,hidden,replies{id,username}}',
            since,
            limit: '15',
          });
          return instagramCommentItems(ctx, data.data || []);
        },
      });
    }
  }
  if (kinds.includes('message')) {
    const convFields = 'id,updated_time,link,participants,messages.limit(1){id,from,message,created_time}';
    jobs.push({
      label: 'Facebook messages',
      run: async () => {
        const data = await graph(`${page.facebook_page_id}/conversations`, token, { platform: 'messenger', fields: convFields, limit: '25' });
        return conversationItems(ctx, 'facebook', data.data || [], [page.facebook_page_id]);
      },
    });
    if (page.ig_user_id) {
      jobs.push({
        label: 'Instagram messages',
        run: async () => {
          const data = await graph(`${page.facebook_page_id}/conversations`, token, { platform: 'instagram', fields: convFields, limit: '25' });
          return conversationItems(ctx, 'instagram', data.data || [], [page.ig_user_id || '', page.facebook_page_id]);
        },
      });
    }
  }

  const items: InboxItem[] = [];
  const errors: string[] = [];
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') { items.push(...r.value); continue; }
    const err = r.reason;
    if (err instanceof GraphError && err.tokenInvalid) {
      await markNeedsReauth(supabase, page.facebook_page_id, err.message);
      errors.push(`${page.page_name}: Facebook access expired. Reconnect the page for the inbox.`);
      break;
    }
    errors.push(`${page.page_name} – ${jobs[i].label}: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return { items, errors };
}

// ---------------------------------------------------------------------------------------------
// Actions

export type InboxAction =
  | { action: 'reply'; platform: InboxPlatform; kind: 'comment'; external_id: string; text: string }
  | { action: 'reply'; platform: InboxPlatform; kind: 'message'; external_id: string; recipient_id: string; text: string }
  | { action: 'hide' | 'unhide'; platform: InboxPlatform; kind: 'comment'; external_id: string };

/** Performs a reply/hide on Meta with the page's token. Throws GraphError with Meta's message on failure. */
export async function performInboxAction(supabase: SupabaseClient, facebookPageId: string, a: InboxAction): Promise<void> {
  const conn = await pageToken(supabase, facebookPageId);
  if (!conn) throw new Error('This page needs to be connected for the inbox (or reconnected).');
  const { token } = conn;
  try {
    if (a.action === 'reply' && a.kind === 'comment') {
      if (a.platform === 'facebook') await graph(`${a.external_id}/comments`, token, { message: a.text }, 'POST');
      else await graph(`${a.external_id}/replies`, token, { message: a.text }, 'POST');
      return;
    }
    if (a.action === 'reply' && a.kind === 'message') {
      // Standard messaging window: replies only within 24 hours of the person's last message
      await graph(`${facebookPageId}/messages`, token, {
        recipient: JSON.stringify({ id: a.recipient_id }),
        messaging_type: 'RESPONSE',
        message: JSON.stringify({ text: a.text }),
      }, 'POST');
      return;
    }
    if (a.action === 'hide' || a.action === 'unhide') {
      const hide = a.action === 'hide' ? 'true' : 'false';
      if (a.platform === 'facebook') await graph(a.external_id, token, { is_hidden: hide }, 'POST');
      else await graph(a.external_id, token, { hide }, 'POST');
    }
  } catch (err) {
    if (err instanceof GraphError && err.tokenInvalid) await markNeedsReauth(supabase, facebookPageId, err.message);
    throw err;
  }
}
