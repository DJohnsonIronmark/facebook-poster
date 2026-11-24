import type { SupabaseClient } from '@supabase/supabase-js';
import { GraphError, appPagesWithTokens } from '@/lib/inbox/server';
import { decryptToken, encryptToken } from '@/lib/social/crypto';

// Server-only: record which app pages a user's own Facebook login manages (fb_user_account_access),
// and re-check daily with their stored, encrypted login token (fb_user_platform_logins).

const loginAad = (userId: string, platform: string) => `fb-poster:user:${userId}:${platform}:login`;

/** Replace the user's Facebook page access with what this (long-lived) Facebook login manages */
export async function verifyFacebookAccess(supabase: SupabaseClient, userId: string, longToken: string): Promise<{ pages: number }> {
  const found = await appPagesWithTokens(supabase, longToken);
  const ids = Array.from(new Set(found.pages.map((p) => String(p.facebook_page_id))));
  await replaceAccess(supabase, userId, 'facebook', ids);
  const { error } = await supabase.from('fb_user_platform_logins').upsert({
    user_id: userId, platform: 'facebook', access_token_enc: encryptToken(longToken, loginAad(userId, 'facebook')),
    status: 'active', last_error: null, verified_at: new Date().toISOString(),
  }, { onConflict: 'user_id,platform' });
  if (error) throw new Error(`save login: ${error.message}`);
  return { pages: ids.length };
}

/** Swap the user's platform-verified rows for `ids` (admin-granted rows are left alone) */
async function replaceAccess(supabase: SupabaseClient, userId: string, platform: string, ids: string[]) {
  const { error: delErr } = await supabase.from('fb_user_account_access')
    .delete().eq('user_id', userId).eq('platform', platform).eq('source', 'platform');
  if (delErr) throw new Error(`clear access: ${delErr.message}`);
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase.from('fb_user_account_access').upsert(
    ids.map((account_id) => ({ user_id: userId, platform, account_id, source: 'platform', refreshed_at: now })),
    { onConflict: 'user_id,platform,account_id' },
  );
  if (error) throw new Error(`save access: ${error.message}`);
}

/**
 * Daily re-check for everyone with a stored Facebook login. If the login no longer works, the user's
 * verified access is removed (fail closed) and they are asked to verify again.
 */
export async function refreshAllFacebookAccess(supabase: SupabaseClient): Promise<{ checked: number; refreshed: number; expired: number; errors: string[] }> {
  const out = { checked: 0, refreshed: 0, expired: 0, errors: [] as string[] };
  const { data } = await supabase.from('fb_user_platform_logins').select('user_id, access_token_enc').eq('platform', 'facebook').eq('status', 'active');
  for (const row of (data || []) as { user_id: string; access_token_enc: string }[]) {
    out.checked++;
    const token = decryptToken(row.access_token_enc, loginAad(row.user_id, 'facebook'));
    try {
      if (!token) throw new GraphError('stored login could not be read', 400, 190, true);
      await verifyFacebookAccess(supabase, row.user_id, token);
      out.refreshed++;
    } catch (e) {
      const expired = e instanceof GraphError && e.tokenInvalid;
      const msg = (e instanceof Error ? e.message : 'failed').slice(0, 300);
      if (expired) {
        out.expired++;
        await replaceAccess(supabase, row.user_id, 'facebook', []);
        await supabase.from('fb_user_platform_logins').update({ status: 'needs_reauth', last_error: msg }).eq('user_id', row.user_id).eq('platform', 'facebook');
      } else if (out.errors.length < 10) {
        out.errors.push(`${row.user_id}: ${msg}`);   // keep yesterday's access on a temporary error
      }
    }
  }
  return out;
}

/** What the signed-in user's access looks like (for the banner) */
export async function accessStatus(supabase: SupabaseClient, userId: string): Promise<{
  facebook: { verified: boolean; status: string | null; verified_at: string | null; pages: number };
}> {
  const [{ data: login }, { count }] = await Promise.all([
    supabase.from('fb_user_platform_logins').select('status, verified_at').eq('user_id', userId).eq('platform', 'facebook').maybeSingle(),
    supabase.from('fb_user_account_access').select('account_id', { count: 'exact', head: true }).eq('user_id', userId).eq('platform', 'facebook'),
  ]);
  const l = login as { status: string; verified_at: string } | null;
  return { facebook: { verified: !!l && l.status === 'active', status: l?.status ?? null, verified_at: l?.verified_at ?? null, pages: count || 0 } };
}
