import type { SupabaseClient } from '@supabase/supabase-js';
import { GraphError, INBOX_SCOPES, graph, inboxEnabled, markNeedsReauth, pageToken } from '@/lib/inbox/server';
import { facebookAppPublishingEnabled } from '@/lib/social/switches';
import { truncate } from '@/lib/social/http';
import { DELETE_SCOPES, platformDeleteEnabled } from '@/lib/social/platformDelete';
import { IG_PUBLISH_SCOPES, instagramAppPublishingEnabled } from '@/lib/instagram/appPublish';

// Server-only: Facebook publishing by the app itself, with each page's own token (fb_page_tokens),
// for pages set to publish_via = 'app'. Pages left on 'n8n' keep publishing through n8n's shared
// credential exactly as before. Used by /api/publish/social-run (scheduled) and by
// "Publish now" (/api/publish, /api/posts).
//
// Env: FACEBOOK_APP_PUBLISHING_ENABLED (default off), FACEBOOK_APP_ID / FACEBOOK_APP_SECRET,
//      SOCIAL_TOKEN_KEY (decrypts the stored page tokens).

/** Permission a page token needs to publish. */
export const PUBLISH_PERMISSION = 'pages_manage_posts';

/** Asked for by "Connect pages" when app publishing is on. */
export const PUBLISH_SCOPES = ['pages_show_list', 'pages_read_engagement', PUBLISH_PERMISSION, 'business_management'];

export type ConnectPurpose = 'inbox' | 'publish';

/** Whether "Connect pages" (which stores page tokens) may run for this purpose right now. */
export function pageConnectEnabled(purpose: ConnectPurpose): boolean {
  return purpose === 'inbox' ? inboxEnabled() : facebookAppPublishingEnabled();
}

/**
 * Permissions for one "Connect pages" login. A page has one stored token, so each connect asks for
 * everything currently switched on (inbox and/or publishing); otherwise reconnecting for one purpose
 * would drop the other's permissions.
 */
export function pageConnectScopes(): string[] {
  const scopes = new Set<string>(['pages_show_list']);
  if (inboxEnabled()) INBOX_SCOPES.forEach((s) => scopes.add(s));
  if (facebookAppPublishingEnabled()) PUBLISH_SCOPES.forEach((s) => scopes.add(s));
  // Deleting published posts from Facebook / Instagram (PLATFORM_DELETE_ENABLED)
  if (platformDeleteEnabled()) DELETE_SCOPES.forEach((s) => scopes.add(s));
  // Instagram published by the app itself (INSTAGRAM_APP_PUBLISHING_ENABLED)
  if (instagramAppPublishingEnabled()) IG_PUBLISH_SCOPES.forEach((s) => scopes.add(s));
  return Array.from(scopes);
}

export interface PublishReadiness {
  ready: boolean;
  /** 'active' | 'needs_reauth' | 'disconnected' | null (never connected) */
  token_status: string | null;
  connected_by: string | null;
  problem: string | null;
}

function readiness(row: { status: string; scopes: string | null; connected_by: string | null } | undefined): PublishReadiness {
  if (!row) return { ready: false, token_status: null, connected_by: null, problem: 'Page not connected yet (use "Connect pages for publishing")' };
  const scopes = String(row.scopes || '').split(',');
  if (row.status !== 'active') return { ready: false, token_status: row.status, connected_by: row.connected_by, problem: 'Facebook access expired or was removed; connect the page again' };
  if (!scopes.includes(PUBLISH_PERMISSION)) return { ready: false, token_status: row.status, connected_by: row.connected_by, problem: `Connected without the ${PUBLISH_PERMISSION} permission; connect again and allow posting` };
  return { ready: true, token_status: row.status, connected_by: row.connected_by, problem: null };
}

/** Publish readiness for several pages (one query). Pages with no stored token are 'not connected'. */
export async function publishReadinessFor(supabase: SupabaseClient, facebookPageIds: string[]): Promise<Map<string, PublishReadiness>> {
  const out = new Map<string, PublishReadiness>();
  const ids = Array.from(new Set(facebookPageIds.map(String))).filter(Boolean);
  if (ids.length === 0) return out;
  const { data, error } = await supabase.from('fb_page_tokens').select('facebook_page_id, status, scopes, connected_by').in('facebook_page_id', ids);
  if (error) throw new Error(`Reading page connections failed: ${error.message}`);
  const rows = new Map((data || []).map((r: { facebook_page_id: string; status: string; scopes: string | null; connected_by: string | null }) => [String(r.facebook_page_id), r]));
  for (const id of ids) out.set(id, readiness(rows.get(id)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Publishing

export interface FacebookPostRow {
  id: string;
  platform: string | null;
  facebook_page_id: string;
  franchise_name: string | null;
  post_content: string | null;
  link_url: string | null;
  media_type: string | null;
  media_url: string | null;
  publish_via?: string | null;
}

export const FACEBOOK_POST_COLUMNS = 'id, platform, facebook_page_id, franchise_name, post_content, link_url, media_type, media_url, publish_via';

export type FacebookPublishOutcome = { ok: true; facebookPostId: string } | { ok: false; error: string };

const VIDEO_TIMEOUT_MS = 120_000;
const isHttpsUrl = (s: string) => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };
const isHttpUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

function graphFailure(e: unknown): string {
  if (e instanceof GraphError) {
    const permission = e.code === 10 || (e.code !== null && e.code >= 200 && e.code < 300);
    if (permission) return `Facebook refused the post (missing permission; connect the page again and allow posting): ${e.message}`;
    return `Facebook: ${e.message}`;
  }
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return 'Facebook did not answer in time; check the page before retrying (the post may be live)';
  }
  return `Facebook: ${e instanceof Error ? e.message : String(e)}`;
}

/** Publishes ONE Facebook post with the page's stored token. Does not change the post's status. */
export async function publishFacebookPost(supabase: SupabaseClient, post: FacebookPostRow): Promise<FacebookPublishOutcome> {
  if (post.platform && post.platform !== 'facebook') return { ok: false, error: 'Not a Facebook post' };
  const pageId = String(post.facebook_page_id || '');
  if (!/^\d{5,25}$/.test(pageId)) return { ok: false, error: 'Invalid Facebook page id' };

  const conn = await pageToken(supabase, pageId);
  if (!conn) return { ok: false, error: 'This page is not connected for app publishing (or needs reconnecting) on the Pages tab' };
  if (!conn.page.scopes.includes(PUBLISH_PERMISSION)) {
    return { ok: false, error: `This page was connected without the ${PUBLISH_PERMISSION} permission; connect it again and allow posting` };
  }
  const token = conn.token;
  const message = String(post.post_content || '');
  const mediaType = post.media_type === 'photo' || post.media_type === 'video' ? post.media_type : null;
  const mediaUrl = post.media_url ? String(post.media_url) : '';

  if (mediaType) {
    if (mediaUrl.startsWith('storage://')) return { ok: false, error: 'Media is still private (not copied to the public bucket); schedule the post again from Approvals' };
    if (!isHttpsUrl(mediaUrl)) return { ok: false, error: 'Media link must be a public https URL' };
  } else if (!message.trim()) {
    return { ok: false, error: 'Post has no text' };
  }

  try {
    if (mediaType === 'photo') {
      // Facebook downloads the photo from the public URL itself
      const data = await graph(`${pageId}/photos`, token, { url: mediaUrl, message, published: 'true' }, 'POST');
      const id = String(data?.post_id || data?.id || '');
      return id ? { ok: true, facebookPostId: id } : { ok: false, error: 'Facebook accepted the photo but returned no post id' };
    }
    if (mediaType === 'video') {
      const data = await graph(`${pageId}/videos`, token, { file_url: mediaUrl, description: message, published: 'true' }, 'POST', VIDEO_TIMEOUT_MS);
      const id = String(data?.id || '');
      return id ? { ok: true, facebookPostId: id } : { ok: false, error: 'Facebook accepted the video but returned no id' };
    }
    const params: Record<string, string> = { message, published: 'true' };
    const link = post.link_url ? String(post.link_url).trim() : '';
    if (link && isHttpUrl(link)) params.link = link;
    const data = await graph(`${pageId}/feed`, token, params, 'POST');
    const id = String(data?.id || '');
    return id ? { ok: true, facebookPostId: id } : { ok: false, error: 'Facebook accepted the post but returned no id' };
  } catch (e) {
    if (e instanceof GraphError && e.tokenInvalid) {
      await markNeedsReauth(supabase, pageId, e.message);
      return { ok: false, error: `Facebook rejected this page's stored access; connect the page again on the Pages tab (${truncate(e.message, 200)})` };
    }
    return { ok: false, error: graphFailure(e) };
  }
}

export type ClaimResult =
  | { status: 'published'; facebookPostId: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

/**
 * Claims one due Facebook post (pending → publishing, only if it is still pending and set to app
 * publishing, so overlapping runs or a double click never post twice), publishes it, and records
 * the result. Caller checks the switch.
 */
export async function claimAndPublishFacebook(supabase: SupabaseClient, post: FacebookPostRow): Promise<ClaimResult> {
  const { data: claimed, error: claimErr } = await supabase
    .from('facebook_scheduled_posts')
    .update({ status: 'publishing', publish_started_at: new Date().toISOString(), publish_error: null })
    .eq('id', post.id)
    .eq('status', 'pending')
    .eq('platform', 'facebook')
    .eq('publish_via', 'app')
    .select('id');
  if (claimErr) return { status: 'skipped', reason: `Could not claim the post: ${claimErr.message}` };
  if ((claimed || []).length !== 1) return { status: 'skipped', reason: 'Post is no longer waiting to publish (already published, publishing, or moved)' };

  let outcome: FacebookPublishOutcome;
  try {
    outcome = await publishFacebookPost(supabase, post);
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' };
  }

  if (outcome.ok) {
    const { error } = await supabase
      .from('facebook_scheduled_posts')
      .update({ status: 'published', published_at: new Date().toISOString(), facebook_post_id: outcome.facebookPostId, publish_error: null })
      .eq('id', post.id)
      .eq('status', 'publishing');
    if (error) console.error('[facebook publish] published but status update failed', post.id, error.message);
    return { status: 'published', facebookPostId: outcome.facebookPostId };
  }
  const message = truncate(outcome.error, 500);
  await supabase
    .from('facebook_scheduled_posts')
    .update({ status: 'failed', publish_error: message })
    .eq('id', post.id)
    .eq('status', 'publishing');
  return { status: 'failed', error: message };
}

/** Reads a page's publish_via ('n8n' unless the page is set to 'app'). */
export async function pagePublishVia(supabase: SupabaseClient, facebookPageId: string): Promise<'n8n' | 'app'> {
  const { data } = await supabase.from('facebook_pages').select('publish_via').eq('facebook_page_id', String(facebookPageId)).limit(1);
  const v = (data || [])[0]?.publish_via;
  return v === 'app' ? 'app' : 'n8n';
}
