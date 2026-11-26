import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getClientIp, rateLimitKey } from '../lib/client-ip.js';
import { renderPage } from '../http/render.js';
import { can, type Permission } from '../security/permissions.js';
import { readCookie } from './cookies.js';
import {
  newPreSignInCookieValue,
  originAllowed,
  preSignInToken,
  sessionCsrfToken,
  verifyPreSignInToken,
  verifySessionCsrf,
} from './csrf.js';
import { navFor } from './nav.js';
import type { AdminServices } from './services.js';
import { loadSession, touchSession, type LoadedSession } from './sessions.js';
import type { RequestInfo } from './auth.js';
import { publicUser } from './users.js';
import { setPreCookie } from './cookies.js';

/** What the middleware attaches to a request. */
export interface AdminRequestState {
  loaded: LoadedSession | null;
}

export function stateOf(res: Response): AdminRequestState {
  return res.locals.adminState as AdminRequestState;
}

export function requestInfo(req: Request): RequestInfo {
  const agent = req.headers['user-agent'];
  return { ip: getClientIp(req), userAgent: typeof agent === 'string' ? agent : null };
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Express 4 does not catch rejected promises, so every async handler goes through this. */
export function wrap(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Headers on every admin response: never cached, never indexed, no referrer. */
export const adminHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

/** General limit on admin requests per client network, in the shared store. */
export function adminRequestLimiter(svc: AdminServices): RequestHandler {
  return wrap(async (req, res, next) => {
    const { max, windowMs } = svc.requestLimit;
    const hit = await svc.store.increment(
      `adm:req:${rateLimitKey(getClientIp(req))}`,
      windowMs,
      svc.now(),
    );
    if (hit.count > max) {
      const seconds = Math.max(1, Math.ceil(hit.resetMs / 1000));
      res.setHeader('Retry-After', String(seconds));
      res.status(429);
      await renderAdminPlain(req, res, 'admin/pages/throttled', 'Too many requests', {
        seconds,
      });
      return;
    }
    next();
  });
}

/** Reads the session cookie and, if it is valid, attaches the session and user. */
export function loadAdminState(svc: AdminServices): RequestHandler {
  return wrap(async (req, res, next) => {
    const state: AdminRequestState = { loaded: null };
    res.locals.adminState = state;
    const token = readCookie(req, svc.config, 'session');
    if (token) {
      const loaded = await loadSession(svc.pool, token, svc.now());
      if (loaded) {
        state.loaded = loaded;
        if (loaded.session.stage === 'active') {
          await touchSession(svc.pool, loaded.session, svc.config.admin.sessionIdleMs, svc.now());
        }
      }
    }
    next();
  });
}

/** Renders a page inside the signed-out layout (centred panel). */
export async function renderAdminPlain(
  req: Request,
  res: Response,
  view: string,
  title: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await renderPage(
    req,
    res,
    view,
    { pageId: 'admin-plain', title, noindex: true, pageScript: 'admin/forms.js' },
    { adminBase: res.locals.adminBase, ...data },
    'admin/layout-plain',
  );
}

/** Renders a page inside the signed-in shell (top bar, navigation, identity). */
export async function renderAdminShell(
  req: Request,
  res: Response,
  view: string,
  options: { title: string; navId: string; data?: Record<string, unknown> },
): Promise<void> {
  const loaded = stateOf(res).loaded as LoadedSession;
  await renderPage(
    req,
    res,
    view,
    {
      pageId: `admin-${options.navId}`,
      title: options.title,
      noindex: true,
      pageScript: 'admin/forms.js',
    },
    {
      adminBase: res.locals.adminBase,
      me: publicUser(loaded.user),
      csrfToken: res.locals.csrfToken,
      navItems: navFor(loaded.user.role),
      navId: options.navId,
      ...options.data,
    },
    'admin/layout',
  );
}

/** Creates (once) the random pre-sign-in cookie and exposes a signed form token for it. */
export function preSignInForms(svc: AdminServices): RequestHandler {
  return (req, res, next) => {
    let value = readCookie(req, svc.config, 'pre');
    if (!value || !/^[A-Za-z0-9_-]{20,64}$/.test(value)) {
      value = newPreSignInCookieValue();
      setPreCookie(res, svc.config, value);
    }
    res.locals.preCookie = value;
    res.locals.csrfToken = preSignInToken(svc, value, svc.now());
    next();
  };
}

function csrfFailed(req: Request, res: Response, svc: AdminServices): void {
  const loaded = stateOf(res).loaded;
  res.status(403);
  const render =
    loaded && loaded.session.stage === 'active'
      ? renderAdminShell(req, res, 'admin/pages/csrf', {
          title: 'Request refused',
          navId: 'none',
        })
      : renderAdminPlain(req, res, 'admin/pages/csrf', 'Request refused');
  render.catch((error: unknown) => {
    svc.logger.error('CSRF page failed to render', { err: error });
    if (!res.headersSent) res.type('text/plain').send('Request refused.');
  });
}

/**
 * Every state-changing admin request must pass two checks: the browser says it came from
 * this site (Origin or Sec-Fetch-Site), and the form carries a valid token. Signed-in
 * forms use a per-session token. Forms shown before sign-in use a short-lived signed
 * token tied to the pre-sign-in cookie.
 */
export function requireCsrf(svc: AdminServices, mode: 'pre' | 'session'): RequestHandler {
  return (req, res, next) => {
    const host = req.get('host');
    const allowed = [svc.config.publicSiteUrl];
    if (host) allowed.push(`${req.protocol}://${host}`);
    const originOk = originAllowed(req, allowed);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const loaded = stateOf(res).loaded;

    const tokenOk =
      mode === 'session'
        ? loaded !== null && verifySessionCsrf(svc, loaded.session.id, body._csrf)
        : verifyPreSignInToken(svc, readCookie(req, svc.config, 'pre'), body._csrf, svc.now());
    if (!originOk || !tokenOk) {
      svc.logger.warn('Admin request refused by forgery protection');
      csrfFailed(req, res, svc);
      return;
    }
    next();
  };
}

/** Exposes the session CSRF token to templates for signed-in and pending sessions. */
export function exposeSessionCsrf(svc: AdminServices): RequestHandler {
  return (_req, res, next) => {
    const loaded = stateOf(res).loaded;
    if (loaded) res.locals.csrfToken = sessionCsrfToken(svc, loaded.session.id);
    next();
  };
}

/**
 * Requires a fully signed-in session (past two-step verification) and enforces the two
 * account gates: a forced password change, and mandatory two-step enrolment. A user stuck
 * behind a gate can reach only the screen that clears it, and sign out.
 */
export function requireSignedIn(
  svc: AdminServices,
  options: { allowDuringPasswordChange?: boolean; allowDuringEnrolment?: boolean } = {},
): RequestHandler {
  return (req, res, next) => {
    const loaded = stateOf(res).loaded;
    const base = res.locals.adminBase as string;
    if (!loaded || loaded.session.stage !== 'active') {
      res.redirect(303, `${base}/login`);
      return;
    }
    const { user } = loaded;
    if (user.mustChangePassword && !options.allowDuringPasswordChange) {
      res.redirect(303, `${base}/password`);
      return;
    }
    if (
      svc.config.admin.requireTwoFactor &&
      !user.twoStepEnabled &&
      !options.allowDuringEnrolment &&
      !user.mustChangePassword
    ) {
      res.redirect(303, `${base}/two-step/setup`);
      return;
    }
    next();
  };
}

/** Denies by default: the signed-in user's role must hold the named permission. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    const loaded = stateOf(res).loaded;
    if (!loaded || !can(loaded.user.role, permission)) {
      res.status(403);
      renderAdminShell(req, res, 'admin/pages/forbidden', {
        title: 'Not allowed',
        navId: 'none',
      }).catch(next);
      return;
    }
    next();
  };
}
