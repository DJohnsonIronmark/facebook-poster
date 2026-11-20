// Pure LinkedIn / X content rules shared by the browser (CSV preview, form, review screens) and
// server routes. No imports, so this module also runs under plain Node (tests).
//
// X (docs.x.com, verified 11/9): a post holds text and up to 4 photos, or 1 GIF, or 1 video.
//   tweet_image ≤ 5 MB (JPG/PNG/GIF/WEBP); video MP4. Text limit 280 "weighted" characters with
//   every URL counted as 23 — the weighting below follows X's open-source twitter-text config v3
//   [not on the pages we read; treat as close, not exact].
// LinkedIn (learn.microsoft.com, verified 11/9): organization posts take text, one image (JPG/PNG/
//   GIF), one MP4 video (3 s – 30 min), or an article link. Commentary limit is not stated in the
//   docs we read; 3,000 is LinkedIn's long-standing UI limit [unverified for the API].

export const X_TEXT_MAX = 280;
export const X_URL_WEIGHT = 23;
export const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const LINKEDIN_TEXT_MAX = 3000;
export const LINKEDIN_VIDEO_MIN_SECONDS = 3;
export const LINKEDIN_VIDEO_MAX_SECONDS = 30 * 60;

export interface TextIssues {
  errors: string[];
  warnings: string[];
}

// twitter-text v3: code points in these ranges weigh 1, everything else (CJK, most emoji) weighs 2.
const LIGHT_RANGES: [number, number][] = [
  [0, 4351], [8192, 8205], [8208, 8223], [8242, 8247],
];

const URL_RE = /\bhttps?:\/\/[^\s]+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|us|gov|edu|info|biz|app|ai)(?:\/[^\s]*)?/gi;

function codePointWeight(cp: number): number {
  for (const [lo, hi] of LIGHT_RANGES) if (cp >= lo && cp <= hi) return 1;
  return 2;
}

/** X weighted length: URLs = 23 each, other code points 1 or 2. */
export function xWeightedLength(text: string): number {
  let total = 0;
  const withoutUrls = String(text ?? '').normalize('NFC').replace(URL_RE, () => {
    total += X_URL_WEIGHT;
    return '';
  });
  for (const ch of withoutUrls) total += codePointWeight(ch.codePointAt(0) ?? 0);
  return total;
}

export function hasUrl(text: string): boolean {
  URL_RE.lastIndex = 0;
  const found = URL_RE.test(String(text ?? ''));
  URL_RE.lastIndex = 0;
  return found;
}

export function validateXText(text: string, opts: { hasMedia: boolean } = { hasMedia: false }): TextIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = String(text ?? '');
  const len = xWeightedLength(t);
  if (!t.trim() && !opts.hasMedia) errors.push('X posts need text or a photo/video');
  if (len > X_TEXT_MAX) errors.push(`X text is ${len}/${X_TEXT_MAX} characters (links count as ${X_URL_WEIGHT})`);
  if (hasUrl(t)) warnings.push('X charges more for posts with a link (about $0.20 vs $0.015)');
  return { errors, warnings };
}

export function validateLinkedInText(text: string, opts: { hasMedia: boolean; hasLink: boolean } = { hasMedia: false, hasLink: false }): TextIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = String(text ?? '');
  if (!t.trim() && !opts.hasMedia && !opts.hasLink) errors.push('LinkedIn posts need text, a photo/video, or a link');
  if (t.length > LINKEDIN_TEXT_MAX) errors.push(`LinkedIn text is ${t.length}/${LINKEDIN_TEXT_MAX} characters`);
  return { errors, warnings };
}

/** Media allowed per platform, judged from the stored URL / file name extension. */
export function socialMediaProblem(platform: 'linkedin' | 'x', mediaType: string | null, mediaUrl: string | null): string | null {
  if (!mediaType || !mediaUrl) return null;
  const path = String(mediaUrl).split('?')[0].toLowerCase();
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const name = platform === 'x' ? 'X' : 'LinkedIn';
  if (mediaType === 'video') {
    if (ext !== 'mp4') return `${name} video must be an MP4 file`;
    return null;
  }
  const okImage = platform === 'x' ? ['jpg', 'jpeg', 'png', 'gif', 'webp'] : ['jpg', 'jpeg', 'png', 'gif'];
  if (!okImage.includes(ext)) return `${name} photo must be ${okImage.join('/').toUpperCase()}`;
  return null;
}

/** Public URL of a published post, for "View on …" links. */
export function publishedPostUrl(platform: string | null | undefined, platformPostId: string | null | undefined, xUsername?: string | null): string | null {
  if (!platformPostId) return null;
  if (platform === 'linkedin') return `https://www.linkedin.com/feed/update/${encodeURIComponent(platformPostId)}/`;
  if (platform === 'x') return `https://x.com/${xUsername ? encodeURIComponent(xUsername) : 'i'}/status/${encodeURIComponent(platformPostId)}`;
  return null;
}
