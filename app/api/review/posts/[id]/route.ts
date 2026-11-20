import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchLinkPreview } from '@/lib/review/linkPreview';
import { MAX_POST_LENGTH, POST_REVIEW_COLUMNS } from '@/lib/review/types';
import { normalizeIncomingMediaUrl, signPostMedia } from '@/lib/media/server';
import { attachInstagramUsernames, instagramCaptionProblem, instagramMediaProblem } from '@/lib/instagram/server';
import { attachSocialIdentities, isSocialPlatform, socialMediaUrlProblem, socialTextProblem } from '@/lib/social/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Internal team can edit while drafts are with them, or after the client approves (final form).
// While the client is reviewing, the copy is locked so the two sides don't overwrite each other.
const EDITABLE = ['internal_review', 'client_approved'];

async function loadPost(id: string) {
  const supabase = createServiceClient();
  const { data } = await supabase.from('facebook_scheduled_posts').select('*').eq('id', id).single();
  return { supabase, post: data };
}

// PATCH - internal edit of a post in review
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invalid post id' }, { status: 400 });

  const { supabase, post } = await loadPost(params.id);
  if (!post || !post.review_batch_id) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  if (!EDITABLE.includes(post.status)) {
    return NextResponse.json({ error: post.status === 'client_review' ? 'Locked while the client is reviewing' : 'Post is no longer in review' }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  const isIg = post.platform === 'instagram';
  const social = isSocialPlatform(post.platform) ? post.platform : null;
  if (typeof body.post_content === 'string') {
    const c = body.post_content.trim();
    if (!c || c.length > MAX_POST_LENGTH) return NextResponse.json({ error: 'Post content is empty or too long' }, { status: 400 });
    const igProblem = isIg ? instagramCaptionProblem(c) : null;
    if (igProblem) return NextResponse.json({ error: igProblem }, { status: 400 });
    const socialProblem = social ? socialTextProblem(social, c, { hasMedia: !!post.media_type, hasLink: !!post.link_url }) : null;
    if (socialProblem) return NextResponse.json({ error: socialProblem }, { status: 400 });
    patch.post_content = c;
  }
  // X keeps links in the text itself (no link card), so X rows never take link_url
  if (typeof body.link_url === 'string' && !post.media_type && !isIg && social !== 'x') {
    patch.link_url = body.link_url.trim() || null;
    patch.link_preview = await fetchLinkPreview(patch.link_url as string | null);
  }
  if (typeof body.media_url === 'string' && post.media_type && body.media_url.trim()) {
    // Accepts an http(s) URL or a storage:// ref from /api/media/upload-urls; a signed preview
    // URL we issued maps back to its ref (so an unchanged image isn't swapped for an expiring URL)
    const media = normalizeIncomingMediaUrl(body.media_url);
    if (!media.ok) return NextResponse.json({ error: 'Invalid media URL' }, { status: 400 });
    const igProblem = isIg && media.value !== post.media_url ? instagramMediaProblem(post.media_type, media.value) : null;
    if (igProblem) return NextResponse.json({ error: igProblem }, { status: 400 });
    const socialMedia = social && media.value !== post.media_url ? socialMediaUrlProblem(social, post.media_type, media.value) : null;
    if (socialMedia) return NextResponse.json({ error: socialMedia }, { status: 400 });
    if (media.value !== post.media_url) patch.media_url = media.value;
  }
  if (body.scheduled_for !== undefined) {
    if (body.scheduled_for === null || body.scheduled_for === '') patch.scheduled_for = null;
    else {
      const d = new Date(body.scheduled_for);
      if (isNaN(d.getTime())) return NextResponse.json({ error: 'Invalid schedule date' }, { status: 400 });
      patch.scheduled_for = d.toISOString();
    }
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  const { data, error } = await supabase
    .from('facebook_scheduled_posts').update(patch).eq('id', post.id).in('status', EDITABLE)
    .select(POST_REVIEW_COLUMNS).maybeSingle();
  if (error) return NextResponse.json({ error: 'Failed to save post' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Post moved to another stage; refresh and try again' }, { status: 409 });

  if ('post_content' in patch || 'link_url' in patch || 'media_url' in patch) {
    await supabase.from('fb_post_revisions').insert({
      post_id: post.id, stage: 'internal_edit', post_content: data.post_content, link_url: data.link_url, media_url: data.media_url, edited_by: user.email,
    });
  }
  await signPostMedia(supabase, [data]);
  await attachInstagramUsernames(supabase, [data]);
  await attachSocialIdentities(supabase, [data]);
  return NextResponse.json({ post: data });
}

// DELETE - drop a post from a batch that hasn't been scheduled yet
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invalid post id' }, { status: 400 });

  const { supabase, post } = await loadPost(params.id);
  if (!post || !post.review_batch_id) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  if (!['internal_review', 'client_review', 'client_approved'].includes(post.status)) {
    return NextResponse.json({ error: 'Post is already scheduled' }, { status: 409 });
  }
  const { error } = await supabase.from('facebook_scheduled_posts').delete().eq('id', post.id);
  if (error) return NextResponse.json({ error: 'Failed to remove post' }, { status: 500 });
  return NextResponse.json({ success: true });
}
