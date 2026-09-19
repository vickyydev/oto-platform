/**
 * Permission constants (CLAUDE.md §3): `service:resource:action` strings.
 * Roles are named bundles; a role assignment binds an account to a role with a
 * scope (operator / branch / department / record). Seed roles are generated
 * from these lists (packages/db/seed).
 *
 * The vocabulary is declared ahead of the features that enforce it (S2-01b):
 * a permission added on the day its route is written cannot be granted to
 * anyone until the next sync, and the roles would drift apart between
 * environments in the meantime.
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
  /** Unmasked audit: child health notes, phones, terminal payloads (S2-03). */
  'admin:audit:read_sensitive',
  // Admin console — the fleet: stations, the boxes that run them, the devices
  // bolted to each box (S2-04)
  'admin:station:read',
  'admin:station:create',
  'admin:station:update',
  'admin:station:archive',
  'admin:box:read',
  'admin:box:register',
  'admin:box:update',
  /** Test print, restart, collect logs, go offline, reset store. */
  'admin:box:command',
  'admin:box:archive',
  'admin:device:read',
  'admin:device:create',
  'admin:device:update',
  'admin:device:archive',
  /** Mint a pairing code for a display, kiosk or booth. */
  'admin:device:pair',
  'admin:device:revoke',
  // Admin console — the Lucky Wheel booths (S2-07b)
  'admin:booth:read',
  'admin:booth:manage',
  /** Publish a config version the booths then pull. */
  'admin:booth:publish',
  'admin:booth:staff_assign',
  // Admin console — running the platform (S2-03)
  'admin:health:read',
  /** Retry a failed run, acknowledge an alert, resolve an expectation. */
  'admin:ops:manage',
  // POS — members & visits
  'pos:member:read',
  'pos:member:create',
  'pos:member:update',
  /** Manager gate: a tier only ever goes down with someone accountable for it. */
  'pos:member:tier_downgrade',
  'pos:child:read',
  'pos:child:create',
  'pos:child:update',
  'pos:visit:create',
  'pos:visit:read',
  'pos:visit:update',
  // POS — selling (S2-09 … S2-11)
  'pos:sale:read',
  'pos:sale:create',
  'pos:sale:update',
  /** A manual discount, which always carries a reason. */
  'pos:sale:discount',
  'pos:sale:void',
  'pos:payment:read',
  'pos:payment:capture',
  /** Confirm an attempt the terminal or gateway left unresolved. */
  'pos:payment:confirm',
  'pos:payment:void',
  'pos:payment:settle',
  'pos:refund:read',
  'pos:refund:create',
  /** Manager gate on refunds and on voids after payment. */
  'pos:refund:approve',
  'pos:voucher:redeem',
  'pos:print:read',
  'pos:print:receipt',
  'pos:print:band',
  'pos:print:voucher',
  /** A reprint keeps the original code, so it is staff-only. */
  'pos:print:reprint',
  // POS — the drawer and the day's close (S2-15a)
  'pos:cash:read',
  'pos:cash:session_open',
  'pos:cash:session_close',
  /** Paid-in, paid-out, safe drop. */
  'pos:cash:movement',
  /** Countersign a paid-out, a safe drop or a close variance. */
  'pos:cash:approve',
  'pos:cash:day_close',
  // POS — child supervision (S2-13)
  'pos:checkin:read',
  'pos:checkin:create',
  'pos:checkin:update',
  'pos:checkin:release',
  'pos:checkin:guardian_manage',
  // POS — wallets (S2-14a)
  'pos:wallet:read',
  'pos:wallet:grant',
  'pos:wallet:spend',
  'pos:wallet:adjust',
  /** Manager gate: bringing expired credit back needs a typed reason. */
  'pos:wallet:reactivate',
  // POS — stock (S2-14b)
  'pos:stock:read',
  'pos:stock:adjust',
  'pos:stock:transfer',
  'pos:stock:count',
  /** Purchase orders: raise and receive. */
  'pos:stock:order',
  /** Manager gate on a stock-take variance above the branch's tolerance. */
  'pos:stock:approve',
  // Branch catalog
  'catalog:package:read',
  'catalog:package:create',
  'catalog:package:update',
  'catalog:holiday:read',
  'catalog:holiday:manage',
  'catalog:tax:read',
  'catalog:tax:manage',
  // Analytics — the rollups Radar and Today read (S2-18)
  'analytics:read',
  // Which of the suite's apps a person may open (S2-02). Access is separate
  // from what they may do once inside: a nanny with POS permissions still has
  // no business on the console.
  'app:pos:access',
  'app:console:access',
  'app:oto_app:access',
  'app:radar:access',
  'app:booth:access',
  'app:inbox:access',
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
 * What the till reads without being allowed to change it. Every counter role
 * holds these, so the read-only bundle is the floor the others build on.
 */
const READ_COUNTER: Permission[] = [
  'admin:branch:read',
  'admin:station:read',
  'pos:member:read',
  'pos:child:read',
  'pos:visit:read',
  'pos:sale:read',
  'pos:payment:read',
  'pos:refund:read',
  'pos:print:read',
  'pos:checkin:read',
  'pos:wallet:read',
  'pos:stock:read',
  ...READ_CATALOG,
];

/** The counter's day: everything reception does without calling a manager. */
const SELL: Permission[] = [
  'pos:sale:create',
  'pos:sale:update',
  'pos:sale:discount',
  'pos:sale:void',
  'pos:payment:capture',
  'pos:payment:confirm',
  'pos:payment:void',
  'pos:refund:create',
  'pos:voucher:redeem',
  'pos:print:receipt',
  'pos:print:band',
  'pos:print:voucher',
  'pos:print:reprint',
];

/**
 * Seed role bundles (CLAUDE.md §4). platform_admin additionally bypasses
 * operator scoping (cross-tenant) — that flag lives on the role row, not here.
 *
 * The bundles nest: staff ⊆ reception ⊆ branch_manager ⊆ operator_admin. The
 * dominance rule (S2-01a) only lets an account grant a role whose every
 * permission it already holds, so a manager who could not grant `reception`
 * could not staff their own branch.
 */
export const ROLE_BUNDLES: Record<SystemRole, Permission[]> = {
  platform_admin: ALL,
  operator_admin: ALL,
  branch_manager: [
    ...READ_COUNTER,
    ...SELL,
    'admin:account:create',
    'admin:account:read',
    'admin:account:update',
    'admin:role:read',
    'admin:role:assign',
    'admin:audit:read',
    'admin:station:create',
    'admin:station:update',
    'admin:box:command',
    'admin:box:read',
    'admin:device:create',
    'admin:device:read',
    'admin:device:update',
    'admin:device:pair',
    'admin:device:revoke',
    'admin:booth:read',
    'admin:booth:staff_assign',
    'admin:health:read',
    'pos:member:create',
    'pos:member:update',
    'pos:member:tier_downgrade',
    'pos:child:create',
    'pos:child:update',
    'pos:visit:create',
    'pos:visit:update',
    'pos:payment:settle',
    'pos:refund:approve',
    'pos:cash:session_open',
    'pos:cash:session_close',
    'pos:cash:movement',
    'pos:cash:approve',
    'pos:cash:day_close',
    'pos:checkin:create',
    'pos:checkin:update',
    'pos:checkin:release',
    'pos:checkin:guardian_manage',
    'pos:wallet:grant',
    'pos:wallet:spend',
    'pos:wallet:adjust',
    'pos:wallet:reactivate',
    'pos:stock:adjust',
    'pos:stock:transfer',
    'pos:stock:count',
    'pos:stock:order',
    'pos:stock:approve',
    'catalog:package:create',
    'catalog:package:update',
    'catalog:holiday:manage',
    'catalog:tax:manage',
    'analytics:read',
    'app:pos:access',
    'app:console:access',
    'app:booth:access',
  ],
  reception: [
    ...READ_COUNTER,
    ...SELL,
    'pos:member:create',
    'pos:member:update',
    'pos:child:create',
    'pos:child:update',
    'pos:visit:create',
    'pos:visit:update',
    'pos:cash:session_open',
    'pos:cash:session_close',
    'pos:cash:movement',
    'pos:checkin:create',
    'pos:checkin:update',
    'pos:checkin:release',
    'pos:checkin:guardian_manage',
    'pos:wallet:grant',
    'pos:wallet:spend',
    'pos:stock:count',
    'app:pos:access',
    'app:booth:access',
  ],
  staff: [...READ_COUNTER, 'app:pos:access', 'app:booth:access'],
};
