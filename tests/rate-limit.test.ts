import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { rateLimiter } from '../src/http/rate-limit.js';
import { MemoryRateLimitStore, type RateLimitStore } from '../src/security/rate-limit-store.js';
import { captureLogger } from './helpers/app.js';

describe('memory rate limit store', () => {
  it('counts requests in a sliding window', async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 100, pruneIntervalMs: 0 });
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i += 1) {
      expect((await store.increment('a', 10_000, t0)).count).toBe(i);
    }
    // Halfway through the next window the previous window still counts for half.
    const next = Math.floor(t0 / 10_000) * 10_000 + 15_000;
    expect((await store.increment('a', 10_000, next)).count).toBe(Math.ceil(5 * 0.5 + 1));
    // Two windows later nothing is remembered.
    expect((await store.increment('a', 10_000, next + 25_000)).count).toBe(1);
  });

  it('keeps keys independent', async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 100, pruneIntervalMs: 0 });
    await store.increment('a', 1000, 5000);
    expect((await store.increment('b', 1000, 5000)).count).toBe(1);
  });

  it('never grows past its size cap', async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 50, pruneIntervalMs: 0 });
    for (let i = 0; i < 500; i += 1) await store.increment(`k${i}`, 60_000, 1_000);
    expect(store.size).toBeLessThanOrEqual(50);
  });

  it('prunes buckets that can no longer matter', async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 100, pruneIntervalMs: 0 });
    await store.increment('old', 1000, 1000);
    await store.increment('fresh', 1000, 9000);
    expect(store.prune(9500)).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe('rate limit middleware', () => {
  function build(store: RateLimitStore, max = 3) {
    const { logger, lines } = captureLogger();
    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimiter({ store, max, windowMs: 60_000, logger }));
    app.get('/', (_req, res) => res.send('ok'));
    return { app, lines };
  }

  it('allows up to the limit then answers 429 with Retry-After', async () => {
    const { app } = build(new MemoryRateLimitStore({ maxKeys: 100, pruneIntervalMs: 0 }));
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200);
    }
    const blocked = await request(app).get('/').set('X-Forwarded-For', '203.0.113.1');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('limits each client separately', async () => {
    const { app } = build(new MemoryRateLimitStore({ maxKeys: 100, pruneIntervalMs: 0 }), 1);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(429);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.2').expect(200);
  });

  it('works with any store that implements the interface', async () => {
    const calls: string[] = [];
    const fake: RateLimitStore = {
      increment: (key) => {
        calls.push(key);
        return Promise.resolve({ count: 99, resetMs: 5000 });
      },
    };
    const { app } = build(fake, 5);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(429);
    expect(calls).toEqual(['203.0.113.1']);
  });

  it('allows the request and logs when the store fails', async () => {
    const broken: RateLimitStore = { increment: () => Promise.reject(new Error('store down')) };
    const { app, lines } = build(broken);
    await request(app).get('/').expect(200);
    expect(lines.join('\n')).toContain('Rate limiter failed');
  });
});
