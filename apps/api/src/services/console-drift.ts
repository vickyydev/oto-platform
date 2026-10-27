import { and, asc, eq, isNotNull, or, type SQL } from 'drizzle-orm';
import { account, appIdentity, appTenantAnchors, branch, employee, otoAppBranchesInstalled, type Db } from '@oto/db';
import type { Permission } from '@oto/shared';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { atBranch } from '../lib/staff-scope';
import { accountScopeFilter, assertDominatesAccount, branchReach, type BranchReach } from './access-control';
import { analyticsSelectionOf } from './console-analytics';
import { branchAppMappingForReach } from './oto-app-branches';
import { findOtoAppUser, otoAppUserIsOperators, resolveOtoAppRoleContext } from './oto-app-users';
import { listAppEmployees, otoAppEmployeesInstalled } from './otoapp-employees';
import { OtoAppSeamNotGrantedError } from './otoapp-events';
import { hasPermission, type EffectivePermission } from './permissions';
import type { Tx } from './tx';

/**
 * SCRUM-646 — read-only drift between the platform's copies and their masters.
 *
 * Each comparison follows the ownership the native code already declares, and
 * nothing here repairs, matches or writes anything:
 *
 *  - **branch_names** — the PLATFORM is the record (SCRUM-268). Read through
 *    `branchAppMappingForReach`; a live park with no app row is a missing copy,
 *    a mapped row whose name differs has drifted, and APP_ONLY rows (Head
 *    Office) are intentional and never read.
 *  - **employees** — the OTO APP is the master of the four mirrored fields and
 *    the owned branch, with its LEFT archival rule (`otoapp-employee-sync.ts`).
 *    Read through `otoapp_v.employees` and the anchor rule (`appTenantAnchors`):
 *    only park groups anchored to this operator alone are compared; one
 *    anchored to two operators is ambiguous, exactly as the copy leaves it.
 *  - **app_accounts** — the PLATFORM account and its provisioning record
 *    (`core.app_identity`) say which app user is whose. Compared only for what
 *    the native code keeps in step: the app user's stamp, its switch-off when
 *    the account is inactive, and the mapped role where the app's opt-in role
 *    context resolves. Names, emails, phones and app branch access are the
 *    app's own after provisioning and are not compared.
 *
 * Only changed field NAMES leave this file — never a value. An absent seam, a
 * denied seam or read door, and an ambiguous owner are each their own status;
 * none is ever reported as an empty clean comparison.
 */

export type DriftStatus = 'clean' | 'drift' | 'absent' | 'denied' | 'ambiguous';
export type DriftReason = 'seam_absent' | 'seam_not_granted' | 'permission' | 'anchor_ambiguous' | 'empty_source';
export type DriftKey = 'branch_names' | 'employees' | 'app_accounts';

export interface DriftItem {
  entity: 'branch' | 'employee' | 'account';
  /** The platform row: core.branch, core.employee or core.account. Null for a master with no copy. */
  platformId: string | null;
  /** The app's id for the same thing, when there is one. */
  externalId: string | null;
  /** The in-scope park the item is filed under; null for accounts and branchless employees. */
  branchId: string | null;
  /** changed: fields differ; missing: the master has no copy; orphan: a live copy whose master is gone. */
  kind: 'changed' | 'missing' | 'orphan';
  /** Field names only, in a fixed order. */
  fields: string[];
}

export interface DriftComparison {
  key: DriftKey;
  master: 'platform' | 'oto_app';
  status: DriftStatus;
  reason: DriftReason | null;
  /** The native read door that was missing, for a permission denial. */
  requiredPermission: Permission | null;
  /** Owned copies actually compared. */
  compared: number;
  /** In-scope records whose owner could not be established. */
  ambiguous: number;
  /** In-scope accounts the caller may not inspect (the account dominance rule). */
  withheld: number;
  items: DriftItem[];
}

export interface ConsoleDrift {
  generatedAt: string;
  basis: 'read-only-comparison';
  branchIds: string[];
  omitted: string[];
  comparisons: DriftComparison[];
}

/** Where one comparison may look, by its own native read door. */
interface Scope {
  /** Selected parks this door reaches. */
  branchIds: Set<string>;
  /** Branchless records: only for operator-wide authority on every door, with no park named. */
  branchless: boolean;
  reach: BranchReach;
}

const blank = (key: DriftKey, master: DriftComparison['master']): DriftComparison => ({
  key, master, status: 'clean', reason: null, requiredPermission: null, compared: 0, ambiguous: 0, withheld: 0, items: [],
});

function unavailable(base: DriftComparison, status: 'absent' | 'denied', reason: DriftReason, requiredPermission: Permission | null = null): DriftComparison {
  return { ...base, status, reason, requiredPermission, compared: 0, ambiguous: 0, withheld: 0, items: [] };
}

function settle(row: DriftComparison, reason: DriftReason | null = null): DriftComparison {
  const items = [...row.items].sort((a, b) => (a.branchId ?? '').localeCompare(b.branchId ?? '')
    || (a.platformId ?? '').localeCompare(b.platformId ?? '') || (a.externalId ?? '').localeCompare(b.externalId ?? ''));
  if (items.length) return { ...row, items, status: 'drift', reason: null };
  if (row.ambiguous > 0 || reason) return { ...row, items, status: 'ambiguous', reason: reason ?? 'anchor_ambiguous' };
  return { ...row, items, status: 'clean', reason: null };
}

/**
 * Run one comparison in its own savepoint, so a seam the database refuses
 * becomes that comparison's denied state rather than a failed reading.
 */
async function guarded(tx: Tx, base: DriftComparison, work: (sp: Tx) => Promise<DriftComparison>): Promise<DriftComparison> {
  try {
    return await tx.transaction(work);
  } catch (error) {
    if (error instanceof OtoAppSeamNotGrantedError || pgErrorOf(error)?.code === '42501') {
      return unavailable(base, 'denied', 'seam_not_granted');
    }
    throw error;
  }
}

function scopeOf(input: {
  effective: EffectivePermission[];
  operatorId: string;
  permission: Permission;
  selected: readonly string[];
  explicit: boolean;
}): Scope {
  const reach = branchReach(input.effective, input.permission, input.operatorId);
  const branchIds = new Set(input.selected.filter(id => reach.kind === 'operator' || reach.branchIds.includes(id)));
  const operatorWide = (permission: Permission) => hasPermission(input.effective, permission, { operatorId: input.operatorId, operatorOnly: true });
  const branchless = !input.explicit && reach.kind === 'operator'
    && operatorWide('console:analytics:read') && operatorWide('analytics:read');
  return { branchIds, branchless, reach };
}

const covers = (scope: Scope, branchId: string | null) => branchId === null ? scope.branchless : scope.branchIds.has(branchId);

async function compareBranchNames(tx: Tx, operatorId: string, scope: Scope): Promise<DriftComparison> {
  const base = blank('branch_names', 'platform');
  if (!scope.branchIds.size) return unavailable(base, 'denied', 'permission', 'admin:branch:read');
  return guarded(tx, base, async sp => {
    const view = await branchAppMappingForReach(sp, operatorId, scope.reach);
    if (!view.installed) return unavailable(base, 'absent', 'seam_absent');
    const row = { ...base };
    // `view.appOnly` (Head Office and its like) is unmapped by design: never read.
    for (const park of view.branches) {
      if (!scope.branchIds.has(park.branchId)) continue;
      if (park.appBranchId === null) {
        row.items.push({ entity: 'branch', platformId: park.branchId, externalId: null, branchId: park.branchId, kind: 'missing', fields: [] });
        continue;
      }
      row.compared += 1;
      if (park.appBranchName !== park.branchName) {
        row.items.push({ entity: 'branch', platformId: park.branchId, externalId: park.appBranchId, branchId: park.branchId, kind: 'changed', fields: ['name'] });
      }
    }
    return settle(row);
  });
}

const EMPLOYEE_FIELDS = ['name', 'nickname', 'phone', 'email', 'branchId'] as const;

async function compareEmployees(tx: Tx, operatorId: string, scope: Scope): Promise<DriftComparison> {
  const base = blank('employees', 'oto_app');
  if (!scope.branchIds.size && !scope.branchless) return unavailable(base, 'denied', 'permission', 'admin:account:read');
  return guarded(tx, base, async sp => {
    if (!(await otoAppEmployeesInstalled(sp))) return unavailable(base, 'absent', 'seam_absent');
    const rows = await listAppEmployees(sp);
    const anchors = await appTenantAnchors(sp);
    const ourBranches = new Set((await sp.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId))).map(park => park.id));
    const copies = await sp.select({
      id: employee.id, externalId: employee.externalId, name: employee.name, nickname: employee.nickname,
      phone: employee.phone, email: employee.email, branchId: employee.branchId, archivedAt: employee.archivedAt,
    }).from(employee)
      .where(and(eq(employee.operatorId, operatorId), eq(employee.source, 'otoapp'), isNotNull(employee.externalId)))
      .orderBy(asc(employee.id));
    const live = new Map<string, (typeof copies)[number]>();
    const archived = new Map<string, (typeof copies)[number]>();
    for (const c of copies) {
      if (c.archivedAt === null) live.set(c.externalId!, c);
      else {
        const seen = archived.get(c.externalId!);
        if (!seen || seen.archivedAt! < c.archivedAt) archived.set(c.externalId!, c);
      }
    }
    const row = { ...base };

    // The copy archives nobody when the app answers nobody; neither does this.
    if (rows.length === 0 && [...live.values()].some(c => covers(scope, c.branchId))) return settle(row, 'empty_source');

    const appIds = new Set(rows.map(r => r.id));
    for (const r of rows) {
      const operators = anchors.get(r.tenantId) ?? [];
      const copy = live.get(r.id) ?? null;
      const expectedBranch = r.branchId !== null && ourBranches.has(r.branchId) ? r.branchId : null;
      if (!operators.includes(operatorId)) {
        // Not this operator's park group. A live copy of ours is then gone from
        // our masters (one other owner), or unread (no owner, or two).
        if (copy && covers(scope, copy.branchId)) {
          if (operators.length === 1) {
            row.items.push({ entity: 'employee', platformId: copy.id, externalId: r.id, branchId: copy.branchId, kind: 'orphan', fields: ['archivedAt'] });
          } else row.ambiguous += 1;
        }
        continue;
      }
      if (operators.length > 1) {
        if (covers(scope, expectedBranch) || (copy !== null && covers(scope, copy.branchId))) row.ambiguous += 1;
        continue;
      }
      if (!covers(scope, expectedBranch) && !(copy !== null && covers(scope, copy.branchId))) continue;
      const filed = copy !== null && covers(scope, copy.branchId) ? copy.branchId : expectedBranch;
      const left = r.employmentState === 'LEFT';
      const expected = { name: r.fullName, nickname: r.nickname, phone: r.phone, email: r.email, branchId: expectedBranch };
      const changed = (c: NonNullable<typeof copy>) => EMPLOYEE_FIELDS.filter(field => c[field] !== expected[field]);
      if (copy) {
        row.compared += 1;
        const fields = left ? ['archivedAt'] : changed(copy);
        if (fields.length) row.items.push({ entity: 'employee', platformId: copy.id, externalId: r.id, branchId: filed, kind: 'changed', fields });
        continue;
      }
      const previous = archived.get(r.id);
      if (previous) {
        row.compared += 1;
        // A rehire takes the same row back; a leaver stays archived.
        if (!left) row.items.push({ entity: 'employee', platformId: previous.id, externalId: r.id, branchId: filed, kind: 'changed', fields: [...changed(previous), 'archivedAt'] });
        continue;
      }
      // A leaver is never copied; anybody else should have been.
      if (!left) row.items.push({ entity: 'employee', platformId: null, externalId: r.id, branchId: filed, kind: 'missing', fields: [] });
    }
    for (const [externalId, copy] of live) {
      if (appIds.has(externalId) || !covers(scope, copy.branchId)) continue;
      row.items.push({ entity: 'employee', platformId: copy.id, externalId, branchId: copy.branchId, kind: 'orphan', fields: ['archivedAt'] });
    }
    return settle(row);
  });
}

async function compareAppAccounts(tx: Tx, input: {
  operatorId: string;
  effective: EffectivePermission[];
  scope: Scope;
}): Promise<DriftComparison> {
  const { operatorId, effective, scope } = input;
  const base = blank('app_accounts', 'platform');
  // The identities read's own door and branch tie (`GET /admin/apps/users/:accountId`).
  const permission: Permission = 'admin:role:read';
  const native = accountScopeFilter(effective, operatorId, permission);
  if (native.empty || !scope.branchIds.size) return unavailable(base, 'denied', 'permission', permission);
  // Narrowed to the parks this reading covers, unless it covers the whole operator.
  const whole = scope.reach.kind === 'operator' && scope.branchless;
  const filter: SQL | undefined = whole ? undefined : or(...[...scope.branchIds].map(id => atBranch(id)));
  return guarded(tx, base, async sp => {
    if (!(await otoAppBranchesInstalled(sp))) return unavailable(base, 'absent', 'seam_absent');
    const links = await sp.select({ accountId: account.id, status: account.status, userId: appIdentity.externalUserId })
      .from(appIdentity)
      .innerJoin(account, eq(account.id, appIdentity.accountId))
      .leftJoin(employee, eq(account.employeeId, employee.id))
      .where(and(eq(appIdentity.app, 'oto_app'), eq(account.operatorId, operatorId), native.filter ?? undefined, filter))
      .orderBy(asc(account.id));
    const row = { ...base };
    for (const link of links) {
      try {
        await assertDominatesAccount(sp, effective, operatorId, link.accountId);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 403) { row.withheld += 1; continue; }
        throw error;
      }
      const user = await findOtoAppUser(sp, { id: link.userId });
      if (!user) {
        row.items.push({ entity: 'account', platformId: link.accountId, externalId: link.userId, branchId: null, kind: 'missing', fields: [] });
        continue;
      }
      if (!(await otoAppUserIsOperators(sp, { operatorId, userId: user.id }))) { row.ambiguous += 1; continue; }
      row.compared += 1;
      const fields: string[] = [];
      if (user.platformUserId !== link.accountId) fields.push('platformUserId');
      if (link.status === 'inactive' && user.isActive) fields.push('isActive');
      const context = await resolveOtoAppRoleContext(sp, { operatorId, accountId: link.accountId });
      if (context && context.userId === user.id && user.role !== 'advisor' && user.role !== context.role) fields.push('role');
      if (fields.length) row.items.push({ entity: 'account', platformId: link.accountId, externalId: user.id, branchId: null, kind: 'changed', fields });
    }
    return settle(row);
  });
}

/** One read-only reading of all three comparisons for the Analytics selection. */
export async function consoleDriftOf(db: Db, input: {
  operatorId: string;
  effective: EffectivePermission[];
  branchIds?: readonly string[];
  now?: Date;
}): Promise<ConsoleDrift> {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const { selected, omitted, explicit } = await analyticsSelectionOf(tx, input);
    const ids = selected.map(park => park.id);
    const scope = (permission: Permission) => scopeOf({ effective: input.effective, operatorId: input.operatorId, permission, selected: ids, explicit });
    const branchScope = scope('admin:branch:read');
    const accountScope = scope('admin:account:read');
    const roleScope = scope('admin:role:read');
    const comparisons = [
      await compareBranchNames(tx, input.operatorId, branchScope),
      await compareEmployees(tx, input.operatorId, accountScope),
      await compareAppAccounts(tx, { operatorId: input.operatorId, effective: input.effective, scope: roleScope }),
    ];
    return { generatedAt: now.toISOString(), basis: 'read-only-comparison', branchIds: ids, omitted, comparisons };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
