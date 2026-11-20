import { randomBytes, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { decryptToken, encryptToken } from './crypto';

// OAuth state for "Connect LinkedIn" / "Connect X". The state (and the X PKCE verifier) live in an
// httpOnly cookie sealed with SOCIAL_TOKEN_KEY, bound to the app user who started the flow,
// scoped to that provider's /oauth path, and valid for 10 minutes.

export type OAuthProvider = 'linkedin' | 'x';

export const OAUTH_TTL_SECONDS = 10 * 60;

export const cookieName = (p: OAuthProvider) => `${p}_oauth`;
export const cookiePath = (p: OAuthProvider) => `/api/${p}/oauth`;

export function callbackUri(provider: OAuthProvider, origin: string): string {
  const base = (process.env.APP_BASE_URL || origin).replace(/\/$/, '');
  return `${base}/api/${provider}/oauth/callback`;
}

export function newState(): string {
  return randomBytes(24).toString('base64url');
}

export function statesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface OAuthCookie {
  state: string;
  verifier?: string;
}

const aad = (provider: OAuthProvider, appUserId: string) => `fb-poster:oauth:${provider}:${appUserId}`;

export function sealOAuthCookie(provider: OAuthProvider, appUserId: string, value: OAuthCookie): string {
  const payload = JSON.stringify({ ...value, e: Date.now() + OAUTH_TTL_SECONDS * 1000 });
  return encryptToken(payload, aad(provider, appUserId));
}

export function openOAuthCookie(provider: OAuthProvider, appUserId: string, sealed: string | undefined): OAuthCookie | null {
  const plain = decryptToken(sealed, aad(provider, appUserId));
  if (!plain) return null;
  try {
    const j: unknown = JSON.parse(plain);
    if (!j || typeof j !== 'object') return null;
    const o = j as Record<string, unknown>;
    if (typeof o.state !== 'string' || typeof o.e !== 'number' || o.e < Date.now()) return null;
    return { state: o.state, verifier: typeof o.verifier === 'string' ? o.verifier : undefined };
  } catch {
    return null;
  }
}

export function oauthCookieOptions(provider: OAuthProvider, maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: cookiePath(provider),
    maxAge,
  };
}

/** Back to the Pages tab with connected=<provider> or connect_error=<code>; always clears the cookie. */
export function finishRedirect(provider: OAuthProvider, origin: string, result: { error: string } | 'connected'): NextResponse {
  const base = (process.env.APP_BASE_URL || origin).replace(/\/$/, '');
  const qs = result === 'connected'
    ? `connected=${provider}`
    : `connect_error=${encodeURIComponent(result.error)}&provider=${provider}`;
  const res = NextResponse.redirect(new URL(`/?tab=pages&${qs}`, base));
  res.cookies.set(cookieName(provider), '', oauthCookieOptions(provider, 0));
  return res;
}
