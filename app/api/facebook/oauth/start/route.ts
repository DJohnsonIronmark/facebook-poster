import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { GRAPH_VERSION, STATE_COOKIE, cookieOptions, facebookConfigured, newState, redirectUri } from '@/lib/facebook/oauth';
import { INBOX_SCOPES, inboxEnabled } from '@/lib/inbox/server';

// GET - start "Connect with Facebook" (admin/manager). Redirects to the Facebook Login dialog.
//   ?purpose=inbox → also asks for comment/message permissions and stores each page's token
//   (encrypted) for the community inbox. Only while COMMUNITY_INBOX_ENABLED is on.
export async function GET(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  const origin = new URL(request.url).origin;
  if (!facebookConfigured()) {
    return NextResponse.redirect(new URL('/?tab=pages&fb=not_configured', origin));
  }

  const inbox = new URL(request.url).searchParams.get('purpose') === 'inbox';
  if (inbox && !inboxEnabled()) {
    return NextResponse.redirect(new URL('/?tab=inbox&fb=inbox_off', origin));
  }
  // The purpose rides in the state, which must match the httpOnly cookie on the way back
  const state = inbox ? `inbox.${newState()}` : newState();
  const dialog = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  dialog.searchParams.set('client_id', process.env.FACEBOOK_APP_ID!);
  dialog.searchParams.set('redirect_uri', redirectUri(origin));
  dialog.searchParams.set('state', state);
  dialog.searchParams.set('response_type', 'code');
  // Default: list pages only. Inbox: comment/message permissions (see INBOX_SCOPES).
  dialog.searchParams.set('scope', inbox ? INBOX_SCOPES.join(',') : 'pages_show_list');

  const res = NextResponse.redirect(dialog);
  res.cookies.set(STATE_COOKIE, state, cookieOptions(10 * 60));
  return res;
}
