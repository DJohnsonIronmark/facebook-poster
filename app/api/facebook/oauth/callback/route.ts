import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth';
import { verifyFacebookAccess } from '@/lib/access-verify';
import {
  STATE_COOKIE, TOKEN_COOKIE, TOKEN_TTL_SECONDS, cookieOptions, exchangeCode, facebookConfigured, sealToken, statesMatch,
} from '@/lib/facebook/oauth';
import { createServiceClient } from '@/lib/supabase/server';
import { appPagesWithTokens, grantedScopes, longLivedUserToken, savePageTokens } from '@/lib/inbox/server';
import { pageConnectEnabled, type ConnectPurpose } from '@/lib/facebook/publish';
import { socialTokenKeyConfigured } from '@/lib/social/crypto';

// GET - Facebook Login redirect target. Verifies state, exchanges the code, and keeps the user
// token only in an encrypted httpOnly cookie, then returns to the Pages tab.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (flag: string) => {
    const res = NextResponse.redirect(new URL(`/?tab=pages&fb=${flag}`, url.origin));
    res.cookies.set(STATE_COOKIE, '', cookieOptions(0));
    return res;
  };

  // "Verify my page access" (any signed-in user): record which app pages this Facebook login manages
  if ((url.searchParams.get('state') || '').startsWith('access.')) {
    const accessBack = (flag: string, extra = '') => {
      const res = NextResponse.redirect(new URL(`/?access=${flag}${extra}`, url.origin));
      res.cookies.set(STATE_COOKIE, '', cookieOptions(0));
      return res;
    };
    const { user: me, error: meErr } = await requireAuth();
    if (meErr || !me) return accessBack('unauthorized');
    if (!facebookConfigured()) return accessBack('not_configured');
    if (!socialTokenKeyConfigured()) return accessBack('no_key');
    if (!statesMatch(request.cookies.get(STATE_COOKIE)?.value, url.searchParams.get('state'))) return accessBack('state_mismatch');
    if (url.searchParams.get('error')) return accessBack('denied');
    const accessCode = url.searchParams.get('code');
    if (!accessCode || accessCode.length > 2000) return accessBack('error');
    const shortToken = await exchangeCode(accessCode, url.origin);
    if (!shortToken) return accessBack('error');
    try {
      const longToken = await longLivedUserToken(shortToken);
      const result = await verifyFacebookAccess(createServiceClient(), me.id, longToken);
      return accessBack('verified', `&pages=${result.pages}`);
    } catch (err) {
      console.error('[access] verify failed', err instanceof Error ? err.message : err);
      return accessBack('error');
    }
  }

  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return back('unauthorized');
  if (!facebookConfigured()) return back('not_configured');

  if (!statesMatch(request.cookies.get(STATE_COOKIE)?.value, url.searchParams.get('state'))) return back('state_mismatch');
  if (url.searchParams.get('error')) return back('denied');

  const code = url.searchParams.get('code');
  if (!code || code.length > 2000) return back('error');

  const token = await exchangeCode(code, url.origin);
  if (!token) return back('error');

  // Connect pages (inbox / app publishing): store each managed page's token (encrypted) for pages
  // already in the app. The user token itself is not kept.
  const stateValue = url.searchParams.get('state') || '';
  const purpose: ConnectPurpose | null = stateValue.startsWith('inbox.') ? 'inbox' : stateValue.startsWith('publish.') ? 'publish' : null;
  if (purpose) {
    const tab = purpose === 'inbox' ? 'inbox' : 'pages';
    const flagPrefix = purpose === 'inbox' ? 'inbox' : 'publish';
    const connectBack = (flag: string, extra = '') => {
      const res = NextResponse.redirect(new URL(`/?tab=${tab}&fb=${flagPrefix}_${flag}${extra}`, url.origin));
      res.cookies.set(STATE_COOKIE, '', cookieOptions(0));
      return res;
    };
    if (!pageConnectEnabled(purpose)) return connectBack('off');
    if (!socialTokenKeyConfigured()) return connectBack('no_key');
    try {
      const longToken = await longLivedUserToken(token);
      const supabase = createServiceClient();
      // Looks up only the pages on the Pages tab, so there is no limit on how many pages the account manages
      const [found, scopes] = await Promise.all([appPagesWithTokens(supabase, longToken), grantedScopes(longToken)]);
      const result = await savePageTokens(supabase, found.pages, scopes, user.email);
      return connectBack('connected', `&saved=${result.saved}&unmanaged=${found.unmanaged}`);
    } catch (err) {
      console.error(`[${purpose}] connect failed`, err instanceof Error ? err.message : err);
      return connectBack('error');
    }
  }

  const res = back('connected');
  res.cookies.set(TOKEN_COOKIE, sealToken(token, user.id, Date.now() + TOKEN_TTL_SECONDS * 1000), cookieOptions(TOKEN_TTL_SECONDS));
  return res;
}
