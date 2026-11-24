import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

// Set CHROMIUM_PATH to a Chrome or Chromium binary. Falls back to Playwright's own download.
const FALLBACK = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(FALLBACK) ? FALLBACK : undefined);

let browser: Browser;
let server: Server;
let base: string;

beforeAll(async () => {
  const { app } = buildTestApp();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function open(
  width: number,
  options: { reducedMotion?: 'reduce'; scheme?: 'light' | 'dark' } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion: options.reducedMotion,
    colorScheme: options.scheme ?? 'dark',
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  return { page, context, problems };
}

describe('home page layout', () => {
  for (const width of [375, 768, 1440]) {
    it(`has no horizontal overflow, a centred hero and no console errors at ${width}px`, async () => {
      const { page, context, problems } = await open(width);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const centre = await page.evaluate(() => {
        const rect = (selector: string) => {
          const box = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
          return box.left + box.width / 2;
        };
        return {
          viewport: window.innerWidth / 2,
          h1: rect('h1'),
          lead: rect('.hero .lead'),
          cta: rect('.hero .btn'),
        };
      });
      expect(Math.abs(centre.h1 - centre.viewport)).toBeLessThanOrEqual(2);
      expect(Math.abs(centre.lead - centre.viewport)).toBeLessThanOrEqual(2);
      expect(Math.abs(centre.cta - centre.viewport)).toBeLessThanOrEqual(2);

      expect(problems).toEqual([]);
      await context.close();
    });
  }

  it('hero call to action scrolls to the studio section on the same page', async () => {
    const { page, context } = await open(1440);
    await page.click('.hero .btn');
    await page.waitForFunction(() => window.location.hash === '#studio');
    // Smooth scrolling is animated, so wait until the section has arrived below the header.
    await page.waitForFunction(
      () => (document.getElementById('studio') as HTMLElement).getBoundingClientRect().top < 200,
    );
    await context.close();
  });

  it('keeps the hero visible when motion is reduced', async () => {
    const { page, context } = await open(375, { reducedMotion: 'reduce' });
    const opacity = await page.evaluate(
      () => getComputedStyle(document.querySelector('.hero .lead') as HTMLElement).opacity,
    );
    expect(opacity).toBe('1');
    await context.close();
  });
});

describe('mobile drawer keyboard behaviour', () => {
  it('opens, traps focus, locks scroll, closes with Escape and returns focus', async () => {
    const { page, context } = await open(375);
    const opener = page.locator('[data-drawer-open]');
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#site-drawer[data-open="true"]');

    const inside = () =>
      page.evaluate(() =>
        (document.getElementById('site-drawer') as HTMLElement).contains(document.activeElement),
      );
    expect(await inside()).toBe(true);
    expect(await opener.getAttribute('aria-expanded')).toBe('true');
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('is-locked')),
    ).toBe(true);
    expect(await page.locator('main').getAttribute('inert')).not.toBeNull();

    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside()).toBe(true);
    }

    await page.keyboard.press('Escape');
    await page.waitForSelector('#site-drawer[data-open="false"]');
    expect(await opener.getAttribute('aria-expanded')).toBe('false');
    expect(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-drawer-open')),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('is-locked')),
    ).toBe(false);
    expect(await page.locator('main').getAttribute('inert')).toBeNull();
    await context.close();
  });

  it('closes when a menu link is chosen and the section is reachable', async () => {
    const { page, context } = await open(375);
    await page.click('[data-drawer-open]');
    await page.click('#site-drawer a.drawer__link >> text=Studio');
    await page.waitForSelector('#site-drawer[data-open="false"]');
    await page.waitForFunction(() => window.location.hash === '#studio');
    await context.close();
  });
});

describe('theme control', () => {
  it('remembers the choice and applies it before the page is interactive', async () => {
    const { page, context } = await open(1440, { scheme: 'dark' });
    await page.click('.theme-control-desktop [data-theme-set="light"]');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The attribute is already set when the document has only just been parsed.
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(247, 249, 252)');
    await page.click('.theme-control-desktop [data-theme-set="system"]');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
    await context.close();
  });

  it('follows the system preference by default', async () => {
    const { page, context } = await open(1440, { scheme: 'light' });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(247, 249, 252)',
    );
    await context.close();
  });
});
