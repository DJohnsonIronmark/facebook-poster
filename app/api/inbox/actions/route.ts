import { NextRequest, NextResponse } from 'next/server';
import { canSeePage, noPageAccess, requireScopedUser } from '@/lib/access';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { GraphError, inboxEnabled, performInboxAction, type InboxAction } from '@/lib/inbox/server';
import { GRAPH_ID_RE, cleanReplyText, itemKey, type InboxKind, type InboxPlatform } from '@/lib/inbox/normalize';

// POST /api/inbox/actions (admin/manager)
//   { facebook_page_id, platform, kind, external_id, action: 'reply' | 'hide' | 'unhide' | 'done' | 'undone',
//     text? (reply), recipient_id? (message reply) }
// A reply is only ever sent by a person pressing Send; nothing here replies on its own.

const FB_PAGE_ID_RE = /^\d{5,25}$/;
const ACTIONS = ['reply', 'hide', 'unhide', 'done', 'undone'] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;
  if (!inboxEnabled()) return NextResponse.json({ error: 'The inbox is not turned on' }, { status: 409 });

  const body = await request.json().catch(() => ({}));
  const pageId = String(body?.facebook_page_id ?? '');
  const platform = body?.platform as InboxPlatform;
  const kind = body?.kind as InboxKind;
  const externalId = String(body?.external_id ?? '');
  const action = body?.action as Action;

  if (!FB_PAGE_ID_RE.test(pageId)) return NextResponse.json({ error: 'Invalid page' }, { status: 400 });
  {
    const scoped = await requireScopedUser(['admin', 'manager']);
    if (scoped.error) return scoped.error;
    if (!canSeePage(scoped.scope, pageId)) return noPageAccess();
  }
  if (platform !== 'facebook' && platform !== 'instagram') return NextResponse.json({ error: 'Invalid platform' }, { status: 400 });
  if (kind !== 'comment' && kind !== 'message') return NextResponse.json({ error: 'Invalid item type' }, { status: 400 });
  if (!GRAPH_ID_RE.test(externalId)) return NextResponse.json({ error: 'Invalid item' }, { status: 400 });
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  const supabase = createServiceClient();
  const key = itemKey(platform, kind, externalId);

  if (action === 'undone') {
    const { error } = await supabase.from('fb_inbox_state').delete().eq('item_key', key);
    if (error) return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (action !== 'done') {
    let meta: InboxAction;
    if (action === 'reply') {
      const text = cleanReplyText(body?.text);
      if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 });
      if (kind === 'message') {
        const recipient = String(body?.recipient_id ?? '');
        if (!GRAPH_ID_RE.test(recipient)) return NextResponse.json({ error: 'Missing recipient' }, { status: 400 });
        meta = { action: 'reply', platform, kind: 'message', external_id: externalId, recipient_id: recipient, text: text.value };
      } else {
        meta = { action: 'reply', platform, kind: 'comment', external_id: externalId, text: text.value };
      }
    } else {
      if (kind !== 'comment') return NextResponse.json({ error: 'Only comments can be hidden' }, { status: 400 });
      meta = { action, platform, kind: 'comment', external_id: externalId };
    }
    try {
      await performInboxAction(supabase, pageId, meta);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      console.error('[inbox] action failed', action, platform, kind, msg);
      const status = err instanceof GraphError ? (err.tokenInvalid ? 401 : 502) : 400;
      return NextResponse.json({ error: `Meta said: ${msg}` }, { status });
    }
  }

  // Replying (or marking done) takes the item out of "Needs reply". Hiding just records the action.
  if (action === 'reply' || action === 'done') {
    const { error } = await supabase.from('fb_inbox_state').upsert({
      item_key: key,
      facebook_page_id: pageId,
      status: 'done',
      last_action: action === 'reply' ? 'replied' : 'done',
      handled_by: user.email,
      handled_at: new Date().toISOString(),
    }, { onConflict: 'item_key' });
    if (error) console.error('[inbox] state save failed', error.message);
  }
  return NextResponse.json({ success: true });
}
