import { Router } from 'express';
import type { AppConfig } from '../config/env.js';

/** Indexable public paths. Later versions add entries here. */
export const sitemapPaths: readonly string[] = ['/'];

export function seoRouter(config: Pick<AppConfig, 'publicSiteUrl'>): Router {
  const router = Router();
  const origin = config.publicSiteUrl;

  router.get('/robots.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', (_req, res) => {
    const urls = sitemapPaths
      .map((path) => `  <url><loc>${new URL(path, `${origin}/`).toString()}</loc></url>`)
      .join('\n');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      );
  });

  return router;
}
