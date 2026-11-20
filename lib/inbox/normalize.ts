// Pure: Graph API responses → inbox items. No imports, so this runs under plain Node tests.
//
// Nothing here is stored. The inbox is read live from Meta each time; the database only keeps which
// items a person marked done (fb_inbox_state), never comment or message text.

export type InboxPlatform = 'facebook' | 'instagram';
export type InboxKind = 'comment' | 'message';

export const INBOX_REPLY_MAX = 2000;

export interface InboxItem {
  key: string;                 // `${platform}:${kind}:${external_id}`
  platform: InboxPlatform;
  kind: InboxKind;
  facebook_page_id: string;
  page_name: string;
  external_id: string;         // comment id, or conversation id for messages
  author: string;
  text: string;
  created_at: string;
  permalink: string | null;
  context_text: string | null; // the post's caption (comments) or null
  context_image: string | null;
  hidden: boolean;
  answered: boolean;           // the brand already replied (comment reply / last message is ours)
  recipient_id: string | null; // messages: who a reply goes to
  is_reply: boolean;           // comment is itself a reply under another comment
}

export const itemKey = (platform: InboxPlatform, kind: InboxKind, id: string) => `${platform}:${kind}:${id}`;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

interface Page { facebook_page_id: string; page_name: string; ig_user_id?: string | null; ig_username?: string | null }

/** /{page-id}/published_posts?fields=…,comments{…,from,parent} */
export function facebookCommentItems(page: Page, posts: unknown[]): InboxItem[] {
  const out: InboxItem[] = [];
  for (const post of posts as any[]) {
    const comments: any[] = post?.comments?.data || [];
    // Comments the page wrote are its replies: they mark their parent as answered
    const answeredIds = new Set(comments.filter((c) => String(c?.from?.id || '') === page.facebook_page_id && c?.parent?.id).map((c) => String(c.parent.id)));
    for (const c of comments) {
      if (!c?.id || String(c?.from?.id || '') === page.facebook_page_id) continue;
      out.push({
        key: itemKey('facebook', 'comment', String(c.id)),
        platform: 'facebook',
        kind: 'comment',
        facebook_page_id: page.facebook_page_id,
        page_name: page.page_name,
        external_id: String(c.id),
        author: str(c?.from?.name) || 'Facebook user',
        text: str(c.message),
        created_at: str(c.created_time),
        permalink: str(c.permalink_url) || str(post.permalink_url) || null,
        context_text: str(post.message) || null,
        context_image: str(post.full_picture) || null,
        hidden: !!c.is_hidden,
        answered: answeredIds.has(String(c.id)),
        recipient_id: null,
        is_reply: !!c?.parent?.id,
      });
    }
  }
  return out;
}

/** /{ig-user-id}/media?fields=…,comments{id,text,timestamp,username,hidden,replies{username}} */
export function instagramCommentItems(page: Page, media: unknown[]): InboxItem[] {
  const out: InboxItem[] = [];
  const own = String(page.ig_username || '').toLowerCase();
  for (const m of media as any[]) {
    for (const c of (m?.comments?.data || []) as any[]) {
      if (!c?.id) continue;
      const username = str(c.username) || str(c?.from?.username);
      if (own && username.toLowerCase() === own) continue;
      const replies: any[] = c?.replies?.data || [];
      out.push({
        key: itemKey('instagram', 'comment', String(c.id)),
        platform: 'instagram',
        kind: 'comment',
        facebook_page_id: page.facebook_page_id,
        page_name: page.page_name,
        external_id: String(c.id),
        author: username ? `@${username}` : 'Instagram user',
        text: str(c.text),
        created_at: str(c.timestamp),
        permalink: str(m.permalink) || null,
        context_text: str(m.caption) || null,
        context_image: str(m.thumbnail_url) || str(m.media_url) || null,
        hidden: !!c.hidden,
        answered: !!own && replies.some((r) => str(r.username).toLowerCase() === own),
        recipient_id: null,
        is_reply: false,
      });
    }
  }
  return out;
}

/**
 * /{page-id}/conversations?platform=messenger|instagram&fields=id,updated_time,link,participants,messages.limit(1){id,from,message,created_time}
 * `ownIds` = the page id (Messenger) or the Instagram account id (Instagram): messages from them are ours.
 */
export function conversationItems(page: Page, platform: InboxPlatform, conversations: unknown[], ownIds: string[]): InboxItem[] {
  const own = new Set(ownIds.filter(Boolean).map(String));
  const out: InboxItem[] = [];
  for (const conv of conversations as any[]) {
    if (!conv?.id) continue;
    const last = conv?.messages?.data?.[0];
    const participants: any[] = conv?.participants?.data || [];
    const other = participants.find((p) => p?.id && !own.has(String(p.id)));
    const lastFromUs = !!last && own.has(String(last?.from?.id || ''));
    out.push({
      key: itemKey(platform, 'message', String(conv.id)),
      platform,
      kind: 'message',
      facebook_page_id: page.facebook_page_id,
      page_name: page.page_name,
      external_id: String(conv.id),
      author: str(other?.name) || (str(other?.username) ? `@${str(other.username)}` : platform === 'instagram' ? 'Instagram user' : 'Facebook user'),
      text: str(last?.message) || (last ? '(attachment)' : ''),
      created_at: str(last?.created_time) || str(conv.updated_time),
      permalink: str(conv.link) ? `https://www.facebook.com${str(conv.link)}` : null,
      context_text: null,
      context_image: null,
      hidden: false,
      answered: lastFromUs,
      recipient_id: other?.id ? String(other.id) : null,
      is_reply: false,
    });
  }
  return out;
}

export type InboxFilter = 'needs_reply' | 'all' | 'done';

/** Newest first; `done` = keys a person marked done. */
export function filterInbox(items: InboxItem[], done: Set<string>, filter: InboxFilter): InboxItem[] {
  const keep = items.filter((i) => {
    const isDone = done.has(i.key);
    if (filter === 'done') return isDone;
    if (filter === 'needs_reply') return !isDone && !i.answered && !i.hidden;
    return true;
  });
  return keep.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Reply text: trimmed, non-empty, at most INBOX_REPLY_MAX characters. */
export function cleanReplyText(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return { ok: false, error: 'Reply is empty' };
  if (v.length > INBOX_REPLY_MAX) return { ok: false, error: `Reply is too long (max ${INBOX_REPLY_MAX} characters)` };
  return { ok: true, value: v };
}

/** Graph object ids: digits and underscores, or base64-ish conversation ids (t_…, aWdf…). */
export const GRAPH_ID_RE = /^[A-Za-z0-9_\-:.=]{3,200}$/;
