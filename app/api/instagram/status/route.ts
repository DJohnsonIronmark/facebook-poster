import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { instagramPublishingEnabled } from '@/lib/instagram/server';
import { instagramAppPublishingEnabled } from '@/lib/instagram/appPublish';

// GET - whether Instagram rows may be scheduled (INSTAGRAM_PUBLISHING_ENABLED). The form uses it to
// flag Instagram rows that can't go through the direct (non-approval) path; servers enforce it anyway.
export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;
  const app = instagramAppPublishingEnabled();
  // app_publishing: the app publishes Instagram itself, so "publish now" works for Instagram too
  return NextResponse.json({ publishing_enabled: instagramPublishingEnabled() || app, app_publishing: app });
}
