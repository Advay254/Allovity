import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAdminServices, type AdminServices } from '../../src/admin/services.js';
import {
  insertUser,
  setPendingTotp,
  enableTotp,
  type AdminUserRecord,
} from '../../src/admin/users.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MIGRATIONS_DIR } from '../../src/lib/paths.js';
import { encryptText } from '../../src/security/crypto.js';
import { PostgresRateLimitStore } from '../../src/security/pg-rate-limit-store.js';
import type { Role } from '../../src/security/permissions.js';
import { generateSecretBase32, codeAt } from '../../src/security/totp.js';
import { captureLogger, SITE_URL, SLUG, testConfig } from './app.js';
import { createTestDatabase, type TestDatabase } from './db.js';

export const BASE = `/${SLUG}`;
export const GOOD_PASSWORD = 'correct horse battery 42';

export interface AdminHarness {
  db: TestDatabase;
  pool: pg.Pool;
  svc: AdminServices;
  app: ReturnType<typeof createApp>;
  lines: string[];
  clock: { now: number };
  store: PostgresRateLimitStore;
  close(): Promise<void>;
  user(input: UserInput): Promise<AdminUserRecord & { totpSecret?: string }>;
  agent(): ReturnType<typeof request.agent>;
}

export interface UserInput {
  email: string;
  name?: string;
  role?: Role;
  password?: string;
  mustChange?: boolean;
  twoStep?: boolean;
  active?: boolean;
}

export async function startAdmin(
  env: Record<string, string> = {},
  options: { fakeClock?: boolean } = {},
): Promise<AdminHarness> {
  const db = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const { logger, lines } = captureLogger();
  await runMigrations(pool, { dir: MIGRATIONS_DIR, logger });
  const config = testConfig(env, db.url);
  const clock = { now: Date.now() };
  const store = new PostgresRateLimitStore(pool, { maxRows: 5000, pruneIntervalMs: 0 });
  const svc = createAdminServices({
    config,
    logger,
    pool,
    store,
    ...(options.fakeClock ? { now: () => clock.now } : {}),
    requestLimit: { max: 100000, windowMs: 60_000 },
  });
  const app = createApp({ config, logger, pool, adminServices: svc });

  return {
    db,
    pool,
    svc: svc as AdminServices,
    app,
    lines,
    clock,
    store,
    async close() {
      store.close();
      await pool.end();
      await db.drop();
    },
    async user(input) {
      const record = await insertUser(pool, {
        email: input.email,
        displayName: input.name ?? 'Test User',
        passwordHash: await (svc as AdminServices).hasher.hash(input.password ?? GOOD_PASSWORD),
        role: input.role ?? 'admin',
        mustChangePassword: input.mustChange ?? false,
      });
      if (!record) throw new Error('user exists');
      if (input.active === false) {
        await pool.query('UPDATE admin_users SET active = false WHERE id = $1', [record.id]);
      }
      if (input.twoStep) {
        const secret = generateSecretBase32();
        await setPendingTotp(
          pool,
          record.id,
          encryptText((svc as AdminServices).keys.totp, secret),
        );
        await enableTotp(pool, record.id, 0);
        return { ...record, totpSecret: secret };
      }
      return record;
    },
    agent: () => request.agent(app),
  };
}

export type Agent = ReturnType<typeof request.agent>;

export function csrfIn(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('no csrf token in page');
  return match[1] as string;
}

/** Fetches a page to obtain a token, then posts the form with a same-site Origin header. */
export async function postForm(
  agent: Agent,
  tokenPage: string,
  path: string,
  fields: Record<string, string>,
) {
  const page = await agent.get(`${BASE}${tokenPage}`);
  const token = csrfIn(page.text);
  return agent
    .post(`${BASE}${path}`)
    .set('Origin', SITE_URL)
    .type('form')
    .send({ _csrf: token, ...fields });
}

export const signIn = (agent: Agent, email: string, password = GOOD_PASSWORD) =>
  postForm(agent, '/login', '/login', { email, password });

export function currentCode(secret: string, offsetSteps = 0): string {
  return codeAt(secret, Date.now() + offsetSteps * 30_000);
}

/** Signs in with two-step verification and returns the agent holding the full session. */
export async function signInFully(
  harness: AdminHarness,
  email: string,
  secret?: string,
  password = GOOD_PASSWORD,
  stepOffset = 0,
): Promise<Agent> {
  const agent = harness.agent();
  const first = await signIn(agent, email, password);
  if (first.headers.location?.endsWith('/login/two-step') && secret) {
    const second = await postForm(agent, '/login/two-step', '/login/two-step', {
      code: currentCode(secret, stepOffset),
    });
    if (second.status !== 303) throw new Error(`two-step failed: ${second.status}`);
  }
  return agent;
}

export function cookieValue(
  res: { headers: Record<string, unknown> },
  name: string,
): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  for (const entry of list) {
    if (entry.startsWith(`${name}=`)) return entry.split(';')[0]!.slice(name.length + 1);
  }
  return null;
}
