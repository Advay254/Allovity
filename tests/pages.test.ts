import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { primaryNav, footerLinks, headerCta } from '../src/config/nav.js';
import { buildTestApp, SITE_URL } from './helpers/app.js';

describe('home page', () => {
  const { app } = buildTestApp();

  it('has the required copy, one h1, landmarks and a skip link', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain("Engineering what's next.");
    expect(html).toContain(
      'We create software products that make technology more useful, accessible and powerful.',
    );
    expect(html).toContain('Explore products');
    expect(html).toContain('Independent products.');
    expect(html).toContain('Thoughtful engineering.');
    expect(html).toContain('Real-world solutions.');
    for (const label of ['Communication', 'Automation', 'Infrastructure', 'Digital Experiences']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<header');
    expect(html).toContain('<footer');
    expect(html).toMatch(/class="skip-link" href="#main"/);
    expect(html).toContain('data-page="home"');
    expect(html).toContain(`&copy; <span class="tabular-nums">${new Date().getFullYear()}</span>`);
  });

  it('has unique metadata with absolute canonical and social tags', async () => {
    const html = (await request(app).get('/')).text;
    expect(html).toContain('<title>Allovity | Software Engineering Studio</title>');
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/">`);
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain(`property="og:url" content="${SITE_URL}/"`);
    expect(html).toMatch(
      new RegExp(`property="og:image" content="${SITE_URL}/static/og-image\\.[0-9a-f]{10}\\.png"`),
    );
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html.match(/name="theme-color"/g)).toHaveLength(1);
    expect(html).toContain('name="theme-color" content="#F7F9FC"');
    expect(html).toContain('name="color-scheme" content="only light"');
    expect(html).toContain('page-init.');
    expect(html).not.toContain('theme-init');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).not.toContain('noindex');
  });

  it('only links to places that exist', async () => {
    const html = (await request(app).get('/')).text;
    const entries = [...primaryNav, headerCta, ...footerLinks];
    for (const entry of entries) {
      const [path, hash] = entry.href.split('#');
      expect(path === '' || path === '/').toBe(true);
      if (hash) expect(html, entry.href).toContain(`id="${hash}"`);
    }
    expect(html).toContain('href="#studio"');
  });

  it('hero call to action targets the studio section on the same page', async () => {
    const html = (await request(app).get('/')).text;
    expect(html).toMatch(/<a class="btn btn-primary btn-lg" href="#studio">Explore products/);
    expect(html).not.toMatch(/loading="lazy"/);
  });

  it('serves hashed static files with long-lived caching and short HTML caching', async () => {
    const page = await request(app).get('/');
    expect(page.headers['cache-control']).toBe('public, max-age=60');
    const css = /href="(\/static\/public\.[0-9a-f]{10}\.css)"/.exec(page.text)?.[1] as string;
    const res = await request(app).get(css);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const font = /rel="preload" href="(\/static\/inter[^"]+)"/.exec(page.text)?.[1] as string;
    expect((await request(app).get(font)).status).toBe(200);
    expect(page.text).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('serves favicon.ico and the social image as real image files', async () => {
    const ico = await request(app).get('/favicon.ico');
    expect(ico.status).toBe(200);
    expect(ico.headers['content-type']).toMatch(/icon/);
    const page = (await request(app).get('/')).text;
    const og = /property="og:image" content="https:\/\/allovity\.test(\/static\/[^"]+)"/.exec(
      page,
    )?.[1] as string;
    const img = await request(app)
      .get(og)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(img.status).toBe(200);
    expect((img.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    expect((img.body as Buffer).readUInt32BE(16)).toBe(1200);
    expect((img.body as Buffer).readUInt32BE(20)).toBe(630);
  });
});
