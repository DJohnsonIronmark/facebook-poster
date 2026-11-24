import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { runScheduledPublishing } from '@/lib/social/runner';
import { facebookAppPublishingEnabled, publishingSwitches } from '@/lib/social/switches';

// LinkedIn / X publisher, plus Facebook for pages set to publish_via='app' (called by the n8n
// "facebook-poster social runner" trigger).
// Auth: Authorization: Bearer <SOCIAL_PUBLISH_CRON_SECRET>. No user session (api/ is outside the
// login middleware), so this secret is the only credential.
//
//   POST → (a) rows stuck in 'publishing' > 30 min → failed (never auto-retried: the post may be live)
//          (b) up to 10 due 'pending' rows on ENABLED platforms (LINKEDIN_/X_PUBLISHING_ENABLED), and
//              Facebook rows with publish_via='app' while FACEBOOK_APP_PUBLISHING_ENABLED is on
//          (c) claim each (pending → publishing, conditional) so overlapping runs never double-post
//          (d) publish; → published + platform_post_id (Facebook: facebook_post_id), or failed + publish_error
//   GET  → dry run: counts only, changes nothing.
// Instagram rows are published here while INSTAGRAM_APP_PUBLISHING_ENABLED is on (lib/social/runner.ts);
// Facebook rows with publish_via='n8n' are never selected here (n8n publishes them).
// Normally run by Vercel Cron via /api/cron/publish; this route stays for manual / n8n triggering.

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const BATCH = 10;
const STALE_MS = 30 * 60 * 1000;

function authorized(request: NextRequest): NextResponse | null {
  const secret = process.env.SOCIAL_PUBLISH_CRON_SECRET || '';
  if (!secret) return NextResponse.json({ error: 'Social publishing runner is not configured' }, { status: 503 });
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Hash both sides so the comparison is constant-time regardless of length
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  if (!given || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return null;
}

function enabledPlatforms(): ('linkedin' | 'x')[] {
  const s = publishingSwitches();
  return [...(s.linkedin ? ['linkedin' as const] : []), ...(s.x ? ['x' as const] : [])];
}

export async function GET(request: NextRequest) {
  const denied = authorized(request);
  if (denied) return denied;
  const platforms = enabledPlatforms();
  const supabase = createServiceClient();
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_MS).toISOString();

  let due = 0;
  if (platforms.length > 0) {
    const { count, error } = await supabase
      .from('facebook_scheduled_posts').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').in('platform', platforms).lte('scheduled_for', nowIso);
    if (error) return NextResponse.json({ error: 'Failed to count posts' }, { status: 500 });
    due = count || 0;
  }
  const facebookOn = facebookAppPublishingEnabled();
  let facebookDue = 0;
  if (facebookOn) {
    const { count, error } = await supabase
      .from('facebook_scheduled_posts').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').eq('platform', 'facebook').lte('scheduled_for', nowIso);
    if (error) return NextResponse.json({ error: 'Failed to count Facebook posts' }, { status: 500 });
    facebookDue = count || 0;
  }
  const { count: stale } = await supabase
    .from('facebook_scheduled_posts').select('id', { count: 'exact', head: true })
    .eq('status', 'publishing').in('platform', ['linkedin', 'x']).lt('publish_started_at', staleIso);
  const { count: staleFacebook } = await supabase
    .from('facebook_scheduled_posts').select('id', { count: 'exact', head: true })
    .eq('status', 'publishing').eq('platform', 'facebook').lt('publish_started_at', staleIso);
  return NextResponse.json({
    dry_run: true, enabled_platforms: platforms, due, would_claim: Math.min(due, BATCH), stale_publishing: stale || 0,
    facebook_app: { enabled: facebookOn, due: facebookDue, would_claim: Math.min(facebookDue, BATCH), stale_publishing: staleFacebook || 0 },
  });
}

export async function POST(request: NextRequest) {
  const denied = authorized(request);
  if (denied) return denied;
  const result = await runScheduledPublishing(createServiceClient());
  return NextResponse.json(result.body, { status: result.status });
}
