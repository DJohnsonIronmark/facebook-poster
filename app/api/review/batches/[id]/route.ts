import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { generateReviewToken } from '@/lib/review/tokens';
import { appBaseUrl, notifyClientReview } from '@/lib/review/notify';
import { fetchLinkPreview } from '@/lib/review/linkPreview';
import { isScheduledForToday, sendScheduledPostToWebhook } from '@/lib/publisher';
import { MAX_POST_LENGTH } from '@/lib/review/types';
import { UUID_RE } from '@/lib/review/guards';

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
      to: recipients, clientName: batch.client.name, postCount: posts.length, reviewUrl, expiresAt,
      replyTo: batch.client.internal_reviewer_emails || [],
    });
    return { email, review_url: reviewUrl, expires_at: expiresAt };
  };

  switch (body.action) {
    case 'approve_internal': {
      if (batch.status !== 'internal_review') return err(`Batch is ${batch.status}, not awaiting internal review`, 409);
      if (posts.length === 0) return err('Batch has no posts');
      if (recipients.length === 0) return err('No client reviewer emails configured for this client. Add them under Client settings.');

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
        if (typeof row.post_content === 'string' && row.post_content.trim()) {
          if (row.post_content.length > MAX_POST_LENGTH) { problems.push(`Row ${i + 1}: content too long`); continue; }
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
          const media = row.media_url.trim();
          if (!isHttpUrl(media)) { problems.push(`Row ${i + 1}: media_url must be http(s)`); continue; }
          if (media !== post.media_url) patch.media_url = media;
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
      const minMs = Date.now() + 10 * 60 * 1000; // Facebook needs scheduled times ≥10 min out
      const missing = posts.filter((p) => !p.scheduled_for || new Date(p.scheduled_for).getTime() < minMs);
      if (missing.length > 0) {
        return err(`${missing.length} post(s) need a future schedule time (at least 10 minutes out): ${missing.map((p) => p.franchise_name).slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
      }

      if (!(await claim(['client_approved'], { status: 'scheduled', scheduled_by_email: user.email, scheduled_at: now, client_token_hash: null }))) {
        return err('This batch was already scheduled or changed. Refresh and check.', 409);
      }
      const { data: released, error: relErr } = await supabase
        .from('facebook_scheduled_posts')
        .update({ status: 'pending' })
        .eq('review_batch_id', batch.id)
        .eq('status', 'client_approved')
        .select('*');
      if (relErr) return err('Failed to schedule posts', 500);

      const failures: string[] = [];
      for (const post of released || []) {
        if (!isScheduledForToday(post.scheduled_for)) continue; // n8n daily publisher handles future days
        const res = await sendScheduledPostToWebhook(post);
        if (!res.ok) {
          failures.push(`${post.franchise_name}: ${res.error}`);
          await supabase.from('facebook_scheduled_posts').update({ status: 'failed' }).eq('id', post.id);
        }
      }
      return NextResponse.json({ success: failures.length === 0, scheduled: (released || []).length - failures.length, failures });
    }

    case 'cancel': {
      if (!(await claim(['internal_review', 'client_review', 'client_approved'], { status: 'cancelled', client_token_hash: null }))) {
        return err('Batch already scheduled or cancelled; delete individual posts from the Scheduled tab instead', 409);
      }
      return NextResponse.json({ success: true });
    }

    default:
      return err('Unknown action');
  }
}
