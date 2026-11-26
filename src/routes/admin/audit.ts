import { Router } from 'express';
import { AUDIT_ACTIONS, AUDIT_PAGE_SIZE, listAudit } from '../../admin/audit.js';
import {
  renderAdminShell,
  requirePermission,
  requireSignedIn,
  wrap,
} from '../../admin/middleware.js';
import type { AdminServices } from '../../admin/services.js';
import { listUsers } from '../../admin/users.js';

export function auditRouter(svc: AdminServices): Router {
  const router = Router();

  router.get(
    '/audit',
    requireSignedIn(svc),
    requirePermission('audit.view'),
    wrap(async (req, res) => {
      const q = req.query;
      const action =
        typeof q.action === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(q.action)
          ? q.action
          : '';
      const users = await listUsers(svc.pool);
      const names = new Map(users.map((user) => [`user:${user.id}`, user.displayName]));
      const actorOptions = [
        ...users.map((user) => ({ value: `user:${user.id}`, label: user.displayName })),
        { value: 'system', label: 'System' },
        { value: 'anonymous', label: 'Not signed in' },
      ];
      const actor =
        typeof q.user === 'string' && actorOptions.some((option) => option.value === q.user)
          ? q.user
          : '';
      const rawPage = typeof q.page === 'string' ? Number.parseInt(q.page, 10) : 1;
      const page = Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 1), 1000) : 1;

      const result = await listAudit(svc.pool, { action, actor, page });
      const rows = result.rows.map((row) => ({
        ...row,
        actorName:
          names.get(row.actor) ?? (row.actor.startsWith('user:') ? 'Removed user' : row.actor),
        details: Object.entries(row.metadata).map(([key, value]) => `${key}: ${String(value)}`),
      }));
      const params = (target: number): string => {
        const search = new URLSearchParams();
        if (action) search.set('action', action);
        if (actor) search.set('user', actor);
        if (target > 1) search.set('page', String(target));
        const text = search.toString();
        return text ? `?${text}` : '';
      };
      await renderAdminShell(req, res, 'admin/pages/audit', {
        title: 'Audit log',
        navId: 'audit',
        data: {
          rows,
          page,
          pageSize: AUDIT_PAGE_SIZE,
          hasMore: result.hasMore,
          actions: AUDIT_ACTIONS,
          actorOptions,
          filter: { action, user: actor },
          newerHref: page > 1 ? params(page - 1) : null,
          olderHref: result.hasMore ? params(page + 1) : null,
        },
      });
    }),
  );

  return router;
}
