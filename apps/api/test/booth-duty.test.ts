import { hash as argonHash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  account,
  auditLog,
  box,
  boothConfigVersion,
  boothDutyAssignment,
  boothDutySync,
  boothStaffAssignment,
  employee,
  role,
  roleAssignment,
  station,
  type Db,
} from '@oto/db';
import { newId } from '@oto/shared';
import { BoothCacheEntrySchema, boxCredential } from '@oto/box-agent';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import {
  BOOTH_DUTY_JOB,
  boothBusinessDate,
  matchBoothDuty,
  runMorningBoothDutySync,
  selfAssignBoothDuty,
  syncBoothDuty,
  type AppAssignmentRow,
  type AppCasualRow,
  type AppDutyBlockRow,
  type AppEmployeeRow,
} from '../src/services/booth-duty';
import { loadBoothStation } from '../src/services/booth';
import { BOOTH_HANDLERS, boothCacheItems } from '../src/services/sync-booth';
import { buildDefaultJobs } from '../src/services/jobs';
import { loadEnv } from '../src/env';
import { issueClaimCode } from '../src/services/box';

/**
 * SCRUM-473 — the day's booth staff, synced from the OTO App's rota and
 * merged (plan D4-D6).
 *
 * Two halves. The matcher over rows shaped exactly as the app's — the rule
 * the park's real data needs: the "Sale Booth" shift group, a duty block
 * called "Sales booth " with its trailing space, casual workers, and people
 * the platform cannot follow to an account. Then the whole path against a
 * database carrying the app's own tables: Sync now, a re-run that changes
 * nothing, the rota changing under it, manual add and remove, permissions,
 * the audit rows, the stand-in at sign-in and on a spin's arrival, the bundle
 * the box receives, and the morning job.
 */

// --- The matcher, no database ------------------------------------------------

describe('matchBoothDuty — over real-shaped rows', () => {
  const OURS = new Set(['acc-tom', 'acc-jerry']);
  const employees = new Map<string, AppEmployeeRow>([
    ['e-tom', { id: 'e-tom', fullName: 'Thomas Cat', nickname: 'Tom', userId: 'u-tom', platformUserId: 'acc-tom' }],
    ['e-jerry', { id: 'e-jerry', fullName: 'Jerry Mouse', nickname: 'Jerry ', userId: 'u-jerry', platformUserId: 'acc-jerry' }],
    ['e-nouser', { id: 'e-nouser', fullName: 'Somchai', nickname: 'Chai', userId: null, platformUserId: null }],
    ['e-nolink', { id: 'e-nolink', fullName: 'Malee', nickname: '', userId: 'u-malee', platformUserId: null }],
    ['e-foreign', { id: 'e-foreign', fullName: 'Stranger', nickname: 'Str', userId: 'u-str', platformUserId: 'acc-elsewhere' }],
    ['e-kitchen', { id: 'e-kitchen', fullName: 'Cook', nickname: 'Cook', userId: 'u-cook', platformUserId: 'acc-tom' }],
  ]);
  const casuals = new Map<string, AppCasualRow>([['c-nok', { id: 'c-nok', fullName: 'Nok Casual', nickname: 'Nok' }]]);
  const rule = { groupText: 'Sale Booth', dutyText: 'booth' };
  const shift = (over: Partial<AppAssignmentRow>): AppAssignmentRow => ({
    assigneeType: 'employee',
    employeeId: null,
    casualWorkerId: null,
    groupName: 'Sale Booth',
    departmentName: null,
    roleNames: [],
    ...over,
  });

  it('takes the Sale Booth group, casuals by name, and lists who cannot be matched', () => {
    const out = matchBoothDuty({
      rule,
      ourAccounts: OURS,
      employees,
      casuals,
      assignments: [
        shift({ employeeId: 'e-tom' }),
        shift({ assigneeType: 'casual', casualWorkerId: 'c-nok' }),
        shift({ employeeId: 'e-nouser' }),
        shift({ employeeId: 'e-nolink' }),
        shift({ employeeId: 'e-foreign' }),
        // Another group entirely: the kitchen is not the booth.
        shift({ employeeId: 'e-kitchen', groupName: 'Kitchen' }),
      ],
      dutyBlocks: [],
    });
    expect(out.people).toEqual([
      { accountId: 'acc-tom', casualWorkerId: null, displayName: 'Tom', source: 'app_schedule' },
      { accountId: null, casualWorkerId: 'c-nok', displayName: 'Nok', source: 'app_schedule' },
    ]);
    expect(out.unmatched).toEqual([
      { name: 'Chai', reason: 'no_app_user' },
      { name: 'Malee', reason: 'no_platform_account' },
      // An account id that is not this operator's is no link at all.
      { name: 'Str', reason: 'no_platform_account' },
    ]);
  });

  it('matches a duty block’s free text with trailing spaces and any case, once per person', () => {
    const out = matchBoothDuty({
      rule,
      ourAccounts: OURS,
      employees,
      casuals,
      assignments: [shift({ employeeId: 'e-tom' })],
      dutyBlocks: [
        { employeeId: 'e-jerry', dutyName: 'Sales booth   ', dutyTypeName: null },
        // Tom is already on by his shift; his duty block adds nothing.
        { employeeId: 'e-tom', dutyName: 'SALES BOOTH', dutyTypeName: null },
        // A block with no name of its own is matched by its type's.
        { employeeId: 'e-kitchen', dutyName: '  ', dutyTypeName: 'Cleaning' },
      ] satisfies AppDutyBlockRow[],
    });
    expect(out.people).toEqual([
      { accountId: 'acc-tom', casualWorkerId: null, displayName: 'Tom', source: 'app_schedule' },
      { accountId: 'acc-jerry', casualWorkerId: null, displayName: 'Jerry', source: 'app_duty_block' },
    ]);
  });

  it('matches a department or a role too, and an empty rule matches nothing', () => {
    const viaDept = matchBoothDuty({
      rule,
      ourAccounts: OURS,
      employees,
      casuals,
      assignments: [
        shift({ employeeId: 'e-tom', groupName: 'Floor', departmentName: ' sale booth ' }),
        shift({ employeeId: 'e-jerry', groupName: 'Floor', roleNames: ['Sale Booth Host'] }),
      ],
      dutyBlocks: [],
    });
    expect(viaDept.people.map((p) => p.displayName)).toEqual(['Tom', 'Jerry']);

    const off = matchBoothDuty({
      rule: { groupText: '  ', dutyText: '' },
      ourAccounts: OURS,
      employees,
      casuals,
      assignments: [shift({ employeeId: 'e-tom' })],
      dutyBlocks: [{ employeeId: 'e-jerry', dutyName: 'Sales booth', dutyTypeName: null }],
    });
    expect(off.people).toEqual([]);
  });
});

// --- The whole path, against the app's own tables ------------------------------

let ctx: TestContext;
let db: Db;
let adminCookie: string;
let receptionCookie: string;
let boothId: string;
let operatorId: string;
let branchId: string;
let appBranchId: string;
let tenantId: string;
let today: string;
let tomAccount: string;
let jerryAccount: string;
let receptionId: string;

const exec = (q: ReturnType<typeof sql>) => db.execute(q);

/** A platform account with an employee, and its OTO App user linked to it. */
async function person(nickname: string, phone: string, link: boolean): Promise<{ accountId: string; appEmployeeId: string }> {
  const employeeId = newId();
  await db.insert(employee).values({ id: employeeId, operatorId, name: `${nickname} (Test)`, nickname, phone, branchId });
  const accountId = newId();
  await db.insert(account).values({
    id: accountId,
    operatorId,
    employeeId,
    phone,
    passwordHash: await argonHash(`${nickname}-pw-1`),
    status: 'active',
  });
  const userId = newId();
  await exec(sql`insert into otoapp.users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
    values (${userId}, ${`${nickname.toLowerCase()}@otopark.test`}, 'x', ${nickname}, 'staff', true, false, ${link ? accountId : null})`);
  const appEmployeeId = newId();
  await exec(sql`insert into otoapp.employees (id, tenant_id, full_name, nickname, email, user_id, branch_id)
    values (${appEmployeeId}, ${tenantId}, ${`${nickname} Full`}, ${nickname}, ${`${nickname.toLowerCase()}.e@otopark.test`}, ${userId}, ${appBranchId})`);
  return { accountId, appEmployeeId };
}

let weekPlanId: string;
let boothRow: string;
let kitchenRow: string;

async function shift(rowId: string, who: { employeeId?: string; casualId?: string }, date = today): Promise<string> {
  const id = newId();
  await exec(sql`insert into otoapp.schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, employee_id, casual_worker_id)
    values (${id}, ${tenantId}, ${weekPlanId}, ${rowId}, ${date}, ${who.casualId ? 'casual' : 'employee'}, ${who.employeeId ?? null}, ${who.casualId ?? null})`);
  return id;
}

async function dutyBlock(employeeId: string, assignmentId: string, name: string): Promise<void> {
  await exec(sql`insert into otoapp.duty_blocks (id, tenant_id, branch_id, date, employee_id, assignment_id, duty_name, start_time, end_time)
    values (${newId()}, ${tenantId}, ${appBranchId}, ${today}, ${employeeId}, ${assignmentId}, ${name}, '10:00', '19:00')`);
}

const idem = () => ({ 'idempotency-key': newId() });

const syncNow = (cookie = adminCookie) =>
  ctx.app.inject({ method: 'POST', url: `/booths/${boothId}/duty/sync`, headers: { cookie, ...idem() } });

const roster = () =>
  db
    .select()
    .from(boothDutyAssignment)
    .where(and(eq(boothDutyAssignment.stationId, boothId), eq(boothDutyAssignment.businessDate, today)));

/** Every roster log line for the booth, whatever the action. */
const allDutyLines = async (): Promise<number> =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          sql`${auditLog.action} like 'booth_duty.%'`,
          sql`coalesce(${auditLog.after}, ${auditLog.before})->>'stationId' = ${boothId}`,
        ),
      )
  )[0]!.n;

const dutyAudits = (action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), sql`${auditLog.after}->>'stationId' = ${boothId}`));

let tom: { accountId: string; appEmployeeId: string };
let jerry: { accountId: string; appEmployeeId: string };
let chai: { accountId: string; appEmployeeId: string };
let tomShift: string;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  db = ctx.db;
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const [booth] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothId = booth!.id;
  operatorId = booth!.operatorId;
  branchId = booth!.branchId;
  today = await boothBusinessDate(db, branchId);

  const [reception] = await db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
  receptionId = reception!.id;

  // The app's side, as its own migrator and screens leave it.
  tenantId = newId();
  await exec(sql`insert into otoapp.tenants (id, name, slug) values (${tenantId}, 'OTO', 'oto')`);
  appBranchId = newId();
  await exec(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appBranchId}, ${tenantId}, 'Oto Play Park, Central Floresta ', 'A mall', ${branchId})`);
  weekPlanId = newId();
  await exec(sql`insert into otoapp.schedule_week_plans (id, tenant_id, branch_id, week_start_date)
    values (${weekPlanId}, ${tenantId}, ${appBranchId}, ${today})`);
  const boothGroup = newId();
  const kitchenGroup = newId();
  await exec(sql`insert into otoapp.shift_groups (id, tenant_id, branch_id, name) values
    (${boothGroup}, ${tenantId}, ${appBranchId}, 'Sale Booth'), (${kitchenGroup}, ${tenantId}, ${appBranchId}, 'Kitchen')`);
  boothRow = newId();
  kitchenRow = newId();
  await exec(sql`insert into otoapp.schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time) values
    (${boothRow}, ${tenantId}, ${appBranchId}, ${boothGroup}, ${weekPlanId}, '10:00', '19:00'),
    (${kitchenRow}, ${tenantId}, ${appBranchId}, ${kitchenGroup}, ${weekPlanId}, '10:00', '19:00')`);

  tom = await person('Tom', '+66900000401', true);
  jerry = await person('Jerry', '+66900000402', true);
  chai = await person('Chai', '+66900000403', false);
  tomAccount = tom.accountId;
  jerryAccount = jerry.accountId;

  // A casual worker: no user, no account, ever.
  const dept = newId();
  const roleId = newId();
  await exec(sql`insert into otoapp.departments (id, tenant_id, name) values (${dept}, ${tenantId}, 'Sales')`);
  await exec(sql`insert into otoapp.roles (id, tenant_id, name) values (${roleId}, ${tenantId}, 'Booth casual 473')`);
  const casualId = newId();
  await exec(sql`insert into otoapp.casual_workers (id, tenant_id, full_name, nickname, branch_id, department_id, role_id, start_date, end_date, daily_rate)
    values (${casualId}, ${tenantId}, 'Nok Casual', 'Nok', ${appBranchId}, ${dept}, ${roleId}, ${today}, ${today}, 50000)`);

  // Today: Tom on the booth's shift; Jerry on the kitchen's shift with a
  // "Sales booth " duty block; Nok the casual on the booth; Chai on the booth
  // with no linked account.
  tomShift = await shift(boothRow, { employeeId: tom.appEmployeeId });
  const jerryShift = await shift(kitchenRow, { employeeId: jerry.appEmployeeId });
  await dutyBlock(jerry.appEmployeeId, jerryShift, 'Sales booth ');
  await shift(boothRow, { casualId });
  await shift(boothRow, { employeeId: chai.appEmployeeId });
  // Tomorrow's shift is not today's roster.
  await shift(boothRow, { employeeId: chai.appEmployeeId }, '2099-01-01');
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('Sync now', () => {
  it('writes the day’s roster from the rota and names who it could not match', async () => {
    const res = await syncNow();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      appState: string;
      added: number;
      removed: number;
      unmatched: Array<{ name: string; reason: string }>;
      roster: Array<{ displayName: string; source: string; accountId: string | null }>;
    };
    expect(body.appState).toBe('ok');
    expect(body.added).toBe(3);
    expect(body.unmatched).toEqual([{ name: 'Chai', reason: 'no_platform_account' }]);
    expect(
      body.roster.map((r) => [r.displayName, r.source, r.accountId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['Jerry', 'app_duty_block', jerryAccount],
      ['Nok', 'app_schedule', null],
      ['Tom', 'app_schedule', tomAccount],
    ]);
    // One log line per new person, and one for the sync.
    expect(await dutyAudits('booth_duty.assign')).toHaveLength(3);
    expect(await dutyAudits('booth_duty.sync')).toHaveLength(1);
  });

  it('is idempotent: a re-run writes no roster row, no sync record and no log line at all', async () => {
    const before = await roster();
    const syncRowBefore = await db
      .select()
      .from(boothDutySync)
      .where(eq(boothDutySync.stationId, boothId));
    const allLinesBefore = await allDutyLines();
    const res = await syncNow();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ added: 0, removed: 0 });
    const after = await roster();
    expect(after.map((r) => [r.id, r.displayName, r.updatedAt.toISOString()]).sort()).toEqual(
      before.map((r) => [r.id, r.displayName, r.updatedAt.toISOString()]).sort(),
    );
    expect(await dutyAudits('booth_duty.assign')).toHaveLength(3);
    // The sync's own line and record are not rewritten by a run that changed nothing.
    expect(await dutyAudits('booth_duty.sync')).toHaveLength(1);
    expect(await allDutyLines()).toBe(allLinesBefore);
    const syncRowAfter = await db
      .select()
      .from(boothDutySync)
      .where(eq(boothDutySync.stationId, boothId));
    expect(syncRowAfter.map((r) => r.updatedAt.toISOString())).toEqual(
      syncRowBefore.map((r) => r.updatedAt.toISOString()),
    );
  });

  it('follows the rota: a shift taken away is unassigned and logged; people’s own rows stay', async () => {
    const add = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothId}/duty`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { displayName: 'Ploy' },
    });
    expect(add.statusCode, add.body).toBe(200);

    await exec(sql`delete from otoapp.schedule_assignments where id = ${tomShift}`);
    const res = await syncNow();
    expect(res.json()).toMatchObject({ added: 0, removed: 1 });
    const names = (await roster()).map((r) => r.displayName).sort();
    expect(names).toEqual(['Jerry', 'Nok', 'Ploy']);
    const [gone] = await dutyAudits('booth_duty.unassign').then(() =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'booth_duty.unassign'), sql`${auditLog.before}->>'displayName' = 'Tom'`)),
    );
    expect(gone).toBeDefined();

    // Put Tom back for what follows.
    tomShift = await shift(boothRow, { employeeId: tom.appEmployeeId });
    await syncNow();
  });

  it('records the sync for the day and shows it on the Console view with the label and log', async () => {
    const [record] = await db
      .select()
      .from(boothDutySync)
      .where(and(eq(boothDutySync.stationId, boothId), eq(boothDutySync.businessDate, today)));
    expect(record?.appState).toBe('ok');

    const view = await ctx.app.inject({ method: 'GET', url: `/booths/${boothId}/duty`, headers: { cookie: adminCookie } });
    expect(view.statusCode, view.body).toBe(200);
    const body = view.json() as { label: string; lastSync: { unmatched: unknown[] }; log: Array<{ action: string }>; rule: unknown };
    // In the order each joined: the rota's shifts, then its duty blocks, then
    // Ploy by hand, then Tom, whose shift came back last.
    expect(body.label).toBe('Nok, Jerry, Ploy and Tom');
    expect(body.lastSync.unmatched).toEqual([{ name: 'Chai', reason: 'no_platform_account' }]);
    expect(body.rule).toEqual({ groupText: 'Sale Booth', dutyText: 'booth' });
    expect(body.log.some((l) => l.action === 'booth_duty.assign')).toBe(true);
  });
});

describe('manual add and remove', () => {
  it('refuses a caller without admin:booth:staff_assign', async () => {
    for (const res of [
      await ctx.app.inject({ method: 'POST', url: `/booths/${boothId}/duty/sync`, headers: { cookie: receptionCookie, ...idem() } }),
      await ctx.app.inject({
        method: 'POST',
        url: `/booths/${boothId}/duty`,
        headers: { cookie: receptionCookie, ...idem() },
        payload: { displayName: 'Nobody' },
      }),
      await ctx.app.inject({
        method: 'PATCH',
        url: `/booths/${boothId}/duty/rule`,
        headers: { cookie: receptionCookie, ...idem() },
        payload: { dutyText: 'x' },
      }),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
  });

  it('adds an account of the branch, refuses one that is not, and removes with a log line', async () => {
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothId}/duty`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { accountId: receptionId },
    });
    expect(added.statusCode, added.body).toBe(200);
    const row = (added.json() as { roster: Array<{ id: string; accountId: string | null; source: string }> }).roster.find(
      (r) => r.accountId === receptionId,
    );
    expect(row?.source).toBe('manual');
    const [line] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booth_duty.assign'), eq(auditLog.entityId, row!.id)));
    expect(line?.after).toMatchObject({ source: 'manual', accountId: receptionId });

    const [otherOp] = await db
      .select({ id: account.id })
      .from(account)
      .where(sql`${account.operatorId} <> ${operatorId}`)
      .limit(1);
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothId}/duty`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { accountId: otherOp!.id },
    });
    expect(refused.statusCode, refused.body).toBe(400);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/booths/${boothId}/duty/${row!.id}`,
      headers: { cookie: adminCookie, ...idem() },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const [unassigned] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booth_duty.unassign'), eq(auditLog.entityId, row!.id)));
    expect(unassigned).toBeDefined();
  });

  it('changes the match rule, audited, without touching the published wheel', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/duty/rule`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { groupText: 'Kitchen' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ groupText: 'Kitchen', dutyText: 'booth' });
    const [line] = await db.select().from(auditLog).where(eq(auditLog.action, 'booth_duty.rule'));
    expect(line?.after).toEqual({ groupText: 'Kitchen', dutyText: 'booth' });
    // Back to the default for the rest of the file.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/duty/rule`,
      headers: { cookie: adminCookie, ...idem() },
      payload: { groupText: 'Sale Booth' },
    });
  });
});

describe('the stand-in (D5.2)', () => {
  let benchBooth: string;
  let boxAuth: Record<string, string>;

  beforeAll(async () => {
    const benchBox = newId();
    await db.insert(box).values({ id: benchBox, operatorId, branchId, name: 'Duty box', slot: 'duty-test', role: 'booth' });
    benchBooth = newId();
    await db.insert(station).values({ id: benchBooth, operatorId, branchId, boxId: benchBox, name: 'Duty Booth', kind: 'booth', codePrefix: 'DT' });
    const { code } = await issueClaimCode(db, benchBox);
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode: code, agentVersion: '0.1.0', hostname: 'duty-pi' },
    });
    const body = registered.json() as { boxId: string; secret: string };
    boxAuth = { authorization: `Bearer ${boxCredential(body.boxId, body.secret)}` };
    // Reception is on the standing list of the bench booth, and on nobody's roster.
    await db.insert(boothStaffAssignment).values({ id: newId(), stationId: benchBooth, accountId: receptionId, addedBy: receptionId });
  });

  const verify = (phone: string, password: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/box/v1/booth/staff/verify',
      headers: boxAuth,
      payload: { stationId: benchBooth, phone, password },
    });

  it('a standing-list sign-in not on today’s roster joins it as self_assigned, once', async () => {
    expect((await verify(RECEPTION.phone, RECEPTION.password)).statusCode).toBe(200);
    expect((await verify(RECEPTION.phone, RECEPTION.password)).statusCode).toBe(200);
    const rows = await db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, benchBooth), eq(boothDutyAssignment.accountId, receptionId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('self_assigned');
    const lines = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booth_duty.assign'), eq(auditLog.entityId, rows[0]!.id)));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.after).toMatchObject({ source: 'self_assigned', via: 'sign_in' });
  });

  it('somebody on today’s roster only may sign in — the union, not the standing list alone', async () => {
    // Tom: not on the bench booth's standing list. Without a roster row, refused.
    await db.insert(roleAssignment).values({
      id: newId(),
      accountId: tomAccount,
      roleId: (await db.select({ id: role.id }).from(role).where(eq(role.name, 'reception')).limit(1))[0]!.id,
      scopeType: 'branch',
      scopeId: branchId,
    });
    expect((await verify('+66900000401', 'Tom-pw-1')).statusCode).toBe(403);
    await db.transaction((tx) =>
      selfAssignBoothDuty(tx, {
        stationId: benchBooth,
        operatorId,
        branchId,
        businessDate: today,
        accountId: tomAccount,
        displayName: 'Tom',
        via: 'sign_in',
      }),
    );
    expect((await verify('+66900000401', 'Tom-pw-1')).statusCode).toBe(200);
  });

  it('a spin by somebody not on the roster adds them when it arrives — a PIN sign-in the box checked alone', async () => {
    // Jerry is on Booth 1's roster from the rota; the reception account is not.
    const [booth1] = await db.select().from(station).where(eq(station.id, boothId)).limit(1);
    const [version] = await db
      .select({ id: boothConfigVersion.id })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, boothId))
      .limit(1);
    const handler = BOOTH_HANDLERS['booth.spin_recorded']!;
    const spinFor = (staffAccountId: string, simulated = false) =>
      db.transaction((tx) =>
        handler.apply(
          tx as never,
          { auth: { operatorId, branchId, boxId: booth1!.boxId! } } as never,
          {
            envelope: { stationId: boothId, eventId: newId(), actionId: null, actorAccountId: staffAccountId },
            occurredAt: new Date(),
            businessDate: today,
            clockTrust: 'trusted',
          } as never,
          {
            spinId: newId(),
            boothConfigVersionId: version!.id,
            outcome: 'no_prize',
            prizeId: null,
            voucherId: null,
            staffAccountId,
            clockSuspect: false,
            simulated,
          } as never,
        ),
      );

    await spinFor(receptionId, true);
    const onRoster = () =>
      db
        .select()
        .from(boothDutyAssignment)
        .where(
          and(
            eq(boothDutyAssignment.stationId, boothId),
            eq(boothDutyAssignment.businessDate, today),
            eq(boothDutyAssignment.accountId, receptionId),
          ),
        );
    // A simulated spin proves nobody worked the booth.
    expect(await onRoster()).toHaveLength(0);

    await spinFor(receptionId);
    await spinFor(receptionId);
    const rows = await onRoster();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('self_assigned');

    // Somebody already on the roster is not added again.
    const before = (await roster()).length;
    await spinFor(jerryAccount);
    expect((await roster()).length).toBe(before);
  });

  it('a self-assign that is already on the roster writes nothing', async () => {
    const wrote = await db.transaction((tx) =>
      selfAssignBoothDuty(tx, {
        stationId: benchBooth,
        operatorId,
        branchId,
        businessDate: today,
        accountId: receptionId,
        via: 'spin',
      }),
    );
    expect(wrote).toBe(false);
  });
});

describe('the bundle the box receives', () => {
  it('ships today’s roster beside allowedStaff, and the box reads it', async () => {
    const [booth] = await db.select().from(station).where(eq(station.id, boothId)).limit(1);
    const items = await boothCacheItems(db, {
      boxId: booth!.boxId!,
      operatorId,
      branchId,
    } as Parameters<typeof boothCacheItems>[1]);
    const item = items.find((i) => i.stationId === boothId)!;
    expect(item.dutyRoster.date).toBe(today);
    // The rota's three, Ploy by hand, and the stand-in whose spin arrived above.
    expect(item.dutyRoster.people.map((p) => p.displayName)).toEqual(
      expect.arrayContaining(['Jerry', 'Nok', 'Ploy', 'Tom']),
    );
    expect(item.dutyRoster.people.some((p) => p.accountId === receptionId)).toBe(true);
    expect(item.dutyRoster.people.find((p) => p.displayName === 'Nok')!.accountId).toBeNull();

    // The agent's own schema, over what the cloud serves: the roundtrip.
    const parsed = BoothCacheEntrySchema.safeParse(JSON.parse(JSON.stringify(item)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.dutyRoster).toEqual(item.dutyRoster);
  });
});

describe('the morning job', () => {
  it('is registered with the job runner', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
    const jobs = buildDefaultJobs({ db, env, log: ctx.app.log, channels: [] });
    expect(jobs.map((j) => j.name)).toContain(BOOTH_DUTY_JOB);
  });

  it('syncs a booth once per trading day, at the open, and not while closed', async () => {
    const now = new Date();
    // Forget today's record for the seeded booth so the job has work.
    await db.delete(boothDutySync).where(eq(boothDutySync.stationId, boothId));

    const closed = await runMorningBoothDutySync(db, now, () => false);
    const [stillNone] = await db.select().from(boothDutySync).where(eq(boothDutySync.stationId, boothId));
    // The seeded branches carry opening hours, so "closed" holds them back.
    expect(stillNone).toBeUndefined();
    expect(closed.synced).toBe(0);

    const first = await runMorningBoothDutySync(db, now, () => true);
    expect(first.synced).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);
    const again = await runMorningBoothDutySync(db, now, () => true);
    expect(again.synced).toBe(0);
    const [record] = await db.select().from(boothDutySync).where(eq(boothDutySync.stationId, boothId));
    expect(record?.syncedByAccountId).toBeNull();
  });
});

describe('a platform with no OTO App', () => {
  it('answers app_not_installed and removes nothing', async () => {
    const plain = await createTestContext();
    try {
      const [b] = await plain.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
      const row = await loadBoothStation(plain.db, b!.operatorId, b!.id);
      const out = await syncBoothDuty(plain.db, {}, { row, actorAccountId: null });
      expect(out.appState).toBe('app_not_installed');
      expect(out.roster).toEqual([]);
    } finally {
      await plain.close();
    }
  });
});
