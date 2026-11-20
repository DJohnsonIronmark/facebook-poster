import { socialTokenKeyConfigured } from '@/lib/social/crypto';
import {
  SocialApiError, asNumber, asRecord, asString, request, requestJson, sleep,
} from '@/lib/social/http';

// LinkedIn Community Management API client (server only). Verified against learn.microsoft.com
// 11/9/2026. Tokens are passed in per call and never logged.
//
// Env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET (required); LINKEDIN_SCOPES (optional, space-
// delimited, default "w_organization_social r_organization_admin"); LINKEDIN_API_VERSION
// (optional, YYYYMM, default 202610 — 202511 sunsets 2026-11-16).

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
const DEFAULT_SCOPES = 'w_organization_social r_organization_admin';
const DEFAULT_VERSION = '202610';
const VIDEO_POLL_MS = 5_000;

/** Roles that can publish organic posts as the organization. */
export const POSTING_ROLES = ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR'] as const;

export function linkedinClientId(): string {
  return process.env.LINKEDIN_CLIENT_ID || '';
}

function clientSecret(): string {
  return process.env.LINKEDIN_CLIENT_SECRET || '';
}

/** Client id + secret + token encryption key all present. */
export function linkedinConfigured(): boolean {
  return !!linkedinClientId() && !!clientSecret() && socialTokenKeyConfigured();
}

export function linkedinScopes(): string {
  const s = (process.env.LINKEDIN_SCOPES || '').trim().split(/[\s,]+/).filter(Boolean).join(' ');
  return s || DEFAULT_SCOPES;
}

function apiVersion(): string {
  const v = (process.env.LINKEDIN_API_VERSION || '').trim();
  return /^\d{6}$/.test(v) ? v : DEFAULT_VERSION;
}

function restHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'Linkedin-Version': apiVersion(),
    ...extra,
  };
}

export const orgUrn = (orgId: string) => `urn:li:organization:${orgId}`;

// ---------------------------------------------------------------------------------------------
// OAuth

export function linkedinAuthorizeUrl(state: string, redirectUri: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', linkedinClientId());
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', linkedinScopes());
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  /** seconds */
  expiresIn: number | null;
  refreshToken: string | null;
  refreshExpiresIn: number | null;
  scope: string | null;
}

function parseTokenResponse(raw: unknown, label: string): TokenSet {
  const j = asRecord(raw);
  const accessToken = asString(j.access_token);
  if (!accessToken) throw new SocialApiError(`${label}: no access token in response`, 0);
  return {
    accessToken,
    expiresIn: asNumber(j.expires_in),
    // refresh tokens are only issued to approved LinkedIn partners; absent otherwise
    refreshToken: asString(j.refresh_token),
    refreshExpiresIn: asNumber(j.refresh_token_expires_in),
    scope: asString(j.scope),
  };
}

async function tokenRequest(params: Record<string, string>, label: string): Promise<TokenSet> {
  try {
    const raw = await requestJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: linkedinClientId(), client_secret: clientSecret() }).toString(),
      label,
    });
    return parseTokenResponse(raw, label);
  } catch (e) {
    // invalid_grant / bad refresh token come back as 400 or 401: reconnect needed
    if (e instanceof SocialApiError && (e.status === 400 || e.status === 401)) {
      throw new SocialApiError(e.message, e.status, true);
    }
    throw e;
  }
}

export function linkedinExchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'LinkedIn token exchange');
}

export function linkedinRefresh(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'LinkedIn token refresh');
}

/** OpenID userinfo (only when the openid + profile scopes were granted). */
export async function linkedinUserInfo(token: string): Promise<{ sub: string; name: string | null }> {
  const j = asRecord(await requestJson(`${API}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${token}` }, label: 'LinkedIn userinfo',
  }));
  const sub = asString(j.sub);
  if (!sub) throw new SocialApiError('LinkedIn userinfo: no member id', 0);
  return { sub, name: asString(j.name) };
}

// ---------------------------------------------------------------------------------------------
// Organizations

export interface LinkedInOrg {
  id: string;     // numeric organization id
  name: string;
  role: string;
}

export interface OrgAclResult {
  orgs: { id: string; role: string }[];
  /** the member's person id (from roleAssignee urn:li:person:{id}) */
  personId: string | null;
}

const ORG_URN_RE = /^urn:li:organization:(\d{1,20})$/;
const PERSON_URN_RE = /^urn:li:person:([A-Za-z0-9_-]{1,100})$/;

/** Organizations where the token's member is an approved ADMINISTRATOR or CONTENT_ADMINISTRATOR. */
export async function linkedinOrgAcls(token: string): Promise<OrgAclResult> {
  const byId = new Map<string, string>();
  let personId: string | null = null;
  let successes = 0;
  let lastError: unknown = null;

  for (const role of POSTING_ROLES) {
    try {
      for (let start = 0, page = 0; page < 20; page++) {
        const url = `${API}/rest/organizationAcls?q=roleAssignee&role=${role}&state=APPROVED&count=100&start=${start}`;
        const j = asRecord(await requestJson(url, { headers: restHeaders(token), label: 'LinkedIn organization list' }));
        const elements = Array.isArray(j.elements) ? j.elements : [];
        for (const el of elements) {
          const e = asRecord(el);
          const target = asString(e.organization) || asString(e.organizationTarget) || '';
          const m = ORG_URN_RE.exec(target);
          if (m && !byId.has(m[1])) byId.set(m[1], asString(e.role) || role);
          const p = PERSON_URN_RE.exec(asString(e.roleAssignee) || '');
          if (p && !personId) personId = p[1];
        }
        const paging = asRecord(j.paging);
        const total = asNumber(paging.total);
        start += elements.length;
        if (elements.length === 0 || (total !== null && start >= total)) break;
      }
      successes++;
    } catch (e) {
      if (e instanceof SocialApiError && e.authFailed) throw e;
      lastError = e;
    }
  }
  if (successes === 0 && lastError) throw lastError;
  return { orgs: Array.from(byId.entries()).map(([id, role]) => ({ id, role })), personId };
}

/** Organization names by id; ids LinkedIn won't name are returned as "Organization {id}". */
export async function linkedinOrgNames(token: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const clean = ids.filter((id) => /^\d{1,20}$/.test(id));
  for (let i = 0; i < clean.length; i += 50) {
    const chunk = clean.slice(i, i + 50);
    const list = `List(${chunk.join(',')})`;
    for (const endpoint of ['organizations', 'organizationsLookup']) {
      const missing = chunk.filter((id) => !names.has(id));
      if (missing.length === 0) break;
      try {
        const j = asRecord(await requestJson(`${API}/rest/${endpoint}?ids=${list}`, {
          headers: restHeaders(token), label: 'LinkedIn organization names',
        }));
        const results = asRecord(j.results);
        for (const id of missing) {
          const r = asRecord(results[id]);
          const name = asString(r.localizedName) || asString(asRecord(asRecord(r.name).localized).en_US);
          if (name) names.set(id, name);
        }
      } catch (e) {
        if (e instanceof SocialApiError && e.authFailed) throw e;
        // fall through to the next endpoint
      }
    }
  }
  for (const id of clean) if (!names.has(id)) names.set(id, `Organization ${id}`);
  return names;
}

export async function linkedinAdminOrganizations(token: string): Promise<LinkedInOrg[]> {
  const { orgs } = await linkedinOrgAcls(token);
  const names = await linkedinOrgNames(token, orgs.map((o) => o.id));
  return orgs
    .map((o) => ({ id: o.id, role: o.role, name: names.get(o.id) || `Organization ${o.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Media uploads

export async function linkedinUploadImage(token: string, ownerUrn: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<string> {
  const init = asRecord(await requestJson(`${API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: restHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    label: 'LinkedIn image upload (initialize)',
  }));
  const value = asRecord(init.value);
  const uploadUrl = asString(value.uploadUrl);
  const image = asString(value.image);
  if (!uploadUrl || !image) throw new SocialApiError('LinkedIn image upload: no upload URL returned', 0);
  await request(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'application/octet-stream' },
    body: bytes,
    timeoutMs: 120_000,
    label: 'LinkedIn image upload',
  });
  return image;
}

/**
 * Uploads an MP4 and waits until LinkedIn reports it AVAILABLE. `deadline` (epoch ms) bounds the
 * wait; past it the upload is reported as failed with a clear message (the post is not created).
 */
export async function linkedinUploadVideo(token: string, ownerUrn: string, bytes: Uint8Array<ArrayBuffer>, deadline: number): Promise<string> {
  const init = asRecord(await requestJson(`${API}/rest/videos?action=initializeUpload`, {
    method: 'POST',
    headers: restHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      initializeUploadRequest: { owner: ownerUrn, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false },
    }),
    label: 'LinkedIn video upload (initialize)',
  }));
  const value = asRecord(init.value);
  const video = asString(value.video);
  const uploadToken = asString(value.uploadToken) ?? '';
  const instructions = Array.isArray(value.uploadInstructions) ? value.uploadInstructions.map(asRecord) : [];
  if (!video || instructions.length === 0) throw new SocialApiError('LinkedIn video upload: no upload instructions returned', 0);

  const etags: string[] = [];
  for (const ins of instructions) {
    const url = asString(ins.uploadUrl);
    const first = asNumber(ins.firstByte);
    const last = asNumber(ins.lastByte);
    if (!url || first === null || last === null || first < 0 || last < first || last >= bytes.byteLength) {
      throw new SocialApiError('LinkedIn video upload: invalid upload instructions', 0);
    }
    const res = await request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes.subarray(first, last + 1),
      timeoutMs: 120_000,
      label: 'LinkedIn video upload (part)',
    });
    const etag = res.headers.get('etag');
    if (!etag) throw new SocialApiError('LinkedIn video upload: part had no ETag', 0);
    etags.push(etag);
  }

  await request(`${API}/rest/videos?action=finalizeUpload`, {
    method: 'POST',
    headers: restHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } }),
    label: 'LinkedIn video upload (finalize)',
  });

  while (Date.now() < deadline) {
    const j = asRecord(await requestJson(`${API}/rest/videos/${encodeURIComponent(video)}`, {
      headers: restHeaders(token), label: 'LinkedIn video status',
    }));
    const status = asString(j.status);
    if (status === 'AVAILABLE') return video;
    if (status === 'PROCESSING_FAILED') {
      const reason = asString(j.processingFailureReason);
      throw new SocialApiError(`LinkedIn could not process the video${reason ? ` (${reason})` : ''}`, 0);
    }
    await sleep(VIDEO_POLL_MS);
  }
  throw new SocialApiError('LinkedIn was still processing the video when the run ended; the post was not created. Retry later.', 0);
}

// ---------------------------------------------------------------------------------------------
// Posts

export type LinkedInPostContent =
  | { kind: 'none' }
  | { kind: 'image'; urn: string; altText?: string }
  | { kind: 'video'; urn: string; title?: string }
  | { kind: 'article'; source: string; title: string; description?: string; thumbnailUrn?: string };

/** Creates a published organization post; returns its URN (x-restli-id). `commentary` must already be escaped. */
export async function linkedinCreatePost(token: string, input: { orgId: string; commentary: string; content: LinkedInPostContent }): Promise<string> {
  const body: Record<string, unknown> = {
    author: orgUrn(input.orgId),
    commentary: input.commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  const c = input.content;
  if (c.kind === 'image') body.content = { media: { id: c.urn, ...(c.altText ? { altText: c.altText } : {}) } };
  else if (c.kind === 'video') body.content = { media: { id: c.urn, ...(c.title ? { title: c.title } : {}) } };
  else if (c.kind === 'article') {
    body.content = {
      article: {
        source: c.source,
        title: c.title,
        ...(c.description ? { description: c.description } : {}),
        ...(c.thumbnailUrn ? { thumbnail: c.thumbnailUrn } : {}),
      },
    };
  }
  const res = await request(`${API}/rest/posts`, {
    method: 'POST',
    headers: restHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    label: 'LinkedIn create post',
  });
  const urn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  if (!urn) throw new SocialApiError('LinkedIn accepted the post but returned no id; check the page before retrying', res.status);
  return urn;
}

/** Deletes a post by URN (helper; not wired to the UI). */
export async function deleteLinkedInPost(token: string, postUrn: string): Promise<void> {
  await request(`${API}/rest/posts/${encodeURIComponent(postUrn)}`, {
    method: 'DELETE', headers: restHeaders(token), label: 'LinkedIn delete post',
  });
}
