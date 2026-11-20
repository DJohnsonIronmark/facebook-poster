import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UUID_RE } from '@/lib/review/guards';
import { mayUseFacebookWebhook } from '@/lib/instagram/release';
import { facebookAppPublishingEnabled } from '@/lib/social/switches';
import { claimAndPublishFacebook, type FacebookPostRow } from '@/lib/facebook/publish';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// POST - Publish a scheduled post now (service role for data access): via the n8n webhook, or for
// pages set to publish_via='app', directly with the page's own token.
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth();
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
    if (!mayUseFacebookWebhook(post)) {
      return NextResponse.json({ error: 'Instagram posts cannot be published from here; they publish at their scheduled time.' }, { status: 409 });
    }

    // Pages set to app publishing: publish here with the page's own token; never the n8n webhook
    if (post.publish_via === 'app') {
      if (!facebookAppPublishingEnabled()) {
        return NextResponse.json(
          { error: 'This page is set to publish from the app, but app publishing is turned off (FACEBOOK_APP_PUBLISHING_ENABLED). Switch the page back to n8n on the Pages tab, or turn app publishing on.' },
          { status: 409 }
        );
      }
      const result = await claimAndPublishFacebook(supabase, post as FacebookPostRow);
      if (result.status === 'published') return NextResponse.json({ success: true, message: 'Post published successfully' });
      if (result.status === 'skipped') return NextResponse.json({ error: result.reason }, { status: 409 });
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    if (!N8N_WEBHOOK_URL) {
      return NextResponse.json({ error: 'n8n webhook URL not configured' }, { status: 500 });
    }

    const webhookPayload = {
      Facebook_Page_ID: post.facebook_page_id,
      FRANCHISENAME: post.franchise_name,
      Post_Content: post.post_content,
      Link_URL: post.link_url || '',
      Publish_Immediately: 'true', // must be a string for the n8n Switch node
      Media_URL: post.media_url || '',
      Media_Type: post.media_type || '',
      Post_ID: post.id, // internal post ID for updating facebook_post_id after publish
    };
    const webhookResponse = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });

    if (!webhookResponse.ok) {
      console.error('n8n webhook error:', await webhookResponse.text());
      await supabase.from('facebook_scheduled_posts').update({ status: 'failed' }).eq('id', post.id);
      return NextResponse.json({ error: 'Failed to publish post via n8n' }, { status: 500 });
    }

    const { error: updErr } = await supabase
      .from('facebook_scheduled_posts')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', post.id);
    if (updErr) console.error('Published but failed to update status', updErr);

    return NextResponse.json({ success: true, message: 'Post published successfully' });
  } catch (error) {
    console.error('Error publishing post:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
