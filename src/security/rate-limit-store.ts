export interface SlidingState {
  windowStart: number;
  windowMs: number;
  current: number;
  previous: number;
}

export interface RateLimitHit {
  /** Weighted request count for the sliding window, including this request. */
  count: number;
  /** Milliseconds until the current fixed window rolls over. */
  resetMs: number;
  /** Raw stored counters, when the store has them. Lets callers work out when a count will fall. */
  state?: SlidingState;
}

/**
 * Storage contract for the rate limiter. The in-memory store below is the default.
 * A shared store (Redis, Postgres) can replace it without touching the middleware.
 */
export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  /**
   * Reads the current count without counting a hit, so a sign-in attempt can be
   * checked before it is known to be a failure. Optional so older stores keep working.
   */
  peek?(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  close?(): void;
}

/** Shared maths for the sliding window, used by every store. */
export function slidingCount(
  state: SlidingState | undefined,
  windowMs: number,
  now: number,
): RateLimitHit {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const elapsed = now - windowStart;
  if (!state) return { count: 0, resetMs: windowMs - elapsed };
  let current = state.current;
  let previous = state.previous;
  if (state.windowStart !== windowStart) {
    previous = windowStart - state.windowStart === windowMs ? state.current : 0;
    current = 0;
  }
  const weight = 1 - elapsed / windowMs;
  return { count: Math.ceil(previous * weight + current), resetMs: windowMs - elapsed, state };
}

/** Whole seconds until a count would fall below `limit` if no further hits arrive. */
export function secondsUntilBelow(
  hit: RateLimitHit,
  limit: number,
  windowMs: number,
  now: number,
): number {
  if (hit.count < limit) return 0;
  if (!hit.state) return Math.ceil(hit.resetMs / 1000);
  const horizon = Math.ceil((windowMs * 2) / 1000);
  for (let s = 1; s <= horizon; s += 1) {
    if (slidingCount(hit.state, windowMs, now + s * 1000).count < limit) return s;
  }
  return horizon;
}

interface Bucket {
  windowStart: number;
  windowMs: number;
  current: number;
  previous: number;
}

export interface MemoryStoreOptions {
  maxKeys: number;
  pruneIntervalMs?: number;
}

/**
 * Sliding-window counter: two fixed windows blended by how far into the current one
 * we are. Memory is bounded by maxKeys (least recently used keys are evicted) and by
 * a scheduled prune that drops buckets that can no longer affect any decision.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MemoryStoreOptions) {
    this.maxKeys = options.maxKeys;
    const interval = options.pruneIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.prune(Date.now()), interval);
      this.timer.unref();
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  increment(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = this.buckets.get(key);

    if (bucket) {
      this.buckets.delete(key); // re-inserted below so Map order tracks recency
    } else {
      bucket = { windowStart, windowMs, current: 0, previous: 0 };
      this.makeRoom(now);
    }

    if (bucket.windowStart !== windowStart) {
      bucket.previous = windowStart - bucket.windowStart === windowMs ? bucket.current : 0;
      bucket.current = 0;
      bucket.windowStart = windowStart;
    }
    bucket.windowMs = windowMs;
    bucket.current += 1;
    this.buckets.set(key, bucket);

    const elapsed = now - windowStart;
    const weight = 1 - elapsed / windowMs;
    return Promise.resolve({
      count: Math.ceil(bucket.previous * weight + bucket.current),
      resetMs: windowMs - elapsed,
      state: {
        windowStart: bucket.windowStart,
        windowMs,
        current: bucket.current,
        previous: bucket.previous,
      },
    });
  }

  peek(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    return Promise.resolve(slidingCount(this.buckets.get(key), windowMs, now));
  }

  /** Removes buckets whose data can no longer influence a decision. */
  prune(now: number): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= bucket.windowMs * 2) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private makeRoom(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    this.prune(now);
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.buckets.clear();
  }
}
