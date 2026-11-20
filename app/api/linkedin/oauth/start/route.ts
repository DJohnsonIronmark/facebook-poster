import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { linkedinAuthorizeUrl, linkedinConfigured } from '@/lib/linkedin/api';
import { callbackUri, cookieName, finishRedirect, newState, oauthCookieOptions, OAUTH_TTL_SECONDS, sealOAuthCookie } from '@/lib/social/oauth';

// GET - start "Connect LinkedIn" (admin only). Redirects to LinkedIn's consent screen.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const { user, error: authError } = await requireRole(['admin']);
  if (authError || !user) return finishRedirect('linkedin', origin, { error: 'forbidden' });
  if (!linkedinConfigured()) return finishRedirect('linkedin', origin, { error: 'not_configured' });

  const state = newState();
  const res = NextResponse.redirect(linkedinAuthorizeUrl(state, callbackUri('linkedin', origin)));
  res.cookies.set(cookieName('linkedin'), sealOAuthCookie('linkedin', user.id, { state }), oauthCookieOptions('linkedin', OAUTH_TTL_SECONDS));
  return res;
}
