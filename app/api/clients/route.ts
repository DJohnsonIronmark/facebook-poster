import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { validEmails } from '@/lib/review/notify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET - clients + the pages assigned to each (any signed-in user)
export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  const supabase = createServiceClient();
  const [clients, pages] = await Promise.all([
    supabase.from('fb_clients').select('*').order('name'),
    supabase.from('facebook_pages').select('id, location_name, location_number, facebook_page_id, client_id').order('location_name'),
  ]);
  if (clients.error || pages.error) {
    console.error('clients GET', clients.error || pages.error);
    return NextResponse.json({ error: 'Failed to load clients' }, { status: 500 });
  }
  return NextResponse.json({ clients: clients.data, pages: pages.data });
}

// POST - create a client (admin)
export async function POST(request: NextRequest) {
  const { error: authError } = await requireRole(['admin']);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name || name.length > 200) {
    return NextResponse.json({ error: 'Client name is required' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('fb_clients')
    .insert({
      name,
      approval_workflow_enabled: !!body.approval_workflow_enabled,
      internal_reviewer_emails: validEmails(body.internal_reviewer_emails),
      client_reviewer_emails: validEmails(body.client_reviewer_emails),
    })
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.code === '23505' ? 'A client with that name already exists' : 'Failed to create client' }, { status: 400 });
  }
  return NextResponse.json({ client: data });
}

// PATCH - update client settings and/or page assignment (admin)
export async function PATCH(request: NextRequest) {
  const { error: authError } = await requireRole(['admin']);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Valid client id required' }, { status: 400 });

  const supabase = createServiceClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim().slice(0, 200);
  if (typeof body.approval_workflow_enabled === 'boolean') updates.approval_workflow_enabled = body.approval_workflow_enabled;
  if (body.internal_reviewer_emails !== undefined) updates.internal_reviewer_emails = validEmails(body.internal_reviewer_emails);
  if (body.client_reviewer_emails !== undefined) updates.client_reviewer_emails = validEmails(body.client_reviewer_emails);

  const { data, error } = await supabase.from('fb_clients').update(updates).eq('id', id).select().single();
  if (error) return NextResponse.json({ error: 'Failed to update client' }, { status: 400 });

  // Page assignment: page_ids is the full desired set for this client
  if (Array.isArray(body.page_ids)) {
    const pageIds = body.page_ids.map(String).filter((p: string) => UUID_RE.test(p));
    const clear = await supabase.from('facebook_pages').update({ client_id: null }).eq('client_id', id);
    if (clear.error) return NextResponse.json({ error: 'Failed to update pages' }, { status: 500 });
    if (pageIds.length > 0) {
      const assign = await supabase.from('facebook_pages').update({ client_id: id }).in('id', pageIds);
      if (assign.error) return NextResponse.json({ error: 'Failed to assign pages' }, { status: 500 });
    }
  }

  return NextResponse.json({ client: data });
}
