import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// POST - Publish a scheduled post via n8n webhook
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { post_id } = body;

    if (!post_id) {
      return NextResponse.json(
        { error: 'Post ID is required' },
        { status: 400 }
      );
    }

    if (!N8N_WEBHOOK_URL) {
      return NextResponse.json(
        { error: 'n8n webhook URL not configured' },
        { status: 500 }
      );
    }

    // Fetch the post from Supabase
    const fetchResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts?id=eq.${post_id}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    if (!fetchResponse.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch post' },
        { status: 500 }
      );
    }

    const posts = await fetchResponse.json();
    if (posts.length === 0) {
      return NextResponse.json(
        { error: 'Post not found' },
        { status: 404 }
      );
    }

    const post = posts[0];

    // Trigger n8n webhook
    const webhookPayload = {
      Facebook_Page_ID: post.facebook_page_id,
      FRANCHISENAME: post.franchise_name,
      Post_Content: post.post_content,
      Link_URL: post.link_url || '',
    };

    const webhookResponse = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });

    if (!webhookResponse.ok) {
      const error = await webhookResponse.text();
      console.error('n8n webhook error:', error);

      // Update post status to failed
      await fetch(
        `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts?id=eq.${post_id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'failed' }),
        }
      );

      return NextResponse.json(
        { error: 'Failed to publish post via n8n', details: error },
        { status: 500 }
      );
    }

    // Update post status to published
    const updateResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts?id=eq.${post_id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'published',
          published_at: new Date().toISOString(),
        }),
      }
    );

    if (!updateResponse.ok) {
      console.error('Failed to update post status');
      // Post was published but status not updated - still return success
    }

    return NextResponse.json({
      success: true,
      message: 'Post published successfully',
    });
  } catch (error) {
    console.error('Error publishing post:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
