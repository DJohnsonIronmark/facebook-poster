import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hashReviewToken, isWellFormedToken } from '@/lib/review/tokens';
import { appBaseUrl, notifyClientApproved } from '@/lib/review/notify';
import { MAX_POST_LENGTH } from '@/lib/review/types';

// PUBLIC (no login): the magic-link token is the credential. Everything is scoped to the
// single batch whose token hash matches; only post text and a comment can be changed.

const CLIENT_POST_COLUMNS =
  'id, facebook_page_id, franchise_name, location_number, post_content, link_url, media_url, media_type, scheduled_for, status, client_comment, link_preview';

async function resolveBatch(token: string) {
  if (!isWellFormedToken(token)) return { supabase: null, batch: null };
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('fb_review_batches')
    .select(`id, name, status, client_token_expires_at, client_approved_by, client_approved_at, client:fb_clients(name, internal_reviewer_emails), posts:facebook_scheduled_posts(${CLIENT_POST_COLUMNS})`)
    .eq('client_token_hash', hashReviewToken(token))
    .maybeSingle();
  if (!data) return { supabase, batch: null };
  if (!data.client_token_expires_at || new Date(data.client_token_expires_at) < new Date()) return { supabase, batch: null };
  if (!['client_review', 'client_approved'].includes(data.status)) return { supabase, batch: null };
  return { supabase, batch: data as any };
}

const notFound = () =>
  NextResponse.json({ error: 'This review link is invalid or has expired. Please contact your Ironmark team for a new link.' }, { status: 404 });

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const { batch } = await resolveBatch(params.token);
  if (!batch) return notFound();
  batch.posts?.sort((a: any, b: any) =>
    (a.scheduled_for || '').localeCompare(b.scheduled_for || '') || a.franchise_name.localeCompare(b.franchise_name));
  return NextResponse.json(
    {
      batch: {
        name: batch.name,
        status: batch.status,
        client_name: batch.client?.name,
        client_approved_by: batch.client_approved_by,
        client_approved_at: batch.client_approved_at,
        expires_at: batch.client_token_expires_at,
      },
      posts: batch.posts || [],
    },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  );
}

// POST { action: 'save' | 'approve', approver_name?, posts: [{ id, post_content, client_comment }] }
export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const { supabase, batch } = await resolveBatch(params.token);
  if (!batch || !supabase) return notFound();
  if (batch.status !== 'client_review') {
    return NextResponse.json({ error: 'These posts were already approved.' }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action;
  if (action !== 'save' && action !== 'approve') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  const approver = String(body.approver_name || '').trim().slice(0, 120);
  if (action === 'approve' && approver.length < 2) {
    return NextResponse.json({ error: 'Please enter your name to approve.' }, { status: 400 });
  }

  const byId = new Map<string, any>((batch.posts || []).map((p: any) => [p.id, p]));
  const edits: any[] = Array.isArray(body.posts) ? body.posts : [];
  let editedCount = 0;

  for (const edit of edits) {
    const post = byId.get(String(edit?.id || ''));
    if (!post) continue;
    const patch: Record<string, unknown> = {};
    if (typeof edit.post_content === 'string') {
      const content = edit.post_content.trim();
      if (!content) return NextResponse.json({ error: `Post for ${post.franchise_name} can't be empty.` }, { status: 400 });
      if (content.length > MAX_POST_LENGTH) return NextResponse.json({ error: 'A post is too long.' }, { status: 400 });
      if (content !== post.post_content) patch.post_content = content;
    }
    if (typeof edit.client_comment === 'string') {
      const comment = edit.client_comment.trim().slice(0, 2000) || null;
      if (comment !== post.client_comment) patch.client_comment = comment;
    }
    if (Object.keys(patch).length === 0) continue;

    const { error } = await supabase.from('facebook_scheduled_posts').update(patch).eq('id', post.id).eq('review_batch_id', batch.id);
    if (error) return NextResponse.json({ error: 'Failed to save your changes. Please try again.' }, { status: 500 });
    if (patch.post_content) {
      editedCount++;
      await supabase.from('fb_post_revisions').insert({
        post_id: post.id, stage: 'client_edit', post_content: patch.post_content, link_url: post.link_url, media_url: post.media_url,
        edited_by: `${approver || 'Client'} (client)`,
      });
    }
  }

  if (action === 'save') return NextResponse.json({ success: true, saved: editedCount });

  const now = new Date().toISOString();
  const p = await supabase.from('facebook_scheduled_posts').update({ status: 'client_approved' }).eq('review_batch_id', batch.id);
  const b = await supabase.from('fb_review_batches').update({
    status: 'client_approved', client_approved_by: approver, client_approved_at: now, updated_at: now,
  }).eq('id', batch.id).eq('status', 'client_review');
  if (p.error || b.error) return NextResponse.json({ error: 'Failed to approve. Please try again.' }, { status: 500 });

  // Count every post the client changed during this review (across earlier saves too)
  const { data: clientEdits } = await supabase
    .from('fb_post_revisions').select('post_id').eq('stage', 'client_edit').in('post_id', Array.from(byId.keys()));
  const totalEdited = new Set((clientEdits || []).map((r: any) => r.post_id)).size;

  await notifyClientApproved({
    to: batch.client?.internal_reviewer_emails || [],
    clientName: batch.client?.name || 'Client', batchName: batch.name, postCount: byId.size,
    editedCount: totalEdited, approvedBy: approver, baseUrl: appBaseUrl(request),
  });
  return NextResponse.json({ success: true, approved: byId.size });
}
