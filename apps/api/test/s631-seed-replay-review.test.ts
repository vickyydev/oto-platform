import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, branch, department, operator, role, roleAssignment, team } from '@oto/db';
import { INBOX_DEPARTMENTS, platformSync, syncInboxSetup } from '@oto/db/seed';
import { newId } from '@oto/shared';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); }, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function estate(label: string) {
  const operatorId = newId(), branchId = newId();
  await ctx.db.insert(operator).values({ id: operatorId, name: `ZZ TEST 631 ${label} ${newId()}` });
  await ctx.db.insert(branch).values({ id: branchId, operatorId, name: `ZZ TEST 631 ${label}`, code: `zz-631-${newId()}` });
  return { operatorId, branchId };
}

async function departmentsFor(operatorId: string) {
  return ctx.db.select().from(department).where(eq(department.operatorId, operatorId)).orderBy(asc(department.id));
}

async function teamsFor(operatorId: string) {
  return ctx.db.select().from(team).where(eq(team.operatorId, operatorId)).orderBy(asc(team.id));
}

describe('SCRUM-631 department mirror and normal platform seed replay', () => {
  it('R1 [high] keeps the existing Reception department identity after source adoption and rename; fix: reuse the canonical team’s owned mirrored department before name fallback', async () => {
    const [existing] = await ctx.db.select({ desk: team, roster: department }).from(team)
      .innerJoin(department, eq(department.id, team.departmentId))
      .where(and(eq(team.key, 'reception'), isNotNull(team.branchId)))
      .orderBy(asc(team.id)).limit(1);
    expect(existing).toBeDefined();
    const { desk, roster } = existing!;
    expect(roster.operatorId).toBe(desk.operatorId);
    expect(roster.branchId).toBe(desk.branchId);
    expect(roster.externalId).toBeNull();
    const accountId = newId(), roleId = newId(), grantId = newId();
    await ctx.db.insert(account).values({ id: accountId, operatorId: desk.operatorId, phone: `ZZ TEST ${newId()}` });
    await ctx.db.insert(role).values({ id: roleId, operatorId: desk.operatorId, name: `ZZ TEST 631 seed replay ${newId()}` });
    await ctx.db.insert(roleAssignment).values({ id: grantId, accountId, roleId, scopeType: 'department', scopeId: roster.id });

    // The real copy keeps this ID and branch while the OTO App masters its name.
    // No app employee, source fixture or scheduler is needed for this seed boundary.
    const sourceId = newId(), sourceName = `ZZ TEST 631 renamed Reception ${newId()}`;
    await ctx.db.update(department).set({ externalId: sourceId, name: sourceName })
      .where(eq(department.id, roster.id));
    const beforeIds = (await ctx.db.select({ id: department.id }).from(department)
      .where(eq(department.operatorId, desk.operatorId)).orderBy(asc(department.id))).map(row => row.id);
    const beforeTeam = (await ctx.db.select().from(team).where(eq(team.id, desk.id)))[0];
    const beforeGrant = (await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.id, grantId)))[0];

    // This is the same re-runnable step used by the API's normal pre-deploy.
    await platformSync(ctx.db);

    expect((await ctx.db.select().from(team).where(eq(team.id, desk.id)))[0]).toEqual(beforeTeam);
    expect((await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.id, grantId)))[0]).toEqual(beforeGrant);
    expect((await ctx.db.select().from(department).where(eq(department.id, roster.id)))[0])
      .toMatchObject({ id: roster.id, operatorId: desk.operatorId, branchId: desk.branchId, externalId: sourceId, name: sourceName });
    const afterIds = (await ctx.db.select({ id: department.id }).from(department)
      .where(eq(department.operatorId, desk.operatorId)).orderBy(asc(department.id))).map(row => row.id);
    expect(afterIds, 'normal deploy must not recreate an unlinked fallback for the existing mirrored team department').toEqual(beforeIds);
    expect(await ctx.db.select().from(department).where(and(eq(department.operatorId, desk.operatorId),
      eq(department.branchId, desk.branchId!), eq(department.name, roster.name)))).toEqual([]);
  }, 180_000);

  it('R2 keeps fresh native branch and null-branch departments unchanged on a second replay', async () => {
    const { operatorId, branchId } = await estate('fresh');
    await syncInboxSetup(ctx.db);
    const departments = await departmentsFor(operatorId);
    const desks = await teamsFor(operatorId);
    expect(departments).toHaveLength(3);
    expect(departments.every(row => row.externalId === null)).toBe(true);
    expect(departments.filter(row => row.branchId === null).map(row => row.name).sort())
      .toEqual([INBOX_DEPARTMENTS.birthdays, INBOX_DEPARTMENTS.marketing].sort());
    expect(departments.find(row => row.branchId === branchId)?.name).toBe('reception');
    expect(desks).toHaveLength(3);
    await syncInboxSetup(ctx.db);
    expect(await departmentsFor(operatorId)).toEqual(departments);
    expect(await teamsFor(operatorId)).toEqual(desks);
  }, 180_000);

  it('R3 preserves the existing name fallback for renamed unlinked branch and operator-wide native departments without moving teams', async () => {
    const { operatorId } = await estate('unlinked');
    await syncInboxSetup(ctx.db);
    const beforeDepartments = await departmentsFor(operatorId);
    const beforeTeams = await teamsFor(operatorId);
    for (const row of beforeDepartments) {
      await ctx.db.update(department).set({ name: `ZZ TEST 631 native rename ${newId()}` }).where(eq(department.id, row.id));
    }
    const renamed = await departmentsFor(operatorId);
    await syncInboxSetup(ctx.db);
    const after = await departmentsFor(operatorId);
    expect(after).toHaveLength(beforeDepartments.length + 3);
    for (const row of renamed) expect(after.find(candidate => candidate.id === row.id)).toEqual(row);
    expect(after.filter(row => !renamed.some(original => original.id === row.id)).map(row => row.name).sort())
      .toEqual([INBOX_DEPARTMENTS.birthdays, INBOX_DEPARTMENTS.marketing, 'reception'].sort());
    for (const original of beforeDepartments) {
      expect(after.some(row => row.name === original.name && row.branchId === original.branchId && row.externalId === null)).toBe(true);
    }
    expect(await teamsFor(operatorId)).toEqual(beforeTeams);
    await syncInboxSetup(ctx.db);
    expect(await departmentsFor(operatorId)).toEqual(after);
  }, 180_000);

  it('R4 never reuses a foreign operator projection even when its branch id matches the canonical team', async () => {
    const own = await estate('foreign fence'), foreign = await estate('foreign owner');
    await syncInboxSetup(ctx.db);
    const desk = (await teamsFor(own.operatorId)).find(row => row.key === 'reception')!;
    const linkedId = newId();
    await ctx.db.insert(department).values({ id: linkedId, operatorId: foreign.operatorId, branchId: own.branchId,
      externalId: newId(), name: `ZZ TEST 631 foreign source ${newId()}` });
    await ctx.db.update(department).set({ name: 'ZZ TEST 631 renamed native foreign-fence fallback' }).where(eq(department.id, desk.departmentId!));
    await ctx.db.update(team).set({ departmentId: linkedId }).where(eq(team.id, desk.id));
    const beforeDesk = (await teamsFor(own.operatorId)).find(row => row.id === desk.id);
    const ownDepartments = await departmentsFor(own.operatorId);
    const foreignDepartments = await departmentsFor(foreign.operatorId);
    await syncInboxSetup(ctx.db);
    const after = await departmentsFor(own.operatorId);
    expect(after).toHaveLength(ownDepartments.length + 1);
    for (const row of ownDepartments) expect(after.find(candidate => candidate.id === row.id)).toEqual(row);
    expect(after.some(row => row.branchId === own.branchId && row.name === 'reception' && row.externalId === null)).toBe(true);
    expect(await departmentsFor(foreign.operatorId)).toEqual(foreignDepartments);
    expect((await teamsFor(own.operatorId)).find(row => row.id === desk.id)).toEqual(beforeDesk);
  }, 180_000);

  it('R5 never lets another branch projection suppress the exact branch name fallback', async () => {
    const { operatorId, branchId } = await estate('branch fence');
    const otherBranchId = newId();
    await ctx.db.insert(branch).values({ id: otherBranchId, operatorId, name: 'ZZ TEST 631 other branch', code: `zz-631-${newId()}` });
    await syncInboxSetup(ctx.db);
    const desks = await teamsFor(operatorId);
    const ownDesk = desks.find(row => row.key === 'reception' && row.branchId === branchId)!;
    const otherDesk = desks.find(row => row.key === 'reception' && row.branchId === otherBranchId)!;
    await ctx.db.update(department).set({ externalId: newId(), name: `ZZ TEST 631 other projection ${newId()}` })
      .where(eq(department.id, otherDesk.departmentId!));
    await ctx.db.update(department).set({ name: 'ZZ TEST 631 renamed native branch-fence fallback' }).where(eq(department.id, ownDesk.departmentId!));
    await ctx.db.update(team).set({ departmentId: otherDesk.departmentId }).where(eq(team.id, ownDesk.id));
    const beforeDepartments = await departmentsFor(operatorId), beforeTeams = await teamsFor(operatorId);
    await syncInboxSetup(ctx.db);
    const after = await departmentsFor(operatorId);
    expect(after).toHaveLength(beforeDepartments.length + 1);
    for (const row of beforeDepartments) expect(after.find(candidate => candidate.id === row.id)).toEqual(row);
    expect(await teamsFor(operatorId)).toEqual(beforeTeams);
    expect(after.some(row => row.branchId === branchId && row.name === 'reception' && row.externalId === null)).toBe(true);
  }, 180_000);

  it('R6 never treats an operator-wide projection as a branch projection', async () => {
    const { operatorId, branchId } = await estate('null branch fence');
    await syncInboxSetup(ctx.db);
    const desk = (await teamsFor(operatorId)).find(row => row.key === 'reception')!;
    const globalId = newId();
    await ctx.db.insert(department).values({ id: globalId, operatorId, branchId: null, externalId: newId(), name: 'ZZ TEST 631 global source' });
    await ctx.db.update(department).set({ name: 'ZZ TEST 631 renamed native null-fence fallback' }).where(eq(department.id, desk.departmentId!));
    await ctx.db.update(team).set({ departmentId: globalId }).where(eq(team.id, desk.id));
    const beforeDepartments = await departmentsFor(operatorId), beforeTeams = await teamsFor(operatorId);
    await syncInboxSetup(ctx.db);
    const after = await departmentsFor(operatorId);
    expect(after).toHaveLength(beforeDepartments.length + 1);
    for (const row of beforeDepartments) expect(after.find(candidate => candidate.id === row.id)).toEqual(row);
    expect(await teamsFor(operatorId)).toEqual(beforeTeams);
    expect(after.some(row => row.branchId === branchId && row.name === 'reception' && row.externalId === null)).toBe(true);
  }, 180_000);

  it('R7 retains the canonical archived source identity until the mirror restores it', async () => {
    const { operatorId } = await estate('archived source');
    await syncInboxSetup(ctx.db);
    const desk = (await teamsFor(operatorId)).find(row => row.key === 'reception')!;
    await ctx.db.update(department).set({ externalId: newId(), name: 'ZZ TEST 631 archived source', archivedAt: new Date() })
      .where(eq(department.id, desk.departmentId!));
    const beforeDepartments = await departmentsFor(operatorId), beforeTeams = await teamsFor(operatorId);
    await syncInboxSetup(ctx.db);
    expect(await departmentsFor(operatorId)).toEqual(beforeDepartments);
    expect(await teamsFor(operatorId)).toEqual(beforeTeams);
  }, 180_000);
});
