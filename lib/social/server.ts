import type { SupabaseClient } from '@supabase/supabase-js';
import { socialTokenKeyConfigured } from './crypto';
import { publishingSwitches } from './switches';
import { X_IMAGE_MAX_BYTES, socialMediaProblem, validateLinkedInText, validateXText } from './rules';
import { linkedinConfigured } from '@/lib/linkedin/api';
import { xConfigured } from '@/lib/x/api';
import { PUBLIC_BUCKET, isStorageRef } from '@/lib/media/storageRef';
import type { PublishConstraints } from '@/lib/media/server';

// Server-only LinkedIn / X helpers shared by the routes and the runner.

export type SocialPlatform = 'linkedin' | 'x';

export const isSocialPlatform = (p: unknown): p is SocialPlatform => p === 'linkedin' || p === 'x';

export function socialStatus() {
  const s = publishingSwitches();
  return {
    instagram: { enabled: s.instagram },
    linkedin: { enabled: s.linkedin, configured: linkedinConfigured() },
    x: { enabled: s.x, configured: xConfigured() },
    tokenKeyConfigured: socialTokenKeyConfigured(),
  };
}

// ---------------------------------------------------------------------------------------------
// Media

const PUBLIC_PREFIX = `/storage/v1/object/public/${PUBLIC_BUCKET}/`;

/**
 * True only for an https URL in OUR Supabase public media bucket. The runner downloads media
 * server-side, so anything else is refused (prevents the server fetching arbitrary hosts).
 */
export function isOurPublicMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return false;
  let u: URL;
  let ours: URL;
  try { u = new URL(url); ours = new URL(supabaseUrl); } catch { return false; }
  if (u.protocol !== 'https:' || u.host !== ours.host || u.username || u.password) return false;
  if (!u.pathname.startsWith(PUBLIC_PREFIX)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(u.pathname); } catch { return false; }
  return !decoded.includes('..');
}

/** Copy-to-public constraints for LinkedIn / X media (checked against the real file type and size). */
export function socialPublishConstraints(platform: SocialPlatform, mediaType: string | null | undefined): PublishConstraints {
  if (mediaType === 'video') return { contentTypes: ['video/mp4'] };
  return platform === 'x'
    ? { contentTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxBytes: X_IMAGE_MAX_BYTES }
    : { contentTypes: ['image/jpeg', 'image/png', 'image/gif'] };
}

/** Media rules for a LinkedIn / X row: allowed type, and stored in our buckets (storage ref or our public URL). */
export function socialMediaUrlProblem(platform: SocialPlatform, mediaType: string | null, mediaUrl: string | null): string | null {
  if (!mediaType || !mediaUrl) return null;
  if (!isStorageRef(mediaUrl) && !isOurPublicMediaUrl(mediaUrl)) {
    return `${platform === 'x' ? 'X' : 'LinkedIn'} media must be uploaded through the app (links to other sites can't be posted)`;
  }
  // storage refs carry the real extension; socialMediaProblem judges by it
  return socialMediaProblem(platform, mediaType, mediaUrl);
}

/** First text error for the platform, or null. */
export function socialTextProblem(platform: SocialPlatform, text: string, opts: { hasMedia: boolean; hasLink: boolean }): string | null {
  const issues = platform === 'x' ? validateXText(text, { hasMedia: opts.hasMedia }) : validateLinkedInText(text, opts);
  return issues.errors[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Page mapping

export interface PageSocialMapping {
  id: string;
  facebook_page_id: string;
  linkedin_org_id: string | null;
  linkedin_org_name: string | null;
  linkedin_connection_id: string | null;
  x_connection_id: string | null;
}

interface ConnectionLite {
  id: string;
  provider: string;
  status: string;
  username: string | null;
  display_name: string | null;
}

export const PAGE_SOCIAL_COLUMNS = 'id, facebook_page_id, linkedin_org_id, linkedin_org_name, linkedin_connection_id, x_connection_id';

export async function loadConnectionsLite(supabase: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, ConnectionLite>> {
  const unique = Array.from(new Set(ids.filter((v): v is string => !!v)));
  const out = new Map<string, ConnectionLite>();
  for (let i = 0; i < unique.length; i += 300) {
    const { data, error } = await supabase
      .from('fb_social_connections').select('id, provider, status, username, display_name').in('id', unique.slice(i, i + 300));
    if (error) { console.error('loadConnectionsLite', error.message); continue; }
    for (const c of (data || []) as ConnectionLite[]) out.set(c.id, c);
  }
  return out;
}

/** Why this page can't post to the platform (missing mapping / connection not active), or null. */
export function pageSocialProblem(
  platform: SocialPlatform,
  page: Pick<PageSocialMapping, 'linkedin_org_id' | 'linkedin_connection_id' | 'x_connection_id'>,
  connections: Map<string, ConnectionLite>,
): string | null {
  if (platform === 'linkedin') {
    if (!page.linkedin_org_id) return 'page has no LinkedIn company page set (Pages tab)';
    if (!page.linkedin_connection_id) return 'page has no LinkedIn account connected (Pages tab)';
    const c = connections.get(page.linkedin_connection_id);
    if (!c || c.provider !== 'linkedin') return 'LinkedIn account for this page is missing; reconnect it (Pages tab)';
    if (c.status !== 'active') return 'LinkedIn account for this page needs to be reconnected (Pages tab)';
    return null;
  }
  if (!page.x_connection_id) return 'page has no X account connected (Pages tab)';
  const c = connections.get(page.x_connection_id);
  if (!c || c.provider !== 'x') return 'X account for this page is missing; reconnect it (Pages tab)';
  if (c.status !== 'active') return 'X account for this page needs to be reconnected (Pages tab)';
  return null;
}

/**
 * Pages by Facebook page id. Several facebook_pages rows can share one Facebook page id; the row
 * that is set up for the platform wins.
 */
export async function loadPageMappings(supabase: SupabaseClient, facebookPageIds: string[]): Promise<Map<string, PageSocialMapping[]>> {
  const ids = Array.from(new Set(facebookPageIds.filter(Boolean).map(String)));
  const out = new Map<string, PageSocialMapping[]>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase.from('facebook_pages').select(PAGE_SOCIAL_COLUMNS).in('facebook_page_id', ids.slice(i, i + 300));
    if (error) { console.error('loadPageMappings', error.message); continue; }
    for (const r of (data || []) as PageSocialMapping[]) {
      const key = String(r.facebook_page_id);
      out.set(key, [...(out.get(key) || []), r]);
    }
  }
  return out;
}

export function pickMappingFor(platform: SocialPlatform, rows: PageSocialMapping[] | undefined): PageSocialMapping | null {
  if (!rows || rows.length === 0) return null;
  const ready = rows.find((r) => (platform === 'linkedin' ? !!r.linkedin_org_id && !!r.linkedin_connection_id : !!r.x_connection_id));
  return ready || rows[0];
}

// ---------------------------------------------------------------------------------------------
// Preview identities

interface WithPageAndPlatform {
  facebook_page_id: string;
  platform?: string | null;
  linkedin_org_name?: string | null;
  x_username?: string | null;
}

/**
 * Adds linkedin_org_name (LinkedIn rows) and x_username (X rows) for preview headers, matched on
 * the Facebook page id stored on the post.
 */
export async function attachSocialIdentities<T extends WithPageAndPlatform>(supabase: SupabaseClient, posts: T[]): Promise<T[]> {
  const social = posts.filter((p) => isSocialPlatform(p.platform));
  if (social.length === 0) return posts;
  const mappings = await loadPageMappings(supabase, social.map((p) => p.facebook_page_id));
  const all = Array.from(mappings.values()).flat();
  const connections = await loadConnectionsLite(supabase, all.map((m) => m.x_connection_id));
  for (const p of social) {
    const platform = p.platform === 'x' ? 'x' : 'linkedin';
    const m = pickMappingFor(platform, mappings.get(String(p.facebook_page_id)));
    if (platform === 'linkedin') p.linkedin_org_name = m?.linkedin_org_name ?? null;
    else p.x_username = (m?.x_connection_id ? connections.get(m.x_connection_id)?.username : null) ?? null;
  }
  return posts;
}
