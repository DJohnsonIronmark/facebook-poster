import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { generateReviewToken } from '@/lib/review/tokens';
import { appBaseUrl, notifyClientReview, type EmailResult } from '@/lib/review/notify';
import { fetchLinkPreview } from '@/lib/review/linkPreview';
import { isScheduledForToday, sendScheduledPostToWebhook } from '@/lib/publisher';
import { MAX_POST_LENGTH } from '@/lib/review/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

/**
 * POST - workflow actions on a review batch (admin/manager)
 *   { action: 'approve_internal' }   internal review done → client_review + email client magic link
 *   { action: 'resend_link' }        new client link (old one stops working) + email
 *   { action: 'final_upload', rows } bulk-apply final copy/schedule to client-approved posts
 *   { action: 'schedule' }           client_approved → pending (n8n publishes); same-day via webhook
 *   { action: 'cancel' }             stop the batch; posts never publish
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;
  if (!UUID_RE.test(params.id)) return err('Invalid batch id');

  const body = await request.json().catch(() => ({}));
  const supabase = createServiceClient();

  const { data: batch, error: batchErr } = await supabase
    .from('fb_review_batches')
    .select('*, client:fb_clients(*), posts:facebook_scheduled_posts(*)')
    .eq('id', params.id)
    .single();
  if (batchErr || !batch) return err('Batch not found', 404);

  const now = new Date().toISOString();
  const posts: any[] = batch.posts || [];

  const sendClientLink = async (): Promise<{ email: EmailResult; review_url: string; expires_at: string } | NextResponse> => {
    const recipients: string[] = batch.client?.client_reviewer_emails || [];
    if (recipients.length === 0) return err('No client reviewer emails configured for this client. Add them under Clients.');
    const { token, hash, expiresAt } = generateReviewToken();
    const reviewUrl = `${appBaseUrl(request)}/review/${token}`;
    const upd = await supabase
      .from('fb_review_batches')
      .update({ client_token_hash: hash, client_token_expires_at: expiresAt, sent_to_client_at: now, updated_at: now })
      .eq('id', batch.id);
    if (upd.error) return err('Failed to create client link', 500);
    const email = await notifyClientReview({
      to: recipients, clientName: batch.client.name, postCount: posts.length, reviewUrl, expiresAt,
    });
    return { email, review_url: reviewUrl, expires_at: expiresAt };
  };

  switch (body.action) {
    case 'approve_internal': {
      if (batch.status !== 'internal_review') return err(`Batch is ${batch.status}, not awaiting internal review`);
      if (posts.length === 0) return err('Batch has no posts');
      const p = await supabase.from('facebook_scheduled_posts').update({ status: 'client_review' }).eq('review_batch_id', batch.id);
      if (p.error) return err('Failed to update posts', 500);
      const b = await supabase.from('fb_review_batches').update({
        status: 'client_review', internal_approved_by_email: user.email, internal_approved_at: now, updated_at: now,
      }).eq('id', batch.id);
      if (b.error) return err('Failed to update batch', 500);
      const link = await sendClientLink();
      if (link instanceof NextResponse) {
        // roll back so the batch isn't stuck in client_review with no link
        await supabase.from('facebook_scheduled_posts').update({ status: 'internal_review' }).eq('review_batch_id', batch.id);
        await supabase.from('fb_review_batches').update({ status: 'internal_review', internal_approved_at: null, internal_approved_by_email: null }).eq('id', batch.id);
        return link;
      }
      return NextResponse.json({ success: true, ...link });
    }

    case 'resend_link': {
      if (batch.status !== 'client_review') return err('Batch is not awaiting client review');
      const link = await sendClientLink();
      if (link instanceof NextResponse) return link;
      return NextResponse.json({ success: true, ...link });
    }

    case 'final_upload': {
      if (batch.status !== 'client_approved') return err('Final copy can only be uploaded after the client approves');
      const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
      const byId = new Map(posts.map((p) => [p.id, p]));
      const updated: string[] = [];
      const problems: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const post = byId.get(String(row.post_id || ''));
        if (!post) { problems.push(`Row ${i + 1}: post_id not in this batch`); continue; }
        const patch: Record<string, unknown> = {};
        if (typeof row.post_content === 'string' && row.post_content.trim()) {
          if (row.post_content.length > MAX_POST_LENGTH) { problems.push(`Row ${i + 1}: content too long`); continue; }
          patch.post_content = row.post_content.trim();
        }
        if (typeof row.link_url === 'string' && !post.media_type) {
          patch.link_url = row.link_url.trim() || null;
          if (patch.link_url !== post.link_url) patch.link_preview = await fetchLinkPreview(patch.link_url as string | null);
        }
        if (typeof row.media_url === 'string' && post.media_type && row.media_url.trim()) patch.media_url = row.media_url.trim();
        if (row.scheduled_for) {
          const d = new Date(row.scheduled_for);
          if (isNaN(d.getTime())) { problems.push(`Row ${i + 1}: invalid scheduled_for`); continue; }
          patch.scheduled_for = d.toISOString();
        }
        if (Object.keys(patch).length === 0) continue;
        const u = await supabase.from('facebook_scheduled_posts').update(patch).eq('id', post.id);
        if (u.error) { problems.push(`Row ${i + 1}: save failed`); continue; }
        await supabase.from('fb_post_revisions').insert({
          post_id: post.id, stage: 'final_upload',
          post_content: (patch.post_content as string) ?? post.post_content,
          link_url: (patch.link_url as string | null) ?? post.link_url,
          media_url: (patch.media_url as string) ?? post.media_url,
          edited_by: user.email,
        });
        updated.push(post.id);
      }
      return NextResponse.json({ success: problems.length === 0, updated: updated.length, problems });
    }

    case 'schedule': {
      if (batch.status !== 'client_approved') return err('Only client-approved batches can be scheduled');
      const nowMs = Date.now();
      const missing = posts.filter((p) => !p.scheduled_for || new Date(p.scheduled_for).getTime() < nowMs + 10 * 60 * 1000);
      if (missing.length > 0) {
        return err(`${missing.length} post(s) need a future schedule time (at least 10 minutes out): ${missing.map((p) => p.franchise_name).slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
      }
      const failures: string[] = [];
      for (const post of posts) {
        const u = await supabase.from('facebook_scheduled_posts').update({ status: 'pending' }).eq('id', post.id);
        if (u.error) { failures.push(`${post.franchise_name}: save failed`); continue; }
        if (isScheduledForToday(post.scheduled_for)) {
          const res = await sendScheduledPostToWebhook(post);
          if (!res.ok) {
            failures.push(`${post.franchise_name}: ${res.error}`);
            await supabase.from('facebook_scheduled_posts').update({ status: 'failed' }).eq('id', post.id);
          }
        }
      }
      await supabase.from('fb_review_batches').update({
        status: 'scheduled', scheduled_by_email: user.email, scheduled_at: now, client_token_hash: null, updated_at: now,
      }).eq('id', batch.id);
      return NextResponse.json({ success: failures.length === 0, scheduled: posts.length - failures.length, failures });
    }

    case 'cancel': {
      if (batch.status === 'scheduled') return err('Batch already scheduled; delete individual posts from the Scheduled tab instead');
      await supabase.from('fb_review_batches').update({ status: 'cancelled', client_token_hash: null, updated_at: now }).eq('id', batch.id);
      return NextResponse.json({ success: true });
    }

    default:
      return err('Unknown action');
  }
}
