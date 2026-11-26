import type { Request } from 'express';
import { hmacHex, randomToken, safeEqual } from '../security/crypto.js';
import type { AdminServices } from './services.js';

const PRE_TOKEN_LIFETIME_MS = 30 * 60_000;

/** Token for a signed-in session: derived from the session id, so it cannot be guessed or reused elsewhere. */
export function sessionCsrfToken(svc: AdminServices, sessionId: string): string {
  return hmacHex(svc.keys.csrf, `session|${sessionId}`);
}

export function verifySessionCsrf(svc: AdminServices, sessionId: string, token: unknown): boolean {
  return typeof token === 'string' && safeEqual(token, sessionCsrfToken(svc, sessionId));
}

export function newPreSignInCookieValue(): string {
  return randomToken(24);
}

/** Short-lived token for forms shown before sign-in, tied to the random pre-sign-in cookie. */
export function preSignInToken(svc: AdminServices, cookieValue: string, now = svc.now()): string {
  const expires = now + PRE_TOKEN_LIFETIME_MS;
  return `${expires}.${hmacHex(svc.keys.csrf, `pre|${cookieValue}|${expires}`)}`;
}

export function verifyPreSignInToken(
  svc: AdminServices,
  cookieValue: string | undefined,
  token: unknown,
  now = svc.now(),
): boolean {
  if (!cookieValue || typeof token !== 'string') return false;
  const [expiresText, mac] = token.split('.');
  const expires = Number(expiresText);
  if (!mac || !Number.isFinite(expires) || expires < now) return false;
  return safeEqual(mac, hmacHex(svc.keys.csrf, `pre|${cookieValue}|${expires}`));
}

/**
 * Second layer for state-changing requests: the browser must say the request came from
 * this site. Modern browsers send Sec-Fetch-Site, which is decisive: only "same-origin"
 * passes. (Origin cannot be used alone, because the admin pages send Referrer-Policy:
 * no-referrer and browsers then send "Origin: null" on form posts.) Without Sec-Fetch-Site,
 * the Origin header must match this site. A request with neither is refused.
 */
export function originAllowed(
  req: Pick<Request, 'headers'>,
  allowedOrigins: readonly string[],
): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string') return fetchSite === 'same-origin';
  const origin = req.headers.origin;
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}
