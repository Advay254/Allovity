import { randomInt } from 'node:crypto';
import { decryptText, encryptText, hmacHex } from '../security/crypto.js';
import { passwordProblem } from '../security/password.js';
import * as totp from '../security/totp.js';
import { writeAudit, type AuditAction } from './audit.js';
import {
  accountId,
  checkFailureLimits,
  recordFailure,
  signInKeys,
  type LimitKeys,
} from './limits.js';
import {
  createSession,
  markReauthenticated,
  recentlyReauthenticated,
  revokeSession,
  revokeUserSessions,
  type LoadedSession,
} from './sessions.js';
import type { AdminServices } from './services.js';
import {
  clearTotp,
  consumeRecoveryCode,
  consumeTotpStep,
  countRecoveryCodes,
  enableTotp,
  findUserByEmail,
  isValidEmail,
  normalizeEmail,
  replaceRecoveryCodes,
  setPassword,
  setPendingTotp,
  touchLastLogin,
  type AdminUserRecord,
} from './users.js';

export interface RequestInfo {
  ip: string;
  userAgent: string | null;
}

export type SignInResult =
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'ok'; token: string; stage: 'pending' | 'active'; user: AdminUserRecord };

const actorOf = (user: { id: string }): string => `user:${user.id}`;

async function audit(
  svc: AdminServices,
  action: AuditAction,
  input: {
    actor: string;
    entity: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ip: string;
  },
): Promise<void> {
  const ok = await writeAudit(svc.pool, { action, ...input });
  if (!ok) svc.logger.error('Audit event could not be written', { action });
}

/**
 * Checks a password for sign-in. Every outcome costs one password hash comparison and
 * returns the same shape, so response text, status and timing do not reveal whether an
 * email exists, whether the account is active or whether the attempt was throttled.
 */
export async function attemptSignIn(
  svc: AdminServices,
  rawEmail: string,
  password: string,
  info: RequestInfo,
): Promise<SignInResult> {
  const email = normalizeEmail(rawEmail);
  const keys = signInKeys(svc, email, info.ip, 'login');
  const limit = await checkFailureLimits(svc, keys);

  if (limit.blocked) {
    await svc.hasher.spendTime(password);
    if (limit.firstBlock) {
      await audit(svc, 'auth.throttled', {
        actor: 'anonymous',
        entity: 'auth',
        metadata: { scope: 'sign_in', account: accountId(svc, email).slice(0, 12) },
        ip: info.ip,
      });
    }
    return { kind: 'throttled', retryAfterSeconds: limit.retryAfterSeconds };
  }

  const user = isValidEmail(email) ? await findUserByEmail(svc.pool, email) : null;
  const usable = user !== null && user.active;
  const encoded = usable ? user.passwordHash : await svc.hasher.dummyHash();
  const matches = await svc.hasher.verify(encoded, password);

  if (!usable || !matches) {
    await recordFailure(svc, keys);
    await audit(svc, 'auth.sign_in_failed', {
      actor: 'anonymous',
      entity: 'auth',
      metadata: { account: accountId(svc, email).slice(0, 12) },
      ip: info.ip,
    });
    return { kind: 'invalid' };
  }

  const timings = {
    idleMs: svc.config.admin.sessionIdleMs,
    absoluteMs: svc.config.admin.sessionAbsoluteMs,
  };
  const stage = user.twoStepEnabled ? 'pending' : 'active';
  const created = await createSession(
    svc.pool,
    {
      userId: user.id,
      stage,
      ip: info.ip,
      userAgent: info.userAgent,
      reauthenticatedAt: new Date(svc.now()),
    },
    timings,
    svc.now(),
  );

  if (stage === 'active') {
    await touchLastLogin(svc.pool, user.id);
    await audit(svc, 'auth.sign_in', {
      actor: actorOf(user),
      entity: 'admin_user',
      entityId: user.id,
      metadata: { method: 'password' },
      ip: info.ip,
    });
  }
  return { kind: 'ok', token: created.token, stage, user };
}

export type TwoStepResult =
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'ok'; token: string };

/** Moves a session to a fresh identifier. The old one stops working immediately. */
export async function rotateSession(
  svc: AdminServices,
  loaded: LoadedSession,
  info: RequestInfo,
  overrides: { stage?: 'pending' | 'active'; reauthenticatedAt?: Date | null } = {},
): Promise<{ token: string; id: string }> {
  const next = await createSession(
    svc.pool,
    {
      userId: loaded.user.id,
      stage: overrides.stage ?? loaded.session.stage,
      ip: info.ip,
      userAgent: info.userAgent,
      reauthenticatedAt:
        overrides.reauthenticatedAt === undefined
          ? loaded.session.reauthenticatedAt
          : overrides.reauthenticatedAt,
      absoluteExpiresAt:
        loaded.session.stage === 'active' ? loaded.session.absoluteExpiresAt : undefined,
    },
    { idleMs: svc.config.admin.sessionIdleMs, absoluteMs: svc.config.admin.sessionAbsoluteMs },
    svc.now(),
  );
  await revokeSession(svc.pool, loaded.session.id);
  return next;
}

/** Recovery codes look like "k7m2q-9xw4d". Input is forgiving about case, spaces and dashes. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] as string;
    const part = () => Array.from({ length: 5 }, pick).join('');
    return `${part()}-${part()}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function recoveryHash(svc: AdminServices, code: string): string {
  return hmacHex(svc.keys.recovery, normalizeRecoveryCode(code));
}

function mfaKeys(svc: AdminServices, user: AdminUserRecord, ip: string): LimitKeys {
  return signInKeys(svc, user.email, ip, 'mfa');
}

/** Checks a code or recovery code for a pending session. Counted against the account. */
export async function verifyTwoStep(
  svc: AdminServices,
  pending: LoadedSession,
  input: { code?: string; recovery?: string },
  info: RequestInfo,
): Promise<TwoStepResult> {
  const { user } = pending;
  const keys = mfaKeys(svc, user, info.ip);
  const limit = await checkFailureLimits(svc, keys);
  if (limit.blocked) {
    if (limit.firstBlock) {
      await audit(svc, 'auth.throttled', {
        actor: actorOf(user),
        entity: 'admin_user',
        entityId: user.id,
        metadata: { scope: 'two_step' },
        ip: info.ip,
      });
    }
    return { kind: 'throttled', retryAfterSeconds: limit.retryAfterSeconds };
  }

  let method: 'totp' | 'recovery' | null = null;
  const recovery = input.recovery?.trim();
  if (recovery) {
    if (await consumeRecoveryCode(svc.pool, user.id, recoveryHash(svc, recovery))) {
      method = 'recovery';
    }
  } else if (input.code && user.totpSecretEncrypted) {
    const secret = decryptText(svc.keys.totp, user.totpSecretEncrypted);
    const step = secret ? totp.matchStep(secret, input.code.replace(/\s/g, ''), svc.now()) : null;
    if (step !== null && (await consumeTotpStep(svc.pool, user.id, step))) method = 'totp';
  }

  if (!method) {
    await recordFailure(svc, keys);
    await audit(svc, 'auth.two_step_failed', {
      actor: actorOf(user),
      entity: 'admin_user',
      entityId: user.id,
      ip: info.ip,
    });
    return { kind: 'invalid' };
  }

  const { token } = await rotateSession(svc, pending, info, { stage: 'active' });
  await touchLastLogin(svc.pool, user.id);
  if (method === 'recovery') {
    await audit(svc, 'recovery_code.used', {
      actor: actorOf(user),
      entity: 'admin_user',
      entityId: user.id,
      metadata: { remaining: await countRecoveryCodes(svc.pool, user.id) },
      ip: info.ip,
    });
  }
  await audit(svc, 'auth.sign_in', {
    actor: actorOf(user),
    entity: 'admin_user',
    entityId: user.id,
    metadata: { method },
    ip: info.ip,
  });
  return { kind: 'ok', token };
}

/* Enrolment ------------------------------------------------------------------ */

export interface EnrolmentDetails {
  manualKey: string;
  qrSvg: string;
}

/** Shows the same pending secret until it is confirmed, so a page reload does not break a scan. */
export async function beginEnrolment(
  svc: AdminServices,
  user: AdminUserRecord,
): Promise<EnrolmentDetails> {
  let secret: string | null = null;
  if (user.twoStepPending && user.totpSecretEncrypted) {
    secret = decryptText(svc.keys.totp, user.totpSecretEncrypted);
  }
  if (!secret) {
    secret = totp.generateSecretBase32();
    await setPendingTotp(svc.pool, user.id, encryptText(svc.keys.totp, secret));
  }
  const uri = totp.otpauthUri(secret, user.email, 'Allovity Admin');
  return { manualKey: totp.groupKey(secret), qrSvg: await totp.qrSvg(uri) };
}

export type EnrolResult =
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'ok'; recoveryCodes: string[]; token: string };

export async function confirmEnrolment(
  svc: AdminServices,
  loaded: LoadedSession,
  code: string,
  info: RequestInfo,
): Promise<EnrolResult> {
  const { user } = loaded;
  const keys = mfaKeys(svc, user, info.ip);
  const limit = await checkFailureLimits(svc, keys);
  if (limit.blocked) return { kind: 'throttled', retryAfterSeconds: limit.retryAfterSeconds };

  const secret =
    user.twoStepPending && user.totpSecretEncrypted
      ? decryptText(svc.keys.totp, user.totpSecretEncrypted)
      : null;
  const step = secret ? totp.matchStep(secret, code.replace(/\s/g, ''), svc.now()) : null;
  if (step === null) {
    await recordFailure(svc, keys);
    return { kind: 'invalid' };
  }

  await enableTotp(svc.pool, user.id, step);
  const codes = generateRecoveryCodes();
  await replaceRecoveryCodes(
    svc.pool,
    user.id,
    codes.map((value) => recoveryHash(svc, value)),
  );
  const { token } = await rotateSession(svc, loaded, info);
  await audit(svc, 'two_step.enrolled', {
    actor: actorOf(user),
    entity: 'admin_user',
    entityId: user.id,
    ip: info.ip,
  });
  return { kind: 'ok', recoveryCodes: codes, token };
}

export async function regenerateRecoveryCodes(
  svc: AdminServices,
  user: AdminUserRecord,
  info: RequestInfo,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await replaceRecoveryCodes(
    svc.pool,
    user.id,
    codes.map((value) => recoveryHash(svc, value)),
  );
  await audit(svc, 'recovery_code.regenerated', {
    actor: actorOf(user),
    entity: 'admin_user',
    entityId: user.id,
    ip: info.ip,
  });
  return codes;
}

export async function disableTwoStep(
  svc: AdminServices,
  user: AdminUserRecord,
  info: RequestInfo,
): Promise<void> {
  await clearTotp(svc.pool, user.id);
  await audit(svc, 'two_step.disabled', {
    actor: actorOf(user),
    entity: 'admin_user',
    entityId: user.id,
    ip: info.ip,
  });
}

/* Re-entering the password for sensitive actions --------------------------------- */

export type ReauthResult =
  { kind: 'ok' } | { kind: 'invalid' } | { kind: 'throttled'; retryAfterSeconds: number };

/** Passes when the password was entered in the last five minutes, or when a correct one is supplied now. */
export async function requireRecentPassword(
  svc: AdminServices,
  loaded: LoadedSession,
  password: string | undefined,
  info: RequestInfo,
): Promise<ReauthResult> {
  if (recentlyReauthenticated(loaded.session, svc.now())) return { kind: 'ok' };
  const keys = signInKeys(svc, loaded.user.email, info.ip, 'login');
  const limit = await checkFailureLimits(svc, keys);
  if (limit.blocked) {
    await svc.hasher.spendTime(password ?? '');
    return { kind: 'throttled', retryAfterSeconds: limit.retryAfterSeconds };
  }
  const matches =
    typeof password === 'string' &&
    password.length > 0 &&
    (await svc.hasher.verify(loaded.user.passwordHash, password));
  if (!matches) {
    if (!password) await svc.hasher.spendTime('');
    await recordFailure(svc, keys);
    return { kind: 'invalid' };
  }
  await markReauthenticated(svc.pool, loaded.session.id, svc.now());
  loaded.session.reauthenticatedAt = new Date(svc.now());
  return { kind: 'ok' };
}

/* Password change ---------------------------------------------------------------- */

export type ChangePasswordResult =
  | { kind: 'ok'; token: string }
  | { kind: 'invalid'; field: 'password' | 'confirm'; message: string };

export async function changePassword(
  svc: AdminServices,
  loaded: LoadedSession,
  next: string,
  confirm: string,
  info: RequestInfo,
  forced: boolean,
): Promise<ChangePasswordResult> {
  const { user } = loaded;
  if (next !== confirm) {
    return { kind: 'invalid', field: 'confirm', message: 'The two passwords do not match.' };
  }
  const problem = passwordProblem(next, { email: user.email, displayName: user.displayName });
  if (problem) return { kind: 'invalid', field: 'password', message: problem };
  if (await svc.hasher.verify(user.passwordHash, next)) {
    return {
      kind: 'invalid',
      field: 'password',
      message: 'Choose a password that is different from the current one.',
    };
  }

  await setPassword(svc.pool, user.id, await svc.hasher.hash(next), false);
  const fresh = await rotateSession(svc, loaded, info, { reauthenticatedAt: new Date(svc.now()) });
  const revoked = await revokeUserSessions(svc.pool, user.id, fresh.id);
  await audit(svc, forced ? 'password.forced_change' : 'password.changed', {
    actor: actorOf(user),
    entity: 'admin_user',
    entityId: user.id,
    metadata: { otherSessionsRevoked: revoked },
    ip: info.ip,
  });
  return { kind: 'ok', token: fresh.token };
}
