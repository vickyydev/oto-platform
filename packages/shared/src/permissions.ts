/**
 * Permission constants (CLAUDE.md §3): `service:resource:action` strings.
 * Roles are named bundles; a role assignment binds an account to a role with a
 * scope (operator / branch / department / record). Seed roles are generated
 * from these lists (packages/db/seed).
 */

export const PERMISSIONS = [
  // Admin console — accounts & access
  'admin:account:create',
  'admin:account:read',
  'admin:account:update',
  'admin:role:read',
  'admin:role:assign',
  'admin:operator:create',
  'admin:operator:read',
  'admin:operator:update',
  'admin:branch:create',
  'admin:branch:read',
  'admin:branch:update',
  'admin:audit:read',
  // POS — members & visits
  'pos:member:read',
  'pos:member:create',
  'pos:member:update',
  'pos:child:read',
  'pos:child:create',
  'pos:child:update',
  'pos:visit:create',
  'pos:visit:read',
  'pos:visit:update',
  // Branch catalog
  'catalog:package:read',
  'catalog:package:create',
  'catalog:package:update',
  'catalog:holiday:read',
  'catalog:holiday:manage',
  'catalog:tax:read',
  'catalog:tax:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type ScopeType = 'operator' | 'branch' | 'department' | 'record';

export const SYSTEM_ROLES = [
  'platform_admin',
  'operator_admin',
  'branch_manager',
  'reception',
  'staff',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

const ALL = [...PERMISSIONS];

const READ_CATALOG: Permission[] = ['catalog:package:read', 'catalog:holiday:read', 'catalog:tax:read'];

/**
 * Seed role bundles (CLAUDE.md §4). platform_admin additionally bypasses
 * operator scoping (cross-tenant) — that flag lives on the role row, not here.
 */
export const ROLE_BUNDLES: Record<SystemRole, Permission[]> = {
  platform_admin: ALL,
  operator_admin: ALL,
  branch_manager: [
    'admin:account:read',
    'admin:account:create',
    'admin:account:update',
    'admin:role:read',
    'admin:role:assign',
    'admin:branch:read',
    'admin:audit:read',
    'pos:member:read',
    'pos:member:create',
    'pos:member:update',
    'pos:child:read',
    'pos:child:create',
    'pos:child:update',
    'pos:visit:create',
    'pos:visit:read',
    'pos:visit:update',
    'catalog:package:read',
    'catalog:package:create',
    'catalog:package:update',
    'catalog:holiday:read',
    'catalog:holiday:manage',
    'catalog:tax:read',
    'catalog:tax:manage',
  ],
  reception: [
    'admin:branch:read',
    'pos:member:read',
    'pos:member:create',
    'pos:member:update',
    'pos:child:read',
    'pos:child:create',
    'pos:child:update',
    'pos:visit:create',
    'pos:visit:read',
    'pos:visit:update',
    ...READ_CATALOG,
  ],
  staff: [
    'admin:branch:read',
    'pos:member:read',
    'pos:child:read',
    'pos:visit:read',
    ...READ_CATALOG,
  ],
};
