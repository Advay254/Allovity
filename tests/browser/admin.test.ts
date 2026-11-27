import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD_PASSWORD, startAdmin, type AdminHarness } from '../helpers/admin.js';
import { SLUG } from '../helpers/app.js';

const FALLBACK = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(FALLBACK) ? FALLBACK : undefined);

let browser: Browser;
let server: Server;
let base: string;
let h: AdminHarness;

beforeAll(async () => {
  h = await startAdmin({ ADMIN_REQUIRE_2FA: 'false', PUBLIC_SITE_URL: 'http://127.0.0.1:0' });
  server = h.app.listen(0);
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/${SLUG}`;
  // The origin check compares against the address the browser really used.
  await h.user({ email: 'owner@example.com', name: 'Olive Owner', role: 'owner' });
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
  await h?.close();
});

async function open(width: number, height = 800) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return { context, page, problems };
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function signInWithKeyboard(page: Page) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab'); // first stop is the email field (autofocus is also fine)
  await page.focus('#email');
  await page.keyboard.type('owner@example.com');
  await page.keyboard.press('Tab');
  await page.keyboard.type(GOOD_PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForURL(`${base}/`);
}

for (const width of [375, 768, 1440]) {
  describe(`admin at ${width}px`, () => {
    it('sign-in page has no horizontal overflow and a visible focus outline', async () => {
      const { page, context, problems } = await open(width);
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.focus('#email');
      const outline = await page.evaluate(
        () => getComputedStyle(document.activeElement as Element).outlineStyle,
      );
      expect(outline).not.toBe('none');
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        'rgb(247, 249, 252)',
      );
      expect(problems).toEqual([]);
      await context.close();
    });

    it('signs in with the keyboard and the dashboard, account, users and audit pages do not overflow', async () => {
      const { page, context, problems } = await open(width);
      await signInWithKeyboard(page);
      for (const path of ['/', '/account', '/users', '/audit']) {
        await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
        expect(await overflow(page), path).toBeLessThanOrEqual(0);
      }
      expect(problems).toEqual([]);
      await context.close();
    });
  });
}

describe('admin navigation', () => {
  it('shows the side column on wide screens and a drawer on phones', async () => {
    const wide = await open(1440);
    await signInWithKeyboard(wide.page);
    expect(await wide.page.isVisible('.admin-side')).toBe(true);
    expect(await wide.page.isVisible('[data-drawer-open]')).toBe(false);
    await wide.context.close();

    const phone = await open(375);
    await signInWithKeyboard(phone.page);
    expect(await phone.page.isVisible('.admin-side')).toBe(false);
    expect(await phone.page.isVisible('[data-drawer-open]')).toBe(true);
    await phone.context.close();
  });

  it('drawer: opens, traps focus, closes with Escape and returns focus, and locks the background', async () => {
    const { page, context } = await open(375);
    await signInWithKeyboard(page);
    await page.click('[data-drawer-open]');
    await page.waitForSelector('#admin-drawer[data-open="true"]');
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('is-locked')),
    ).toBe(true);
    expect(await page.evaluate(() => document.getElementById('main')?.hasAttribute('inert'))).toBe(
      true,
    );
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('#admin-drawer'))).toBe(
        true,
      );
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('#admin-drawer[data-open="false"]', { state: 'attached' });
    expect(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-drawer-open')),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('is-locked')),
    ).toBe(false);
    await context.close();
  });

  it('drawer links navigate and the current page is marked', async () => {
    const { page, context } = await open(375);
    await signInWithKeyboard(page);
    await page.click('[data-drawer-open]');
    await page.click('#admin-drawer a >> text=Account');
    await page.waitForURL(`${base}/account`);
    expect(await page.locator('.admin-nav__link[aria-current="page"]').count()).toBe(1);
    await context.close();
  });

  it('disables the submit button after a submit so a double click cannot send twice', async () => {
    const { page, context } = await open(375);
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await page.fill('#email', 'nobody@example.com');
    await page.fill('#password', 'not the password at all');
    await Promise.all([
      page.waitForNavigation(),
      page.evaluate(() => {
        const form = document.querySelector('form') as HTMLFormElement;
        const button = form.querySelector('button[type=submit]') as HTMLButtonElement;
        button.click();
        button.click();
      }),
    ]);
    const attempts = await h.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.sign_in_failed'`,
    );
    expect(attempts.rows[0].n).toBe(1);
    await context.close();
  });

  it('respects reduced motion on the drawer', async () => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 800 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await signInWithKeyboard(page);
    const duration = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.admin-drawer__panel') as Element)
          .transitionDuration,
    );
    expect(parseFloat(duration)).toBeLessThan(0.01);
    await context.close();
  });
});
