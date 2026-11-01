import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { account, auditLog, branch, employee, nanny, nannyShift, nannySync, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_BRANCH_CODE,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import {
  NANNY_DUTY_JOB,
  addManualNanny,
  matchNannyDuty,
  nannyDutyView,
  runMorningNannyDutySync,
  syncNannyDuty,
  type AppNannyAssignmentRow,
  type AppNannyCasualRow,
  type AppNannyEmployeeRow,
} from '../src/services/nanny-duty';
import { nannyRosterOf } from '../src/services/checkin';
import { buildDefaultJobs } from '../src/services/jobs';
import { loadEnv } from '../src/env';

/**
 * SCRUM-699 — the park's nannies and their shifts from the OTO App's rota,
 * with a Console fallback.
 *
 * The matcher first, over rows shaped as the app's (no database). Then the
 * whole path against a database carrying the app's own tables: a sync writes
 * the nanny and her shift, a re-run writes nothing, the rota changing under
 * it (D3: a shift that has not started goes, one in progress is cut short,
 * the past stays, a manual shift is never touched), the routes and their
 * permissions, the demo seed unchanged for the till, and the morning job.
 */

// --- The matcher, no database ------------------------------------------------

describe('matchNannyDuty — over real-shaped rows', () => {
  const t = (hhmm: string) => new Date(`2030-06-03T${hhmm}:00+07:00`);
  const employees = new Map<string, AppNannyEmployeeRow>([
    ['e-fah', { id: 'e-fah', fullName: 'Fah Full', nickname: 'Fah ' }],
    ['e-mai', { id: 'e-mai', fullName: 'Mai Full', nickname: '' }],
    ['e-som', { id: 'e-som', fullName: 'Som Full', nickname: 'Som' }],
    ['e-ning', { id: 'e-ning', fullName: 'Ning Full', nickname: 'Ning' }],
    ['e-cook', { id: 'e-cook', fullName: 'Cook', nickname: 'Cook' }],
    ['e-blank', { id: 'e-blank', fullName: '  ', nickname: ' ' }],
  ]);
  const casuals = new Map<string, AppNannyCasualRow>([['c-nok', { id: 'c-nok', fullName: 'Nok Casual', nickname: 'Nok' }]]);
  let n = 0;
  const shift = (over: Partial<AppNannyAssignmentRow>): AppNannyAssignmentRow => ({
    id: `a-${++n}`,
    assigneeType: 'employee',
    employeeId: null,
    casualWorkerId: null,
    groupName: 'Floor',
    departmentName: null,
    roleNames: [],
    startsAt: t('10:00'),
    endsAt: t('19:00'),
    ...over,
  });

  it('matches a role, a group, a department and the Thai word, and skips the kitchen', () => {
    const out = matchNannyDuty({
      matchText: 'Nanny',
      employees,
      casuals,
      assignments: [
        shift({ employeeId: 'e-fah', roleNames: ['Nanny'] }),
        shift({ employeeId: 'e-mai', groupName: 'Nanny Team' }),
        shift({ employeeId: 'e-som', departmentName: '  nanny  ' }),
        // The Thai word on the assignment's own role (read last in roleNames).
        shift({ employeeId: 'e-ning', roleNames: ['Floor staff', 'พี่เลี้ยง'] }),
        shift({ employeeId: 'e-cook', groupName: 'Kitchen' }),
      ],
    });
    expect(out.people.map((p) => [p.appEmployeeId, p.displayName])).toEqual([
      ['e-fah', 'Fah'],
      // A blank nickname reads the full name.
      ['e-mai', 'Mai Full'],
      ['e-som', 'Som'],
      ['e-ning', 'Ning'],
    ]);
    expect(out.unmatched).toEqual([]);
  });

  it('makes a split shift one person with two shifts, in time order', () => {
    const out = matchNannyDuty({
      matchText: 'Nanny',
      employees,
      casuals,
      assignments: [
        shift({ id: 'late', employeeId: 'e-fah', groupName: 'Nanny', startsAt: t('15:00'), endsAt: t('19:00') }),
        shift({ id: 'early', employeeId: 'e-fah', groupName: 'Nanny', startsAt: t('10:00'), endsAt: t('13:00') }),
      ],
    });
    expect(out.people).toHaveLength(1);
    expect(out.people[0]!.shifts.map((s) => s.appAssignmentId)).toEqual(['early', 'late']);
  });

  it('lists who cannot be made a nanny, once each: no employee row, no name, a casual', () => {
    const out = matchNannyDuty({
      matchText: 'Nanny',
      employees,
      casuals,
      assignments: [
        shift({ employeeId: 'e-ghost', groupName: 'Nanny' }),
        shift({ employeeId: 'e-ghost', groupName: 'Nanny' }),
        shift({ employeeId: 'e-blank', groupName: 'Nanny' }),
        shift({ assigneeType: 'casual', casualWorkerId: 'c-nok', groupName: 'Nanny' }),
        shift({ assigneeType: 'casual', casualWorkerId: 'c-nok', groupName: 'Nanny' }),
      ],
    });
    expect(out.people).toEqual([]);
    expect(out.unmatched).toEqual([
      { name: null, reason: 'no_employee_row' },
      { name: null, reason: 'no_name' },
      { name: 'Nok', reason: 'casual_worker' },
    ]);
  });

  it('an empty match text turns off the English term only: the Thai word still matches', () => {
    const out = matchNannyDuty({
      matchText: '  ',
      employees,
      casuals,
      assignments: [
        shift({ employeeId: 'e-fah', groupName: 'Nanny' }),
        shift({ employeeId: 'e-ning', groupName: 'ทีม พี่เลี้ยง' }),
      ],
    });
    expect(out.people.map((p) => p.displayName)).toEqual(['Ning']);
  });
});

// --- The whole path, against the app's own tables ------------------------------

let ctx: TestContext;
let db: Db;
let adminCookie: string;
let receptionCookie: string;
let operatorId: string;
let branchId: string;
let chalongId: string;
let foreignBranchId: string;
let tenantId: string;
let appBranchId: string;
let weekPlanId: string;
let nannyRow: string;
let fahAppId: string;
let fahEmployeeId: string;

const exec = (q: ReturnType<typeof sql>) => db.execute(q);
const idem = () => ({ 'idempotency-key': newId() });

/** The fixed trading day the sync cases run on, and a moment on its Bangkok clock. */
const D = '2030-06-03';
const at = (hhmm: string) => new Date(`${D}T${hhmm}:00+07:00`);

async function assign(employeeId: string | null, opts: { casualId?: string; date?: string } = {}): Promise<string> {
  const id = newId();
  await exec(sql`insert into otoapp.schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, employee_id, casual_worker_id)
    values (${id}, ${tenantId}, ${weekPlanId}, ${nannyRow}, ${opts.date ?? D}, ${opts.casualId ? 'casual' : 'employee'}, ${employeeId}, ${opts.casualId ?? null})`);
  return id;
}

const sync = (now: Date, branch = branchId) =>
  syncNannyDuty(db, {}, { operatorId, branchId: branch, date: D, actorAccountId: null, now });

const dayShifts = () =>
  db
    .select()
    .from(nannyShift)
    .where(and(eq(nannyShift.branchId, branchId), eq(nannyShift.businessDate, D)));

const dayLines = async (action?: string) =>
  db
    .select()
    .from(auditLog)
    .where(
      and(
        sql`${auditLog.action} like 'nanny_duty.%'`,
        action ? eq(auditLog.action, action) : sql`true`,
        eq(auditLog.branchId, branchId),
        sql`coalesce(${auditLog.after}, ${auditLog.before})->>'businessDate' = ${D}`,
      ),
    );

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  db = ctx.db;
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const [hkt] = await db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [chalong] = await db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
  chalongId = chalong!.id;
  const [foreign] = await db.select().from(branch).where(eq(branch.code, SECOND_OPERATOR_BRANCH_CODE));
  foreignBranchId = foreign!.id;

  // The app's side, as its own migrator and screens leave it: the park mapped
  // to Central, a week plan, a "Nanny" shift group with a 10:00-19:00 row.
  tenantId = newId();
  await exec(sql`insert into otoapp.tenants (id, name, slug) values (${tenantId}, 'OTO', 'oto')`);
  appBranchId = newId();
  await exec(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appBranchId}, ${tenantId}, 'Oto Play Park, Central Floresta', 'A mall', ${branchId})`);
  weekPlanId = newId();
  await exec(sql`insert into otoapp.schedule_week_plans (id, tenant_id, branch_id, week_start_date)
    values (${weekPlanId}, ${tenantId}, ${appBranchId}, ${D})`);
  const nannyGroup = newId();
  await exec(sql`insert into otoapp.shift_groups (id, tenant_id, branch_id, name) values (${nannyGroup}, ${tenantId}, ${appBranchId}, 'Nanny')`);
  nannyRow = newId();
  await exec(sql`insert into otoapp.schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time)
    values (${nannyRow}, ${tenantId}, ${appBranchId}, ${nannyGroup}, ${weekPlanId}, '10:00', '19:00')`);

  // Fah, an employee with no login, and the platform's copy of her.
  fahAppId = newId();
  await exec(sql`insert into otoapp.employees (id, tenant_id, full_name, nickname, email, branch_id)
    values (${fahAppId}, ${tenantId}, 'Fah Full', 'Fah', 'fah.699@otopark.test', ${appBranchId})`);
  fahEmployeeId = newId();
  await db.insert(employee).values({
    id: fahEmployeeId,
    operatorId,
    name: 'Fah Full',
    nickname: 'Fah',
    branchId,
    source: 'otoapp',
    externalId: fahAppId,
  });

  // A casual on the nanny row: listed, never made a nanny (D1 says an employee).
  const dept = newId();
  const roleId = newId();
  await exec(sql`insert into otoapp.departments (id, tenant_id, name) values (${dept}, ${tenantId}, 'Care')`);
  await exec(sql`insert into otoapp.roles (id, tenant_id, name) values (${roleId}, ${tenantId}, 'Casual 699')`);
  const casualId = newId();
  await exec(sql`insert into otoapp.casual_workers (id, tenant_id, full_name, nickname, branch_id, department_id, role_id, start_date, end_date, daily_rate)
    values (${casualId}, ${tenantId}, 'Nok Casual', 'Nok', ${appBranchId}, ${dept}, ${roleId}, ${D}, ${D}, 50000)`);
  await assign(null, { casualId });
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the sync', () => {
  let fahShift: string;
  let fahNanny: string;

  it('writes the nanny and her shift from the rota, and names who it could not match', async () => {
    fahShift = await assign(fahAppId);
    const out = await sync(at('08:00'));
    expect(out).toMatchObject({ businessDate: D, appState: 'ok', added: 1, removed: 0, renamed: 0, reshifted: 0 });
    expect(out.unmatched).toEqual([{ name: 'Nok', reason: 'casual_worker' }]);

    const nannies = await db
      .select()
      .from(nanny)
      .where(and(eq(nanny.branchId, branchId), eq(nanny.appEmployeeId, fahAppId)));
    expect(nannies).toHaveLength(1);
    expect(nannies[0]).toMatchObject({ name: 'Fah', source: 'app_schedule', employeeId: fahEmployeeId, archivedAt: null });
    fahNanny = nannies[0]!.id;

    const shifts = await dayShifts();
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({ source: 'app_schedule', businessDate: D, appAssignmentId: fahShift, nannyId: fahNanny });
    // 10:00 Bangkok is 03:00Z.
    expect(shifts[0]!.startsAt.toISOString()).toBe('2030-06-03T03:00:00.000Z');
    expect(shifts[0]!.endsAt.toISOString()).toBe('2030-06-03T12:00:00.000Z');

    const assigned = await dayLines('nanny_duty.assign');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.after).toMatchObject({ name: 'Fah', source: 'app_schedule', nannyCreated: true, nannyId: fahNanny });
    // Names and platform ids only: no app id anywhere in the line.
    expect(JSON.stringify(assigned[0]!.after)).not.toContain(fahAppId);
    expect(JSON.stringify(assigned[0]!.after)).not.toContain(fahShift);
    expect(await dayLines('nanny_duty.sync')).toHaveLength(1);
  });

  it('is idempotent: a re-run writes no shift, no sync record and no log line', async () => {
    const linesBefore = (await dayLines()).length;
    const [syncBefore] = await db
      .select()
      .from(nannySync)
      .where(and(eq(nannySync.branchId, branchId), eq(nannySync.businessDate, D)));
    const shiftsBefore = await dayShifts();

    const out = await sync(at('08:01'));
    expect(out).toMatchObject({ added: 0, removed: 0, renamed: 0, reshifted: 0 });
    expect((await dayLines()).length).toBe(linesBefore);
    const [syncAfter] = await db
      .select()
      .from(nannySync)
      .where(and(eq(nannySync.branchId, branchId), eq(nannySync.businessDate, D)));
    expect(syncAfter!.syncedAt.toISOString()).toBe(syncBefore!.syncedAt.toISOString());
    expect(syncAfter!.updatedAt.toISOString()).toBe(syncBefore!.updatedAt.toISOString());
    expect((await dayShifts()).map((s) => s.updatedAt.toISOString())).toEqual(
      shiftsBefore.map((s) => s.updatedAt.toISOString()),
    );
  });

  it('follows a change of hours on a shift that has not started', async () => {
    await exec(sql`update otoapp.schedule_shift_rows set start_time = '11:00' where id = ${nannyRow}`);
    const moved = await sync(at('08:02'));
    expect(moved.reshifted).toBe(1);
    expect((await dayShifts())[0]!.startsAt.toISOString()).toBe('2030-06-03T04:00:00.000Z');
    await exec(sql`update otoapp.schedule_shift_rows set start_time = '10:00' where id = ${nannyRow}`);
    expect((await sync(at('08:03'))).reshifted).toBe(1);
    expect(await dayLines('nanny_duty.reshift')).toHaveLength(2);
  });

  it('D3: a dropped shift that has not started goes; the manual shift and the nanny stay', async () => {
    const manual = await addManualNanny(
      db,
      {},
      { accountId: await adminAccountId(), operatorId },
      branchId,
      { name: ' fah ', from: '12:00', to: '14:00', date: D },
      { now: at('08:10') },
    );
    // The same person by name, whatever put her there.
    expect(manual.nannyId).toBe(fahNanny);
    expect(manual.shiftId).not.toBeNull();

    await exec(sql`delete from otoapp.schedule_assignments where id = ${fahShift}`);
    const out = await sync(at('08:30'));
    expect(out).toMatchObject({ added: 0, removed: 1 });
    const left = await dayShifts();
    expect(left.map((s) => [s.source, s.id])).toEqual([['manual', manual.shiftId]]);
    const [stillThere] = await db.select().from(nanny).where(eq(nanny.id, fahNanny));
    expect(stillThere!.archivedAt).toBeNull();
    const [gone] = (await dayLines('nanny_duty.unassign')).filter((l) => l.entityId !== manual.shiftId);
    expect(gone!.before).toMatchObject({ name: 'Fah', source: 'app_schedule' });

    // The same manual shift again changes nothing.
    const again = await addManualNanny(
      db,
      {},
      { accountId: await adminAccountId(), operatorId },
      branchId,
      { name: 'Fah', from: '12:00', to: '14:00', date: D },
      { now: at('08:31') },
    );
    expect(again.shiftId).toBeNull();
  });

  it('D3: a dropped shift in progress is cut short at the sync; an ended one stays', async () => {
    const id = await assign(fahAppId);
    expect((await sync(at('08:40'))).added).toBe(1);
    await exec(sql`delete from otoapp.schedule_assignments where id = ${id}`);
    const out = await sync(at('11:00'));
    expect(out.removed).toBe(1);
    const [cut] = (await dayShifts()).filter((s) => s.appAssignmentId === id);
    expect(cut!.startsAt.toISOString()).toBe('2030-06-03T03:00:00.000Z');
    expect(cut!.endsAt.toISOString()).toBe(at('11:00').toISOString());
    const line = (await dayLines('nanny_duty.unassign')).find((l) => l.entityId === cut!.id);
    expect(line!.after).toMatchObject({ cutShort: true, endsAt: at('11:00').toISOString() });

    // A shift that already ended is written as a record of the rota, and
    // stays when the rota drops it.
    const late = await assign(fahAppId);
    expect((await sync(at('20:00'))).added).toBe(1);
    await exec(sql`delete from otoapp.schedule_assignments where id = ${late}`);
    expect((await sync(at('20:30'))).removed).toBe(0);
    expect((await dayShifts()).some((s) => s.appAssignmentId === late)).toBe(true);
  });

  it('follows a name the app changes, on the app’s own row', async () => {
    await assign(fahAppId);
    await sync(at('08:50'));
    await exec(sql`update otoapp.employees set nickname = 'Fahsai' where id = ${fahAppId}`);
    const out = await sync(at('08:51'));
    expect(out.renamed).toBe(1);
    const [row] = await db.select().from(nanny).where(eq(nanny.id, fahNanny));
    expect(row!.name).toBe('Fahsai');
    const [line] = await dayLines('nanny_duty.rename');
    expect(line!.before).toMatchObject({ name: 'Fah' });
    expect(line!.after).toMatchObject({ name: 'Fahsai' });
  });

  it('removes nothing when the rota cannot be read', async () => {
    const appNanny = newId();
    await db.insert(nanny).values({
      id: appNanny,
      operatorId,
      branchId: chalongId,
      name: 'Kept',
      source: 'app_schedule',
      appEmployeeId: 'app-emp-kept',
    });
    const kept = newId();
    await db.insert(nannyShift).values({
      id: kept,
      operatorId,
      nannyId: appNanny,
      branchId: chalongId,
      startsAt: at('12:00'),
      endsAt: at('13:00'),
      source: 'app_schedule',
      businessDate: D,
      appAssignmentId: 'app-assign-kept',
    });
    // Chalong has no branch in the app.
    const out = await sync(at('08:00'), chalongId);
    expect(out).toMatchObject({ appState: 'no_app_branch', removed: 0 });
    expect(await db.select().from(nannyShift).where(eq(nannyShift.id, kept))).toHaveLength(1);
  });

  it('the Console view says what the till says, with the day’s shifts and log', async () => {
    const view = await nannyDutyView(db, { operatorId, branchId, date: D, now: at('12:30') });
    const fah = view.nannies.find((n) => n.id === fahNanny)!;
    expect(fah).toMatchObject({ name: 'Fahsai', source: 'app_schedule', employeeId: fahEmployeeId, onShift: true });
    expect(view.nannies[0]!.onShift).toBe(true);
    expect(fah.shifts.map((s) => s.source)).toContain('manual');
    expect(view.timezone).toBe('Asia/Bangkok');
    expect(view.rule).toEqual({ matchText: 'Nanny', alsoMatches: ['พี่เลี้ยง'] });
    expect(view.lastSync?.appState).toBe('ok');
    expect(view.lastSync?.unmatched).toEqual([{ name: 'Nok', reason: 'casual_worker' }]);
    expect(view.log.length).toBeGreaterThan(0);
    // The till's own read at the same instant.
    const till = await nannyRosterOf(db, branchId, at('12:30'));
    for (const n of view.nannies) {
      expect(till.find((t) => t.id === n.id)?.onShift).toBe(n.onShift);
    }
  });
});

async function adminAccountId(): Promise<string> {
  const [row] = await db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone)).limit(1);
  return row!.id;
}

// --- The routes ---------------------------------------------------------------

const bkkTime = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const bkkDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

describe('the routes', () => {
  let noonShift: string;

  it('reception adds a nanny for today by hand, and the till shows her on shift', async () => {
    const now = Date.now();
    const start = new Date(now - 30 * 60_000);
    const payload = { name: 'Noon', from: bkkTime(start), to: bkkTime(new Date(now + 60 * 60_000)), date: bkkDate(start) };
    const key = idem();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/nannies/manual`,
      headers: { cookie: receptionCookie, ...key },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { nannies: Array<{ name: string; source: string; onShift: boolean; shifts: Array<{ id: string; source: string }> }> };
    const noon = view.nannies.find((n) => n.name === 'Noon')!;
    expect(noon).toMatchObject({ source: 'manual', onShift: true });
    noonShift = noon.shifts[0]!.id;

    // A retry with the same key replays the view itself, and writes no second shift.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/nannies/manual`,
      headers: { cookie: receptionCookie, ...key },
      payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(res.json());
    const [noonRow] = await db.select().from(nanny).where(and(eq(nanny.branchId, branchId), eq(nanny.name, 'Noon')));
    expect(await db.select().from(nannyShift).where(eq(nannyShift.nannyId, noonRow!.id))).toHaveLength(1);

    const config = await ctx.app.inject({
      method: 'GET',
      url: `/checkin/config?branchId=${branchId}`,
      headers: { cookie: receptionCookie },
    });
    expect(config.statusCode, config.body).toBe(200);
    const nannies = (config.json() as { nannies: Array<{ name: string; onShift: boolean }> }).nannies;
    expect(nannies.find((n) => n.name === 'Noon')?.onShift).toBe(true);

    const [line] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'nanny_duty.assign'), eq(auditLog.entityId, noonShift)));
    expect(line!.after).toMatchObject({ name: 'Noon', source: 'manual', nannyCreated: true });
  });

  it('reception reads the day and presses Sync now', async () => {
    const today = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/nannies/today`,
      headers: { cookie: receptionCookie },
    });
    expect(today.statusCode, today.body).toBe(200);
    const synced = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/nannies/sync`,
      headers: { cookie: receptionCookie, ...idem() },
    });
    expect(synced.statusCode, synced.body).toBe(200);
    const body = synced.json() as { sync: { appState: string; businessDate: string }; view: { businessDate: string } };
    expect(body.sync.appState).toBe('ok');
    expect(body.view.businessDate).toBe(body.sync.businessDate);
  });

  it('takes a shift off: one in progress is cut short, a finished one stays', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchId}/nannies/shifts/${noonShift}`,
      headers: { cookie: receptionCookie, ...idem() },
    });
    expect(res.statusCode, res.body).toBe(200);
    const noon = (res.json() as { nannies: Array<{ name: string; onShift: boolean }> }).nannies.find((n) => n.name === 'Noon');
    expect(noon?.onShift).toBe(false);
    const [line] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'nanny_duty.unassign'), eq(auditLog.entityId, noonShift)));
    expect(line!.after).toMatchObject({ cutShort: true });

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchId}/nannies/shifts/${noonShift}`,
      headers: { cookie: receptionCookie, ...idem() },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('NANNY_SHIFT_ENDED');
  });

  it('the match text is a manager’s: reception is refused, the administrator changes it, audited', async () => {
    const refused = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/nannies/rule`,
      headers: { cookie: receptionCookie, ...idem() },
      payload: { matchText: 'Care' },
    });
    expect(refused.statusCode, refused.body).toBe(403);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/nannies/rule`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { matchText: '  Care  ' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { rule: { matchText: string } }).rule.matchText).toBe('Care');
    const [line] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'nanny_duty.rule'), eq(auditLog.branchId, branchId)));
    expect(line).toMatchObject({ entityType: 'supervision_policy', before: { matchText: 'Nanny' }, after: { matchText: 'Care' } });

    // Back to the default for what follows.
    const back = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/nannies/rule`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { matchText: 'Nanny' },
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  it('refuses another operator’s branch', async () => {
    for (const res of [
      await ctx.app.inject({
        method: 'GET',
        url: `/branches/${foreignBranchId}/nannies/today`,
        headers: { cookie: adminCookie },
      }),
      await ctx.app.inject({
        method: 'POST',
        url: `/branches/${foreignBranchId}/nannies/manual`,
        headers: { cookie: adminCookie, ...idem() },
        payload: { name: 'Stranger', from: '10:00', to: '23:59' },
      }),
    ]) {
      expect([403, 404], res.body).toContain(res.statusCode);
    }
    expect(await db.select().from(nanny).where(eq(nanny.branchId, foreignBranchId)).then((r) => r.filter((n) => n.name === 'Stranger'))).toEqual([]);
  });
});

// --- The demo seed, unchanged for the till -------------------------------------

describe('the demo seed', () => {
  it('marks Pim, Jum, Bow and Aor as the seed’s, and the till reads them as before', async () => {
    const seedNames = ['Pim', 'Jum', 'Bow', 'Aor'];
    const rows = await db
      .select()
      .from(nanny)
      .where(and(eq(nanny.branchId, branchId), inArray(nanny.name, seedNames)));
    expect(rows.map((r) => r.source).sort()).toEqual(['seed', 'seed', 'seed', 'seed']);
    const shifts = await db
      .select({ source: nannyShift.source })
      .from(nannyShift)
      .where(inArray(nannyShift.nannyId, rows.map((r) => r.id)));
    expect(shifts.length).toBeGreaterThan(0);
    expect(new Set(shifts.map((s) => s.source))).toEqual(new Set(['seed']));

    // 13:00 Bangkok on the seed's own day sits inside its 10:00-20:00 shifts.
    const today = new Date();
    const instant = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 6));
    const roster = await nannyRosterOf(db, branchId, instant);
    expect(
      Object.fromEntries(roster.filter((n) => seedNames.includes(n.name)).map((n) => [n.name, n.onShift])),
    ).toEqual({ Pim: true, Jum: true, Bow: true, Aor: false });
  });
});

// --- The morning job ------------------------------------------------------------

describe('the morning job', () => {
  it('is registered with the job runner', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
    const jobs = buildDefaultJobs({ db, env, log: ctx.app.log, channels: [] });
    expect(jobs.map((j) => j.name)).toContain(NANNY_DUTY_JOB);
  });

  it('syncs a branch once per trading day, at the open, and not while closed', async () => {
    const now = new Date();
    await db.delete(nannySync).where(eq(nannySync.branchId, branchId));
    await db.delete(nannySync).where(sql`${nannySync.businessDate} <> ${D}`);

    const closed = await runMorningNannyDutySync(db, now, () => false);
    expect(closed.failed).toBe(0);
    // Central carries opening hours, so "closed" holds it back.
    const stillNone = await db.select().from(nannySync).where(eq(nannySync.branchId, branchId));
    expect(stillNone).toEqual([]);

    const first = await runMorningNannyDutySync(db, now, () => true);
    expect(first.synced).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);
    const [record] = await db.select().from(nannySync).where(eq(nannySync.branchId, branchId));
    expect(record?.syncedByAccountId).toBeNull();
    expect(record?.appState).toBe('ok');

    const again = await runMorningNannyDutySync(db, now, () => true);
    expect(again.synced).toBe(0);
    expect(again.notDue).toBe(again.branches);
  });
});
