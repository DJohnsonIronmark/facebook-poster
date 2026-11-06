import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { BATCH_PUBLIC_COLUMNS, POST_REVIEW_COLUMNS } from '@/lib/review/types';

const OPEN_STATUSES = ['internal_review', 'client_review', 'client_approved'];

// GET - review batches with client + posts. ?include=all to also return scheduled/cancelled (last 60 days)
export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const includeAll = new URL(request.url).searchParams.get('include') === 'all';
  const supabase = createServiceClient();

  let query = supabase
    .from('fb_review_batches')
    .select(`${BATCH_PUBLIC_COLUMNS}, client:fb_clients(id, name, approval_workflow_enabled, internal_reviewer_emails, client_reviewer_emails), posts:facebook_scheduled_posts(${POST_REVIEW_COLUMNS})`)
    .order('created_at', { ascending: false })
    .limit(200);
  query = includeAll
    ? query.gte('created_at', new Date(Date.now() - 60 * 86400000).toISOString())
    : query.in('status', OPEN_STATUSES);

  const { data, error } = await query;
  if (error) {
    console.error('batches GET', error);
    return NextResponse.json({ error: 'Failed to load review batches' }, { status: 500 });
  }
  // Attach review history: original draft text + whether the client changed the copy
  const postIds = (data || []).flatMap((b: any) => (b.posts || []).map((p: any) => p.id));
  const history = new Map<string, { original: string | null; clientEdited: boolean }>();
  for (let i = 0; i < postIds.length; i += 300) {
    const { data: revs } = await supabase
      .from('fb_post_revisions')
      .select('post_id, stage, post_content, created_at')
      .in('post_id', postIds.slice(i, i + 300))
      .in('stage', ['draft', 'client_edit'])
      .order('created_at', { ascending: true });
    for (const r of revs || []) {
      const h = history.get(r.post_id) || { original: null, clientEdited: false };
      if (r.stage === 'draft' && h.original === null) h.original = r.post_content;
      if (r.stage === 'client_edit') h.clientEdited = true;
      history.set(r.post_id, h);
    }
  }

  for (const b of data || []) {
    b.posts?.sort((a: any, c: any) =>
      (a.scheduled_for || '').localeCompare(c.scheduled_for || '') || a.franchise_name.localeCompare(c.franchise_name));
    for (const p of b.posts || []) {
      const h = history.get(p.id);
      p.original_content = h?.original ?? null;
      p.client_edited = h?.clientEdited ?? false;
    }
  }
  return NextResponse.json({ batches: data });
}
