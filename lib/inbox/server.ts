import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSwitchOn } from '@/lib/instagram/rules';
import { GRAPH_VERSION } from '@/lib/facebook/oauth';
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
  path: string, token: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET',
): Promise<any> {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
  const all: Record<string, string> = { ...params, access_token: token };
  const proof = appSecretProof(token);
  if (proof) all.appsecret_proof = proof;
  let res: Response;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    res = await fetch(url, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(all).toString(),
      signal: AbortSignal.timeout(20000),
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

export async function pagesWithTokens(userToken: string): Promise<ConnectablePage[]> {
  const out: ConnectablePage[] = [];
  let after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const params: Record<string, string> = { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' };
    if (after) params.after = after;
    const data = await graph('me/accounts', userToken, params);
    for (const p of data.data || []) {
      if (!p?.id || typeof p.access_token !== 'string') continue;
      out.push({
        facebook_page_id: String(p.id),
        page_name: String(p.name || ''),
        access_token: p.access_token,
        ig_user_id: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null,
        ig_username: p.instagram_business_account?.username ? String(p.instagram_business_account.username) : null,
      });
    }
    after = data.paging?.next ? data.paging?.cursors?.after || null : null;
    if (!after) break;
  }
  return out;
}

export async function grantedScopes(userToken: string): Promise<string[]> {
  const data = await graph('me/permissions', userToken);
  return (data.data || []).filter((p: any) => p?.status === 'granted').map((p: any) => String(p.permission));
}

/**
 * Stores tokens only for pages already on the Pages tab. Returns how many were saved and which
 * managed pages were skipped because they aren't in the app.
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

export async function listConnectedPages(supabase: SupabaseClient): Promise<ConnectedPage[]> {
  const { data, error } = await supabase.from('fb_page_tokens').select(TOKEN_COLUMNS).neq('status', 'disconnected').order('page_name');
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return (data || []).map((r: any) => ({ ...r, scopes: String(r.scopes || '').split(',').filter(Boolean) }));
}

async function pageToken(supabase: SupabaseClient, facebookPageId: string): Promise<{ token: string; page: ConnectedPage } | null> {
  const { data } = await supabase.from('fb_page_tokens').select(`${TOKEN_COLUMNS}, access_token_enc`).eq('facebook_page_id', facebookPageId).maybeSingle();
  if (!data || data.status !== 'active') return null;
  const token = decryptToken(data.access_token_enc, pageAad(facebookPageId));
  if (!token) return null;
  const { access_token_enc: _enc, ...rest } = data;
  void _enc;
  return { token, page: { ...rest, scopes: String(rest.scopes || '').split(',').filter(Boolean) } as ConnectedPage };
}

async function markNeedsReauth(supabase: SupabaseClient, facebookPageId: string, message: string) {
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
  const ctx = { facebook_page_id: page.facebook_page_id, page_name: page.page_name, ig_user_id: page.ig_user_id, ig_username: page.ig_username };
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
