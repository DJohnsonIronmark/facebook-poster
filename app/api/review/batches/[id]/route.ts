import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { generateReviewToken } from '@/lib/review/tokens';
import { allowedSenderDomain, appBaseUrl, isAllowedSender, notifyClientReview } from '@/lib/review/notify';
import { fetchLinkPreview } from '@/lib/review/linkPreview';
import { isScheduledForToday, sendScheduledPostToWebhook } from '@/lib/publisher';
import { planScheduleRelease, shouldSendSameDay } from '@/lib/instagram/release';
import { instagramCaptionProblem, instagramMediaProblem, instagramPublishingEnabled } from '@/lib/instagram/server';
import { MAX_POST_LENGTH } from '@/lib/review/types';
import { UUID_RE } from '@/lib/review/guards';
import { createMediaPublisher, instagramPublishConstraints, normalizeIncomingMediaUrl } from '@/lib/media/server';
import { isStorageRef } from '@/lib/media/storageRef';

export const maxDuration = 300;

const MAX_FINAL_ROWS = 1000;
const err = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
const isHttpUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

/**
 * POST - workflow actions on a review batch (admin/manager)
 *   { action: 'approve_internal' }   internal review done → client_review + email client magic link
 *   { action: 'resend_link' }        new client link (old one stops working) + email
 *   { action: 'final_upload', rows } bulk-apply final copy/schedule to client-approved posts
 *   { action: 'schedule' }           client_approved → pending (n8n publishes); same-day via webhook
 *   { action: 'cancel' }             stop the batch; posts never publish
 *
 * Every transition is claimed with a status-conditional UPDATE so double-clicks or two
 * reviewers acting at once can't double-send links or double-publish.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;
  if (!UUID_RE.test(params.id)) return err('Invalid batch id');

  const body = await request.json().catch(() => ({}));
  const supabase = createServiceClient();

  const { data: batch, error: batchErr } = await supabase
    .from('fb_review_batches')
    .select('*, client:fb_clients!client_id(*), posts:facebook_scheduled_posts!review_batch_id(*)')
    .eq('id', params.id)
    .single();
  if (batchErr || !batch) return err('Batch not found', 404);

  const now = new Date().toISOString();
  const posts: any[] = batch.posts || [];
  const recipients: string[] = batch.client?.client_reviewer_emails || [];
  const senderProblem = isAllowedSender(batch.client?.account_manager_email)
    ? null
    : `Set an account manager (@${allowedSenderDomain()}) for this client under Client settings; they review drafts and client replies go to them.`;

  /** Atomically move the batch from one of `from` to `patch.status`; false if someone else got there first */
  const claim = async (from: string[], patch: Record<string, unknown>) => {
    const { data, error } = await supabase
      .from('fb_review_batches')
      .update({ ...patch, updated_at: now })
      .eq('id', batch.id)
      .in('status', from)
      .select('id');
    return !error && (data || []).length === 1;
  };

  const issueLinkAndEmail = async () => {
    const { token, hash, expiresAt } = generateReviewToken();
    const reviewUrl = `${appBaseUrl(request)}/review/${token}`;
    const upd = await supabase
      .from('fb_review_batches')
      .update({ client_token_hash: hash, client_token_expires_at: expiresAt, sent_to_client_at: now, updated_at: now })
      .eq('id', batch.id)
      .eq('status', 'client_review');
    if (upd.error) return null;
    const email = await notifyClientReview({
      to: recipients, accountManager: batch.client.account_manager_email, cc: [batch.created_by_email],
      clientName: batch.client.name, postCount: posts.length, reviewUrl, expiresAt,
    });
    return { email, review_url: reviewUrl, expires_at: expiresAt };
  };

  switch (body.action) {
    case 'approve_internal': {
      if (batch.status !== 'internal_review') return err(`Batch is ${batch.status}, not awaiting account manager review`, 409);
      // Account manager review: only the client's AM (or an admin) can approve first drafts
      const isAccountManager = !!batch.client?.account_manager_email
        && user.email.toLowerCase() === String(batch.client.account_manager_email).toLowerCase();
      if (!isAccountManager && user.role !== 'admin') {
        return err(`Only the account manager (${batch.client?.account_manager_email || 'not set'}) can approve these drafts for the client`, 403);
      }
      if (posts.length === 0) return err('Batch has no posts');
      if (recipients.length === 0) return err('No client reviewer emails configured for this client. Add them under Client settings.');
      if (senderProblem) return err(senderProblem);

      if (!(await claim(['internal_review'], { status: 'client_review', internal_approved_by_email: user.email, internal_approved_at: now }))) {
        return err('Someone else already moved this batch. Refresh and try again.', 409);
      }
      const p = await supabase.from('facebook_scheduled_posts')
        .update({ status: 'client_review' }).eq('review_batch_id', batch.id).eq('status', 'internal_review');
      const link = p.error ? null : await issueLinkAndEmail();
      if (!link) {
        // roll back so the batch isn't stuck in client_review without a link
        await supabase.from('facebook_scheduled_posts').update({ status: 'internal_review' }).eq('review_batch_id', batch.id).eq('status', 'client_review');
        await supabase.from('fb_review_batches').update({ status: 'internal_review', internal_approved_at: null, internal_approved_by_email: null, updated_at: now }).eq('id', batch.id);
        return err('Failed to send to client', 500);
      }
      return NextResponse.json({ success: true, ...link });
    }

    case 'resend_link': {
      if (batch.status !== 'client_review') return err('Batch is not awaiting client review', 409);
      if (recipients.length === 0) return err('No client reviewer emails configured for this client.');
      if (senderProblem) return err(senderProblem);
      const link = await issueLinkAndEmail();
      if (!link) return err('Failed to create a new link', 500);
      return NextResponse.json({ success: true, ...link });
    }

    case 'final_upload': {
      if (batch.status !== 'client_approved') return err('Final copy can only be uploaded after the client approves', 409);
      const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length > MAX_FINAL_ROWS) return err(`Max ${MAX_FINAL_ROWS} rows per upload`);
      const byId = new Map(posts.map((p) => [p.id, p]));
      const previews = new Map<string, ReturnType<typeof fetchLinkPreview>>();
      const updated: string[] = [];
      const problems: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const post = byId.get(String(row.post_id || ''));
        if (!post) { problems.push(`Row ${i + 1}: post_id not in this batch`); continue; }
        if (post.status !== 'client_approved') { problems.push(`Row ${i + 1}: post is ${post.status}`); continue; }

        const patch: Record<string, unknown> = {};
        const isIg = post.platform === 'instagram';
        if (typeof row.post_content === 'string' && row.post_content.trim()) {
          if (row.post_content.length > MAX_POST_LENGTH) { problems.push(`Row ${i + 1}: content too long`); continue; }
          const igProblem = isIg ? instagramCaptionProblem(row.post_content.trim()) : null;
          if (igProblem) { problems.push(`Row ${i + 1}: ${igProblem}`); continue; }
          if (row.post_content.trim() !== post.post_content) patch.post_content = row.post_content.trim();
        }
        if (typeof row.link_url === 'string' && !post.media_type) {
          const link = row.link_url.trim() || null;
          if (link && !isHttpUrl(link)) { problems.push(`Row ${i + 1}: link_url must be http(s)`); continue; }
          if (link !== post.link_url) {
            patch.link_url = link;
            if (link && !previews.has(link)) previews.set(link, fetchLinkPreview(link));
            patch.link_preview = link ? await previews.get(link)! : null;
          }
        }
        if (typeof row.media_url === 'string' && post.media_type && row.media_url.trim()) {
          // A signed preview URL from the export maps back to its private ref (unchanged media)
          const media = normalizeIncomingMediaUrl(row.media_url);
          if (!media.ok) { problems.push(`Row ${i + 1}: media_url must be http(s)`); continue; }
          if (media.value && media.value !== post.media_url) {
            const igProblem = isIg ? instagramMediaProblem(post.media_type, media.value) : null;
            if (igProblem) { problems.push(`Row ${i + 1}: ${igProblem}`); continue; }
            patch.media_url = media.value;
          }
        }
        if (row.scheduled_for) {
          const d = new Date(row.scheduled_for);
          if (isNaN(d.getTime())) { problems.push(`Row ${i + 1}: invalid scheduled_for`); continue; }
          if (d.toISOString() !== post.scheduled_for) patch.scheduled_for = d.toISOString();
        }
        if (Object.keys(patch).length === 0) continue;

        const u = await supabase.from('facebook_scheduled_posts')
          .update(patch).eq('id', post.id).eq('status', 'client_approved');
        if (u.error) { problems.push(`Row ${i + 1}: save failed`); continue; }
        if ('post_content' in patch || 'link_url' in patch || 'media_url' in patch) {
          await supabase.from('fb_post_revisions').insert({
            post_id: post.id, stage: 'final_upload',
            post_content: 'post_content' in patch ? patch.post_content : post.post_content,
            link_url: 'link_url' in patch ? patch.link_url : post.link_url,
            media_url: 'media_url' in patch ? patch.media_url : post.media_url,
            edited_by: user.email,
          });
        }
        updated.push(post.id);
      }
      return NextResponse.json({ success: problems.length === 0, updated: updated.length, problems });
    }

    case 'schedule': {
      if (batch.status !== 'client_approved') return err('Only client-approved batches can be scheduled', 409);
      if (posts.length === 0) return err('Batch has no posts');

      // HARD SAFETY RULE (lib/instagram/release.ts): with Instagram publishing off, Instagram rows
      // stay client_approved and the batch stays in "Ready to post"; only Facebook rows are released.
      const igEnabled = instagramPublishingEnabled();
      const plan = planScheduleRelease(posts, igEnabled);
      const igHeldMessage = plan.heldInstagram.length > 0
        ? `${plan.heldInstagram.length} Instagram post(s) not scheduled: Instagram publishing not enabled yet. They stay in Ready to post.`
        : null;
      if (plan.release.length === 0) {
        return err(igHeldMessage || 'No approved posts left to schedule', 409);
      }
      const toRelease = posts.filter((p) => plan.release.includes(p.id));

      const minMs = Date.now() + 10 * 60 * 1000; // Facebook needs scheduled times ≥10 min out
      const missing = toRelease.filter((p) => !p.scheduled_for || new Date(p.scheduled_for).getTime() < minMs);
      if (missing.length > 0) {
        return err(`${missing.length} post(s) need a future schedule time (at least 10 minutes out): ${missing.map((p) => p.franchise_name).slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
      }

      // Private draft media must be public before n8n/Facebook can fetch it. Copy everything
      // first (idempotent, one copy per file) and stop before claiming if any file fails, so
      // the batch stays client_approved and can be fixed (replace/remove the post) and retried.
      const publishMedia = createMediaPublisher(supabase);
      const mediaPosts = toRelease.filter((p) => isStorageRef(p.media_url));
      const publicUrlById = new Map<string, string>();
      const mediaFailures: string[] = [];
      for (const p of mediaPosts) {
        const isIg = p.platform === 'instagram';
        const res = await publishMedia(p.media_url, p.media_type, isIg ? instagramPublishConstraints(p.media_type) : {});
        if (res.ok && res.url) publicUrlById.set(p.id, res.url);
        else mediaFailures.push(`${p.franchise_name}${isIg ? ' (Instagram)' : ''}: ${res.ok ? 'no media' : res.error}`);
      }
      if (mediaFailures.length > 0) {
        return err(`Nothing was scheduled: media for ${mediaFailures.length} post(s) could not be published (${mediaFailures.slice(0, 5).join('; ')}${mediaFailures.length > 5 ? '…' : ''}). Replace the media or remove those posts, then schedule again.`, 502);
      }

      if (!(await claim(['client_approved'], { status: 'scheduled', scheduled_by_email: user.email, scheduled_at: now, client_token_hash: null }))) {
        return err('This batch was already scheduled or changed. Refresh and check.', 409);
      }

      // Point each post at its public copy while it is still client_approved (never picked up by
      // n8n); any post whose update fails is held back from release and reported.
      const failures: string[] = [];
      const heldBack: string[] = [];
      for (const [postId, url] of Array.from(publicUrlById.entries())) {
        const { data: upd, error: updErr } = await supabase
          .from('facebook_scheduled_posts')
          .update({ media_url: url })
          .eq('id', postId)
          .eq('status', 'client_approved')
          .select('id');
        if (updErr || (upd || []).length !== 1) {
          heldBack.push(postId);
          const name = posts.find((p) => p.id === postId)?.franchise_name || postId;
          failures.push(`${name}: media not updated; post not released`);
        }
      }

      // Release ONLY the planned rows (never batch-wide: held Instagram rows must stay out of 'pending')
      const releaseIds = plan.release.filter((id) => !heldBack.includes(id));
      let releasedRows: any[] = [];
      if (releaseIds.length > 0) {
        const { data, error: relErr } = await supabase
          .from('facebook_scheduled_posts')
          .update({ status: 'pending' })
          .eq('review_batch_id', batch.id)
          .eq('status', 'client_approved')
          .in('id', releaseIds)
          .select('*');
        if (relErr) {
          await supabase.from('fb_review_batches').update({ status: 'client_approved', updated_at: now }).eq('id', batch.id).eq('status', 'scheduled');
          return err('Failed to schedule posts', 500);
        }
        releasedRows = data || [];
      }

      // Guards before anything can reach n8n:
      //  * media swapped to a new private file mid-schedule must never be 'pending'
      //  * an Instagram row must never be 'pending' while Instagram publishing is off
      const released: any[] = [];
      for (const post of releasedRows) {
        const igBlocked = post.platform === 'instagram' && !igEnabled;
        if (!isStorageRef(post.media_url) && !igBlocked) { released.push(post); continue; }
        await supabase.from('facebook_scheduled_posts').update({ status: 'client_approved' }).eq('id', post.id).eq('status', 'pending');
        failures.push(`${post.franchise_name}: ${igBlocked ? 'Instagram publishing not enabled' : 'media changed while scheduling'}; post not released`);
      }

      // Same-day posts go to the Facebook webhook: Facebook rows only, never Instagram
      let webhookFailed = 0;
      for (const post of released) {
        if (!shouldSendSameDay(post, isScheduledForToday(post.scheduled_for))) continue; // n8n daily publisher handles the rest
        const res = await sendScheduledPostToWebhook(post);
        if (!res.ok) {
          webhookFailed++;
          failures.push(`${post.franchise_name}: ${res.error}`);
          await supabase.from('facebook_scheduled_posts').update({ status: 'failed' }).eq('id', post.id);
        }
      }

      // Anything still waiting (held Instagram rows, rows that failed to release) keeps the batch
      // in Ready to post so it can be scheduled again; re-scheduling only touches client_approved rows.
      const { count: stillApproved } = await supabase
        .from('facebook_scheduled_posts')
        .select('id', { count: 'exact', head: true })
        .eq('review_batch_id', batch.id)
        .eq('status', 'client_approved');
      const batchStatus = (stillApproved || 0) > 0 ? 'client_approved' : 'scheduled';
      if (batchStatus === 'client_approved') {
        await supabase.from('fb_review_batches').update({ status: 'client_approved', updated_at: now }).eq('id', batch.id).eq('status', 'scheduled');
      }

      return NextResponse.json({
        success: failures.length === 0,
        scheduled: released.length - webhookFailed,
        instagram_held: plan.heldInstagram.length,
        instagram_message: igHeldMessage,
        batch_status: batchStatus,
        failures,
      });
    }

    case 'cancel': {
      if (!(await claim(['internal_review', 'client_review', 'client_approved'], { status: 'cancelled', client_token_hash: null }))) {
        return err('Batch already scheduled or cancelled; delete individual posts from the Scheduled tab instead', 409);
      }
      // A batch kept in Ready to post for held Instagram rows may already have released Facebook
      // rows; cancelling does not unschedule those (delete them from the Scheduled tab).
      const alreadyScheduled = posts.filter((p) => p.status === 'pending').length;
      return NextResponse.json({ success: true, already_scheduled: alreadyScheduled });
    }

    default:
      return err('Unknown action');
  }
}
