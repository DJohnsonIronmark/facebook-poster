import type { SupabaseClient } from '@supabase/supabase-js';
import { GraphError, graph, markNeedsReauth, pageToken } from '@/lib/inbox/server';
import { isSwitchOn } from '@/lib/instagram/rules';

// Server-only: delete a published Facebook or Instagram post from the platform itself (not just the
// app's record), with the page's stored token (fb_page_tokens, saved by "Connect pages").
//
// Meta rules this relies on:
//  * Facebook only lets the app that published a post delete it through the API. n8n and the app
//    publish with the same Meta app, so posts published from here qualify; posts made in Business
//    Suite, the Facebook app or another scheduler do not.
//  * Facebook needs pages_manage_posts; Instagram needs instagram_manage_contents (regular posts,
//    Reels and whole carousels; not single carousel items).
//
// Env: PLATFORM_DELETE_ENABLED (default off). While on, "Connect pages" also asks for the delete
// permissions; pages must be reconnected once to get them.

export const FB_DELETE_PERMISSION = 'pages_manage_posts';
export const IG_DELETE_PERMISSION = 'instagram_manage_contents';
/** Added to "Connect pages" while deleting is switched on */
export const DELETE_SCOPES = ['pages_show_list', 'business_management', 'instagram_basic', FB_DELETE_PERMISSION, IG_DELETE_PERMISSION];

export function platformDeleteEnabled(): boolean {
  return isSwitchOn(process.env.PLATFORM_DELETE_ENABLED);
}

// Facebook post ids are "<page>_<post>" or plain digits; Instagram media ids are digits
const PLATFORM_ID_RE = /^[0-9]{1,40}(_[0-9]{1,40})?$/;

export interface DeletablePost {
  platform: string | null;
  facebook_page_id: string;
  facebook_post_id: string | null;
}

export type PlatformDeleteResult =
  | { ok: true; alreadyGone: boolean }
  | { ok: false; status: number; message: string };

export async function deleteFromPlatform(supabase: SupabaseClient, post: DeletablePost): Promise<PlatformDeleteResult> {
  const platform = post.platform || 'facebook';
  if (platform !== 'facebook' && platform !== 'instagram') {
    return { ok: false, status: 422, message: `Deleting from ${platform === 'linkedin' ? 'LinkedIn' : 'X'} isn't supported yet; delete it there directly.` };
  }
  const label = platform === 'facebook' ? 'Facebook' : 'Instagram';
  if (!platformDeleteEnabled()) {
    return { ok: false, status: 409, message: `Deleting from ${label} is switched off (PLATFORM_DELETE_ENABLED).` };
  }
  const id = String(post.facebook_post_id || '').trim();
  if (!PLATFORM_ID_RE.test(id)) {
    return { ok: false, status: 409, message: `No ${label} post ID is saved for this post, so it can't be deleted from here. Delete it on ${label}.` };
  }

  const conn = await pageToken(supabase, String(post.facebook_page_id));
  if (!conn) {
    return { ok: false, status: 409, message: 'This page isn\'t connected (or its connection expired). Use Inbox → "Connect pages", then try again.' };
  }
  const need = platform === 'facebook' ? FB_DELETE_PERMISSION : IG_DELETE_PERMISSION;
  if (!conn.page.scopes.includes(need)) {
    return { ok: false, status: 409, message: `The page's connection doesn't allow deleting yet (missing ${need}). Use Inbox → "Connect pages" once to reconnect it, then try again.` };
  }

  try {
    // Graph accepts method=delete on a POST
    await graph(id, conn.token, { method: 'delete' }, 'POST');
    return { ok: true, alreadyGone: false };
  } catch (e) {
    if (e instanceof GraphError) {
      if (e.tokenInvalid) await markNeedsReauth(supabase, String(post.facebook_page_id), e.message);
      // Already deleted on the platform (e.g. by hand in Business Suite): treat as done
      if (e.code === 100 && /does not exist|cannot be loaded|unsupported (get|delete) request/i.test(e.message)) {
        return { ok: true, alreadyGone: true };
      }
      return { ok: false, status: 502, message: `${label} didn't delete it: ${e.message}` };
    }
    return { ok: false, status: 502, message: `${label} didn't answer; try again.` };
  }
}
