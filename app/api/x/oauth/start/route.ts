import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { xAuthorizeUrl, xConfigured } from '@/lib/x/api';
import { codeChallengeS256, newCodeVerifier } from '@/lib/x/pkce';
import { callbackUri, cookieName, finishRedirect, newState, oauthCookieOptions, OAUTH_TTL_SECONDS, sealOAuthCookie } from '@/lib/social/oauth';

// GET - start "Connect X" (admin only). OAuth 2.0 + PKCE (S256); the verifier stays in the sealed cookie.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const { user, error: authError } = await requireRole(['admin']);
  if (authError || !user) return finishRedirect('x', origin, { error: 'forbidden' });
  if (!xConfigured()) return finishRedirect('x', origin, { error: 'not_configured' });

  const state = newState();
  const verifier = newCodeVerifier();
  const res = NextResponse.redirect(xAuthorizeUrl(state, codeChallengeS256(verifier), callbackUri('x', origin)));
  res.cookies.set(cookieName('x'), sealOAuthCookie('x', user.id, { state, verifier }), oauthCookieOptions('x', OAUTH_TTL_SECONDS));
  return res;
}
