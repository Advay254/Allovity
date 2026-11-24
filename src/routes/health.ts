import { Router } from 'express';
import type { HealthService } from '../services/health.js';

/** Liveness: 200 whenever the process runs. Mounted before the rate limiter. */
export function livenessRouter(health: HealthService): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(health.liveness());
  });
  return router;
}

/** Readiness: 200 when the database answers, 503 when it does not. No internal detail. */
export function readinessRouter(health: HealthService): Router {
  const router = Router();
  router.get('/readyz', (_req, res, next) => {
    health
      .readiness()
      .then(({ ready }) => {
        res.setHeader('Cache-Control', 'no-store');
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
      })
      .catch(next);
  });
  return router;
}
