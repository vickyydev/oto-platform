import { boolean, pgSchema, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * The OTO App's own tables — as much of them as the platform reads and writes
 * (S2-17a, widened for the branch seam in SCRUM-268).
 *
 * The app is a lift, not a port: it keeps its 184 tables, its own migrations
 * and its own npm project outside this pnpm workspace, and
 * `apps/oto-app/shared/schema.ts` stays the definition of these tables. What is
 * here is a narrow re-declaration of the columns the provisioning service
 * reads and writes, because that file cannot be imported from here — pnpm
 * would have to hoist the app's dependency tree against ours for it to
 * resolve, which is the reason the app is excluded from the workspace in the
 * first place.
 *
 * Deliberately NOT exported from `./index` — the file `drizzle.config.ts`
 * points at. `otoapp` is outside `schemaFilter` and the app's own migrator
 * owns every table in it, so a Drizzle diff must never meet this declaration
 * and offer to create, alter or drop what it describes. Keeping it out of the
 * schema graph makes that impossible rather than merely configured.
 *
 * Adding a column here changes nothing in the database. It has to exist in
 * `apps/oto-app/shared/schema.ts` and in one of that app's migrations first.
 */
export const otoapp = pgSchema('otoapp');

/**
 * The app's own role vocabulary, copied from `userRoles` in
 * `apps/oto-app/shared/schema.ts`.
 *
 * Not a translation of platform roles: the two answer different questions — a
 * platform role says what someone may do at the till and in the console, this
 * says what they are inside the OTO App — and inventing a mapping between
 * them would silently decide something nobody has decided. Whoever provisions
 * the person picks from this list.
 *
 * `advisor` is in the list because the column accepts it, but the app resolves
 * an advisor's effective role from `access_policies` at runtime
 * (`getUserWithBranchAccess`), so one provisioned from here with no policy
 * behind it gets nothing.
 */
export const OTO_APP_USER_ROLES = [
  'global_admin',
  'operator_admin',
  'admin',
  'manager',
  'staff',
  'advisor',
] as const;
export type OtoAppUserRole = (typeof OTO_APP_USER_ROLES)[number];

export const otoappUsers = otoapp.table('users', {
  /** `varchar` with a `gen_random_uuid()` default there; minted here instead. */
  id: varchar('id').primaryKey(),
  username: text('username'),
  /** NOT NULL and unique. The app looks users up by a lower-cased email. */
  email: text('email').notNull(),
  /** NOT NULL, and nothing the platform can fill honestly — see `oto-app-users.ts`. */
  password: text('password').notNull(),
  fullName: text('full_name').notNull(),
  role: text('role', { enum: OTO_APP_USER_ROLES }).notNull(),
  /** `otoapp.operators.id` — the app's own operator table, not `core.operator`. */
  operatorId: uuid('operator_id'),
  isActive: boolean('is_active').notNull(),
  mustChangePassword: boolean('must_change_password').notNull(),
  /** One of the app's own user ids, so the platform leaves it null. */
  createdBy: varchar('created_by'),
  phoneNumber: text('phone_number'),
  /** Unique there, so two users cannot carry the same number. */
  phoneE164: text('phone_e164'),
  /**
   * The platform account this user is the same person as. Unique and
   * nullable: it is what `platformSignOn.ts` resolves the signed-in person by,
   * and every user that predates the platform has none.
   */
  platformUserId: uuid('platform_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * The app's own branch list — the columns needed to seat a provisioned person
 * in one of them (SCRUM-268).
 *
 * It is a different list from `core.branch` with different ids, and the two
 * are not kept in step by anything: renaming a park on the platform does not
 * rename it here. `coreBranchId` is the column that was meant to join them and
 * until SCRUM-268 nothing wrote or read it.
 */
export const otoappBranches = otoapp.table('branches', {
  /** `varchar` here against a platform `uuid`; the app mints its own. */
  id: varchar('id').primaryKey(),
  /** NOT NULL there. Copied onto a branch access row, which also requires it. */
  tenantId: uuid('tenant_id').notNull(),
  /** `otoapp.operators.id` — the app's own operator table, not `core.operator`. */
  operatorId: uuid('operator_id'),
  name: text('name').notNull(),
  /**
   * `core.branch.id`, as text. Declared `text` in the app's schema, so a
   * comparison against a platform uuid is written as text on both sides.
   */
  coreBranchId: text('core_branch_id'),
  coreSyncStatus: text('core_sync_status', {
    enum: ['PENDING', 'SUCCESS', 'FAILED'],
  }),
  coreSyncedAt: timestamp('core_synced_at'),
  coreSyncError: text('core_sync_error'),
});

/**
 * Which branches a user of the app may see.
 *
 * `accessScope` `all_branches` carries a null `branchId` and means every
 * branch; `selected_branches` names one branch per row, and a user with no row
 * at all sees nothing — which is what everybody provisioned from the platform
 * was until SCRUM-268. The app reads these rows in `getUserWithBranchAccess`
 * and takes the session's tenant from the first of them.
 */
export const otoappUserBranchAccess = otoapp.table('user_branch_access', {
  id: varchar('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: varchar('user_id').notNull(),
  /** Null when the scope is `all_branches`. */
  branchId: varchar('branch_id'),
  accessScope: text('access_scope', { enum: ['all_branches', 'selected_branches'] }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
