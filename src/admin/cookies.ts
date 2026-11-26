import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config/env.js';

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header || header.length > 4096) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in result)) result[name] = value;
  }
  return result;
}

export interface CookieNames {
  session: string;
  pre: string;
}

/** In production the names carry the __Secure- prefix, so browsers refuse them without HTTPS. */
export function cookieNames(config: Pick<AppConfig, 'isProduction'>): CookieNames {
  const prefix = config.isProduction ? '__Secure-' : '';
  return { session: `${prefix}av_admin`, pre: `${prefix}av_pre` };
}

function baseOptions(config: Pick<AppConfig, 'isProduction' | 'adminPathSlug'>): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: `/${config.adminPathSlug}`,
  };
}

/** Session cookie: no expiry, so it ends with the browser. The server enforces the real limits. */
export function setSessionCookie(
  res: Response,
  config: Pick<AppConfig, 'isProduction' | 'adminPathSlug'>,
  token: string,
): void {
  res.cookie(cookieNames(config).session, token, baseOptions(config));
}

export function setPreCookie(
  res: Response,
  config: Pick<AppConfig, 'isProduction' | 'adminPathSlug'>,
  value: string,
): void {
  res.cookie(cookieNames(config).pre, value, { ...baseOptions(config), maxAge: 30 * 60_000 });
}

export function clearSessionCookie(
  res: Response,
  config: Pick<AppConfig, 'isProduction' | 'adminPathSlug'>,
): void {
  res.clearCookie(cookieNames(config).session, baseOptions(config));
}

export function readCookie(
  req: Request,
  config: Pick<AppConfig, 'isProduction'>,
  which: keyof CookieNames,
): string | undefined {
  return parseCookies(req.headers.cookie)[cookieNames(config)[which]];
}
