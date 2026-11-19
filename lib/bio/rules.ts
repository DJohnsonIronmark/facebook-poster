// Pure rules for the Instagram "link in bio" page. No imports, so this runs under plain Node tests.
//
// A link in bio page is a public page per Instagram account (/l/<slug>) that mirrors the account's
// grid of posts published through this app. Each tile opens the link the team attached to that post
// (bio_link_url), and buttons at the top hold the brand's standing links (website, book, call).

export const BIO_SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
export const BIO_TITLE_MAX = 80;
export const BIO_BUTTON_MAX = 6;
export const BIO_BUTTON_LABEL_MAX = 40;
export const BIO_URL_MAX = 2000;
export const BIO_GRID_LIMIT = 60;

export type Clean<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BioButton {
  label: string;
  url: string;
}

/** Slug for /l/<slug>: lowercase letters, numbers, . _ - ; 2–40 characters; starts with a letter or number. */
export function cleanBioSlug(value: unknown): Clean<string> {
  const v = typeof value === 'string' ? value.trim().toLowerCase().replace(/^@/, '') : '';
  if (!BIO_SLUG_RE.test(v)) {
    return { ok: false, error: 'Page address must be 2–40 characters: lowercase letters, numbers, periods, underscores or hyphens' };
  }
  return { ok: true, value: v };
}

/** Suggested slug from an Instagram handle (null when it can't make a valid one). */
export function slugFromUsername(username: string | null | undefined): string | null {
  const v = String(username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return BIO_SLUG_RE.test(v) ? v : null;
}

/**
 * A link a visitor is sent to. Only http(s), no embedded credentials, a real host name.
 * Blank → null (no link). Returns the normalized URL.
 */
export function cleanBioUrl(value: unknown): Clean<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'Link must be text' };
  const v = value.trim();
  if (!v) return { ok: true, value: null };
  if (v.length > BIO_URL_MAX) return { ok: false, error: `Link is too long (max ${BIO_URL_MAX} characters)` };
  let u: URL;
  try { u = new URL(v); } catch { return { ok: false, error: 'Link must be a full web address (https://…)' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Link must start with https:// or http://' };
  if (u.username || u.password) return { ok: false, error: 'Link cannot contain a user name or password' };
  if (!u.hostname.includes('.')) return { ok: false, error: 'Link must be a full web address (https://…)' };
  return { ok: true, value: u.toString() };
}

export function cleanBioTitle(value: unknown): Clean<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'Title must be text' };
  const v = value.replace(/\s+/g, ' ').trim();
  if (v.length > BIO_TITLE_MAX) return { ok: false, error: `Title is too long (max ${BIO_TITLE_MAX} characters)` };
  return { ok: true, value: v || null };
}

/** Header buttons: up to 6, each with a label and a valid link. Rows with both blank are dropped. */
export function cleanBioButtons(value: unknown): Clean<BioButton[]> {
  if (value === null || value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'Buttons must be a list' };
  const out: BioButton[] = [];
  for (const raw of value) {
    const label = typeof raw?.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim() : '';
    const urlRaw = typeof raw?.url === 'string' ? raw.url.trim() : '';
    if (!label && !urlRaw) continue;
    if (!label) return { ok: false, error: 'Every button needs a label' };
    if (label.length > BIO_BUTTON_LABEL_MAX) return { ok: false, error: `Button label "${label.slice(0, 20)}…" is too long (max ${BIO_BUTTON_LABEL_MAX})` };
    const url = cleanBioUrl(urlRaw);
    if (!url.ok) return { ok: false, error: `Button "${label}": ${url.error}` };
    if (!url.value) return { ok: false, error: `Button "${label}" needs a link` };
    out.push({ label, url: url.value });
  }
  if (out.length > BIO_BUTTON_MAX) return { ok: false, error: `Up to ${BIO_BUTTON_MAX} buttons` };
  return { ok: true, value: out };
}

export interface BioTileSource {
  id: string;
  media_url: string | null;
  media_type: string | null;
  bio_link_url: string | null;
  bio_hidden?: boolean | null;
  published_at: string | null;
  post_content?: string | null;
}

export interface BioTile {
  id: string;
  image: string;
  isVideo: boolean;
  link: string | null;
  alt: string;
}

/**
 * Published posts → public grid tiles, newest first. Drops hidden posts, posts without public media,
 * and any link that no longer passes cleanBioUrl. `isPublicMedia` decides which media URLs are safe
 * to show (our public bucket only).
 */
export function buildBioTiles(posts: BioTileSource[], isPublicMedia: (url: string) => boolean, limit = BIO_GRID_LIMIT): BioTile[] {
  return posts
    .filter((p) => !p.bio_hidden && !!p.media_url && isPublicMedia(p.media_url))
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
    .slice(0, limit)
    .map((p) => {
      const link = cleanBioUrl(p.bio_link_url);
      const alt = String(p.post_content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return { id: p.id, image: p.media_url as string, isVideo: p.media_type === 'video', link: link.ok ? link.value : null, alt };
    });
}
