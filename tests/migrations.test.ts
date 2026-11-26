import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationError, runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS_DIR } from '../src/lib/paths.js';
import { captureLogger } from './helpers/app.js';
import { createTestDatabase, type TestDatabase } from './helpers/db.js';

const { logger } = captureLogger();
const pools: pg.Pool[] = [];
const newPool = (url: string) => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  return pool;
};

async function tables(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return res.rows.map((row) => row.tablename);
}

describe('migrations', () => {
  const databases: TestDatabase[] = [];
  const fresh = async () => {
    const db = await createTestDatabase();
    databases.push(db);
    return db;
  };

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await Promise.all(databases.map((db) => db.drop()));
  });

  it('creates the schema on a fresh empty database and nothing else', async () => {
    const db = await fresh();
    const pool = newPool(db.url);
    expect(await tables(pool)).toEqual([]);
    const result = await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
    expect(result.applied).toEqual(['0001_foundation.sql', '0002_admin_auth.sql']);
    expect(await tables(pool)).toEqual([
      'admin_recovery_codes',
      'admin_sessions',
      'admin_users',
      'audit_log',
      'rate_limit_hits',
      'schema_migrations',
      'site_settings',
    ]);
    const index = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'audit_log_created_at_idx'",
    );
    expect(index.rowCount).toBe(1);
  });

  it('is safe to repeat: a second boot applies nothing', async () => {
    const db = await fresh();
    const pool = newPool(db.url);
    await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
    const again = await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual(['0001_foundation.sql', '0002_admin_auth.sql']);
    const rows = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows.rows[0].n).toBe(2);
  });

  it('keeps the audit log append-only and its metadata small', async () => {
    const db = await fresh();
    const pool = newPool(db.url);
    await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
    await pool.query(
      "INSERT INTO audit_log (actor, action, entity, metadata, ip_address) VALUES ('system','test','x','{\"a\":1}','203.0.113.1')",
    );
    await expect(pool.query("UPDATE audit_log SET actor = 'other'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        "INSERT INTO audit_log (actor, action, entity, metadata) VALUES ('a','b','c','[1]')",
      ),
    ).rejects.toThrow();
  });

  it('rolls back a failing file and records nothing for it', async () => {
    const db = await fresh();
    const pool = newPool(db.url);
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '0001_foundation.sql'), join(dir, '0001_foundation.sql'));
    writeFileSync(
      join(dir, '0002_broken.sql'),
      'CREATE TABLE half_done (id int);\nINSERT INTO does_not_exist VALUES (1);\n',
    );
    await expect(runMigrations(pool, { dir, logger })).rejects.toThrow(MigrationError);
    expect(await tables(pool)).not.toContain('half_done');
    const recorded = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(recorded.rows.map((r) => r.filename)).toEqual(['0001_foundation.sql']);
  });

  it('is safe when several instances start at once', async () => {
    const db = await fresh();
    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runMigrations(newPool(db.url), { dir: MIGRATIONS_DIR, logger }),
      ),
    );
    const appliedTotal = runs.reduce((sum, run) => sum + run.applied.length, 0);
    expect(appliedTotal).toBe(2);
    const check = newPool(db.url);
    const rows = await check.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows.rows[0].n).toBe(2);
  });

  it('refuses to start when an applied migration was edited', async () => {
    const db = await fresh();
    const pool = newPool(db.url);
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS a (id int);\n');
    await runMigrations(pool, { dir, logger });
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS a (id int, extra int);\n');
    await expect(runMigrations(pool, { dir, logger })).rejects.toThrow(
      /changed after it was applied/,
    );
  });

  it('rejects files that manage their own transaction or have bad names', async () => {
    const db = await fresh();
    const pool = newPool(db.url);
    const dirA = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dirA, '0001_tx.sql'), 'BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n');
    await expect(runMigrations(pool, { dir: dirA, logger })).rejects.toThrow(/BEGIN, COMMIT/);
    const dirB = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dirB, 'create-stuff.sql'), 'SELECT 1;');
    await expect(runMigrations(pool, { dir: dirB, logger })).rejects.toThrow(/must look like/);
  });
});

beforeAll(() => undefined);
