import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { analyticsEnabled, collectAnalytics } from '@/lib/analytics/collect';

// GET - Vercel Cron (daily): refresh Facebook / Instagram post metrics and follower counts.
// Authorization: Bearer <CRON_SECRET> (sent by Vercel). Does nothing while ANALYTICS_ENABLED is off.

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  if (!given || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!analyticsEnabled()) return NextResponse.json({ skipped: 'ANALYTICS_ENABLED is off' });
  const summary = await collectAnalytics(createServiceClient());
  return NextResponse.json(summary);
}
