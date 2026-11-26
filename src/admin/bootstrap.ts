import { writeAudit } from './audit.js';
import type { AdminServices } from './services.js';
import { revokeUserSessions } from './sessions.js';
import { clearTotp, countUsers, findUserByEmail, insertUser, setPassword } from './users.js';
import { passwordProblem } from '../security/password.js';

/**
 * Runs once at startup, after migrations.
 *
 * First owner: only when no admin users exist, from ADMIN_INITIAL_EMAIL and
 * ADMIN_INITIAL_PASSWORD. The owner must change the password at first sign-in.
 *
 * Emergency recovery: only when ADMIN_EMERGENCY_RESET is true. Replaces the password of
 * the owner whose email matches ADMIN_INITIAL_EMAIL, clears two-step verification and
 * revokes sessions. It never touches any other account. Whoever controls the deployment
 * environment already controls the system, so this opens nothing to anyone else.
 */
export async function bootstrapAdmin(svc: AdminServices): Promise<void> {
  const { logger } = svc;
  const { initialEmail, initialPassword, emergencyReset } = svc.config.admin;
  let createdThisBoot = false;

  if ((await countUsers(svc.pool)) === 0) {
    if (!initialEmail || !initialPassword) {
      logger.warn(
        'No admin users exist. Set ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD to create the first owner.',
      );
    } else {
      const problem = passwordProblem(initialPassword, { email: initialEmail });
      if (problem) {
        logger.error(
          `ADMIN_INITIAL_PASSWORD was rejected, so no owner was created: ${problem} Set a stronger value and restart.`,
        );
      } else {
        const owner = await insertUser(svc.pool, {
          email: initialEmail,
          displayName: 'Owner',
          passwordHash: await svc.hasher.hash(initialPassword),
          role: 'owner',
          mustChangePassword: true,
        });
        if (owner) {
          createdThisBoot = true;
          await writeAudit(svc.pool, {
            actor: 'system',
            action: 'system.first_owner_created',
            entity: 'admin_user',
            entityId: owner.id,
          });
          logger.warn(
            'First admin owner created from ADMIN_INITIAL_EMAIL. Sign in, set a new password, then REMOVE the ADMIN_INITIAL_PASSWORD variable.',
          );
        }
      }
    }
  }

  if (!emergencyReset || createdThisBoot) return;

  if (!initialEmail || !initialPassword) {
    logger.error(
      'ADMIN_EMERGENCY_RESET is true but ADMIN_INITIAL_EMAIL or ADMIN_INITIAL_PASSWORD is missing. Nothing was changed.',
    );
    return;
  }
  const owner = await findUserByEmail(svc.pool, initialEmail);
  if (!owner || owner.role !== 'owner') {
    logger.error(
      'ADMIN_EMERGENCY_RESET is true but no owner has the email in ADMIN_INITIAL_EMAIL. Nothing was changed.',
    );
    return;
  }
  const problem = passwordProblem(initialPassword, {
    email: owner.email,
    displayName: owner.displayName,
  });
  if (problem) {
    logger.error(
      `ADMIN_EMERGENCY_RESET could not run because the new password was rejected: ${problem}`,
    );
    return;
  }

  await setPassword(svc.pool, owner.id, await svc.hasher.hash(initialPassword), true);
  await clearTotp(svc.pool, owner.id);
  await revokeUserSessions(svc.pool, owner.id);
  await writeAudit(svc.pool, {
    actor: 'system',
    action: 'system.emergency_recovery',
    entity: 'admin_user',
    entityId: owner.id,
  });
  logger.warn(
    'EMERGENCY RECOVERY APPLIED: the owner password was replaced, two-step verification was cleared and all sessions were revoked. Sign in, then set ADMIN_EMERGENCY_RESET to false and REMOVE ADMIN_INITIAL_PASSWORD.',
  );
}
