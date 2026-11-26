import compression from 'compression';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { AppConfig } from './config/env.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { rateLimiter } from './http/rate-limit.js';
import { templateLocals } from './http/render.js';
import { requestContext } from './http/request-context.js';
import { securityHeaders } from './http/security.js';
import { loadAssetResolver, type AssetResolver } from './lib/assets.js';
import type { Logger } from './lib/logger.js';
import { ROOT_FILES_DIR, STATIC_DIR, VIEWS_DIR } from './lib/paths.js';
import { adminRouter } from './routes/admin/index.js';
import { createAdminServices, type AdminServices } from './admin/services.js';
import { PostgresRateLimitStore } from './security/pg-rate-limit-store.js';
import { livenessRouter, readinessRouter } from './routes/health.js';
import { publicRouter } from './routes/public.js';
import { seoRouter } from './routes/seo.js';
import { MemoryRateLimitStore, type RateLimitStore } from './security/rate-limit-store.js';
import { createHealthService, type HealthService } from './services/health.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  pool: pg.Pool;
  /** Override in tests. Defaults to a service backed by the pool. */
  healthService?: HealthService;
  /** Swap the rate limit storage without touching the limiter. */
  rateLimitStore?: RateLimitStore;
  /** Shared store for admin security limits. Defaults to a Postgres store on the pool. */
  adminRateLimitStore?: RateLimitStore;
  /** Pass the services built at startup so bootstrap and the app share them. Null means admin is not configured. */
  adminServices?: AdminServices | null;
  assets?: AssetResolver;
}

/**
 * Builds the Express app. It does not listen on a port, so tests can import it and
 * drive it directly.
 */
export function createApp(deps: AppDependencies): Express {
  const { config, logger, pool } = deps;
  const asset = deps.assets ?? loadAssetResolver();
  const health = deps.healthService ?? createHealthService(pool);
  const store =
    deps.rateLimitStore ?? new MemoryRateLimitStore({ maxKeys: config.rateLimit.maxKeys });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxyHops);
  app.set('case sensitive routing', true);
  app.set('query parser', 'simple');
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  app.set('view cache', config.isProduction);

  app.use(requestContext(logger, config.adminPathSlug));
  app.use(securityHeaders(config));
  app.use(compression({ threshold: 1024 }));
  app.use(templateLocals(config, asset));

  // Liveness comes before the rate limiter so platform health checks are never throttled.
  app.use(livenessRouter(health));
  app.use(
    rateLimiter({
      store,
      max: config.rateLimit.max,
      windowMs: config.rateLimit.windowMs,
      logger,
    }),
  );

  const allowCrossOrigin: RequestHandler = (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  };
  app.use(
    '/static',
    allowCrossOrigin,
    express.static(STATIC_DIR, {
      maxAge: '1y',
      immutable: true,
      index: false,
      redirect: false,
      dotfiles: 'ignore',
    }),
  );
  app.get('/favicon.ico', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile('favicon.ico', { root: ROOT_FILES_DIR, dotfiles: 'deny' }, (error) => {
      if (error) next();
    });
  });

  app.use(readinessRouter(health));
  app.use(seoRouter(config));
  app.use(publicRouter());
  const adminServices =
    deps.adminServices !== undefined
      ? deps.adminServices
      : createAdminServices({
          config,
          logger,
          pool,
          store:
            deps.adminRateLimitStore ??
            new PostgresRateLimitStore(pool, { maxRows: 50_000 }, (error) =>
              logger.error('Admin rate limit store error', { err: error }),
            ),
        });
  app.use(`/${config.adminPathSlug}`, adminRouter(adminServices, config));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
