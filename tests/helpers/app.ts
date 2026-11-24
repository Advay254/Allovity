import pg from 'pg';
import { createApp, type AppDependencies } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';

export const SLUG = 'k3x9Qm7vT2pLw8Zr4NbY';
export const SITE_URL = 'https://allovity.test';

export function testConfig(
  overrides: Record<string, string> = {},
  databaseUrl?: string,
): AppConfig {
  return loadConfig({
    DATABASE_URL: databaseUrl ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    PUBLIC_SITE_URL: SITE_URL,
    ADMIN_PATH_SLUG: SLUG,
    NODE_ENV: 'test',
    ...overrides,
  }).config;
}

export function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  return { logger, lines };
}

/** A pool that can never connect, to simulate a database outage. */
export function deadPool(): pg.Pool {
  return new pg.Pool({
    host: '127.0.0.1',
    port: 1,
    user: 'x',
    database: 'x',
    connectionTimeoutMillis: 500,
  });
}

export function buildTestApp(
  overrides: Partial<AppDependencies> & { env?: Record<string, string> } = {},
) {
  const { env, ...rest } = overrides;
  const { logger, lines } = captureLogger();
  const config = testConfig(env);
  const pool = rest.pool ?? deadPool();
  const app = createApp({ config, logger, pool, ...rest });
  return { app, config, pool, lines };
}
