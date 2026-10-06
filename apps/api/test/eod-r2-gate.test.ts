import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@oto/db';
import { addDaysToIsoDate, businessDate, newId, type EndOfDayRecord } from '@oto/shared';
import {
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  OTO_OPERATOR_NAME,
  type TestContext,
} from './helpers';

/**
 * Gate reproductions for S2-15a round 2: the provisional close, the override
 * and the receipt, attacked from the box states and request shapes the
 * round's own suite does not build.
 */

const TZ = 'Asia/Bangkok';
const D = businessDate(new Date(), TZ, 5 * 60);
const day = (n: number) => addDaysToIsoDate(D, -n);

let ctx: TestContext;
let operatorId: string;
let central: string;
let chalong: string;
let till1: { id: string; boxId: string; codePrefix: string };
let otherCentralStation: string;
let chalongStation: string;
let receptionCookie: string;
let managerCookie: string;

const getDay = async (date: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/branches/${central}/end-of-day?date=${date}`, headers: { cookie: receptionCookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EndOfDayRecord;
};

const close = (cookie: string, payload: Record<string, unknown>, key: string = newId()) =>
  ctx.app.inject({
    method: 'POST',
    url: `/branches/${central}/end-of-day/close`,
    headers: { cookie, 'idempotency-key': key },
    payload: { actuals: [], countedSatang: null, floatLeftSatang: null, ...payload },
  });

async function outboxRow(boxId: string, state: 'queued' | 'sending' | 'failed' | 'quarantined'): Promise<string> {
  const eventId = newId();
  await ctx.db.insert(schema.boxOutbox).values({
    eventId,
    boxId,
    journalEpoch: 1,
    boxSeq: Math.floor(Math.random() * 1e9),
    type: 'sale.finalised',
    occurredAt: new Date(Date.now() - 10 * 60_000),
    payload: {},
    payloadHash: 'b'.repeat(64),
    sig: 'x',
    state,
    createdAt: new Date(Date.now() - 10 * 60_000),
  });
  return eventId;
}

beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [t1] = await ctx.db
    .select()
    .from(schema.station)
    .where(and(eq(schema.station.branchId, central), eq(schema.station.codePrefix, 'T1')))
    .limit(1);
  till1 = { id: t1!.id, boxId: t1!.boxId!, codePrefix: t1!.codePrefix! };
  const centralStations = await ctx.db.select().from(schema.station).where(eq(schema.station.branchId, central));
  otherCentralStation = centralStations.find((row) => row.id !== till1.id && row.kind === 'till')!.id;
  const [t3] = await ctx.db.select().from(schema.station).where(eq(schema.station.branchId, chalong)).limit(1);
  chalongStation = t3!.id;
  // The virtual box the counter sells through, registered as the running agent registers it.
  await ctx.db.update(schema.box).set({ registeredAt: new Date(), status: 'online' }).where(eq(schema.box.id, till1.boxId));
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  await takeStation(ctx.app, receptionCookie, till1.id);
  await takeStation(ctx.app, managerCookie, till1.id);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('eod-r2-gate provisional: box states that must hold the day', () => {
  it('a virtual box holding a sale the platform refused and the box will retry (outbox state failed) keeps the day provisional', async () => {
    // The box's own depth counts queued, sending AND failed (store-sql.ts depth()):
    // a failed row is a fact not on the platform's ledger, waiting for its retry.
    const eventId = await outboxRow(till1.boxId, 'failed');
    try {
      const rec = await getDay(day(1));
      expect(rec.provisional, 'a failed outbox row is undelivered').toEqual([
        expect.objectContaining({ boxId: till1.boxId, reason: 'outbox', waiting: 1 }),
      ]);
      const res = await close(receptionCookie, { date: day(1) });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('DAY_PROVISIONAL');
    } finally {
      await ctx.db.delete(schema.boxOutbox).where(eq(schema.boxOutbox.eventId, eventId));
    }
  });

  it("a box of another branch with records waiting does not hold this branch's day", async () => {
    const otherBox = newId();
    await ctx.db.insert(schema.box).values({
      id: otherBox,
      operatorId,
      branchId: chalong,
      name: 'Chalong Pi',
      slot: 'gate-chalong-pi',
      role: 'counter',
      status: 'online',
      registeredAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 7, oldestUnackedAgeS: 60, clockOffsetMs: 30 * 60_000, clockMeasuredBy: 'platform' },
    });
    const rec = await getDay(day(1));
    expect(rec.provisional).toEqual([]);
    await ctx.db.update(schema.box).set({ archivedAt: new Date() }).where(eq(schema.box.id, otherBox));
  });

  it('a Pi the watchdog marked offline still holds the day with the depth it last reported', async () => {
    const pi = newId();
    await ctx.db.insert(schema.box).values({
      id: pi,
      operatorId,
      branchId: central,
      name: 'Dark Pi',
      slot: 'gate-dark-pi',
      role: 'counter',
      status: 'offline',
      registeredAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() - 3_600_000),
      lastStatus: { receivedAt: new Date(Date.now() - 3_600_000).toISOString(), outboxDepth: 2, oldestUnackedAgeS: 30 },
    });
    const rec = await getDay(day(1));
    expect(rec.provisional).toEqual([expect.objectContaining({ boxId: pi, reason: 'outbox', waiting: 2 })]);
    await ctx.db.update(schema.box).set({ archivedAt: new Date() }).where(eq(schema.box.id, pi));
    expect((await getDay(day(1))).provisional).toEqual([]);
  });

  it('a clock out by two minutes on an agent too old to say who measured it is low trust', async () => {
    const pi = newId();
    await ctx.db.insert(schema.box).values({
      id: pi,
      operatorId,
      branchId: central,
      name: 'Old Pi',
      slot: 'gate-old-pi',
      role: 'counter',
      status: 'online',
      registeredAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 0, clockOffsetMs: -2 * 60_000 },
    });
    const rec = await getDay(day(1));
    expect(rec.provisional).toEqual([expect.objectContaining({ boxId: pi, reason: 'clock' })]);
    expect(rec.provisional![0]!.message).toContain('behind');
    await ctx.db.update(schema.box).set({ archivedAt: new Date() }).where(eq(schema.box.id, pi));
  });

  it('a disabled box holding undelivered records still holds the day', async () => {
    const pi = newId();
    await ctx.db.insert(schema.box).values({
      id: pi,
      operatorId,
      branchId: central,
      name: 'Disabled Pi',
      slot: 'gate-disabled-pi',
      role: 'counter',
      status: 'disabled',
      registeredAt: new Date(),
      lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 4, oldestUnackedAgeS: 30 },
    });
    expect((await getDay(day(1))).provisional).toEqual([
      expect.objectContaining({ boxId: pi, reason: 'outbox', waiting: 4 }),
    ]);
    await ctx.db.update(schema.box).set({ archivedAt: new Date() }).where(eq(schema.box.id, pi));
  });
});

describe('eod-r2-gate close: counter, override and receipt request shapes', () => {
  it("a counter of another branch is refused, and nothing is written", async () => {
    const res = await close(managerCookie, { date: day(2), stationId: chalongStation });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('STATION_NOT_FOUND');
    expect(await ctx.db.select().from(schema.endOfDay).where(eq(schema.endOfDay.businessDate, day(2)))).toHaveLength(0);
  });

  it('a whitespace override reason is refused by the schema', async () => {
    const res = await close(managerCookie, { date: day(2), override: { reason: '   ' } });
    expect(res.statusCode).toBe(400);
  });

  it('an override reason with nobody inside records no override and no override audit', async () => {
    const res = await close(managerCookie, { date: day(2), stationId: till1.id, override: { reason: 'just in case' } });
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.override).toBeNull();
    expect(
      await ctx.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'end_of_day.override'), eq(schema.auditLog.entityId, rec.id))),
    ).toHaveLength(0);
    expect(rec.receipt).toMatchObject({ number: `${till1.codePrefix}-EOD-000001`, stationId: till1.id });
  });

  it('a second close with a new key prints nothing and takes no number', async () => {
    const res = await close(managerCookie, { date: day(2), stationId: till1.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DAY_CLOSED');
    const [row] = await ctx.db.select().from(schema.endOfDay).where(eq(schema.endOfDay.businessDate, day(2)));
    expect(await ctx.db.select().from(schema.printJob).where(eq(schema.printJob.subjectId, row!.id))).toHaveLength(1);
    const [series] = await ctx.db
      .select()
      .from(schema.receiptSeries)
      .where(and(eq(schema.receiptSeries.stationId, till1.id), eq(schema.receiptSeries.kind, 'end_of_day')));
    expect(series!.nextSeq).toBe(2);
  });

  it('two closes racing with different keys lock one day, one number, one print', async () => {
    const [a, b] = await Promise.all([
      close(managerCookie, { date: day(3), stationId: till1.id }),
      close(receptionCookie, { date: day(3), stationId: till1.id }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const rows = await ctx.db.select().from(schema.endOfDay).where(eq(schema.endOfDay.businessDate, day(3)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receiptNumber).toBe(`${till1.codePrefix}-EOD-000002`);
    expect(await ctx.db.select().from(schema.printJob).where(eq(schema.printJob.subjectId, rows[0]!.id))).toHaveLength(1);
  });

  it('a close defaults to the counter this session took and queues its receipt', async () => {
    const res = await close(receptionCookie, { date: day(4) });
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.receipt).toMatchObject({ stationId: till1.id });
    expect(rec.receipt!.number).toMatch(/^T1-EOD-/);
  });
});

// --- Who closes: any holder of pos:cash:day_close, at a counter or not (PLAN.md §2) ---

describe('eod-r2-gate close away from a printing counter: the day closes, the receipt waits', () => {
  const reprint = (cookie: string, payload: Record<string, unknown>, key: string = newId()) =>
    ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/reprint`,
      headers: { cookie, 'idempotency-key': key },
      payload,
    });
  const eodSeries = async () => {
    const [series] = await ctx.db
      .select()
      .from(schema.receiptSeries)
      .where(and(eq(schema.receiptSeries.stationId, till1.id), eq(schema.receiptSeries.kind, 'end_of_day')));
    return series?.nextSeq ?? 1;
  };
  const jobsOf = async (id: string) => ctx.db.select().from(schema.printJob).where(eq(schema.printJob.subjectId, id));
  let pending: EndOfDayRecord;

  it('a session with no counter closes the day: 200, no number, nothing printed, the receipt waits', async () => {
    const unseated = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const before = await eodSeries();
    const res = await close(unseated, { date: day(5) });
    expect(res.statusCode, res.body).toBe(200);
    pending = res.json() as EndOfDayRecord;
    expect(pending.status).toBe('closed');
    expect(pending.receipt).toMatchObject({ number: null, stationId: null, jobs: [], note: 'Receipt not printed — reprint it from a counter' });
    expect(await jobsOf(pending.id)).toHaveLength(0);
    expect(await eodSeries()).toBe(before);
    const audit = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'end_of_day.close'), eq(schema.auditLog.entityId, pending.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ receiptNumber: null, receiptStationId: null, receiptPrintJobId: null });
    // Reloading the closed day says the same.
    expect((await getDay(day(5))).receipt).toMatchObject({ number: null, note: 'Receipt not printed — reprint it from a counter' });
  });

  it('a counter of another branch is refused for the reprint, and nothing is numbered', async () => {
    const before = await eodSeries();
    const res = await reprint(managerCookie, { date: day(5), stationId: chalongStation });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('STATION_NOT_FOUND');
    const [row] = await ctx.db.select().from(schema.endOfDay).where(and(eq(schema.endOfDay.branchId, central), eq(schema.endOfDay.businessDate, day(5))));
    expect(row!.receiptNumber).toBeNull();
    expect(await eodSeries()).toBe(before);
  });

  it('a session with no counter still cannot print the waiting receipt', async () => {
    const unseated = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await reprint(unseated, { date: day(5) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NO_COUNTER');
  });

  it("the reprint from a counter with a box numbers the waiting receipt on that counter's series and prints it once", async () => {
    const before = await eodSeries();
    const key = newId();
    const res = await reprint(receptionCookie, { date: day(5), stationId: till1.id }, key);
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    const number = `${till1.codePrefix}-EOD-${String(before).padStart(6, '0')}`;
    expect(rec.receipt).toMatchObject({ number, stationId: till1.id, note: null });
    expect(rec.receipt!.jobs).toHaveLength(1);
    expect(rec.receipt!.jobs[0]!.reprint).toBe(false);
    const jobs = await jobsOf(pending.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ stationId: till1.id, boxId: till1.boxId, kind: 'receipt', subjectType: 'end_of_day', reprintOf: null });
    expect(await eodSeries()).toBe(before + 1);
    // The figures stay as they were locked; only the receipt was written.
    expect({ ...rec, receipt: undefined }).toEqual({ ...pending, receipt: undefined });
    const numbered = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'end_of_day.receipt'), eq(schema.auditLog.entityId, pending.id)));
    expect(numbered).toHaveLength(1);
    expect(numbered[0]!.after).toMatchObject({ receiptNumber: number, receiptStationId: till1.id, receiptPrintJobId: jobs[0]!.id });

    // A replay of the same press prints nothing more and takes no number.
    const replay = await reprint(receptionCookie, { date: day(5), stationId: till1.id }, key);
    expect(replay.statusCode).toBe(200);
    expect(await jobsOf(pending.id)).toHaveLength(1);
    expect(await eodSeries()).toBe(before + 1);

    // The next reprint is a copy of that first print, on the same number.
    const copy = await reprint(receptionCookie, { date: day(5), stationId: till1.id });
    expect(copy.statusCode, copy.body).toBe(200);
    const after = copy.json() as EndOfDayRecord;
    expect(after.receipt!.number).toBe(number);
    expect(after.receipt!.jobs.map((j) => j.reprint)).toEqual([false, true]);
    expect(await eodSeries()).toBe(before + 1);
  });

  it('naming a counter of the branch this session did not take closes the day without printing on it', async () => {
    const res = await close(managerCookie, { date: day(6), stationId: otherCentralStation });
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.receipt).toMatchObject({ number: null, stationId: null, jobs: [] });
    expect(await jobsOf(rec.id)).toHaveLength(0);
  });

  it('a counter with no box closes the day and its receipt waits', async () => {
    const boxless = newId();
    await ctx.db.insert(schema.station).values({ id: boxless, operatorId, branchId: central, name: 'Boxless till', kind: 'till', codePrefix: 'BX' });
    const seated = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    await takeStation(ctx.app, seated, boxless);
    const res = await close(seated, { date: day(7), stationId: boxless });
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.receipt).toMatchObject({ number: null, stationId: null, note: 'Receipt not printed — reprint it from a counter' });
    // That counter cannot print it either; the refusal says why.
    const again = await reprint(seated, { date: day(7), stationId: boxless });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('STATION_HAS_NO_BOX');
    await ctx.db.update(schema.station).set({ archivedAt: new Date() }).where(eq(schema.station.id, boxless));
  });

  it('the closed day takes its receipt once and nothing else: the figures stay frozen', async () => {
    const [row] = await ctx.db.select().from(schema.endOfDay).where(and(eq(schema.endOfDay.branchId, central), eq(schema.endOfDay.businessDate, day(5))));
    await expect(
      ctx.db.update(schema.endOfDay).set({ receiptNumber: 'X-EOD-999999', receiptStationId: till1.id }).where(eq(schema.endOfDay.id, row!.id)),
    ).rejects.toThrow();
    const [waiting] = await ctx.db.select().from(schema.endOfDay).where(and(eq(schema.endOfDay.branchId, central), eq(schema.endOfDay.businessDate, day(6))));
    await expect(
      ctx.db
        .update(schema.endOfDay)
        .set({ receiptNumber: 'X-EOD-999999', receiptStationId: till1.id, notes: 'rewritten' })
        .where(eq(schema.endOfDay.id, waiting!.id)),
    ).rejects.toThrow();
  });
});

// --- Review (lane D): replays and races around the waiting receipt ---

describe('eod-r2-gate review: a waiting receipt is numbered and printed exactly once', () => {
  const reprint = (cookie: string, payload: Record<string, unknown>, key: string = newId()) =>
    ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/reprint`,
      headers: { cookie, 'idempotency-key': key },
      payload,
    });
  const eodSeries = async () => {
    const [series] = await ctx.db
      .select()
      .from(schema.receiptSeries)
      .where(and(eq(schema.receiptSeries.stationId, till1.id), eq(schema.receiptSeries.kind, 'end_of_day')));
    return series?.nextSeq ?? 1;
  };
  const jobsOf = async (id: string) => ctx.db.select().from(schema.printJob).where(eq(schema.printJob.subjectId, id));
  const auditsOf = async (action: string, id: string) =>
    ctx.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.entityId, id)));

  it('a replayed counterless close answers the same, writes one day, prints nothing; racing first prints take one number', async () => {
    const unseated = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const key = newId();
    const before = await eodSeries();
    const first = await close(unseated, { date: day(8) }, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await close(unseated, { date: day(8) }, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const closed = first.json() as EndOfDayRecord;
    expect(await ctx.db.select().from(schema.endOfDay).where(and(eq(schema.endOfDay.branchId, central), eq(schema.endOfDay.businessDate, day(8))))).toHaveLength(1);
    expect(await jobsOf(closed.id)).toHaveLength(0);
    expect(await auditsOf('end_of_day.close', closed.id)).toHaveLength(1);
    expect(await eodSeries()).toBe(before);

    // Two first prints pressed at once from the same counter: one number, one original, one copy.
    const [a, b] = await Promise.all([
      reprint(receptionCookie, { date: day(8), stationId: till1.id }),
      reprint(managerCookie, { date: day(8), stationId: till1.id }),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(await eodSeries()).toBe(before + 1);
    const jobs = await jobsOf(closed.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.reprintOf === null)).toHaveLength(1);
    expect(await auditsOf('end_of_day.receipt', closed.id)).toHaveLength(1);
    const [row] = await ctx.db.select().from(schema.endOfDay).where(eq(schema.endOfDay.id, closed.id));
    expect(row!.receiptNumber).toBe(`${till1.codePrefix}-EOD-${String(before).padStart(6, '0')}`);
    expect(row!.receiptStationId).toBe(till1.id);

    // Replaying the original close after the receipt printed still prints nothing more.
    const late = await close(unseated, { date: day(8) }, key);
    expect(late.statusCode, late.body).toBe(200);
    expect(await jobsOf(closed.id)).toHaveLength(2);
    expect(await eodSeries()).toBe(before + 1);
  });

  it('a replayed close at a printing counter prints once and takes one number', async () => {
    const key = newId();
    const before = await eodSeries();
    const first = await close(receptionCookie, { date: day(9), stationId: till1.id }, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await close(receptionCookie, { date: day(9), stationId: till1.id }, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const rec = first.json() as EndOfDayRecord;
    expect(rec.receipt!.number).toBe(`${till1.codePrefix}-EOD-${String(before).padStart(6, '0')}`);
    expect(await jobsOf(rec.id)).toHaveLength(1);
    expect(await eodSeries()).toBe(before + 1);
    // Already numbered: no second end_of_day.receipt audit, a reprint is a copy.
    const copy = await reprint(receptionCookie, { date: day(9) });
    expect(copy.statusCode, copy.body).toBe(200);
    expect((copy.json() as EndOfDayRecord).receipt!.jobs.map((j) => j.reprint)).toEqual([false, true]);
    expect(await auditsOf('end_of_day.receipt', rec.id)).toHaveLength(0);
  });

  it('a reprint naming a counter this session did not take is refused and numbers nothing', async () => {
    const unseated = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const closed = await close(unseated, { date: day(10) });
    expect(closed.statusCode, closed.body).toBe(200);
    const before = await eodSeries();
    const res = await reprint(receptionCookie, { date: day(10), stationId: otherCentralStation });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STATION_NOT_PICKED');
    const [row] = await ctx.db.select().from(schema.endOfDay).where(and(eq(schema.endOfDay.branchId, central), eq(schema.endOfDay.businessDate, day(10))));
    expect(row!.receiptNumber).toBeNull();
    expect(await eodSeries()).toBe(before);
  });
});
