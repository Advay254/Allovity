import { z } from 'zod';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NodeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  databaseUrl: string;
  /** Origin only, no trailing slash. Used for canonical links. */
  publicSiteUrl: string;
  adminPathSlug: string;
  port: number;
  logLevel: LogLevel;
  trustedProxyHops: number;
  runMigrations: boolean;
  databaseSsl: 'auto' | 'require' | 'disable';
  databaseSslStrict: boolean;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  rateLimit: { max: number; windowMs: number; maxKeys: number };
  shutdownTimeoutMs: number;
}

export interface LoadedConfig {
  config: AppConfig;
  warnings: string[];
}

/** Lists the variables that are wrong. It never contains their values. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid configuration. Fix these environment variables and restart:\n${issues
        .map((issue) => `  - ${issue}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Record<string, string | undefined>;

const PLACEHOLDER_SLUG = /(replace-with|change-me|your-secret|example|placeholder)/i;

const databaseUrlSchema = z.string().refine((value) => {
  if (!/^postgres(ql)?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a postgres:// or postgresql:// connection string');

const siteUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}, 'must be an absolute http(s) address such as https://example.com');

const slugSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{16,}$/,
    'must be at least 16 characters using only letters, digits, underscore and hyphen',
  )
  .refine((value) => !PLACEHOLDER_SLUG.test(value), 'still looks like the example placeholder');

const booleanSchema = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

function readOptional<T>(
  env: Env,
  name: string,
  schema: z.ZodType<T>,
  fallback: T,
  hint: string,
  warnings: string[],
): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  warnings.push(`${name}: ${hint}. Using the default (${String(fallback)}).`);
  return fallback;
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export function loadConfig(env: Env = process.env): LoadedConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  const required = (name: string, schema: z.ZodType<string>): string => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') {
      issues.push(`${name}: is required but not set`);
      return '';
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      issues.push(`${name}: ${parsed.error.issues[0]?.message ?? 'is invalid'}`);
      return '';
    }
    return parsed.data;
  };

  const databaseUrl = required('DATABASE_URL', databaseUrlSchema);
  const siteUrlRaw = required('PUBLIC_SITE_URL', siteUrlSchema);
  const adminPathSlug = required('ADMIN_PATH_SLUG', slugSchema);

  if (issues.length > 0) throw new ConfigError(issues);

  const siteUrl = new URL(siteUrlRaw);
  if (siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash) {
    warnings.push(
      'PUBLIC_SITE_URL: path, query and fragment are ignored. Only the origin is used for canonical links.',
    );
  }

  const nodeEnvRaw = env.NODE_ENV?.trim();
  let nodeEnv: NodeEnv = 'development';
  if (nodeEnvRaw === 'production' || nodeEnvRaw === 'test' || nodeEnvRaw === 'development') {
    nodeEnv = nodeEnvRaw;
  } else if (nodeEnvRaw) {
    warnings.push(
      'NODE_ENV: expected production, development or test. Treating it as development.',
    );
  }
  const isProduction = nodeEnv === 'production';

  const port = readOptional(env, 'PORT', int(1, 65535), 3000, 'must be a port number', warnings);
  const logLevel = readOptional<LogLevel>(
    env,
    'LOG_LEVEL',
    z.enum(['debug', 'info', 'warn', 'error']),
    'info',
    'must be debug, info, warn or error',
    warnings,
  );
  const trustedProxyHops = readOptional(
    env,
    'TRUSTED_PROXY_HOPS',
    int(0, 10),
    0,
    'must be a whole number from 0 to 10',
    warnings,
  );
  const runMigrations = readOptional(
    env,
    'RUN_MIGRATIONS',
    booleanSchema,
    true,
    'must be true or false',
    warnings,
  );
  const databaseSsl = readOptional<'auto' | 'require' | 'disable'>(
    env,
    'DATABASE_SSL',
    z.enum(['auto', 'require', 'disable']),
    'auto',
    'must be auto, require or disable',
    warnings,
  );
  const databaseSslStrict = readOptional(
    env,
    'DATABASE_SSL_STRICT',
    booleanSchema,
    false,
    'must be true or false',
    warnings,
  );
  const dbPoolMax = readOptional(env, 'DB_POOL_MAX', int(1, 100), 10, 'must be 1 to 100', warnings);
  const dbStatementTimeoutMs = readOptional(
    env,
    'DB_STATEMENT_TIMEOUT_MS',
    int(500, 600_000),
    15_000,
    'must be 500 to 600000',
    warnings,
  );
  const rateMax = readOptional(
    env,
    'RATE_LIMIT_MAX',
    int(1, 1_000_000),
    300,
    'must be a positive whole number',
    warnings,
  );
  const rateWindowSeconds = readOptional(
    env,
    'RATE_LIMIT_WINDOW_SECONDS',
    int(1, 3600),
    60,
    'must be 1 to 3600',
    warnings,
  );
  const rateMaxKeys = readOptional(
    env,
    'RATE_LIMIT_MAX_KEYS',
    int(100, 1_000_000),
    10_000,
    'must be 100 to 1000000',
    warnings,
  );
  const shutdownTimeoutMs = readOptional(
    env,
    'SHUTDOWN_TIMEOUT_MS',
    int(1000, 120_000),
    10_000,
    'must be 1000 to 120000',
    warnings,
  );

  if (isProduction && trustedProxyHops === 0) {
    warnings.push(
      'TRUSTED_PROXY_HOPS is 0 in production. If a proxy or load balancer sits in front of the app, every visitor will share one IP address for rate limiting. Set it to the number of proxies.',
    );
  }
  if (isProduction && siteUrl.protocol === 'http:') {
    warnings.push('PUBLIC_SITE_URL uses http in production. Canonical links should use https.');
  }
  if (isProduction && databaseSsl === 'disable') {
    warnings.push('DATABASE_SSL is disable in production. Database traffic will not be encrypted.');
  }
  if (new Set(adminPathSlug).size < 8) {
    warnings.push('ADMIN_PATH_SLUG has very few distinct characters. Use a long random value.');
  }
  if (rateMax > 10_000 || rateWindowSeconds < 5) {
    warnings.push('RATE_LIMIT_MAX or RATE_LIMIT_WINDOW_SECONDS makes the rate limiter very loose.');
  }

  return {
    config: {
      nodeEnv,
      isProduction,
      databaseUrl,
      publicSiteUrl: siteUrl.origin,
      adminPathSlug,
      port,
      logLevel,
      trustedProxyHops,
      runMigrations,
      databaseSsl,
      databaseSslStrict,
      dbPoolMax,
      dbStatementTimeoutMs,
      rateLimit: { max: rateMax, windowMs: rateWindowSeconds * 1000, maxKeys: rateMaxKeys },
      shutdownTimeoutMs,
    },
    warnings,
  };
}
