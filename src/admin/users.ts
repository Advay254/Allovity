import type pg from 'pg';
import type { Role } from '../security/permissions.js';
import type { Queryable } from './audit.js';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  twoStepEnabled: boolean;
  twoStepPending: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AdminUserRecord extends AdminUser {
  passwordHash: string;
  totpSecretEncrypted: string | null;
  totpLastStep: number | null;
}

const COLUMNS = `id, email, display_name, password_hash, role, active, must_change_password,
  totp_secret_encrypted, totp_enabled_at, totp_last_step, last_login_at, created_at`;

function toRecord(row: Record<string, unknown>): AdminUserRecord {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    passwordHash: row.password_hash as string,
    role: row.role as Role,
    active: row.active as boolean,
    mustChangePassword: row.must_change_password as boolean,
    totpSecretEncrypted: (row.totp_secret_encrypted as string | null) ?? null,
    twoStepEnabled: row.totp_enabled_at !== null && row.totp_enabled_at !== undefined,
    twoStepPending:
      (row.totp_enabled_at === null || row.totp_enabled_at === undefined) &&
      row.totp_secret_encrypted !== null &&
      row.totp_secret_encrypted !== undefined,
    totpLastStep:
      row.totp_last_step === null || row.totp_last_step === undefined
        ? null
        : Number(row.totp_last_step),
    lastLoginAt: (row.last_login_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

/** The part of a user that is safe to pass to views. */
export function publicUser(record: AdminUserRecord): AdminUser {
  const {
    passwordHash: _hash,
    totpSecretEncrypted: _secret,
    totpLastStep: _step,
    ...rest
  } = record;
  void _hash;
  void _secret;
  void _step;
  return rest;
}

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase().slice(0, 254);

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function findUserByEmail(
  db: Queryable,
  email: string,
): Promise<AdminUserRecord | null> {
  const res = await db.query(`SELECT ${COLUMNS} FROM admin_users WHERE email = $1`, [
    normalizeEmail(email),
  ]);
  return res.rows[0] ? toRecord(res.rows[0]) : null;
}

export async function findUserById(db: Queryable, id: string): Promise<AdminUserRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await db.query(`SELECT ${COLUMNS} FROM admin_users WHERE id = $1`, [id]);
  return res.rows[0] ? toRecord(res.rows[0]) : null;
}

export async function listUsers(db: Queryable): Promise<AdminUser[]> {
  const res = await db.query(
    `SELECT ${COLUMNS} FROM admin_users
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(display_name), email`,
  );
  return res.rows.map((row) => publicUser(toRecord(row)));
}

export async function countUsers(db: Queryable): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM admin_users');
  return res.rows[0].n as number;
}

export async function countActiveOwners(db: Queryable): Promise<number> {
  const res = await db.query(
    "SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active",
  );
  return res.rows[0].n as number;
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  mustChangePassword: boolean;
}

/** Returns null when the email is already taken. */
export async function insertUser(db: Queryable, user: NewUser): Promise<AdminUserRecord | null> {
  const res = await db.query(
    `INSERT INTO admin_users (email, display_name, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      normalizeEmail(user.email),
      user.displayName.trim(),
      user.passwordHash,
      user.role,
      user.mustChangePassword,
    ],
  );
  return res.rows[0] ? toRecord(res.rows[0]) : null;
}

export async function setPassword(
  db: Queryable,
  id: string,
  passwordHash: string,
  mustChange: boolean,
): Promise<void> {
  await db.query(
    'UPDATE admin_users SET password_hash = $2, must_change_password = $3, updated_at = now() WHERE id = $1',
    [id, passwordHash, mustChange],
  );
}

export async function setRole(db: Queryable, id: string, role: Role): Promise<void> {
  await db.query('UPDATE admin_users SET role = $2, updated_at = now() WHERE id = $1', [id, role]);
}

export async function setActive(db: Queryable, id: string, active: boolean): Promise<void> {
  await db.query('UPDATE admin_users SET active = $2, updated_at = now() WHERE id = $1', [
    id,
    active,
  ]);
}

/** Stores a pending (not yet confirmed) secret. Clears any earlier confirmation. */
export async function setPendingTotp(db: Queryable, id: string, encrypted: string): Promise<void> {
  await db.query(
    `UPDATE admin_users SET totp_secret_encrypted = $2, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = now()
     WHERE id = $1`,
    [id, encrypted],
  );
}

export async function enableTotp(db: Queryable, id: string, step: number): Promise<void> {
  await db.query(
    'UPDATE admin_users SET totp_enabled_at = now(), totp_last_step = $2, updated_at = now() WHERE id = $1',
    [id, step],
  );
}

export async function clearTotp(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE admin_users SET totp_secret_encrypted = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = now()
     WHERE id = $1`,
    [id],
  );
  await db.query('DELETE FROM admin_recovery_codes WHERE user_id = $1', [id]);
}

/** Atomically records a used time step. False means that code (or a later one) was already used. */
export async function consumeTotpStep(db: Queryable, id: string, step: number): Promise<boolean> {
  const res = await db.query(
    `UPDATE admin_users SET totp_last_step = $2
     WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [id, step],
  );
  return (res.rowCount ?? 0) === 1;
}

export async function touchLastLogin(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [id]);
}

/* Recovery codes ------------------------------------------------------------ */

export async function replaceRecoveryCodes(
  pool: pg.Pool,
  userId: string,
  hashes: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM admin_recovery_codes WHERE user_id = $1', [userId]);
    for (const hash of hashes) {
      await client.query('INSERT INTO admin_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
        userId,
        hash,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically marks one unused code as used. */
export async function consumeRecoveryCode(
  db: Queryable,
  userId: string,
  hash: string,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE admin_recovery_codes SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hash],
  );
  return (res.rowCount ?? 0) === 1;
}

export async function countRecoveryCodes(db: Queryable, userId: string): Promise<number> {
  const res = await db.query(
    'SELECT count(*)::int AS n FROM admin_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return res.rows[0].n as number;
}
