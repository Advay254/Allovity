import { randomInt } from 'node:crypto';
import { writeAudit, type Queryable } from './audit.js';
import type { RequestInfo } from './auth.js';
import { revokeUserSessions } from './sessions.js';
import type { AdminServices } from './services.js';
import {
  clearTotp,
  findUserById,
  insertUser,
  isValidEmail,
  normalizeEmail,
  setActive,
  setRole,
  type AdminUserRecord,
} from './users.js';
import { passwordProblem } from '../security/password.js';
import {
  canAssignRole,
  canManageUser,
  isRole,
  type Actor,
  type Role,
  type UserAction,
} from '../security/permissions.js';

export type UserOpResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string; field?: string };

const fail = (
  status: 400 | 403 | 404 | 409,
  message: string,
  field?: string,
): { ok: false; status: 400 | 403 | 404 | 409; message: string; field?: string } => ({
  ok: false,
  status,
  message,
  ...(field ? { field } : {}),
});

const actorId = (actor: Actor): string => `user:${actor.id}`;

/** A readable temporary password with no look-alike characters, for the "must change" flow. */
export function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[randomInt(alphabet.length)] as string;
  const group = () => Array.from({ length: 5 }, pick).join('');
  return `${group()}-${group()}-${group()}`;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: string;
  password: string;
}

export async function createManagedUser(
  svc: AdminServices,
  actor: Actor,
  input: CreateUserInput,
  info: RequestInfo,
): Promise<UserOpResult<AdminUserRecord>> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!isValidEmail(email)) return fail(400, 'Enter a valid email address.', 'email');
  if (displayName.length < 1 || displayName.length > 80) {
    return fail(400, 'Enter a name of 1 to 80 characters.', 'displayName');
  }
  if (!isRole(input.role) || !canAssignRole(actor.role, input.role)) {
    return fail(403, 'You cannot give that role.', 'role');
  }
  const problem = passwordProblem(input.password, { email, displayName });
  if (problem) return fail(400, problem, 'password');

  const created = await insertUser(svc.pool, {
    email,
    displayName,
    passwordHash: await svc.hasher.hash(input.password),
    role: input.role,
    mustChangePassword: true,
  });
  if (!created) return fail(409, 'An account with that email already exists.', 'email');
  await writeAudit(svc.pool, {
    actor: actorId(actor),
    action: 'user.created',
    entity: 'admin_user',
    entityId: created.id,
    metadata: { role: created.role },
    ip: info.ip,
  });
  return { ok: true, value: created };
}

async function loadManaged(
  svc: AdminServices,
  actor: Actor,
  targetId: string,
  action: UserAction,
): Promise<UserOpResult<AdminUserRecord>> {
  const target = await findUserById(svc.pool, targetId);
  if (!target) return fail(404, 'That account does not exist.');
  if (!canManageUser(actor, target, action)) {
    return fail(403, 'You do not have permission to do that to this account.');
  }
  return { ok: true, value: target };
}

/**
 * Runs a change on an owner under a lock, so two owners cannot remove each other at the
 * same moment and leave the site without one.
 */
async function withOwnerLock<T>(
  svc: AdminServices,
  work: (activeOwners: number, db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await svc.pool.connect();
  try {
    await client.query('BEGIN');
    const owners = await client.query(
      "SELECT id FROM admin_users WHERE role = 'owner' AND active FOR UPDATE",
    );
    const result = await work(owners.rowCount ?? 0, client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function changeUserRole(
  svc: AdminServices,
  actor: Actor,
  targetId: string,
  newRole: string,
  info: RequestInfo,
): Promise<UserOpResult> {
  const loaded = await loadManaged(svc, actor, targetId, 'change-role');
  if (!loaded.ok) return loaded;
  const target = loaded.value;
  if (!isRole(newRole) || !canAssignRole(actor.role, newRole)) {
    return fail(403, 'You cannot give that role.', 'role');
  }
  if (newRole === target.role) return fail(400, 'That account already has this role.', 'role');

  const outcome = await withOwnerLock(svc, async (activeOwners, db) => {
    if (target.role === 'owner' && target.active && activeOwners <= 1) return false;
    await setRole(db, target.id, newRole);
    return true;
  });
  if (!outcome) return fail(409, 'There must always be at least one active owner.');

  // A role change takes effect at once: every session of that person ends.
  await revokeUserSessions(svc.pool, target.id);
  await writeAudit(svc.pool, {
    actor: actorId(actor),
    action: 'user.role_changed',
    entity: 'admin_user',
    entityId: target.id,
    metadata: { from: target.role, to: newRole },
    ip: info.ip,
  });
  return { ok: true, value: undefined };
}

export async function setUserActive(
  svc: AdminServices,
  actor: Actor,
  targetId: string,
  active: boolean,
  info: RequestInfo,
): Promise<UserOpResult> {
  const loaded = await loadManaged(svc, actor, targetId, active ? 'reactivate' : 'deactivate');
  if (!loaded.ok) return loaded;
  const target = loaded.value;
  if (target.active === active) {
    return fail(
      400,
      active ? 'That account is already active.' : 'That account is already inactive.',
    );
  }

  const outcome = await withOwnerLock(svc, async (activeOwners, db) => {
    if (!active && target.role === 'owner' && activeOwners <= 1) return false;
    await setActive(db, target.id, active);
    return true;
  });
  if (!outcome) return fail(409, 'There must always be at least one active owner.');

  if (!active) await revokeUserSessions(svc.pool, target.id);
  await writeAudit(svc.pool, {
    actor: actorId(actor),
    action: active ? 'user.reactivated' : 'user.deactivated',
    entity: 'admin_user',
    entityId: target.id,
    ip: info.ip,
  });
  return { ok: true, value: undefined };
}

export async function resetUserTwoStep(
  svc: AdminServices,
  actor: Actor,
  targetId: string,
  info: RequestInfo,
): Promise<UserOpResult> {
  const loaded = await loadManaged(svc, actor, targetId, 'reset-two-step');
  if (!loaded.ok) return loaded;
  const target = loaded.value;
  await clearTotp(svc.pool, target.id);
  await revokeUserSessions(svc.pool, target.id);
  await writeAudit(svc.pool, {
    actor: actorId(actor),
    action: 'two_step.reset',
    entity: 'admin_user',
    entityId: target.id,
    ip: info.ip,
  });
  return { ok: true, value: undefined };
}

export type { Role };
