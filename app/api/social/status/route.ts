import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { socialStatus } from '@/lib/social/server';

// GET - publishing switches + whether LinkedIn / X are configured (any signed-in user).
//   { instagram:{enabled}, linkedin:{enabled, configured}, x:{enabled, configured}, tokenKeyConfigured }
export const dynamic = 'force-dynamic';

export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;
  return NextResponse.json(socialStatus());
}
