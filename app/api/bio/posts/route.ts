import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireAuth, requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { UUID_RE } from '@/lib/review/guards';
import { IG_USER_ID_RE } from '@/lib/instagram/rules';
import { signPostMedia } from '@/lib/media/server';
import { cleanBioUrl } from '@/lib/bio/rules';
import { facebookPageIdsForIg } from '@/lib/bio/server';

// Instagram posts of one account, for setting each grid tile's link.
// GET ?ig_user_id= (signed-in) · PATCH { id, bio_link_url?, bio_hidden? } (admin/manager)

const POST_COLUMNS = 'id, franchise_name, status, scheduled_for, published_at, post_content, media_url, media_type, bio_link_url, bio_hidden, facebook_page_id';

export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const igUserId = new URL(request.url).searchParams.get('ig_user_id') || '';
  if (!IG_USER_ID_RE.test(igUserId)) return NextResponse.json({ error: 'Invalid Instagram account' }, { status: 400 });

  const supabase = createServiceClient();
  const { ids } = await facebookPageIdsForIg(supabase, igUserId);
  if (ids.length === 0) return NextResponse.json({ posts: [] });

  const { data, error } = await supabase
    .from('facebook_scheduled_posts')
    .select(POST_COLUMNS)
    .eq('platform', 'instagram')
    .neq('status', 'failed')
    .in('facebook_page_id', ids)
    .order('published_at', { ascending: false, nullsFirst: true })
    .order('scheduled_for', { ascending: false })
    .limit(200);
  if (error) {
    console.error('bio posts GET', error);
    return NextResponse.json({ error: 'Failed to load Instagram posts' }, { status: 500 });
  }
  return NextResponse.json({ posts: await signPostMedia(supabase, data || []) });
}

export async function PATCH(request: NextRequest) {
  const { error: authError } = await requireRole(['admin', 'manager']);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const id = String(body?.id ?? '');
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid post' }, { status: 400 });

  const patch: { bio_link_url?: string | null; bio_hidden?: boolean } = {};
  if ('bio_link_url' in body) {
    const url = cleanBioUrl(body.bio_link_url);
    if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 });
    patch.bio_link_url = url.value;
  }
  if ('bio_hidden' in body) {
    if (typeof body.bio_hidden !== 'boolean') return NextResponse.json({ error: 'bio_hidden must be true or false' }, { status: 400 });
    patch.bio_hidden = body.bio_hidden;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('facebook_scheduled_posts')
    .update(patch)
    .eq('id', id)
    .eq('platform', 'instagram')
    .select('id, bio_link_url, bio_hidden, facebook_page_id')
    .maybeSingle();
  if (error) {
    console.error('bio posts PATCH', error);
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Instagram post not found' }, { status: 404 });

  // Refresh the public page this post appears on
  const { data: pages } = await supabase.from('facebook_pages').select('ig_user_id').eq('facebook_page_id', data.facebook_page_id);
  const igIds = Array.from(new Set((pages || []).map((p: { ig_user_id: string | null }) => p.ig_user_id).filter((v: string | null): v is string => !!v)));
  if (igIds.length > 0) {
    const { data: bios } = await supabase.from('fb_bio_pages').select('slug').in('ig_user_id', igIds);
    for (const b of (bios || []) as { slug: string }[]) revalidatePath(`/l/${b.slug}`);
  }
  return NextResponse.json({ post: { id: data.id, bio_link_url: data.bio_link_url, bio_hidden: data.bio_hidden } });
}
