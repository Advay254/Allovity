import { Router, type Request, type Response } from 'express';
import { requireRecentPassword } from '../../admin/auth.js';
import {
  renderAdminShell,
  requestInfo,
  requireCsrf,
  requirePermission,
  requireSignedIn,
  stateOf,
  wrap,
} from '../../admin/middleware.js';
import type { AdminServices } from '../../admin/services.js';
import { recentlyReauthenticated } from '../../admin/sessions.js';
import {
  changeUserRole,
  createManagedUser,
  generateTemporaryPassword,
  resetUserTwoStep,
  setUserActive,
  type UserOpResult,
} from '../../admin/user-admin.js';
import { findUserById, listUsers, publicUser, type AdminUser } from '../../admin/users.js';
import { formBody } from '../../http/parsers.js';
import { assignableRoles, canManageUser, type UserAction } from '../../security/permissions.js';
import { emptyForm, field, reauthFailure, type FormState } from './shared.js';

type Loaded = NonNullable<ReturnType<typeof stateOf>['loaded']>;

const ACTIONS = {
  role: { permission: 'change-role' as UserAction, done: 'role' },
  deactivate: { permission: 'deactivate' as UserAction, done: 'deactivated' },
  reactivate: { permission: 'reactivate' as UserAction, done: 'reactivated' },
  'reset-two-step': { permission: 'reset-two-step' as UserAction, done: 'two-step-reset' },
} as const;
type ActionKey = keyof typeof ACTIONS;
const isAction = (value: string): value is ActionKey => value in ACTIONS;

export function usersRouter(svc: AdminServices): Router {
  const router = Router();
  const gate = [requireSignedIn(svc), requirePermission('users.manage')];
  const post = [formBody, ...gate, requireCsrf(svc, 'session')];
  const base = (res: Response): string => res.locals.adminBase as string;
  const me = (res: Response): Loaded => stateOf(res).loaded as Loaded;
  const needsPassword = (res: Response): boolean =>
    !recentlyReauthenticated(me(res).session, svc.now());

  /* List ---------------------------------------------------------------------- */
  router.get(
    '/users',
    ...gate,
    wrap(async (req, res) => {
      const actor = me(res).user;
      const rows = (await listUsers(svc.pool)).map((user) => ({
        ...user,
        isMe: user.id === actor.id,
        can: {
          role: canManageUser(actor, user, 'change-role'),
          deactivate: user.active && canManageUser(actor, user, 'deactivate'),
          reactivate: !user.active && canManageUser(actor, user, 'reactivate'),
          resetTwoStep: user.twoStepEnabled && canManageUser(actor, user, 'reset-two-step'),
        },
      }));
      const key = typeof req.query.done === 'string' ? req.query.done : '';
      await renderAdminShell(req, res, 'admin/pages/users', {
        title: 'Users',
        navId: 'users',
        data: { users: rows, doneKey: key, canCreate: assignableRoles(actor.role).length > 0 },
      });
    }),
  );

  /* Create ---------------------------------------------------------------------- */
  const renderNew = async (req: Request, res: Response, form: FormState): Promise<void> => {
    await renderAdminShell(req, res, 'admin/pages/user-new', {
      title: 'Create user',
      navId: 'users',
      data: {
        form,
        roles: assignableRoles(me(res).user.role),
        needsPassword: needsPassword(res),
      },
    });
  };

  router.get(
    '/users/new',
    ...gate,
    wrap(async (req, res) => {
      const roles = assignableRoles(me(res).user.role);
      await renderNew(req, res, {
        values: {
          role: roles.includes('editor') ? 'editor' : (roles[0] ?? ''),
          password: generateTemporaryPassword(),
        },
        errors: {},
      });
    }),
  );

  router.post(
    '/users',
    ...post,
    wrap(async (req, res) => {
      const loaded = me(res);
      const info = requestInfo(req);
      const values = {
        email: field(req, 'email', 254),
        displayName: field(req, 'displayName', 80),
        role: field(req, 'role', 20),
        password: field(req, 'password', 128),
      };
      const form: FormState = { values, errors: {} };
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
        await renderNew(req, res, form);
        return;
      }
      const result = await createManagedUser(svc, loaded.user, values, info);
      if (!result.ok) {
        form.errors[result.field ?? 'form'] = result.message;
        res.status(result.status);
        await renderNew(req, res, form);
        return;
      }
      res.redirect(303, `${base(res)}/users?done=created`);
    }),
  );

  /* Confirm and apply an action ------------------------------------------------------ */
  const confirmPage = async (
    req: Request,
    res: Response,
    target: AdminUser,
    action: ActionKey,
    form: FormState = emptyForm(),
  ): Promise<void> => {
    const copy: Record<
      ActionKey,
      { title: string; message: string; button: string; danger?: boolean }
    > = {
      role: {
        title: `Change role for ${target.displayName}`,
        message: 'Their sessions will end so the new role applies at once.',
        button: 'Change role',
      },
      deactivate: {
        title: `Deactivate ${target.displayName}`,
        message: 'They will be signed out everywhere and will not be able to sign in.',
        button: 'Deactivate',
        danger: true,
      },
      reactivate: {
        title: `Reactivate ${target.displayName}`,
        message: 'They will be able to sign in again with their current password.',
        button: 'Reactivate',
      },
      'reset-two-step': {
        title: `Reset two-step verification for ${target.displayName}`,
        message:
          'Their authenticator and recovery codes are removed and their sessions end. They must set it up again.',
        button: 'Reset',
        danger: true,
      },
    };
    await renderAdminShell(req, res, 'admin/pages/confirm', {
      title: copy[action].title,
      navId: 'users',
      data: {
        form,
        needsPassword: needsPassword(res),
        spec: {
          ...copy[action],
          action: `${base(res)}/users/${target.id}/${action}`,
          cancel: `${base(res)}/users`,
          roleChoices: action === 'role' ? assignableRoles(me(res).user.role) : null,
          currentRole: target.role,
        },
      },
    });
  };

  const loadTarget = async (
    req: Request,
    res: Response,
  ): Promise<{ target: AdminUser; action: ActionKey } | null> => {
    const action = String(req.params.action ?? '');
    const record = await findUserById(svc.pool, String(req.params.id ?? ''));
    if (!isAction(action) || !record) {
      res.redirect(303, `${base(res)}/users`);
      return null;
    }
    const target = publicUser(record);
    if (!canManageUser(me(res).user, target, ACTIONS[action].permission)) {
      res.status(403);
      await renderAdminShell(req, res, 'admin/pages/forbidden', {
        title: 'Not allowed',
        navId: 'users',
      });
      return null;
    }
    return { target, action };
  };

  router.get(
    '/users/:id/:action',
    ...gate,
    wrap(async (req, res) => {
      const found = await loadTarget(req, res);
      if (found) await confirmPage(req, res, found.target, found.action);
    }),
  );

  router.post(
    '/users/:id/:action',
    ...post,
    wrap(async (req, res) => {
      const found = await loadTarget(req, res);
      if (!found) return;
      const { target, action } = found;
      const loaded = me(res);
      const info = requestInfo(req);
      const form: FormState = emptyForm();
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
        await confirmPage(req, res, target, action, form);
        return;
      }
      let result: UserOpResult;
      if (action === 'role') {
        result = await changeUserRole(svc, loaded.user, target.id, field(req, 'role', 20), info);
      } else if (action === 'deactivate') {
        result = await setUserActive(svc, loaded.user, target.id, false, info);
      } else if (action === 'reactivate') {
        result = await setUserActive(svc, loaded.user, target.id, true, info);
      } else {
        result = await resetUserTwoStep(svc, loaded.user, target.id, info);
      }
      if (!result.ok) {
        form.errors.form = result.message;
        res.status(result.status);
        await confirmPage(req, res, target, action, form);
        return;
      }
      res.redirect(303, `${base(res)}/users?done=${ACTIONS[action].done}`);
    }),
  );

  return router;
}
