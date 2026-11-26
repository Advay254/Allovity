import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import {
  adminHeaders,
  adminRequestLimiter,
  exposeSessionCsrf,
  loadAdminState,
  renderAdminPlain,
  wrap,
} from '../../admin/middleware.js';
import type { AdminServices } from '../../admin/services.js';
import { accountRouter } from './account.js';
import { auditRouter } from './audit.js';
import { authRouter } from './auth.js';
import { usersRouter } from './users.js';

/**
 * Admin area, mounted at the secret path. The path is an extra layer only: every route
 * below checks authentication and the specific permission on the server.
 *
 * When the encryption secret is unusable, `services` is null. The public site keeps
 * working and every admin URL answers 503 with a plain explanation.
 */
export function adminRouter(
  services: AdminServices | null,
  config: Pick<AppConfig, 'adminPathSlug'>,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.locals.adminBase = `/${config.adminPathSlug}`;
    next();
  });
  router.use(adminHeaders);

  if (!services) {
    router.use(
      wrap(async (req, res) => {
        res.setHeader('Retry-After', '3600');
        res.status(503);
        await renderAdminPlain(req, res, 'admin/pages/not-configured', 'Admin is not configured');
      }),
    );
    return router;
  }

  router.use(adminRequestLimiter(services));
  router.use(loadAdminState(services));
  router.use(exposeSessionCsrf(services));
  router.use(authRouter(services));
  router.use(accountRouter(services));
  router.use(usersRouter(services));
  router.use(auditRouter(services));
  return router;
}
