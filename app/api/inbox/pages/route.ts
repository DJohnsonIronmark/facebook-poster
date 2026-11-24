import { NextRequest, NextResponse } from 'next/server';
import { canSeePage, noPageAccess, requireScopedUser } from '@/lib/access';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';

// DELETE /api/inbox/pages?facebook_page_id= (admin/manager): disconnect a page from the inbox.
// Deletes its stored (encrypted) token. Publishing is unaffected (n8n uses its own credential).

const FB_PAGE_ID_RE = /^\d{5,25}$/;

export async function DELETE(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  const id = new URL(request.url).searchParams.get('facebook_page_id') || '';
  if (!FB_PAGE_ID_RE.test(id)) return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
  {
    const scoped = await requireScopedUser(['admin', 'manager']);
    if (scoped.error) return scoped.error;
    if (!canSeePage(scoped.scope, id)) return noPageAccess();
  }

  const { error } = await createServiceClient().from('fb_page_tokens').delete().eq('facebook_page_id', id);
  if (error) {
    console.error('inbox pages DELETE', error);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
