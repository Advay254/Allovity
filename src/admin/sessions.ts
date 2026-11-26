import { randomToken, sha256Hex } from '../security/crypto.js';
import type { Queryable } from './audit.js';
import { findUserById, type AdminUserRecord } from './users.js';

export interface AdminSession {
  id: string;
  userId: string;
  stage: 'pending' | 'active';
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  reauthenticatedAt: Date | null;
}

export interface SessionTimings {
  idleMs: number;
  absoluteMs: number;
}

/** A pending session only has to survive the time it takes to type a code. */
export const PENDING_LIFETIME_MS = 10 * 60_000;
export const REAUTH_WINDOW_MS = 5 * 60_000;

const COLUMNS = `s.id, s.user_id, s.stage, s.created_at, s.last_seen_at, s.idle_expires_at,
  s.absolute_expires_at, host(s.ip_address) AS ip, s.user_agent, s.reauthenticated_at`;

function toSession(row: Record<string, unknown>): AdminSession {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    stage: row.stage as 'pending' | 'active',
    createdAt: row.created_at as Date,
    lastSeenAt: row.last_seen_at as Date,
    idleExpiresAt: row.idle_expires_at as Date,
    absoluteExpiresAt: row.absolute_expires_at as Date,
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    reauthenticatedAt: (row.reauthenticated_at as Date | null) ?? null,
  };
}

export interface NewSession {
  userId: string;
  stage: 'pending' | 'active';
  ip: string | null;
  userAgent: string | null;
  reauthenticatedAt: Date | null;
  /** Keeps the original hard limit when a session is rotated. */
  absoluteExpiresAt?: Date;
}

/** Creates a session and returns its one-time token. Only the hash is stored. */
export async function createSession(
  db: Queryable,
  input: NewSession,
  timings: SessionTimings,
  now = Date.now(),
): Promise<{ token: string; id: string }> {
  const token = randomToken(32);
  const idleMs = input.stage === 'pending' ? PENDING_LIFETIME_MS : timings.idleMs;
  const absolute =
    input.absoluteExpiresAt ??
    new Date(now + (input.stage === 'pending' ? PENDING_LIFETIME_MS : timings.absoluteMs));
  const res = await db.query(
    `INSERT INTO admin_sessions
       (user_id, token_hash, stage, idle_expires_at, absolute_expires_at, ip_address, user_agent, reauthenticated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.userId,
      sha256Hex(token),
      input.stage,
      new Date(Math.min(now + idleMs, absolute.getTime())),
      absolute,
      input.ip && input.ip !== 'unknown' ? input.ip : null,
      input.userAgent ? input.userAgent.slice(0, 200) : null,
      input.reauthenticatedAt,
    ],
  );
  return { token, id: res.rows[0].id as string };
}

export interface LoadedSession {
  session: AdminSession;
  user: AdminUserRecord;
}

/** Finds a live session for a cookie token. Expired, revoked or inactive-user sessions return null. */
export async function loadSession(
  db: Queryable,
  token: string,
  now = Date.now(),
): Promise<LoadedSession | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const res = await db.query(
    `SELECT ${COLUMNS} FROM admin_sessions s
     JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.active
       AND s.idle_expires_at > $2 AND s.absolute_expires_at > $2`,
    [sha256Hex(token), new Date(now)],
  );
  if (!res.rows[0]) return null;
  const session = toSession(res.rows[0]);
  const user = await findUserById(db, session.userId);
  return user ? { session, user } : null;
}

/** Extends the idle timer, at most once a minute, never past the absolute limit. */
export async function touchSession(
  db: Queryable,
  session: AdminSession,
  idleMs: number,
  now = Date.now(),
): Promise<void> {
  if (now - session.lastSeenAt.getTime() < 60_000) return;
  await db.query(
    `UPDATE admin_sessions
     SET last_seen_at = $2, idle_expires_at = LEAST($3::timestamptz, absolute_expires_at)
     WHERE id = $1`,
    [session.id, new Date(now), new Date(now + idleMs)],
  );
}

export async function revokeSession(db: Queryable, id: string): Promise<void> {
  await db.query(
    'UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
}

/** Revokes every live session of a user, optionally keeping one. Returns how many were revoked. */
export async function revokeUserSessions(
  db: Queryable,
  userId: string,
  exceptId?: string,
): Promise<number> {
  const res = await db.query(
    `UPDATE admin_sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptId ?? null],
  );
  return res.rowCount ?? 0;
}

export async function markReauthenticated(
  db: Queryable,
  id: string,
  now = Date.now(),
): Promise<void> {
  await db.query('UPDATE admin_sessions SET reauthenticated_at = $2 WHERE id = $1', [
    id,
    new Date(now),
  ]);
}

export function recentlyReauthenticated(session: AdminSession, now = Date.now()): boolean {
  return (
    session.reauthenticatedAt !== null &&
    now - session.reauthenticatedAt.getTime() <= REAUTH_WINDOW_MS
  );
}

export async function listActiveSessions(
  db: Queryable,
  userId: string,
  now = Date.now(),
): Promise<AdminSession[]> {
  const res = await db.query(
    `SELECT ${COLUMNS} FROM admin_sessions s
     WHERE s.user_id = $1 AND s.stage = 'active' AND s.revoked_at IS NULL
       AND s.idle_expires_at > $2 AND s.absolute_expires_at > $2
     ORDER BY s.last_seen_at DESC`,
    [userId, new Date(now)],
  );
  return res.rows.map(toSession);
}

export async function pruneSessions(db: Queryable): Promise<number> {
  const res = await db.query(
    `DELETE FROM admin_sessions
     WHERE absolute_expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`,
  );
  return res.rowCount ?? 0;
}

/** Shortens a user agent to something readable such as "Chrome on Android". */
export function describeAgent(agent: string | null): string {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\/|Opera/.test(agent)
      ? 'Opera'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Browser';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad|iOS/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'unknown system';
  return `${browser} on ${system}`;
}
