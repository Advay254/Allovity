import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import type { Logger } from '../lib/logger.js';

/** Arbitrary constant shared by every instance so only one runs migrations at a time. */
const ADVISORY_LOCK_KEY = 727_410_001;
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|start\s+transaction)\b/im;

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Drops comments and dollar-quoted bodies (function code may legitimately say BEGIN). */
function stripForTransactionCheck(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '');
}

function listMigrationFiles(dir: string): string[] {
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql'));
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) {
      throw new MigrationError(`Migration file name "${name}" must look like 0001_description.sql`);
    }
  }
  return names.sort();
}

/**
 * Applies numbered SQL files in order. Each file runs in its own transaction and is
 * recorded in schema_migrations. An advisory lock makes concurrent starts safe: the
 * second instance waits, then finds everything already applied.
 */
export async function runMigrations(
  pool: pg.Pool,
  options: { dir: string; logger: Logger },
): Promise<MigrationResult> {
  const { dir, logger } = options;
  const files = listMigrationFiles(dir);
  const result: MigrationResult = { applied: [], skipped: [] };

  const client = await pool.connect();
  let broken = false;
  try {
    // Migrations may legitimately run longer than the normal query timeout.
    await client.query("SET statement_timeout = '300s'");
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const existing = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map(existing.rows.map((row) => [row.filename, row.checksum]));

    for (const filename of files) {
      const sql = readFileSync(join(dir, filename), 'utf8');
      const sum = checksum(sql);
      const recorded = applied.get(filename);

      if (recorded !== undefined) {
        if (recorded !== sum) {
          throw new MigrationError(
            `Migration ${filename} was changed after it was applied. Revert the edit and add a new numbered migration instead.`,
          );
        }
        result.skipped.push(filename);
        continue;
      }
      if (TRANSACTION_CONTROL.test(stripForTransactionCheck(sql))) {
        throw new MigrationError(
          `Migration ${filename} contains BEGIN, COMMIT or ROLLBACK. The runner manages the transaction.`,
        );
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          sum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(`Migration ${filename} failed and was rolled back`, {
          cause: error,
        });
      }
      result.applied.push(filename);
      logger.info('Migration applied', { migration: filename });
    }

    if (result.applied.length === 0) logger.info('Database schema is up to date');
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {
      broken = true;
    });
    await client.query('RESET statement_timeout').catch(() => {
      broken = true;
    });
    client.release(broken);
  }
}
