import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { publishingSwitches } from '@/lib/social/switches';
import { publishSocialPost, type SocialPostRow } from '@/lib/social/publish';
import { truncate } from '@/lib/social/http';

// LinkedIn / X publisher (called hourly by the n8n "facebook-poster social runner" trigger).
// Auth: Authorization: Bearer <SOCIAL_PUBLISH_CRON_SECRET>. No user session (api/ is outside the
// login middleware), so this secret is the only credential.
//
//   POST → (a) rows stuck in 'publishing' > 30 min → failed (never auto-retried: the post may be live)
//          (b) up to 10 due 'pending' rows on ENABLED platforms (LINKEDIN_/X_PUBLISHING_ENABLED)
//          (c) claim each (pending → publishing, conditional) so overlapping runs never double-post
//          (d) publish; → published + platform_post_id, or failed + publish_error
//   GET  → dry run: counts only, changes nothing.
// Facebook and Instagram rows are never selected here.

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const BATCH = 10;
const STALE_MS = 30 * 60 * 1000;
const STOP_CLAIMING_AFTER_MS = 90 * 1000;   // leave the rest of the 300 s for uploads/processing
const HARD_DEADLINE_MS = 270 * 1000;        // video processing polls stop here
const POST_COLUMNS = 'id, platform, facebook_page_id, franchise_name, post_content, link_url, link_preview, media_type, media_url';
const INTERRUPTED = 'Interrupted while publishing — check the LinkedIn/X page before retrying';

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
  const { count: stale } = await supabase
    .from('facebook_scheduled_posts').select('id', { count: 'exact', head: true })
    .eq('status', 'publishing').in('platform', ['linkedin', 'x']).lt('publish_started_at', staleIso);
  return NextResponse.json({ dry_run: true, enabled_platforms: platforms, due, would_claim: Math.min(due, BATCH), stale_publishing: stale || 0 });
}

export async function POST(request: NextRequest) {
  const denied = authorized(request);
  if (denied) return denied;
  const started = Date.now();
  const supabase = createServiceClient();

  // (a) interrupted runs: mark failed, never retry automatically (the post may already be live)
  const { data: staleRows, error: staleErr } = await supabase
    .from('facebook_scheduled_posts')
    .update({ status: 'failed', publish_error: INTERRUPTED })
    .eq('status', 'publishing')
    .in('platform', ['linkedin', 'x'])
    .lt('publish_started_at', new Date(started - STALE_MS).toISOString())
    .select('id');
  if (staleErr) console.error('social-run: stale sweep', staleErr.message);

  const summary = { claimed: 0, published: 0, failed: 0, skipped: 0, interrupted: (staleRows || []).length, results: [] as { id: string; status: 'published' | 'failed'; error?: string }[] };
  const platforms = enabledPlatforms();
  if (platforms.length === 0) return NextResponse.json({ ...summary, enabled_platforms: platforms });

  // (b) due rows on enabled platforms
  const { data: due, error: dueErr } = await supabase
    .from('facebook_scheduled_posts')
    .select(POST_COLUMNS)
    .eq('status', 'pending')
    .in('platform', platforms)
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(BATCH);
  if (dueErr) {
    console.error('social-run: select', dueErr.message);
    return NextResponse.json({ error: 'Failed to load due posts' }, { status: 500 });
  }

  for (const post of (due || []) as SocialPostRow[]) {
    if (Date.now() - started > STOP_CLAIMING_AFTER_MS) { summary.skipped++; continue; } // next run picks it up

    // (c) atomic claim
    const { data: claimed, error: claimErr } = await supabase
      .from('facebook_scheduled_posts')
      .update({ status: 'publishing', publish_started_at: new Date().toISOString(), publish_error: null })
      .eq('id', post.id)
      .eq('status', 'pending')
      .select('id');
    if (claimErr || (claimed || []).length !== 1) { summary.skipped++; continue; }
    summary.claimed++;

    // (d) publish
    let outcome: Awaited<ReturnType<typeof publishSocialPost>>;
    try {
      outcome = await publishSocialPost(supabase, post, started + HARD_DEADLINE_MS);
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' };
    }

    if (outcome.ok) {
      const { error: updErr } = await supabase
        .from('facebook_scheduled_posts')
        .update({ status: 'published', published_at: new Date().toISOString(), platform_post_id: outcome.platformPostId, publish_error: null })
        .eq('id', post.id)
        .eq('status', 'publishing');
      if (updErr) console.error('social-run: published but status update failed', post.id, updErr.message);
      summary.published++;
      summary.results.push({ id: post.id, status: 'published' });
    } else {
      const message = truncate(outcome.error, 500);
      await supabase
        .from('facebook_scheduled_posts')
        .update({ status: 'failed', publish_error: message })
        .eq('id', post.id)
        .eq('status', 'publishing');
      summary.failed++;
      summary.results.push({ id: post.id, status: 'failed', error: message });
    }
  }

  return NextResponse.json({ ...summary, enabled_platforms: platforms });
}
