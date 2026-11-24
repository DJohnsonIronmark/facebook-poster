import type { SupabaseClient } from '@supabase/supabase-js';
import { GraphError, graph, markNeedsReauth, pageToken } from '@/lib/inbox/server';
import { isSwitchOn } from '@/lib/instagram/rules';

// Server-only: Instagram publishing by the app itself (instead of the n8n Instagram publisher),
// with the linked Facebook page's stored token (fb_page_tokens, saved by "Connect pages").
// Instagram publishes in two steps: create a media container from a public URL, wait until
// Instagram has processed it, then publish the container.
//
// Env: INSTAGRAM_APP_PUBLISHING_ENABLED (default off). While on, "Connect pages" also asks for
// instagram_content_publish (reconnect a page once), Instagram posts may be published immediately,
// and the app publishes them. Keep the n8n "Instagram Scheduled Publisher" inactive meanwhile, or a
// scheduled Instagram row could be picked up by both.

export const IG_PUBLISH_PERMISSION = 'instagram_content_publish';
export const IG_PUBLISH_SCOPES = ['pages_show_list', 'business_management', 'instagram_basic', IG_PUBLISH_PERMISSION];

export function instagramAppPublishingEnabled(): boolean {
  return isSwitchOn(process.env.INSTAGRAM_APP_PUBLISHING_ENABLED);
}

export interface InstagramPostRow {
  id: string;
  facebook_page_id: string;
  post_content: string | null;
  media_url: string | null;
  media_type: string | null;
  platform?: string | null;
}

// claimed: false = nothing was attempted (checks failed, or another run already has the row)
export type InstagramPublishResult = { ok: true; mediaId: string } | { ok: false; error: string; claimed: boolean; alreadyClaimed?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_EVERY_MS = 2500;
const PHOTO_WAIT_MS = 30_000;
const VIDEO_WAIT_MS = 100_000;

async function markFailed(supabase: SupabaseClient, postId: string, error: string) {
  await supabase.from('facebook_scheduled_posts')
    .update({ status: 'failed', publish_error: error.slice(0, 500) })
    .eq('id', postId).eq('status', 'publishing');
}

/**
 * Claim a 'pending' Instagram row and publish it now. The status-conditional claim means two clicks
 * (or two runners) can never publish the same row twice. On failure the row is marked 'failed' with
 * the reason (shown in the post list).
 */
export async function claimAndPublishInstagram(supabase: SupabaseClient, post: InstagramPostRow): Promise<InstagramPublishResult> {
  if (post.platform !== 'instagram') return { ok: false, error: 'Not an Instagram post', claimed: false };
  if (!instagramAppPublishingEnabled()) return { ok: false, error: 'Instagram app publishing is switched off (INSTAGRAM_APP_PUBLISHING_ENABLED)', claimed: false };
  const kind = post.media_type === 'video' ? 'video' : post.media_type === 'photo' ? 'photo' : null;
  if (!kind || !post.media_url) return { ok: false, error: 'Instagram posts need a photo or video', claimed: false };

  // Everything that can be checked without touching Instagram, before claiming the row
  const { data: pageRows } = await supabase
    .from('facebook_pages').select('ig_user_id').eq('facebook_page_id', String(post.facebook_page_id));
  const igUserId = (pageRows || []).map((p: { ig_user_id: string | null }) => p.ig_user_id).find(Boolean);
  if (!igUserId || !/^[0-9]{5,25}$/.test(igUserId)) return { ok: false, error: 'The page has no Instagram account ID (set it on the Pages tab)', claimed: false };
  const conn = await pageToken(supabase, String(post.facebook_page_id));
  if (!conn) return { ok: false, error: 'The page isn\'t connected (or its connection expired). Use Inbox → "Connect pages", then try again.', claimed: false };
  if (!conn.page.scopes.includes(IG_PUBLISH_PERMISSION)) {
    return { ok: false, error: `The page's connection can't publish to Instagram yet (missing ${IG_PUBLISH_PERMISSION}). Use Inbox → "Connect pages" once to reconnect it.`, claimed: false };
  }

  const { data: claimed } = await supabase.from('facebook_scheduled_posts')
    .update({ status: 'publishing', publish_started_at: new Date().toISOString(), publish_error: null })
    .eq('id', post.id).eq('status', 'pending').select('id');
  if (!claimed || claimed.length === 0) return { ok: false, error: 'This post is already publishing or was published', claimed: false, alreadyClaimed: true };

  try {
    const caption = String(post.post_content || '');
    const container = await graph(`${igUserId}/media`, conn.token, kind === 'photo'
      ? { image_url: post.media_url, caption }
      : { media_type: 'REELS', video_url: post.media_url, caption }, 'POST', 60_000);
    const creationId = String(container?.id || '');
    if (!/^[0-9]{1,40}$/.test(creationId)) throw new Error('Instagram did not return a media container');

    // Wait until Instagram has processed the media (photos: seconds; videos: longer)
    const deadline = Date.now() + (kind === 'photo' ? PHOTO_WAIT_MS : VIDEO_WAIT_MS);
    for (;;) {
      const st = await graph(creationId, conn.token, { fields: 'status_code,status' });
      const code = String(st?.status_code || '');
      if (code === 'FINISHED') break;
      if (code === 'ERROR' || code === 'EXPIRED') throw new Error(`Instagram could not process the ${kind}${st?.status ? ` (${st.status})` : ''}`);
      if (Date.now() > deadline) throw new Error(`Instagram is still processing the ${kind}; try Publish again in a minute`);
      await sleep(POLL_EVERY_MS);
    }

    const published = await graph(`${igUserId}/media_publish`, conn.token, { creation_id: creationId }, 'POST', 60_000);
    const mediaId = String(published?.id || '');
    if (!/^[0-9]{1,40}$/.test(mediaId)) throw new Error('Instagram did not confirm the post');

    await supabase.from('facebook_scheduled_posts')
      .update({ status: 'published', published_at: new Date().toISOString(), facebook_post_id: mediaId, publish_error: null })
      .eq('id', post.id);
    return { ok: true, mediaId };
  } catch (e) {
    if (e instanceof GraphError && e.tokenInvalid) await markNeedsReauth(supabase, String(post.facebook_page_id), e.message);
    const message = e instanceof Error ? e.message : 'Instagram publishing failed';
    await markFailed(supabase, post.id, message);
    return { ok: false, error: message, claimed: true };
  }
}
