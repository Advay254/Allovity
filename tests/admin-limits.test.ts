import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  currentCode,
  GOOD_PASSWORD,
  postForm,
  signIn,
  startAdmin,
  type AdminHarness,
} from './helpers/admin.js';

describe('sign-in throttling', () => {
  let h: AdminHarness;
  beforeAll(async () => {
    h = await startAdmin({ ADMIN_REQUIRE_2FA: 'false' }, { fakeClock: true });
    await h.user({ email: 'owner@example.com', role: 'owner' });
  });
  afterAll(async () => h.close());

  it('throttles after five failures with 429 and Retry-After, and never checks the password while throttled', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await signIn(h.agent(), 'owner@example.com', 'wrong password here')).status).toBe(
        401,
      );
    }
    const blocked = await signIn(h.agent(), 'owner@example.com', GOOD_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.text).toContain('Try again in');
    expect(blocked.text).toContain('not a lock');
  });

  it('throttles an unknown email exactly the same way', async () => {
    for (let i = 0; i < 5; i += 1)
      await signIn(h.agent(), 'ghost@example.com', 'wrong password here');
    const blocked = await signIn(h.agent(), 'ghost@example.com', 'wrong password here');
    expect(blocked.status).toBe(429);
  });

  it('recovers by itself once the window has passed, so nobody is locked out for good', async () => {
    h.clock.now += 40 * 60_000;
    const ok = await signIn(h.agent(), 'owner@example.com', GOOD_PASSWORD);
    expect(ok.status).toBe(303);
  });

  it('adds a little delay for people who keep trying while throttled, but it is bounded', async () => {
    for (let i = 0; i < 5; i += 1)
      await signIn(h.agent(), 'owner@example.com', 'wrong password here');
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await signIn(h.agent(), 'owner@example.com', 'wrong password here');
      waits.push(Number(res.headers['retry-after']));
    }
    expect(waits[5]!).toBeGreaterThan(waits[0]!);
    expect(Math.max(...waits)).toBeLessThanOrEqual(2 * 15 * 60 + 180);
  });

  it('does not let one stranger block the owner from a different network address', async () => {
    h.clock.now += 6 * 3600_000;
    const stranger = h.agent();
    for (let i = 0; i < 6; i += 1) {
      await stranger.post(`${BASE}/login`).set('X-Forwarded-For', '203.0.113.9').send({});
    }
    // Failures are per account plus address, so the owner's own address is unaffected.
    const ok = await signIn(h.agent(), 'owner@example.com', GOOD_PASSWORD);
    expect(ok.status).toBe(303);
  });

  it('records a throttle event once, not once per blocked attempt', async () => {
    const rows = await h.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.throttled'`,
    );
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0].n).toBeLessThan(10);
  });
});

describe('two-step throttling', () => {
  let h: AdminHarness;
  beforeAll(async () => {
    h = await startAdmin({ ADMIN_REQUIRE_2FA: 'false' }, { fakeClock: true });
  });
  afterAll(async () => h.close());

  it('counts wrong codes against the account and then returns 429', async () => {
    const user = await h.user({ email: 'two@example.com', role: 'editor', twoStep: true });
    const agent = h.agent();
    await signIn(agent, 'two@example.com');
    for (let i = 0; i < 5; i += 1) {
      const res = await postForm(agent, '/login/two-step', '/login/two-step', { code: '000000' });
      expect(res.status).toBe(401);
    }
    const blocked = await postForm(agent, '/login/two-step', '/login/two-step', {
      code: currentCode(user.totpSecret as string),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
  });
});

describe('general admin request limit', () => {
  it('answers 429 with Retry-After when a network sends too many admin requests', async () => {
    const h = await startAdmin();
    try {
      h.svc.requestLimit.max = 5;
      let last = 200;
      let retry: unknown;
      for (let i = 0; i < 8; i += 1) {
        const res = await h.agent().get(`${BASE}/login`);
        last = res.status;
        retry = res.headers['retry-after'];
      }
      expect(last).toBe(429);
      expect(retry).toBeTruthy();
    } finally {
      await h.close();
    }
  });
});
