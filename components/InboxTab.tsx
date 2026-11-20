'use client';

import { useCallback, useEffect, useState } from 'react';
import PlatformBadge from './PlatformBadge';

// Community inbox: Facebook + Instagram comments and messages for connected pages, read live from
// Meta. Replies, hides and "done" are always a person's click; nothing replies on its own.

interface ConnectedPage {
  facebook_page_id: string;
  page_name: string;
  ig_user_id: string | null;
  ig_username: string | null;
  status: string;
  scopes: string[];
  last_error: string | null;
  connected_by: string | null;
}
interface Item {
  key: string;
  platform: 'facebook' | 'instagram';
  kind: 'comment' | 'message';
  facebook_page_id: string;
  page_name: string;
  external_id: string;
  author: string;
  text: string;
  created_at: string;
  permalink: string | null;
  context_text: string | null;
  context_image: string | null;
  hidden: boolean;
  answered: boolean;
  recipient_id: string | null;
  is_reply: boolean;
  done: boolean;
}

const NEEDED_SCOPES: Record<string, string> = {
  pages_read_engagement: 'read comments',
  pages_read_user_content: 'see who commented',
  pages_manage_engagement: 'reply to and hide comments',
  pages_messaging: 'read and answer Messenger',
  instagram_manage_comments: 'Instagram comments',
  instagram_manage_messages: 'Instagram DMs',
};

const FLAGS: Record<string, { kind: 'ok' | 'error'; text: string }> = {
  inbox_off: { kind: 'error', text: 'The inbox is not turned on yet (COMMUNITY_INBOX_ENABLED).' },
  inbox_no_key: { kind: 'error', text: 'SOCIAL_TOKEN_KEY is not set, so page access can\'t be stored safely.' },
  inbox_error: { kind: 'error', text: 'Connecting pages for the inbox failed. Please try again.' },
  denied: { kind: 'error', text: 'Facebook sign-in was cancelled.' },
  state_mismatch: { kind: 'error', text: 'Facebook sign-in could not be verified. Please try again.' },
  not_configured: { kind: 'error', text: 'Facebook sign-in isn\'t set up yet (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET).' },
};

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function InboxTab({ canAct }: { canAct: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [pages, setPages] = useState<ConnectedPage[]>([]);
  const [page, setPage] = useState('all');
  const [kinds, setKinds] = useState<'comment,message' | 'comment' | 'message'>('comment,message');
  const [filter, setFilter] = useState<'needs_reply' | 'all' | 'done'>('needs_reply');
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<{ needs_reply: number; all: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [replyOpen, setReplyOpen] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showPages, setShowPages] = useState(false);

  // Messages from the Facebook connect redirect (/?tab=inbox&fb=…)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const flag = q.get('fb');
    if (!flag) return;
    if (flag === 'inbox_connected') {
      const saved = Number(q.get('saved') || 0);
      const skipped = Number(q.get('skipped') || 0);
      setMessage({
        kind: saved > 0 ? 'ok' : 'error',
        text: saved > 0
          ? `Connected ${saved} page${saved === 1 ? '' : 's'} for the inbox.${skipped ? ` ${skipped} other page${skipped === 1 ? '' : 's'} you manage aren't on the Pages tab, so they were skipped.` : ''}`
          : 'None of the pages you manage are on the Pages tab yet. Add them there first.',
      });
    } else if (FLAGS[flag]) setMessage(FLAGS[flag]);
    window.history.replaceState(null, '', '/?tab=inbox');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErrors([]);
    try {
      const q = new URLSearchParams({ page, kinds, filter });
      const res = await fetch(`/api/inbox?${q}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to load the inbox');
      setEnabled(!!data.enabled);
      setMigrationNeeded(!!data.migrationNeeded);
      setPages(data.pages || []);
      setItems(data.items || []);
      setCounts(data.counts || null);
      setErrors(data.errors || []);
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Failed to load the inbox' });
    } finally {
      setLoading(false);
    }
  }, [page, kinds, filter]);

  useEffect(() => { load(); }, [load]);

  const act = async (item: Item, action: 'reply' | 'hide' | 'unhide' | 'done' | 'undone', text?: string) => {
    setBusy(item.key);
    setMessage(null);
    try {
      const res = await fetch('/api/inbox/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebook_page_id: item.facebook_page_id, platform: item.platform, kind: item.kind,
          external_id: item.external_id, recipient_id: item.recipient_id, action, text,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (action === 'reply') { setReplyOpen(null); setReplyText(''); }
      setItems((list) => list.map((i) => (i.key !== item.key ? i : {
        ...i,
        done: action === 'reply' || action === 'done' ? true : action === 'undone' ? false : i.done,
        answered: action === 'reply' ? true : i.answered,
        hidden: action === 'hide' ? true : action === 'unhide' ? false : i.hidden,
      })));
      setMessage({ kind: 'ok', text: action === 'reply' ? 'Reply sent.' : action === 'hide' ? 'Comment hidden.' : action === 'unhide' ? 'Comment shown again.' : 'Updated.' });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (p: ConnectedPage) => {
    if (!window.confirm(`Disconnect ${p.page_name} from the inbox? Publishing is not affected.`)) return;
    const res = await fetch(`/api/inbox/pages?facebook_page_id=${encodeURIComponent(p.facebook_page_id)}`, { method: 'DELETE' });
    if (res.ok) { setPages((list) => list.filter((x) => x.facebook_page_id !== p.facebook_page_id)); if (page === p.facebook_page_id) setPage('all'); }
    else setMessage({ kind: 'error', text: 'Failed to disconnect' });
  };

  if (enabled === false) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-sm text-gray-600 space-y-2">
        <p className="font-medium text-gray-900">The inbox isn&apos;t turned on yet.</p>
        <p>It shows Facebook and Instagram comments and messages for connected pages so the team can reply, hide or mark them done in one place. An admin turns it on with <code>COMMUNITY_INBOX_ENABLED</code>.</p>
      </div>
    );
  }
  if (migrationNeeded) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
        The inbox isn&apos;t set up in the database yet (migration <code>20261119010000_community_inbox.sql</code>).
      </div>
    );
  }

  const needsReconnect = pages.filter((p) => p.status !== 'active');
  const missingScopes = (p: ConnectedPage) => Object.keys(NEEDED_SCOPES).filter((s) => !p.scopes.includes(s) && (p.ig_user_id || !s.startsWith('instagram_')));

  return (
    <div className="space-y-4">
      {message && (
        <div className={`rounded-lg p-3 text-sm ${message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>
      )}

      <div className="bg-white rounded-lg shadow p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Page</label>
          <select value={page} onChange={(e) => setPage(e.target.value)} className="border border-gray-300 rounded-md px-2 py-1.5 text-sm">
            <option value="all">All connected pages</option>
            {pages.map((p) => <option key={p.facebook_page_id} value={p.facebook_page_id}>{p.page_name}{p.status !== 'active' ? ' (reconnect)' : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Show</label>
          <select value={kinds} onChange={(e) => setKinds(e.target.value as typeof kinds)} className="border border-gray-300 rounded-md px-2 py-1.5 text-sm">
            <option value="comment,message">Comments + messages</option>
            <option value="comment">Comments</option>
            <option value="message">Messages</option>
          </select>
        </div>
        <div className="flex rounded-md border border-gray-300 overflow-hidden text-sm">
          {(['needs_reply', 'all', 'done'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 ${filter === f ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
              {f === 'needs_reply' ? `Needs reply${counts && filter === 'needs_reply' ? ` (${counts.needs_reply})` : ''}` : f === 'all' ? 'All' : 'Done'}
            </button>
          ))}
        </div>
        <button onClick={load} disabled={loading} className="text-sm px-3 py-1.5 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <button onClick={() => setShowPages(!showPages)} className="text-gray-600 hover:text-gray-900">
            {pages.length} connected page{pages.length === 1 ? '' : 's'}{needsReconnect.length ? ` · ${needsReconnect.length} need reconnecting` : ''}
          </button>
          {canAct && (
            <a href="/api/facebook/oauth/start?purpose=inbox" className="bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700">Connect pages</a>
          )}
        </div>
      </div>

      {showPages && (
        <div className="bg-white rounded-lg shadow p-4 text-sm">
          <p className="text-xs text-gray-500 mb-2">
            &quot;Connect pages&quot; signs in with Facebook and connects every page you manage that is already on the Pages tab. Reconnect any time to refresh access.
          </p>
          {pages.length === 0 ? <p className="text-gray-500">No pages connected yet.</p> : (
            <ul className="divide-y divide-gray-100">
              {pages.map((p) => {
                const missing = missingScopes(p);
                return (
                  <li key={p.facebook_page_id} className="py-2 flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-gray-900">{p.page_name}{p.ig_username ? <span className="text-gray-500 font-normal"> · @{p.ig_username}</span> : <span className="text-gray-400 font-normal"> · no Instagram linked</span>}</p>
                      {p.status !== 'active' && <p className="text-xs text-red-700">Needs reconnecting{p.last_error ? `: ${p.last_error}` : ''}</p>}
                      {missing.length > 0 && <p className="text-xs text-amber-700">Missing permission to {missing.map((s) => NEEDED_SCOPES[s]).join(', ')}</p>}
                      {p.connected_by && <p className="text-xs text-gray-400">Connected by {p.connected_by}</p>}
                    </div>
                    {canAct && <button onClick={() => disconnect(p)} className="text-xs text-gray-500 hover:text-red-600">Disconnect</button>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 space-y-1">
          {errors.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      )}

      {pages.length === 0 && !loading ? (
        <div className="bg-white rounded-lg shadow p-6 text-sm text-gray-600">
          No pages are connected for the inbox yet.{canAct ? ' Use "Connect pages" above.' : ' Ask an admin or manager to connect them.'}
        </div>
      ) : items.length === 0 && !loading ? (
        <div className="bg-white rounded-lg shadow p-6 text-sm text-gray-600">
          {filter === 'needs_reply' ? 'Nothing needs a reply. 🎉' : 'Nothing here.'} <span className="text-gray-400">(Comments from the last 14 days and recent conversations.)</span>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.key} className={`bg-white rounded-lg shadow p-4 ${item.hidden ? 'opacity-70' : ''}`}>
              <div className="flex gap-3">
                {item.context_image && <img src={item.context_image} alt="" className="w-14 h-14 object-cover rounded flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-1">
                    <PlatformBadge platform={item.platform} />
                    <span className="font-medium text-gray-700">{item.kind === 'message' ? 'Message' : item.is_reply ? 'Reply' : 'Comment'}</span>
                    <span>· {item.page_name}</span>
                    <span>· {ago(item.created_at)}</span>
                    {item.answered && <span className="text-green-700">· answered</span>}
                    {item.hidden && <span className="text-gray-700">· hidden</span>}
                    {item.done && <span className="text-blue-700">· done</span>}
                  </div>
                  <p className="text-sm"><span className="font-medium text-gray-900">{item.author}</span> <span className="text-gray-800 whitespace-pre-wrap break-words">{item.text}</span></p>
                  {item.context_text && <p className="text-xs text-gray-400 mt-1 line-clamp-1">On: {item.context_text}</p>}

                  <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
                    {canAct && <button onClick={() => { setReplyOpen(replyOpen === item.key ? null : item.key); setReplyText(''); }} className="text-blue-600 hover:text-blue-800">Reply</button>}
                    {canAct && item.kind === 'comment' && (
                      <button disabled={busy === item.key} onClick={() => act(item, item.hidden ? 'unhide' : 'hide')} className="text-gray-600 hover:text-gray-900">{item.hidden ? 'Unhide' : 'Hide'}</button>
                    )}
                    {canAct && (
                      <button disabled={busy === item.key} onClick={() => act(item, item.done ? 'undone' : 'done')} className="text-gray-600 hover:text-gray-900">{item.done ? 'Move back to Needs reply' : 'Mark done'}</button>
                    )}
                    {item.permalink && <a href={item.permalink} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-800">Open on {item.platform === 'instagram' ? 'Instagram' : 'Facebook'} ↗</a>}
                  </div>

                  {replyOpen === item.key && (
                    <div className="mt-2 space-y-2">
                      <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={3} maxLength={2000}
                        placeholder={item.kind === 'message' ? `Reply to ${item.author} as ${item.page_name}…` : `Reply publicly as ${item.page_name}…`}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm" />
                      <div className="flex items-center gap-2">
                        <button disabled={busy === item.key || !replyText.trim()} onClick={() => act(item, 'reply', replyText)} className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-md hover:bg-blue-700 disabled:opacity-50">
                          {busy === item.key ? 'Sending…' : 'Send'}
                        </button>
                        <span className="text-xs text-gray-500">
                          {item.kind === 'message' ? 'Sent as a private message. Meta only allows replies within 24 hours of their last message.' : 'Posted publicly under the comment.'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
