import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { AppConfig } from '../config/env.js';

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

/**
 * Security headers, set by the app itself so protection never depends on a host,
 * proxy or platform setting. The policy allows only the site's own resources and
 * has no inline allowances: scripts and styles must come from files.
 */
export function securityHeaders(config: Pick<AppConfig, 'isProduction'>): RequestHandler[] {
  const csp: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'manifest-src': ["'self'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  };
  if (config.isProduction) csp['upgrade-insecure-requests'] = [];

  const permissions: RequestHandler = (_req, res, next) => {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    next();
  };

  return [
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: csp },
      strictTransportSecurity: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      xPoweredBy: false,
    }),
    permissions,
  ];
}
