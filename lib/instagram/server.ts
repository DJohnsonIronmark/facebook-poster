import type { SupabaseClient } from '@supabase/supabase-js';
import { isInstagramMediaUrl, isInstagramPublishingEnabled, validateIgCaption } from './rules';

// Server-only Instagram helpers.

/** INSTAGRAM_PUBLISHING_ENABLED (default off). See lib/instagram/release.ts for what it gates. */
export function instagramPublishingEnabled(): boolean {
  return isInstagramPublishingEnabled(process.env.INSTAGRAM_PUBLISHING_ENABLED);
}

/**
 * Server-side rules for an Instagram row's content/media (the browser checks the same rules, but
 * requests are not trusted). Returns an error message or null.
 */
export function instagramRowProblem(input: {
  caption: string;
  mediaType: string | null;
  mediaUrl: string | null;
  igUserId: string | null | undefined;
}): string | null {
  if (!input.igUserId) return 'page has no Instagram account (set it on the Pages tab)';
  return instagramMediaProblem(input.mediaType, input.mediaUrl) || instagramCaptionProblem(input.caption);
}

export function instagramMediaProblem(mediaType: string | null, mediaUrl: string | null): string | null {
  if (!mediaType || !mediaUrl) return 'Instagram posts need a photo or video';
  if (!isInstagramMediaUrl(mediaUrl, mediaType)) {
    return mediaType === 'video'
      ? 'Instagram video must be an MP4 or MOV file'
      : 'Instagram photo must be a JPEG (upload it through the app so it is converted)';
  }
  return null;
}

export function instagramCaptionProblem(caption: string): string | null {
  const { errors } = validateIgCaption(caption);
  return errors[0] || null;
}

interface WithPageAndPlatform {
  facebook_page_id: string;
  platform?: string | null;
  ig_username?: string | null;
}

/**
 * Adds ig_username (from facebook_pages) to Instagram posts for the preview header. Matches on
 * the Facebook page id stored on the post.
 */
export async function attachInstagramUsernames<T extends WithPageAndPlatform>(supabase: SupabaseClient, posts: T[]): Promise<T[]> {
  const ids = Array.from(new Set(posts.filter((p) => p.platform === 'instagram').map((p) => p.facebook_page_id)));
  if (ids.length === 0) return posts;
  const names = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase
      .from('facebook_pages').select('facebook_page_id, ig_username').in('facebook_page_id', ids.slice(i, i + 300));
    if (error) { console.error('attachInstagramUsernames', error); continue; }
    for (const r of (data || []) as { facebook_page_id: string; ig_username: string | null }[]) {
      names.set(String(r.facebook_page_id), r.ig_username);
    }
  }
  for (const p of posts) if (p.platform === 'instagram') p.ig_username = names.get(String(p.facebook_page_id)) ?? null;
  return posts;
}
