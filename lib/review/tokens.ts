import { createHash, randomBytes } from 'crypto';

export const CLIENT_LINK_TTL_DAYS = 14;

/** New magic-link token. Only the hash is stored; the raw token goes in the email link. */
export function generateReviewToken(): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CLIENT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { token, hash: hashReviewToken(token), expiresAt };
}

export function hashReviewToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Tokens are 43-char base64url; reject anything else before touching the DB. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(token);
}
