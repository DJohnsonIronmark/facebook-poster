import { socialTokenKeyConfigured } from '@/lib/social/crypto';
import {
  SocialApiError, asNumber, asRecord, asString, request, requestJson, sleep,
} from '@/lib/social/http';

// X API v2 client (server only), OAuth 2.0 user context with PKCE, confidential client.
// Verified against docs.x.com 11/9/2026. Tokens are passed in per call and never logged.
//
// Env: X_CLIENT_ID, X_CLIENT_SECRET.
// Cost (pay-per-use): about $0.015 per post, about $0.20 when the text contains a URL.

const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const API = 'https://api.x.com';
export const X_SCOPES = 'tweet.read tweet.write users.read offline.access media.write';
const CHUNK_BYTES = 4 * 1024 * 1024;
const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 15_000;

export function xClientId(): string {
  return process.env.X_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.X_CLIENT_SECRET || '';
}

export function xConfigured(): boolean {
  return !!xClientId() && !!clientSecret() && socialTokenKeyConfigured();
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${xClientId()}:${clientSecret()}`, 'utf8').toString('base64')}`;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------------------------
// OAuth

export function xAuthorizeUrl(state: string, codeChallenge: string, redirectUri: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', xClientId());
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', X_SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface XTokenSet {
  accessToken: string;
  expiresIn: number | null;
  refreshToken: string | null;
  scope: string | null;
}

async function tokenRequest(params: Record<string, string>, label: string): Promise<XTokenSet> {
  let raw: unknown;
  try {
    raw = await requestJson(`${API}/2/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
      body: new URLSearchParams({ ...params, client_id: xClientId() }).toString(),
      label,
    });
  } catch (e) {
    // invalid_grant (used/expired/revoked refresh token) comes back as 400 or 401
    if (e instanceof SocialApiError && (e.status === 400 || e.status === 401)) {
      throw new SocialApiError(e.message, e.status, true);
    }
    throw e;
  }
  const j = asRecord(raw);
  const accessToken = asString(j.access_token);
  if (!accessToken) throw new SocialApiError(`${label}: no access token in response`, 0);
  return {
    accessToken,
    expiresIn: asNumber(j.expires_in),
    refreshToken: asString(j.refresh_token),
    scope: asString(j.scope),
  };
}

/** The authorization code lives ~30 s: call this straight away in the callback. */
export function xExchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<XTokenSet> {
  return tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier },
    'X token exchange',
  );
}

/** Refresh tokens are treated as single-use: persist the returned one immediately. */
export function xRefresh(refreshToken: string): Promise<XTokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'X token refresh');
}

export async function xMe(token: string): Promise<{ id: string; username: string; name: string | null }> {
  const j = asRecord(await requestJson(`${API}/2/users/me`, { headers: bearer(token), label: 'X profile' }));
  const d = asRecord(j.data);
  const id = asString(d.id);
  const username = asString(d.username);
  if (!id || !username) throw new SocialApiError('X profile: no user id returned', 0);
  return { id, username, name: asString(d.name) };
}

// ---------------------------------------------------------------------------------------------
// Media

function mediaIdFrom(raw: unknown, label: string): string {
  const d = asRecord(asRecord(raw).data);
  const id = asString(d.id) || asString(d.media_id_string) || asString(d.media_id);
  if (!id) throw new SocialApiError(`${label}: no media id returned`, 0);
  return id;
}

function blobOf(bytes: Uint8Array<ArrayBuffer>, contentType: string): Blob {
  // copy into a fresh ArrayBuffer-backed view so Blob gets exactly these bytes
  return new Blob([Uint8Array.from(bytes)], { type: contentType });
}

export async function xUploadImage(token: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<string> {
  const form = new FormData();
  form.append('media', blobOf(bytes, contentType || 'application/octet-stream'), 'image');
  form.append('media_category', 'tweet_image');
  const raw = await requestJson(`${API}/2/media/upload`, {
    method: 'POST', headers: bearer(token), body: form, timeoutMs: 120_000, label: 'X image upload',
  });
  return mediaIdFrom(raw, 'X image upload');
}

/** Chunked MP4 upload; waits for processing until `deadline` (epoch ms). */
export async function xUploadVideo(token: string, bytes: Uint8Array<ArrayBuffer>, deadline: number): Promise<string> {
  const init = await requestJson(`${API}/2/media/upload/initialize`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'video/mp4', total_bytes: bytes.byteLength, media_category: 'tweet_video' }),
    label: 'X video upload (initialize)',
  });
  const mediaId = mediaIdFrom(init, 'X video upload (initialize)');
  const idPath = encodeURIComponent(mediaId);

  for (let offset = 0, segment = 0; offset < bytes.byteLength; offset += CHUNK_BYTES, segment++) {
    const form = new FormData();
    form.append('segment_index', String(segment));
    form.append('media', blobOf(bytes.subarray(offset, offset + CHUNK_BYTES), 'application/octet-stream'), 'chunk');
    await request(`${API}/2/media/upload/${idPath}/append`, {
      method: 'POST', headers: bearer(token), body: form, timeoutMs: 120_000, label: 'X video upload (append)',
    });
  }

  const fin = asRecord(await requestJson(`${API}/2/media/upload/${idPath}/finalize`, {
    method: 'POST', headers: bearer(token), label: 'X video upload (finalize)',
  }));
  let info = asRecord(asRecord(fin.data).processing_info);
  while (Object.keys(info).length > 0) {
    const state = asString(info.state);
    if (state === 'succeeded') break;
    if (state === 'failed') {
      const err = asRecord(info.error);
      const msg = asString(err.message) || asString(err.name);
      throw new SocialApiError(`X could not process the video${msg ? ` (${msg})` : ''}`, 0);
    }
    const waitMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (asNumber(info.check_after_secs) ?? 2) * 1000));
    if (Date.now() + waitMs > deadline) {
      throw new SocialApiError('X was still processing the video when the run ended; the post was not created. Retry later.', 0);
    }
    await sleep(waitMs);
    const st = asRecord(await requestJson(`${API}/2/media/upload?command=STATUS&media_id=${idPath}`, {
      headers: bearer(token), label: 'X video status',
    }));
    info = asRecord(asRecord(st.data).processing_info);
  }
  return mediaId;
}

// ---------------------------------------------------------------------------------------------
// Posts

export async function xCreatePost(token: string, input: { text: string; mediaId?: string | null }): Promise<string> {
  const body: Record<string, unknown> = { text: input.text };
  if (input.mediaId) body.media = { media_ids: [input.mediaId] };
  const j = asRecord(await requestJson(`${API}/2/tweets`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    label: 'X create post',
  }));
  const id = asString(asRecord(j.data).id);
  if (!id) throw new SocialApiError('X accepted the post but returned no id; check the account before retrying', 0);
  return id;
}

/** Deletes a post (helper; not wired to the UI). */
export async function deleteXPost(token: string, postId: string): Promise<void> {
  await request(`${API}/2/tweets/${encodeURIComponent(postId)}`, {
    method: 'DELETE', headers: bearer(token), label: 'X delete post',
  });
}
