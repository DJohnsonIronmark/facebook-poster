import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { GRAPH_VERSION, STATE_COOKIE, cookieOptions, facebookConfigured, newState, redirectUri } from '@/lib/facebook/oauth';

// GET - start "Connect with Facebook" (admin/manager). Redirects to the Facebook Login dialog.
export async function GET(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  const origin = new URL(request.url).origin;
  if (!facebookConfigured()) {
    return NextResponse.redirect(new URL('/?tab=pages&fb=not_configured', origin));
  }

  const state = newState();
  const dialog = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  dialog.searchParams.set('client_id', process.env.FACEBOOK_APP_ID!);
  dialog.searchParams.set('redirect_uri', redirectUri(origin));
  dialog.searchParams.set('state', state);
  dialog.searchParams.set('response_type', 'code');
  dialog.searchParams.set('scope', 'pages_show_list'); // list pages only; no posting/management scopes

  const res = NextResponse.redirect(dialog);
  res.cookies.set(STATE_COOKIE, state, cookieOptions(10 * 60));
  return res;
}
