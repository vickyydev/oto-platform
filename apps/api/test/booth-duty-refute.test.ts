import { hash as argonHash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  account,
  auditLog,
  boothDutyAssignment,
  employee,
  station,
  type Db,
} from '@oto/db';
import { boothDutyLabel, boothStaffLabel, newId } from '@oto/shared';
import { createTestContext, teardownAll, type TestContext } from './helpers';
import {
  boothBusinessDate,
  matchBoothDuty,
  syncBoothDuty,
} from '../src/services/booth-duty';
import { loadBoothStation, type BoothStationRow } from '../src/services/booth';

/**
 * SCRUM-473 adversarial gate — reproductions. Each `it` states the behaviour
 * the round claims; a failing one is a defect that survived.
 */

describe('matcher: nothing silently dropped', () => {
  it('two casual workers sharing a nickname are both accounted for (named or listed)', () => {
    const out = matchBoothDuty({
      rule: { groupText: 'Sale Booth', dutyText: 'booth' },
      assignments: [
        { assigneeType: 'casual', employeeId: null, casualWorkerId: 'c1', groupName: 'Sale Booth', departmentName: null, roleNames: [] },
        { assigneeType: 'casual', employeeId: null, casualWorkerId: 'c2', groupName: 'Sale Booth ', departmentName: null, roleNames: [] },
      ],
      dutyBlocks: [],
      employees: new Map(),
      casuals: new Map([
        ['c1', { id: 'c1', fullName: 'Nok One', nickname: 'Nok' }],
        ['c2', { id: 'c2', fullName: 'Nok Two', nickname: 'nok' }],
      ]),
      ourAccounts: new Set(),
    });
    // Two different people worked the booth; the roster holds one "Nok" and
    // the unmatched list is empty, so the second is gone without a trace.
    expect(out.people.length + out.unmatched.length).toBe(2);
  });
});

let ctx: TestContext;
let db: Db;
let row: BoothStationRow;
let today: string;
let tenantId: string;
let appBranchId: string;
let weekPlanId: string;
let boothRowId: string;
const exec = (q: ReturnType<typeof sql>) => db.execute(q);

async function linkedPerson(nickname: string, phone: string) {
  const employeeId = newId();
  await db.insert(employee).values({ id: employeeId, operatorId: row.operatorId, name: nickname, nickname, phone, branchId: row.branchId });
  const accountId = newId();
  await db.insert(account).values({ id: accountId, operatorId: row.operatorId, employeeId, phone, passwordHash: await argonHash('x-pw-1'), status: 'active' });
  const userId = newId();
  await exec(sql`insert into otoapp.users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
    values (${userId}, ${`${nickname.toLowerCase()}@refute.test`}, 'x', ${nickname}, 'staff', true, false, ${accountId})`);
  const appEmployeeId = newId();
  await exec(sql`insert into otoapp.employees (id, tenant_id, full_name, nickname, email, user_id, branch_id)
    values (${appEmployeeId}, ${tenantId}, ${nickname}, ${nickname}, ${`${nickname.toLowerCase()}.e@refute.test`}, ${userId}, ${appBranchId})`);
  return { accountId, appEmployeeId };
}

async function shift(appEmployeeId: string): Promise<string> {
  const id = newId();
  await exec(sql`insert into otoapp.schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, employee_id)
    values (${id}, ${tenantId}, ${weekPlanId}, ${boothRowId}, ${today}, 'employee', ${appEmployeeId})`);
  return id;
}

const auditsFor = (action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), sql`coalesce(${auditLog.after}, ${auditLog.before})->>'stationId' = ${row.stationId}`));

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  db = ctx.db;
  const [b] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  row = await loadBoothStation(db, b!.operatorId, b!.id);
  today = await boothBusinessDate(db, row.branchId);
  tenantId = newId();
  await exec(sql`insert into otoapp.tenants (id, name, slug) values (${tenantId}, 'OTO', 'oto-refute')`);
  appBranchId = newId();
  await exec(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appBranchId}, ${tenantId}, 'Refute park', 'A mall', ${row.branchId})`);
  weekPlanId = newId();
  await exec(sql`insert into otoapp.schedule_week_plans (id, tenant_id, branch_id, week_start_date)
    values (${weekPlanId}, ${tenantId}, ${appBranchId}, ${today})`);
  const group = newId();
  await exec(sql`insert into otoapp.shift_groups (id, tenant_id, branch_id, name) values (${group}, ${tenantId}, ${appBranchId}, 'Sale Booth')`);
  boothRowId = newId();
  await exec(sql`insert into otoapp.schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time)
    values (${boothRowId}, ${tenantId}, ${appBranchId}, ${group}, ${weekPlanId}, '10:00', '19:00')`);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('idempotence and the log', () => {
  it('a re-run with nothing changed audits nothing new (the service header claims "no audit row")', async () => {
    const pim = await linkedPerson('Pim', '+66900000471');
    await shift(pim.appEmployeeId);
    await syncBoothDuty(db, {}, { row, actorAccountId: null });
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;
    const again = await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(again).toMatchObject({ added: 0, removed: 0 });
    const after = (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;
    expect(after).toBe(before);
  });

  it('two syncs racing after a shift is taken away write ONE unassign line', async () => {
    const dao = await linkedPerson('Dao', '+66900000472');
    const daoShift = await shift(dao.appEmployeeId);
    await syncBoothDuty(db, {}, { row, actorAccountId: null });
    await exec(sql`delete from otoapp.schedule_assignments where id = ${daoShift}`);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => syncBoothDuty(db, {}, { row, actorAccountId: null })),
    );
    const lines = (await auditsFor('booth_duty.unassign')).filter(
      (l) => (l.before as { accountId?: string } | null)?.accountId === dao.accountId,
    );
    const onRoster = await db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, row.stationId), eq(boothDutyAssignment.accountId, dao.accountId)));
    expect(onRoster).toHaveLength(0);
    expect(results.reduce((n, r) => n + r.removed, 0)).toBe(1);
    expect(lines).toHaveLength(1);
  });
});

describe('fix round: casuals sharing a nickname, and what a quiet re-run still logs', () => {
  it('two app casuals called Nok on the booth shift both land on the roster through a real sync', async () => {
    const dept = newId();
    const roleId = newId();
    await exec(sql`insert into otoapp.departments (id, tenant_id, name) values (${dept}, ${tenantId}, 'Refute sales')`);
    await exec(sql`insert into otoapp.roles (id, tenant_id, name) values (${roleId}, ${tenantId}, 'Refute casual')`);
    const casualIds: string[] = [];
    for (const [full, nick] of [['Nok One', 'Nok'], ['Nok Two', 'nok ']] as const) {
      const id = newId();
      casualIds.push(id);
      await exec(sql`insert into otoapp.casual_workers (id, tenant_id, full_name, nickname, branch_id, department_id, role_id, start_date, end_date, daily_rate)
        values (${id}, ${tenantId}, ${full}, ${nick}, ${appBranchId}, ${dept}, ${roleId}, ${today}, ${today}, 50000)`);
      await exec(sql`insert into otoapp.schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, casual_worker_id)
        values (${newId()}, ${tenantId}, ${weekPlanId}, ${boothRowId}, ${today}, 'casual', ${id})`);
    }
    const res = await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(res.added).toBe(2);
    const casualsOnRoster = await db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, row.stationId), sql`${boothDutyAssignment.casualWorkerId} is not null`));
    expect(casualsOnRoster.map((r) => r.casualWorkerId).sort()).toEqual([...casualIds].sort());
    expect(casualsOnRoster.every((r) => r.accountId === null)).toBe(true);
    // And a re-run keeps both, adding nothing.
    const again = await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(again).toMatchObject({ added: 0, removed: 0 });
  });

  it('a re-run where only the unmatched list changed still writes its sync line', async () => {
    const lines = async () => (await auditsFor('booth_duty.sync')).length;
    const before = await lines();
    // Somebody on the booth shift the app never gave a login: unmatched, no roster change.
    const appEmployeeId = newId();
    await exec(sql`insert into otoapp.employees (id, tenant_id, full_name, nickname, email, user_id, branch_id)
      values (${appEmployeeId}, ${tenantId}, 'Somchai', 'Chai', 'chai.refute@refute.test', null, ${appBranchId})`);
    await shift(appEmployeeId);
    const res = await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(res).toMatchObject({ added: 0, removed: 0 });
    expect(res.unmatched).toContainEqual({ name: 'Chai', reason: 'no_app_user' });
    expect(await lines()).toBe(before + 1);
    // Unchanged again: nothing new.
    await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(await lines()).toBe(before + 1);
  });
});

describe('the label once somebody is attributed today (decided: names only)', () => {
  it('a roster holding one self-assigned stand-in prints the name alone; the code was the slip before anyone was attributed today', () => {
    const accountId = newId();
    const before = boothStaffLabel('Nok', 'S-7KMQ');
    const afterPull = boothDutyLabel({
      roster: { date: '2026-10-01', people: [{ accountId, displayName: 'Nok' }] },
      today: '2026-10-01',
      signedIn: { accountId, name: 'Nok', label: before },
    });
    expect(before).toBe('Nok (S-7KMQ)');
    // The owner's format ruling: the merged day label is names only and
    // applies the moment the day's roster is non-empty — a stand-in
    // self-assigned at a booth with no rota included. The untouched-slip
    // guarantee is scoped to "before anyone is attributed today"; this is
    // after, so "Nok" replacing "Nok (S-7KMQ)" is the intended behaviour.
    expect(afterPull).toBe('Nok');
  });
});

describe('racing syncs, repeated (the re-check gate’s reproduction, kept)', () => {
  /**
   * Eight syncs of one booth's day at once, fifteen rounds. Before the
   * advisory lock and the `.returning()` guards, every racer that lost a drop
   * still counted a removal and wrote an unassign line — lines=8 removed=8 in
   * 15 of 15 rounds. Now exactly one sync does the work and writes the two
   * lines that answer for it (the unassign and its own sync line); the other
   * seven find nothing to do and write no line of any kind.
   */
  const syncLines = async () => (await auditsFor('booth_duty.sync')).length;

  it('after a drop: one removal, ONE unassign line and ONE sync line per round', async () => {
    const failures: string[] = [];
    for (let round = 0; round < 15; round += 1) {
      const p = await linkedPerson(`Race${round}`, `+669000019${String(round).padStart(2, '0')}`);
      const sid = await shift(p.appEmployeeId);
      await syncBoothDuty(db, {}, { row, actorAccountId: null });
      await exec(sql`delete from otoapp.schedule_assignments where id = ${sid}`);
      const syncBefore = await syncLines();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => syncBoothDuty(db, {}, { row, actorAccountId: null })),
      );
      const lines = (await auditsFor('booth_duty.unassign')).filter(
        (l) => (l.before as { accountId?: string } | null)?.accountId === p.accountId,
      );
      const removed = results.reduce((n, r) => n + r.removed, 0);
      const syncWritten = (await syncLines()) - syncBefore;
      const onRoster = await db
        .select({ id: boothDutyAssignment.id })
        .from(boothDutyAssignment)
        .where(and(eq(boothDutyAssignment.stationId, row.stationId), eq(boothDutyAssignment.accountId, p.accountId)));
      if (lines.length !== 1 || removed !== 1 || syncWritten !== 1 || onRoster.length !== 0) {
        failures.push(
          `round ${round}: unassign lines=${lines.length} removed=${removed} sync lines=${syncWritten} still on roster=${onRoster.length}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('after an add: one insert, ONE assign line and ONE sync line per round', async () => {
    const failures: string[] = [];
    for (let round = 0; round < 15; round += 1) {
      const p = await linkedPerson(`Add${round}`, `+669000029${String(round).padStart(2, '0')}`);
      await shift(p.appEmployeeId);
      const syncBefore = await syncLines();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => syncBoothDuty(db, {}, { row, actorAccountId: null })),
      );
      const lines = (await auditsFor('booth_duty.assign')).filter(
        (l) => (l.after as { accountId?: string } | null)?.accountId === p.accountId,
      );
      const added = results.reduce((n, r) => n + r.added, 0);
      const syncWritten = (await syncLines()) - syncBefore;
      if (lines.length !== 1 || added !== 1 || syncWritten !== 1) {
        failures.push(`round ${round}: assign lines=${lines.length} added=${added} sync lines=${syncWritten}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('after a rename in the app: one rename line per round, however many syncs race', async () => {
    const failures: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const p = await linkedPerson(`Ren${round}`, `+669000039${String(round).padStart(2, '0')}`);
      await shift(p.appEmployeeId);
      await syncBoothDuty(db, {}, { row, actorAccountId: null });
      await exec(sql`update otoapp.employees set nickname = ${`Ren${round}X`} where id = ${p.appEmployeeId}`);
      const syncBefore = await syncLines();
      await Promise.all(Array.from({ length: 8 }, () => syncBoothDuty(db, {}, { row, actorAccountId: null })));
      const lines = (await auditsFor('booth_duty.rename')).filter(
        (l) => (l.after as { accountId?: string } | null)?.accountId === p.accountId,
      );
      const syncWritten = (await syncLines()) - syncBefore;
      const [onRoster] = await db
        .select({ displayName: boothDutyAssignment.displayName })
        .from(boothDutyAssignment)
        .where(and(eq(boothDutyAssignment.stationId, row.stationId), eq(boothDutyAssignment.accountId, p.accountId)));
      if (lines.length !== 1 || syncWritten !== 1 || onRoster?.displayName !== `Ren${round}X`) {
        failures.push(`round ${round}: rename lines=${lines.length} sync lines=${syncWritten} name=${onRoster?.displayName}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('a casual whose app id is not a uuid', () => {
  it('syncs cleanly, is keyed by that id, and a re-run keeps it', async () => {
    const dept = newId();
    const roleId = newId();
    await exec(sql`insert into otoapp.departments (id, tenant_id, name) values (${dept}, ${tenantId}, 'Refute legacy')`);
    await exec(sql`insert into otoapp.roles (id, tenant_id, name) values (${roleId}, ${tenantId}, 'Refute legacy casual')`);
    // varchar-shaped, the way an app id may be: not a uuid.
    const casualId = 'cw-legacy-0007';
    await exec(sql`insert into otoapp.casual_workers (id, tenant_id, full_name, nickname, branch_id, department_id, role_id, start_date, end_date, daily_rate)
      values (${casualId}, ${tenantId}, 'Lek Legacy', 'Lek', ${appBranchId}, ${dept}, ${roleId}, ${today}, ${today}, 50000)`);
    await exec(sql`insert into otoapp.schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, casual_worker_id)
      values (${newId()}, ${tenantId}, ${weekPlanId}, ${boothRowId}, ${today}, 'casual', ${casualId})`);
    const res = await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(res.added).toBe(1);
    const rows = await db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, row.stationId), eq(boothDutyAssignment.casualWorkerId, casualId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ displayName: 'Lek', accountId: null, source: 'app_schedule' });
    const again = await syncBoothDuty(db, {}, { row, actorAccountId: null });
    expect(again).toMatchObject({ added: 0, removed: 0 });
    expect(again.roster.some((r) => r.displayName === 'Lek')).toBe(true);
  });
});
