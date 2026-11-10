import { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { xConfigured, xExchangeCode, xMe } from '@/lib/x/api';
import { isValidCodeVerifier } from '@/lib/x/pkce';
import { saveConnection } from '@/lib/social/connections';
import { errorMessage } from '@/lib/social/http';
import { callbackUri, cookieName, finishRedirect, openOAuthCookie, statesMatch } from '@/lib/social/oauth';

// GET - X redirect target (admin only). The code is valid ~30 s, so it is exchanged first thing.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (error: string) => finishRedirect('x', url.origin, { error });

  const { user, error: authError } = await requireRole(['admin']);
  if (authError || !user) return back('forbidden');
  if (!xConfigured()) return back('not_configured');

  const saved = openOAuthCookie('x', user.id, request.cookies.get(cookieName('x'))?.value);
  if (!saved || !statesMatch(saved.state, url.searchParams.get('state'))) return back('state_mismatch');
  if (url.searchParams.get('error')) return back('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2000) return back('no_code');
  if (!saved.verifier || !isValidCodeVerifier(saved.verifier)) return back('state_mismatch');

  let tokens;
  try {
    tokens = await xExchangeCode(code, saved.verifier, callbackUri('x', url.origin));
  } catch (e) {
    console.error('[x] code exchange failed:', errorMessage(e));
    return back('exchange_failed');
  }

  let me;
  try {
    me = await xMe(tokens.accessToken);
  } catch (e) {
    console.error('[x] profile failed:', errorMessage(e));
    return back('profile_failed');
  }

  try {
    await saveConnection(createServiceClient(), {
      provider: 'x',
      externalId: me.id,
      displayName: me.name,
      username: me.username,
      accessToken: tokens.accessToken,
      accessExpiresIn: tokens.expiresIn,
      refreshToken: tokens.refreshToken,
      refreshExpiresIn: null,
      scopes: tokens.scope,
      connectedBy: user.id,
    });
  } catch (e) {
    console.error('[x] save connection failed:', errorMessage(e));
    return back('save_failed');
  }
  return finishRedirect('x', url.origin, 'connected');
}
