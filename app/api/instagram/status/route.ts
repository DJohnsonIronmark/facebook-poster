import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { instagramPublishingEnabled } from '@/lib/instagram/server';

// GET - whether Instagram rows may be scheduled (INSTAGRAM_PUBLISHING_ENABLED). The form uses it to
// flag Instagram rows that can't go through the direct (non-approval) path; servers enforce it anyway.
export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;
  return NextResponse.json({ publishing_enabled: instagramPublishingEnabled() });
}
