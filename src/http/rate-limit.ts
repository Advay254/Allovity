import type { RequestHandler } from 'express';
import { getClientIp, rateLimitKey } from '../lib/client-ip.js';
import type { Logger } from '../lib/logger.js';
import type { RateLimitStore } from '../security/rate-limit-store.js';

export interface RateLimiterOptions {
  store: RateLimitStore;
  max: number;
  windowMs: number;
  logger: Logger;
  now?: () => number;
}

/**
 * Sliding-window limiter keyed by client IP. If the store itself fails the request
 * is allowed and the failure is logged: a broken limiter must not take the site down.
 */
export function rateLimiter(options: RateLimiterOptions): RequestHandler {
  const { store, max, windowMs, logger } = options;
  const now = options.now ?? Date.now;

  return async (req, res, next) => {
    try {
      const hit = await store.increment(rateLimitKey(getClientIp(req)), windowMs, now());
      const resetSeconds = Math.max(1, Math.ceil(hit.resetMs / 1000));
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - hit.count)));
      res.setHeader('RateLimit-Reset', String(resetSeconds));
      if (hit.count > max) {
        res.setHeader('Retry-After', String(resetSeconds));
        res.setHeader('Cache-Control', 'no-store');
        res.status(429).type('text/plain').send('Too many requests. Please try again shortly.');
        return;
      }
    } catch (error) {
      logger.error('Rate limiter failed, allowing request', { err: error });
    }
    next();
  };
}
