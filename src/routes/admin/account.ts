import { Router, type Request, type Response } from 'express';
import { writeAudit } from '../../admin/audit.js';
import {
  changePassword,
  disableTwoStep,
  regenerateRecoveryCodes,
  requireRecentPassword,
} from '../../admin/auth.js';
import { clearSessionCookie, setSessionCookie } from '../../admin/cookies.js';
import {
  renderAdminPlain,
  renderAdminShell,
  requestInfo,
  requireCsrf,
  requirePermission,
  requireSignedIn,
  stateOf,
  wrap,
} from '../../admin/middleware.js';
import type { AdminServices } from '../../admin/services.js';
import {
  describeAgent,
  listActiveSessions,
  recentlyReauthenticated,
  revokeSession,
  revokeUserSessions,
} from '../../admin/sessions.js';
import { countRecoveryCodes } from '../../admin/users.js';
import { formBody } from '../../http/parsers.js';
import { emptyForm, field, flashFrom, reauthFailure, type FormState } from './shared.js';

type Loaded = NonNullable<ReturnType<typeof stateOf>['loaded']>;

/** Dashboard summary and the signed-in user's own account page. */
export function accountRouter(svc: AdminServices): Router {
  const router = Router();
  const signedIn = requireSignedIn(svc);
  const self = requirePermission('account.self');
  const base = (res: Response): string => res.locals.adminBase as string;
  const me = (res: Response): Loaded => stateOf(res).loaded as Loaded;
  const needsPassword = (res: Response): boolean =>
    !recentlyReauthenticated(me(res).session, svc.now());

  router.get(
    '/',
    signedIn,
    self,
    wrap(async (req, res) => {
      const { user, session } = me(res);
      const sessions = await listActiveSessions(svc.pool, user.id, svc.now());
      const previous = await svc.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM audit_log WHERE actor = $1 AND action = 'auth.sign_in'
         ORDER BY id DESC OFFSET 1 LIMIT 1`,
        [`user:${user.id}`],
      );
      await renderAdminShell(req, res, 'admin/pages/dashboard', {
        title: 'Dashboard',
        navId: 'dashboard',
        data: {
          summary: {
            twoStep: user.twoStepEnabled,
            twoStepRequired: svc.config.admin.requireTwoFactor,
            previousSignIn: previous.rows[0]?.created_at ?? null,
            activeSessions: sessions.length,
            sessionStarted: session.createdAt,
          },
        },
      });
    }),
  );

  const renderAccount = async (
    req: Request,
    res: Response,
    form: FormState = emptyForm(),
    flash: string | null = flashFrom(req),
  ): Promise<void> => {
    const { user, session } = me(res);
    const sessions = await listActiveSessions(svc.pool, user.id, svc.now());
    await renderAdminShell(req, res, 'admin/pages/account', {
      title: 'Account',
      navId: 'account',
      data: {
        form,
        flash,
        needsPassword: needsPassword(res),
        recoveryCodesLeft: user.twoStepEnabled ? await countRecoveryCodes(svc.pool, user.id) : 0,
        twoStepRequired: svc.config.admin.requireTwoFactor,
        sessions: sessions.map((item) => ({
          id: item.id,
          device: describeAgent(item.userAgent),
          ip: item.ip,
          startedAt: item.createdAt,
          lastSeenAt: item.lastSeenAt,
          current: item.id === session.id,
        })),
      },
    });
  };

  router.get(
    '/account',
    signedIn,
    self,
    wrap((req, res) => renderAccount(req, res)),
  );

  const sensitive = [formBody, signedIn, self, requireCsrf(svc, 'session')];

  router.post(
    '/account/password',
    ...sensitive,
    wrap(async (req, res) => {
      const loaded = me(res);
      const info = requestInfo(req);
      const form: FormState = { values: {}, errors: {} };
      const reauth = await requireRecentPassword(
        svc,
        loaded,
        field(req, 'currentPassword', 1024),
        info,
      );
      if (reauth.kind !== 'ok') {
        const failure = reauthFailure(res, reauth);
        form.errors.currentPassword = failure.message;
        res.status(failure.status);
        await renderAccount(req, res, form, null);
        return;
      }
      const result = await changePassword(
        svc,
        loaded,
        field(req, 'password', 1024),
        field(req, 'confirm', 1024),
        info,
        false,
      );
      if (result.kind === 'invalid') {
        form.errors[result.field] = result.message;
        res.status(400);
        await renderAccount(req, res, form, null);
        return;
      }
      setSessionCookie(res, svc.config, result.token);
      res.redirect(303, `${base(res)}/account?done=password`);
    }),
  );

  /* Two-step: turn off ---------------------------------------------------------- */
  const confirmView = (
    req: Request,
    res: Response,
    spec: { title: string; message: string; action: string; button: string; danger?: boolean },
    form: FormState = emptyForm(),
  ): Promise<void> =>
    renderAdminShell(req, res, 'admin/pages/confirm', {
      title: spec.title,
      navId: 'account',
      data: {
        form,
        needsPassword: needsPassword(res),
        spec: { ...spec, cancel: `${base(res)}/account`, action: `${base(res)}${spec.action}` },
      },
    });

  const disableSpec = {
    title: 'Turn off two-step verification',
    message:
      'Your account will be protected by your password alone. Your recovery codes will stop working.',
    action: '/account/two-step/disable',
    button: 'Turn off',
    danger: true,
  };

  router.get(
    '/account/two-step/disable',
    signedIn,
    self,
    wrap(async (req, res) => {
      if (svc.config.admin.requireTwoFactor || !me(res).user.twoStepEnabled) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      await confirmView(req, res, disableSpec);
    }),
  );

  router.post(
    '/account/two-step/disable',
    ...sensitive,
    wrap(async (req, res) => {
      const loaded = me(res);
      if (svc.config.admin.requireTwoFactor || !loaded.user.twoStepEnabled) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      const reauth = await requireRecentPassword(
        svc,
        loaded,
        field(req, 'currentPassword', 1024),
        requestInfo(req),
      );
      if (reauth.kind !== 'ok') {
        const failure = reauthFailure(res, reauth);
        res.status(failure.status);
        await confirmView(req, res, disableSpec, {
          values: {},
          errors: { currentPassword: failure.message },
        });
        return;
      }
      await disableTwoStep(svc, loaded.user, requestInfo(req));
      res.redirect(303, `${base(res)}/account?done=two-step-disabled`);
    }),
  );

  /* Recovery codes -------------------------------------------------------------- */
  const regenSpec = {
    title: 'Create new recovery codes',
    message: 'Your current recovery codes will stop working. The new codes are shown once.',
    action: '/account/recovery-codes',
    button: 'Create new codes',
  };

  router.get(
    '/account/recovery-codes',
    signedIn,
    self,
    wrap(async (req, res) => {
      if (!me(res).user.twoStepEnabled) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      await confirmView(req, res, regenSpec);
    }),
  );

  router.post(
    '/account/recovery-codes',
    ...sensitive,
    wrap(async (req, res) => {
      const loaded = me(res);
      if (!loaded.user.twoStepEnabled) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      const reauth = await requireRecentPassword(
        svc,
        loaded,
        field(req, 'currentPassword', 1024),
        requestInfo(req),
      );
      if (reauth.kind !== 'ok') {
        const failure = reauthFailure(res, reauth);
        res.status(failure.status);
        await confirmView(req, res, regenSpec, {
          values: {},
          errors: { currentPassword: failure.message },
        });
        return;
      }
      const codes = await regenerateRecoveryCodes(svc, loaded.user, requestInfo(req));
      await renderAdminPlain(req, res, 'admin/pages/recovery-codes', 'Save your recovery codes', {
        codes,
        heading: 'Your new recovery codes',
      });
    }),
  );

  /* Sessions ----------------------------------------------------------------------- */
  router.post(
    '/account/sessions/:id/revoke',
    ...sensitive,
    wrap(async (req, res) => {
      const loaded = me(res);
      const id = String(req.params.id ?? '');
      const sessions = await listActiveSessions(svc.pool, loaded.user.id, svc.now());
      const target = sessions.find((item) => item.id === id);
      if (!target) {
        res.redirect(303, `${base(res)}/account`);
        return;
      }
      await revokeSession(svc.pool, target.id);
      await writeAudit(svc.pool, {
        actor: `user:${loaded.user.id}`,
        action: 'session.revoked',
        entity: 'admin_session',
        entityId: target.id,
        ip: requestInfo(req).ip,
      });
      if (target.id === loaded.session.id) {
        clearSessionCookie(res, svc.config);
        res.redirect(303, `${base(res)}/login`);
        return;
      }
      res.redirect(303, `${base(res)}/account?done=session-revoked`);
    }),
  );

  router.post(
    '/account/sessions/revoke-others',
    ...sensitive,
    wrap(async (req, res) => {
      const loaded = me(res);
      const count = await revokeUserSessions(svc.pool, loaded.user.id, loaded.session.id);
      await writeAudit(svc.pool, {
        actor: `user:${loaded.user.id}`,
        action: 'session.revoked_all',
        entity: 'admin_user',
        entityId: loaded.user.id,
        metadata: { count },
        ip: requestInfo(req).ip,
      });
      res.redirect(303, `${base(res)}/account?done=others-revoked`);
    }),
  );

  return router;
}
