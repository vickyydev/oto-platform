import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { newId, normalizePhone } from '@oto/shared';
import type { Db } from './index';
import {
  account,
  appIdentity,
  auditLog,
  employee,
  role,
  roleAssignment,
  rolePermission,
} from './schema/index';
import {
  mappedAppBranches,
  otoAppBranchesInstalled,
  otoappBranches,
  otoappEmployees,
  otoappUserBranchAccess,
  otoappUsers,
  OTO_APP_USER_ROLES,
  type OtoAppExec,
  type OtoAppUserRole,
} from './schema/otoapp';

/**
 * SCRUM-795 — A PLATFORM ACCOUNT FOR EVERY OTO APP USER WHO HAS NONE.
 *
 * After the production restore the OTO App holds its staff, managers and
 * administrators as users of its own, and not one of them has a platform
 * account or an identity link, so none of them can open the HR app from the
 * suite launcher. This makes the account, the link and the grants for each of
 * them, with NO platform password: the first sign-in on the launcher takes the
 * person's existing app password (`signIn` in `apps/api/src/services/auth.ts`
 * checks it against the app's own hash once and keeps an argon2 hash of it).
 *
 * What one person gets, in one transaction:
 *   - `core.account` in the operator: their phone, `active`, no password hash,
 *     the forced change and the phone's verification as `FORCED CHANGE` and
 *     `PHONE VERIFIED` below decide them;
 *   - the account's employee record: the copy of their app employee
 *     (`core.employee`, source `otoapp`) when the app links exactly one
 *     employee to the user — see `EMPLOYEE LINK` below;
 *   - the identity link (`core.app_identity`, app `oto_app`) and the stamp on
 *     their app user (`platform_user_id` — and, unlike `linkOtoAppUser`, the
 *     app's own forced change left as the app has it: `FORCED CHANGE` below);
 *   - the OTO App tile: the operator's `app_access_oto_app` role at operator
 *     scope — the Console's link with no branch choice, and SCRUM-539's
 *     provisioning, grant exactly this;
 *   - a platform role where `OTO_APP_ROLE_TO_PLATFORM` below gives one.
 *
 * FORCED CHANGE. The app sets `must_change_password` on every user it creates
 * and at every administrator reset, and shows that temporary password to the
 * administrator (`apps/oto-app/server/routes.ts`, the user create and reset
 * routes, `storage.resetUserPassword`). The first launcher sign-in adopts
 * whatever password the user holds, so a user still on such a password would
 * keep, as their suite password, one an administrator chose or saw. The flag
 * is therefore carried: `core.account.must_change_password` is the app user's
 * own, read under the row lock, so the adopting sign-in answers
 * `mustChangePassword: true` and `requireAuth` holds every business route
 * (the OTO App hand-off included) until `/auth/change-password`, which takes
 * the adopted hash as the current password — SCRUM-539 sets the same flag on
 * the temporary password it issues (`otoapp-provision.ts`). The app's own flag
 * is NOT switched off here, as `linkOtoAppUser` switches it: a launcher session
 * never sees it (the app's `/api/user` answers false for a platform session),
 * and the app's own password is still the temporary one, which its legacy
 * form (`OTOAPP_LEGACY_LOGIN`, kept for the cutover rehearsal) must not take
 * without the change. Counted as `appForcedChange` in the report. OWNER
 * QUESTION, in PLAN.md: both halves of this rule.
 *
 * PHONE VERIFIED. `/auth/password-reset/request` sends a reset code to any
 * active account whose phone is verified, so a verified phone is a way into
 * the account that does not need the app password. SCRUM-539 marks the phone
 * verified because an administrator typed the number for the person in front
 * of them; restored data carries no such moment. So `phone_verified_at` is set
 * only where the app itself says the number is proven: the phone was taken
 * from the user's own `phone_e164` AND the app's `phone_verified` is true —
 * the condition the app's own SMS sign-in and reset look a user up by
 * (`twilio-service.ts`). Every other account starts unverified: it signs in
 * with the app password as before, and SMS reset is refused until a
 * verification (an administrator's temporary password marks the phone, as for
 * any account). Counted as `phoneVerification` in the report. OWNER QUESTION,
 * in PLAN.md, not a decided fact.
 *
 * WHY THESE ROWS ARE WRITTEN HERE AND NOT BY THE API'S SERVICES. `linkOtoAppUser`,
 * `ensureAppAccessRole`, `grantAppAccess` and `audit.record` live in
 * `apps/api/src/services`, and this package cannot import from the api — the
 * dependency only points the other way (the same reason the branch seam lives
 * in `schema/otoapp.ts`). So this writes the same rows those services write,
 * column for column: the stamp of `linkOtoAppUser` (all but its switching off
 * of the app's forced change, FORCED CHANGE above), the role and grant of
 * `ensureAppAccessRole` + `grantAppAccess(…, null)`, and audit rows of the
 * shape `audit.record` inserts. `test/s795-staff-accounts.test.ts` in the api
 * holds the result to the api's own readers (the tile's permission, the grant
 * read back as operator-wide, the identity the role context resolves), so a
 * drift on either side fails a test rather than a person at the launcher.
 * What it does not do is call `reconcileOtoAppRole`: `roleFor` reads the
 * grants below back as the app role each person already holds, so for every
 * mapped role but `operator_admin` the reconciliation would write nothing —
 * see the note on that row.
 *
 * WHO IS TAKEN, AND WHO IS COUNTED AND LEFT. Every `otoapp.users` row that is
 * active and has no platform link, in a park group anchored to this operator.
 * The outcomes are `STAFF_ACCOUNT_OUTCOMES`; each person gets exactly one, and
 * the report carries counts and ids — never a name or a phone number.
 *
 * Re-runnable: a provisioned user is stamped, so a second run counts them as
 * `already_linked` and has nothing to do.
 */

/** The `request_id` on every audit row this writes, so the run is findable. */
export const STAFF_ACCOUNTS_REQUEST_ID = 'script:otoapp-staff-accounts';

/**
 * The platform's system roles a mapped OTO App role may land on. `staff` is
 * kept in the vocabulary, though no row below uses it today, so that the
 * owner's answer to the staff question is a one-line change of the table.
 */
export type PlatformStaffRole = 'staff' | 'branch_manager' | 'operator_admin';

export type PlatformRoleMapping =
  /** The OTO App tile alone: no platform role. */
  | { role: null }
  | {
      role: PlatformStaffRole;
      /**
       * `app_branches`: one assignment at each platform branch the user may
       * access in the app (`user_branch_access` joined to
       * `branches.core_branch_id`). `operator`: one assignment at operator scope.
       */
      scope: 'app_branches' | 'operator';
    };

/**
 * THE ROLE MAPPING — one table, reviewed as one, and an OWNER QUESTION in
 * PLAN.md as a whole: it decides what each restored person may do in the
 * suite beyond opening the OTO App.
 *
 * What the OTO App needs is `roleFor(grants)` in
 * `apps/api/src/services/oto-app-users.ts`, which reads platform grants back
 * into an app role where the app's operator has platform roles switched on:
 * `operator_admin` at operator scope is `admin`, `branch_manager` anywhere is
 * `manager`, anything else — no grant at all included — is `staff`; an
 * advisor is left as an advisor. The tile alone opens the app and seats a
 * sign-in (it is operator-wide). So the table grants a platform role only
 * where `roleFor` needs one to read the person's app role back, and nothing
 * more — which is also all the Console's Link gives (the tile):
 *
 *   staff           → the tile alone. `roleFor` reads no grant as `staff`. The
 *                     platform `staff` bundle would add the till, the booth,
 *                     the counter's reads, benefits and the assistant to people
 *                     who have none of it today — left to the owner.
 *   advisor         → the tile alone. `reconcileOtoAppRole` never rewrites an
 *                     advisor, whose reach inside the app comes from their
 *                     access policy.
 *   manager         → branch_manager at each of their app branches. What
 *                     `roleFor` needs for `manager`; the bundle also carries
 *                     account administration at those parks (temporary
 *                     passwords included), role assignment, refund and cash
 *                     approval and device pairing. A manager whose app branches
 *                     join no park gets no assignment, and `roleFor` would then
 *                     read them as `staff`.
 *   admin           → operator_admin, operator-wide. What `roleFor` needs for
 *                     `admin`; it is every permission across the operator,
 *                     where the app admin's reach is one park group.
 *   operator_admin  → operator_admin, operator-wide. `roleFor` reads that grant
 *                     back as `admin`, so where the app's operator has platform
 *                     roles switched on, the next hand-off rewrites this user's
 *                     app role from `operator_admin` to `admin`, which drops
 *                     the app's owner-only `payroll.lock` — a question, not
 *                     decided here.
 *   global_admin    → nothing: skipped, and listed by id for a hand link in
 *                     the Console. Nobody's estate-wide app role is minted by a
 *                     script.
 *
 * A role word outside the app's six (the column is plain text there) is
 * `unknown_role` and skipped.
 */
export const OTO_APP_ROLE_TO_PLATFORM: Readonly<Record<OtoAppUserRole, PlatformRoleMapping | null>> = {
  staff: { role: null },
  advisor: { role: null },
  manager: { role: 'branch_manager', scope: 'app_branches' },
  admin: { role: 'operator_admin', scope: 'operator' },
  operator_admin: { role: 'operator_admin', scope: 'operator' },
  global_admin: null,
};

/** The system roles some row of the table lands on: what `--apply` needs to exist. */
const MAPPED_SYSTEM_ROLES: readonly PlatformStaffRole[] = [
  ...new Set(Object.values(OTO_APP_ROLE_TO_PLATFORM).flatMap((m) => (m?.role ? [m.role] : []))),
].sort();

/**
 * One outcome per app user, in the order they are decided.
 *
 *   provision         gets an account (a dry run: would get one)
 *   inactive          switched off in the app — not a candidate
 *   already_linked    `platform_user_id` set, or an `oto_app` identity names them
 *   global_admin      skipped by the mapping; listed by id
 *   unknown_role      a role word outside the app's six
 *   other_park_group  the app places them in a park group not anchored to this
 *                     operator, or cannot place them at all (the Console's Link
 *                     refuses the same people, `otoAppUserIsOperators`)
 *   no_phone          no usable phone on the user or their employee record
 *   phone_taken       a `core.account` already holds the number (any operator:
 *                     sign-in looks a phone up across operators)
 *   phone_shared      two or more candidates resolve to the same number, so none
 *                     of them is given it rather than whichever comes first
 *   employee_held     their employee copy already belongs to another account —
 *                     a second account for one person is not minted here
 *   failed            `--apply` only: the person's transaction rolled back
 */
export const STAFF_ACCOUNT_OUTCOMES = [
  'provision',
  'inactive',
  'already_linked',
  'global_admin',
  'unknown_role',
  'other_park_group',
  'no_phone',
  'phone_taken',
  'phone_shared',
  'employee_held',
  'failed',
] as const;
export type StaffAccountOutcome = (typeof STAFF_ACCOUNT_OUTCOMES)[number];

/** Where the account's phone came from, first that normalises to E.164 wins. */
export const STAFF_ACCOUNT_PHONE_SOURCES = ['user_phone_e164', 'user_phone_number', 'employee'] as const;
export type StaffAccountPhoneSource = (typeof STAFF_ACCOUNT_PHONE_SOURCES)[number];

/** PHONE VERIFIED, as the report counts it. */
export const STAFF_ACCOUNT_PHONE_VERIFICATION = ['verified', 'unverified'] as const;
export type StaffAccountPhoneVerification = (typeof STAFF_ACCOUNT_PHONE_VERIFICATION)[number];

/**
 * PHONE VERIFIED, the rule: the app's own proof of the number, and only for
 * the number it proves — the user's `phone_e164`, which is where the app's
 * SMS check writes. A free-text `phone_number` or an employee record's phone
 * is never counted as verified, whatever the flag says.
 */
function phoneCountsVerified(source: StaffAccountPhoneSource, appPhoneVerified: boolean): boolean {
  return source === 'user_phone_e164' && appPhoneVerified;
}

/**
 * EMPLOYEE LINK — which employee record the account is given.
 *
 * The app's employee is `otoapp.employees` carrying this user in `user_id`,
 * and only when exactly ONE employee carries them: step 1 of the app's own
 * user-to-employee rule as `otoapp_v.employees` applies it (app migration
 * 0005), so the account is linked to the same employee the view will name
 * once the user is stamped, and the nightly copy (`otoapp:employee.sync`)
 * finds them agreeing. The rule's step 2 — a user no employee carries, matched
 * by email — is not applied here: it reads the app's HR record, which the
 * platform reads only through the view, and the view names an account only
 * once the stamp exists. The copy job links those accounts itself on its next
 * run (`linkAccount`, which fills an empty `employee_id`).
 *
 *   linked     the copy exists and is the account's employee record
 *   none       no employee carries the user
 *   ambiguous  two or more employees carry the user; none is guessed
 *   no_copy    the app's employee has no live `core.employee` copy yet
 *   held       the copy belongs to another account (the person is skipped)
 */
export const STAFF_ACCOUNT_EMPLOYEE_LINKS = ['linked', 'none', 'ambiguous', 'no_copy', 'held'] as const;
export type StaffAccountEmployeeLink = (typeof STAFF_ACCOUNT_EMPLOYEE_LINKS)[number];

/** One app user, as the report shows them: ids and categories, never a name or a number. */
export interface StaffAccountPerson {
  userId: string;
  appRole: string;
  outcome: StaffAccountOutcome;
  phoneSource: StaffAccountPhoneSource | null;
  employeeLink: StaffAccountEmployeeLink | null;
  /** The mirror `core.employee.id` linked, when `employeeLink` is `linked`. */
  employeeId: string | null;
  /**
   * The app user's own `must_change_password`, carried to the account
   * (FORCED CHANGE). Null for anybody stopped before the plan reached the
   * account. Re-read under the row lock on apply, so an applied person shows
   * what was written.
   */
  mustChangePassword: boolean | null;
  /** Whether the account's phone is counted as verified (PHONE VERIFIED). Null, and re-read, as above. */
  phoneVerified: boolean | null;
  /** Null for the tile alone, by the table or because nothing to provision. */
  platformRole: PlatformStaffRole | null;
  /** Platform branches the role is assigned at (empty for an operator-wide role). */
  branchIds: string[];
  /** Set once applied. */
  accountId: string | null;
  /** Why a `failed` person's transaction rolled back: a code, never a value. */
  failure: string | null;
}

export interface StaffAccountsReport {
  /** False on a database with no OTO App on it; nothing else is then read. */
  installed: boolean;
  operatorId: string;
  applied: boolean;
  /** Every app user read. */
  read: number;
  outcomes: Record<StaffAccountOutcome, number>;
  /** App role → outcome → count. */
  byAppRole: Record<string, Partial<Record<StaffAccountOutcome, number>>>;
  /** Of those provisioned (or to be). */
  phoneSources: Record<StaffAccountPhoneSource, number>;
  /** Of those provisioned (or to be): the phone counted as verified, or not (PHONE VERIFIED). */
  phoneVerification: Record<StaffAccountPhoneVerification, number>;
  /** Of those provisioned (or to be): the app still owes a password change, carried to the account. */
  appForcedChange: number;
  employeeLinks: Record<StaffAccountEmployeeLink, number>;
  /** Assignments made (or to be made), by platform role. */
  roleAssignments: Record<PlatformStaffRole, number>;
  /** Provisioned people the table gives the OTO App tile alone (staff, advisor). */
  tileOnly: number;
  /** Provisioned people whose mapped role landed nowhere: no app branch joined to a park. The tile only. */
  withoutPlatformRole: number;
  /** The `global_admin` users, by `otoapp.users.id`, for a hand link in the Console. */
  globalAdminUserIds: string[];
  /** Accounts that may be named as the actor: active, this operator, operator_admin or platform_admin. */
  eligibleActorIds: string[];
  people: StaffAccountPerson[];
}

export interface StaffAccountsOptions {
  /** `core.operator.id`. */
  operatorId: string;
  /** Write. Without it nothing is written. */
  apply: boolean;
  /**
   * The administrator's platform account: `core.app_identity.created_by` (not
   * nullable — access to another system is always granted by someone) and the
   * actor of every audit row. Required to apply.
   */
  actorAccountId?: string | null;
}

/** A refusal of the whole run, before anything is written. */
export class StaffAccountsRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A person's transaction stopped on purpose; the code is what the report shows. */
class PersonStopped extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const APP_ACCESS_ROLE = 'app_access_oto_app';
const APP_ACCESS_PERMISSION = 'app:oto_app:access';

async function relationInstalled(exec: OtoAppExec, name: string): Promise<boolean> {
  const res = await exec.execute<{ reg: string | null }>(sql`select to_regclass(${name})::text as reg`);
  return Boolean(res.rows[0]?.reg);
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** First phone that normalises, with where it came from. */
function choosePhone(
  candidates: ReadonlyArray<[StaffAccountPhoneSource, string | null | undefined]>,
): { phone: string; source: StaffAccountPhoneSource } | null {
  for (const [source, raw] of candidates) {
    const phone = raw ? normalizePhone(raw) : null;
    if (phone) return { phone, source };
  }
  return null;
}

/**
 * The accounts that may be named as the actor: active, in this operator, and
 * holding a live assignment of the system `operator_admin` role at this
 * operator's scope, or of `platform_admin` at operator scope. A system role
 * (`is_system`, no operator) and not a name: an operator may mint its own
 * role called anything (SCRUM-318).
 */
async function eligibleActors(exec: OtoAppExec, operatorId: string): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ id: account.id })
    .from(account)
    .innerJoin(roleAssignment, eq(roleAssignment.accountId, account.id))
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(account.operatorId, operatorId),
        eq(account.status, 'active'),
        isNull(roleAssignment.archivedAt),
        eq(role.isSystem, true),
        isNull(role.operatorId),
        eq(roleAssignment.scopeType, 'operator'),
        sql`(
          (${role.name} = 'operator_admin' and ${roleAssignment.scopeId} = ${operatorId})
          or (${role.name} = 'platform_admin' and (${roleAssignment.scopeId} is null or ${roleAssignment.scopeId} = ${operatorId}))
        )`,
      ),
    );
  return rows.map((r) => r.id).sort();
}

/**
 * Plan — and with `apply`, provision — a platform account for every OTO App
 * user who has none. One transaction per person, so one person's failure
 * leaves everybody else's account standing and is reported by code.
 */
export async function provisionOtoAppStaffAccounts(
  db: Db,
  opts: StaffAccountsOptions,
): Promise<StaffAccountsReport> {
  const { operatorId } = opts;
  const report: StaffAccountsReport = {
    installed: false,
    operatorId,
    applied: false,
    read: 0,
    outcomes: zero(STAFF_ACCOUNT_OUTCOMES),
    byAppRole: {},
    phoneSources: zero(STAFF_ACCOUNT_PHONE_SOURCES),
    phoneVerification: zero(STAFF_ACCOUNT_PHONE_VERIFICATION),
    appForcedChange: 0,
    employeeLinks: zero(STAFF_ACCOUNT_EMPLOYEE_LINKS),
    roleAssignments: zero(['staff', 'branch_manager', 'operator_admin'] as const),
    tileOnly: 0,
    withoutPlatformRole: 0,
    globalAdminUserIds: [],
    eligibleActorIds: await eligibleActors(db, operatorId),
    people: [],
  };

  for (const name of ['otoapp.users', 'otoapp.user_branch_access', 'otoapp.tenants', 'otoapp.operators']) {
    if (!(await relationInstalled(db, name))) return report;
  }
  if (!(await otoAppBranchesInstalled(db))) return report;
  report.installed = true;

  // --- What the app says --------------------------------------------------
  const mapped = await mappedAppBranches(db, operatorId);
  const ourTenants = new Set(mapped.map((m) => m.tenantId));
  /** App branch → the platform branch it is joined to (this operator's, live). */
  const coreOf = new Map(mapped.map((m) => [m.id, m.coreBranchId]));
  /** Park group → every platform branch joined to one of its app branches. */
  const coreOfTenant = new Map<string, string[]>();
  for (const m of mapped) coreOfTenant.set(m.tenantId, [...(coreOfTenant.get(m.tenantId) ?? []), m.coreBranchId]);

  const users = await db
    .select({
      id: otoappUsers.id,
      role: otoappUsers.role,
      isActive: otoappUsers.isActive,
      operatorId: otoappUsers.operatorId,
      phoneE164: otoappUsers.phoneE164,
      phoneNumber: otoappUsers.phoneNumber,
      phoneVerified: otoappUsers.phoneVerified,
      mustChangePassword: otoappUsers.mustChangePassword,
      platformUserId: otoappUsers.platformUserId,
    })
    .from(otoappUsers)
    .orderBy(otoappUsers.id);
  report.read = users.length;

  const identified = new Set(
    (
      await db
        .select({ externalUserId: appIdentity.externalUserId })
        .from(appIdentity)
        .where(eq(appIdentity.app, 'oto_app'))
    ).map((r) => r.externalUserId),
  );

  const access = await db
    .select({
      userId: otoappUserBranchAccess.userId,
      tenantId: otoappUserBranchAccess.tenantId,
      branchId: otoappUserBranchAccess.branchId,
      accessScope: otoappUserBranchAccess.accessScope,
    })
    .from(otoappUserBranchAccess);
  const accessOf = new Map<string, typeof access>();
  for (const row of access) accessOf.set(row.userId, [...(accessOf.get(row.userId) ?? []), row]);
  const appBranchTenant = new Map(
    (await db.select({ id: otoappBranches.id, tenantId: otoappBranches.tenantId }).from(otoappBranches)).map(
      (b) => [b.id, b.tenantId],
    ),
  );
  const appOperatorTenant = new Map(
    (
      await db.execute<{ id: string; tenant_id: string }>(
        sql`select id::text as id, tenant_id::text as tenant_id from otoapp.operators`,
      )
    ).rows.map((r) => [r.id, r.tenant_id]),
  );
  const tenants = (await db.execute<{ id: string }>(sql`select id::text as id from otoapp.tenants limit 2`)).rows;
  const onlyTenant = tenants.length === 1 ? tenants[0]!.id : null;

  /**
   * The park group the app places a user in — the app's `managedUserTenant`,
   * as `placeAppUsers` in `apps/api/src/services/oto-app-users.ts` applies it
   * for the Console's unlinked list and Link (a private function there, so
   * the same five conditions are written out again here): every access row in
   * one tenant, each row's branch in that tenant, an operator admin's app
   * operator in it too, and a user with no access row only on a database that
   * holds a single tenant. Null when the app itself cannot place them.
   */
  const tenantOf = (u: (typeof users)[number]): string | null => {
    const rows = accessOf.get(u.id) ?? [];
    if (rows.length === 0) return onlyTenant;
    const tenantId = rows[0]!.tenantId;
    if (!rows.every((r) => r.tenantId === tenantId)) return null;
    for (const r of rows) {
      if (r.branchId && appBranchTenant.get(r.branchId) !== tenantId) return null;
    }
    if (u.role === 'operator_admin' && u.operatorId && appOperatorTenant.get(u.operatorId) !== tenantId) return null;
    return tenantId;
  };

  /** The platform branches a user may access in the app, sorted. */
  const platformBranchesOf = (userId: string): string[] => {
    const out = new Set<string>();
    for (const r of accessOf.get(userId) ?? []) {
      if (r.accessScope === 'all_branches') {
        for (const id of coreOfTenant.get(r.tenantId) ?? []) out.add(id);
      } else if (r.branchId) {
        const core = coreOf.get(r.branchId);
        if (core) out.add(core);
      }
    }
    return [...out].sort();
  };

  // The app's employees carrying each user (EMPLOYEE LINK, step 1 only).
  const userIds = users.map((u) => u.id);
  const carried = new Map<string, string[]>();
  if (userIds.length && (await relationInstalled(db, 'otoapp.employees'))) {
    const rows = await db
      .select({ id: otoappEmployees.id, userId: otoappEmployees.userId })
      .from(otoappEmployees)
      .where(inArray(otoappEmployees.userId, userIds));
    for (const r of rows) carried.set(r.userId!, [...(carried.get(r.userId!) ?? []), r.id]);
  }
  const singleEmployee = [...carried.values()].flatMap((ids) => (ids.length === 1 ? ids : []));
  const copies = new Map(
    (singleEmployee.length
      ? await db
          .select({ id: employee.id, externalId: employee.externalId, phone: employee.phone })
          .from(employee)
          .where(
            and(
              eq(employee.operatorId, operatorId),
              eq(employee.source, 'otoapp'),
              isNull(employee.archivedAt),
              inArray(employee.externalId, singleEmployee),
            ),
          )
      : []
    ).map((e) => [e.externalId!, e]),
  );
  const copyIds = [...copies.values()].map((c) => c.id);
  const heldCopies = new Set(
    (copyIds.length
      ? await db.select({ employeeId: account.employeeId }).from(account).where(inArray(account.employeeId, copyIds))
      : []
    ).map((a) => a.employeeId!),
  );

  // Every phone any account holds, in any operator.
  const takenPhones = new Set((await db.select({ phone: account.phone }).from(account)).map((a) => a.phone));

  // --- One outcome each ---------------------------------------------------
  const phones = new Map<string, string>();
  for (const u of users) {
    const person: StaffAccountPerson = {
      userId: u.id,
      appRole: u.role,
      outcome: 'provision',
      phoneSource: null,
      employeeLink: null,
      employeeId: null,
      mustChangePassword: null,
      phoneVerified: null,
      platformRole: null,
      branchIds: [],
      accountId: null,
      failure: null,
    };
    report.people.push(person);
    const decide = (outcome: StaffAccountOutcome) => {
      person.outcome = outcome;
    };

    if (!u.isActive) {
      decide('inactive');
      continue;
    }
    if (u.platformUserId || identified.has(u.id)) {
      decide('already_linked');
      continue;
    }
    if (!(OTO_APP_USER_ROLES as readonly string[]).includes(u.role)) {
      decide('unknown_role');
      continue;
    }
    const mapping = OTO_APP_ROLE_TO_PLATFORM[u.role as OtoAppUserRole];
    if (!mapping) {
      decide('global_admin');
      report.globalAdminUserIds.push(u.id);
      continue;
    }
    const tenantId = tenantOf(u);
    if (!tenantId || !ourTenants.has(tenantId)) {
      decide('other_park_group');
      continue;
    }

    const employees = carried.get(u.id) ?? [];
    const copy = employees.length === 1 ? copies.get(employees[0]!) : undefined;
    person.employeeLink =
      employees.length === 0
        ? 'none'
        : employees.length > 1
          ? 'ambiguous'
          : !copy
            ? 'no_copy'
            : heldCopies.has(copy.id)
              ? 'held'
              : 'linked';

    const chosen = choosePhone([
      ['user_phone_e164', u.phoneE164],
      ['user_phone_number', u.phoneNumber],
      ['employee', person.employeeLink === 'linked' ? copy?.phone : null],
    ]);
    if (!chosen) {
      decide('no_phone');
      continue;
    }
    person.phoneSource = chosen.source;
    if (takenPhones.has(chosen.phone)) {
      decide('phone_taken');
      continue;
    }
    if (person.employeeLink === 'held') {
      decide('employee_held');
      continue;
    }
    person.employeeId = person.employeeLink === 'linked' ? copy!.id : null;
    person.mustChangePassword = u.mustChangePassword;
    person.phoneVerified = phoneCountsVerified(chosen.source, u.phoneVerified);
    person.platformRole = mapping.role;
    person.branchIds = mapping.role === null || mapping.scope === 'operator' ? [] : platformBranchesOf(u.id);
    phones.set(u.id, chosen.phone);
  }

  // Two candidates on one number: neither is given it.
  const holders = new Map<string, string[]>();
  for (const [userId, phone] of phones) holders.set(phone, [...(holders.get(phone) ?? []), userId]);
  for (const person of report.people) {
    if (person.outcome !== 'provision') continue;
    if ((holders.get(phones.get(person.userId)!) ?? []).length > 1) person.outcome = 'phone_shared';
  }

  // --- Write ---------------------------------------------------------------
  if (opts.apply) {
    const actor = opts.actorAccountId ?? null;
    if (!actor || !report.eligibleActorIds.includes(actor)) {
      throw new StaffAccountsRefused(
        'ACTOR_REQUIRED',
        'Applying needs --actor: the id of an active operator_admin or platform_admin account of this operator',
      );
    }
    const systemRoles = new Map(
      (
        await db
          .select({ id: role.id, name: role.name })
          .from(role)
          .where(and(eq(role.isSystem, true), isNull(role.operatorId), inArray(role.name, [...MAPPED_SYSTEM_ROLES])))
      ).map((r) => [r.name, r.id]),
    );
    for (const name of MAPPED_SYSTEM_ROLES) {
      if (!systemRoles.has(name)) {
        throw new StaffAccountsRefused('SYSTEM_ROLE_MISSING', `The system role ${name} is missing: run platform:sync first`);
      }
    }
    report.applied = true;
    for (const person of report.people) {
      if (person.outcome !== 'provision') continue;
      try {
        person.accountId = await provisionOne(db, {
          operatorId,
          actor,
          person,
          phone: phones.get(person.userId)!,
          platformRoleId: person.platformRole ? systemRoles.get(person.platformRole)! : null,
        });
      } catch (err) {
        person.outcome = 'failed';
        person.failure =
          err instanceof PersonStopped
            ? err.code
            : (err as { code?: string }).code === '23505'
              ? `unique_violation:${(err as { constraint?: string }).constraint ?? 'unknown'}`
              : `error:${(err as { code?: string }).code ?? 'unknown'}`;
      }
    }
  }

  // --- Counts ----------------------------------------------------------------
  for (const person of report.people) {
    report.outcomes[person.outcome] += 1;
    const byRole = (report.byAppRole[person.appRole] ??= {});
    byRole[person.outcome] = (byRole[person.outcome] ?? 0) + 1;
    if (person.outcome !== 'provision') continue;
    report.phoneSources[person.phoneSource!] += 1;
    report.phoneVerification[person.phoneVerified ? 'verified' : 'unverified'] += 1;
    if (person.mustChangePassword) report.appForcedChange += 1;
    report.employeeLinks[person.employeeLink!] += 1;
    if (!person.platformRole) {
      report.tileOnly += 1;
      continue;
    }
    const assignments = person.platformRole === 'operator_admin' ? 1 : person.branchIds.length;
    report.roleAssignments[person.platformRole] += assignments;
    if (assignments === 0) report.withoutPlatformRole += 1;
  }
  return report;
}

/** One person, one transaction. Answers the new account's id. */
async function provisionOne(
  db: Db,
  input: {
    operatorId: string;
    actor: string;
    person: StaffAccountPerson;
    phone: string;
    /** Null for the tile alone. */
    platformRoleId: string | null;
  },
): Promise<string> {
  const { operatorId, actor, person, phone } = input;
  return db.transaction(async (tx) => {
    // The plan was read without locks; everything it rests on is asked again
    // under the app user's row lock, which the Console's Link also has to take
    // (its stamp is an UPDATE of this row).
    const [user] = await tx
      .select({
        isActive: otoappUsers.isActive,
        platformUserId: otoappUsers.platformUserId,
        mustChangePassword: otoappUsers.mustChangePassword,
        phoneE164: otoappUsers.phoneE164,
        phoneVerified: otoappUsers.phoneVerified,
      })
      .from(otoappUsers)
      .where(eq(otoappUsers.id, person.userId))
      .for('update');
    if (!user || !user.isActive || user.platformUserId) throw new PersonStopped('changed_since_plan');
    // FORCED CHANGE and PHONE VERIFIED from the row as it is now, locked: an
    // administrator's reset since the plan is carried, and a phone counts as
    // verified only while the app's proof is of the number being given.
    const mustChangePassword = user.mustChangePassword;
    const phoneVerified =
      phoneCountsVerified(person.phoneSource!, user.phoneVerified) &&
      Boolean(user.phoneE164) &&
      normalizePhone(user.phoneE164!) === phone;
    person.mustChangePassword = mustChangePassword;
    person.phoneVerified = phoneVerified;
    const [identity] = await tx
      .select({ id: appIdentity.id })
      .from(appIdentity)
      .where(and(eq(appIdentity.app, 'oto_app'), eq(appIdentity.externalUserId, person.userId)))
      .limit(1);
    if (identity) throw new PersonStopped('changed_since_plan');
    const [holder] = await tx.select({ id: account.id }).from(account).where(eq(account.phone, phone)).limit(1);
    if (holder) throw new PersonStopped('phone_taken_since_plan');
    if (person.employeeId) {
      const [copy] = await tx
        .select({ id: employee.id })
        .from(employee)
        .where(and(eq(employee.id, person.employeeId), isNull(employee.archivedAt)))
        .limit(1);
      const [held] = await tx
        .select({ id: account.id })
        .from(account)
        .where(eq(account.employeeId, person.employeeId))
        .limit(1);
      if (!copy || held) throw new PersonStopped('employee_changed_since_plan');
    }

    const accountId = newId();
    await tx.insert(account).values({
      id: accountId,
      operatorId,
      employeeId: person.employeeId,
      phone,
      // No platform password yet: the first sign-in adopts the app's (SCRUM-795).
      passwordHash: null,
      status: 'active',
      // PHONE VERIFIED (an owner question): only the app's own proof of this number.
      phoneVerifiedAt: phoneVerified ? new Date() : null,
      // FORCED CHANGE (an owner question): what the app user still owes.
      mustChangePassword,
    });

    // The stamp: `platform_user_id` as `linkOtoAppUser` writes it, and the
    // app's own `must_change_password` deliberately left as it is — FORCED
    // CHANGE above says why.
    const stamped = await tx
      .update(otoappUsers)
      .set({ platformUserId: accountId, updatedAt: new Date() })
      .where(and(eq(otoappUsers.id, person.userId), isNull(otoappUsers.platformUserId)))
      .returning({ id: otoappUsers.id });
    if (stamped.length !== 1) throw new PersonStopped('changed_since_plan');

    const identityId = newId();
    await tx.insert(appIdentity).values({
      id: identityId,
      app: 'oto_app',
      accountId,
      externalUserId: person.userId,
      createdBy: actor,
    });

    // `ensureAppAccessRole` + `grantAppAccess(…, null)`: the operator's access
    // role for the app, found or created, assigned at operator scope.
    const [inserted] = await tx
      .insert(role)
      .values({
        id: newId(),
        operatorId,
        name: APP_ACCESS_ROLE,
        description: 'Opens the oto_app app',
        isSystem: false,
      })
      .onConflictDoNothing({ target: [role.operatorId, role.name] })
      .returning({ id: role.id });
    if (inserted) {
      await tx.insert(rolePermission).values({ id: newId(), roleId: inserted.id, permission: APP_ACCESS_PERMISSION });
    }
    const accessRoleId =
      inserted?.id ??
      (
        await tx
          .select({ id: role.id })
          .from(role)
          .where(and(eq(role.operatorId, operatorId), eq(role.name, APP_ACCESS_ROLE)))
          .limit(1)
      )[0]!.id;
    await tx.insert(roleAssignment).values({
      id: newId(),
      accountId,
      roleId: accessRoleId,
      scopeType: 'operator',
      scopeId: operatorId,
    });

    const scopes = !input.platformRoleId
      ? []
      : person.platformRole === 'operator_admin'
        ? [{ scopeType: 'operator' as const, scopeId: operatorId }]
        : person.branchIds.map((id) => ({ scopeType: 'branch' as const, scopeId: id }));
    for (const scope of scopes) {
      const assignmentId = newId();
      await tx.insert(roleAssignment).values({
        id: assignmentId,
        accountId,
        roleId: input.platformRoleId!,
        ...scope,
      });
      await tx.insert(auditLog).values({
        id: newId(),
        operatorId,
        actorAccountId: actor,
        requestId: STAFF_ACCOUNTS_REQUEST_ID,
        action: 'role_assignment.create',
        entityType: 'role_assignment',
        entityId: assignmentId,
        after: { accountId, role: person.platformRole, ...scope },
      });
    }

    // One row for the person, the shape SCRUM-539's provisioning writes. Ids
    // and categories only: no name, no phone, no hash.
    await tx.insert(auditLog).values({
      id: newId(),
      operatorId,
      actorAccountId: actor,
      requestId: STAFF_ACCOUNTS_REQUEST_ID,
      action: 'app_identity.provision',
      entityType: 'app_identity',
      entityId: identityId,
      after: {
        targetApp: 'oto_app',
        via: 'otoapp_staff_accounts',
        accountId,
        externalUserId: person.userId,
        appUserRole: person.appRole,
        employeeId: person.employeeId,
        phoneSource: person.phoneSource,
        platformRole: person.platformRole,
        platformScopes: scopes.length,
        accountCreated: true,
        passwordSet: false,
        mustChangePassword,
        phoneVerified,
        accessGranted: true,
      },
    });
    return accountId;
  });
}
