import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UUID_RE } from '@/lib/review/guards';
import { disconnectConnection } from '@/lib/social/connections';

// DELETE - disconnect an account (admin). Wipes its stored tokens; pages linked to it keep the
// link but their LinkedIn / X posts fail with "reconnect" until a new account is linked.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const { error: authError } = await requireRole(['admin']);
  if (authError) return authError;
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invalid connection id' }, { status: 400 });
  const ok = await disconnectConnection(createServiceClient(), params.id);
  if (!ok) return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
