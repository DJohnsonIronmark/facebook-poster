import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import {
  linkedinConfigured, linkedinExchangeCode, linkedinOrgAcls, linkedinOrgNames, linkedinScopes, linkedinUserInfo,
} from '@/lib/linkedin/api';
import { saveConnection } from '@/lib/social/connections';
import { errorMessage } from '@/lib/social/http';
import { callbackUri, cookieName, finishRedirect, openOAuthCookie, statesMatch } from '@/lib/social/oauth';

// GET - LinkedIn redirect target (admin only). Verifies state, exchanges the code, identifies the
// member, and stores the encrypted tokens in fb_social_connections. Tokens never reach the browser.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (error: string) => finishRedirect('linkedin', url.origin, { error });

  const { user, error: authError } = await requireRole(['admin']);
  if (authError || !user) return back('forbidden');
  if (!linkedinConfigured()) return back('not_configured');

  const saved = openOAuthCookie('linkedin', user.id, request.cookies.get(cookieName('linkedin'))?.value);
  if (!saved || !statesMatch(saved.state, url.searchParams.get('state'))) return back('state_mismatch');
  if (url.searchParams.get('error')) return back('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2000) return back('no_code');

  let tokens;
  try {
    tokens = await linkedinExchangeCode(code, callbackUri('linkedin', url.origin));
  } catch (e) {
    console.error('[linkedin] code exchange failed:', errorMessage(e));
    return back('exchange_failed');
  }

  // Who connected: OpenID userinfo when granted, else the member id from their org roles.
  let externalId: string | null = null;
  let displayName: string | null = null;
  // LinkedIn normally echoes the granted scopes; if it doesn't, go by what we asked for
  const granted = (tokens.scope || linkedinScopes()).split(/[\s,]+/);
  if (granted.includes('openid')) {
    try {
      const info = await linkedinUserInfo(tokens.accessToken);
      externalId = info.sub;
      displayName = info.name;
    } catch (e) {
      console.error('[linkedin] userinfo failed:', errorMessage(e));
    }
  }
  let orgs: { id: string; role: string }[] = [];
  try {
    const acl = await linkedinOrgAcls(tokens.accessToken);
    orgs = acl.orgs;
    if (!externalId && acl.personId) externalId = acl.personId;
  } catch (e) {
    console.error('[linkedin] organization roles failed:', errorMessage(e));
    if (!externalId) return back('profile_failed');
  }
  if (orgs.length === 0) return back('no_admin_orgs');
  if (!externalId) {
    // No member id available: fall back to a stable hash of the org set (reconnect = same row)
    externalId = `orgs-${createHash('sha256').update(orgs.map((o) => o.id).sort().join(',')).digest('hex').slice(0, 32)}`;
  }
  if (!displayName) {
    try {
      const names = await linkedinOrgNames(tokens.accessToken, orgs.slice(0, 3).map((o) => o.id));
      const list = Array.from(names.values());
      displayName = `Admin of ${list.join(', ')}${orgs.length > 3 ? ` +${orgs.length - 3} more` : ''}`;
    } catch {
      displayName = `LinkedIn admin (${orgs.length} page${orgs.length === 1 ? '' : 's'})`;
    }
  }

  try {
    await saveConnection(createServiceClient(), {
      provider: 'linkedin',
      externalId,
      displayName,
      username: null,
      accessToken: tokens.accessToken,
      accessExpiresIn: tokens.expiresIn,
      refreshToken: tokens.refreshToken,
      refreshExpiresIn: tokens.refreshExpiresIn,
      scopes: tokens.scope,
      connectedBy: user.id,
    });
  } catch (e) {
    console.error('[linkedin] save connection failed:', errorMessage(e));
    return back('save_failed');
  }
  return finishRedirect('linkedin', url.origin, 'connected');
}
