'use client';

import { useCallback, useEffect, useState } from 'react';
import SearchableMultiSelect from './SearchableMultiSelect';
import type { FbClient } from '@/lib/review/types';

interface PageRow { id: string; location_name: string; location_number: string | null; facebook_page_id: string; client_id: string | null }

const splitEmails = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);

export default function ClientSettings() {
  const [clients, setClients] = useState<FbClient[]>([]);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/clients', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) { setMessage({ kind: 'error', text: data.error || 'Failed to load clients' }); return; }
    setClients(data.clients || []);
    setPages(data.pages || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!newName.trim()) return;
    const res = await fetch('/api/clients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }),
    });
    const data = await res.json();
    if (!res.ok) { setMessage({ kind: 'error', text: data.error }); return; }
    setNewName('');
    setMessage({ kind: 'ok', text: `Added ${data.client.name}. Assign its pages and turn the workflow on below.` });
    load();
  };

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-4">
      <div>
        <h3 className="font-semibold text-gray-900">Client approval settings</h3>
        <p className="text-sm text-gray-500">
          When the workflow is on, drafts for that client&apos;s pages go: team member uploads → account manager reviews &amp; approves → client reviews &amp; approves → everyone gets a &quot;ready to post&quot; confirmation → team member uploads final posts and schedules.
        </p>
      </div>
      {message && (
        <div className={`text-sm rounded px-3 py-2 ${message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{message.text}</div>
      )}
      <div className="flex gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New client name (e.g. Home Instead)"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm" onKeyDown={(e) => e.key === 'Enter' && create()} />
        <button onClick={create} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white">Add client</button>
      </div>
      <div className="divide-y">
        {clients.map((c) => (
          <ClientRow key={c.id} client={c} pages={pages} onSaved={(t) => { setMessage({ kind: 'ok', text: t }); load(); }}
            onError={(t) => setMessage({ kind: 'error', text: t })} />
        ))}
        {clients.length === 0 && <p className="text-sm text-gray-500 py-3">No clients yet.</p>}
      </div>
    </div>
  );
}

function ClientRow({ client, pages, onSaved, onError }: {
  client: FbClient; pages: PageRow[]; onSaved: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [enabled, setEnabled] = useState(client.approval_workflow_enabled);
  const [accountManager, setAccountManager] = useState(client.account_manager_email || '');
  const [external, setExternal] = useState(client.client_reviewer_emails.join(', '));
  const [pageIds, setPageIds] = useState<string[]>(pages.filter((p) => p.client_id === client.id).map((p) => p.id));
  const [saving, setSaving] = useState(false);

  // Pages already owned by another client are hidden, so a page belongs to at most one client
  const options = pages
    .filter((p) => !p.client_id || p.client_id === client.id)
    .map((p) => ({ id: p.id, label: p.location_number ? `${p.location_number} - ${p.location_name}` : p.location_name, subLabel: p.facebook_page_id }));

  const save = async () => {
    if (enabled && !accountManager.trim()) { onError(`${client.name}: add the account manager before enabling (they review drafts, and client replies go to them).`); return; }
    if (enabled && splitEmails(external).length === 0) { onError(`${client.name}: add at least one client reviewer email before enabling.`); return; }
    setSaving(true);
    const res = await fetch('/api/clients', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: client.id, approval_workflow_enabled: enabled, account_manager_email: accountManager.trim(),
        client_reviewer_emails: splitEmails(external), page_ids: pageIds,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { onError(data.error || 'Save failed'); return; }
    onSaved(`Saved ${client.name}.`);
  };

  return (
    <div className="py-4 grid gap-3 md:grid-cols-2">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-gray-900">{client.name}</span>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4" />
            Approval workflow
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-gray-600">Account manager (reviews and approves drafts; client replies go to this address)</span>
          <input value={accountManager} onChange={(e) => setAccountManager(e.target.value)} placeholder="am@ironmarkusa.com"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-1.5" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">Client reviewer email(s)</span>
          <input value={external} onChange={(e) => setExternal(e.target.value)} placeholder="marketing@client.com"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-1.5" />
        </label>
      </div>
      <div className="space-y-2">
        <span className="block text-sm text-gray-600">Facebook pages for this client ({pageIds.length})</span>
        <SearchableMultiSelect options={options} selectedIds={pageIds} onChange={setPageIds} placeholder="Assign pages…" disabled={saving} />
        <div className="flex justify-end">
          <button onClick={save} disabled={saving} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
