import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, encryptToken, tokenAad } from './crypto';
import { SocialApiError, errorMessage, sleep, truncate } from './http';
import { linkedinRefresh } from '@/lib/linkedin/api';
import { xRefresh } from '@/lib/x/api';

// Server-only store for connected LinkedIn members / X accounts (fb_social_connections,
// service role only). Tokens are encrypted with SOCIAL_TOKEN_KEY before they reach the database
// and are never returned to the browser.
//
// Refresh safety: X refresh tokens are treated as single-use (they rotate). A refresh is claimed
// first with a compare-and-set on (refresh_token_enc, updated_at), so two concurrent runs can't
// both spend the same refresh token; the run that loses waits for the winner's new token.

export type SocialProvider = 'linkedin' | 'x';
export type ConnectionStatus = 'active' | 'needs_reauth' | 'disconnected';

const TABLE = 'fb_social_connections';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Safe for the browser: no token columns. */
export const PUBLIC_CONNECTION_COLUMNS =
  'id, provider, display_name, username, status, access_expires_at, refresh_expires_at, last_error, created_at';

export interface PublicConnection {
  id: string;
  provider: SocialProvider;
  display_name: string | null;
  username: string | null;
  status: ConnectionStatus;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface ConnectionRow extends PublicConnection {
  external_id: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  updated_at: string;
}

const PRIVATE_COLUMNS = `${PUBLIC_CONNECTION_COLUMNS}, external_id, access_token_enc, refresh_token_enc, updated_at`;

const expiresAt = (seconds: number | null | undefined, now: number = Date.now()): string | null =>
  seconds && seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null;

export interface SaveConnectionInput {
  provider: SocialProvider;
  externalId: string;
  displayName: string | null;
  username: string | null;
  accessToken: string;
  accessExpiresIn: number | null;
  refreshToken: string | null;
  refreshExpiresIn: number | null;
  scopes: string | null;
  connectedBy: string | null;
}

/** Upserts on (provider, external_id); a reconnect replaces the tokens and reactivates the row. */
export async function saveConnection(supabase: SupabaseClient, input: SaveConnectionInput): Promise<PublicConnection> {
  const now = Date.now();
  const row = {
    provider: input.provider,
    external_id: input.externalId,
    display_name: input.displayName ? truncate(input.displayName, 200) : null,
    username: input.username,
    access_token_enc: encryptToken(input.accessToken, tokenAad(input.provider, input.externalId, 'access')),
    refresh_token_enc: input.refreshToken
      ? encryptToken(input.refreshToken, tokenAad(input.provider, input.externalId, 'refresh'))
      : null,
    access_expires_at: expiresAt(input.accessExpiresIn, now),
    refresh_expires_at: expiresAt(input.refreshExpiresIn, now),
    scopes: input.scopes,
    status: 'active',
    last_error: null,
    connected_by: input.connectedBy,
    updated_at: new Date(now).toISOString(),
  };
  const { data, error } = await supabase
    .from(TABLE).upsert(row, { onConflict: 'provider,external_id' }).select(PUBLIC_CONNECTION_COLUMNS).single();
  if (error || !data) throw new Error('Failed to save connection');
  return data as PublicConnection;
}

export async function listConnections(supabase: SupabaseClient): Promise<PublicConnection[]> {
  const { data, error } = await supabase
    .from(TABLE).select(PUBLIC_CONNECTION_COLUMNS).neq('status', 'disconnected').order('created_at', { ascending: true });
  if (error) throw new Error('Failed to load connections');
  return (data || []) as PublicConnection[];
}

export async function getPublicConnection(supabase: SupabaseClient, id: string): Promise<PublicConnection | null> {
  const { data } = await supabase.from(TABLE).select(PUBLIC_CONNECTION_COLUMNS).eq('id', id).maybeSingle();
  return (data as PublicConnection | null) || null;
}

/** Disconnect: status=disconnected and both token columns wiped (pages keep the id; posting fails clearly). */
export async function disconnectConnection(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'disconnected', access_token_enc: null, refresh_token_enc: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  return !error && (data || []).length === 1;
}

/** Records a failure on the connection; `needsReauth` also flips status so the UI asks to reconnect. */
export async function markConnectionError(supabase: SupabaseClient, id: string, message: string, needsReauth: boolean): Promise<void> {
  const patch: Record<string, unknown> = { last_error: truncate(message), updated_at: new Date().toISOString() };
  if (needsReauth) patch.status = 'needs_reauth';
  await supabase.from(TABLE).update(patch).eq('id', id).neq('status', 'disconnected');
}

export type AccessTokenResult =
  | { ok: true; token: string; connection: PublicConnection & { external_id: string } }
  | { ok: false; error: string; needsReauth: boolean };

async function loadRow(supabase: SupabaseClient, id: string): Promise<ConnectionRow | null> {
  const { data } = await supabase.from(TABLE).select(PRIVATE_COLUMNS).eq('id', id).maybeSingle();
  return (data as ConnectionRow | null) || null;
}

const providerName = (p: SocialProvider) => (p === 'x' ? 'X' : 'LinkedIn');

function fresh(row: ConnectionRow, now: number = Date.now()): boolean {
  if (!row.access_expires_at) return true; // no expiry reported: try it; a 401 marks needs_reauth
  return new Date(row.access_expires_at).getTime() - now > REFRESH_MARGIN_MS;
}

function usable(row: ConnectionRow): AccessTokenResult {
  const token = decryptToken(row.access_token_enc, tokenAad(row.provider, row.external_id, 'access'));
  if (!token) return { ok: false, error: `${providerName(row.provider)} token could not be read (SOCIAL_TOKEN_KEY changed?); reconnect the account`, needsReauth: true };
  return {
    ok: true,
    token,
    connection: {
      id: row.id, provider: row.provider, external_id: row.external_id, display_name: row.display_name,
      username: row.username, status: row.status, access_expires_at: row.access_expires_at,
      refresh_expires_at: row.refresh_expires_at, last_error: row.last_error, created_at: row.created_at,
    },
  };
}

async function fail(supabase: SupabaseClient, row: ConnectionRow, error: string, needsReauth: boolean): Promise<AccessTokenResult> {
  await markConnectionError(supabase, row.id, error, needsReauth);
  return { ok: false, error, needsReauth };
}

/**
 * A usable access token for the connection, refreshing it when it expires within 5 minutes.
 * LinkedIn: refreshes only when LinkedIn issued a refresh token (approved partners); otherwise an
 * expired token marks the connection needs_reauth. X: rotating refresh, serialized per connection.
 */
export async function getAccessToken(supabase: SupabaseClient, connectionId: string, expected?: SocialProvider): Promise<AccessTokenResult> {
  const row = await loadRow(supabase, connectionId);
  if (!row) return { ok: false, error: 'Connected account not found; reconnect it on the Pages tab', needsReauth: true };
  if (expected && row.provider !== expected) return { ok: false, error: 'Page is linked to the wrong kind of account', needsReauth: false };
  const name = providerName(row.provider);
  if (row.status === 'disconnected') return { ok: false, error: `${name} account was disconnected; reconnect it on the Pages tab`, needsReauth: true };
  if (row.status === 'needs_reauth') return { ok: false, error: `${name} account needs to be reconnected (Pages tab)`, needsReauth: true };
  if (fresh(row)) {
    const r = usable(row);
    return r.ok ? r : fail(supabase, row, r.error, true);
  }

  const refreshPlain = decryptToken(row.refresh_token_enc, tokenAad(row.provider, row.external_id, 'refresh'));
  if (!refreshPlain) {
    const expired = !!row.access_expires_at && new Date(row.access_expires_at).getTime() <= Date.now();
    if (!expired) return usable(row); // inside the 5-min margin but still valid: use it
    return fail(supabase, row, `${name} access expired; reconnect the account on the Pages tab`, true);
  }
  if (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() <= Date.now()) {
    return fail(supabase, row, `${name} authorization expired; reconnect the account on the Pages tab`, true);
  }

  // Claim the refresh (compare-and-set). Losing means another run is refreshing right now.
  const claimedAt = new Date().toISOString();
  const { data: claimed } = await supabase
    .from(TABLE)
    .update({ updated_at: claimedAt })
    .eq('id', row.id)
    .eq('status', 'active')
    .eq('refresh_token_enc', row.refresh_token_enc ?? '')
    .eq('updated_at', row.updated_at)
    .select('id');
  if ((claimed || []).length !== 1) return waitForOtherRefresh(supabase, row.id);

  let tokens: { accessToken: string; expiresIn: number | null; refreshToken: string | null; refreshExpiresIn?: number | null; scope: string | null };
  try {
    tokens = row.provider === 'x' ? await xRefresh(refreshPlain) : await linkedinRefresh(refreshPlain);
  } catch (e) {
    const authFailed = e instanceof SocialApiError && e.authFailed;
    return fail(supabase, row, authFailed ? `${name} authorization was revoked or expired; reconnect the account` : errorMessage(e), authFailed);
  }

  const now = Date.now();
  // X rotates refresh tokens; if a new one isn't returned, the old one is kept (LinkedIn behavior)
  const newRefreshEnc = tokens.refreshToken
    ? encryptToken(tokens.refreshToken, tokenAad(row.provider, row.external_id, 'refresh'))
    : row.refresh_token_enc;
  const patch: Record<string, unknown> = {
    access_token_enc: encryptToken(tokens.accessToken, tokenAad(row.provider, row.external_id, 'access')),
    refresh_token_enc: newRefreshEnc,
    access_expires_at: expiresAt(tokens.expiresIn, now),
    last_error: null,
    updated_at: new Date(now).toISOString(),
  };
  if (tokens.refreshExpiresIn) patch.refresh_expires_at = expiresAt(tokens.refreshExpiresIn, now);
  if (tokens.scope) patch.scopes = tokens.scope;
  const { data: saved, error: saveErr } = await supabase
    .from(TABLE).update(patch).eq('id', row.id).eq('refresh_token_enc', row.refresh_token_enc ?? '').select('id');
  if (saveErr || (saved || []).length !== 1) {
    // The old refresh token is spent; without the new one saved the account must be reconnected.
    return fail(supabase, row, `${name} token was refreshed but could not be saved; reconnect the account`, true);
  }
  const updated = await loadRow(supabase, row.id);
  if (!updated) return { ok: false, error: 'Connected account disappeared during refresh', needsReauth: true };
  return usable(updated);
}

/** Another run claimed the refresh: re-read until its new token lands (~12 s max). */
async function waitForOtherRefresh(supabase: SupabaseClient, id: string): Promise<AccessTokenResult> {
  for (let i = 0; i < 6; i++) {
    await sleep(2_000);
    const row = await loadRow(supabase, id);
    if (!row) return { ok: false, error: 'Connected account not found', needsReauth: true };
    if (row.status !== 'active') return { ok: false, error: `${providerName(row.provider)} account needs to be reconnected (Pages tab)`, needsReauth: true };
    if (fresh(row)) return usable(row);
  }
  return { ok: false, error: 'Token refresh is in progress elsewhere; try again in a minute', needsReauth: false };
}
