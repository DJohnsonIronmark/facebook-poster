// Small fetch helpers shared by the LinkedIn and X clients (server only).
// Never logs or returns request headers, so access tokens can't leak into errors or logs.

export const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_CHARS = 300;

/** An HTTP/API failure. `authFailed` = the token was rejected (401, invalid_grant): reconnect needed. */
export class SocialApiError extends Error {
  readonly status: number;
  readonly authFailed: boolean;

  constructor(message: string, status: number, authFailed = false) {
    super(truncate(message));
    this.name = 'SocialApiError';
    this.status = status;
    this.authFailed = authFailed;
  }
}

export function truncate(s: string, max: number = MAX_ERROR_CHARS): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return truncate(e.message);
  return truncate(String(e));
}

/** Short, token-free description of an error response body. */
async function describeFailure(res: Response): Promise<string> {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  let detail = text;
  try {
    const j: unknown = JSON.parse(text);
    if (j && typeof j === 'object') {
      const o = j as Record<string, unknown>;
      const pick = [o.message, o.error_description, o.detail, o.title, o.error]
        .find((v) => typeof v === 'string' && v.trim());
      if (typeof pick === 'string') detail = pick;
    }
  } catch { /* not JSON */ }
  return truncate(`${res.status}${detail ? ` ${detail}` : ''}`);
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  /** label used in error messages, e.g. "LinkedIn create post" */
  label: string;
}

/** fetch with a timeout, no redirects, no caching; throws SocialApiError on non-2xx. */
export async function request(url: string, opts: RequestOptions): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body ?? undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new SocialApiError(`${opts.label}: ${timedOut ? 'timed out' : 'network error'}`, 0);
  }
  if (!res.ok) {
    const detail = await describeFailure(res);
    throw new SocialApiError(`${opts.label} failed (${detail})`, res.status, res.status === 401);
  }
  return res;
}

export async function requestJson<T = unknown>(url: string, opts: RequestOptions): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SocialApiError(`${opts.label}: response was not JSON`, res.status);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Narrow unknown JSON to a record (no casts to any). */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
}

export function asNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
