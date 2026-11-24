import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth';
import { GRAPH_VERSION, STATE_COOKIE, cookieOptions, facebookConfigured, newState, redirectUri } from '@/lib/facebook/oauth';
import { pageConnectEnabled, pageConnectScopes, type ConnectPurpose } from '@/lib/facebook/publish';

// GET - start "Connect with Facebook" (admin/manager). Redirects to the Facebook Login dialog.
//   ?purpose=inbox   → stores each page's token (encrypted) for the community inbox (COMMUNITY_INBOX_ENABLED)
//   ?purpose=publish → stores each page's token for app publishing (FACEBOOK_APP_PUBLISHING_ENABLED)
// Either way the login asks for every permission currently switched on (one token per page).
export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const raw = new URL(request.url).searchParams.get('purpose');

  // ?purpose=access → "Verify my page access": any signed-in user (viewers too). Only lists which of
  // the app's pages their own Facebook login manages; no page tokens are stored.
  if (raw === 'access') {
    const { error } = await requireAuth();
    if (error) return error;
    if (!facebookConfigured()) return NextResponse.redirect(new URL('/?access=not_configured', origin));
    const state = `access.${newState()}`;
    const dialog = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    dialog.searchParams.set('client_id', process.env.FACEBOOK_APP_ID!);
    dialog.searchParams.set('redirect_uri', redirectUri(origin));
    dialog.searchParams.set('state', state);
    dialog.searchParams.set('response_type', 'code');
    dialog.searchParams.set('scope', 'pages_show_list,business_management');
    const res = NextResponse.redirect(dialog);
    res.cookies.set(STATE_COOKIE, state, cookieOptions(10 * 60));
    return res;
  }

  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;
  if (!facebookConfigured()) {
    return NextResponse.redirect(new URL('/?tab=pages&fb=not_configured', origin));
  }

  const purpose: ConnectPurpose | null = raw === 'inbox' || raw === 'publish' ? raw : null;
  if (purpose && !pageConnectEnabled(purpose)) {
    return NextResponse.redirect(new URL(purpose === 'inbox' ? '/?tab=inbox&fb=inbox_off' : '/?tab=pages&fb=publish_off', origin));
  }
  // The purpose rides in the state, which must match the httpOnly cookie on the way back
  const state = purpose ? `${purpose}.${newState()}` : newState();
  const dialog = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  dialog.searchParams.set('client_id', process.env.FACEBOOK_APP_ID!);
  dialog.searchParams.set('redirect_uri', redirectUri(origin));
  dialog.searchParams.set('state', state);
  dialog.searchParams.set('response_type', 'code');
  // Default: list pages only. Connect pages: inbox and/or publishing permissions (pageConnectScopes).
  // Meta "Business" type apps use Facebook Login for Business, which takes a configuration id
  // (set up in the Meta app with the same permissions, incl. pages_manage_posts when publishing)
  // instead of a scope list.
  const configId = (process.env.FACEBOOK_INBOX_CONFIG_ID || '').trim();
  if (purpose && /^\d{5,25}$/.test(configId)) dialog.searchParams.set('config_id', configId);
  else dialog.searchParams.set('scope', purpose ? pageConnectScopes().join(',') : 'pages_show_list');

  const res = NextResponse.redirect(dialog);
  res.cookies.set(STATE_COOKIE, state, cookieOptions(10 * 60));
  return res;
}
