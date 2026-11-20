import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UUID_RE } from '@/lib/review/guards';
import { linkedinAdminOrganizations } from '@/lib/linkedin/api';
import { getAccessToken, markConnectionError } from '@/lib/social/connections';
import { SocialApiError, errorMessage } from '@/lib/social/http';

// GET ?connection_id=<uuid> - LinkedIn company pages the connected member can post for (admin/manager).
//   { organizations: [{ id: "12345", name, role }] }
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;
  const connectionId = new URL(request.url).searchParams.get('connection_id') || '';
  if (!UUID_RE.test(connectionId)) return NextResponse.json({ error: 'Valid connection_id required' }, { status: 400 });

  const supabase = createServiceClient();
  const auth = await getAccessToken(supabase, connectionId, 'linkedin');
  if (!auth.ok) return NextResponse.json({ error: auth.error, needs_reauth: auth.needsReauth }, { status: 409 });
  try {
    const organizations = await linkedinAdminOrganizations(auth.token);
    return NextResponse.json({ organizations });
  } catch (e) {
    const msg = errorMessage(e);
    if (e instanceof SocialApiError && e.authFailed) {
      await markConnectionError(supabase, connectionId, `LinkedIn rejected the token: ${msg}`, true);
      return NextResponse.json({ error: 'LinkedIn rejected this account; reconnect it', needs_reauth: true }, { status: 409 });
    }
    console.error('[linkedin] organizations failed:', msg);
    return NextResponse.json({ error: `Could not load LinkedIn pages (${msg})` }, { status: 502 });
  }
}
