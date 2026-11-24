import pg from 'pg';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../lib/logger.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const SSL_PARAMS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat'];

export interface PoolSettings {
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean };
}

/**
 * Decides how to reach the database. TLS is used by default for any non-local host
 * because managed hosts expect it, but certificates are only verified when
 * DATABASE_SSL_STRICT is on, so existing deployments keep working. The ssl* URL
 * parameters are stripped and replaced by an explicit setting so the driver cannot
 * silently change meaning between versions.
 */
export function resolvePoolSettings(
  config: Pick<AppConfig, 'databaseUrl' | 'databaseSsl' | 'databaseSslStrict'>,
): PoolSettings {
  const url = new URL(config.databaseUrl);
  const sslmode = url.searchParams.get('sslmode')?.toLowerCase() ?? '';
  for (const name of SSL_PARAMS) url.searchParams.delete(name);

  const isLocal = LOCAL_HOSTS.has(url.hostname.toLowerCase());
  const explicitTls = ['require', 'verify-ca', 'verify-full'].includes(sslmode);

  let useTls: boolean;
  if (config.databaseSsl === 'disable') useTls = false;
  else if (config.databaseSsl === 'require') useTls = true;
  else if (sslmode === 'disable') useTls = false;
  else useTls = !isLocal || explicitTls;

  return {
    connectionString: url.toString(),
    ssl: useTls ? { rejectUnauthorized: config.databaseSslStrict } : false,
  };
}

export function createPool(config: AppConfig, logger: Logger): pg.Pool {
  const { connectionString, ssl } = resolvePoolSettings(config);
  const pool = new pg.Pool({
    connectionString,
    ssl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.dbStatementTimeoutMs,
    query_timeout: config.dbStatementTimeoutMs + 2_000,
    application_name: 'allovity',
  });
  // An error on an idle client must not crash the process.
  pool.on('error', (error) => logger.error('Database pool error', { err: error }));
  return pool;
}

/** Runs a trivial query and gives up after timeoutMs. Resolves true only if the database answered. */
export async function checkDatabase(pool: pg.Pool, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const query = pool.query('SELECT 1');
  query.catch(() => undefined);
  try {
    await Promise.race([
      query,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('database check timed out')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
