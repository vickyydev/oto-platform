import { and, eq, isNull, sql } from 'drizzle-orm';
import { boolean, pgSchema, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { newId } from '@oto/shared';
import type { Db } from '../index';
import { branch } from './tenancy';

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
/**
 * What `core_sync_status` says about one of the app's branch rows.
 *
 * `PENDING`, `SUCCESS` and `FAILED` are the app's own three, declared when the
 * column was added and written by nothing until SCRUM-268. `APP_ONLY` is the
 * fourth and it is not a failure: Head Office is a row in the app's branch list
 * and deliberately not a `core.branch` — it trades nothing, has no till and no
 * gate — so the mapping leaves it alone rather than erroring on it every run.
 * Without a word for that, "unmapped by design" and "unmapped because something
 * went wrong" would be the same empty column.
 */
export const OTO_APP_BRANCH_SYNC_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'APP_ONLY'] as const;
export type OtoAppBranchSyncStatus = (typeof OTO_APP_BRANCH_SYNC_STATUSES)[number];

export const otoappBranches = otoapp.table('branches', {
  /** `varchar` here against a platform `uuid`; the app mints its own. */
  id: varchar('id').primaryKey(),
  /** NOT NULL there. Copied onto a branch access row, which also requires it. */
  tenantId: uuid('tenant_id').notNull(),
  /** `otoapp.operators.id` — the app's own operator table, not `core.operator`. */
  operatorId: uuid('operator_id'),
  name: text('name').notNull(),
  /** NOT NULL there, so a row the platform creates has to carry one. */
  address: text('address').notNull(),
  /** NOT NULL there with a default; the platform copies the branch's own. */
  timezone: text('timezone').notNull(),
  /**
   * `core.branch.id`, as text. Declared `text` in the app's schema, so a
   * comparison against a platform uuid is written as text on both sides.
   *
   * At most one app row may carry a given platform branch, and the database
   * says so: `branches_core_branch_id_unique`, a unique index over the column
   * where it is not null, added in the app's own migration `0002` (SCRUM-319).
   * Every "is it mapped already" test below reads rows this transaction cannot
   * see uncommitted, so two concurrent creates of one branch both found nothing
   * and both wrote — leaving one platform branch with two app rows, and which
   * of them a person was seated in decided by which the reader happened to
   * find first. Declared there rather than here: the app owns this table and
   * this file is a narrow re-declaration that no migration is ever generated
   * from.
   */
  coreBranchId: text('core_branch_id'),
  coreSyncStatus: text('core_sync_status', { enum: OTO_APP_BRANCH_SYNC_STATUSES }),
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

// ---------------------------------------------------------------------------
// The seam: `core.branch` ↔ `otoapp.branches` (SCRUM-268)
// ---------------------------------------------------------------------------

/**
 * THE DECISIONS, so that nobody has to reconstruct them from the code:
 *
 * 1. **The platform's branch is the record.** `otoapp.branches.core_branch_id`
 *    holds the platform branch's uuid as text; the app row's name follows the
 *    platform's when a branch is created or renamed there;
 *    `core_sync_status` / `core_synced_at` / `core_sync_error` say when that
 *    last happened and why it did not.
 * 2. **Head Office is an app-only row.** It trades nowhere, it has no platform
 *    branch, its `core_branch_id` stays null and the mapping leaves it alone —
 *    never archived, never errored. It is unmapped BY DESIGN, and
 *    `core_sync_status = 'APP_ONLY'` is where that is said.
 * 3. Provisioning seats a person in the mapped app branch of the platform
 *    branch they work at — `apps/api/src/services/oto-app-users.ts`.
 * 4. **Rows that already exist on both sides are reconciled once, by name.**
 *    `reconcileAppBranches` matches an unmapped app row to a platform branch by
 *    trimmed, case-folded name — the park's export carries a trailing space on
 *    "Oto Play Park, Central Floresta " — writes `core_branch_id`, and from
 *    then on the two are joined by id and the name may drift on either side
 *    without breaking anything. It is idempotent: a second run writes nothing
 *    and says so.
 *
 * **Why this lives in `@oto/db` and not in `apps/api/src/services`.** Both the
 * api and `packages/db/src/seed` have to run the same reconciliation, and the
 * seed cannot import from the api — the dependency only points the other way.
 * Two copies of a matching rule is exactly how these two lists drifted apart in
 * the first place. What is here is the mechanism; the api's
 * `services/oto-app-branches.ts` is what gives it a permission check, an audit
 * row and an error envelope.
 */

/** The pool, or a transaction on it. Same surface for everything below. */
export type OtoAppExec = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** A platform branch, as the mapping needs it. */
interface CoreBranchSeed {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
}

interface AppBranchRow {
  id: string;
  tenantId: string;
  operatorId: string | null;
  name: string;
  coreBranchId: string | null;
  coreSyncStatus: OtoAppBranchSyncStatus | null;
  coreSyncError: string | null;
}

const APP_BRANCH_COLUMNS = {
  id: otoappBranches.id,
  tenantId: otoappBranches.tenantId,
  operatorId: otoappBranches.operatorId,
  name: otoappBranches.name,
  coreBranchId: otoappBranches.coreBranchId,
  coreSyncStatus: otoappBranches.coreSyncStatus,
  coreSyncError: otoappBranches.coreSyncError,
};

/**
 * The one comparison a first-time match is allowed to make.
 *
 * Trimmed because the park's export holds `"Oto Play Park, Central Floresta "`
 * and that trailing space is real — the app's own importer find-or-creates on
 * the exact string, so it was never going to be tidied away there. Case-folded
 * because "Robinson Chalong" and "Robinson chalong" are one park. Inner
 * whitespace is collapsed for the same reason a double space between two words
 * is a typo and not a different branch.
 */
export function foldBranchName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Is the OTO App's schema on this database at all?
 *
 * Asked before every statement below, and not once at boot: a platform-only
 * deployment (and every test that does not opt into the app's 184-table
 * baseline) has the `otoapp` schema from migration 0008 and nothing in it, and
 * a missing relation inside a transaction aborts the whole transaction — which
 * would mean opening a branch failed because an app nobody installed was not
 * there. `to_regclass` answers null instead of raising.
 */
export async function otoAppBranchesInstalled(exec: OtoAppExec): Promise<boolean> {
  const res = await exec.execute<{ reg: string | null }>(
    sql`select to_regclass('otoapp.branches')::text as reg`,
  );
  return Boolean(res.rows[0]?.reg);
}

async function loadAppBranches(exec: OtoAppExec): Promise<AppBranchRow[]> {
  return exec.select(APP_BRANCH_COLUMNS).from(otoappBranches);
}

/**
 * The operator's LIVE branches. An archived park keeps whatever app row it has
 * — the app's history hangs off it — but it is not matched to a new one and
 * never has one created for it.
 */
async function loadCoreBranches(exec: OtoAppExec, operatorId: string): Promise<CoreBranchSeed[]> {
  return exec
    .select({
      id: branch.id,
      name: branch.name,
      address: branch.address,
      timezone: branch.timezone,
    })
    .from(branch)
    .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)));
}

/**
 * The tenant a row the platform creates must belong to — and the reason this
 * cannot simply be "the app's only tenant".
 *
 * `otoapp.operators` and `core.operator` are different tables with different
 * ids and no correspondence between them, so nothing here can work out which
 * app tenant an operator belongs to. What CAN be established is that this
 * operator is already present in the app: one app row carrying one of its
 * branch ids. That row's tenant is the anchor, and without one the platform
 * creates nothing — the alternative is putting a second park's branch inside
 * the first park's tenant, which is a leak that would look like a feature.
 */
function anchorOf(appRows: AppBranchRow[], coreIds: Set<string>) {
  return appRows.find((r) => r.coreBranchId !== null && coreIds.has(r.coreBranchId)) ?? null;
}

/**
 * Tenants of the app that already belong to somebody else — any tenant holding
 * a row mapped to a branch that is not one of this operator's.
 *
 * This is the fence around the first-time NAME match, and it is needed because
 * that match is the one step taken without an anchor: bootstrapping the park's
 * own rows requires it. Without this, a second operator opening a branch called
 * "Head Office" would claim the first operator's head office row by naming it.
 * A tenant nobody has claimed is still open to a name match, which is the case
 * every real deployment starts from.
 */
function foreignTenantsOf(appRows: AppBranchRow[], ourIds: Set<string>): Set<string> {
  return new Set(
    appRows.flatMap((r) => (r.coreBranchId && !ourIds.has(r.coreBranchId) ? [r.tenantId] : [])),
  );
}

/** Why a platform branch has no app row. */
export type AppBranchMapRefusal = 'app_not_installed' | 'no_app_anchor' | 'ambiguous_name';

export interface AppBranchMapResult {
  appBranchId: string | null;
  appBranchName: string | null;
  status: OtoAppBranchSyncStatus | null;
  /** How the row was found, or that it was made here. */
  mappedBy: 'core_branch_id' | 'name' | 'created' | null;
  reason: AppBranchMapRefusal | null;
}

const unmappedResult = (reason: AppBranchMapRefusal): AppBranchMapResult => ({
  appBranchId: null,
  appBranchName: null,
  status: null,
  mappedBy: null,
  reason,
});

/**
 * Give a platform branch its row in the OTO App — the create path.
 *
 * Runs inside the transaction that creates the branch, so a branch and its app
 * row arrive together or not at all. It does NOT refuse when the app is absent
 * or unanchored: opening a park must not depend on another application being
 * installed, so the refusal travels back as `reason` for the answer and the
 * audit row to carry.
 */
export async function mapCoreBranchIntoApp(
  exec: OtoAppExec,
  input: { operatorId: string; branchId: string; name: string; address: string | null; timezone: string },
): Promise<AppBranchMapResult> {
  if (!(await otoAppBranchesInstalled(exec))) return unmappedResult('app_not_installed');

  const appRows = await loadAppBranches(exec);
  const already = appRows.find((r) => r.coreBranchId === input.branchId);
  if (already) {
    // A replay, or a branch created twice against the same id. Nothing to do,
    // and saying "created" for a row that was already there would be a lie in
    // the audit trail.
    return {
      appBranchId: already.id,
      appBranchName: already.name,
      status: already.coreSyncStatus,
      mappedBy: 'core_branch_id',
      reason: null,
    };
  }

  const coreIds = new Set((await loadCoreBranches(exec, input.operatorId)).map((b) => b.id));
  coreIds.add(input.branchId);
  const foreign = foreignTenantsOf(appRows, coreIds);

  // The first-time name join, applied to one branch: an app row that is
  // obviously this same park, carrying no mapping yet, is taken rather than
  // duplicated beside.
  const folded = foldBranchName(input.name);
  const peers = appRows.filter(
    (r) =>
      r.coreBranchId === null && !foreign.has(r.tenantId) && foldBranchName(r.name) === folded,
  );
  if (peers.length > 1) return unmappedResult('ambiguous_name');
  if (peers.length === 1) {
    await markMapped(exec, peers[0]!.id, input.branchId);
    return {
      appBranchId: peers[0]!.id,
      appBranchName: peers[0]!.name,
      status: 'SUCCESS',
      mappedBy: 'name',
      reason: null,
    };
  }

  const anchor = anchorOf(appRows, coreIds);
  if (!anchor) return unmappedResult('no_app_anchor');

  const created = await createAppBranch(exec, anchor, input);
  return {
    appBranchId: created.id,
    appBranchName: created.name,
    status: 'SUCCESS',
    mappedBy: 'created',
    reason: null,
  };
}

async function createAppBranch(
  exec: OtoAppExec,
  anchor: AppBranchRow,
  input: { branchId: string; name: string; address: string | null; timezone: string },
): Promise<{ id: string; name: string }> {
  const id = newId();
  await exec.insert(otoappBranches).values({
    id,
    // The tenant and the operator come off the anchor row rather than off
    // anything on the platform: they are the app's own ids and this is the
    // only place they can honestly be read from.
    tenantId: anchor.tenantId,
    operatorId: anchor.operatorId,
    name: input.name,
    // Empty rather than invented. The column is NOT NULL there and the
    // platform's address is optional; "nobody has said yet" is the truth, and
    // a placeholder sentence would be printed on something one day.
    address: input.address ?? '',
    timezone: input.timezone,
    coreBranchId: input.branchId,
    coreSyncStatus: 'SUCCESS',
    coreSyncedAt: new Date(),
    coreSyncError: null,
  });
  return { id, name: input.name };
}

const markMapped = (exec: OtoAppExec, appBranchId: string, coreBranchId: string) =>
  exec
    .update(otoappBranches)
    .set({
      coreBranchId,
      coreSyncStatus: 'SUCCESS',
      coreSyncedAt: new Date(),
      coreSyncError: null,
    })
    .where(eq(otoappBranches.id, appBranchId));

/**
 * Follow a rename. The platform's branch is the record (decision 1), so the
 * app row's name follows it — by id, never by the old name, which is the whole
 * point of having written `core_branch_id` down.
 *
 * Null when there is no mapped row: an unmapped park is not renamed into
 * existence by an edit on the platform.
 */
export async function renameAppBranchForCore(
  exec: OtoAppExec,
  input: { branchId: string; name: string },
): Promise<{ appBranchId: string; appBranchName: string } | null> {
  if (!(await otoAppBranchesInstalled(exec))) return null;
  const [row] = await exec
    .update(otoappBranches)
    .set({
      name: input.name,
      coreSyncStatus: 'SUCCESS',
      coreSyncedAt: new Date(),
      coreSyncError: null,
    })
    .where(eq(otoappBranches.coreBranchId, input.branchId))
    .returning({ id: otoappBranches.id, name: otoappBranches.name });
  return row ? { appBranchId: row.id, appBranchName: row.name } : null;
}

// --- Reading the mapping ----------------------------------------------------

export interface AppBranchLookup {
  id: string;
  name: string;
  tenantId: string;
  matchedBy: 'core_branch_id' | 'name';
}

/**
 * The app branch a platform branch corresponds to, for seating a person in it.
 *
 * Prefers the id, which survives a rename on either side, and falls back to the
 * folded name for a deployment whose rows have not been reconciled yet.
 * `'ambiguous'` rather than a guess when two app rows carry that name: seating
 * somebody in the wrong park's data is invisible afterwards, and landing
 * nowhere is not.
 *
 * The name step is the FIRST-TIME join and nothing else, which is why it takes
 * only rows carrying no `core_branch_id` — the same requirement the
 * reconciliation's name step has always had, and missing here until SCRUM-319.
 * Without it, two parks sharing a name where one is already mapped to the other
 * park's branch seated this one's staff in that other park's data: the id says
 * whose row it is, and a row that has already answered that question is not
 * available to be claimed again by a name.
 */
export async function findAppBranchForCore(
  exec: OtoAppExec,
  input: { operatorId: string; coreBranchId: string; name: string },
): Promise<AppBranchLookup | 'ambiguous' | null> {
  if (!(await otoAppBranchesInstalled(exec))) return null;
  const rows = await loadAppBranches(exec);
  const byId = rows.find((r) => r.coreBranchId === input.coreBranchId);
  if (byId) return { id: byId.id, name: byId.name, tenantId: byId.tenantId, matchedBy: 'core_branch_id' };
  // Same fence as the reconciliation's name step: a tenant another operator has
  // already claimed is not somewhere this one's staff may be seated by name.
  const ourIds = new Set((await loadCoreBranches(exec, input.operatorId)).map((b) => b.id));
  const foreign = foreignTenantsOf(rows, ourIds);
  const folded = foldBranchName(input.name);
  const named = rows.filter(
    (r) =>
      r.coreBranchId === null && !foreign.has(r.tenantId) && foldBranchName(r.name) === folded,
  );
  if (named.length > 1) return 'ambiguous';
  const one = named[0];
  return one ? { id: one.id, name: one.name, tenantId: one.tenantId, matchedBy: 'name' } : null;
}

/**
 * Every app branch joined to a live branch of this operator — what somebody who
 * administers the whole operator is given access to.
 *
 * Mapped rows only, deliberately: "every branch" through the app's own
 * `all_branches` scope would also hand them Head Office and anything else in
 * that tenant, which is wider than the platform is entitled to decide.
 */
export async function mappedAppBranches(
  exec: OtoAppExec,
  operatorId: string,
): Promise<Array<{ id: string; name: string; tenantId: string; coreBranchId: string }>> {
  if (!(await otoAppBranchesInstalled(exec))) return [];
  const ours = new Set((await loadCoreBranches(exec, operatorId)).map((b) => b.id));
  return (await loadAppBranches(exec))
    .filter((r) => r.coreBranchId !== null && ours.has(r.coreBranchId))
    .map((r) => ({ id: r.id, name: r.name, tenantId: r.tenantId, coreBranchId: r.coreBranchId! }));
}

export interface AppBranchMappingRow {
  branchId: string;
  branchName: string;
  appBranchId: string | null;
  appBranchName: string | null;
  status: OtoAppBranchSyncStatus | null;
  error: string | null;
}

export interface AppBranchOnlyRow {
  appBranchId: string;
  appBranchName: string;
  status: OtoAppBranchSyncStatus | null;
}

export interface AppBranchMappingView {
  installed: boolean;
  branches: AppBranchMappingRow[];
  /** Rows the app has and the platform does not — Head Office and its like. */
  appOnly: AppBranchOnlyRow[];
}

/**
 * What the Console shows per branch. Read-only, and it never guesses: a branch
 * with no app row says so, and a row belonging to no branch is listed
 * separately rather than being quietly dropped or counted as an error.
 */
export async function readAppBranchMapping(
  exec: OtoAppExec,
  operatorId: string,
): Promise<AppBranchMappingView> {
  const coreBranches = await loadCoreBranches(exec, operatorId);
  if (!(await otoAppBranchesInstalled(exec))) {
    return {
      installed: false,
      branches: coreBranches.map((b) => ({
        branchId: b.id,
        branchName: b.name,
        appBranchId: null,
        appBranchName: null,
        status: null,
        error: null,
      })),
      appOnly: [],
    };
  }

  const appRows = await loadAppBranches(exec);
  const byCore = new Map(appRows.filter((r) => r.coreBranchId).map((r) => [r.coreBranchId!, r]));
  const ours = new Set(coreBranches.map((b) => b.id));
  const anchor = anchorOf(appRows, ours);
  return {
    installed: true,
    branches: coreBranches.map((b) => {
      const app = byCore.get(b.id) ?? null;
      return {
        branchId: b.id,
        branchName: b.name,
        appBranchId: app?.id ?? null,
        appBranchName: app?.name ?? null,
        status: app?.coreSyncStatus ?? null,
        error: app?.coreSyncError ?? null,
      };
    }),
    /**
     * Only the tenant this operator is anchored in — and none at all when it is
     * anchored nowhere. An unmapped app row is somebody's head office, and
     * which somebody is a question only the anchor answers: showing every one
     * of them to an operator who has no row in this app at all would hand a
     * second operator's administrator the first one's list of sites.
     */
    appOnly: anchor
      ? appRows
          .filter((r) => !r.coreBranchId && r.tenantId === anchor.tenantId)
          .map((r) => ({ appBranchId: r.id, appBranchName: r.name, status: r.coreSyncStatus }))
      : [],
  };
}

// --- Reconciling what already exists ----------------------------------------

export type AppBranchUnmappedReason = 'no_app_anchor' | 'ambiguous_name';
export type AppBranchAmbiguity = 'two_app_rows' | 'two_platform_branches';

export interface AppBranchReconcileReport {
  installed: boolean;
  /** Joined by id before this run started. Untouched by it. */
  alreadyMapped: number;
  matchedByName: Array<{
    branchId: string;
    branchName: string;
    appBranchId: string;
    appBranchName: string;
  }>;
  created: Array<{ branchId: string; branchName: string; appBranchId: string }>;
  /** Rows the app has and the platform does not. `marked` says whether this run wrote the status. */
  appOnly: Array<{ appBranchId: string; appBranchName: string; marked: boolean }>;
  ambiguous: Array<{ appBranchId: string; appBranchName: string; why: AppBranchAmbiguity }>;
  unmapped: Array<{ branchId: string; branchName: string; reason: AppBranchUnmappedReason }>;
  /** Rows this run actually wrote. Zero is what a second run answers. */
  writes: number;
}

const emptyReport = (installed: boolean): AppBranchReconcileReport => ({
  installed,
  alreadyMapped: 0,
  matchedByName: [],
  created: [],
  appOnly: [],
  ambiguous: [],
  unmapped: [],
  writes: 0,
});

/**
 * Join the two lists as they stand today — the one-off, run by the seed and by
 * `POST /branches/oto-app/reconcile`.
 *
 * Four phases, in this order and for these reasons:
 *
 *  1. **By id.** Anything already carrying `core_branch_id` is mapped and is
 *     not looked at again. A name may drift on either side afterwards and this
 *     keeps holding, which is the point of writing the id down.
 *  2. **By name, once.** An unmapped app row and an unclaimed platform branch
 *     whose folded names are equal are the same park. Two candidates on either
 *     side is an ambiguity, not a coin toss: guessing seats a park's staff in
 *     the other park's data, and that is invisible afterwards. The row is left
 *     unmapped and marked FAILED with the reason on it.
 *  3. **Create.** A platform branch with no app row gets one — but only inside
 *     a tenant this operator is already anchored in (see `anchorOf`).
 *  4. **`APP_ONLY`.** What is left on the app's side belongs to no platform
 *     branch, which is Head Office and anything like it. Saying so is the
 *     difference between "we looked and it is meant to be this way" and a blank
 *     column.
 *
 * Idempotent throughout: every write is guarded on the value already there, so
 * a second run writes nothing and `writes` comes back 0.
 */
export async function reconcileAppBranches(
  exec: OtoAppExec,
  opts: { operatorId: string },
): Promise<AppBranchReconcileReport> {
  if (!(await otoAppBranchesInstalled(exec))) return emptyReport(false);

  const coreBranches = await loadCoreBranches(exec, opts.operatorId);
  const appRows = await loadAppBranches(exec);
  const report = emptyReport(true);

  // 1 — already joined by id.
  const ourIds = new Set(coreBranches.map((b) => b.id));
  const claimed = new Set(
    appRows.flatMap((r) => (r.coreBranchId && ourIds.has(r.coreBranchId) ? [r.coreBranchId] : [])),
  );
  report.alreadyMapped = claimed.size;

  // 2 — the first-time name join, inside tenants nobody else has claimed.
  const foreign = foreignTenantsOf(appRows, ourIds);
  const freeApp = appRows.filter((r) => r.coreBranchId === null && !foreign.has(r.tenantId));
  const appByName = new Map<string, AppBranchRow[]>();
  for (const row of freeApp) {
    const key = foldBranchName(row.name);
    appByName.set(key, [...(appByName.get(key) ?? []), row]);
  }
  const coreByName = new Map<string, CoreBranchSeed[]>();
  for (const b of coreBranches) {
    if (claimed.has(b.id)) continue;
    const key = foldBranchName(b.name);
    coreByName.set(key, [...(coreByName.get(key) ?? []), b]);
  }

  const ambiguousApp = new Set<string>();
  for (const row of freeApp) {
    const key = foldBranchName(row.name);
    const candidates = coreByName.get(key) ?? [];
    if (candidates.length === 0) continue;
    const peers = appByName.get(key) ?? [];
    const why: AppBranchAmbiguity | null =
      peers.length > 1 ? 'two_app_rows' : candidates.length > 1 ? 'two_platform_branches' : null;
    if (why) {
      ambiguousApp.add(row.id);
      report.ambiguous.push({ appBranchId: row.id, appBranchName: row.name, why });
      const message = `Two candidates for "${row.name.trim()}" — mapped by hand or renamed, not guessed`;
      if (row.coreSyncStatus !== 'FAILED' || row.coreSyncError !== message) {
        await exec
          .update(otoappBranches)
          .set({ coreSyncStatus: 'FAILED', coreSyncedAt: new Date(), coreSyncError: message })
          .where(eq(otoappBranches.id, row.id));
        report.writes += 1;
      }
      continue;
    }
    const match = candidates[0]!;
    await markMapped(exec, row.id, match.id);
    report.writes += 1;
    claimed.add(match.id);
    row.coreBranchId = match.id;
    report.matchedByName.push({
      branchId: match.id,
      branchName: match.name,
      appBranchId: row.id,
      appBranchName: row.name,
    });
  }

  // 3 — a platform branch the app has never heard of.
  const anchor = anchorOf(appRows, ourIds);
  for (const b of coreBranches) {
    if (claimed.has(b.id)) continue;
    if (!anchor) {
      report.unmapped.push({ branchId: b.id, branchName: b.name, reason: 'no_app_anchor' });
      continue;
    }
    const created = await createAppBranch(exec, anchor, {
      branchId: b.id,
      name: b.name,
      address: b.address,
      timezone: b.timezone,
    });
    report.writes += 1;
    claimed.add(b.id);
    report.created.push({ branchId: b.id, branchName: b.name, appBranchId: created.id });
  }

  /**
   * 4 — what is left on the app's side is app-only, and that is not a failure.
   *
   * Only inside the tenant this operator is anchored in. With no anchor, this
   * operator has no row in the app at all and none of what is there is its
   * business: marking those rows — or even listing them back — would be one
   * operator's administrator writing on, and reading, another's branch list.
   */
  for (const row of anchor ? freeApp : []) {
    if (row.coreBranchId !== null || ambiguousApp.has(row.id)) continue;
    if (row.tenantId !== anchor!.tenantId) continue;
    const marked = row.coreSyncStatus !== 'APP_ONLY';
    if (marked) {
      await exec
        .update(otoappBranches)
        .set({ coreSyncStatus: 'APP_ONLY', coreSyncedAt: new Date(), coreSyncError: null })
        .where(eq(otoappBranches.id, row.id));
      report.writes += 1;
    }
    report.appOnly.push({ appBranchId: row.id, appBranchName: row.name, marked });
  }

  return report;
}
