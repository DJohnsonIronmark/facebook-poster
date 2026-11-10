import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  STATE_COOKIE, TOKEN_COOKIE, TOKEN_TTL_SECONDS, cookieOptions, exchangeCode, facebookConfigured, sealToken, statesMatch,
} from '@/lib/facebook/oauth';

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

  const res = back('connected');
  res.cookies.set(TOKEN_COOKIE, sealToken(token, user.id, Date.now() + TOKEN_TTL_SECONDS * 1000), cookieOptions(TOKEN_TTL_SECONDS));
  return res;
}
