import type { IconName } from '../lib/icons.js';
import { can, type Permission, type Role } from '../security/permissions.js';

export interface AdminNavItem {
  id: string;
  label: string;
  /** Path below the admin base, for example "/users". */
  path: string;
  icon: IconName;
  permission: Permission;
}

/**
 * The single list that drives admin navigation. A later version adds a section by
 * adding one entry here and mounting its route. Items are filtered by permission.
 */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/', icon: 'house', permission: 'account.self' },
  { id: 'account', label: 'Account', path: '/account', icon: 'user', permission: 'account.self' },
  { id: 'users', label: 'Users', path: '/users', icon: 'users', permission: 'users.manage' },
  {
    id: 'audit',
    label: 'Audit log',
    path: '/audit',
    icon: 'scroll-text',
    permission: 'audit.view',
  },
];

export function navFor(role: Role): AdminNavItem[] {
  return ADMIN_NAV.filter((item) => can(role, item.permission));
}
