'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface PageRow {
  id: string;
  location_name: string;
  location_number: string | null;
  facebook_page_id: string;
  city: string | null;
  base_url: string | null;
  phone: string | null;
  client_id: string | null;
}
interface ClientOpt { id: string; name: string }
interface FbPage { id: string; name: string; picture: string | null; location: string | null; already_added: boolean }

const FB_FLAG_MESSAGES: Record<string, { kind: 'ok' | 'error'; text: string }> = {
  connected: { kind: 'ok', text: 'Connected to Facebook. Pick the pages to import below.' },
  denied: { kind: 'error', text: 'Facebook sign-in was cancelled.' },
  state_mismatch: { kind: 'error', text: 'Facebook sign-in could not be verified. Please try again.' },
  not_configured: { kind: 'error', text: 'Facebook sign-in isn\'t set up yet (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET). Use "Add manually" for now.' },
  unauthorized: { kind: 'error', text: 'Only admins and managers can add pages.' },
  error: { kind: 'error', text: 'Facebook sign-in failed. Please try again.' },
};

const EMPTY = { location_name: '', facebook_page_id: '', location_number: '', city: '', base_url: '', phone: '' };

export default function PagesManager({ onPagesChanged }: { onPagesChanged: () => void }) {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [mode, setMode] = useState<'none' | 'manual' | 'facebook'>('none');
  const [form, setForm] = useState({ ...EMPTY });
  const [clientId, setClientId] = useState('');
  const [saving, setSaving] = useState(false);
  const [fbPages, setFbPages] = useState<FbPage[]>([]);
  const [fbSelected, setFbSelected] = useState<string[]>([]);
  const [fbLoading, setFbLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([fetch('/api/pages', { cache: 'no-store' }), fetch('/api/clients', { cache: 'no-store' })]);
    if (p.ok) setPages((await p.json()).pages || []);
    if (c.ok) setClients(((await c.json()).clients || []).map((x: any) => ({ id: x.id, name: x.name })));
  }, []);

  const loadFacebookPages = useCallback(async () => {
    setFbLoading(true);
    try {
      const res = await fetch('/api/facebook/pages', { cache: 'no-store' });
      const data = await res.json();
      if (data.error) setMessage({ kind: 'error', text: data.error });
      setFbPages(data.connected ? data.pages : []);
      if (data.connected) setMode('facebook');
    } finally {
      setFbLoading(false);
    }
  }, []);

  // Coming back from Facebook Login: /?tab=pages&fb=<flag>
  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('fb');
    if (flag) {
      setMessage(FB_FLAG_MESSAGES[flag] || null);
      params.delete('fb');
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
      if (flag === 'connected') loadFacebookPages();
    }
  }, [load, loadFacebookPages]);

  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const visible = pages.filter((p) => {
    const q = filter.trim().toLowerCase();
    return !q || [p.location_name, p.location_number, p.facebook_page_id, p.city].some((v) => (v || '').toLowerCase().includes(q));
  });

  const submit = async (payload: Record<string, unknown>[], source: 'manual' | 'facebook') => {
    setSaving(true);
    setMessage(null);
    const res = await fetch('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: payload, client_id: clientId || null, source }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setMessage({ kind: 'error', text: data.error || 'Failed to add pages' }); return false; }
    const problems: string[] = data.problems || [];
    setMessage({
      kind: problems.length && !data.added?.length ? 'error' : 'ok',
      text: `Added ${data.added?.length || 0} page(s).${problems.length ? ` Skipped: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '…' : ''}` : ''}`,
    });
    await load();
    onPagesChanged();
    return (data.added?.length || 0) > 0;
  };

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await submit([form], 'manual')) setForm({ ...EMPTY });
  };

  const importFacebook = async () => {
    const chosen = fbPages.filter((p) => fbSelected.includes(p.id));
    const ok = await submit(chosen.map((p) => ({ facebook_page_id: p.id, location_name: p.name })), 'facebook');
    if (ok) { setFbPages([]); setFbSelected([]); setMode('none'); }
  };

  const disconnect = async () => {
    await fetch('/api/facebook/pages', { method: 'DELETE' });
    setFbPages([]); setFbSelected([]); setMode('none');
  };

  const importable = fbPages.filter((p) => !p.already_added);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h2 className="text-lg font-semibold text-gray-900">Facebook pages ({pages.length})</h2>
            <p className="text-sm text-gray-500">Pages you can post to. Add them by signing in with Facebook or by entering the page name and ID.</p>
          </div>
          <a href="/api/facebook/oauth/start"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1877f2] text-white text-sm font-semibold hover:bg-[#166fe5]">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            Connect with Facebook
          </a>
          <button onClick={() => setMode(mode === 'manual' ? 'none' : 'manual')}
            className="px-4 py-2 rounded-lg bg-gray-100 text-gray-800 text-sm font-medium hover:bg-gray-200">
            {mode === 'manual' ? 'Close' : 'Add manually'}
          </button>
        </div>

        <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded px-3 py-2">
          Publishing uses the n8n Facebook connection, not this sign-in. A new page only publishes if that connection&apos;s
          Facebook account also has access to the page (e.g. through Business Manager).
        </p>

        {message && (
          <div className={`text-sm rounded px-3 py-2 ${message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`} role="status">
            {message.text}
          </div>
        )}

        {(mode === 'manual' || mode === 'facebook') && clients.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Assign to client (optional)
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5">
              <option value="">— none —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}

        {mode === 'manual' && (
          <form onSubmit={addManual} className="grid gap-3 sm:grid-cols-2">
            <Field label="Page name *" value={form.location_name} onChange={(v) => setForm({ ...form, location_name: v })} placeholder="Home Instead Augusta, GA" required />
            <Field label="Facebook page ID *" value={form.facebook_page_id} onChange={(v) => setForm({ ...form, facebook_page_id: v.replace(/\D/g, '') })}
              placeholder="123456789012345" required hint="Numeric ID: Facebook page → About → Page transparency, or Meta Business Suite settings." />
            <Field label="Location number" value={form.location_number} onChange={(v) => setForm({ ...form, location_number: v })} placeholder="788" />
            <Field label="City ({{CITY}})" value={form.city} onChange={(v) => setForm({ ...form, city: v })} placeholder="Augusta" />
            <Field label="Website ({{BASEURL}})" value={form.base_url} onChange={(v) => setForm({ ...form, base_url: v })} placeholder="https://www.homeinstead.com/location/788" />
            <Field label="Phone ({{PHONE}})" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="(706) 555-0100" />
            <div className="sm:col-span-2 flex justify-end">
              <button type="submit" disabled={saving || !form.location_name.trim() || !form.facebook_page_id}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50">
                {saving ? 'Adding…' : 'Add page'}
              </button>
            </div>
          </form>
        )}

        {mode === 'facebook' && (
          <div className="border rounded-lg">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b bg-gray-50 text-sm">
              <span className="font-medium text-gray-800 mr-auto">
                {fbLoading ? 'Loading your Facebook pages…' : `${fbPages.length} page(s) on your Facebook account · ${importable.length} not yet added`}
              </span>
              {importable.length > 0 && (
                <button onClick={() => setFbSelected(fbSelected.length === importable.length ? [] : importable.map((p) => p.id))}
                  className="text-blue-600 hover:underline">
                  {fbSelected.length === importable.length ? 'Select none' : 'Select all'}
                </button>
              )}
              <button onClick={disconnect} className="text-gray-500 hover:underline">Disconnect</button>
            </div>
            <ul className="max-h-80 overflow-auto divide-y">
              {fbPages.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                  <input type="checkbox" disabled={p.already_added} checked={fbSelected.includes(p.id)}
                    onChange={(e) => setFbSelected(e.target.checked ? [...fbSelected, p.id] : fbSelected.filter((x) => x !== p.id))}
                    className="w-4 h-4" aria-label={`Select ${p.name}`} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.picture ? <img src={p.picture} alt="" className="w-8 h-8 rounded-full" /> : <div className="w-8 h-8 rounded-full bg-gray-200" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                    <div className="text-xs text-gray-500">{p.id}{p.location ? ` · ${p.location}` : ''}</div>
                  </div>
                  {p.already_added && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Already added</span>}
                </li>
              ))}
              {!fbLoading && fbPages.length === 0 && <li className="px-3 py-4 text-sm text-gray-500">No pages found on this Facebook account.</li>}
            </ul>
            <div className="flex justify-end px-3 py-2 border-t">
              <button onClick={importFacebook} disabled={saving || fbSelected.length === 0}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50">
                {saving ? 'Importing…' : `Import ${fbSelected.length} page${fbSelected.length === 1 ? '' : 's'}`}
              </button>
            </div>
            <p className="px-3 pb-3 text-xs text-gray-500">Imported pages use their Facebook name. Add city, website and phone afterwards with Edit for placeholders.</p>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="p-3 border-b">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search pages by name, number, ID or city…"
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <ul className="divide-y">
          {visible.map((p) => editingId === p.id ? (
            <EditRow key={p.id} page={p} onDone={async (saved) => { setEditingId(null); if (saved) { await load(); onPagesChanged(); } }} />
          ) : (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <div className="flex-1 min-w-[220px]">
                <div className="font-medium text-gray-900">{p.location_number ? `${p.location_number} · ` : ''}{p.location_name}</div>
                <div className="text-xs text-gray-500">
                  Page ID {p.facebook_page_id}{p.city ? ` · ${p.city}` : ''}{p.client_id ? ` · ${clientName.get(p.client_id) || 'client'}` : ''}
                </div>
              </div>
              <button onClick={() => setEditingId(p.id)} className="px-3 py-1 rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200">Edit</button>
            </li>
          ))}
          {visible.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-500">No pages match.</li>}
        </ul>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, required, hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean; hint?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required}
        className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-1.5" />
      {hint && <span className="block mt-1 text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

function EditRow({ page, onDone }: { page: PageRow; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState({
    location_name: page.location_name, location_number: page.location_number || '', city: page.city || '',
    base_url: page.base_url || '', phone: page.phone || '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const res = await fetch('/api/pages', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: page.id, ...f }),
    });
    setSaving(false);
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Save failed'); return; }
    onDone(true);
  };

  return (
    <li className="px-4 py-3 bg-blue-50/40">
      <div className="text-xs text-gray-500 mb-2">Page ID {page.facebook_page_id} (to change the ID, add the page again)</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Page name" value={f.location_name} onChange={(v) => setF({ ...f, location_name: v })} />
        <Field label="Location number" value={f.location_number} onChange={(v) => setF({ ...f, location_number: v })} />
        <Field label="City" value={f.city} onChange={(v) => setF({ ...f, city: v })} />
        <Field label="Website" value={f.base_url} onChange={(v) => setF({ ...f, base_url: v })} />
        <Field label="Phone" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={() => onDone(false)} className="px-3 py-1.5 rounded-lg border text-sm">Cancel</button>
        <button onClick={save} disabled={saving || !f.location_name.trim()} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </li>
  );
}
