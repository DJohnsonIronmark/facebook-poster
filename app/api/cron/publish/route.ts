import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { runScheduledPublishing } from '@/lib/social/runner';

// GET - Vercel Cron (vercel.json "crons"): publishes due scheduled posts for pages and platforms the
// app publishes itself (Facebook publish_via='app', Instagram, LinkedIn, X). Vercel sends
// Authorization: Bearer <CRON_SECRET>; nothing else can trigger it. Overlapping runs are safe: every
// row is claimed (pending → publishing) before it is published.

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

  const result = await runScheduledPublishing(createServiceClient());
  return NextResponse.json(result.body, { status: result.status });
}
