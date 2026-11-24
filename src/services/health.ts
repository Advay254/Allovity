import type pg from 'pg';
import { checkDatabase } from '../db/pool.js';

export interface HealthService {
  /** Answers as long as the process can run code. Never touches the database. */
  liveness(): { status: 'ok' };
  /** True only when the database answers a trivial query in time. */
  readiness(): Promise<{ ready: boolean }>;
}

export function createHealthService(pool: pg.Pool, timeoutMs = 2000): HealthService {
  return {
    liveness: () => ({ status: 'ok' }),
    readiness: async () => ({ ready: await checkDatabase(pool, timeoutMs) }),
  };
}
