'use client';

import { useState } from 'react';
import type { SocialStatus } from '@/lib/social/ui';

// LinkedIn / X on the Pages tab: the connected-accounts panel (connect, reconnect, disconnect) and
// the per-page mapping controls (which LinkedIn company page / X account a page posts to).
// Connecting is a plain navigation to the server's OAuth start route (admin only, enforced there).

export interface SocialConnection {
  id: string;
  provider: 'linkedin' | 'x';
  display_name: string | null;
  username: string | null;
  status: 'active' | 'needs_reauth' | 'disconnected';
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface SocialMappedPage {
  id: string;
  location_name: string;
  linkedin_org_id?: string | null;
  linkedin_org_name?: string | null;
  linkedin_connection_id?: string | null;
  x_connection_id?: string | null;
  x_username?: string | null;
  linkedin_connection_status?: string | null;
  x_connection_status?: string | null;
}

export interface LinkedInOrg { id: string; name: string; role?: string | null }

export const CONNECT_MESSAGES: Record<string, string> = {
  denied: 'sign-in was cancelled.',
  state_mismatch: 'sign-in could not be verified. Please try again.',
  not_configured: "isn't set up yet (app credentials missing on the server).",
  forbidden: 'only admins can connect accounts.',
  no_code: 'sign-in did not finish. Please try again.',
  exchange_failed: 'sign-in failed while getting access. Please try again.',
  profile_failed: 'sign-in worked but the account details could not be read. Please try again.',
  no_admin_orgs: 'this LinkedIn member is not an admin of any company page.',
  save_failed: 'the connection could not be saved (is SOCIAL_TOKEN_KEY set?).',
};

const NAME = { linkedin: 'LinkedIn', x: 'X' } as const;
const START = { linkedin: '/api/linkedin/oauth/start', x: '/api/x/oauth/start' } as const;

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function connectionLabel(c: SocialConnection): string {
  if (c.provider === 'x') return c.username ? `@${c.username}` : c.display_name || 'X account';
  return c.display_name || 'LinkedIn member';
}

function ProviderIcon({ provider }: { provider: 'linkedin' | 'x' }) {
  return provider === 'linkedin' ? (
    <span className="w-7 h-7 rounded bg-[#0a66c2] text-white text-xs font-bold flex items-center justify-center shrink-0" aria-hidden>in</span>
  ) : (
    <span className="w-7 h-7 rounded bg-black text-white text-sm font-bold flex items-center justify-center shrink-0" aria-hidden>X</span>
  );
}

function StatusChip({ label, ok, text }: { label: string; ok: boolean; text: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${ok ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
      <span className="font-semibold">{label}</span> {text}
    </span>
  );
}

export function SocialAccountsPanel({ status, connections, isAdmin, loading, onChanged }: {
  status: SocialStatus | null;
  connections: SocialConnection[];
  isAdmin: boolean;
  loading: boolean;
  onChanged: () => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = connections.filter((c) => c.status !== 'disconnected');

  const disconnect = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/social/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Disconnect failed');
      setConfirmId(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed');
    } finally {
      setBusyId(null);
    }
  };

  const go = (provider: 'linkedin' | 'x') => { window.location.href = START[provider]; };

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold text-gray-900">Connected accounts</h2>
          <p className="text-sm text-gray-500">LinkedIn admins and X accounts this app posts with. Each page is mapped to one below.</p>
        </div>
        {isAdmin && (
          <>
            <button type="button" onClick={() => go('linkedin')} disabled={!!status && !status.linkedin.configured}
              title={status && !status.linkedin.configured ? 'LinkedIn app credentials are not set on the server' : undefined}
              className="px-4 py-2 rounded-lg bg-[#0a66c2] text-white text-sm font-semibold hover:bg-[#004182] disabled:opacity-50">
              Connect LinkedIn
            </button>
            <button type="button" onClick={() => go('x')} disabled={!!status && !status.x.configured}
              title={status && !status.x.configured ? 'X app credentials are not set on the server' : undefined}
              className="px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50">
              Connect X
            </button>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2" aria-label="LinkedIn and X setup">
        {status ? (
          <>
            <StatusChip label="LinkedIn" ok={status.linkedin.configured} text={status.linkedin.configured ? 'app set up' : 'app not set up'} />
            <StatusChip label="LinkedIn" ok={status.linkedin.enabled} text={status.linkedin.enabled ? 'publishing on' : 'publishing off'} />
            <StatusChip label="X" ok={status.x.configured} text={status.x.configured ? 'app set up' : 'app not set up'} />
            <StatusChip label="X" ok={status.x.enabled} text={status.x.enabled ? 'publishing on' : 'publishing off'} />
            {!status.tokenKeyConfigured && <StatusChip label="Token key" ok={false} text="missing (SOCIAL_TOKEN_KEY)" />}
          </>
        ) : (
          <span className="text-xs text-gray-500">Checking setup…</span>
        )}
      </div>

      <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded px-3 py-2">
        LinkedIn sign-in lasts 60 days unless LinkedIn approves refresh tokens; reconnect when it expires. While publishing is off,
        LinkedIn and X posts can still be drafted and approved; they are held back when the batch is scheduled.
      </p>

      {error && <p className="text-sm text-red-700" role="status">{error}</p>}

      <ul className="divide-y border rounded-lg">
        {loading && visible.length === 0 && <li className="px-3 py-3 text-sm text-gray-500">Loading connected accounts…</li>}
        {!loading && visible.length === 0 && <li className="px-3 py-3 text-sm text-gray-500">No LinkedIn or X accounts connected yet.</li>}
        {visible.map((c) => {
          const reauth = c.status === 'needs_reauth';
          const expires = c.refresh_expires_at || c.access_expires_at;
          return (
            <li key={c.id} className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${reauth ? 'bg-amber-50' : ''}`}>
              <ProviderIcon provider={c.provider} />
              <div className="flex-1 min-w-[200px]">
                <div className="font-medium text-gray-900">
                  {connectionLabel(c)}
                  {c.provider === 'x' && c.display_name && c.username && <span className="font-normal text-gray-500"> · {c.display_name}</span>}
                </div>
                <div className="text-xs text-gray-500">
                  {NAME[c.provider]} · {reauth ? <span className="text-amber-800 font-medium">needs to be reconnected</span> : 'active'}
                  {expires ? ` · sign-in expires ${fmtDate(expires)}` : ''}
                  {c.last_error ? <span className="text-red-700"> · {c.last_error}</span> : null}
                </div>
              </div>
              {isAdmin && (confirmId === c.id ? (
                <span className="flex items-center gap-2">
                  <span className="text-gray-700">Disconnect {connectionLabel(c)}? Pages mapped to it stop posting to {NAME[c.provider]}.</span>
                  <button type="button" onClick={() => setConfirmId(null)} disabled={busyId === c.id} className="px-3 py-1 rounded-lg border">No</button>
                  <button type="button" onClick={() => disconnect(c.id)} disabled={busyId === c.id}
                    className="px-3 py-1 rounded-lg bg-red-600 text-white disabled:opacity-50">
                    {busyId === c.id ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  {reauth && (
                    <button type="button" onClick={() => go(c.provider)} className="px-3 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700">
                      Reconnect
                    </button>
                  )}
                  <button type="button" onClick={() => setConfirmId(c.id)} className="px-3 py-1 rounded-lg text-red-700 hover:bg-red-50">Disconnect</button>
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Per-page mapping

async function patchMapping(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch('/api/pages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : 'Save failed';
}

export function LinkedInMappingCell({ page, connections, isAdmin, loadOrgs, onSaved }: {
  page: SocialMappedPage;
  connections: SocialConnection[];
  isAdmin: boolean;
  /** cached per connection by the parent */
  loadOrgs: (connectionId: string) => Promise<{ orgs: LinkedInOrg[] } | { error: string }>;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [connId, setConnId] = useState('');
  const [orgs, setOrgs] = useState<LinkedInOrg[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = connections.filter((c) => c.provider === 'linkedin' && c.status === 'active');
  const current = page.linkedin_org_id ? page.linkedin_org_name || `Organization ${page.linkedin_org_id}` : null;
  const broken = !!page.linkedin_connection_id && page.linkedin_connection_status !== 'active';

  const pickConnection = async (id: string) => {
    setConnId(id);
    setOrgs(null);
    setOrgId('');
    setError(null);
    if (!id) return;
    setBusy(true);
    const r = await loadOrgs(id);
    setBusy(false);
    if ('error' in r) setError(r.error);
    else { setOrgs(r.orgs); if (r.orgs.length === 1) setOrgId(r.orgs[0].id); }
  };

  const startEdit = () => {
    setOpen(true);
    setError(null);
    const initial = page.linkedin_connection_id && active.some((c) => c.id === page.linkedin_connection_id)
      ? page.linkedin_connection_id : active.length === 1 ? active[0].id : '';
    if (initial) void pickConnection(initial).then(() => { if (page.linkedin_org_id) setOrgId(page.linkedin_org_id); });
  };

  const save = async (clear: boolean) => {
    setBusy(true);
    setError(null);
    const org = orgs?.find((o) => o.id === orgId);
    const err = await patchMapping(clear
      ? { id: page.id, linkedin_org_id: null, linkedin_org_name: null, linkedin_connection_id: null }
      : { id: page.id, linkedin_org_id: orgId, linkedin_org_name: org?.name || null, linkedin_connection_id: connId });
    setBusy(false);
    if (err) { setError(err); return; }
    setOpen(false);
    onSaved();
  };

  if (!open) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-[#0a66c2]">LinkedIn</span>
        <span className={current ? (broken ? 'text-amber-800' : 'text-gray-800') : 'text-gray-400'}>
          {current || 'not set'}{broken ? ' (reconnect the account)' : ''}
        </span>
        {isAdmin && (
          <button type="button" onClick={startEdit} className="text-blue-600 hover:underline">{current ? 'Change' : 'Set'}</button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs bg-white border rounded-lg px-2 py-1.5">
      <span className="font-semibold text-[#0a66c2]">LinkedIn</span>
      {active.length === 0 ? (
        <span className="text-gray-600">Connect a LinkedIn account first (Connected accounts above).</span>
      ) : (
        <>
          <select value={connId} onChange={(e) => void pickConnection(e.target.value)} disabled={busy}
            aria-label={`LinkedIn admin for ${page.location_name}`} className="border border-gray-300 rounded px-1.5 py-1">
            <option value="">Choose admin…</option>
            {active.map((c) => <option key={c.id} value={c.id}>{connectionLabel(c)}</option>)}
          </select>
          {connId && (
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={busy || !orgs}
              aria-label={`LinkedIn company page for ${page.location_name}`} className="border border-gray-300 rounded px-1.5 py-1">
              <option value="">{orgs ? (orgs.length ? 'Choose company page…' : 'No company pages') : 'Loading…'}</option>
              {(orgs || []).map((o) => <option key={o.id} value={o.id}>{o.name}{o.role ? ` (${o.role.toLowerCase()})` : ''}</option>)}
            </select>
          )}
          <button type="button" onClick={() => save(false)} disabled={busy || !connId || !orgId}
            className="px-2 py-1 rounded bg-blue-600 text-white disabled:opacity-50">{busy ? '…' : 'Save'}</button>
        </>
      )}
      {current && <button type="button" onClick={() => save(true)} disabled={busy} className="px-2 py-1 rounded text-red-700 hover:bg-red-50">Remove</button>}
      <button type="button" onClick={() => setOpen(false)} disabled={busy} className="px-2 py-1 rounded border">Cancel</button>
      {error && <span className="basis-full text-red-700">{error}</span>}
    </div>
  );
}

export function XMappingCell({ page, connections, isAdmin, onSaved }: {
  page: SocialMappedPage;
  connections: SocialConnection[];
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const xs = connections.filter((c) => c.provider === 'x' && (c.status === 'active' || c.id === page.x_connection_id));
  const mapped = connections.find((c) => c.id === page.x_connection_id);
  const current = page.x_connection_id ? (page.x_username ? `@${page.x_username}` : mapped ? connectionLabel(mapped) : 'X account') : null;
  const broken = !!page.x_connection_id && page.x_connection_status !== 'active';

  const change = async (id: string) => {
    setBusy(true);
    setError(null);
    const err = await patchMapping({ id: page.id, x_connection_id: id || null });
    setBusy(false);
    if (err) { setError(err); return; }
    onSaved();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold text-black">X</span>
      {isAdmin && xs.length > 0 ? (
        <select value={page.x_connection_id || ''} onChange={(e) => void change(e.target.value)} disabled={busy}
          aria-label={`X account for ${page.location_name}`} className="border border-gray-300 rounded px-1.5 py-0.5">
          <option value="">not set</option>
          {xs.map((c) => (
            <option key={c.id} value={c.id} disabled={c.status !== 'active'}>
              {connectionLabel(c)}{c.status !== 'active' ? ' (reconnect)' : ''}
            </option>
          ))}
        </select>
      ) : (
        <span className={current ? (broken ? 'text-amber-800' : 'text-gray-800') : 'text-gray-400'}>{current || 'not set'}</span>
      )}
      {broken && <span className="text-amber-800">reconnect the account</span>}
      {busy && <span className="text-gray-500">Saving…</span>}
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}
