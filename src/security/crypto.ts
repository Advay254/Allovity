import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Purposes a key can be derived for. One purpose, one key: the raw secret is never used directly. */
export type KeyPurpose = 'totp-encryption' | 'csrf' | 'recovery-codes' | 'identifier-hash';

const SALT = Buffer.from('allovity-admin-keys-v1', 'utf8');

export function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, `allovity:${purpose}`, 32),
  );
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptText(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${body.toString('base64url')}`;
}

/** Returns null when the text was not produced with this key or was altered. */
export function decryptText(key: Buffer, encoded: string): string | null {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1] as string, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2] as string, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3] as string, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
