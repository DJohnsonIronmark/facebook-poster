import type { SupabaseClient } from '@supabase/supabase-js';
import { isOurPublicMediaUrl } from '@/lib/social/server';
import { BIO_GRID_LIMIT, buildBioTiles, cleanBioButtons, type BioButton, type BioTile } from './rules';

// Server-only link in bio helpers (service-role client required).

export interface BioSettings {
  id: string;
  ig_user_id: string;
  slug: string;
  title: string | null;
  buttons: BioButton[];
  enabled: boolean;
  updated_by: string | null;
  updated_at: string;
}

export const BIO_COLUMNS = 'id, ig_user_id, slug, title, buttons, enabled, updated_by, updated_at';

/** Facebook page ids whose page rows are linked to this Instagram account. */
export async function facebookPageIdsForIg(supabase: SupabaseClient, igUserId: string): Promise<{ ids: string[]; username: string | null }> {
  const { data, error } = await supabase.from('facebook_pages').select('facebook_page_id, ig_username').eq('ig_user_id', igUserId);
  if (error) throw new Error(`facebook_pages lookup failed: ${error.message}`);
  const rows = (data || []) as { facebook_page_id: string; ig_username: string | null }[];
  return {
    ids: Array.from(new Set(rows.map((r) => String(r.facebook_page_id)))),
    username: rows.map((r) => r.ig_username).find(Boolean) || null,
  };
}

export interface PublicBioPage {
  title: string;
  username: string | null;
  buttons: BioButton[];
  tiles: BioTile[];
}

/**
 * Everything the public /l/<slug> page shows, or null when there is no enabled page with that slug.
 * Only safe fields leave this function: no ids of pages, clients or users.
 */
export async function loadPublicBioPage(supabase: SupabaseClient, slug: string): Promise<PublicBioPage | null> {
  const { data: settings, error } = await supabase
    .from('fb_bio_pages').select(BIO_COLUMNS).eq('slug', slug).eq('enabled', true).maybeSingle();
  if (error) {
    console.error('[bio] settings lookup', error.message);
    return null;
  }
  if (!settings) return null;
  const s = settings as BioSettings;

  const { ids, username } = await facebookPageIdsForIg(supabase, s.ig_user_id);
  let posts: Parameters<typeof buildBioTiles>[0] = [];
  if (ids.length > 0) {
    const { data, error: postErr } = await supabase
      .from('facebook_scheduled_posts')
      .select('id, media_url, media_type, bio_link_url, bio_hidden, published_at, post_content')
      .eq('platform', 'instagram')
      .eq('status', 'published')
      .eq('bio_hidden', false)
      .in('facebook_page_id', ids)
      .order('published_at', { ascending: false })
      .limit(BIO_GRID_LIMIT);
    if (postErr) console.error('[bio] posts lookup', postErr.message);
    posts = data || [];
  }

  const buttons = cleanBioButtons(s.buttons);
  return {
    title: s.title || (username ? `@${username}` : 'Links'),
    username,
    buttons: buttons.ok ? buttons.value : [],
    tiles: buildBioTiles(posts, isOurPublicMediaUrl),
  };
}
