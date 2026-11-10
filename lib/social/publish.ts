import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccessToken, markConnectionError } from './connections';
import { SocialApiError, errorMessage, truncate } from './http';
import { X_IMAGE_MAX_BYTES } from './rules';
import {
  isOurPublicMediaUrl, loadConnectionsLite, loadPageMappings, pageSocialProblem, pickMappingFor, socialTextProblem,
  type SocialPlatform,
} from './server';
import { escapeLittleText } from '@/lib/linkedin/text';
import {
  linkedinCreatePost, linkedinUploadImage, linkedinUploadVideo, orgUrn, type LinkedInPostContent,
} from '@/lib/linkedin/api';
import { xCreatePost, xUploadImage, xUploadVideo } from '@/lib/x/api';
import { MEDIA_LIMITS } from '@/lib/media/mapping';

// Publishes ONE claimed LinkedIn / X row (status already 'publishing'). Used by
// /api/publish/social-run. Never touches Facebook / Instagram rows.

export interface SocialPostRow {
  id: string;
  platform: string | null;
  facebook_page_id: string;
  franchise_name: string | null;
  post_content: string | null;
  link_url: string | null;
  link_preview: unknown;
  media_type: string | null;
  media_url: string | null;
}

export type PublishOutcome = { ok: true; platformPostId: string } | { ok: false; error: string };

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Downloads media from our public bucket only (no redirects, size-capped). */
async function fetchOurMedia(url: string, mediaType: string, platform: SocialPlatform): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  if (url.startsWith('storage://')) {
    throw new SocialApiError('Media is still private (not copied to the public bucket); schedule the post again from Approvals', 0);
  }
  if (!isOurPublicMediaUrl(url)) throw new SocialApiError('Media must be in the app\'s public media bucket; re-upload it through the app', 0);
  const isVideo = mediaType === 'video';
  const max = isVideo ? MEDIA_LIMITS.video : platform === 'x' ? X_IMAGE_MAX_BYTES : MEDIA_LIMITS.photo;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: 'error', cache: 'no-store' });
  } catch {
    throw new SocialApiError('Could not download the media file', 0);
  }
  if (!res.ok) throw new SocialApiError(`Could not download the media file (${res.status})`, res.status);
  const declared = Number(res.headers.get('content-length') || NaN);
  if (Number.isFinite(declared) && declared > max) throw new SocialApiError(`Media file is larger than ${Math.round(max / (1024 * 1024))} MB`, 0);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new SocialApiError('Media file is empty', 0);
  if (bytes.byteLength > max) throw new SocialApiError(`Media file is larger than ${Math.round(max / (1024 * 1024))} MB`, 0);
  const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (isVideo && contentType !== 'video/mp4') throw new SocialApiError(`Video must be MP4 (file is ${contentType || 'unknown type'})`, 0);
  if (!isVideo && !IMAGE_TYPES.includes(contentType)) throw new SocialApiError(`Unsupported image type ${contentType || '(unknown)'}`, 0);
  return { bytes, contentType };
}

function articleFor(linkUrl: string, preview: unknown): LinkedInPostContent {
  const p = preview && typeof preview === 'object' ? (preview as Record<string, unknown>) : {};
  let host = linkUrl;
  try { host = new URL(linkUrl).hostname; } catch { /* keep raw */ }
  const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : host;
  const description = typeof p.description === 'string' && p.description.trim() ? p.description.trim() : undefined;
  // No thumbnail: it would need the preview image (another site) downloaded server-side.
  return { kind: 'article', source: linkUrl, title: truncate(title, 400), description: description ? truncate(description, 4000) : undefined };
}

const isHttpUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

export async function publishSocialPost(supabase: SupabaseClient, post: SocialPostRow, deadline: number): Promise<PublishOutcome> {
  const platform: SocialPlatform | null = post.platform === 'linkedin' || post.platform === 'x' ? post.platform : null;
  if (!platform) return { ok: false, error: 'Not a LinkedIn or X post' };
  const name = platform === 'x' ? 'X' : 'LinkedIn';
  const text = String(post.post_content || '');
  const hasMedia = !!post.media_type && !!post.media_url;
  const linkUrl = platform === 'linkedin' && !hasMedia && post.link_url && isHttpUrl(post.link_url) ? post.link_url : null;

  const textProblem = socialTextProblem(platform, text, { hasMedia, hasLink: !!linkUrl });
  if (textProblem) return { ok: false, error: textProblem };

  const mappings = await loadPageMappings(supabase, [post.facebook_page_id]);
  const page = pickMappingFor(platform, mappings.get(String(post.facebook_page_id)));
  if (!page) return { ok: false, error: 'Page not found' };
  const connections = await loadConnectionsLite(supabase, [page.linkedin_connection_id, page.x_connection_id]);
  const pageProblem = pageSocialProblem(platform, page, connections);
  if (pageProblem) return { ok: false, error: `${name}: ${pageProblem}` };
  const connectionId = platform === 'linkedin' ? page.linkedin_connection_id : page.x_connection_id;
  if (!connectionId) return { ok: false, error: `${name}: page has no account connected` };

  const auth = await getAccessToken(supabase, connectionId, platform);
  if (!auth.ok) return { ok: false, error: `${name}: ${auth.error}` };
  const token = auth.token;

  try {
    const media = hasMedia && post.media_type && post.media_url
      ? await fetchOurMedia(post.media_url, post.media_type, platform)
      : null;

    if (platform === 'linkedin') {
      const orgId = page.linkedin_org_id;
      if (!orgId) return { ok: false, error: 'LinkedIn: page has no company page set' };
      let content: LinkedInPostContent = { kind: 'none' };
      if (media && post.media_type === 'video') {
        content = { kind: 'video', urn: await linkedinUploadVideo(token, orgUrn(orgId), media.bytes, deadline) };
      } else if (media) {
        content = { kind: 'image', urn: await linkedinUploadImage(token, orgUrn(orgId), media.bytes, media.contentType) };
      } else if (linkUrl) {
        content = articleFor(linkUrl, post.link_preview);
      }
      const urn = await linkedinCreatePost(token, { orgId, commentary: escapeLittleText(text), content });
      return { ok: true, platformPostId: urn };
    }

    let mediaId: string | null = null;
    if (media && post.media_type === 'video') mediaId = await xUploadVideo(token, media.bytes, deadline);
    else if (media) mediaId = await xUploadImage(token, media.bytes, media.contentType);
    const id = await xCreatePost(token, { text, mediaId });
    return { ok: true, platformPostId: id };
  } catch (e) {
    const msg = errorMessage(e);
    if (e instanceof SocialApiError && e.authFailed) {
      await markConnectionError(supabase, connectionId, `${name} rejected the token: ${msg}`, true);
      return { ok: false, error: `${name} rejected the connected account's token; reconnect it on the Pages tab (${msg})` };
    }
    if (e instanceof SocialApiError && e.status === 403) {
      return { ok: false, error: `${name} refused the post (permission): ${msg}` };
    }
    return { ok: false, error: `${name}: ${msg}` };
  }
}
