import { Router } from 'express';
import { renderPage } from '../http/render.js';

/**
 * Placeholder for the admin entrance, mounted at the secret path. The secrecy of the
 * path is an extra layer only. Nothing here relies on it for protection, and nothing
 * here accepts input, sets cookies or reads data.
 */
export function adminRouter(): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (req, res, next) => {
    renderPage(
      req,
      res,
      'admin/placeholder',
      { pageId: 'admin', title: 'Admin', noindex: true },
      {},
      'admin/layout',
    ).catch(next);
  });

  router.all('/', (_req, res) => {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).type('text/plain').send('Method not allowed.');
  });

  return router;
}
