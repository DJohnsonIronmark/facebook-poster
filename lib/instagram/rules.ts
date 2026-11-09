// Pure Instagram rules shared by the browser (CSV preview, single-post form) and server routes.
// No imports, so this module also runs under plain Node (tests).
//
// Instagram Graph API constraints (content publishing via container → media_publish):
//   * feed images: JPEG only, aspect ratio 4:5 (0.8) to 1.91:1, max 8 MB; width ≤ 1440 recommended
//   * Reels: MP4/MOV, 3 s to 15 min, 9:16 recommended
//   * caption ≤ 2,200 characters, max 30 hashtags; links in captions are not clickable
//   * every post needs a photo or video (no text-only posts) and an IG Business/Creator account
//     linked to the Facebook Page

export type Platform = 'facebook' | 'instagram';
export type IgMediaKind = 'photo' | 'video';

export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;
export const IG_HASHTAG_WARN = 5;
export const IG_MIN_RATIO = 0.8;   // 4:5 portrait
export const IG_MAX_RATIO = 1.91;  // 1.91:1 landscape
export const IG_MAX_WIDTH = 1440;
export const IG_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IG_VIDEO_MIN_SECONDS = 3;
export const IG_VIDEO_MAX_SECONDS = 15 * 60;
export const IG_REELS_RATIO = 9 / 16;

export const IG_USER_ID_RE = /^\d{5,25}$/;
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

export const PLATFORM_LABEL: Record<Platform, string> = { facebook: 'Facebook', instagram: 'Instagram' };

// ---------------------------------------------------------------------------------------------
// Platforms

const PLATFORM_ALIASES: Record<string, Platform> = {
  fb: 'facebook', facebook: 'facebook',
  ig: 'instagram', insta: 'instagram', instagram: 'instagram',
};

export type PlatformsCell = { ok: true; platforms: Platform[] } | { ok: false; message: string };

/**
 * CSV `platforms` cell → platforms (Facebook first). Blank means Facebook only (every CSV made
 * before Instagram support keeps working). Accepts fb / ig / facebook / instagram separated by
 * commas, semicolons, "+", "/", "|" or spaces, e.g. "fb,ig", "Facebook + Instagram".
 */
export function parsePlatformsCell(value: string | null | undefined): PlatformsCell {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, platforms: ['facebook'] };
  const tokens = raw.toLowerCase().split(/[\s,;+/|]+/).filter(Boolean);
  const found = new Set<Platform>();
  for (const t of tokens) {
    const p = PLATFORM_ALIASES[t];
    if (!p) return { ok: false, message: `platforms "${raw}" must be fb, ig or fb,ig` };
    found.add(p);
  }
  const platforms = (['facebook', 'instagram'] as Platform[]).filter((p) => found.has(p));
  return platforms.length ? { ok: true, platforms } : { ok: false, message: `platforms "${raw}" must be fb, ig or fb,ig` };
}

/** Server-side: a row's `platform` field. Missing/blank = facebook (legacy callers); anything unknown = null (reject). */
export function normalizePlatform(value: unknown): Platform | null {
  if (value === undefined || value === null || value === '') return 'facebook';
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'facebook' || v === 'instagram') return v;
  return null;
}

/** Platform of a stored row; rows from before the migration (no column) are Facebook. */
export function rowPlatform(row: { platform?: string | null }): Platform {
  return row.platform === 'instagram' ? 'instagram' : 'facebook';
}

/** The server-side switch. Off unless INSTAGRAM_PUBLISHING_ENABLED is explicitly true/1/yes/on. */
export function isInstagramPublishingEnabled(value: string | null | undefined): boolean {
  return /^(true|1|yes|on)$/i.test(String(value ?? '').trim());
}

// ---------------------------------------------------------------------------------------------
// Pages

/** Normalizes an Instagram username input ("@Name" → "Name"); '' when blank; null when invalid. */
export function cleanIgUsername(value: unknown): string | null {
  const s = (typeof value === 'string' ? value : '').trim().replace(/^@+/, '');
  if (!s) return '';
  return IG_USERNAME_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------------------------
// Captions

// RegExp() rather than literals: the 'u' flag literal is rejected under the ES5 TS target.
// A hashtag/mention starts at the beginning or after a non-word character (so "a#b" and HTML
// entities like "&#39;" don't count).
const HASHTAG_RE = new RegExp('(^|[^\\p{L}\\p{N}_&])#([\\p{L}\\p{N}_]+)', 'gu');
const URL_RE = /https?:\/\/[^\s]+/i;

export function countHashtags(text: string): number {
  return Array.from(String(text || '').matchAll(HASHTAG_RE)).length;
}

export interface Issues {
  errors: string[];
  warnings: string[];
}

export function validateIgCaption(caption: string): Issues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = String(caption || '');
  if (text.length > IG_CAPTION_MAX) {
    errors.push(`Instagram caption is ${text.length.toLocaleString('en-US')} characters (max ${IG_CAPTION_MAX.toLocaleString('en-US')})`);
  }
  const tags = countHashtags(text);
  if (tags > IG_HASHTAG_MAX) errors.push(`Instagram allows at most ${IG_HASHTAG_MAX} hashtags (found ${tags})`);
  else if (tags > IG_HASHTAG_WARN) warnings.push(`${tags} hashtags; Instagram recommends ${IG_HASHTAG_WARN} or fewer`);
  if (URL_RE.test(text)) warnings.push('Links in Instagram captions are not clickable');
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// Images: aspect ratio + center-crop plan for the JPEG derivative

export interface CropPlan {
  /** source rectangle (pixels in the original image) */
  sx: number; sy: number; sw: number; sh: number;
  /** output size of the JPEG derivative */
  width: number; height: number;
  cropped: boolean;
  originalRatio: number;
  ratio: number;
  /** human description of the crop (empty when not cropped) */
  note: string;
}

export function formatRatio(r: number): string {
  if (Math.abs(r - 0.8) < 0.005) return '4:5';
  if (Math.abs(r - 1) < 0.005) return '1:1';
  if (Math.abs(r - 1.91) < 0.005) return '1.91:1';
  if (Math.abs(r - 9 / 16) < 0.005) return '9:16';
  if (Math.abs(r - 16 / 9) < 0.005) return '16:9';
  return `${r.toFixed(2)}:1`;
}

/**
 * Plans the Instagram derivative for an image: center-crop to the nearest allowed ratio when
 * outside 4:5–1.91:1, then scale down to at most 1440 px wide. Never upscales.
 */
export function planInstagramImage(width: number, height: number): CropPlan {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!(w > 0 && h > 0)) throw new Error('Image has no size');
  const originalRatio = w / h;

  let sx = 0, sy = 0, sw = w, sh = h;
  if (originalRatio < IG_MIN_RATIO) {
    // too tall: keep full width, trim top and bottom
    sh = Math.min(h, Math.floor(w / IG_MIN_RATIO));
    sy = Math.floor((h - sh) / 2);
  } else if (originalRatio > IG_MAX_RATIO) {
    // too wide: keep full height, trim left and right
    sw = Math.min(w, Math.floor(h * IG_MAX_RATIO));
    sx = Math.floor((w - sw) / 2);
  }
  const cropped = sw !== w || sh !== h;

  const outW = Math.min(sw, IG_MAX_WIDTH);
  let outH = Math.max(1, Math.round((outW * sh) / sw));
  // rounding must not push the output outside the allowed range
  if (outW / outH < IG_MIN_RATIO) outH = Math.floor(outW / IG_MIN_RATIO);
  if (outW / outH > IG_MAX_RATIO) outH = Math.ceil(outW / IG_MAX_RATIO);

  const ratio = outW / outH;
  const note = cropped
    ? `Cropped from ${formatRatio(originalRatio)} to ${formatRatio(ratio)} (${originalRatio < IG_MIN_RATIO ? 'top and bottom' : 'left and right'} trimmed, centered) for Instagram`
    : '';
  return { sx, sy, sw, sh, width: outW, height: outH, cropped, originalRatio, ratio, note };
}

export function isAllowedIgImageRatio(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  const r = width / height;
  return r >= IG_MIN_RATIO - 1e-9 && r <= IG_MAX_RATIO + 1e-9;
}

// ---------------------------------------------------------------------------------------------
// Video

export function validateIgVideo(meta: { duration: number; width: number; height: number }): Issues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const d = Number(meta.duration);
  if (!Number.isFinite(d) || d <= 0) errors.push('Could not read the video length');
  else if (d < IG_VIDEO_MIN_SECONDS) errors.push(`Video is ${d.toFixed(1)} s; Instagram needs at least ${IG_VIDEO_MIN_SECONDS} s`);
  else if (d > IG_VIDEO_MAX_SECONDS) errors.push(`Video is ${Math.round(d / 60)} min; Instagram Reels max 15 min`);
  if (meta.width > 0 && meta.height > 0) {
    const r = meta.width / meta.height;
    if (Math.abs(r - IG_REELS_RATIO) > 0.02) {
      warnings.push(`Video is ${formatRatio(r)}; Instagram Reels look best at 9:16 (vertical)`);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// Media URLs (server-side check of what an Instagram row may point at)

const IG_EXT: Record<IgMediaKind, string[]> = { photo: ['jpg', 'jpeg'], video: ['mp4', 'mov'] };

function extOf(path: string): string {
  const last = path.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * Instagram media must be a JPEG photo or an MP4/MOV video, either our private draft upload
 * (storage://… ref, validated separately) or an https URL whose path ends in that extension.
 */
export function isInstagramMediaUrl(url: unknown, kind: IgMediaKind | string | null | undefined): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  const k: IgMediaKind | null = kind === 'photo' || kind === 'image' ? 'photo' : kind === 'video' ? 'video' : null;
  if (!k) return false;
  const v = url.trim();
  if (v.startsWith('storage://')) return IG_EXT[k].includes(extOf(v));
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return IG_EXT[k].includes(extOf(u.pathname));
}

// ---------------------------------------------------------------------------------------------
// Whole-post validation (used by the CSV preview, single-post form and server routes)

export interface IgPostInput {
  caption: string;
  hasIgAccount: boolean;
  mediaKind: IgMediaKind | null;
}

export type IgTargetMedia =
  | { source: 'none' }
  /** uploaded file; `prepared` is the browser analysis (undefined while it runs) */
  | { source: 'file'; kind: IgMediaKind; prepared?: { errors: string[]; warnings: string[] } }
  | { source: 'url'; kind: IgMediaKind; url: string };

export interface IgTargetInput {
  caption: string;          // placeholders already filled in
  pageFound: boolean;
  hasIgAccount: boolean;
  media: IgTargetMedia;
  /** true when the page's client is NOT on the approval workflow (row goes straight to /api/posts) */
  direct: boolean;
  instagramEnabled: boolean;
  hasSchedule: boolean;
  publishNow?: boolean;
}

/**
 * Everything the create form checks for one Instagram post (CSV row or single-post page) before
 * anything is uploaded. `pending` = media analysis still running (block submit until done).
 */
export function evaluateInstagramTarget(input: IgTargetInput): Issues & { pending: boolean } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let pending = false;
  const m = input.media;
  const base = validateInstagramPost({
    caption: input.caption,
    hasIgAccount: input.hasIgAccount || !input.pageFound, // "page not found" is reported separately
    mediaKind: m.source === 'none' ? null : m.kind,
  });
  errors.push(...base.errors);
  warnings.push(...base.warnings);
  if (m.source === 'file') {
    if (!m.prepared) pending = true;
    else { errors.push(...m.prepared.errors); warnings.push(...m.prepared.warnings); }
  } else if (m.source === 'url') {
    if (!isInstagramMediaUrl(m.url, m.kind)) {
      errors.push(m.kind === 'video'
        ? 'Instagram needs an https link to an .mp4 or .mov video'
        : 'Instagram needs an https link to a .jpg photo (or upload the file with the CSV so it is converted)');
    } else if (m.kind === 'photo') {
      warnings.push("Linked photo can't be checked here; it must be 4:5 to 1.91:1 or Instagram rejects it");
    }
  }
  if (input.direct) {
    if (!input.instagramEnabled) {
      errors.push("Instagram publishing isn't enabled yet; for now Instagram posts only go through the client approval workflow");
    } else {
      if (input.publishNow) errors.push("Instagram posts can't be published immediately; schedule them");
      else if (!input.hasSchedule) errors.push('Instagram posts need a schedule date');
    }
  }
  return { errors, warnings, pending };
}

export function validateInstagramPost(input: IgPostInput): Issues {
  const errors: string[] = [];
  if (!input.hasIgAccount) errors.push('This page has no Instagram account set (Pages tab → Edit → Instagram account ID)');
  if (!input.mediaKind) errors.push('Instagram posts need a photo or video');
  const caption = validateIgCaption(input.caption);
  return { errors: [...errors, ...caption.errors], warnings: caption.warnings };
}
