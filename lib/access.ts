import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserRole, requireAuth, type UserRole } from '@/lib/auth';
import { isSwitchOn } from '@/lib/instagram/rules';
import { createServiceClient } from '@/lib/supabase/server';

// Server-only: which social accounts a signed-in user may see, from their own platform logins
// (fb_user_account_access). Admins see everything. While PAGE_ACCESS_ENFORCED is off, everyone
// sees everything (people verify their access first; then the switch goes on).
//
// Today access is checked per Facebook page (facebook_page_id), which also covers the page's
// Instagram account and any LinkedIn / X posts filed under it. LinkedIn / X logins will add their
// own per-platform checks (see the migration notes).

export function pageAccessEnforced(): boolean {
  return isSwitchOn(process.env.PAGE_ACCESS_ENFORCED);
}

export interface AccessScope {
  /** true = no filtering (admin, or enforcement off) */
  all: boolean;
  facebookPages: Set<string>;
}

const ALL: AccessScope = { all: true, facebookPages: new Set() };

export async function accessScope(supabase: SupabaseClient, userId: string, role: UserRole | null): Promise<AccessScope> {
  if (role === 'admin' || !pageAccessEnforced()) return ALL;
  const { data } = await supabase.from('fb_user_account_access').select('platform, account_id').eq('user_id', userId);
  const facebookPages = new Set<string>();
  for (const r of (data || []) as { platform: string; account_id: string }[]) {
    if (r.platform === 'facebook') facebookPages.add(String(r.account_id));
  }
  return { all: false, facebookPages };
}

export function canSeePage(scope: AccessScope, facebookPageId: string | null | undefined): boolean {
  return scope.all || (!!facebookPageId && scope.facebookPages.has(String(facebookPageId)));
}

export function filterByPage<T extends { facebook_page_id?: string | null }>(scope: AccessScope, rows: T[]): T[] {
  return scope.all ? rows : rows.filter((r) => canSeePage(scope, r.facebook_page_id));
}

/** The page ids the user may see out of `ids` (all of them when unrestricted) */
export function visiblePageIds(scope: AccessScope, ids: string[]): string[] {
  return scope.all ? ids : ids.filter((id) => scope.facebookPages.has(String(id)));
}

export function noPageAccess(): NextResponse {
  return NextResponse.json(
    { error: "You don't have access to this page on Facebook. Ask an admin, or use \"Verify my page access\" if you were just added." },
    { status: 403 },
  );
}

/**
 * requireAuth / requireRole plus the user's access scope, for routes that return or change page data.
 * `allowed` = roles permitted at all (omit for any signed-in user).
 */
export async function requireScopedUser(allowed?: UserRole[]): Promise<
  | { user: { id: string; email: string; role: UserRole | null }; scope: AccessScope; supabase: SupabaseClient; error: null }
  | { user: null; scope: null; supabase: null; error: Response }
> {
  const auth = await requireAuth();
  if (auth.error || !auth.user) return { user: null, scope: null, supabase: null, error: auth.error! };
  const role = await getUserRole(auth.user.id);
  if (allowed && (!role || !allowed.includes(role))) {
    return { user: null, scope: null, supabase: null, error: NextResponse.json({ error: 'Forbidden: insufficient role' }, { status: 403 }) };
  }
  const supabase = createServiceClient();
  const scope = await accessScope(supabase, auth.user.id, role);
  return { user: { ...auth.user, role }, scope, supabase, error: null };
}

/** facebook_page_id for a facebook_pages row id (uuid), or null */
export async function pageIdForRow(supabase: SupabaseClient, rowId: string): Promise<string | null> {
  const { data } = await supabase.from('facebook_pages').select('facebook_page_id').eq('id', rowId).maybeSingle();
  return data ? String((data as { facebook_page_id: string }).facebook_page_id) : null;
}

/** Facebook page ids linked to an Instagram account */
export async function pageIdsForInstagram(supabase: SupabaseClient, igUserId: string): Promise<string[]> {
  const { data } = await supabase.from('facebook_pages').select('facebook_page_id').eq('ig_user_id', igUserId);
  return ((data || []) as { facebook_page_id: string }[]).map((r) => String(r.facebook_page_id));
}
