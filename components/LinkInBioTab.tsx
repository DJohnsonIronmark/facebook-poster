'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Team screen for Instagram link in bio pages: per Instagram account, turn the public page on,
// set its address, title and buttons, and set the link each post's grid tile opens.

interface BioButton { label: string; url: string }
interface BioSettings { slug: string; title: string | null; buttons: BioButton[]; enabled: boolean; updated_by: string | null; updated_at: string }
interface Account { ig_user_id: string; ig_username: string | null; page_names: string[]; settings: BioSettings | null; suggested_slug: string | null }
interface IgPost {
  id: string;
  franchise_name: string;
  status: string;
  scheduled_for: string | null;
  published_at: string | null;
  post_content: string;
  media_url: string | null;
  media_type: string | null;
  bio_link_url: string | null;
  bio_hidden: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  published: 'Published', pending: 'Scheduled', publishing: 'Publishing', internal_review: 'In internal review',
  client_review: 'With client', client_approved: 'Client approved',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export default function LinkInBioTab({ canEdit }: { canEdit: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [selected, setSelected] = useState('');
  const [form, setForm] = useState({ slug: '', title: '', enabled: false, buttons: [] as BioButton[] });
  const [posts, setPosts] = useState<IgPost[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState('');

  useEffect(() => { setOrigin(window.location.origin); }, []);

  const account = useMemo(() => accounts.find((a) => a.ig_user_id === selected) || null, [accounts, selected]);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bio');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setAccounts(data.accounts || []);
      setMigrationNeeded(!!data.migrationNeeded);
      setSelected((cur) => cur || data.accounts?.[0]?.ig_user_id || '');
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Failed to load' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  useEffect(() => {
    if (!account) return;
    const s = account.settings;
    setForm({
      slug: s?.slug || account.suggested_slug || '',
      title: s?.title || '',
      enabled: !!s?.enabled,
      buttons: s?.buttons?.length ? s.buttons : [],
    });
  }, [account]);

  const loadPosts = useCallback(async (igUserId: string) => {
    setPosts([]);
    const res = await fetch(`/api/bio/posts?ig_user_id=${encodeURIComponent(igUserId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMessage({ kind: 'error', text: data.error || 'Failed to load posts' }); return; }
    setPosts(data.posts || []);
    setLinks(Object.fromEntries((data.posts || []).map((p: IgPost) => [p.id, p.bio_link_url || ''])));
  }, []);

  useEffect(() => { if (selected && !migrationNeeded) loadPosts(selected); }, [selected, migrationNeeded, loadPosts]);

  const saveSettings = async () => {
    if (!account) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/bio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ig_user_id: account.ig_user_id, ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setAccounts((list) => list.map((a) => (a.ig_user_id === account.ig_user_id ? { ...a, settings: data.settings } : a)));
      setMessage({ kind: 'ok', text: form.enabled ? 'Saved. The page is live.' : 'Saved. The page is off until you turn it on.' });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const patchPost = async (id: string, patch: { bio_link_url?: string; bio_hidden?: boolean }) => {
    setMessage(null);
    const res = await fetch('/api/bio/posts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMessage({ kind: 'error', text: data.error || 'Failed to save' }); return; }
    setPosts((list) => list.map((p) => (p.id === id ? { ...p, ...data.post } : p)));
    setLinks((m) => ({ ...m, [id]: data.post.bio_link_url || '' }));
    setMessage({ kind: 'ok', text: 'Saved.' });
  };

  const setButton = (i: number, key: keyof BioButton, value: string) =>
    setForm((f) => ({ ...f, buttons: f.buttons.map((b, j) => (j === i ? { ...b, [key]: value } : b)) }));

  const saved = account?.settings;
  const publicUrl = saved ? `${origin}/l/${saved.slug}` : '';

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  if (migrationNeeded) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
        Link in bio isn&apos;t set up in the database yet (migration <code>20261119000000_link_in_bio.sql</code>).
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-sm text-gray-600">
        No Instagram accounts yet. Add an Instagram account ID to a page on the Pages tab first.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {message && (
        <div className={`rounded-lg p-3 text-sm ${message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>
      )}

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Instagram account</label>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm">
            {accounts.map((a) => (
              <option key={a.ig_user_id} value={a.ig_user_id}>
                {a.ig_username ? `@${a.ig_username}` : a.ig_user_id} · {a.page_names.slice(0, 2).join(', ')}{a.page_names.length > 2 ? ` +${a.page_names.length - 2}` : ''}
                {a.settings?.enabled ? ' · live' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Page address</label>
            <div className="flex items-center text-sm">
              <span className="text-gray-500 mr-1">{origin}/l/</span>
              <input value={form.slug} disabled={!canEdit} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                className="flex-1 border border-gray-300 rounded-md px-2 py-1.5" placeholder="brandname" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title (optional)</label>
            <input value={form.title} disabled={!canEdit} onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm" placeholder={account?.ig_username ? `@${account.ig_username}` : 'Brand name'} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700">Buttons at the top (website, book, call…)</label>
            {canEdit && form.buttons.length < 6 && (
              <button type="button" onClick={() => setForm({ ...form, buttons: [...form.buttons, { label: '', url: '' }] })} className="text-sm text-blue-600 hover:text-blue-800">+ Add button</button>
            )}
          </div>
          {form.buttons.length === 0 && <p className="text-xs text-gray-500">No buttons. The page shows just the grid.</p>}
          <div className="space-y-2">
            {form.buttons.map((b, i) => (
              <div key={i} className="flex gap-2">
                <input value={b.label} disabled={!canEdit} onChange={(e) => setButton(i, 'label', e.target.value)} placeholder="Label" className="w-1/3 border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
                <input value={b.url} disabled={!canEdit} onChange={(e) => setButton(i, 'url', e.target.value)} placeholder="https://…" className="flex-1 border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
                {canEdit && (
                  <button type="button" onClick={() => setForm({ ...form, buttons: form.buttons.filter((_, j) => j !== i) })} className="text-sm text-gray-500 hover:text-red-600 px-2" aria-label="Remove button">✕</button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-gray-100">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} disabled={!canEdit} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Page is live
          </label>
          {canEdit && (
            <button onClick={saveSettings} disabled={saving} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {saved && (
            <span className="text-sm text-gray-600">
              {saved.enabled ? (
                <>
                  Live at <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">{publicUrl}</a>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(publicUrl)} className="ml-2 text-xs text-gray-500 hover:text-gray-800">Copy</button>
                  <span className="block text-xs text-gray-500">Paste this link into the Instagram profile&apos;s bio / website field.</span>
                </>
              ) : 'Saved but not live.'}
            </span>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-sm font-medium text-gray-900 mb-1">Post links</h3>
        <p className="text-xs text-gray-500 mb-4">
          Published posts appear on the page newest first. Set where each tile goes; posts still in review or scheduled can get their link now.
          The CSV <code>bio_link</code> column (or <code>link_url</code>) fills this in on upload.
        </p>
        {posts.length === 0 ? (
          <p className="text-sm text-gray-500">No Instagram posts for this account yet.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {posts.map((p) => (
              <div key={p.id} className={`flex gap-3 border rounded-lg p-3 ${p.bio_hidden ? 'opacity-60' : ''}`}>
                <div className="w-20 h-24 flex-shrink-0 bg-gray-100 rounded overflow-hidden">
                  {p.media_url && (p.media_type === 'video'
                    ? <video src={`${p.media_url}#t=0.1`} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                    : <img src={p.media_url} alt="" className="w-full h-full object-cover" />)}
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="text-xs text-gray-500">
                    {STATUS_LABEL[p.status] || p.status} · {fmt(p.published_at || p.scheduled_for)}
                    {p.bio_hidden && ' · hidden from page'}
                  </p>
                  <p className="text-sm text-gray-800 line-clamp-2">{p.post_content}</p>
                  <div className="flex gap-1">
                    <input value={links[p.id] ?? ''} disabled={!canEdit} onChange={(e) => setLinks({ ...links, [p.id]: e.target.value })}
                      placeholder="https://… (where this tile goes)" className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs" />
                    {canEdit && (links[p.id] ?? '') !== (p.bio_link_url || '') && (
                      <button onClick={() => patchPost(p.id, { bio_link_url: links[p.id] })} className="text-xs bg-blue-600 text-white rounded px-2">Save</button>
                    )}
                  </div>
                  {canEdit && (
                    <button onClick={() => patchPost(p.id, { bio_hidden: !p.bio_hidden })} className="text-xs text-gray-500 hover:text-gray-800">
                      {p.bio_hidden ? 'Show on page' : 'Hide from page'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
