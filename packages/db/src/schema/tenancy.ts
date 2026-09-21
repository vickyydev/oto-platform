import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, core, idPk, timestamps } from './helpers';

// --- Tenancy (schema `core`) -----------------------------------------------
// Row-scoped multi-tenancy (CLAUDE.md §3): "operator" here is the TENANT
// (e.g. the OTO company) — NOT the prototype's logged-in staff member, which
// maps to `account`. See ARCHITECTURE.md §7.

export const operator = core.table('operator', {
  id: idPk(),
  name: text('name').notNull(),
  ...timestamps,
  ...archivedAt,
});

export const branch = core.table(
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
    /**
     * When the park is open, per weekday, as
     * `{ mon: { open: "10:00", close: "20:00" }, … }` in the branch's own
     * timezone; a day may be absent or null for a closing day (S2-04).
     *
     * Null — the whole column — means nobody has said yet, and that is treated
     * as "unknown", never as "closed": the watchdog rule that raises when a box
     * goes silent DURING opening hours does not fire at all, and the branch
     * tile says "opening hours not set". Guessing here would mean either
     * paging somebody at two in the morning or staying quiet through a busy
     * Saturday.
     */
    openingHours: jsonb('opening_hours'),
    /**
     * When one trading day becomes the next, in the branch's timezone. Not
     * midnight: the park closes at 20:00 but a late party, the cash count and
     * the end-of-day print land after it, and every one of those belongs to the
     * day that is finishing rather than to the one starting. 05:00 puts the
     * boundary in the only hour nothing happens in.
     */
    businessDayStart: time('business_day_start').notNull().default('05:00'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('branch_operator_idx').on(t.operatorId),
    uniqueIndex('branch_code_unique').on(t.operatorId, t.code),
  ],
);

export const department = core.table(
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

export const employee = core.table(
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

/**
 * Enumerations are text + CHECK rather than pg enums (S2-01b). Adding a value
 * to a pg enum takes a DDL lock and cannot be done inside a transaction that
 * also uses it; a CHECK is replaced in one statement. The set is still
 * enforced by the database, which is the point of having it there at all.
 */
export const ACCOUNT_STATUSES = ['invited', 'active', 'inactive'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const account = core.table(
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
    status: text('status').$type<AccountStatus>().notNull().default('invited'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('account_phone_unique').on(t.operatorId, t.phone),
    index('account_operator_idx').on(t.operatorId),
    index('account_employee_idx').on(t.employeeId),
    check('account_status_check', sql`${t.status} in ('invited','active','inactive')`),
  ],
);

export const role = core.table(
  'role',
  {
    id: idPk(),
    /** Null = system role (seeded bundles, shared by every operator). */
    operatorId: uuid('operator_id').references(() => operator.id),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * A seeded bundle the platform owns. System roles are re-synced by
     * `platform:sync` and an operator may not edit or delete one; an
     * operator's own role with the same name is a different row, which is
     * why the uniqueness below is per operator rather than global (S2-01b).
     */
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('role_operator_idx').on(t.operatorId),
    uniqueIndex('role_name_unique').on(t.operatorId, t.name),
    /**
     * An operator's roles are unique within that operator — but `operator_id`
     * is null on a system role, and Postgres treats nulls as distinct, so the
     * index above would happily allow two system roles called `reception`.
     * This partial index closes that (S2-01b).
     */
    uniqueIndex('role_system_name_unique')
      .on(t.name)
      .where(sql`${t.operatorId} is null`),
  ],
);

export const rolePermission = core.table(
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

export const SCOPE_TYPES = ['operator', 'branch', 'department', 'record'] as const;
export type ScopeTypeValue = (typeof SCOPE_TYPES)[number];

export const roleAssignment = core.table(
  'role_assignment',
  {
    id: idPk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id),
    scopeType: text('scope_type').$type<ScopeTypeValue>().notNull(),
    /**
     * Target of the scope: branch/department/record id, or the operator id.
     * Null with scope_type 'operator' = platform-wide (platform_admin only).
     */
    scopeId: uuid('scope_id'),
    ...timestamps,
    /** Withdrawn rather than deleted, so "who held what, when" survives. */
    ...archivedAt,
  },
  (t) => [
    index('role_assignment_account_idx').on(t.accountId),
    index('role_assignment_role_idx').on(t.roleId),
    uniqueIndex('role_assignment_unique').on(t.accountId, t.roleId, t.scopeType, t.scopeId),
    check(
      'role_assignment_scope_check',
      sql`${t.scopeType} in ('operator','branch','department','record')`,
    ),
  ],
);

export const SESSION_CLASSES = ['staff', 'display', 'box', 'kiosk'] as const;
export type SessionClass = (typeof SESSION_CLASSES)[number];

export const session = core.table(
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
    /**
     * The station this session is working at, set when the person picks one
     * after signing in (S2-04) and stamped onto their audit rows and log lines
     * from then on.
     *
     * Deliberately without a foreign key. `station` is declared in `fleet.ts`,
     * which already imports `operator`, `branch` and `account` from this file,
     * and pointing back at it would make the two modules circular for a
     * constraint that is the weaker half of the check anyway: the pick route
     * has to verify that the station is live, at this session's branch, and
     * visible to this account under its access scope — none of which
     * referential integrity can express, and all of which it must do first.
     */
    stationId: uuid('station_id'),
    /**
     * Short-lived membership lookup handed from the customer display to the
     * till through the API (CLAUDE.md §7.4) — consumed by the till, never
     * shared browser state. Retired by the station session document (S2-05).
     */
    pendingLookupPhone: text('pending_lookup_phone'),
    pendingLookupAt: timestamp('pending_lookup_at', { withTimezone: true, mode: 'date' }),
    /**
     * What holds this session (S2-01a). 'staff' is a person signed in at a
     * till or on the console; the other classes cover a paired display, a box
     * and a kiosk, each fenced by its own credential.
     */
    sessionClass: text('class').$type<SessionClass>().notNull().default('staff'),
    /**
     * Set while the POS is locked on inactivity. A locked session still
     * exists — unlocking re-verifies the password against it — which is what
     * makes an offline unlock possible on a box later (S2-06). Sprint 1
     * deleted the session on inactivity, so unlocking needed the network.
     */
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    /**
     * Set by an explicit sign-out or a force sign-out. Kept (rather than the
     * row deleted) so "who ended this session, and when" survives for audit;
     * a revoked session is refused like an expired one.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_token_unique').on(t.tokenHash),
    index('session_account_idx').on(t.accountId),
    index('session_expires_idx').on(t.expiresAt),
    index('session_account_live_idx').on(t.accountId, t.revokedAt),
    check('session_class_check', sql`${t.sessionClass} in ('staff','display','box','kiosk')`),
  ],
);

/**
 * The suite's apps, as a hand-off can name them (S2-02). Each one has a
 * matching `app:<name>:access` permission in `@oto/shared`, and the two lists
 * are tied together at compile time in `services/handoff.ts`.
 */
export const HANDOFF_AUDIENCES = ['pos', 'console', 'oto_app', 'radar', 'booth', 'inbox'] as const;
export type HandoffAudience = (typeof HANDOFF_AUDIENCES)[number];

/**
 * One platform session, several app origins (S2-02).
 *
 * A cookie cannot be shared across `*.onrender.com` — it is on the public
 * suffix list — and would not reach the booking site's own domain anyway. So
 * the launcher asks for a short-lived signed token aimed at ONE app, the
 * browser carries it there in the URL fragment, and the app posts it back for
 * a cookie of its own bound to the same session row.
 *
 * This table is the token's `jti` store, and it exists for one reason: a
 * signature proves a token was minted by us, not that it has never been used.
 * The row is claimed in a single `update … where jti = $1 and consumed_at is
 * null`, so two tabs racing the same fragment cannot both win — the same
 * lesson as the idempotency claim.
 *
 * The token itself is NEVER stored: only its jti, which is useless without
 * the signature.
 */
export const handoffToken = core.table(
  'handoff_token',
  {
    /** The token's `jti` claim. UUIDv7, minted with the token. */
    jti: uuid('jti').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    /** Denormalised from the session so a rejection can be attributed without a join. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    audience: text('audience').$type<HandoffAudience>().notNull(),
    /**
     * The origin this token was minted for, resolved from configuration at
     * issue time. The exchange compares the request's `Origin` with THIS,
     * not with whatever the environment says a minute later: a token means
     * what it meant when it was signed.
     */
    audienceOrigin: text('audience_origin').notNull(),
    /** Which signing key sealed the row below, so a key can be rotated. */
    keyId: text('key_id').notNull(),
    /**
     * The session's own opaque cookie token, sealed (AES-256-GCM under a key
     * derived from the signing secret, with the jti as associated data) so
     * that the exchange can hand the app a cookie bound to the SAME session
     * row — which is what makes one sign-out end every app at once.
     *
     * The database alone cannot open it, it lives at most one token lifetime,
     * and it is wiped the moment the token is consumed. Sessions are still
     * stored as a hash and nothing here changes that.
     */
    sessionSecret: text('session_secret'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('handoff_token_session_idx').on(t.sessionId),
    index('handoff_token_account_idx').on(t.accountId),
    /** The housekeeping sweep, and the expiry guard on the claim itself. */
    index('handoff_token_expires_idx').on(t.expiresAt),
    check(
      'handoff_token_audience_check',
      sql`${t.audience} in ('pos','console','oto_app','radar','booth','inbox')`,
    ),
  ],
);

/**
 * Which person in a lifted app is which account here (S2-17a).
 *
 * The apps taken into the suite keep their own user tables — `otoapp.users`
 * is the first — and a hand-off arriving at one of them has to be answered in
 * that app's own vocabulary. This row is the answer: one platform account,
 * one app, and the id that app knows the person by. The app's sign-on
 * middleware resolves the incoming token to an account and then to this row;
 * the provisioning route writes it.
 *
 * Both directions are unique. An account has at most one identity in an app,
 * and an app's user belongs to at most one account — without the second
 * constraint two accounts could claim the same `otoapp.users` row and the
 * sign-on would hand the app's session to whichever one it happened to read
 * first.
 *
 * There is no `operator_id` here for the same reason `role_assignment` has
 * none: the row hangs off the account, and the account carries the operator.
 * One owner of that fact is enough.
 */
export const appIdentity = core.table(
  'app_identity',
  {
    id: idPk(),
    /**
     * The same list as the hand-off audiences, so an identity cannot name an
     * app no token can be aimed at.
     */
    app: text('app').$type<HandoffAudience>().notNull(),
    /**
     * RESTRICT rather than CASCADE: an account is archived, never deleted, so
     * a delete reaching this table is a mistake — and cascading would quietly
     * take with it the record of who was provisioned into the app.
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /** The id the app knows the person by — `otoapp.users.id` for `oto_app`. */
    externalUserId: text('external_user_id').notNull(),
    /**
     * The administrator who made the link. Not nullable: access to another
     * system is always granted by someone, and that someone is who an audit
     * asks about. RESTRICT for the same reason as above.
     */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_identity_account_unique').on(t.app, t.accountId),
    uniqueIndex('app_identity_external_unique').on(t.app, t.externalUserId),
    /**
     * The unique indexes above lead with `app`, so neither serves "what has
     * this account been linked to?" — which is the question the account page
     * asks on every open.
     */
    index('app_identity_account_idx').on(t.accountId),
    index('app_identity_created_by_idx').on(t.createdBy),
    check(
      'app_identity_app_check',
      sql`${t.app} in ('pos','console','oto_app','radar','booth','inbox')`,
    ),
  ],
);

export const VERIFICATION_PURPOSES = ['setup', 'password_reset'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

export const verificationCode = core.table(
  'verification_code',
  {
    id: idPk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    purpose: text('purpose').$type<VerificationPurpose>().notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('verification_code_account_idx').on(t.accountId),
    check('verification_code_purpose_check', sql`${t.purpose} in ('setup','password_reset')`),
  ],
);
