// Mirrors /api/posts behavior: posts scheduled for *today* are sent straight to the n8n
// publish webhook (the daily publisher has already run); future-dated 'pending' posts are
// picked up by the n8n daily scheduled publisher (status=eq.pending, scheduled_for not null).

export function isScheduledForToday(scheduledFor: string | null | undefined): boolean {
  if (!scheduledFor) return false;
  const d = new Date(scheduledFor);
  const t = new Date();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

export async function sendScheduledPostToWebhook(post: {
  id: string;
  facebook_page_id: string;
  franchise_name: string;
  location_number: string | null;
  post_content: string;
  link_url: string | null;
  media_url: string | null;
  media_type: string | null;
  scheduled_for: string;
}): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return { ok: false, error: 'n8n webhook URL not configured' };

  const payload = {
    Facebook_Page_ID: post.facebook_page_id,
    FRANCHISENAME: post.franchise_name,
    Location_Number: post.location_number || '',
    Post_Content: post.post_content,
    Link_URL: post.link_url || '',
    Scheduled_Publish_Time: Math.floor(new Date(post.scheduled_for).getTime() / 1000).toString(),
    Publish_Immediately: 'false',
    Media_URL: post.media_url || '',
    Media_Type: post.media_type || '',
    Post_ID: post.id,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'webhook request failed' };
  }
}

/** Normalize media type to what n8n routes on ('photo' | 'video'). */
export function normalizeMediaType(v: unknown): 'photo' | 'video' | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'photo' || s === 'image') return 'photo';
  if (s === 'video') return 'video';
  return null;
}
