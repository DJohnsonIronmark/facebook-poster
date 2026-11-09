// Pure helpers for referring to objects in Supabase Storage without exposing them.
// No imports, so this module runs under plain Node (tests) as well as in Next.
//
// Draft media (client work product awaiting approval) lives in the PRIVATE bucket and is
// stored on posts as a canonical internal reference:
//   storage://facebook-media-drafts/drafts/<yyyy-mm>/<uuid>.<ext>
// The reference is resolved to a short-lived signed URL whenever posts go to a browser, and
// copied to the PUBLIC bucket (Facebook/n8n fetch it unauthenticated) when the post is scheduled.

export const DRAFTS_BUCKET = 'facebook-media-drafts';
export const PUBLIC_BUCKET = 'facebook-media';

const REF_PREFIX = 'storage://';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Only paths this app generates are ever accepted, so a user-supplied value can't point at
// another object, another bucket, or traverse ("..") anywhere.
const DRAFT_PATH_RE = new RegExp(`^drafts/\\d{4}-\\d{2}/${UUID}\\.(jpg|png|gif|webp|mp4|mov)$`);

export interface StorageRef {
  bucket: string;
  path: string;
}

export function isSafeDraftPath(path: string): boolean {
  return DRAFT_PATH_RE.test(path);
}

/** Server-generated object path for a new draft upload, e.g. drafts/2026-11/<uuid>.jpg */
export function draftPathFor(ext: string, uuid: string, now: Date = new Date()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const path = `drafts/${month}/${uuid.toLowerCase()}.${ext.toLowerCase()}`;
  if (!isSafeDraftPath(path)) throw new Error('Invalid draft path');
  return path;
}

export function formatStorageRef(path: string, bucket: string = DRAFTS_BUCKET): string {
  if (bucket !== DRAFTS_BUCKET || !isSafeDraftPath(path)) throw new Error('Invalid storage reference');
  return `${REF_PREFIX}${bucket}/${path}`;
}

/** Parses a storage:// reference to a draft object; null for anything else (http URLs, junk). */
export function parseStorageRef(value: unknown): StorageRef | null {
  if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) return null;
  const rest = value.slice(REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (bucket !== DRAFTS_BUCKET || !isSafeDraftPath(path)) return null;
  return { bucket, path };
}

export function isStorageRef(value: unknown): boolean {
  return parseStorageRef(value) !== null;
}

/**
 * A signed URL we handed out (e.g. round-tripped through the final-copy CSV export) back to the
 * reference it was signed for, so re-importing it doesn't replace the media with an expiring URL.
 * If supabaseUrl is given, the URL must be on that origin.
 */
export function signedUrlToRef(url: unknown, supabaseUrl?: string): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (supabaseUrl) {
    try { if (u.origin !== new URL(supabaseUrl).origin) return null; } catch { return null; }
  }
  const prefix = `/storage/v1/object/sign/${DRAFTS_BUCKET}/`;
  if (!u.pathname.startsWith(prefix)) return null;
  let path: string;
  try { path = decodeURIComponent(u.pathname.slice(prefix.length)); } catch { return null; }
  return isSafeDraftPath(path) ? `${REF_PREFIX}${DRAFTS_BUCKET}/${path}` : null;
}

/** Where a draft object is copied in the public bucket when its post is scheduled (deterministic, so copies are idempotent). */
export function publicPathForDraft(draftPath: string): string {
  if (!isSafeDraftPath(draftPath)) throw new Error('Invalid draft path');
  return `scheduled/${draftPath.slice('drafts/'.length)}`;
}
