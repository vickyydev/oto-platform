import { and, eq, isNotNull } from 'drizzle-orm';
import { department, employee } from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from './audit';
import type { AppDepartment, AppDepartmentSnapshot } from './otoapp-departments';
import type { AppEmployee } from './otoapp-employees';
import type { Tx } from './tx';

export const DEPARTMENT_SYNC_CASES = {
  EMPTY_SOURCE: 'OTOAPP_DEPARTMENTS_EMPTY',
  INVALID_SOURCE: 'OTOAPP_DEPARTMENT_INVALID_SOURCE',
  INVALID_BRANCH: 'OTOAPP_DEPARTMENT_INVALID_BRANCH',
  AMBIGUOUS_NAME: 'OTOAPP_DEPARTMENT_AMBIGUOUS_NAME',
  INVALID_MEMBER: 'OTOAPP_DEPARTMENT_INVALID_MEMBER',
} as const;
export type DepartmentSyncCase = (typeof DEPARTMENT_SYNC_CASES)[keyof typeof DEPARTMENT_SYNC_CASES];
export const DEPARTMENT_SYNC_WORDS: Record<DepartmentSyncCase, string> = {
  OTOAPP_DEPARTMENTS_EMPTY:
    'The OTO App answered no departments while live copied departments exist. Existing departments and memberships were kept; check the source before the next copy.',
  OTOAPP_DEPARTMENT_INVALID_SOURCE:
    'A copied department could not be tied safely to its source park group. Existing ids and memberships were kept; check the department in the OTO App.',
  OTOAPP_DEPARTMENT_INVALID_BRANCH:
    'A department assignment names an unmapped or foreign park. It was not made operator-wide and previous projections were kept; correct its branch mapping.',
  OTOAPP_DEPARTMENT_AMBIGUOUS_NAME:
    'A source department matches more than one possible seeded department. No id was guessed; an administrator must resolve the matching names.',
  OTOAPP_DEPARTMENT_INVALID_MEMBER:
    'An employee department reference does not agree with its park group or branch. The existing membership was kept; correct the source reference before copying again.',
};

export interface DepartmentMirrorCounts {
  created: number;
  adopted: number;
  updated: number;
  archived: number;
  restored: number;
  membersUpdated: number;
}
export const emptyDepartmentCounts = (): DepartmentMirrorCounts => ({
  created: 0, adopted: 0, updated: 0, archived: 0, restored: 0, membersUpdated: 0,
});

type DepartmentRow = typeof department.$inferSelect;
type Raise = (code: DepartmentSyncCase, detail: Record<string, unknown>) => void;
const key = (externalId: string, branchId: string | null) => JSON.stringify([externalId, branchId]);
const normalizedName = (name: string) => name.trim().toLowerCase();
const sameBranch = (a: string | null, b: string | null) => a === b;

export interface DepartmentProjectionState {
  snapshot: AppDepartmentSnapshot;
  masters: Map<string, AppDepartment>;
  projections: Map<string, DepartmentRow>;
  validKeys: Set<string>;
  counts: DepartmentMirrorCounts;
}

/** Core projections only; the caller owns the existing operator advisory transaction. */
export async function syncDepartmentProjections(tx: Tx, input: {
  operatorId: string;
  snapshot: AppDepartmentSnapshot;
  tenantIds: ReadonlySet<string>;
  unreadDepartmentIds: ReadonlySet<string>;
  ourBranches: ReadonlySet<string>;
  now: Date;
  raise: Raise;
}): Promise<DepartmentProjectionState> {
  const { operatorId, snapshot, now, raise } = input;
  const counts = emptyDepartmentCounts();
  const rows = await tx.select().from(department).where(eq(department.operatorId, operatorId));
  const projections = new Map(rows.filter(row => row.externalId !== null)
    .map(row => [key(row.externalId!, row.branchId), row]));
  const masters = new Map(snapshot.departments.filter(row => input.tenantIds.has(row.tenantId)).map(row => [row.id, row]));
  const allSourceIds = new Set(snapshot.departments.map(row => row.id));
  const held = new Set(input.unreadDepartmentIds);
  const validKeys = new Set<string>();
  const wanted = new Map<string, Array<string | null>>();

  // A remaining owned member reference makes a missing master incomplete,
  // rather than proof that the department is gone. Foreign members cannot
  // hold this operator's projections, and unreferenced removals still retire.
  for (const member of snapshot.members) {
    const externalId = member.primaryDepartmentId;
    if (externalId === null || !input.tenantIds.has(member.tenantId)
      || allSourceIds.has(externalId) || held.has(externalId)) continue;
    held.add(externalId);
    raise(DEPARTMENT_SYNC_CASES.INVALID_SOURCE, { externalId, tenantId: member.tenantId,
      employeeExternalId: member.id, reason: 'referenced_master_missing' });
  }

  for (const master of masters.values()) {
    const assignments = snapshot.branches.filter(row => row.departmentId === master.id);
    const parks: Array<string | null> = [];
    if (assignments.length === 0) parks.push(null);
    for (const assignment of assignments) {
      if (assignment.tenantId !== master.tenantId || assignment.branchId === null
        || !input.ourBranches.has(assignment.branchId)) {
        held.add(master.id);
        raise(DEPARTMENT_SYNC_CASES.INVALID_BRANCH, { externalId: master.id, tenantId: master.tenantId,
          otoappBranchId: assignment.otoappBranchId, branchId: assignment.branchId });
        continue;
      }
      if (!parks.includes(assignment.branchId)) parks.push(assignment.branchId);
    }
    wanted.set(master.id, parks);
  }

  // One seed matching two source masters is also ambiguous: source-id order
  // must not decide which person or team's existing id is adopted.
  const nameUses = new Map<string, number>();
  for (const master of masters.values()) for (const park of wanted.get(master.id) ?? []) {
    const nameKey = JSON.stringify([park, normalizedName(master.name)]);
    nameUses.set(nameKey, (nameUses.get(nameKey) ?? 0) + 1);
  }

  for (const master of [...masters.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const park of wanted.get(master.id) ?? []) {
      const projectionKey = key(master.id, park);
      let copy = projections.get(projectionKey);
      if (!copy) {
        const candidates = rows.filter(row => row.externalId === null && row.archivedAt === null
          && sameBranch(row.branchId, park) && normalizedName(row.name) === normalizedName(master.name));
        const nameKey = JSON.stringify([park, normalizedName(master.name)]);
        if (candidates.length > 1 || (candidates.length === 1 && nameUses.get(nameKey)! > 1)) {
          held.add(master.id);
          raise(DEPARTMENT_SYNC_CASES.AMBIGUOUS_NAME, { externalId: master.id, tenantId: master.tenantId,
            branchId: park, candidateIds: candidates.map(row => row.id) });
          continue;
        }
        const seed = candidates[0];
        const values = { name: master.name, externalId: master.id, archivedAt: master.isActive ? null : now, updatedAt: now };
        if (seed) {
          const before = { name: seed.name, externalId: null, branchId: park, archivedAt: null };
          const [adopted] = await tx.update(department).set(values)
            .where(and(eq(department.id, seed.id), eq(department.operatorId, operatorId))).returning();
          copy = adopted!;
          Object.assign(seed, copy);
          await audit.record(tx, { actorAccountId: null, operatorId, branchId: park,
            action: 'department.mirror_adopt', entityType: 'department', entityId: copy.id,
            before,
            after: { ...values, branchId: park } });
          counts.adopted += 1;
        } else {
          const [created] = await tx.insert(department).values({ id: newId(), operatorId, branchId: park,
            ...values, createdAt: now }).returning();
          copy = created!; rows.push(copy);
          await audit.record(tx, { actorAccountId: null, operatorId, branchId: park,
            action: 'department.mirror_create', entityType: 'department', entityId: copy.id,
            after: { name: copy.name, externalId: master.id, branchId: park, archivedAt: copy.archivedAt } });
          counts.created += 1;
        }
        projections.set(projectionKey, copy);
      } else {
        const archivedAt = master.isActive ? null : copy.archivedAt ?? now;
        const archived = copy.archivedAt === null && archivedAt !== null;
        const restored = copy.archivedAt !== null && archivedAt === null;
        const renamed = copy.name !== master.name;
        if (renamed || archived || restored) {
          const before = { name: copy.name, externalId: master.id, branchId: park, archivedAt: copy.archivedAt };
          const action = archived ? 'department.mirror_archive' : restored ? 'department.mirror_restore' : 'department.mirror_update';
          await tx.update(department).set({ name: master.name, archivedAt, updatedAt: now })
            .where(and(eq(department.id, copy.id), eq(department.operatorId, operatorId)));
          Object.assign(copy, { name: master.name, archivedAt, updatedAt: now });
          await audit.record(tx, { actorAccountId: null, operatorId, branchId: park, action,
            entityType: 'department', entityId: copy.id, before,
            after: { name: copy.name, externalId: master.id, branchId: park, archivedAt } });
          if (renamed) counts.updated += 1;
          if (archived) counts.archived += 1;
          if (restored) counts.restored += 1;
        }
      }
      validKeys.add(projectionKey);
    }
  }

  for (const copy of projections.values()) {
    const externalId = copy.externalId!;
    if (validKeys.has(key(externalId, copy.branchId)) || held.has(externalId) || copy.archivedAt !== null) continue;
    if (allSourceIds.has(externalId) && !masters.has(externalId)) {
      raise(DEPARTMENT_SYNC_CASES.INVALID_SOURCE, { externalId, departmentId: copy.id });
      continue;
    }
    await tx.update(department).set({ archivedAt: now, updatedAt: now })
      .where(and(eq(department.id, copy.id), eq(department.operatorId, operatorId)));
    await audit.record(tx, { actorAccountId: null, operatorId, branchId: copy.branchId,
      action: 'department.mirror_archive', entityType: 'department', entityId: copy.id,
      before: { externalId, branchId: copy.branchId, archivedAt: null },
      after: { externalId, branchId: copy.branchId, archivedAt: now,
        reason: masters.has(externalId) ? 'assignment_withdrawn' : 'gone' } });
    copy.archivedAt = now; counts.archived += 1;
  }
  return { snapshot, masters, projections, validKeys, counts };
}

/** Update only the exact copy chosen by the unchanged employee lifecycle rules. */
export async function syncDepartmentMembers(tx: Tx, input: {
  operatorId: string;
  state: DepartmentProjectionState;
  rows: readonly AppEmployee[];
  copyIds: ReadonlyMap<string, string>;
  ourBranches: ReadonlySet<string>;
  now: Date;
  raise: Raise;
}): Promise<void> {
  const { operatorId, state, raise } = input;
  const members = new Map(state.snapshot.members.map(row => [row.id, row]));
  const copies = new Map((await tx.select().from(employee).where(and(eq(employee.operatorId, operatorId),
    eq(employee.source, 'otoapp'), isNotNull(employee.externalId)))).map(row => [row.id, row]));
  for (const source of input.rows) {
    const copyId = input.copyIds.get(source.id);
    const copy = copyId ? copies.get(copyId) : undefined;
    if (!copy || copy.externalId !== source.id) continue;
    const member = members.get(source.id);
    if (!member || member.tenantId !== source.tenantId || member.otoappBranchId !== source.otoappBranchId
      || member.branchId !== source.branchId || copy.branchId !== member.branchId
      || (member.branchId !== null && !input.ourBranches.has(member.branchId))
      || (member.otoappBranchId !== null && member.branchId === null)) {
      raise(DEPARTMENT_SYNC_CASES.INVALID_MEMBER, { externalId: source.id, tenantId: source.tenantId,
        employeeId: copy.id, reason: 'employee_branch_mismatch' });
      continue;
    }
    let departmentId: string | null = null;
    if (member.primaryDepartmentId !== null) {
      const master = state.masters.get(member.primaryDepartmentId);
      if (!master || master.tenantId !== member.tenantId) {
        raise(DEPARTMENT_SYNC_CASES.INVALID_MEMBER, { externalId: source.id, employeeId: copy.id,
          primaryDepartmentId: member.primaryDepartmentId, reason: 'department_tenant_mismatch' });
        continue;
      }
      const globalKey = key(master.id, null);
      const branchKey = key(master.id, member.branchId);
      const projectionKey = state.validKeys.has(branchKey) ? branchKey : globalKey;
      const projected = state.validKeys.has(projectionKey) ? state.projections.get(projectionKey) : undefined;
      if (!projected || (projected.branchId !== null && projected.branchId !== copy.branchId)) {
        raise(DEPARTMENT_SYNC_CASES.INVALID_MEMBER, { externalId: source.id, employeeId: copy.id,
          primaryDepartmentId: member.primaryDepartmentId, reason: 'department_projection_unavailable' });
        continue;
      }
      departmentId = projected.id;
    }
    if (copy.departmentId === departmentId) continue;
    await tx.update(employee).set({ departmentId, updatedAt: input.now }).where(and(eq(employee.id, copy.id),
      eq(employee.operatorId, operatorId), eq(employee.source, 'otoapp'), eq(employee.externalId, source.id)));
    await audit.record(tx, { actorAccountId: null, operatorId, branchId: copy.branchId,
      action: 'employee.mirror_department', entityType: 'employee', entityId: copy.id,
      before: { departmentId: copy.departmentId, externalId: source.id },
      after: { departmentId, primaryDepartmentId: member.primaryDepartmentId, externalId: source.id } });
    state.counts.membersUpdated += 1;
  }
}
