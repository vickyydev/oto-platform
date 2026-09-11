import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, timestamps } from './helpers';

// --- Tenancy ---------------------------------------------------------------
// Row-scoped multi-tenancy (CLAUDE.md §3): "operator" here is the TENANT
// (e.g. the OTO company) — NOT the prototype's logged-in staff member, which
// maps to `account`. See ARCHITECTURE.md §7.

export const operator = pgTable('operator', {
  id: idPk(),
  name: text('name').notNull(),
  ...timestamps,
  ...archivedAt,
});

export const branch = pgTable(
  'branch',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    name: text('name').notNull(),
    /** Stable slug, e.g. "hkt-central" (the prototype's branch id). */
    code: text('code').notNull(),
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    address: text('address'),
    country: text('country'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('branch_operator_idx').on(t.operatorId),
    uniqueIndex('branch_code_unique').on(t.operatorId, t.code),
  ],
);

export const department = pgTable(
  'department',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    /** Null = operator-wide department. */
    branchId: uuid('branch_id').references(() => branch.id),
    name: text('name').notNull(),
    ...timestamps,
  },
  (t) => [index('department_operator_idx').on(t.operatorId), index('department_branch_idx').on(t.branchId)],
);

export const employee = pgTable(
  'employee',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    name: text('name').notNull(),
    nickname: text('nickname'),
    /** E.164. */
    phone: text('phone'),
    email: text('email'),
    departmentId: uuid('department_id').references(() => department.id),
    branchId: uuid('branch_id').references(() => branch.id),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('employee_operator_idx').on(t.operatorId),
    index('employee_department_idx').on(t.departmentId),
    index('employee_branch_idx').on(t.branchId),
    index('employee_phone_idx').on(t.phone),
  ],
);

export const accountStatus = pgEnum('account_status', ['invited', 'active', 'inactive']);

export const account = pgTable(
  'account',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    employeeId: uuid('employee_id').references(() => employee.id),
    /** E.164; unique per operator (business key + duplicate safeguard). */
    phone: text('phone').notNull(),
    passwordHash: text('password_hash'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true, mode: 'date' }),
    status: accountStatus('status').notNull().default('invited'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('account_phone_unique').on(t.operatorId, t.phone),
    index('account_operator_idx').on(t.operatorId),
    index('account_employee_idx').on(t.employeeId),
  ],
);

export const role = pgTable(
  'role',
  {
    id: idPk(),
    /** Null = system role (seeded bundles, shared by every operator). */
    operatorId: uuid('operator_id').references(() => operator.id),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (t) => [index('role_operator_idx').on(t.operatorId), uniqueIndex('role_name_unique').on(t.name)],
);

export const rolePermission = pgTable(
  'role_permission',
  {
    id: idPk(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [
    index('role_permission_role_idx').on(t.roleId),
    uniqueIndex('role_permission_unique').on(t.roleId, t.permission),
  ],
);

export const scopeType = pgEnum('scope_type', ['operator', 'branch', 'department', 'record']);

export const roleAssignment = pgTable(
  'role_assignment',
  {
    id: idPk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id),
    scopeType: scopeType('scope_type').notNull(),
    /**
     * Target of the scope: branch/department/record id, or the operator id.
     * Null with scope_type 'operator' = platform-wide (platform_admin only).
     */
    scopeId: uuid('scope_id'),
    ...timestamps,
  },
  (t) => [
    index('role_assignment_account_idx').on(t.accountId),
    index('role_assignment_role_idx').on(t.roleId),
    uniqueIndex('role_assignment_unique').on(t.accountId, t.roleId, t.scopeType, t.scopeId),
  ],
);

export const session = pgTable(
  'session',
  {
    id: idPk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque cookie token — the raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Active branch for this session (POS pickers scope to it). */
    branchId: uuid('branch_id').references(() => branch.id),
    stationId: uuid('station_id'),
    /**
     * Short-lived membership lookup handed from the customer display to the
     * till through the API (CLAUDE.md §7.4) — consumed by the till, never
     * shared browser state.
     */
    pendingLookupPhone: text('pending_lookup_phone'),
    pendingLookupAt: timestamp('pending_lookup_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_token_unique').on(t.tokenHash),
    index('session_account_idx').on(t.accountId),
    index('session_expires_idx').on(t.expiresAt),
  ],
);

export const verificationPurpose = pgEnum('verification_purpose', ['setup', 'password_reset']);

export const verificationCode = pgTable(
  'verification_code',
  {
    id: idPk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    purpose: verificationPurpose('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('verification_code_account_idx').on(t.accountId)],
);
