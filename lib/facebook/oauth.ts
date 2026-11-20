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

/** Pages the user manages (/me/accounts), following paging up to 1,000 pages. */
export async function listManagedPages(userToken: string): Promise<ManagedPage[]> {
  const out: ManagedPage[] = [];
  let next: string | null =
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,picture{url},location{city,state}&limit=100`;
  for (let i = 0; next && i < 10; i++) {
    const url: URL = new URL(next);
    if (url.hostname !== 'graph.facebook.com') break; // only follow Graph paging links
    url.searchParams.set('access_token', userToken);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!res.ok) throw new Error(`Graph /me/accounts failed (${res.status})`);
    const data = await res.json();
    for (const p of data.data || []) {
      const loc = p.location ? [p.location.city, p.location.state].filter(Boolean).join(', ') : '';
      out.push({ id: String(p.id), name: String(p.name || ''), picture: p.picture?.data?.url || null, location: loc || null });
    }
    next = data.paging?.next || null;
  }
  return out;
}
