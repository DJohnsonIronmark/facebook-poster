import { createHash, randomBytes } from 'crypto';

// PKCE (RFC 7636) for X OAuth 2.0. Only node:crypto, so this module runs under plain Node (tests).

/** 43-character base64url code verifier (32 random bytes). */
export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** S256 code challenge: base64url(sha256(verifier)), no padding. */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export function isValidCodeVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}
