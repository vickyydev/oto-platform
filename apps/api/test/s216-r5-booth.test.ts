import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothPrize,
  dirtyDate,
  factBoothDaily,
  opsRun,
  spin,
  station,
  ticketPackage,
  voucher,
} from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  mintBoothCode,
  newId,
  parseDayStart,
  type BoothReport,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { ROLLUP_BOOTH_JOB, runBoothRollupJob } from '../src/services/analytics-booth';

/**
 * S2-15b (SCRUM-216) round 5 — the booth's day (plan
 * docs/progress/plans/analytics/PLAN.md §5, §7, §8 round 5).
 *
 * Spins and their vouchers are filed on the seeded Booth 1 over two trading
 * days — prizes with a cost and one "not costed yet", a press that won
 * nothing, staff signed in and nobody signed in, and a `#debug` simulated
 * press — and one of yesterday's vouchers is redeemed at the till today. The
 * booth rollup's fact must equal what was written, row by row; the redemption
 * must land on the day the voucher was spun; a simulated spin must change
 * nothing; a replayed run must write nothing. Then the report route, its CSV
 * (guarded against formula injection), its branch scope, and Health's line.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let operatorId: string;
let branchId: string;
let chalong: string;
let boothId: string;
let boxId: string;
let versionId: string;
let tillId: string;
let staffA: string;
let staffB: string;
let T: string;
let Y: string;
type Prize = typeof boothPrize.$inferSelect;
let p100: Prize;
let p150: Prize;
let bracelet: Prize;

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [booth] = await ctx.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothId = booth!.id;
  boxId = booth!.boxId!;
  branchId = booth!.branchId;
  operatorId = booth!.operatorId;
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [version] = await ctx.db
    .select()
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, boothId))
    .orderBy(desc(boothConfigVersion.version))
    .limit(1);
  versionId = version!.id;
  const prizes = await ctx.db.select().from(boothPrize).where(eq(boothPrize.stationId, boothId));
  p100 = prizes.find((p) => p.nameEn === '100 THB Voucher')!;
  p150 = prizes.find((p) => p.nameEn === '150 THB Voucher')!;
  bracelet = prizes.find((p) => p.nameEn === 'Free Bracelet Workshop')!;
  expect([p100.costSatang, p150.costSatang, bracelet.costSatang]).toEqual([10_000, 15_000, 0]);
  const [a] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  const [b] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  staffA = a!.id;
  staffB = b!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  await takeStation(ctx.app, reception, tillId);
  // The booth's branch's clock.
  const { rows } = await ctx.db.execute<{ timezone: string; business_day_start: string }>(
    sql`select timezone, business_day_start::text from core.branch where id = ${branchId}::uuid`,
  );
  T = businessDate(new Date(), rows[0]!.timezone, parseDayStart(rows[0]!.business_day_start));
  Y = addDaysToIsoDate(T, -1);
  await runBoothRollupJob(ctx.db, new Date());
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

interface Filed {
  date: string;
  staff: string | null;
  prize: Prize | null;
  voucherId: string | null;
  code: string | null;
  issuedAt: Date;
}

const filed: Filed[] = [];

/** A press of Booth 1, filed as the sync path files one: the voucher first, then the spin naming it. */
async function press(date: string, staff: string | null, prize: Prize | null, opts: { simulated?: boolean } = {}): Promise<Filed> {
  const issuedAt = new Date(`${date}T14:00:00+07:00`);
  let voucherId: string | null = null;
  let code: string | null = null;
  if (prize) {
    voucherId = newId();
    code = mintBoothCode('B1', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({
      id: voucherId,
      operatorId,
      branchId,
      voucherDefinitionId: prize.voucherDefinitionId!,
      code,
      source: 'booth',
      status: 'issued',
      costSatang: prize.costSatang,
      issuedByAccountId: staff,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 14 * 86_400_000),
    });
  }
  await ctx.db.insert(spin).values({
    id: newId(),
    operatorId,
    branchId,
    stationId: boothId,
    boxId,
    boothConfigVersionId: versionId,
    outcome: prize ? 'prize' : 'no_prize',
    prizeId: prize?.id ?? null,
    voucherId,
    staffAccountId: staff,
    simulated: opts.simulated ?? false,
    occurredAt: issuedAt,
    businessDate: date,
  });
  const row = { date, staff, prize, voucherId, code, issuedAt };
  if (!opts.simulated) filed.push(row);
  return row;
}

async function factRows() {
  return ctx.db
    .select()
    .from(factBoothDaily)
    .where(eq(factBoothDaily.branchId, branchId))
    .orderBy(factBoothDaily.businessDate, factBoothDaily.id);
}

const keyOf = (date: string, staff: string | null, prize: string | null) => `${date}|${staff ?? '-'}|${prize ?? '-'}`;

/** The fact as it must be: the pressed spins, summed by hand per day, staff member and prize. */
async function expectedFact() {
  const out = new Map<string, { spins: number; issued: number; redeemed: number; lag: number; cost: number }>();
  const vouchers = new Map((await ctx.db.select().from(voucher)).map((v) => [v.id, v]));
  for (const f of filed) {
    const key = keyOf(f.date, f.staff, f.prize?.id ?? null);
    const row = out.get(key) ?? { spins: 0, issued: 0, redeemed: 0, lag: 0, cost: 0 };
    row.spins += 1;
    if (f.voucherId) {
      const v = vouchers.get(f.voucherId)!;
      row.issued += 1;
      row.cost += v.costSatang;
      if (v.status === 'redeemed' && v.redeemedAt) {
        row.redeemed += 1;
        row.lag += Math.round((v.redeemedAt.getTime() - v.issuedAt.getTime()) / 1000);
      }
    }
    out.set(key, row);
  }
  return out;
}

async function storedFact() {
  return new Map(
    (await factRows()).map((r) => [
      keyOf(r.businessDate, r.staffAccountId, r.prizeId),
      { spins: r.spins, issued: r.vouchersIssued, redeemed: r.vouchersRedeemed, lag: r.redemptionLagSumS, cost: r.prizeCostSatang },
    ]),
  );
}

async function boothMarks(): Promise<string[]> {
  const rows = await ctx.db
    .select({ date: dirtyDate.businessDate })
    .from(dirtyDate)
    .where(and(eq(dirtyDate.kind, 'booth'), eq(dirtyDate.branchId, branchId)))
    .orderBy(dirtyDate.businessDate);
  return rows.map((r) => r.date);
}

describe('S2-15b round 5 — the booth fact', () => {
  it('equals the spins and vouchers written, by day, staff member and prize, and marks each day at commit', async () => {
    expect(await boothMarks()).toEqual([]);
    for (let i = 0; i < 3; i += 1) await press(T, staffA, p150);
    await press(T, staffA, null);
    await press(T, null, bracelet);
    await press(T, null, bracelet);
    await press(T, staffB, p100);
    await press(Y, staffA, p100);
    await press(Y, staffA, p100);
    expect(await boothMarks()).toEqual([Y, T]);

    const run = await runBoothRollupJob(ctx.db, new Date());
    expect(run.rowsWritten).toBe(5);
    expect(await boothMarks()).toEqual([]);
    const expected = await expectedFact();
    expect(await storedFact()).toEqual(expected);
    expect(expected.get(keyOf(T, staffA, p150.id))).toEqual({ spins: 3, issued: 3, redeemed: 0, lag: 0, cost: 45_000 });
    expect(expected.get(keyOf(T, staffA, null))).toEqual({ spins: 1, issued: 0, redeemed: 0, lag: 0, cost: 0 });
    expect(expected.get(keyOf(T, null, bracelet.id))).toEqual({ spins: 2, issued: 2, redeemed: 0, lag: 0, cost: 0 });
  });

  it('H12 — a simulated spin marks nothing and changes nothing', async () => {
    const before = await factRows();
    await press(T, staffA, p150, { simulated: true });
    await press(T, null, null, { simulated: true });
    expect(await boothMarks()).toEqual([]);
    const run = await runBoothRollupJob(ctx.db, new Date());
    expect(run.rowsWritten).toBe(0);
    expect(await factRows()).toEqual(before);
  });

  it('a voucher redeemed today counts on the day it was spun, with its lag', async () => {
    const won = filed.find((f) => f.date === Y)!;
    const G = newId();
    const held = await ctx.app.inject({ method: 'POST', url: `/sales/${G}/vouchers`, headers: { cookie: reception }, payload: { code: won.code } });
    expect(held.statusCode, held.body).toBe(200);
    const rung = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        id: G,
        stationId: tillId,
        lines: [{ id: newId(), packageId: await packageId('2 Hours Play'), kids: 1, adults: 1 }],
        promoCodes: [won.code],
      },
    });
    expect(rung.statusCode, rung.body).toBe(200);
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${G}/finalise`,
      headers: { cookie: reception },
      payload: { actionId: newId(), method: 'cash' },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(await boothMarks()).toEqual([Y]);

    const run = await runBoothRollupJob(ctx.db, new Date());
    expect(run.rowsWritten).toBe(1);
    const expected = await expectedFact();
    expect(await storedFact()).toEqual(expected);
    const yesterday = expected.get(keyOf(Y, staffA, p100.id))!;
    expect(yesterday.redeemed).toBe(1);
    expect(yesterday.lag).toBeGreaterThan(0);
  });

  it('a replayed run writes and removes nothing', async () => {
    const before = await factRows();
    const run = await runBoothRollupJob(ctx.db, new Date());
    expect([run.rowsWritten, run.rowsRemoved]).toEqual([0, 0]);
    expect(await factRows()).toEqual(before);
  });
});

async function packageId(name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ticketPackage.id })
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, name)));
  return row!.id;
}

describe('S2-15b round 5 — the booth report', () => {
  const get = (cookie: string | null, path: string, query: string) =>
    ctx.app.inject({ method: 'GET', url: `/analytics/${path}?${query}`, ...(cookie ? { headers: { cookie } } : {}) });

  it('per booth, prize, staff member and day, from the fact', async () => {
    const res = await get(manager, 'booths', `from=${Y}&to=${T}`);
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json() as BoothReport;
    const fact = await factRows();
    const sum = (pick: (r: (typeof fact)[number]) => number) => fact.reduce((s, r) => s + pick(r), 0);
    const issued = sum((r) => r.vouchersIssued);
    const redeemed = sum((r) => r.vouchersRedeemed);
    expect(report.booths).toEqual([
      {
        boothId,
        name: 'Booth 1',
        branchId,
        branchName: report.branches[0]!.name,
        spins: sum((r) => r.spins),
        prizesWon: sum((r) => (r.prizeId ? r.spins : 0)),
        vouchersIssued: issued,
        vouchersRedeemed: redeemed,
        redemptionRate: redeemed / issued,
        meanRedemptionLagS: Math.round(sum((r) => r.redemptionLagSumS) / redeemed),
        prizeCostSatang: sum((r) => r.prizeCostSatang),
        // The bracelet workshop was won and is not costed yet.
        prizeCostIncomplete: true,
      },
    ]);
    expect(report.booths[0]).toMatchObject({ spins: 9, prizesWon: 8, vouchersIssued: 8, vouchersRedeemed: 1, prizeCostSatang: 75_000 });
    expect(report.prizes.map((p) => [p.name, p.prizesWon, p.prizeCostSatang, p.prizeCostIncomplete])).toEqual([
      ['100 THB Voucher', 3, 30_000, false],
      ['150 THB Voucher', 3, 45_000, false],
      ['Free Bracelet Workshop', 2, 0, true],
    ]);
    expect(report.staff.map((s) => [s.accountId, s.spins, s.prizesWon])).toEqual([
      [staffA, 6, 5],
      [null, 2, 2],
      [staffB, 1, 1],
    ]);
    expect(report.staff.find((s) => s.accountId === null)!.name).toBe('Unattributed');
    expect(report.days.map((d) => [d.businessDate, d.spins, d.vouchersRedeemed])).toEqual([
      [Y, 2, 1],
      [T, 7, 0],
    ]);
    // Today only: yesterday's redemption is not in it.
    const today = (await get(manager, 'booths', `from=${T}&to=${T}`)).json() as BoothReport;
    expect(today.booths[0]).toMatchObject({ spins: 7, vouchersRedeemed: 0, redemptionRate: 0, meanRedemptionLagS: null });
  });

  it('downloads as a CSV, one row per day, booth, staff member and prize, every cell guarded', async () => {
    await ctx.db.update(boothPrize).set({ nameEn: '=HYPERLINK("x")' }).where(eq(boothPrize.id, bracelet.id));
    const res = await get(manager, 'booths/export', `from=${Y}&to=${T}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="booth-report_${Y}_${T}.csv"`);
    const lines = res.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe(
      '"Trading day","Branch","Booth","Staff","Prize","Spins","Prizes won","Vouchers issued","Vouchers redeemed","Redemption rate (%)","Mean redemption lag (minutes)","Prize cost (THB)"',
    );
    expect(lines).toHaveLength(1 + (await factRows()).length);
    expect(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`))).toBe(true);
    expect(lines.some((l) => l.includes('"=HYPERLINK'))).toBe(false);
    expect(lines.find((l) => l.includes('"Unattributed"') && l.startsWith(`"${T}"`))).toContain('"2","2","2","0","0.0","","0.00"');
    await ctx.db.update(boothPrize).set({ nameEn: bracelet.nameEn }).where(eq(boothPrize.id, bracelet.id));
  });

  it('is read per branch on analytics:read', async () => {
    const both = await get(manager, 'booths', `branches=${branchId},${chalong}&from=${T}&to=${T}`);
    expect(both.json()).toMatchObject({ branches: [{ branchId }], omitted: [chalong] });
    expect((await get(manager, 'booths', `branches=${chalong}&from=${T}&to=${T}`)).statusCode).toBe(403);
    expect((await get(reception, 'booths', `from=${T}&to=${T}`)).statusCode).toBe(403);
    expect((await get(reception, 'booths/export', `from=${T}&to=${T}`)).statusCode).toBe(403);
    expect((await get(null, 'booths', `from=${T}&to=${T}`)).statusCode).toBe(401);
    expect((await get(admin, 'booths', `branches=${newId()}&from=${T}&to=${T}`)).statusCode).toBe(404);
    const chalongOnly = (await get(admin, 'booths', `branches=${chalong}&from=${Y}&to=${T}`)).json() as BoothReport;
    expect(chalongOnly.booths).toEqual([]);
  });

  it('Health says when the booth figures were last brought up to date, and so does the report', async () => {
    const before = (await get(manager, 'booths', `from=${T}&to=${T}`)).json() as BoothReport;
    expect(before.lastRolledUpAt).toBeNull();
    const ran = await ctx.app.inject({ method: 'POST', url: '/ops/test-controls/rollup.run', headers: { cookie: admin } });
    expect(ran.statusCode, ran.body).toBe(200);
    expect((ran.json() as { message: string }).message).toContain(`booth ok`);
    const health = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: admin } });
    const rollups = health.json<{ rollups: Array<{ branchId: string; boothLastRolledUpAt: string | null }> }>().rollups;
    const line = rollups.find((r) => r.branchId === branchId)!;
    expect(line.boothLastRolledUpAt).not.toBeNull();
    const after = (await get(manager, 'booths', `from=${T}&to=${T}`)).json() as BoothReport;
    expect(after.lastRolledUpAt).toBe(line.boothLastRolledUpAt);
    const [run] = await ctx.db.select().from(opsRun).where(eq(opsRun.name, ROLLUP_BOOTH_JOB)).orderBy(desc(opsRun.startedAt)).limit(1);
    expect(run).toMatchObject({ outcome: 'ok' });
    expect(line.boothLastRolledUpAt).toBe(run!.startedAt.toISOString());
  });
});
