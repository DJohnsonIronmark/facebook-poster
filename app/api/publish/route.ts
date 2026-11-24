import { NextRequest, NextResponse } from 'next/server';
import { canSeePage, filterByPage, noPageAccess, requireScopedUser, visiblePageIds } from '@/lib/access';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UUID_RE } from '@/lib/review/guards';
import { mayUseFacebookWebhook } from '@/lib/instagram/release';
import { facebookAppPublishingEnabled } from '@/lib/social/switches';
import { claimAndPublishFacebook, type FacebookPostRow } from '@/lib/facebook/publish';
import { claimAndPublishInstagram, instagramAppPublishingEnabled } from '@/lib/instagram/appPublish';

export const maxDuration = 300;

// POST - Publish a scheduled post now (service role for data access): Facebook directly with the
// page's own token; Instagram through the app publisher.
export async function POST(request: NextRequest) {
  // Viewers are Internal View Only: they can see posts but not create, delete or publish them
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  try {
    const { post_id } = await request.json();
    if (!post_id || !UUID_RE.test(String(post_id))) {
      return NextResponse.json({ error: 'Valid post ID is required' }, { status: 400 });
    }
    const supabase = createServiceClient();
    const { data: post, error: fetchErr } = await supabase
      .from('facebook_scheduled_posts').select('*').eq('id', post_id).maybeSingle();
    if (fetchErr) return NextResponse.json({ error: 'Failed to fetch post' }, { status: 500 });
    if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    {
      const scoped = await requireScopedUser(['admin', 'manager']);
      if (scoped.error) return scoped.error;
      if (!canSeePage(scoped.scope, String(post.facebook_page_id))) return noPageAccess();
    }

    // Approval workflow: only posts already released to 'pending' can be published from here
    // (review posts move to 'pending' only via Approvals → Schedule).
    if (post.status !== 'pending') {
      return NextResponse.json(
        { error: post.review_batch_id ? 'This post is in the approval workflow; schedule it from Approvals once the client approves.' : `Post is ${post.status}` },
        { status: 409 }
      );
    }
    // This webhook publishes to Facebook; Instagram rows are left to the n8n Instagram publisher and
    // LinkedIn / X rows to the app's social runner (/api/publish/social-run)
    if (post.platform === 'linkedin' || post.platform === 'x') {
      return NextResponse.json(
        { error: `${post.platform === 'x' ? 'X' : 'LinkedIn'} posts can't be published immediately; schedule them instead (they publish at their scheduled time).` },
        { status: 400 }
      );
    }
    // Instagram published by the app itself (never the Facebook webhook)
    if (post.platform === 'instagram' && instagramAppPublishingEnabled()) {
      const result = await claimAndPublishInstagram(supabase, post);
      if (result.ok) return NextResponse.json({ success: true, message: 'Published to Instagram' });
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    if (!mayUseFacebookWebhook(post)) {
      return NextResponse.json({ error: 'Instagram posts cannot be published from here; they publish at their scheduled time.' }, { status: 409 });
    }

    // Every Facebook page publishes from the app with its own token (n8n is no longer used)
    if (!facebookAppPublishingEnabled()) {
      return NextResponse.json({ error: 'Facebook publishing is turned off (FACEBOOK_APP_PUBLISHING_ENABLED).' }, { status: 409 });
    }
    const result = await claimAndPublishFacebook(supabase, post as FacebookPostRow);
    if (result.status === 'published') return NextResponse.json({ success: true, message: 'Post published successfully' });
    if (result.status === 'skipped') return NextResponse.json({ error: result.reason }, { status: 409 });
    return NextResponse.json({ error: result.error }, { status: 502 });
  } catch (error) {
    console.error('Error publishing post:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
