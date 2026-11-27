import pg from 'pg';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/admin/bootstrap.js';
import { createAdminServices } from '../src/admin/services.js';
import { findUserByEmail } from '../src/admin/users.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS_DIR } from '../src/lib/paths.js';
import { MemoryRateLimitStore } from '../src/security/rate-limit-store.js';
import { PostgresRateLimitStore } from '../src/security/pg-rate-limit-store.js';
import { BASE, GOOD_PASSWORD, signIn, startAdmin, type AdminHarness } from './helpers/admin.js';
import { captureLogger, SLUG, testConfig } from './helpers/app.js';
import { createTestDatabase, type TestDatabase } from './helpers/db.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(env: Record<string, string>) {
  const db: TestDatabase = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: db.url, max: 5 });
  const { logger, lines } = captureLogger();
  await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
  const config = testConfig({ ADMIN_REQUIRE_2FA: 'false', ...env }, db.url);
  const store = new PostgresRateLimitStore(pool, { maxRows: 100, pruneIntervalMs: 0 });
  const svc = createAdminServices({ config, logger, pool, store });
  cleanups.push(async () => {
    store.close();
    await pool.end();
    await db.drop();
  });
  return { pool, svc: svc!, lines, config, logger, store };
}

const audit = async (pool: pg.Pool, action: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE action = $1', [action])).rows[0]
    .n as number;

describe('first owner', () => {
  it('is created from the environment only when no admin users exist, with the change flag and an audit event', async () => {
    const { pool, svc, lines } = await boot({
      ADMIN_INITIAL_EMAIL: 'First@Example.com',
      ADMIN_INITIAL_PASSWORD: 'a long unusual passphrase 91',
    });
    await bootstrapAdmin(svc);
    const owner = await findUserByEmail(pool, 'first@example.com');
    expect(owner?.role).toBe('owner');
    expect(owner?.mustChangePassword).toBe(true);
    expect(owner?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await audit(pool, 'system.first_owner_created')).toBe(1);
    const joined = lines.join('\n');
    expect(joined).toContain('REMOVE the ADMIN_INITIAL_PASSWORD');
    expect(joined).not.toContain('a long unusual passphrase 91');
  });

  it('ignores the initial variables once any admin user exists', async () => {
    const { pool, svc } = await boot({
      ADMIN_INITIAL_EMAIL: 'second@example.com',
      ADMIN_INITIAL_PASSWORD: 'a long unusual passphrase 91',
    });
    await pool.query(
      `INSERT INTO admin_users (email, display_name, password_hash, role) VALUES ('existing@example.com','E','x','editor')`,
    );
    await bootstrapAdmin(svc);
    expect(await findUserByEmail(pool, 'second@example.com')).toBeNull();
    await bootstrapAdmin(svc);
    expect((await pool.query('SELECT count(*)::int AS n FROM admin_users')).rows[0].n).toBe(1);
  });

  it('does not create an owner from a weak initial password, and says why without crashing', async () => {
    const { pool, svc, lines } = await boot({
      ADMIN_INITIAL_EMAIL: 'weak@example.com',
      ADMIN_INITIAL_PASSWORD: 'password123456',
    });
    await bootstrapAdmin(svc);
    expect(await findUserByEmail(pool, 'weak@example.com')).toBeNull();
    expect(lines.join('\n')).toContain('ADMIN_INITIAL_PASSWORD was rejected');
  });

  it('lets the founder sign in and must change the password before anything else', async () => {
    const h: AdminHarness = await startAdmin({ ADMIN_REQUIRE_2FA: 'false' });
    cleanups.push(() => h.close());
    await h.user({ email: 'founder@example.com', role: 'owner', mustChange: true });
    const agent = h.agent();
    expect((await signIn(agent, 'founder@example.com')).status).toBe(303);
    expect((await agent.get(`${BASE}/`)).headers.location).toBe(`${BASE}/password`);
  });
});

describe('emergency recovery', () => {
  async function seeded(env: Record<string, string>) {
    const ctx = await boot({
      ADMIN_INITIAL_EMAIL: 'owner@example.com',
      ADMIN_INITIAL_PASSWORD: 'a brand new rescue passphrase 55',
      ...env,
    });
    const hash = await ctx.svc.hasher.hash(GOOD_PASSWORD);
    await ctx.pool.query(
      `INSERT INTO admin_users (email, display_name, password_hash, role, totp_secret_encrypted, totp_enabled_at)
       VALUES ('owner@example.com','Owner',$1,'owner','v1.x.y.z', now()),
              ('other@example.com','Other',$1,'admin','v1.x.y.z', now())`,
      [hash],
    );
    const owner = (await findUserByEmail(ctx.pool, 'owner@example.com'))!;
    await ctx.pool.query(
      `INSERT INTO admin_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at) VALUES ($1,'h1', now() + interval '1 hour', now() + interval '1 hour')`,
      [owner.id],
    );
    return ctx;
  }

  it('does nothing when the setting is absent or false', async () => {
    for (const env of [{} as Record<string, string>, { ADMIN_EMERGENCY_RESET: 'false' }]) {
      const { pool, svc } = await seeded(env);
      await bootstrapAdmin(svc);
      const owner = (await findUserByEmail(pool, 'owner@example.com'))!;
      expect(await svc.hasher.verify(owner.passwordHash, GOOD_PASSWORD)).toBe(true);
      expect(owner.twoStepEnabled).toBe(true);
      expect(await audit(pool, 'system.emergency_recovery')).toBe(0);
    }
  });

  it('replaces the owner password, clears two-step, revokes sessions, sets the change flag and never touches other accounts', async () => {
    const { pool, svc, lines } = await seeded({ ADMIN_EMERGENCY_RESET: 'true' });
    const otherBefore = (await findUserByEmail(pool, 'other@example.com'))!;
    await bootstrapAdmin(svc);
    const owner = (await findUserByEmail(pool, 'owner@example.com'))!;
    expect(await svc.hasher.verify(owner.passwordHash, 'a brand new rescue passphrase 55')).toBe(
      true,
    );
    expect(owner.twoStepEnabled).toBe(false);
    expect(owner.mustChangePassword).toBe(true);
    const live = await pool.query(
      `SELECT count(*)::int AS n FROM admin_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [owner.id],
    );
    expect(live.rows[0].n).toBe(0);
    const otherAfter = (await findUserByEmail(pool, 'other@example.com'))!;
    expect(otherAfter.passwordHash).toBe(otherBefore.passwordHash);
    expect(otherAfter.twoStepEnabled).toBe(true);
    expect(await audit(pool, 'system.emergency_recovery')).toBe(1);
    const joined = lines.join('\n');
    expect(joined).toContain('EMERGENCY RECOVERY APPLIED');
    expect(joined).toContain('ADMIN_EMERGENCY_RESET to false');
    expect(joined).not.toContain('a brand new rescue passphrase 55');
  });

  it('does nothing when the email belongs to a non-owner or to nobody', async () => {
    const a = await seeded({
      ADMIN_EMERGENCY_RESET: 'true',
      ADMIN_INITIAL_EMAIL: 'other@example.com',
    });
    await bootstrapAdmin(a.svc);
    const other = (await findUserByEmail(a.pool, 'other@example.com'))!;
    expect(await a.svc.hasher.verify(other.passwordHash, GOOD_PASSWORD)).toBe(true);
    const b = await seeded({
      ADMIN_EMERGENCY_RESET: 'true',
      ADMIN_INITIAL_EMAIL: 'nobody@example.com',
    });
    await bootstrapAdmin(b.svc);
    expect(await audit(b.pool, 'system.emergency_recovery')).toBe(0);
  });

  it('lets the owner sign in with the new password only', async () => {
    const h = await startAdmin({
      ADMIN_REQUIRE_2FA: 'false',
      ADMIN_INITIAL_EMAIL: 'owner@example.com',
      ADMIN_INITIAL_PASSWORD: 'a brand new rescue passphrase 55',
      ADMIN_EMERGENCY_RESET: 'true',
    });
    cleanups.push(() => h.close());
    await h.user({ email: 'owner@example.com', role: 'owner' });
    await bootstrapAdmin(h.svc);
    expect((await signIn(h.agent(), 'owner@example.com', GOOD_PASSWORD)).status).toBe(401);
    expect(
      (await signIn(h.agent(), 'owner@example.com', 'a brand new rescue passphrase 55')).status,
    ).toBe(303);
  });
});

describe('admin not configured', () => {
  it('answers 503 on every admin route while the public site keeps working, and never crashes or leaks the value', async () => {
    const bad = 'not-a-valid-secret!!';
    const { logger, lines } = captureLogger();
    const config = testConfig({ ADMIN_SECRET_KEY: bad });
    expect(config.admin.secretKey).toBeNull();
    expect(config.admin.secretKeyProblem).toMatch(/ADMIN_SECRET_KEY/);
    expect(config.admin.secretKeyProblem).not.toContain(bad);
    const services = createAdminServices({
      config,
      logger,
      pool: new pg.Pool({ host: '127.0.0.1', port: 1 }),
      store: new MemoryRateLimitStore({ maxKeys: 10, pruneIntervalMs: 0 }),
    });
    expect(services).toBeNull();
    const app = createApp({
      config,
      logger,
      pool: new pg.Pool({ host: '127.0.0.1', port: 1 }),
      adminServices: null,
    });
    for (const path of ['', '/login', '/users', '/audit', '/anything']) {
      const res = await request(app).get(`/${SLUG}${path}`);
      expect(res.status, path).toBe(503);
      expect(res.text).toContain('Admin is not configured');
    }
    const post = await request(app).post(`/${SLUG}/login`).send({});
    expect(post.status).toBe(503);
    const home = await request(app).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Allovity');
    expect(lines.join('\n')).not.toContain(bad);
  });

  it('is reported by the settings loader as a warning-free load that still names the variable', () => {
    const missing = testConfig({ ADMIN_SECRET_KEY: '' });
    expect(missing.admin.secretKey).toBeNull();
    expect(missing.admin.secretKeyProblem).toBe('ADMIN_SECRET_KEY is not set');
  });
});
