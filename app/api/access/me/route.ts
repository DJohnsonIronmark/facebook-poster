import { NextResponse } from 'next/server';
import { getUserRole, requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { pageAccessEnforced } from '@/lib/access';
import { accessStatus } from '@/lib/access-verify';

// GET - the signed-in user's page access (for the "Verify my page access" banner)
export const dynamic = 'force-dynamic';

export async function GET() {
  const { user, error } = await requireAuth();
  if (error || !user) return error!;
  const supabase = createServiceClient();
  const [role, status] = await Promise.all([getUserRole(user.id), accessStatus(supabase, user.id)]);
  return NextResponse.json({
    enforced: pageAccessEnforced(),
    sees_all: role === 'admin' || !pageAccessEnforced(),
    role,
    ...status,
  });
}
