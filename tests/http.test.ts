import request from 'supertest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS_DIR } from '../src/lib/paths.js';
import { MemoryRateLimitStore } from '../src/security/rate-limit-store.js';
import { buildTestApp, captureLogger, SITE_URL, SLUG } from './helpers/app.js';
import { createTestDatabase, type TestDatabase } from './helpers/db.js';

let db: TestDatabase;
let realPool: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  realPool = new pg.Pool({ connectionString: db.url, max: 3 });
  await runMigrations(realPool, { dir: MIGRATIONS_DIR, logger: captureLogger().logger });
});

afterAll(async () => {
  await realPool.end();
  await db.drop();
});

describe('health endpoints', () => {
  it('liveness answers 200 even when the database is down', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('readiness answers 200 when the database answers', async () => {
    const { app } = buildTestApp({ pool: realPool });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('readiness answers 503 when the database is down, with no internal detail', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(res.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres/i);
  });
});

describe('robots and sitemap', () => {
  it('allows crawling, points at the sitemap, and never lists the admin path', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('User-agent: *');
    expect(res.text).toContain('Allow: /');
    expect(res.text).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    expect(res.text).not.toContain(SLUG);
    expect(res.text.toLowerCase()).not.toContain('admin');
  });

  it('serves a sitemap with absolute URLs and no admin path', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<loc>${SITE_URL}/</loc>`);
    expect(res.text).not.toContain(SLUG);
  });
});

describe('error pages', () => {
  it('serves a branded 404 with correct status and safe routes back', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/definitely-not-here');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('This page is not on the map.');
    expect(res.text).toContain('href="/"');
    expect(res.text).toContain('noindex');
    expect(res.text).not.toContain('<link rel="canonical"');
  });

  it('serves a generic 500 and keeps details in the log only', async () => {
    const { app, lines } = buildTestApp({
      healthService: {
        liveness: () => ({ status: 'ok' }),
        readiness: () =>
          Promise.reject(new Error('SELECT secret FROM users failed at /srv/app/db.ts')),
      },
    });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(500);
    expect(res.text).toContain('Something broke on our side.');
    expect(res.text).not.toMatch(/SELECT|users|\/srv\/app|stack|at Object/i);
    expect(res.text).toContain(String(res.headers['x-request-id']));
    expect(lines.join('\n')).toContain('/srv/app/db.ts');
  });

  it('treats a malformed URL as an ordinary 404 without leaking an error', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/static/%E0%A4%A');
    expect(res.status).toBe(404);
    expect(res.text).not.toMatch(/URIError|decode/i);
  });

  it('returns a request id header on every response', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/').set('X-Request-Id', 'attacker-chosen');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('security headers', () => {
  it('sets the full header set and hides the framework', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/');
    const h = res.headers;
    expect(h['x-powered-by']).toBeUndefined();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['strict-transport-security']).toBeUndefined();
  });

  it('has a content security policy with no inline allowances', async () => {
    const { app } = buildTestApp();
    const csp = String((await request(app).get('/')).headers['content-security-policy']);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:|\*/);
    for (const part of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ]) {
      expect(csp).toContain(part);
    }
  });

  it('adds strict transport security in production only', async () => {
    const { app } = buildTestApp({ env: { NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '1' } });
    const res = await request(app).get('/');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(String(res.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
  });

  it('keeps every page free of inline scripts, styles and event handlers', async () => {
    const { app } = buildTestApp();
    for (const path of ['/', '/nope', `/${SLUG}`]) {
      const html = (await request(app).get(path)).text;
      expect(html, path).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(html, path).not.toMatch(/\sstyle=/i);
      expect(html, path).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });

  it('parses no request body on routes that do not need one', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/').send({ a: 1 });
    expect(res.status).toBe(404);
  });

  it('applies the general rate limit to routes', async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_SECONDS: '60' } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await request(app).get('/robots.txt')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await request(app).get('/healthz')).status).toBe(200);
  });
});

const memoryStore = () => new MemoryRateLimitStore({ maxKeys: 1000, pruneIntervalMs: 0 });

describe('admin entrance', () => {
  it('returns the normal 404 for the plain admin path and common guesses', async () => {
    const { app } = buildTestApp();
    for (const path of ['/admin', '/admin/', '/administrator', '/wp-admin', '/dashboard']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).toContain('This page is not on the map.');
    }
  });

  it('is case sensitive so the slug cannot be matched loosely', async () => {
    const { app } = buildTestApp();
    expect((await request(app).get(`/${SLUG.toLowerCase()}`)).status).toBe(404);
  });

  it('sends signed-out visitors from the secret path to the sign-in page', async () => {
    const { app } = buildTestApp({ adminRateLimitStore: memoryStore() });
    const entry = await request(app).get(`/${SLUG}`);
    expect(entry.status).toBe(303);
    expect(entry.headers.location).toBe(`/${SLUG}/login`);
    const res = await request(app).get(`/${SLUG}/login`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).toMatch(/admin\.[0-9a-f]{10}\.css/);
    expect(res.text).not.toMatch(/public\.[0-9a-f]{10}\.css/);
  });

  it('keeps the indexing header on everything under the path', async () => {
    const { app } = buildTestApp({ adminRateLimitStore: memoryStore() });
    const sub = await request(app).get(`/${SLUG}/anything`);
    expect(sub.status).toBe(404);
    expect(sub.headers['x-robots-tag']).toContain('noindex');
  });

  it('serves the admin stylesheet bundle', async () => {
    const { app } = buildTestApp({ adminRateLimitStore: memoryStore() });
    const html = (await request(app).get(`/${SLUG}/login`)).text;
    const href = /href="(\/static\/admin\.[0-9a-f]{10}\.css)"/.exec(html)?.[1];
    expect(href).toBeTruthy();
    const css = await request(app).get(href as string);
    expect(css.status).toBe(200);
    expect(css.text).toContain('.admin-panel');
  });

  it('never writes the secret path to the logs', async () => {
    const { app, lines } = buildTestApp({ adminRateLimitStore: memoryStore() });
    await request(app).get(`/${SLUG}`);
    await request(app).get(`/${SLUG}/deeper`);
    const joined = lines.join('\n');
    expect(joined).not.toContain(SLUG);
    expect(joined).toContain('/[admin]');
  });
});

describe('logging', () => {
  it('redacts credentials in URLs and secret-looking fields', async () => {
    const { logger, lines } = captureLogger();
    logger.info('connecting', {
      url: 'postgres://user:hunter2@db.example.com/app',
      password: 'hunter2',
      nested: { authorization: 'Bearer abc', cookie: 'sid=1' },
      err: new Error('failed for postgres://u:hunter2@h/db'),
    });
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('Bearer abc');
    expect(lines[0]).not.toContain('sid=1');
  });
});
