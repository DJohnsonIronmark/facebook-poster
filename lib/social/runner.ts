import type { SupabaseClient } from '@supabase/supabase-js';
import { facebookAppPublishingEnabled, publishingSwitches } from '@/lib/social/switches';
import { publishSocialPost, type SocialPostRow } from '@/lib/social/publish';
import { truncate } from '@/lib/social/http';
import { FACEBOOK_POST_COLUMNS, claimAndPublishFacebook, type FacebookPostRow } from '@/lib/facebook/publish';
import { claimAndPublishInstagram, instagramAppPublishingEnabled, type InstagramPostRow } from '@/lib/instagram/appPublish';

// Server-only: one run of the app's scheduled publisher. Called by Vercel Cron (/api/cron/publish)
// and by /api/publish/social-run (Bearer SOCIAL_PUBLISH_CRON_SECRET).
//   (a) rows stuck in 'publishing' > 30 min → failed (never auto-retried: the post may be live)
//   (b) due 'pending' rows: Facebook with publish_via='app' (FACEBOOK_APP_PUBLISHING_ENABLED),
//       Instagram (INSTAGRAM_APP_PUBLISHING_ENABLED), LinkedIn / X (their switches)
//   (c) each row is claimed (pending → publishing, conditional) so overlapping runs never double-post
//   (d) publish → published + platform id, or failed + publish_error
// Facebook rows on publish_via='n8n' are never selected here (n8n publishes them).

const BATCH = 10;
const STALE_MS = 30 * 60 * 1000;
const STOP_CLAIMING_AFTER_MS = 90 * 1000;   // leave the rest of the 300 s for uploads/processing
const HARD_DEADLINE_MS = 270 * 1000;        // video processing polls stop here
const POST_COLUMNS = 'id, platform, facebook_page_id, franchise_name, post_content, link_url, link_preview, media_type, media_url';
const INTERRUPTED = 'Interrupted while publishing — check the page before retrying (the post may be live)';

function enabledPlatforms(): ('linkedin' | 'x')[] {
  const s = publishingSwitches();
  return [...(s.linkedin ? ['linkedin' as const] : []), ...(s.x ? ['x' as const] : [])];
}

export async function runScheduledPublishing(supabase: SupabaseClient): Promise<{ status: number; body: Record<string, unknown> }> {
  const started = Date.now();

  // (a) interrupted runs: mark failed, never retry automatically (the post may already be live)
  const { data: staleRows, error: staleErr } = await supabase
    .from('facebook_scheduled_posts')
    .update({ status: 'failed', publish_error: INTERRUPTED })
    .eq('status', 'publishing')
    .in('platform', ['linkedin', 'x'])
    .lt('publish_started_at', new Date(started - STALE_MS).toISOString())
    .select('id');
  if (staleErr) console.error('social-run: stale sweep', staleErr.message);
  const { data: staleFacebook, error: staleFbErr } = await supabase
    .from('facebook_scheduled_posts')
    .update({ status: 'failed', publish_error: INTERRUPTED })
    .eq('status', 'publishing')
    .eq('platform', 'facebook')
    .eq('publish_via', 'app')
    .lt('publish_started_at', new Date(started - STALE_MS).toISOString())
    .select('id');
  if (staleFbErr) console.error('social-run: facebook stale sweep', staleFbErr.message);
  const { data: staleInstagram, error: staleIgErr } = await supabase
    .from('facebook_scheduled_posts')
    .update({ status: 'failed', publish_error: INTERRUPTED })
    .eq('status', 'publishing')
    .eq('platform', 'instagram')
    .lt('publish_started_at', new Date(started - STALE_MS).toISOString())
    .select('id');
  if (staleIgErr) console.error('social-run: instagram stale sweep', staleIgErr.message);

  const summary = {
    claimed: 0, published: 0, failed: 0, skipped: 0,
    interrupted: (staleRows || []).length + (staleFacebook || []).length + (staleInstagram || []).length,
    results: [] as { id: string; platform: string; status: 'published' | 'failed'; error?: string }[],
  };
  const platforms = enabledPlatforms();
  const facebookOn = facebookAppPublishingEnabled();
  const instagramOn = instagramAppPublishingEnabled();

  // Facebook (publish_via='app') first: these have an exact scheduled time, LinkedIn/X follow
  if (facebookOn) {
    const { data: fbDue, error: fbErr } = await supabase
      .from('facebook_scheduled_posts')
      .select(FACEBOOK_POST_COLUMNS)
      .eq('status', 'pending')
      .eq('platform', 'facebook')
      .eq('publish_via', 'app')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH);
    if (fbErr) console.error('social-run: facebook select', fbErr.message);
    for (const post of (fbDue || []) as FacebookPostRow[]) {
      if (Date.now() - started > STOP_CLAIMING_AFTER_MS) { summary.skipped++; continue; } // next run picks it up
      const r = await claimAndPublishFacebook(supabase, post);
      if (r.status === 'skipped') { summary.skipped++; continue; }
      summary.claimed++;
      if (r.status === 'published') { summary.published++; summary.results.push({ id: post.id, platform: 'facebook', status: 'published' }); }
      else { summary.failed++; summary.results.push({ id: post.id, platform: 'facebook', status: 'failed', error: r.error }); }
    }
  }

  // Instagram published by the app itself (INSTAGRAM_APP_PUBLISHING_ENABLED); the n8n Instagram
  // publisher must stay inactive while this is on
  if (instagramOn) {
    const { data: igDue, error: igErr } = await supabase
      .from('facebook_scheduled_posts')
      .select('id, platform, facebook_page_id, post_content, media_url, media_type')
      .eq('status', 'pending')
      .eq('platform', 'instagram')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH);
    if (igErr) console.error('social-run: instagram select', igErr.message);
    for (const post of (igDue || []) as InstagramPostRow[]) {
      if (Date.now() - started > STOP_CLAIMING_AFTER_MS) { summary.skipped++; continue; } // next run picks it up
      const r = await claimAndPublishInstagram(supabase, post);
      if (!r.ok && !r.claimed) {
        if (r.alreadyClaimed) { summary.skipped++; continue; }
        // Couldn't even start (e.g. page not connected): mark failed with the reason instead of
        // retrying silently every run
        await supabase.from('facebook_scheduled_posts')
          .update({ status: 'failed', publish_error: truncate(r.error, 500) })
          .eq('id', post.id).eq('status', 'pending');
        summary.failed++;
        summary.results.push({ id: post.id, platform: 'instagram', status: 'failed', error: r.error });
        continue;
      }
      summary.claimed++;
      if (r.ok) { summary.published++; summary.results.push({ id: post.id, platform: 'instagram', status: 'published' }); }
      else { summary.failed++; summary.results.push({ id: post.id, platform: 'instagram', status: 'failed', error: r.error }); }
    }
  }

  if (platforms.length === 0) return { status: 200, body: { ...summary, enabled_platforms: platforms, facebook_app_enabled: facebookOn, instagram_app_enabled: instagramOn } };

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
    return { status: 500, body: { error: 'Failed to load due posts' } };
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
      summary.results.push({ id: post.id, platform: String(post.platform), status: 'published' });
    } else {
      const message = truncate(outcome.error, 500);
      await supabase
        .from('facebook_scheduled_posts')
        .update({ status: 'failed', publish_error: message })
        .eq('id', post.id)
        .eq('status', 'publishing');
      summary.failed++;
      summary.results.push({ id: post.id, platform: String(post.platform), status: 'failed', error: message });
    }
  }

  return { status: 200, body: { ...summary, enabled_platforms: platforms, facebook_app_enabled: facebookOn, instagram_app_enabled: instagramOn } };
}
