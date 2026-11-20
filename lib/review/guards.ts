import { createServiceClient } from '@/lib/supabase/server';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REVIEW_STATUSES = ['internal_review', 'client_review', 'client_approved'];

/**
 * Server-side enforcement of the approval workflow for the legacy direct paths
 * (/api/posts, /api/publish): true if this Facebook page belongs to a client that
 * requires approval, so it must not be scheduled/published directly.
 */
export async function pageRequiresApproval(facebookPageId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('facebook_pages')
    .select('client:fb_clients!client_id(approval_workflow_enabled)')
    .eq('facebook_page_id', facebookPageId);
  if (error) {
    // Before the migration is applied the column doesn't exist: no client is enabled yet
    if (error.code === '42703' || error.code === 'PGRST200') return false;
    throw new Error('Failed to check approval workflow');
  }
  return (data || []).some((p: any) => p.client?.approval_workflow_enabled);
}
