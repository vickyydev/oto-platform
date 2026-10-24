import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, branch, department, employee, operator, role, roleAssignment, schema, team, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import { runOtoAppEmployeeSync } from '../src/services/otoapp-employee-sync';
import type { AppDepartment, AppDepartmentSnapshot } from '../src/services/otoapp-departments';
import type { AppEmployee } from '../src/services/otoapp-employees';
import { OtoAppSeamNotGrantedError } from '../src/services/otoapp-events';
import type { Tx } from '../src/services/tx';

const seam = vi.hoisted(() => ({ departments: vi.fn(), employees: vi.fn(), anchors: vi.fn(), role: vi.fn() }));
vi.mock('../src/services/otoapp-departments', async original => ({
  ...await original<typeof import('../src/services/otoapp-departments')>(), readAppDepartmentSnapshot: seam.departments,
}));
vi.mock('../src/services/otoapp-employees', async original => ({
  ...await original<typeof import('../src/services/otoapp-employees')>(),
  listAppEmployees: seam.employees, otoAppEmployeesInstalled: async () => true,
}));
vi.mock('../src/services/oto-app-users', async original => ({
  ...await original<typeof import('../src/services/oto-app-users')>(), reconcileOtoAppRole: seam.role,
}));
vi.mock('@oto/db', async original => ({
  ...await original<typeof import('@oto/db')>(), appTenantAnchors: seam.anchors,
}));

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;
let db: Db;
const now = new Date('2026-10-24T12:00:00.000Z');

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new pg.Pool({ connectionString: database.url });
  db = drizzle(pool, { schema }) as Db;
});
beforeEach(() => {
  seam.departments.mockReset(); seam.employees.mockReset(); seam.anchors.mockReset();
  seam.role.mockReset().mockResolvedValue(null);
});
afterAll(async () => { await pool?.end(); await database?.drop(); await stopTestServer(); });

async function fixture(tx: Tx) {
  const f = { operatorId: newId(), foreignOperator: newId(), tenantId: newId(), foreignTenant: newId(),
    branchA: newId(), branchB: newId(), foreignBranch: newId(), appA: newId(), appB: newId(),
    snapshot: { departments: [], branches: [], members: [] } as AppDepartmentSnapshot, rows: [] as AppEmployee[] };
  await tx.insert(operator).values([{ id: f.operatorId, name: 'ZZ TEST mirror owner' },
    { id: f.foreignOperator, name: 'ZZ TEST other owner' }]);
  await tx.insert(branch).values([
    { id: f.branchA, operatorId: f.operatorId, name: 'ZZ TEST A', code: 'zz-test-a' },
    { id: f.branchB, operatorId: f.operatorId, name: 'ZZ TEST B', code: 'zz-test-b' },
    { id: f.foreignBranch, operatorId: f.foreignOperator, name: 'ZZ TEST foreign', code: 'zz-test-foreign' },
  ]);
  seam.departments.mockResolvedValue(f.snapshot);
  seam.employees.mockResolvedValue(f.rows);
  seam.anchors.mockResolvedValue(new Map([[f.tenantId, [f.operatorId]]]));
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function scenario(work: (tx: Tx, f: Fixture) => Promise<void>) {
  const rollback = Symbol('s631 scenario rollback');
  try {
    await db.transaction(async tx => { await work(tx, await fixture(tx)); throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
}
const run = (tx: Tx) => runOtoAppEmployeeSync(tx as unknown as Db, now);
function source(f: Fixture, name = 'ZZ TEST department', parks: string[] = [f.branchA]): AppDepartment {
  const row = { id: newId(), tenantId: f.tenantId, name, isActive: true, updatedAt: now };
  f.snapshot.departments.push(row);
  for (const park of parks) f.snapshot.branches.push({ departmentId: row.id, tenantId: f.tenantId,
    otoappBranchId: park === f.branchA ? f.appA : park === f.branchB ? f.appB : newId(), branchId: park });
  return row;
}
function staff(f: Fixture, primaryDepartmentId: string | null, park = f.branchA): AppEmployee {
  const row: AppEmployee = { id: newId(), tenantId: f.tenantId, otoappBranchId: park === f.branchA ? f.appA : f.appB,
    branchId: park, fullName: 'ZZ TEST copied person', nickname: 'ZZ TEST person', phone: null,
    email: `zz-test-${newId()}@example.invalid`, status: 'active', employmentState: 'ACTIVE',
    lastWorkingDay: null, updatedAt: now, platformUserId: null };
  f.rows.push(row);
  f.snapshot.members.push({ id: row.id, tenantId: row.tenantId, otoappBranchId: row.otoappBranchId,
    branchId: row.branchId, primaryDepartmentId });
  return row;
}
const projections = (tx: Tx, f: Fixture, externalId: string) => tx.select().from(department)
  .where(and(eq(department.operatorId, f.operatorId), eq(department.externalId, externalId)));
async function projection(tx: Tx, f: Fixture, externalId: string) {
  const rows = await projections(tx, f, externalId);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!;
}
const copies = (tx: Tx, f: Fixture, externalId: string) => tx.select().from(employee)
  .where(and(eq(employee.operatorId, f.operatorId), eq(employee.externalId, externalId)));
const audits = (tx: Tx, entityId: string) => tx.select().from(auditLog).where(eq(auditLog.entityId, entityId));

describe('SCRUM-631 department copy house review', () => {
  it('R1 [high] preserves legacy employee copying when the department seam is absent; fix: null readiness skips only the new phase', async () => {
    await scenario(async (tx, f) => {
      seam.departments.mockResolvedValue(null);
      const person = staff(f, null);
      const summary = await run(tx);
      expect(summary.created).toBe(1);
      expect((await copies(tx, f, person.id))[0]).toMatchObject({ source: 'otoapp', branchId: f.branchA, departmentId: null });
    });
  });

  it('R2 [critical] preserves existing membership when the optional seam is absent; fix: absence must never masquerade as a null primary department', async () => {
    await scenario(async (tx, f) => {
      const held = newId(); const person = staff(f, null);
      await tx.insert(department).values({ id: held, operatorId: f.operatorId, branchId: f.branchA, name: 'ZZ TEST held' });
      await tx.insert(employee).values({ id: newId(), operatorId: f.operatorId, source: 'otoapp', externalId: person.id,
        name: person.fullName, nickname: person.nickname, email: person.email, branchId: f.branchA, departmentId: held });
      seam.departments.mockResolvedValue(null);
      await run(tx);
      expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(held);
    });
  });

  it('R3 [critical] adopts both seeded Reception ids without moving team or grant references; fix: match exact operator and branch with trim/case only', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, ' Reception ', [f.branchA, f.branchB]);
      const a = newId(); const b = newId(); const teamId = newId(); const accountId = newId(); const roleId = newId(); const grantId = newId();
      await tx.insert(department).values([
        { id: a, operatorId: f.operatorId, branchId: f.branchA, name: 'reception' },
        { id: b, operatorId: f.operatorId, branchId: f.branchB, name: 'Reception' },
      ]);
      await tx.insert(team).values({ id: teamId, operatorId: f.operatorId, branchId: f.branchA,
        departmentId: a, key: 'reception', name: 'ZZ TEST desk', colour: 'sky' });
      await tx.insert(account).values({ id: accountId, operatorId: f.operatorId, phone: `ZZ TEST ${newId()}` });
      await tx.insert(role).values({ id: roleId, operatorId: f.operatorId, name: 'ZZ TEST department grant' });
      await tx.insert(roleAssignment).values({ id: grantId, accountId, roleId, scopeType: 'department', scopeId: b });
      await run(tx);
      expect((await projections(tx, f, master.id)).map(row => row.id).sort()).toEqual([a, b].sort());
      expect((await tx.select().from(team).where(eq(team.id, teamId)))[0]!.departmentId).toBe(a);
      expect((await tx.select().from(roleAssignment).where(eq(roleAssignment.id, grantId)))[0]!.scopeId).toBe(b);
      expect((await audits(tx, a)).some(row => row.actorAccountId === null && row.action === 'department.mirror_adopt')).toBe(true);
    });
  });

  it('R4 [high] copies an empty department without employees and keeps fuzzy names distinct; fix: enumerate department tenants independently', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST Front desk'); const old = newId();
      await tx.insert(department).values({ id: old, operatorId: f.operatorId, branchId: f.branchA, name: 'ZZ TEST Reception' });
      await run(tx);
      const rows = await projections(tx, f, master.id);
      expect(rows).toHaveLength(1); expect(rows[0]!.id).not.toBe(old);
      expect(rows[0]).toMatchObject({ branchId: f.branchA, archivedAt: null });
    });
  });

  it('R5 [high] gives only truly zero-assigned departments a null-branch projection; fix: distinguish no rows from unreadable assignments', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST operator department', []);
      await run(tx);
      expect(await projections(tx, f, master.id)).toEqual([expect.objectContaining({ branchId: null, archivedAt: null })]);
    });
  });

  it('R6 [critical] raises unmapped and foreign assignments without globalising them; fix: validate every actual mapped branch against the operator', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST unsafe', []);
      f.snapshot.branches.push({ departmentId: master.id, tenantId: f.tenantId, otoappBranchId: newId(), branchId: null },
        { departmentId: master.id, tenantId: f.tenantId, otoappBranchId: newId(), branchId: f.foreignBranch });
      const summary = await run(tx);
      expect(await projections(tx, f, master.id)).toEqual([]); expect(summary.raised).toBeGreaterThan(0);
      expect(await tx.select().from(department).where(eq(department.operatorId, f.foreignOperator))).toEqual([]);
    });
  });

  it('R7 [critical] holds all previous projections when one assignment becomes unreadable; fix: invalid metadata is not a withdrawal', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST held assignments', [f.branchA, f.branchB]);
      await run(tx); const before = await projections(tx, f, master.id); expect(before).toHaveLength(2);
      f.snapshot.branches.splice(0, f.snapshot.branches.length,
        { departmentId: master.id, tenantId: f.tenantId, otoappBranchId: f.appA, branchId: f.branchA },
        { departmentId: master.id, tenantId: f.tenantId, otoappBranchId: f.appB, branchId: null });
      expect((await run(tx)).raised).toBeGreaterThan(0);
      expect((await projections(tx, f, master.id)).map(row => ({ id: row.id, archivedAt: row.archivedAt })))
        .toEqual(before.map(row => ({ id: row.id, archivedAt: null })));
    });
  });

  it('R8 [high] keeps a renamed department id and writes no audit on replay; fix: external identity wins after one adoption', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); await run(tx);
      const id = (await projection(tx, f, master.id)).id;
      master.name = 'ZZ TEST renamed'; await run(tx);
      expect((await projections(tx, f, master.id))[0]).toMatchObject({ id, name: master.name });
      const before = await audits(tx, id); await run(tx);
      expect(await audits(tx, id)).toEqual(before);
    });
  });

  it('R9 [high] archives and restores a deactivated master on the same ids; fix: soft archive only, never replace rows', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST lifecycle', [f.branchA, f.branchB]); await run(tx);
      const first = await projections(tx, f, master.id); expect(first).toHaveLength(2);
      const ids = first.map(row => row.id).sort();
      master.isActive = false; await run(tx);
      expect((await projections(tx, f, master.id)).every(row => row.archivedAt !== null)).toBe(true);
      master.isActive = true; await run(tx);
      const restored = await projections(tx, f, master.id);
      expect(restored.map(row => row.id).sort()).toEqual(ids); expect(restored.every(row => row.archivedAt === null)).toBe(true);
    });
  });

  it('R10 [critical] archives a withdrawn branch and restores its original id on return; fix: never repoint a projection across parks', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST branch change', [f.branchA, f.branchB]); await run(tx);
      const b = (await projections(tx, f, master.id)).find(row => row.branchId === f.branchB)!;
      expect(b).toBeDefined();
      f.snapshot.branches.splice(f.snapshot.branches.findIndex(row => row.branchId === f.branchB), 1);
      await run(tx); expect((await projections(tx, f, master.id)).find(row => row.id === b.id)!.archivedAt).not.toBeNull();
      f.snapshot.branches.push({ departmentId: master.id, tenantId: f.tenantId, otoappBranchId: f.appB, branchId: f.branchB });
      await run(tx); expect((await projections(tx, f, master.id)).find(row => row.id === b.id)).toMatchObject({ branchId: f.branchB, archivedAt: null });
    });
  });

  it('R11 [high] archives a removed master only with a nonempty complete source; fix: distinguish gone from globally empty', async () => {
    await scenario(async (tx, f) => {
      const gone = source(f, 'ZZ TEST gone'); source(f, 'ZZ TEST remains'); await run(tx);
      await projection(tx, f, gone.id);
      f.snapshot.departments.splice(f.snapshot.departments.findIndex(row => row.id === gone.id), 1);
      f.snapshot.branches.splice(f.snapshot.branches.findIndex(row => row.departmentId === gone.id), 1);
      await run(tx); expect((await projections(tx, f, gone.id))[0]!.archivedAt).not.toBeNull();
    });
  });

  it('R12 [critical] holds live projections and memberships on an unexpectedly empty master source; fix: raise instead of retiring the estate', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); const person = staff(f, master.id); await run(tx);
      const before = await projection(tx, f, master.id); const held = (await copies(tx, f, person.id))[0]!.departmentId;
      f.snapshot.departments.length = 0; f.snapshot.branches.length = 0;
      expect((await run(tx)).raised).toBeGreaterThan(0);
      expect((await projections(tx, f, master.id))[0]!.archivedAt).toBeNull();
      expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(held); expect(held).toBe(before.id);
    });
  });

  it('R24 [high] holds an owned referenced master missing from a partial source while retiring an unreferenced gone master; fix: protect incomplete source ids before retirement', async () => {
    await scenario(async (tx, f) => {
      const missing = source(f, 'ZZ TEST missing but referenced');
      const gone = source(f, 'ZZ TEST genuinely gone'); source(f, 'ZZ TEST remains');
      const person = staff(f, missing.id); await run(tx);
      const held = await projection(tx, f, missing.id);
      await projection(tx, f, gone.id);
      const removed = new Set([missing.id, gone.id]);
      f.snapshot.departments.splice(0, f.snapshot.departments.length,
        ...f.snapshot.departments.filter(row => !removed.has(row.id)));
      f.snapshot.branches.splice(0, f.snapshot.branches.length,
        ...f.snapshot.branches.filter(row => !removed.has(row.departmentId)));
      expect((await run(tx)).raised).toBeGreaterThan(0);
      expect(await projection(tx, f, missing.id)).toMatchObject({ id: held.id, archivedAt: null });
      expect((await projection(tx, f, gone.id)).archivedAt).not.toBeNull();
      expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(held.id);
    });
  });

  it('R25 [critical] does not let a foreign membership pin another operator\'s gone projection; fix: derive missing-master holds only from this operator\'s anchored tenants', async () => {
    await scenario(async (tx, f) => {
      const gone = source(f, 'ZZ TEST owned gone'); source(f, 'ZZ TEST remains'); await run(tx);
      await projection(tx, f, gone.id);
      f.snapshot.departments.splice(f.snapshot.departments.findIndex(row => row.id === gone.id), 1);
      f.snapshot.branches.splice(f.snapshot.branches.findIndex(row => row.departmentId === gone.id), 1);
      f.snapshot.members.push({ id: newId(), tenantId: f.foreignTenant, otoappBranchId: newId(),
        branchId: f.foreignBranch, primaryDepartmentId: gone.id });
      await run(tx);
      expect((await projection(tx, f, gone.id)).archivedAt).not.toBeNull();
    });
  });

  it('R13 [critical] refuses an ambiguous seeded name instead of picking the first id; fix: require a unique normalized adoption candidate', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'Reception'); const ids = [newId(), newId()];
      await tx.insert(department).values(ids.map((id, index) => ({ id, operatorId: f.operatorId,
        branchId: f.branchA, name: index ? ' Reception ' : 'reception' })));
      expect((await run(tx)).raised).toBeGreaterThan(0); expect(await projections(tx, f, master.id)).toEqual([]);
      expect((await tx.select().from(department).where(eq(department.operatorId, f.operatorId))).map(row => row.id).sort()).toEqual(ids.sort());
    });
  });

  it('R14 [critical] skips an unanchored or ambiguously anchored tenant without retiring its existing department; fix: preserve unread source ids', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); await run(tx);
      const held = (await projection(tx, f, master.id)).id;
      seam.anchors.mockResolvedValue(new Map([[f.tenantId, [f.operatorId, f.foreignOperator]]]));
      expect((await run(tx)).raised).toBeGreaterThan(0);
      expect((await projections(tx, f, master.id))[0]).toMatchObject({ id: held, archivedAt: null });
      seam.anchors.mockResolvedValue(new Map()); await run(tx);
      expect((await projections(tx, f, master.id))[0]!.archivedAt).toBeNull();
    });
  });

  it('R15 [high] links new and restored copies to the exact branch projection and clears an explicit null; fix: reconcile membership inside the same transaction', async () => {
    await scenario(async (tx, f) => {
      const master = source(f, 'ZZ TEST member department', [f.branchA, f.branchB]); const person = staff(f, master.id);
      await run(tx); const first = (await copies(tx, f, person.id))[0]!;
      const projected = await projections(tx, f, master.id); expect(projected).toHaveLength(2);
      const a = projected.find(row => row.branchId === f.branchA)!;
      const b = projected.find(row => row.branchId === f.branchB)!; expect(first.departmentId).toBe(a.id);
      person.branchId = f.branchB; person.otoappBranchId = f.appB;
      Object.assign(f.snapshot.members[0]!, { branchId: f.branchB, otoappBranchId: f.appB });
      await run(tx); expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(b.id);
      person.employmentState = 'LEFT'; await run(tx);
      person.employmentState = 'ACTIVE'; await run(tx);
      expect((await copies(tx, f, person.id))[0]).toMatchObject({ id: first.id, archivedAt: null, departmentId: b.id });
      f.snapshot.members[0]!.primaryDepartmentId = null; await run(tx);
      expect((await copies(tx, f, person.id))[0]!.departmentId).toBeNull();
    });
  });

  it('R16 [critical] refuses foreign or unknown primary department references without detaching a good link; fix: validate member/master tenant before linking', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); const person = staff(f, master.id); await run(tx);
      const held = (await copies(tx, f, person.id))[0]!.departmentId;
      expect(held).not.toBeNull();
      const foreign = { ...master, id: newId(), tenantId: f.foreignTenant }; f.snapshot.departments.push(foreign);
      seam.anchors.mockResolvedValue(new Map([[f.tenantId, [f.operatorId]], [f.foreignTenant, [f.foreignOperator]]]));
      f.snapshot.members[0]!.primaryDepartmentId = foreign.id;
      expect((await run(tx)).raised).toBeGreaterThan(0); expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(held);
      f.snapshot.members[0]!.primaryDepartmentId = newId();
      expect((await run(tx)).raised).toBeGreaterThan(0); expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(held);
    });
  });

  it('R17 [critical] holds membership if independently read employee/source branch tuples disagree; fix: refuse a mixed-snapshot or foreign-branch link', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); const person = staff(f, master.id); await run(tx);
      const held = (await copies(tx, f, person.id))[0]!.departmentId;
      expect(held).not.toBeNull();
      Object.assign(f.snapshot.members[0]!, { branchId: f.foreignBranch, otoappBranchId: newId(), primaryDepartmentId: null });
      expect((await run(tx)).raised).toBeGreaterThan(0);
      expect((await copies(tx, f, person.id))[0]!.departmentId).toBe(held);
    });
  });

  it('R18 [high] copies department links during platform employee adoption without changing its id; fix: include adopted copies in the membership phase', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); const person = staff(f, master.id); const employeeId = newId(); const accountId = newId();
      await tx.insert(employee).values({ id: employeeId, operatorId: f.operatorId, branchId: f.branchA, name: 'ZZ TEST platform person' });
      await tx.insert(account).values({ id: accountId, operatorId: f.operatorId, employeeId, phone: `ZZ TEST ${newId()}` });
      person.platformUserId = accountId; await run(tx);
      const copiedDepartment = await projection(tx, f, master.id);
      expect((await copies(tx, f, person.id))[0]).toMatchObject({ id: employeeId, source: 'otoapp',
        departmentId: copiedDepartment.id });
      expect(seam.role).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        operatorId: f.operatorId, accountId, tenantId: f.tenantId, actorAccountId: null,
      });
    });
  });

  it('R19 [critical] never edits unrelated platform-owned employee membership; fix: update only trusted OTO copies with matching source identity', async () => {
    await scenario(async (tx, f) => {
      const master = source(f); const id = newId();
      await tx.insert(employee).values({ id, operatorId: f.operatorId, branchId: f.branchA, name: 'ZZ TEST platform only', departmentId: null });
      f.snapshot.members.push({ id, tenantId: f.tenantId, otoappBranchId: f.appA, branchId: f.branchA, primaryDepartmentId: master.id });
      await run(tx);
      expect((await tx.select().from(employee).where(eq(employee.id, id)))[0]).toMatchObject({ source: 'platform', externalId: null, departmentId: null });
    });
  });

  it.each(['denied', 'failed'] as const)('R20 [critical] propagates a %s source before any department or employee write; fix: never reinterpret source failure as empty', async failure => {
    await scenario(async (tx, f) => {
      source(f); staff(f, null);
      const error = failure === 'denied' ? new OtoAppSeamNotGrantedError(['SELECT on otoapp_v.departments']) : new Error('ZZ TEST source failure');
      seam.departments.mockRejectedValue(error);
      await expect(run(tx)).rejects.toBe(error);
      expect(await tx.select().from(department).where(eq(department.operatorId, f.operatorId))).toEqual([]);
      expect(await tx.select().from(employee).where(eq(employee.operatorId, f.operatorId))).toEqual([]);
    });
  });

  it('R21 [critical] rolls back projections, new copies and their audit if membership audit fails late; fix: keep every phase in the existing operator transaction', async () => {
    await scenario(async (tx, f) => {
      source(f); const person = staff(f, f.snapshot.departments[0]!.id);
      const record = audit.record.bind(audit);
      const spy = vi.spyOn(audit, 'record').mockImplementation(async (handle, entry) => {
        if (entry.action === 'employee.mirror_department') throw new Error('ZZ TEST department audit failure');
        return record(handle, entry);
      });
      try { await expect(run(tx)).rejects.toThrow('ZZ TEST department audit failure'); }
      finally { spy.mockRestore(); }
      expect(await projections(tx, f, f.snapshot.departments[0]!.id)).toEqual([]);
      expect(await copies(tx, f, person.id)).toEqual([]);
      expect(await tx.select().from(auditLog).where(eq(auditLog.operatorId, f.operatorId))).toEqual([]);
    });
  });

  it('R22 [high] makes a ready empty source with no held projections a write-free no-op; fix: distinguish safe emptiness from absence and outage', async () => {
    await scenario(async (tx, f) => {
      await run(tx);
      expect(await tx.select().from(department).where(eq(department.operatorId, f.operatorId))).toEqual([]);
      expect(await tx.select().from(auditLog).where(eq(auditLog.operatorId, f.operatorId))).toEqual([]);
    });
  });

  it('R23 [high] serialises simultaneous copies to one projection and one creation audit; fix: retain the operator advisory transaction for department work', async () => {
    // This case uses committed fixtures so two independent transactions really race.
    const f = await db.transaction(tx => fixture(tx)); const master = source(f);
    await Promise.all([runOtoAppEmployeeSync(db, now), runOtoAppEmployeeSync(db, now)]);
    const rows = await db.select().from(department).where(and(eq(department.operatorId, f.operatorId), eq(department.externalId, master.id), isNull(department.archivedAt)));
    expect(rows).toHaveLength(1);
    const lines = await db.select().from(auditLog).where(and(eq(auditLog.entityId, rows[0]!.id), eq(auditLog.action, 'department.mirror_create')));
    expect(lines).toHaveLength(1);
  });
});
