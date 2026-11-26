import { Router, type Request, type Response } from 'express';
import { writeAudit } from '../../admin/audit.js';
import {
  attemptSignIn,
  beginEnrolment,
  changePassword,
  confirmEnrolment,
  verifyTwoStep,
} from '../../admin/auth.js';
import { clearSessionCookie, setSessionCookie } from '../../admin/cookies.js';
import { describeWait } from '../../admin/limits.js';
import {
  preSignInForms,
  renderAdminPlain,
  requestInfo,
  requireCsrf,
  requireSignedIn,
  stateOf,
  wrap,
} from '../../admin/middleware.js';
import type { AdminServices } from '../../admin/services.js';
import { revokeSession } from '../../admin/sessions.js';
import { formBody } from '../../http/parsers.js';
import { emptyForm, field, throttleMessage } from './shared.js';

/** Sign-in, two-step verification, sign-out, forced password change and enrolment. */
export function authRouter(svc: AdminServices): Router {
  const router = Router();
  const base = (res: Response): string => res.locals.adminBase as string;

  /* Sign in ---------------------------------------------------------------- */
  router.get(
    '/login',
    preSignInForms(svc),
    wrap(async (req, res) => {
      const loaded = stateOf(res).loaded;
      if (loaded?.session.stage === 'active') {
        res.redirect(303, `${base(res)}/`);
        return;
      }
      await renderAdminPlain(req, res, 'admin/pages/login', 'Sign in', { form: emptyForm() });
    }),
  );

  router.post(
    '/login',
    formBody,
    preSignInForms(svc),
    requireCsrf(svc, 'pre'),
    wrap(async (req, res) => {
      const email = field(req, 'email', 254);
      const password = field(req, 'password', 1024);
      const result = await attemptSignIn(svc, email, password, requestInfo(req));
      const form = { values: { email }, errors: {} as Record<string, string> };

      if (result.kind === 'throttled') {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        res.status(429);
        await renderAdminPlain(req, res, 'admin/pages/login', 'Sign in', {
          form,
          throttled: {
            message: throttleMessage(result.retryAfterSeconds),
            seconds: result.retryAfterSeconds,
            wait: describeWait(result.retryAfterSeconds),
          },
        });
        return;
      }
      if (result.kind === 'invalid') {
        res.status(401);
        await renderAdminPlain(req, res, 'admin/pages/login', 'Sign in', {
          form,
          failed: true,
        });
        return;
      }

      // A fresh identifier on every sign-in: any earlier session cookie is ended.
      const previous = stateOf(res).loaded;
      if (previous) await revokeSession(svc.pool, previous.session.id);
      setSessionCookie(res, svc.config, result.token);
      res.redirect(
        303,
        result.stage === 'pending' ? `${base(res)}/login/two-step` : `${base(res)}/`,
      );
    }),
  );

  /* Two-step challenge -------------------------------------------------------- */
  const pendingOnly = (req: Request, res: Response): boolean => {
    const loaded = stateOf(res).loaded;
    if (!loaded || loaded.session.stage !== 'pending') {
      res.redirect(303, `${base(res)}/login`);
      return false;
    }
    return true;
  };

  router.get(
    '/login/two-step',
    wrap(async (req, res) => {
      if (!pendingOnly(req, res)) return;
      await renderAdminPlain(req, res, 'admin/pages/two-step', 'Two-step verification', {
        form: emptyForm(),
        recoveryMode: req.query.mode === 'recovery',
      });
    }),
  );

  router.post(
    '/login/two-step',
    formBody,
    requireCsrf(svc, 'session'),
    wrap(async (req, res) => {
      if (!pendingOnly(req, res)) return;
      const loaded = stateOf(res).loaded as NonNullable<ReturnType<typeof stateOf>['loaded']>;
      const recoveryMode = field(req, 'mode', 10) === 'recovery';
      const result = await verifyTwoStep(
        svc,
        loaded,
        recoveryMode ? { recovery: field(req, 'recovery', 40) } : { code: field(req, 'code', 20) },
        requestInfo(req),
      );
      if (result.kind === 'ok') {
        setSessionCookie(res, svc.config, result.token);
        res.redirect(303, `${base(res)}/`);
        return;
      }
      const form = emptyForm();
      if (result.kind === 'throttled') {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        res.status(429);
        form.errors.code = throttleMessage(result.retryAfterSeconds);
      } else {
        res.status(401);
        form.errors.code = recoveryMode
          ? 'That recovery code did not work.'
          : 'That code did not work. Check the time on your phone and try the newest code.';
      }
      await renderAdminPlain(req, res, 'admin/pages/two-step', 'Two-step verification', {
        form,
        recoveryMode,
      });
    }),
  );

  /* Sign out ----------------------------------------------------------------- */
  router.post(
    '/logout',
    formBody,
    requireCsrf(svc, 'session'),
    wrap(async (req, res) => {
      const loaded = stateOf(res).loaded;
      if (loaded) {
        await revokeSession(svc.pool, loaded.session.id);
        await writeAudit(svc.pool, {
          actor: `user:${loaded.user.id}`,
          action: 'auth.sign_out',
          entity: 'admin_user',
          entityId: loaded.user.id,
          ip: requestInfo(req).ip,
        });
      }
      clearSessionCookie(res, svc.config);
      res.redirect(303, `${base(res)}/login`);
    }),
  );

  /* Forced password change ------------------------------------------------------ */
  const forcedGate = requireSignedIn(svc, { allowDuringPasswordChange: true });

  router.get(
    '/password',
    forcedGate,
    wrap(async (req, res) => {
      const loaded = stateOf(res).loaded as NonNullable<ReturnType<typeof stateOf>['loaded']>;
      if (!loaded.user.mustChangePassword) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      await renderAdminPlain(req, res, 'admin/pages/password-forced', 'Choose a new password', {
        form: emptyForm(),
        me: { displayName: loaded.user.displayName, email: loaded.user.email },
      });
    }),
  );

  router.post(
    '/password',
    formBody,
    forcedGate,
    requireCsrf(svc, 'session'),
    wrap(async (req, res) => {
      const loaded = stateOf(res).loaded as NonNullable<ReturnType<typeof stateOf>['loaded']>;
      if (!loaded.user.mustChangePassword) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      const result = await changePassword(
        svc,
        loaded,
        field(req, 'password', 1024),
        field(req, 'confirm', 1024),
        requestInfo(req),
        true,
      );
      if (result.kind === 'ok') {
        setSessionCookie(res, svc.config, result.token);
        res.redirect(303, `${base(res)}/`);
        return;
      }
      const form = emptyForm();
      form.errors[result.field] = result.message;
      res.status(400);
      await renderAdminPlain(req, res, 'admin/pages/password-forced', 'Choose a new password', {
        form,
        me: { displayName: loaded.user.displayName, email: loaded.user.email },
      });
    }),
  );

  /* Two-step enrolment ------------------------------------------------------------ */
  const enrolGate = requireSignedIn(svc, { allowDuringEnrolment: true });

  const renderSetup = async (req: Request, res: Response, form = emptyForm()): Promise<void> => {
    const loaded = stateOf(res).loaded as NonNullable<ReturnType<typeof stateOf>['loaded']>;
    const details = await beginEnrolment(svc, loaded.user);
    await renderAdminPlain(req, res, 'admin/pages/two-step-setup', 'Set up two-step verification', {
      form,
      details,
      required: svc.config.admin.requireTwoFactor && !loaded.user.twoStepEnabled,
    });
  };

  router.get(
    '/two-step/setup',
    enrolGate,
    wrap(async (req, res) => {
      const loaded = stateOf(res).loaded as NonNullable<ReturnType<typeof stateOf>['loaded']>;
      if (loaded.user.twoStepEnabled) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      await renderSetup(req, res);
    }),
  );

  router.post(
    '/two-step/setup',
    formBody,
    enrolGate,
    requireCsrf(svc, 'session'),
    wrap(async (req, res) => {
      const loaded = stateOf(res).loaded as NonNullable<ReturnType<typeof stateOf>['loaded']>;
      if (loaded.user.twoStepEnabled) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      const result = await confirmEnrolment(svc, loaded, field(req, 'code', 20), requestInfo(req));
      if (result.kind === 'ok') {
        setSessionCookie(res, svc.config, result.token);
        await renderAdminPlain(req, res, 'admin/pages/recovery-codes', 'Save your recovery codes', {
          codes: result.recoveryCodes,
          heading: 'Two-step verification is on',
        });
        return;
      }
      const form = emptyForm();
      if (result.kind === 'throttled') {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        res.status(429);
        form.errors.code = throttleMessage(result.retryAfterSeconds);
      } else {
        res.status(400);
        form.errors.code = 'That code did not match. Check the time on your phone and try again.';
      }
      await renderSetup(req, res, form);
    }),
  );

  router.post('/two-step/saved', formBody, requireCsrf(svc, 'session'), (_req, res) => {
    res.redirect(303, `${base(res)}/`);
  });

  return router;
}
