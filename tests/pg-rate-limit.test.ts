import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS_DIR } from '../src/lib/paths.js';
import { PostgresRateLimitStore } from '../src/security/pg-rate-limit-store.js';
import { MemoryRateLimitStore } from '../src/security/rate-limit-store.js';
import { captureLogger } from './helpers/app.js';
import { createTestDatabase, type TestDatabase } from './helpers/db.js';

let db: TestDatabase;
let pool: pg.Pool;
beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 12 });
  await runMigrations(pool, { dir: MIGRATIONS_DIR, logger: captureLogger().logger });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

const make = (maxRows = 1000) => new PostgresRateLimitStore(pool, { maxRows, pruneIntervalMs: 0 });

describe('postgres rate limit store', () => {
  it('counts the same way as the memory store', async () => {
    const pgStore = make();
    const mem = new MemoryRateLimitStore({ maxKeys: 100, pruneIntervalMs: 0 });
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i += 1) {
      expect((await pgStore.increment('same', 10_000, t0)).count).toBe(
        (await mem.increment('same', 10_000, t0)).count,
      );
    }
    const later = Math.floor(t0 / 10_000) * 10_000 + 15_000;
    expect((await pgStore.increment('same', 10_000, later)).count).toBe(
      (await mem.increment('same', 10_000, later)).count,
    );
    expect((await pgStore.increment('same', 10_000, later + 25_000)).count).toBe(1);
  });

  it('is atomic under concurrent calls: no hit is lost', async () => {
    const store = make();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => store.increment('burst', 60_000, 5_000_000)),
    );
    expect(Math.max(...results.map((r) => r.count))).toBe(40);
    expect(new Set(results.map((r) => r.count)).size).toBe(40);
  });

  it('peek reads without counting', async () => {
    const store = make();
    await store.increment('peeked', 60_000, 9_000_000);
    expect((await store.peek('peeked', 60_000, 9_000_000)).count).toBe(1);
    expect((await store.peek('peeked', 60_000, 9_000_000)).count).toBe(1);
    expect((await store.peek('never-seen', 60_000, 9_000_000)).count).toBe(0);
    expect(
      (await new MemoryRateLimitStore({ maxKeys: 5, pruneIntervalMs: 0 }).peek!('x', 1000, 1))
        .count,
    ).toBe(0);
  });

  it('prunes expired rows', async () => {
    const store = make();
    await store.increment('old-a', 1000, 1_000);
    await store.increment('old-b', 1000, 1_000);
    await store.increment('fresh', 1000, Date.now());
    const removed = await store.prune(Date.now());
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = await pool.query(
      `SELECT key FROM rate_limit_hits WHERE key IN ('old-a','old-b','fresh')`,
    );
    expect(left.rows.map((r) => r.key)).toEqual(['fresh']);
  });

  it('never keeps more rows than its hard cap', async () => {
    await pool.query('TRUNCATE rate_limit_hits');
    const store = new PostgresRateLimitStore(pool, {
      maxRows: 30,
      pruneIntervalMs: 0,
      capCheckEvery: 5,
    });
    for (let i = 0; i < 200; i += 1) await store.increment(`flood-${i}`, 60_000, Date.now());
    await store.enforceCap();
    const count = await pool.query('SELECT count(*)::int AS n FROM rate_limit_hits');
    expect(count.rows[0].n).toBeLessThanOrEqual(30);
  });
});
