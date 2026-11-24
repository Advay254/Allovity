export interface RateLimitHit {
  /** Weighted request count for the sliding window, including this request. */
  count: number;
  /** Milliseconds until the current fixed window rolls over. */
  resetMs: number;
}

/**
 * Storage contract for the rate limiter. The in-memory store below is the default.
 * A shared store (Redis, Postgres) can replace it without touching the middleware.
 */
export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  close?(): void;
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
    });
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
