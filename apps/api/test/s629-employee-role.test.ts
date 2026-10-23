import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, branch, employee } from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import { runOtoAppEmployeeSync } from '../src/services/otoapp-employee-sync';
import type { AppEmployee } from '../src/services/otoapp-employees';
import { createTestContext, teardownAll, type TestContext } from './helpers';

const seam = vi.hoisted(() => ({ reconcile: vi.fn(), employees: vi.fn(), anchors: vi.fn() }));
vi.mock('../src/services/oto-app-users', async (original) => ({
  ...await original<typeof import('../src/services/oto-app-users')>(), reconcileOtoAppRole: seam.reconcile,
}));
vi.mock('../src/services/otoapp-employees', async (original) => ({
  ...await original<typeof import('../src/services/otoapp-employees')>(),
  listAppEmployees: seam.employees, otoAppEmployeesInstalled: async () => true,
}));
vi.mock('@oto/db', async (original) => ({
  ...await original<typeof import('@oto/db')>(), appTenantAnchors: seam.anchors,
}));

let ctx: TestContext;
let operatorId: string;
let accountId: string;
let foreignAccount: string;
let employeeId: string;
let row: AppEmployee;
const tenantId = newId();

beforeAll(async () => {
  ctx = await createTestContext();
  const parks = await ctx.db.select().from(branch);
  const home = parks[0]!;
  const foreign = parks.find(p => p.operatorId !== home.operatorId)!;
  operatorId = home.operatorId; accountId = newId(); foreignAccount = newId(); employeeId = newId();
  row = { id: newId(), tenantId, otoappBranchId: newId(), branchId: home.id,
    fullName: 'ZZ TEST Role-only employee', nickname: 'ZZ TEST Employee', phone: null,
    email: 'zz-test-s629@example.invalid', status: 'active', employmentState: 'ACTIVE',
    lastWorkingDay: null, updatedAt: new Date(), platformUserId: accountId };
  await ctx.db.insert(employee).values({ id: employeeId, operatorId, branchId: home.id,
    source: 'otoapp', externalId: row.id, name: row.fullName, nickname: row.nickname, phone: null, email: row.email });
  await ctx.db.insert(account).values([
    { id: accountId, operatorId, employeeId, phone: `ZZ TEST ${newId()}`, status: 'active' },
    { id: foreignAccount, operatorId: foreign.operatorId, phone: `ZZ TEST ${newId()}`, status: 'active' },
  ]);
});
beforeEach(() => {
  seam.reconcile.mockReset().mockResolvedValue(null);
  seam.employees.mockReset().mockImplementation(async () => [{ ...row }]);
  seam.anchors.mockReset().mockImplementation(async () => new Map([[tenantId, [operatorId]]]));
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-629 employee-copy role integration', () => {
  it('R1 [high] reconciles role-only changes when employee fields are unchanged; fix: call the seam before the copy no-op branch', async () => {
    const summary = await runOtoAppEmployeeSync(ctx.db);
    expect(summary).toMatchObject({ created: 0, updated: 0, archived: 0, accountsLinked: 0 });
    expect(seam.reconcile).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      operatorId, accountId, tenantId, actorAccountId: null,
    });
  });

  it('R2 [high] reconciles each owned account and tenant once even if the view repeats the login; fix: deduplicate within the operator transaction', async () => {
    seam.employees.mockResolvedValue([{ ...row }, { ...row }]);
    await runOtoAppEmployeeSync(ctx.db);
    expect(seam.reconcile).toHaveBeenCalledTimes(1);
  });

  it('R3 [critical] refuses role work for a foreign account and an ambiguous tenant anchor; fix: retain both existing ownership fences first', async () => {
    seam.employees.mockResolvedValue([{ ...row, platformUserId: foreignAccount }]);
    expect((await runOtoAppEmployeeSync(ctx.db)).raised).toBe(1);
    expect(seam.reconcile).not.toHaveBeenCalled();
    seam.employees.mockResolvedValue([{ ...row }]);
    seam.anchors.mockResolvedValue(new Map([[tenantId, [operatorId, newId()]]]));
    expect((await runOtoAppEmployeeSync(ctx.db)).skipped).toEqual([
      { tenantId, reason: 'two_operators', employees: 1 },
    ]);
    expect(seam.reconcile).not.toHaveBeenCalled();
  });

  it('R4 [critical] rolls back role audit work when reconciliation fails; fix: pass the employee-copy transaction through the identity seam', async () => {
    const marker = newId();
    seam.reconcile.mockImplementation(async (tx) => {
      await audit.record(tx, { actorAccountId: null, operatorId, action: 'ZZ TEST s629.employee.rollback',
        entityType: 'account', entityId: marker });
      throw new Error('ZZ TEST employee role reconciliation failed');
    });
    await expect(runOtoAppEmployeeSync(ctx.db)).rejects.toThrow('ZZ TEST employee role reconciliation failed');
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, marker),
      eq(auditLog.action, 'ZZ TEST s629.employee.rollback')))).toHaveLength(0);
    const [current] = await ctx.db.select().from(employee).where(eq(employee.id, employeeId));
    expect(current!.name).toBe(row.fullName);
  });
});
