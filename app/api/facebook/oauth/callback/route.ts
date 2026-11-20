import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  STATE_COOKIE, TOKEN_COOKIE, TOKEN_TTL_SECONDS, cookieOptions, exchangeCode, facebookConfigured, sealToken, statesMatch,
} from '@/lib/facebook/oauth';
import { createServiceClient } from '@/lib/supabase/server';
import { grantedScopes, inboxEnabled, longLivedUserToken, pagesWithTokens, savePageTokens } from '@/lib/inbox/server';
import { socialTokenKeyConfigured } from '@/lib/social/crypto';

// GET - Facebook Login redirect target. Verifies state, exchanges the code, and keeps the user
// token only in an encrypted httpOnly cookie, then returns to the Pages tab.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (flag: string) => {
    const res = NextResponse.redirect(new URL(`/?tab=pages&fb=${flag}`, url.origin));
    res.cookies.set(STATE_COOKIE, '', cookieOptions(0));
    return res;
  };

  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return back('unauthorized');
  if (!facebookConfigured()) return back('not_configured');

  if (!statesMatch(request.cookies.get(STATE_COOKIE)?.value, url.searchParams.get('state'))) return back('state_mismatch');
  if (url.searchParams.get('error')) return back('denied');

  const code = url.searchParams.get('code');
  if (!code || code.length > 2000) return back('error');

  const token = await exchangeCode(code, url.origin);
  if (!token) return back('error');

  // Community inbox: store each managed page's token (encrypted) for pages already in the app.
  // The user token itself is not kept.
  if (url.searchParams.get('state')?.startsWith('inbox.')) {
    const inboxBack = (flag: string, extra = '') => {
      const res = NextResponse.redirect(new URL(`/?tab=inbox&fb=${flag}${extra}`, url.origin));
      res.cookies.set(STATE_COOKIE, '', cookieOptions(0));
      return res;
    };
    if (!inboxEnabled()) return inboxBack('inbox_off');
    if (!socialTokenKeyConfigured()) return inboxBack('inbox_no_key');
    try {
      const longToken = await longLivedUserToken(token);
      const [pages, scopes] = await Promise.all([pagesWithTokens(longToken), grantedScopes(longToken)]);
      const result = await savePageTokens(createServiceClient(), pages, scopes, user.email);
      return inboxBack('inbox_connected', `&saved=${result.saved}&skipped=${result.notInApp}`);
    } catch (err) {
      console.error('[inbox] connect failed', err instanceof Error ? err.message : err);
      return inboxBack('inbox_error');
    }
  }

  const res = back('connected');
  res.cookies.set(TOKEN_COOKIE, sealToken(token, user.id, Date.now() + TOKEN_TTL_SECONDS * 1000), cookieOptions(TOKEN_TTL_SECONDS));
  return res;
}
