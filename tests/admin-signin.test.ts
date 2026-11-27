import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  cookieValue,
  currentCode,
  GOOD_PASSWORD,
  postForm,
  signIn,
  signInFully,
  startAdmin,
  type AdminHarness,
} from './helpers/admin.js';
import { SITE_URL } from './helpers/app.js';

let h: AdminHarness;
beforeAll(async () => {
  h = await startAdmin({ ADMIN_REQUIRE_2FA: 'false' });
  await h.user({ email: 'owner@example.com', name: 'Olive Owner', role: 'owner' });
});
afterAll(async () => h.close());

describe('sign in', () => {
  it('signs in with a valid password and lands on the dashboard', async () => {
    const agent = h.agent();
    const res = await signIn(agent, 'owner@example.com');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${BASE}/`);
    const dash = await agent.get(`${BASE}/`);
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Dashboard');
    expect(dash.text).toContain('Olive Owner');
  });

  it('sets a session cookie that is HttpOnly, SameSite Strict and scoped to the admin path', async () => {
    const res = await signIn(h.agent(), 'owner@example.com');
    const header = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('av_admin='),
    ) as string;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toContain(`Path=${BASE}`);
    expect(header).not.toMatch(/Expires|Max-Age/i);
  });

  it('uses the Secure prefix and Secure flag in production', async () => {
    const prod = await startAdmin({
      NODE_ENV: 'production',
      TRUSTED_PROXY_HOPS: '1',
      ADMIN_REQUIRE_2FA: 'false',
    });
    try {
      await prod.user({ email: 'a@example.com' });
      const agent = prod.agent();
      const page = await agent.get(`${BASE}/login`);
      const pre = (page.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('__Secure-av_pre='),
      ) as string;
      expect(pre).toMatch(/Secure/);
      expect(pre).toMatch(/HttpOnly/i);
      expect(pre).toMatch(/SameSite=Strict/i);
    } finally {
      await prod.close();
    }
  });

  it('stores only a hash of the session token', async () => {
    const res = await signIn(h.agent(), 'owner@example.com');
    const token = cookieValue(res, 'av_admin') as string;
    const rows = await h.pool.query('SELECT token_hash FROM admin_sessions');
    expect(rows.rows.every((r) => r.token_hash !== token)).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('gives the same response for an unknown email, a wrong password and an inactive account', async () => {
    await h.user({ email: 'gone@example.com', active: false });
    const normalise = (text: string) =>
      text.replace(/value="[^"]*"/g, 'value=""').replace(/\d{13}\.[0-9a-f]{64}/g, 'TOKEN');
    const attempts = [
      ['nobody@example.com', GOOD_PASSWORD],
      ['owner@example.com', 'wrong password entirely'],
      ['gone@example.com', GOOD_PASSWORD],
    ] as const;
    const results = [];
    for (const [email, password] of attempts) {
      const res = await signIn(h.agent(), email, password);
      results.push({ status: res.status, body: normalise(res.text) });
    }
    expect(results[0]!.status).toBe(401);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('spends comparable time for unknown and known accounts', async () => {
    const time = async (email: string) => {
      const agent = h.agent();
      const started = process.hrtime.bigint();
      await signIn(agent, email, 'wrong password entirely');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    await time('owner@example.com');
    const known = await time('owner@example.com');
    const unknown = await time('missing-person@example.com');
    expect(Math.abs(known - unknown)).toBeLessThan(Math.max(known, unknown) * 0.6 + 25);
  });

  it('never logs passwords, codes or tokens', async () => {
    const agent = h.agent();
    await signIn(agent, 'owner@example.com', 'a very secret password 123');
    await signIn(agent, 'owner@example.com');
    const joined = h.lines.join('\n');
    expect(joined).not.toContain('a very secret password 123');
    expect(joined).not.toContain(GOOD_PASSWORD);
    expect(joined).not.toMatch(/av_admin=/);
  });

  it('rotates the session on sign-in: the old identifier stops working', async () => {
    const first = await signIn(h.agent(), 'owner@example.com');
    const oldToken = cookieValue(first, 'av_admin') as string;
    expect(oldToken).toBeTruthy();

    // Sign in again while still carrying the old session cookie.
    const page = await request(h.app).get(`${BASE}/login`).set('Cookie', `av_admin=${oldToken}`);
    expect(page.status).toBe(303); // already signed in
    const loginPage = await request(h.app).get(`${BASE}/login`);
    const pre = cookieValue(loginPage, 'av_pre') as string;
    const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.text)![1];
    const second = await request(h.app)
      .post(`${BASE}/login`)
      .set('Origin', SITE_URL)
      .set('Cookie', `av_pre=${pre}; av_admin=${oldToken}`)
      .type('form')
      .send({ _csrf: csrf, email: 'owner@example.com', password: GOOD_PASSWORD });
    expect(second.status).toBe(303);
    const newToken = cookieValue(second, 'av_admin') as string;
    expect(newToken).not.toBe(oldToken);

    const replay = await request(h.app)
      .get(`${BASE}/account`)
      .set('Cookie', `av_admin=${oldToken}`);
    expect(replay.status).toBe(303);
    expect(replay.headers.location).toBe(`${BASE}/login`);
    const fresh = await request(h.app).get(`${BASE}/account`).set('Cookie', `av_admin=${newToken}`);
    expect(fresh.status).toBe(200);
  });

  it('signs out on the server: the old cookie no longer works', async () => {
    const agent = h.agent();
    const first = await signIn(agent, 'owner@example.com');
    const token = cookieValue(first, 'av_admin') as string;
    const page = await agent.get(`${BASE}/`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    const out = await agent
      .post(`${BASE}/logout`)
      .set('Origin', SITE_URL)
      .type('form')
      .send({ _csrf: csrf });
    expect(out.status).toBe(303);
    expect((await agent.get(`${BASE}/`)).headers.location).toBe(`${BASE}/login`);
    const replay = await request(h.app).get(`${BASE}/`).set('Cookie', `av_admin=${token}`);
    expect(replay.headers.location).toBe(`${BASE}/login`);
  });

  it('records sign-in, failure and sign-out in the audit log without secrets', async () => {
    const rows = await h.pool.query('SELECT action, metadata::text AS m FROM audit_log');
    const actions = new Set(rows.rows.map((r) => r.action));
    expect(actions.has('auth.sign_in')).toBe(true);
    expect(actions.has('auth.sign_in_failed')).toBe(true);
    expect(actions.has('auth.sign_out')).toBe(true);
    expect(rows.rows.map((r) => r.m).join()).not.toContain('owner@example.com');
  });
});

describe('sessions and expiry', () => {
  it('ends a session after the idle timeout and after the absolute lifetime', async () => {
    const idle = await signInFully(h, 'owner@example.com');
    expect((await idle.get(`${BASE}/account`)).status).toBe(200);
    await h.pool.query(
      `UPDATE admin_sessions SET idle_expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`,
    );
    expect((await idle.get(`${BASE}/account`)).status).toBe(303);

    const abs = await signInFully(h, 'owner@example.com');
    await h.pool.query(
      `UPDATE admin_sessions SET absolute_expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`,
    );
    expect((await abs.get(`${BASE}/account`)).status).toBe(303);
  });

  it('applies a session revoked from the account page at once', async () => {
    const a = await signInFully(h, 'owner@example.com');
    const b = await signInFully(h, 'owner@example.com');
    const page = await a.get(`${BASE}/account`);
    const id = /sessions\/([0-9a-f-]{36})\/revoke/.exec(
      page.text.replace(/<form[^>]*sessions\/([0-9a-f-]{36})\/revoke/g, '$&'),
    )![1];
    const own = (await b.get(`${BASE}/account`)).text;
    expect(own).toContain('This device');
    const res = await postForm(a, '/account', `/account/sessions/${id}/revoke`, {});
    expect(res.status).toBe(303);
    const all = await h.pool.query(
      'SELECT count(*)::int AS n FROM admin_sessions WHERE revoked_at IS NOT NULL',
    );
    expect(all.rows[0].n).toBeGreaterThan(0);
  });

  it("changing the password revokes the user's other sessions and keeps the current one", async () => {
    await h.user({ email: 'pw@example.com', role: 'editor' });
    const a = await signInFully(h, 'pw@example.com');
    const b = await signInFully(h, 'pw@example.com');
    const res = await postForm(a, '/account', '/account/password', {
      password: 'a brand new passphrase 99',
      confirm: 'a brand new passphrase 99',
    });
    expect(res.status).toBe(303);
    expect((await a.get(`${BASE}/account`)).status).toBe(200);
    expect((await b.get(`${BASE}/account`)).status).toBe(303);
    const again = await signIn(h.agent(), 'pw@example.com', 'a brand new passphrase 99');
    expect(again.headers.location).toBe(`${BASE}/`);
  });

  it('requires the current password for sensitive actions when it was not entered recently', async () => {
    await h.user({ email: 'stale@example.com', role: 'editor' });
    const agent = await signInFully(h, 'stale@example.com');
    await h.pool.query(
      `UPDATE admin_sessions SET reauthenticated_at = now() - interval '10 minutes' WHERE revoked_at IS NULL`,
    );
    const denied = await postForm(agent, '/account', '/account/password', {
      password: 'another new passphrase 7',
      confirm: 'another new passphrase 7',
    });
    expect(denied.status).toBe(401);
    expect(denied.text).toContain('That password is not correct.');
    const ok = await postForm(agent, '/account', '/account/password', {
      currentPassword: GOOD_PASSWORD,
      password: 'another new passphrase 7',
      confirm: 'another new passphrase 7',
    });
    expect(ok.status).toBe(303);
  });
});

describe('forced password change', () => {
  it('lets a user with the flag reach only the password screen', async () => {
    await h.user({ email: 'temp@example.com', role: 'editor', mustChange: true });
    const agent = h.agent();
    const res = await signIn(agent, 'temp@example.com');
    expect(res.status).toBe(303);
    for (const path of ['/', '/account', '/users', '/audit']) {
      const page = await agent.get(`${BASE}${path}`);
      expect(page.status, path).toBe(303);
      expect(page.headers.location, path).toBe(`${BASE}/password`);
    }
    const bad = await postForm(agent, '/password', '/password', {
      password: 'short',
      confirm: 'short',
    });
    expect(bad.status).toBe(400);
    const done = await postForm(agent, '/password', '/password', {
      password: 'my own long passphrase 31',
      confirm: 'my own long passphrase 31',
    });
    expect(done.status).toBe(303);
    expect((await agent.get(`${BASE}/account`)).status).toBe(200);
  });
});

describe('two-step verification', () => {
  it('requires a code, rejects a replayed code and accepts the next step', async () => {
    const user = await h.user({ email: 'two@example.com', role: 'editor', twoStep: true });
    const secret = user.totpSecret as string;
    const agent = h.agent();
    const first = await signIn(agent, 'two@example.com');
    expect(first.headers.location).toBe(`${BASE}/login/two-step`);
    expect((await agent.get(`${BASE}/account`)).status).toBe(303);
    const ok = await postForm(agent, '/login/two-step', '/login/two-step', {
      code: currentCode(secret),
    });
    expect(ok.status).toBe(303);
    expect((await agent.get(`${BASE}/account`)).status).toBe(200);

    const replayAgent = h.agent();
    await signIn(replayAgent, 'two@example.com');
    const replay = await postForm(replayAgent, '/login/two-step', '/login/two-step', {
      code: currentCode(secret),
    });
    expect(replay.status).toBe(401);
    const next = await postForm(replayAgent, '/login/two-step', '/login/two-step', {
      code: currentCode(secret, 1),
    });
    expect(next.status).toBe(303);
  });

  it('rotates the session when two-step verification completes', async () => {
    const user = await h.user({ email: 'rot@example.com', role: 'editor', twoStep: true });
    const agent = h.agent();
    const first = await signIn(agent, 'rot@example.com');
    const pending = cookieValue(first, 'av_admin');
    const done = await postForm(agent, '/login/two-step', '/login/two-step', {
      code: currentCode(user.totpSecret as string),
    });
    const active = cookieValue(done, 'av_admin');
    expect(active).toBeTruthy();
    expect(active).not.toBe(pending);
    const stale = await h.agent().get(`${BASE}/account`).set('Cookie', `av_admin=${pending}`);
    expect(stale.status).toBe(303);
  });

  it('accepts each recovery code once only', async () => {
    const user = await h.user({ email: 'rec@example.com', role: 'editor', twoStep: true });
    const { generateRecoveryCodes } = await import('../src/admin/auth.js');
    const { replaceRecoveryCodes } = await import('../src/admin/users.js');
    const { hmacHex } = await import('../src/security/crypto.js');
    const codes = generateRecoveryCodes();
    await replaceRecoveryCodes(
      h.pool,
      user.id,
      codes.map((c) => hmacHex(h.svc.keys.recovery, c.replace('-', ''))),
    );
    const a = h.agent();
    await signIn(a, 'rec@example.com');
    const used = await postForm(a, '/login/two-step?mode=recovery', '/login/two-step', {
      mode: 'recovery',
      recovery: codes[0] as string,
    });
    expect(used.status).toBe(303);
    const b = h.agent();
    await signIn(b, 'rec@example.com');
    const reuse = await postForm(b, '/login/two-step?mode=recovery', '/login/two-step', {
      mode: 'recovery',
      recovery: codes[0] as string,
    });
    expect(reuse.status).toBe(401);
    const other = await postForm(b, '/login/two-step?mode=recovery', '/login/two-step', {
      mode: 'recovery',
      recovery: (codes[1] as string).toUpperCase(),
    });
    expect(other.status).toBe(303);
  });

  it('enrols from the account page, shows recovery codes once and then requires a code', async () => {
    await h.user({ email: 'enrol@example.com', role: 'editor' });
    const agent = await signInFully(h, 'enrol@example.com');
    const page = await agent.get(`${BASE}/two-step/setup`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<svg');
    expect(page.text).not.toContain('data:');
    const key = /<code>([A-Z2-7 ]+)<\/code>/.exec(page.text)![1]!.replace(/\s/g, '');
    const bad = await postForm(agent, '/two-step/setup', '/two-step/setup', { code: '000000' });
    expect(bad.status).toBe(400);
    const good = await postForm(agent, '/two-step/setup', '/two-step/setup', {
      code: currentCode(key),
    });
    expect(good.status).toBe(200);
    expect(good.text).toContain('I have saved these');
    expect(good.text.match(/<code>[a-z0-9]{5}-[a-z0-9]{5}<\/code>/g)).toHaveLength(10);
    const stored = await h.pool.query(
      `SELECT count(*)::int AS n, bool_and(code_hash ~ '^[0-9a-f]{64}$') AS hashed FROM admin_recovery_codes r JOIN admin_users u ON u.id = r.user_id WHERE u.email = 'enrol@example.com'`,
    );
    expect(stored.rows[0]).toEqual({ n: 10, hashed: true });
    const secretRow = await h.pool.query(
      `SELECT totp_secret_encrypted FROM admin_users WHERE email = 'enrol@example.com'`,
    );
    expect(secretRow.rows[0].totp_secret_encrypted).toMatch(/^v1\./);
    expect(secretRow.rows[0].totp_secret_encrypted).not.toContain(key);
  });
});
