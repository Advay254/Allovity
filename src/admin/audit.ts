import type pg from 'pg';
import net from 'node:net';
import { SECRET_KEY_PATTERN } from '../lib/logger.js';

export type AuditAction =
  | 'auth.sign_in'
  | 'auth.sign_in_failed'
  | 'auth.throttled'
  | 'auth.sign_out'
  | 'auth.two_step_failed'
  | 'session.revoked'
  | 'session.revoked_all'
  | 'password.changed'
  | 'password.forced_change'
  | 'two_step.enrolled'
  | 'two_step.disabled'
  | 'two_step.reset'
  | 'recovery_code.used'
  | 'recovery_code.regenerated'
  | 'user.created'
  | 'user.role_changed'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.password_reset'
  | 'system.first_owner_created'
  | 'system.emergency_recovery';

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'auth.sign_in',
  'auth.sign_in_failed',
  'auth.throttled',
  'auth.sign_out',
  'auth.two_step_failed',
  'session.revoked',
  'session.revoked_all',
  'password.changed',
  'password.forced_change',
  'two_step.enrolled',
  'two_step.disabled',
  'two_step.reset',
  'recovery_code.used',
  'recovery_code.regenerated',
  'user.created',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
  'user.password_reset',
  'system.first_owner_created',
  'system.emergency_recovery',
];

export interface AuditEvent {
  /** `user:<id>`, `system` or `anonymous`. */
  actor: string;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

const MAX_VALUE_LENGTH = 200;

/** Drops secret-looking keys and long values so the row always fits the size limit. */
export function cleanMetadata(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (count >= 20) break;
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'string') output[key] = value.slice(0, MAX_VALUE_LENGTH);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    } else continue;
    count += 1;
  }
  return output;
}

export interface Queryable {
  query: pg.Pool['query'];
}

/** Writes one event. A failure is returned, never thrown, so auditing cannot break a request. */
export async function writeAudit(db: Queryable, event: AuditEvent): Promise<boolean> {
  const ip = event.ip && net.isIP(event.ip) ? event.ip : null;
  try {
    await db.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        event.actor,
        event.action,
        event.entity,
        event.entityId ?? null,
        JSON.stringify(cleanMetadata(event.metadata)),
        ip,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
}

export const AUDIT_PAGE_SIZE = 25;

export async function listAudit(
  db: Queryable,
  filter: { action?: string; actor?: string; page: number },
): Promise<{ rows: AuditRow[]; hasMore: boolean }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.action) {
    params.push(filter.action);
    where.push(`action = $${params.length}`);
  }
  if (filter.actor) {
    params.push(filter.actor);
    where.push(`actor = $${params.length}`);
  }
  params.push(AUDIT_PAGE_SIZE + 1, (Math.max(1, filter.page) - 1) * AUDIT_PAGE_SIZE);
  const result = await db.query(
    `SELECT id::text, actor, action, entity, entity_id, metadata, host(ip_address) AS ip, created_at
     FROM audit_log
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const rows = result.rows.map((row): AuditRow => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    metadata: row.metadata,
    ip: row.ip,
    createdAt: row.created_at,
  }));
  return { rows: rows.slice(0, AUDIT_PAGE_SIZE), hasMore: rows.length > AUDIT_PAGE_SIZE };
}
