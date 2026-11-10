import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { listConnections } from '@/lib/social/connections';

// GET - connected LinkedIn members / X accounts (any signed-in user). Never includes tokens.
export const dynamic = 'force-dynamic';

export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;
  try {
    const connections = await listConnections(createServiceClient());
    return NextResponse.json({ connections });
  } catch {
    return NextResponse.json({ error: 'Failed to load connected accounts' }, { status: 500 });
  }
}
