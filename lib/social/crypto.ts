import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM encryption for LinkedIn / X OAuth tokens stored in fb_social_connections.
// Key: SOCIAL_TOKEN_KEY = 32 random bytes, base64 (generate with `openssl rand -base64 32`).
// Env only; never in source, the database or chat. Rotating it means reconnecting every account.
//
// Stored format: "v1." + base64url(iv[12] | tag[16] | ciphertext). The provider and connection
// external id are bound as associated data, so a token copied to another row does not decrypt.

const PREFIX = 'v1.';

export function socialTokenKeyConfigured(): boolean {
  try {
    keyBytes();
    return true;
  } catch {
    return false;
  }
}

function keyBytes(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_KEY || '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SOCIAL_TOKEN_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptToken(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

/** Returns null when the value is missing, malformed, or was encrypted for another row/key. */
export function decryptToken(sealed: string | null | undefined, aad: string): string | null {
  if (!sealed || !sealed.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Associated data for a connection's tokens. */
export function tokenAad(provider: 'linkedin' | 'x', externalId: string, kind: 'access' | 'refresh'): string {
  return `fb-poster:${provider}:${externalId}:${kind}`;
}
