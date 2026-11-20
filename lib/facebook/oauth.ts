import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

// Facebook Login used ONLY to discover which Pages the signed-in user manages, so they can be
// imported into facebook_pages. The user token never reaches the browser or the database: it lives
// in an AES-256-GCM encrypted, httpOnly cookie scoped to /api/facebook for 15 minutes.
//
// Publishing is unchanged: n8n uses its own Facebook credential to fetch each page's token, so an
// imported page only publishes if that credential can also access the page.
//
// Env: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, APP_BASE_URL (stable origin registered as the
// Valid OAuth Redirect URI: <APP_BASE_URL>/api/facebook/oauth/callback)

export const GRAPH_VERSION = 'v24.0';
export const STATE_COOKIE = 'fb_oauth_state';
export const TOKEN_COOKIE = 'fb_user_token';
export const COOKIE_PATH = '/api/facebook';
export const TOKEN_TTL_SECONDS = 15 * 60;

export function facebookConfigured(): boolean {
  return !!process.env.FACEBOOK_APP_ID && !!process.env.FACEBOOK_APP_SECRET;
}

export function redirectUri(origin: string): string {
  const base = (process.env.APP_BASE_URL || origin).replace(/\/$/, '');
  return `${base}/api/facebook/oauth/callback`;
}

export function newState(): string {
  return randomBytes(24).toString('base64url');
}

export function statesMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function key(): Buffer {
  return createHash('sha256').update(`${process.env.FACEBOOK_APP_SECRET}:fb-user-token-cookie`).digest();
}

/** Encrypt the user token (bound to the app user who connected) for the httpOnly cookie */
export function sealToken(token: string, appUserId: string, expiresAt: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ t: token, u: appUserId, e: expiresAt }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

export function openToken(sealed: string | undefined, appUserId: string): string | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (json.u !== appUserId || typeof json.e !== 'number' || json.e < Date.now()) return null;
    return typeof json.t === 'string' ? json.t : null;
  } catch {
    return null;
  }
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: COOKIE_PATH,
    maxAge,
  };
}

export async function exchangeCode(code: string, origin: string): Promise<string | null> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', process.env.FACEBOOK_APP_ID!);
  url.searchParams.set('client_secret', process.env.FACEBOOK_APP_SECRET!);
  url.searchParams.set('redirect_uri', redirectUri(origin));
  url.searchParams.set('code', code);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!res.ok) {
    console.error('[facebook] code exchange failed', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = await res.json();
  return typeof data.access_token === 'string' ? data.access_token : null;
}

export interface ManagedPage {
  id: string;
  name: string;
  picture: string | null;
  location: string | null;
}

/** Graph paging cursor: base64url-ish, bounded. Anything else is refused. */
export const PAGE_CURSOR_RE = /^[A-Za-z0-9_\-=]{1,512}$/;

const PAGE_FIELDS = 'id,name,picture{url},location{city,state}';
const PAGE_BATCH = 100;           // pages per Graph call (Graph's /me/accounts maximum page size we rely on)
const CALLS_PER_CHUNK = 3;        // Graph calls per request → up to 300 pages per request
const CHUNK_BUDGET_MS = 8000;     // stop starting new Graph calls after this, so a request never runs long

/**
 * One chunk of the pages the user manages (/me/accounts): up to 300 pages per call, plus the cursor
 * to continue from (null = no more pages). There is no overall cap here: the browser keeps asking
 * with the returned cursor until it is null, so each request stays short whatever the account size.
 */
export async function listManagedPagesChunk(userToken: string, after: string | null): Promise<{ pages: ManagedPage[]; after: string | null }> {
  if (after !== null && !PAGE_CURSOR_RE.test(after)) throw new Error('Invalid page cursor');
  const started = Date.now();
  const out: ManagedPage[] = [];
  let cursor: string | null = after;
  for (let i = 0; i < CALLS_PER_CHUNK; i++) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`);
    url.searchParams.set('fields', PAGE_FIELDS);
    url.searchParams.set('limit', String(PAGE_BATCH));
    if (cursor) url.searchParams.set('after', cursor);
    url.searchParams.set('access_token', userToken);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!res.ok) throw new Error(`Graph /me/accounts failed (${res.status})`);
    const data = await res.json();
    for (const p of data.data || []) {
      const loc = p.location ? [p.location.city, p.location.state].filter(Boolean).join(', ') : '';
      out.push({ id: String(p.id), name: String(p.name || ''), picture: p.picture?.data?.url || null, location: loc || null });
    }
    // Graph includes cursors on the last page too; only `paging.next` means there is more
    const nextCursor = data.paging?.next ? data.paging?.cursors?.after : null;
    cursor = typeof nextCursor === 'string' && PAGE_CURSOR_RE.test(nextCursor) ? nextCursor : null;
    if (!cursor || Date.now() - started > CHUNK_BUDGET_MS) break;
  }
  return { pages: out, after: cursor };
}
