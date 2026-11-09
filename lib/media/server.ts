import type { SupabaseClient } from '@supabase/supabase-js';
import { ALLOWED_MEDIA, MEDIA_LIMITS } from './mapping';
import {
  DRAFTS_BUCKET, PUBLIC_BUCKET, isStorageRef, parseStorageRef, publicPathForDraft, signedUrlToRef,
} from './storageRef';

// Server-only helpers for private draft media (service-role client required).

export const SIGNED_URL_TTL_SECONDS = 60 * 60;

const isHttpUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

/**
 * Normalizes a media_url coming from a request: a storage ref stays a ref, a signed URL we issued
 * goes back to its ref, any other http(s) URL is kept (legacy URL-based media). Anything else → invalid.
 */
export function normalizeIncomingMediaUrl(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const v = value.trim();
  if (!v) return { ok: true, value: null };
  if (isStorageRef(v)) return { ok: true, value: v };
  const fromSigned = signedUrlToRef(v, process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (fromSigned) return { ok: true, value: fromSigned };
  if (v.startsWith('storage://')) return { ok: false };
  return isHttpUrl(v) ? { ok: true, value: v } : { ok: false };
}

/**
 * Replaces private storage refs in `media_url` with short-lived signed URLs (in place) so the
 * browser can preview them. The original ref is kept in `media_storage_ref`.
 */
export async function signPostMedia<T extends { media_url?: string | null; media_storage_ref?: string | null }>(
  supabase: SupabaseClient,
  posts: T[],
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<T[]> {
  const paths = Array.from(new Set(
    posts.map((p) => parseStorageRef(p.media_url)?.path).filter((p): p is string => !!p),
  ));
  if (paths.length === 0) return posts;

  const signed = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    const { data, error } = await supabase.storage.from(DRAFTS_BUCKET).createSignedUrls(paths.slice(i, i + 500), ttlSeconds);
    if (error) { console.error('signPostMedia', error); continue; }
    for (const d of data || []) if (d.path && d.signedUrl && !d.error) signed.set(d.path, d.signedUrl);
  }
  for (const p of posts) {
    const original = p.media_url;
    const ref = parseStorageRef(original);
    if (!ref || !original) continue;
    p.media_storage_ref = original;
    p.media_url = signed.get(ref.path) ?? null;
  }
  return posts;
}

export type PublishMediaResult = { ok: true; url: string | null } | { ok: false; error: string };

/**
 * Makes a post's media publicly fetchable for Facebook/n8n. Storage refs are verified (real size
 * and type, since the browser's claims at upload time are not trusted) and copied into the public
 * bucket at a deterministic path, so publishing the same file for many posts copies it once.
 * http(s) URLs and null pass through unchanged.
 */
export async function publishDraftMedia(
  supabase: SupabaseClient,
  mediaUrl: string | null | undefined,
  mediaType?: string | null,
): Promise<PublishMediaResult> {
  if (!mediaUrl) return { ok: true, url: null };
  const ref = parseStorageRef(mediaUrl);
  if (!ref) {
    if (mediaUrl.startsWith('storage://')) return { ok: false, error: 'invalid media reference' };
    return { ok: true, url: mediaUrl };
  }

  const drafts = supabase.storage.from(DRAFTS_BUCKET);
  const info = await drafts.info(ref.path);
  if (info.error || !info.data) return { ok: false, error: 'media file not found (upload may have failed)' };
  const contentType = String(info.data.contentType || info.data.metadata?.mimetype || '').toLowerCase();
  const rule = ALLOWED_MEDIA[contentType];
  const size = Number(info.data.size ?? info.data.metadata?.size ?? NaN);
  if (!rule) return { ok: false, error: `unsupported media type ${contentType || '(unknown)'}` };
  if (!Number.isFinite(size) || size <= 0 || size > MEDIA_LIMITS[rule.kind]) return { ok: false, error: 'media file too large or empty' };
  const wanted = mediaType === 'image' ? 'photo' : mediaType;
  if (wanted && wanted !== rule.kind) return { ok: false, error: `post is ${wanted} but file is ${rule.kind}` };

  const publicPath = publicPathForDraft(ref.path);
  const copy = await drafts.copy(ref.path, publicPath, { destinationBucket: PUBLIC_BUCKET });
  if (copy.error) {
    // Already copied for another post (or a retried request): fine if it's really there
    const exists = await supabase.storage.from(PUBLIC_BUCKET).exists(publicPath);
    if (!exists.data) {
      console.error('publishDraftMedia copy', copy.error);
      return { ok: false, error: 'failed to copy media to the public bucket' };
    }
  }
  return { ok: true, url: supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(publicPath).data.publicUrl };
}

/** publishDraftMedia with a per-request cache (a batch usually reuses one file across many posts). */
export function createMediaPublisher(supabase: SupabaseClient) {
  const cache = new Map<string, Promise<PublishMediaResult>>();
  return (mediaUrl: string | null | undefined, mediaType?: string | null) => {
    const key = `${mediaType || ''}|${mediaUrl || ''}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = publishDraftMedia(supabase, mediaUrl, mediaType);
      cache.set(key, pending);
    }
    return pending;
  };
}
