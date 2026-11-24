import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { refreshAllFacebookAccess } from '@/lib/access-verify';

// GET - Vercel Cron (daily): re-check every user's Facebook page access with their stored login.
// Expired logins lose their verified access until the user verifies again (fail closed).
// Authorization: Bearer <CRON_SECRET>.

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

  return NextResponse.json(await refreshAllFacebookAccess(createServiceClient()));
}
