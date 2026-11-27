import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  BASE,
  cookieValue,
  csrfIn,
  GOOD_PASSWORD,
  postForm,
  signIn,
  signInFully,
  startAdmin,
  type AdminHarness,
} from './helpers/admin.js';
import { SITE_URL } from './helpers/app.js';

let h: AdminHarness;
let owner: Awaited<ReturnType<AdminHarness['user']>>;
let admin: Awaited<ReturnType<AdminHarness['user']>>;
let admin2: Awaited<ReturnType<AdminHarness['user']>>;
let editor: Awaited<ReturnType<AdminHarness['user']>>;

beforeAll(async () => {
  h = await startAdmin({ ADMIN_REQUIRE_2FA: 'false' });
  owner = await h.user({ email: 'owner@example.com', name: 'Olive Owner', role: 'owner' });
  admin = await h.user({ email: 'admin@example.com', name: 'Adam Admin', role: 'admin' });
  admin2 = await h.user({ email: 'admin2@example.com', name: 'Ada Second', role: 'admin' });
  editor = await h.user({ email: 'editor@example.com', name: 'Edie Editor', role: 'editor' });
});
afterAll(async () => h.close());

describe('security headers on admin responses', () => {
  it('sends no-store, noindex and no referrer on every admin response, and keeps the strict CSP', async () => {
    const agent = await signInFully(h, 'owner@example.com');
    for (const path of ['/login', '/', '/account', '/users', '/audit']) {
      const res = await agent.get(`${BASE}${path}`);
      expect(res.headers['cache-control'], path).toBe('no-store');
      expect(res.headers['x-robots-tag'], path).toContain('noindex');
      expect(res.headers['x-robots-tag'], path).toContain('nofollow');
      expect(res.headers['referrer-policy'], path).toBe('no-referrer');
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toMatch(/data:/);
      expect(res.text, path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(res.text, path).not.toMatch(/\son[a-z]+=/);
      expect(res.text, path).not.toMatch(/\sstyle="/);
    }
  });
});

describe('request forgery protection', () => {
  it('refuses every state-changing route without a valid token or without a same-site origin', async () => {
    const agent = await signInFully(h, 'owner@example.com');
    const page = await agent.get(`${BASE}/account`);
    const token = csrfIn(page.text);
    const sessionId = /sessions\/([0-9a-f-]{36})\/revoke/.exec(page.text)![1];
    const routes = [
      '/logout',
      '/password',
      '/two-step/setup',
      '/two-step/saved',
      '/account/password',
      '/account/two-step/disable',
      '/account/recovery-codes',
      `/account/sessions/${sessionId}/revoke`,
      '/account/sessions/revoke-others',
      '/users',
      `/users/${editor.id}/role`,
      `/users/${editor.id}/deactivate`,
      `/users/${editor.id}/reactivate`,
      `/users/${editor.id}/reset-two-step`,
    ];
    for (const path of routes) {
      const noToken = await agent
        .post(`${BASE}${path}`)
        .set('Origin', SITE_URL)
        .type('form')
        .send({});
      expect(noToken.status, `${path} without token`).toBe(403);
      const badToken = await agent
        .post(`${BASE}${path}`)
        .set('Origin', SITE_URL)
        .type('form')
        .send({ _csrf: 'nope' });
      expect(badToken.status, `${path} bad token`).toBe(403);
      const foreign = await agent
        .post(`${BASE}${path}`)
        .set('Origin', 'https://evil.example')
        .type('form')
        .send({ _csrf: token });
      expect(foreign.status, `${path} foreign origin`).toBe(403);
      const noOrigin = await agent.post(`${BASE}${path}`).type('form').send({ _csrf: token });
      expect(noOrigin.status, `${path} no origin`).toBe(403);
      const nullOrigin = await agent
        .post(`${BASE}${path}`)
        .set('Origin', 'null')
        .type('form')
        .send({ _csrf: token });
      expect(nullOrigin.status, `${path} null origin without fetch metadata`).toBe(403);
      const crossSite = await agent
        .post(`${BASE}${path}`)
        .set('Origin', SITE_URL)
        .set('Sec-Fetch-Site', 'cross-site')
        .type('form')
        .send({ _csrf: token });
      expect(crossSite.status, `${path} cross-site fetch`).toBe(403);
    }
    // Browsers that send fetch metadata but a null Origin (no-referrer pages) are accepted.
    const viaFetchMetadata = await agent
      .post(`${BASE}/two-step/saved`)
      .set('Origin', 'null')
      .set('Sec-Fetch-Site', 'same-origin')
      .type('form')
      .send({ _csrf: token });
    expect(viaFetchMetadata.status).toBe(303);
    // The session is still alive: refused requests changed nothing.
    expect((await agent.get(`${BASE}/account`)).status).toBe(200);
  });

  it('refuses sign-in forms without the pre-sign-in token or cookie, and rejects a token from another cookie', async () => {
    const page = await request(h.app).get(`${BASE}/login`);
    const token = csrfIn(page.text);
    const pre = cookieValue(page, 'av_pre');
    const fields = { email: 'owner@example.com', password: GOOD_PASSWORD };
    const body = { _csrf: token, ...fields };
    const noCookie = await request(h.app)
      .post(`${BASE}/login`)
      .set('Origin', SITE_URL)
      .type('form')
      .send(body);
    expect(noCookie.status).toBe(403);
    const otherCookie = await request(h.app)
      .post(`${BASE}/login`)
      .set('Origin', SITE_URL)
      .set('Cookie', 'av_pre=AAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      .type('form')
      .send(body);
    expect(otherCookie.status).toBe(403);
    const expired = await request(h.app)
      .post(`${BASE}/login`)
      .set('Origin', SITE_URL)
      .set('Cookie', `av_pre=${pre}`)
      .type('form')
      .send({ ...fields, _csrf: `1.${'0'.repeat(64)}` });
    expect(expired.status).toBe(403);
    const ok = await request(h.app)
      .post(`${BASE}/login`)
      .set('Origin', SITE_URL)
      .set('Cookie', `av_pre=${pre}`)
      .type('form')
      .send(body);
    expect(ok.status).toBe(303);
  });

  it('never changes state on GET', async () => {
    const agent = await signInFully(h, 'owner@example.com');
    for (const path of ['/logout', '/two-step/saved', '/account/sessions/revoke-others']) {
      expect((await agent.get(`${BASE}${path}`)).status).toBe(404);
    }
    expect((await agent.get(`${BASE}/account`)).status).toBe(200);
  });
});

describe('permissions on every protected route', () => {
  const guarded = ['/users', '/users/new', '/audit'];
  const expected: Record<string, number[]> = {
    owner: [200, 200, 200],
    admin: [200, 200, 200],
    editor: [403, 403, 403],
  };

  for (const role of ['owner', 'admin', 'editor']) {
    it(`${role}: allowed and denied pages`, async () => {
      const agent = await signInFully(h, `${role}@example.com`);
      for (const [index, path] of guarded.entries()) {
        const res = await agent.get(`${BASE}${path}`);
        expect(res.status, `${role} ${path}`).toBe(expected[role]![index]);
      }
      expect((await agent.get(`${BASE}/account`)).status).toBe(200);
    });
  }

  it('signed-out visitors are sent to sign in from every protected page', async () => {
    for (const path of [
      '/',
      '/account',
      '/users',
      '/users/new',
      '/audit',
      `/users/${editor.id}/deactivate`,
    ]) {
      const res = await request(h.app).get(`${BASE}${path}`);
      expect(res.status, path).toBe(303);
      expect(res.headers.location, path).toBe(`${BASE}/login`);
    }
  });

  it('shows navigation only for sections the role may use', async () => {
    const ed = await signInFully(h, 'editor@example.com');
    const page = (await ed.get(`${BASE}/account`)).text;
    expect(page).not.toContain(`${BASE}/users`);
    expect(page).not.toContain(`${BASE}/audit`);
    const ow = await signInFully(h, 'owner@example.com');
    const full = (await ow.get(`${BASE}/account`)).text;
    expect(full).toContain(`${BASE}/users`);
    expect(full).toContain(`${BASE}/audit`);
  });

  it('an editor cannot post to user management even with a valid token', async () => {
    const ed = await signInFully(h, 'editor@example.com');
    const res = await postForm(ed, '/account', '/users', {
      email: 'x@example.com',
      displayName: 'X',
      role: 'editor',
      password: 'a long unusual passphrase 91',
    });
    expect(res.status).toBe(403);
    const exists = await h.pool.query(`SELECT 1 FROM admin_users WHERE email = 'x@example.com'`);
    expect(exists.rowCount).toBe(0);
  });
});

describe('user management rules', () => {
  it('an owner creates a user who must change the temporary password', async () => {
    const agent = await signInFully(h, 'owner@example.com');
    const res = await postForm(agent, '/users/new', '/users', {
      email: 'New.Person@Example.com',
      displayName: 'New Person',
      role: 'editor',
      password: 'Tmp-passphrase-4821',
    });
    expect(res.status).toBe(303);
    const row = await h.pool.query(
      `SELECT email, role, must_change_password FROM admin_users WHERE email = 'new.person@example.com'`,
    );
    expect(row.rows[0]).toEqual({
      email: 'new.person@example.com',
      role: 'editor',
      must_change_password: true,
    });
    const dup = await postForm(agent, '/users/new', '/users', {
      email: 'new.person@example.com',
      displayName: 'Dup',
      role: 'editor',
      password: 'Tmp-passphrase-4821',
    });
    expect(dup.status).toBe(409);
  });

  it('blocks privilege escalation: nobody grants a higher role than their own', async () => {
    const ad = await signInFully(h, 'admin@example.com');
    const res = await postForm(ad, '/users/new', '/users', {
      email: 'sneaky@example.com',
      displayName: 'Sneaky',
      role: 'owner',
      password: 'Tmp-passphrase-4821',
    });
    expect(res.status).toBe(403);
    expect(
      (await h.pool.query(`SELECT 1 FROM admin_users WHERE email = 'sneaky@example.com'`)).rowCount,
    ).toBe(0);
    const promote = await postForm(ad, `/users/${editor.id}/role`, `/users/${editor.id}/role`, {
      role: 'owner',
    });
    expect(promote.status).toBe(403);
    expect(
      (await h.pool.query('SELECT role FROM admin_users WHERE id = $1', [editor.id])).rows[0].role,
    ).toBe('editor');
  });

  it('an admin cannot touch an owner or another admin, and nobody can change their own role', async () => {
    const ad = await signInFully(h, 'admin@example.com');
    for (const [id, action, fields] of [
      [owner.id, 'deactivate', {}],
      [owner.id, 'role', { role: 'editor' }],
      [owner.id, 'reset-two-step', {}],
      [admin2.id, 'deactivate', {}],
      [admin2.id, 'role', { role: 'editor' }],
      [admin.id, 'role', { role: 'owner' }],
      [admin.id, 'deactivate', {}],
    ] as const) {
      const res = await postForm(ad, '/account', `/users/${id}/${action}`, fields);
      expect(res.status, `${id} ${action}`).toBe(403);
    }
    const stillActive = await h.pool.query(
      `SELECT count(*)::int AS n FROM admin_users WHERE active AND email IN ('owner@example.com','admin2@example.com','admin@example.com')`,
    );
    expect(stillActive.rows[0].n).toBe(3);
    const ow = await signInFully(h, 'owner@example.com');
    expect(
      (await postForm(ow, '/account', `/users/${owner.id}/role`, { role: 'admin' })).status,
    ).toBe(403);
  });

  it("cross-user access: an editor cannot revoke someone else's session", async () => {
    const ow = await signInFully(h, 'owner@example.com');
    const ownerSession = (
      await h.pool.query(
        `SELECT s.id FROM admin_sessions s WHERE s.user_id = $1 AND s.revoked_at IS NULL LIMIT 1`,
        [owner.id],
      )
    ).rows[0].id;
    const ed = await signInFully(h, 'editor@example.com');
    const res = await postForm(ed, '/account', `/account/sessions/${ownerSession}/revoke`, {});
    expect(res.status).toBe(303);
    expect(
      (await h.pool.query('SELECT revoked_at FROM admin_sessions WHERE id = $1', [ownerSession]))
        .rows[0].revoked_at,
    ).toBeNull();
    expect((await ow.get(`${BASE}/account`)).status).toBe(200);
  });

  it("role change, deactivation and reactivation end the person's sessions at once", async () => {
    const victim = await h.user({ email: 'victim@example.com', role: 'editor', twoStep: true });
    const ow = await signInFully(h, 'owner@example.com');
    const vic = await signInFully(h, 'victim@example.com', victim.totpSecret);
    expect((await vic.get(`${BASE}/account`)).status).toBe(200);
    expect(
      (await postForm(ow, '/account', `/users/${victim.id}/role`, { role: 'admin' })).status,
    ).toBe(303);
    expect((await vic.get(`${BASE}/account`)).status).toBe(303);

    const vic2 = await signInFully(h, 'victim@example.com', victim.totpSecret, GOOD_PASSWORD, 1);
    expect((await postForm(ow, '/account', `/users/${victim.id}/deactivate`, {})).status).toBe(303);
    expect((await vic2.get(`${BASE}/account`)).status).toBe(303);
    expect((await signIn(h.agent(), 'victim@example.com')).status).toBe(401);
    expect((await postForm(ow, '/account', `/users/${victim.id}/reactivate`, {})).status).toBe(303);
    expect((await signIn(h.agent(), 'victim@example.com')).status).toBe(303);

    const reset = await postForm(ow, '/account', `/users/${victim.id}/reset-two-step`, {});
    expect(reset.status).toBe(303);
    const after = await h.pool.query(
      'SELECT totp_secret_encrypted, totp_enabled_at FROM admin_users WHERE id = $1',
      [victim.id],
    );
    expect(after.rows[0]).toEqual({ totp_secret_encrypted: null, totp_enabled_at: null });
  });

  it('protects the last remaining owner, even from a second owner acting at the same time', async () => {
    const solo = await startAdmin({ ADMIN_REQUIRE_2FA: 'false' });
    try {
      const a = await solo.user({ email: 'a@example.com', role: 'owner' });
      const b = await solo.user({ email: 'b@example.com', role: 'owner' });
      const agentA = await signInFully(solo, 'a@example.com');
      const agentB = await signInFully(solo, 'b@example.com');
      const results = await Promise.all([
        postForm(agentA, '/account', `/users/${b.id}/deactivate`, {}),
        postForm(agentB, '/account', `/users/${a.id}/deactivate`, {}),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([303, 409]);
      const active = await solo.pool.query(
        `SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active`,
      );
      expect(active.rows[0].n).toBe(1);
    } finally {
      await solo.close();
    }
  });
});

describe('audit log', () => {
  it('lists newest first with filters and pagination, and never shows secrets', async () => {
    const ow = await signInFully(h, 'owner@example.com');
    const page = await ow.get(`${BASE}/audit`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('auth.sign_in');
    expect(page.text).not.toMatch(/\$argon2/);
    expect(page.text).not.toContain(GOOD_PASSWORD);
    const filtered = await ow.get(`${BASE}/audit?action=user.created`);
    expect(filtered.text).toContain('user.created');
    expect(filtered.text).not.toContain('<code>auth.sign_in</code>');
    const bogus = await ow.get(`${BASE}/audit?action=%27%3Bdrop&page=abc&user=x`);
    expect(bogus.status).toBe(200);
    for (let i = 0; i < 30; i += 1) {
      await h.pool.query(
        `INSERT INTO audit_log (actor, action, entity) VALUES ('system', 'session.revoked', 'test')`,
      );
    }
    const first = await ow.get(`${BASE}/audit`);
    expect(first.text).toContain('Older');
    const second = await ow.get(`${BASE}/audit?page=2`);
    expect(second.text).toContain('Newer');
  });

  it('still rejects updates, deletes and truncation at the database', async () => {
    await expect(h.pool.query(`UPDATE audit_log SET actor = 'x'`)).rejects.toThrow(/append-only/);
    await expect(h.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(h.pool.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('records user management events', async () => {
    const rows = await h.pool.query('SELECT DISTINCT action FROM audit_log');
    const actions = rows.rows.map((r) => r.action);
    for (const wanted of [
      'user.created',
      'user.role_changed',
      'user.deactivated',
      'user.reactivated',
      'two_step.reset',
    ]) {
      expect(actions, wanted).toContain(wanted);
    }
  });
});
