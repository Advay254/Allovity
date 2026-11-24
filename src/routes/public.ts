import { Router } from 'express';
import { renderPage } from '../http/render.js';

export function publicRouter(): Router {
  const router = Router();

  router.get('/', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    renderPage(req, res, 'pages/home', {
      pageId: 'home',
      canonicalPath: '/',
      pageScript: 'pages/home.js',
    }).catch(next);
  });

  return router;
}
