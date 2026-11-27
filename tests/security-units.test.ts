import { describe, expect, it } from 'vitest';
import { checkAdminSecretKey } from '../src/config/env.js';
import { decryptText, deriveKey, encryptText } from '../src/security/crypto.js';
import { PasswordHasher, passwordProblem } from '../src/security/password.js';
import {
  assignableRoles,
  can,
  canManageUser,
  PERMISSIONS,
  ROLES,
} from '../src/security/permissions.js';
import { Secret, TOTP } from 'otpauth';
import { codeAt, generateSecretBase32, matchStep } from '../src/security/totp.js';

describe('TOTP (RFC 6238 appendix B, SHA-1)', () => {
  const secret = Secret.fromLatin1('12345678901234567890');
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [time, expected] of vectors) {
    it(`gives ${expected} at ${time}`, () => {
      const totp = new TOTP({ algorithm: 'SHA1', digits: 8, period: 30, secret });
      expect(totp.generate({ timestamp: time * 1000 })).toBe(expected);
    });
  }

  it('accepts one step of drift and rejects two', () => {
    const key = generateSecretBase32();
    const now = 1_700_000_000_000;
    expect(matchStep(key, codeAt(key, now), now)).not.toBeNull();
    expect(matchStep(key, codeAt(key, now - 30_000), now)).not.toBeNull();
    expect(matchStep(key, codeAt(key, now + 30_000), now)).not.toBeNull();
    expect(matchStep(key, codeAt(key, now - 90_000), now)).toBeNull();
    expect(matchStep(key, 'abcdef', now)).toBeNull();
  });
});

describe('key derivation and encryption', () => {
  const secret = 'Zk3vQ9mT2xLp7WnB4rYc8HdJ5sGf1AeUq6VoXtN0iKM';
  it('derives a different key for each purpose, never the raw secret', () => {
    const a = deriveKey(secret, 'totp-encryption');
    const b = deriveKey(secret, 'csrf');
    expect(a.equals(b)).toBe(false);
    expect(a.equals(Buffer.from(secret))).toBe(false);
    expect(a.length).toBe(32);
  });
  it('round-trips and rejects tampering and the wrong key', () => {
    const key = deriveKey(secret, 'totp-encryption');
    const sealed = encryptText(key, 'JBSWY3DPEHPK3PXP');
    expect(decryptText(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptText(deriveKey(secret, 'csrf'), sealed)).toBeNull();
    expect(decryptText(key, sealed.slice(0, -2) + 'AA')).toBeNull();
    expect(encryptText(key, 'same')).not.toBe(encryptText(key, 'same'));
  });
  it('validates the encryption secret without leaking it', () => {
    expect(checkAdminSecretKey(secret)).toBeNull();
    expect(checkAdminSecretKey(undefined)).toMatch(/ADMIN_SECRET_KEY/);
    expect(checkAdminSecretKey('short')).toMatch(/malformed/);
    expect(checkAdminSecretKey('a'.repeat(60))).toMatch(/random/);
    expect(checkAdminSecretKey(`${secret}!!`)).toMatch(/malformed/);
  });
});

describe('passwords', () => {
  it('enforces length, common passwords, email and name', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/no more than 128/);
    expect(passwordProblem('password123456')).toMatch(/common/);
    expect(passwordProblem('Password1234!!')).toMatch(/common/);
    expect(passwordProblem('jane.doe@example.com!!', { email: 'jane.doe@example.com' })).toMatch(
      /email/,
    );
    expect(passwordProblem('my name is olivia ok', { displayName: 'Olivia Owner' })).toMatch(
      /name/,
    );
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toMatch(/variety/);
    expect(passwordProblem('a long unusual passphrase 91')).toBeNull();
  });
  it('hashes with Argon2id at the configured cost and verifies', async () => {
    const hasher = new PasswordHasher({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const hash = await hasher.hash('a long unusual passphrase 91');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'a long unusual passphrase 91')).toBe(true);
    expect(await hasher.verify(hash, 'another passphrase 91')).toBe(false);
    expect(await hasher.verify('not a hash', 'x')).toBe(false);
  });
});

describe('roles and permissions', () => {
  it('matches the documented matrix and denies by default', () => {
    const matrix = Object.fromEntries(
      ROLES.map((role) => [role, PERMISSIONS.filter((p) => can(role, p))]),
    );
    expect(matrix.owner).toEqual([...PERMISSIONS]);
    expect(matrix.admin).toEqual([
      'account.self',
      'users.manage',
      'audit.view',
      'settings.manage',
      'content.edit',
    ]);
    expect(matrix.editor).toEqual(['account.self', 'content.edit']);
    expect(can('nobody' as never, 'account.self')).toBe(false);
  });
  it('never lets anyone grant a higher role or manage themselves', () => {
    expect(assignableRoles('editor')).toEqual([]);
    expect(assignableRoles('admin')).toEqual(['admin', 'editor']);
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'editor']);
    const owner = { id: 'o', role: 'owner' as const };
    const admin = { id: 'a', role: 'admin' as const };
    expect(canManageUser(owner, owner, 'deactivate')).toBe(false);
    expect(canManageUser(admin, owner, 'deactivate')).toBe(false);
    expect(canManageUser(admin, { id: 'b', role: 'admin' }, 'change-role')).toBe(false);
    expect(canManageUser(admin, { id: 'e', role: 'editor' }, 'deactivate')).toBe(true);
    expect(
      canManageUser({ id: 'e', role: 'editor' }, { id: 'x', role: 'editor' }, 'deactivate'),
    ).toBe(false);
  });
});
