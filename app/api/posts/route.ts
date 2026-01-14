import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// GET - Fetch all posts
export async function GET() {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts?select=*&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch posts', details: error },
        { status: response.status }
      );
    }

    const posts = await response.json();
    return NextResponse.json({ posts });
  } catch (error) {
    console.error('Error fetching posts:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Create a new post
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      facebook_page_id,
      franchise_name,
      post_content,
      link_url,
      scheduled_for,
      publish_now,
    } = body;

    // Validate required fields
    if (!facebook_page_id || !post_content) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // If publish_now is true, trigger n8n webhook directly
    if (publish_now) {
      if (!N8N_WEBHOOK_URL) {
        return NextResponse.json(
          { error: 'n8n webhook URL not configured' },
          { status: 500 }
        );
      }

      // Trigger n8n webhook for immediate publishing
      const webhookPayload = {
        Facebook_Page_ID: facebook_page_id,
        FRANCHISENAME: franchise_name,
        Post_Content: post_content,
        Link_URL: link_url || '',
      };

      const webhookResponse = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      });

      if (!webhookResponse.ok) {
        const error = await webhookResponse.text();
        console.error('n8n webhook error:', error);
        return NextResponse.json(
          { error: 'Failed to publish post', details: error },
          { status: 500 }
        );
      }

      // Save to Supabase as published
      const postData = {
        facebook_page_id,
        franchise_name,
        post_content,
        link_url: link_url || null,
        scheduled_for: null,
        status: 'published',
        published_at: new Date().toISOString(),
      };

      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts`,
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify(postData),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error('Supabase error:', error);
        // Post was published but not saved - still return success
        return NextResponse.json({
          success: true,
          message: 'Post published (but not saved to database)',
        });
      }

      const savedPost = await response.json();
      return NextResponse.json({
        success: true,
        message: 'Post published successfully',
        post: savedPost[0],
      });
    }

    // Save as scheduled post
    const postData = {
      facebook_page_id,
      franchise_name,
      post_content,
      link_url: link_url || null,
      scheduled_for: scheduled_for || null,
      status: 'pending',
    };

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(postData),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to save post', details: error },
        { status: response.status }
      );
    }

    const savedPost = await response.json();
    return NextResponse.json({
      success: true,
      message: 'Post scheduled successfully',
      post: savedPost[0],
    });
  } catch (error) {
    console.error('Error creating post:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE - Delete a post
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const postId = searchParams.get('id');

    if (!postId) {
      return NextResponse.json(
        { error: 'Post ID is required' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/facebook_scheduled_posts?id=eq.${postId}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to delete post', details: error },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting post:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
