import type pg from 'pg';
import { slidingCount, type RateLimitHit, type RateLimitStore } from './rate-limit-store.js';

export interface PostgresStoreOptions {
  /** Hard cap on stored rows. The oldest rows are removed when it is exceeded. */
  maxRows: number;
  /** How often expired rows are pruned. 0 turns the timer off (tests call prune directly). */
  pruneIntervalMs?: number;
  /** Check the cap on every Nth new key instead of on every one. */
  capCheckEvery?: number;
}

interface Row {
  window_start: string;
  window_ms: number;
  current_hits: number;
  previous_hits: number;
}

/**
 * Shared sliding-window store in Postgres, so limits hold across instances and
 * restarts. One atomic upsert per hit: concurrent callers cannot lose an update.
 * The same two-window maths as the memory store keeps both implementations consistent.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  private timer: NodeJS.Timeout | undefined;
  private inserts = 0;
  private readonly capCheckEvery: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresStoreOptions,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.capCheckEvery = options.capCheckEvery ?? 50;
    const interval = options.pruneIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        this.prune(Date.now()).catch(this.onError);
      }, interval);
      this.timer.unref();
    }
  }

  async increment(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const expiresAt = new Date(windowStart + windowMs * 2);
    const result = await this.pool.query<Row & { inserted: boolean }>(
      `INSERT INTO rate_limit_hits (key, window_start, window_ms, current_hits, previous_hits, expires_at, updated_at)
       VALUES ($1, $2, $3, 1, 0, $4, now())
       ON CONFLICT (key) DO UPDATE SET
         previous_hits = CASE
           WHEN rate_limit_hits.window_start = EXCLUDED.window_start THEN rate_limit_hits.previous_hits
           WHEN EXCLUDED.window_start - rate_limit_hits.window_start = EXCLUDED.window_ms THEN rate_limit_hits.current_hits
           ELSE 0 END,
         current_hits = CASE
           WHEN rate_limit_hits.window_start = EXCLUDED.window_start THEN rate_limit_hits.current_hits + 1
           ELSE 1 END,
         window_start = EXCLUDED.window_start,
         window_ms = EXCLUDED.window_ms,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       RETURNING window_start, window_ms, current_hits, previous_hits, (xmax = 0) AS inserted`,
      [key, windowStart, windowMs, expiresAt],
    );
    const row = result.rows[0] as Row & { inserted: boolean };
    if (row.inserted) {
      this.inserts += 1;
      if (this.inserts % this.capCheckEvery === 0) {
        this.enforceCap().catch(this.onError);
      }
    }
    return slidingCount(rowToState(row), windowMs, now);
  }

  async peek(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const result = await this.pool.query<Row>(
      'SELECT window_start, window_ms, current_hits, previous_hits FROM rate_limit_hits WHERE key = $1',
      [key],
    );
    const row = result.rows[0];
    return slidingCount(row ? rowToState(row) : undefined, windowMs, now);
  }

  /** Deletes expired rows, then trims to the hard cap. Returns how many rows were removed. */
  async prune(now: number): Promise<number> {
    const expired = await this.pool.query('DELETE FROM rate_limit_hits WHERE expires_at < $1', [
      new Date(now),
    ]);
    return (expired.rowCount ?? 0) + (await this.enforceCap());
  }

  /** Removes the oldest rows beyond the cap. The count is bounded by the cap itself. */
  async enforceCap(): Promise<number> {
    const { maxRows } = this.options;
    const result = await this.pool.query(
      `DELETE FROM rate_limit_hits WHERE key IN (
         SELECT key FROM rate_limit_hits ORDER BY updated_at DESC OFFSET $1
       )`,
      [maxRows],
    );
    return result.rowCount ?? 0;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function rowToState(row: Row) {
  return {
    windowStart: Number(row.window_start),
    windowMs: row.window_ms,
    current: row.current_hits,
    previous: row.previous_hits,
  };
}
