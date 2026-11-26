/**
 * The one place that defines roles and permissions. Access is denied unless a role
 * is explicitly granted a permission. Later versions attach their routes to these names.
 */
export const ROLES = ['owner', 'admin', 'editor'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'account.self',
  'users.manage',
  'audit.view',
  'settings.manage',
  'content.edit',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: ['account.self', 'users.manage', 'audit.view', 'settings.manage', 'content.edit'],
  editor: ['account.self', 'content.edit'],
};

const RANK: Record<Role, number> = { owner: 3, admin: 2, editor: 1 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role]?.includes(permission) ?? false;
}

export function permissionsOf(role: Role): readonly Permission[] {
  return GRANTS[role] ?? [];
}

export type UserAction = 'create' | 'change-role' | 'deactivate' | 'reactivate' | 'reset-two-step';

export interface Actor {
  id: string;
  role: Role;
}

export interface Target {
  id: string;
  role: Role;
}

/** Roles an actor may hand out. Nobody can grant a role higher than their own. */
export function assignableRoles(actor: Role): Role[] {
  if (!can(actor, 'users.manage')) return [];
  return ROLES.filter((role) => RANK[role] <= RANK[actor]);
}

/**
 * Whether an actor may perform an action on another account. Owners manage everyone
 * except themselves (so the last owner cannot be removed by their own hand). Admins
 * manage editors only, and can never touch owners or other admins.
 */
export function canManageUser(actor: Actor, target: Target, action: UserAction): boolean {
  if (!can(actor.role, 'users.manage')) return false;
  if (actor.id === target.id) return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return target.role === 'editor' && action !== 'create';
  return false;
}

/** The role a user may be changed to, given who is acting. */
export function canAssignRole(actor: Role, newRole: Role): boolean {
  return assignableRoles(actor).includes(newRole);
}
