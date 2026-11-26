import type pg from 'pg';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { deriveKey } from '../security/crypto.js';
import { PasswordHasher } from '../security/password.js';
import type { RateLimitStore } from '../security/rate-limit-store.js';

export interface AdminKeys {
  totp: Buffer;
  csrf: Buffer;
  recovery: Buffer;
  identifier: Buffer;
}

/** Everything the admin area needs, built once. Absent when the secret key is unusable. */
export interface AdminServices {
  pool: pg.Pool;
  config: AppConfig;
  logger: Logger;
  hasher: PasswordHasher;
  store: RateLimitStore;
  keys: AdminKeys;
  /** General limit on admin requests per client network. */
  requestLimit: { max: number; windowMs: number };
  now: () => number;
}

export interface AdminServiceDeps {
  config: AppConfig;
  logger: Logger;
  pool: pg.Pool;
  store: RateLimitStore;
  now?: () => number;
  requestLimit?: { max: number; windowMs: number };
}

export function createAdminServices(deps: AdminServiceDeps): AdminServices | null {
  const secret = deps.config.admin.secretKey;
  if (!secret) return null;
  return {
    pool: deps.pool,
    config: deps.config,
    logger: deps.logger,
    hasher: new PasswordHasher(deps.config.admin.argon2),
    store: deps.store,
    keys: {
      totp: deriveKey(secret, 'totp-encryption'),
      csrf: deriveKey(secret, 'csrf'),
      recovery: deriveKey(secret, 'recovery-codes'),
      identifier: deriveKey(secret, 'identifier-hash'),
    },
    requestLimit: deps.requestLimit ?? { max: 120, windowMs: 60_000 },
    now: deps.now ?? Date.now,
  };
}
