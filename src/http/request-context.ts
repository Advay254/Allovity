import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { getClientIp } from '../lib/client-ip.js';
import type { Logger } from '../lib/logger.js';

/** The admin path is a secret, so it must never appear in logs. */
export function maskAdminPath(path: string, slug: string): string {
  const prefix = `/${slug}`;
  if (path === prefix || path.startsWith(`${prefix}/`))
    return `/[admin]${path.slice(prefix.length)}`;
  return path;
}

/**
 * Gives every request an identifier (always generated here, never trusted from the
 * client), returns it in X-Request-Id and writes one structured access log line.
 * Query strings, cookies and authorization headers are never logged.
 */
export function requestContext(logger: Logger, adminSlug: string): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.locals.log = logger.child({ requestId });
    res.setHeader('X-Request-Id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const path = maskAdminPath(req.originalUrl.split('?')[0] ?? '/', adminSlug).slice(0, 200);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      (res.locals.log as Logger)[level]('request', {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: getClientIp(req),
      });
    });
    next();
  };
}
