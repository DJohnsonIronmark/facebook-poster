import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { replacePlaceholders } from '@/lib/placeholders';
import { UUID_RE, pageRequiresApproval } from '@/lib/review/guards';
import { isScheduledForToday, normalizeMediaType } from '@/lib/publisher';

// Direct (non-approval) scheduling path. All data access is server-side via the service role.
// n8n "Facebook Daily Scheduled Publisher" publishes rows with status='pending' once scheduled_for
// has passed (daily 6 AM run); same-day posts and "publish now" go straight to the n8n webhook.

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// GET - Fetch all posts
export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('facebook_scheduled_posts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('posts GET', error);
    return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 });
  }
  return NextResponse.json({ posts: data });
}

// POST - Create a new post
export async function POST(request: NextRequest) {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  try {
    const body = await request.json();
    const { facebook_page_id, franchise_name, post_content, link_url, scheduled_for, publish_now, media_url, city, base_url, phone } = body;

    if (!facebook_page_id || !post_content) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Approval workflow is enforced server-side, not just in the form
    if (await pageRequiresApproval(String(facebook_page_id))) {
      return NextResponse.json(
        { error: "This page's client requires approval. Submit it as a draft through the approval workflow." },
        { status: 409 }
      );
    }

    const placeholderValues = {
      city: city || '',
      franchise_name: franchise_name || '',
      location_number: body.location_number || '',
      base_url: base_url || '',
      phone: phone || '',
    };
    const mediaType = normalizeMediaType(body.media_type);
    const processedContent = replacePlaceholders(post_content, placeholderValues);
    const processedLinkUrl = mediaType ? '' : replacePlaceholders(link_url || '', placeholderValues);

    let scheduledIso: string | null = null;
    if (scheduled_for && !publish_now) {
      const d = new Date(scheduled_for);
      if (isNaN(d.getTime())) return NextResponse.json({ error: 'Invalid schedule date' }, { status: 400 });
      scheduledIso = d.toISOString();
    }
    const viaWebhook = !!publish_now || isScheduledForToday(scheduledIso);
    if (viaWebhook && !N8N_WEBHOOK_URL) {
      return NextResponse.json({ error: 'n8n webhook URL not configured' }, { status: 500 });
    }

    // Save first to get the post ID
    const supabase = createServiceClient();
    const { data: saved, error: insertErr } = await supabase
      .from('facebook_scheduled_posts')
      .insert({
        facebook_page_id,
        franchise_name,
        location_number: body.location_number || null,
        post_content: processedContent,
        link_url: processedLinkUrl || null,
        scheduled_for: scheduledIso,
        status: publish_now ? 'published' : 'pending',
        published_at: publish_now ? new Date().toISOString() : null,
        media_url: mediaType ? media_url || null : null,
        media_type: mediaType,
      })
      .select('*')
      .single();
    if (insertErr || !saved) {
      console.error('posts POST insert', insertErr);
      return NextResponse.json({ error: 'Failed to save post' }, { status: 500 });
    }

    if (!viaWebhook) {
      return NextResponse.json({ success: true, message: 'Post scheduled successfully', post: saved });
    }

    // Publish now / same-day: hand to the n8n webhook
    const webhookPayload = {
      Facebook_Page_ID: facebook_page_id,
      FRANCHISENAME: franchise_name,
      Location_Number: body.location_number || '',
      Post_Content: processedContent,
      Link_URL: processedLinkUrl,
      Scheduled_Publish_Time: publish_now || !scheduledIso ? '' : Math.floor(new Date(scheduledIso).getTime() / 1000).toString(),
      Publish_Immediately: publish_now ? 'true' : 'false',
      Media_URL: saved.media_url || '',
      Media_Type: mediaType || '',
      Post_ID: saved.id, // internal post ID for updating facebook_post_id after publish
    };
    const webhookResponse = await fetch(N8N_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });
    if (!webhookResponse.ok) {
      console.error('n8n webhook error:', await webhookResponse.text());
      await supabase.from('facebook_scheduled_posts').update({ status: 'failed' }).eq('id', saved.id);
      return NextResponse.json({ error: 'Failed to publish post' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: publish_now ? 'Post published successfully' : 'Post scheduled for today and sent to publisher',
      post: saved,
    });
  } catch (error) {
    console.error('Error creating post:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE - Delete a post
export async function DELETE(request: NextRequest) {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const postId = new URL(request.url).searchParams.get('id');
  if (!postId || !UUID_RE.test(postId)) {
    return NextResponse.json({ error: 'Valid post ID is required' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase.from('facebook_scheduled_posts').delete().eq('id', postId);
  if (error) {
    console.error('posts DELETE', error);
    return NextResponse.json({ error: 'Failed to delete post' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
