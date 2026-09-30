import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  bandEvent,
  box,
  branch,
  factOccupancy15min,
  station,
  ticketPackage,
  type Db,
} from '@oto/db';
import { LiveOccupancyViewSchema, OCCUPANCY_STALE_AFTER_S, newId } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  boxBySlot,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import {
  DAY_END_CLEAR_ACTION,
  FACT_LOOKBACK_BUCKETS,
  clearTradingDay,
  liveOccupancy,
  quarterHourFloor,
  runOccupancyJob,
  writeOccupancyBucket,
} from '../src/services/occupancy';

/**
 * S2-12 round 4 — the live occupancy projection over scripted gate passages.
 *
 * The passages are written straight into `pos.band_event` as the
 * `band.gate_event` sync handler writes them (kind, station, box, the box's
 * `occurredAt` as `created_at`); `occupancy-freshness.test.ts` drives the same
 * rows through the real outbox and push. Each scenario runs on its own trading
 * day at HKT Central (Asia/Bangkok, day start 05:00), so none sees another's
 * passages.
 */

let ctx: TestContext;
let db: Db;
let centralId: string;
let operatorId: string;
let gateStationId: string;
let gateBoxId: string;
let receptionCookie: string;

interface Sold {
  saleId: string;
  adults: string[];
  kids: string[];
}

async function sell(kids: number, adults: number): Promise<Sold> {
  const [till] = await db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  const saleId = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: receptionCookie },
    payload: { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids, adults }] },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: receptionCookie },
    payload: {},
  });
  expect(paid.statusCode, paid.body).toBe(200);
  const bands = await db.select().from(band).where(eq(band.saleId, saleId));
  return {
    saleId,
    adults: bands.filter((b) => b.kind === 'adult').map((b) => b.id),
    kids: bands.filter((b) => b.kind === 'kid').map((b) => b.id),
  };
}

/** Bangkok wall-clock time on a given date → the instant (UTC+7, no DST). */
const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

async function pass(
  bandId: string,
  kind: 'entry' | 'exit' | 'denied' | 'timeout' | 'alarm',
  at: Date,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(bandEvent).values({
    id: newId(),
    bandId,
    kind,
    stationId: gateStationId,
    boxId: gateBoxId,
    detail: { direction: kind === 'exit' ? 'exit' : 'entry', side: 'left', ...detail },
    createdAt: at,
  });
}

const count = async (now: Date) => {
  const v = await liveOccupancy(db, { operatorId, branchId: centralId, now });
  return { adults: v.adults, kids: v.kids, total: v.total };
};

const clock = async () => {
  const [row] = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    })
    .from(branch)
    .where(eq(branch.id, centralId));
  return row!;
};

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  centralId = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  const [row] = await db.select({ operatorId: branch.operatorId }).from(branch).where(eq(branch.id, centralId));
  operatorId = row!.operatorId;
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  gateBoxId = (await boxBySlot(db, 'virtual-2')).id;
  gateStationId = newId();
  await db.insert(station).values({
    id: gateStationId,
    operatorId,
    branchId: centralId,
    boxId: gateBoxId,
    name: 'Occupancy test lane',
    kind: 'gate',
  });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the projection over scripted passages (S2-12 round 4)', () => {
  it('in then out: an adult and their sale\'s child count while the adult is inside', async () => {
    const day = '2030-01-07';
    const s = await sell(1, 1);
    await pass(s.adults[0]!, 'entry', bkk(day, '10:00'));
    expect(await count(bkk(day, '10:30'))).toEqual({ adults: 1, kids: 1, total: 2 });
    await pass(s.adults[0]!, 'exit', bkk(day, '11:00'));
    expect(await count(bkk(day, '11:30'))).toEqual({ adults: 0, kids: 0, total: 0 });
    // The count at an instant reads only passages up to it.
    expect(await count(bkk(day, '10:59'))).toEqual({ adults: 1, kids: 1, total: 2 });
  });

  it('denied, timeout and alarm never count, and an alarm after an entry changes nothing', async () => {
    const day = '2030-01-08';
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    await pass(a, 'denied', bkk(day, '10:00'), { reason: 'ANTI_PASSBACK' });
    await pass(a, 'timeout', bkk(day, '10:01'), { inferred: true });
    await pass(a, 'alarm', bkk(day, '10:02'), { alarm: 'reverse' });
    expect(await count(bkk(day, '10:10'))).toEqual({ adults: 0, kids: 0, total: 0 });
    await pass(a, 'entry', bkk(day, '10:20'));
    await pass(a, 'alarm', bkk(day, '10:21'), { alarm: 'tailgating' });
    await pass(a, 'timeout', bkk(day, '10:22'));
    expect(await count(bkk(day, '10:30'))).toEqual({ adults: 1, kids: 1, total: 2 });
  });

  it('an exit without an entry is recorded and never takes the count below zero or off anyone else (OD-A4)', async () => {
    const day = '2030-01-09';
    const lone = await sell(0, 1);
    const other = await sell(0, 1);
    await pass(lone.adults[0]!, 'exit', bkk(day, '10:00'), { exitWithoutEntry: true });
    expect(await count(bkk(day, '10:05'))).toEqual({ adults: 0, kids: 0, total: 0 });
    await pass(other.adults[0]!, 'entry', bkk(day, '10:10'));
    await pass(lone.adults[0]!, 'exit', bkk(day, '10:20'), { exitWithoutEntry: true });
    expect(await count(bkk(day, '10:30'))).toEqual({ adults: 1, kids: 0, total: 1 });
    // A band read in twice (a swapped gate box) is still one person.
    await pass(other.adults[0]!, 'entry', bkk(day, '10:40'));
    expect(await count(bkk(day, '10:45'))).toEqual({ adults: 1, kids: 0, total: 1 });
  });

  it('the kids rule with a two-adult sale: children stay while either adult is inside', async () => {
    const day = '2030-01-10';
    const s = await sell(2, 2);
    const [a1, a2] = s.adults as [string, string];
    await pass(a1, 'entry', bkk(day, '10:00'));
    expect(await count(bkk(day, '10:01'))).toEqual({ adults: 1, kids: 2, total: 3 });
    await pass(a2, 'entry', bkk(day, '10:05'));
    expect(await count(bkk(day, '10:06'))).toEqual({ adults: 2, kids: 2, total: 4 });
    await pass(a1, 'exit', bkk(day, '11:00'));
    expect(await count(bkk(day, '11:01'))).toEqual({ adults: 1, kids: 2, total: 3 });
    await pass(a2, 'exit', bkk(day, '11:30'));
    expect(await count(bkk(day, '11:31'))).toEqual({ adults: 0, kids: 0, total: 0 });
    // An adult coming back brings the sale's children back.
    await pass(a2, 'entry', bkk(day, '12:00'));
    expect(await count(bkk(day, '12:01'))).toEqual({ adults: 1, kids: 2, total: 3 });
    // A revoked kid band (refunded) no longer counts.
    await db.update(band).set({ status: 'revoked' }).where(eq(band.id, s.kids[0]!));
    expect(await count(bkk(day, '12:02'))).toEqual({ adults: 1, kids: 1, total: 2 });
  });

  it('a passage at another branch\'s gate does not count here', async () => {
    const day = '2030-01-11';
    const s = await sell(1, 1);
    const chalongId = await branchIdByCode(db, CHALONG_BRANCH_CODE);
    const chalongBox = await boxBySlot(db, 'virtual-3');
    const chalongGate = newId();
    await db.insert(station).values({
      id: chalongGate,
      operatorId,
      branchId: chalongId,
      boxId: chalongBox.id,
      name: 'Chalong lane',
      kind: 'gate',
    });
    await db.insert(bandEvent).values({
      id: newId(),
      bandId: s.adults[0]!,
      kind: 'entry',
      stationId: chalongGate,
      boxId: chalongBox.id,
      detail: {},
      createdAt: bkk(day, '10:00'),
    });
    expect(await count(bkk(day, '10:30'))).toEqual({ adults: 0, kids: 0, total: 0 });
    const there = await liveOccupancy(db, { operatorId, branchId: chalongId, now: bkk(day, '10:30') });
    expect(there.total).toBe(2);
    await db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, chalongGate));
  });
});

describe('the trading day and the day-end clear (S2-12 round 4)', () => {
  it('a group inside at 05:00 is not carried into the next day, and the clear audits it once', async () => {
    const day = '2030-01-14';
    const next = '2030-01-15';
    const s = await sell(1, 2);
    await pass(s.adults[0]!, 'entry', bkk(day, '19:00'));
    // 00:30 the next calendar day is still `day`'s trading day.
    expect(await count(bkk(next, '00:30'))).toEqual({ adults: 1, kids: 1, total: 2 });
    // 05:00 starts `next`: the stranded group is gone from the count.
    expect(await count(bkk(next, '05:00'))).toEqual({ adults: 0, kids: 0, total: 0 });

    const c = await clock();
    // Not ended yet → nothing.
    const early = await clearTradingDay(db, c, day, bkk(next, '04:59'));
    expect(early.cleared).toBe(false);

    const first = await clearTradingDay(db, c, day, bkk(next, '06:00'));
    expect(first).toEqual({ cleared: true, count: { adults: 1, kids: 1, total: 2 } });
    const again = await clearTradingDay(db, c, day, bkk(next, '06:05'));
    expect(again.cleared).toBe(false);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, DAY_END_CLEAR_ACTION), eq(auditLog.entityId, `${centralId}:${day}`)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branchId).toBe(centralId);
    expect(rows[0]!.before).toMatchObject({
      businessDate: day,
      adults: 1,
      kids: 1,
      saleIds: [s.saleId],
      adultBandIds: [s.adults[0]],
    });
    expect(rows[0]!.after).toMatchObject({ adults: 0, kids: 0 });
    // Nothing invented in the gate's journal.
    const journal = await db.select().from(bandEvent).where(eq(bandEvent.bandId, s.adults[0]!));
    expect(journal.map((j) => j.kind).filter((k) => k !== 'minted')).toEqual(['entry']);
  });

  it('a day that ended with nobody inside writes no audit row', async () => {
    const day = '2030-01-16';
    const s = await sell(0, 1);
    await pass(s.adults[0]!, 'entry', bkk(day, '10:00'));
    await pass(s.adults[0]!, 'exit', bkk(day, '12:00'));
    const out = await clearTradingDay(db, await clock(), day, bkk('2030-01-17', '06:00'));
    expect(out.cleared).toBe(false);
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, `${centralId}:${day}`));
    expect(rows).toHaveLength(0);
  });
});

describe('the fact job (S2-12 round 4)', () => {
  it('writes a quarter-hour from the projection, and writing it again changes nothing', async () => {
    const day = '2030-01-21';
    const s = await sell(1, 1);
    await pass(s.adults[0]!, 'entry', bkk(day, '10:05'));
    const c = await clock();
    const bucket = bkk(day, '10:15');
    const first = await writeOccupancyBucket(db, c, bucket);
    const second = await writeOccupancyBucket(db, c, bucket);
    expect(first).toEqual(second);
    const rows = await db
      .select()
      .from(factOccupancy15min)
      .where(and(eq(factOccupancy15min.branchId, centralId), eq(factOccupancy15min.bucketStart, bucket)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ adults: 1, kids: 1, businessDate: day, operatorId });
    // A late passage (a gate that was offline) corrects the bucket when it is recomputed.
    await pass(s.adults[0]!, 'exit', bkk(day, '10:10'));
    await writeOccupancyBucket(db, c, bucket);
    const [fixed] = await db
      .select()
      .from(factOccupancy15min)
      .where(and(eq(factOccupancy15min.branchId, centralId), eq(factOccupancy15min.bucketStart, bucket)));
    expect(fixed).toMatchObject({ adults: 0, kids: 0 });
  });

  it('the job run twice in one quarter-hour writes each bucket once', async () => {
    const now = new Date();
    const one = await runOccupancyJob(db, now);
    const two = await runOccupancyJob(db, new Date(now.getTime() + 1000));
    expect(one.buckets).toBe(two.buckets);
    expect(one.branches).toBeGreaterThanOrEqual(1);
    const since = new Date(quarterHourFloor(now).getTime() - FACT_LOOKBACK_BUCKETS * 15 * 60 * 1000);
    const rows = (await db.select().from(factOccupancy15min).where(eq(factOccupancy15min.branchId, centralId))).filter(
      // Only the job's window: the scripted days above are in 2030.
      (r) => r.bucketStart.getTime() >= since.getTime() && r.bucketStart.getTime() <= now.getTime() + 1000,
    );
    expect(rows).toHaveLength(FACT_LOOKBACK_BUCKETS + 1);
    for (const r of rows) expect(r.bucketStart.getTime() % (15 * 60 * 1000)).toBe(0);
  });
});

describe('GET /branches/:id/occupancy (S2-12 round 4)', () => {
  it('answers the chip\'s shape, fresh while the gate box is current and stale since its last contact when not', async () => {
    const now = Date.now();
    await db
      .update(box)
      .set({ lastHeartbeatAt: new Date(now - 5_000), lastStatus: { outboxDepth: 0, oldestUnackedAgeS: null } })
      .where(eq(box.id, gateBoxId));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${centralId}/occupancy`,
      headers: { cookie: receptionCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = LiveOccupancyViewSchema.parse(res.json());
    expect(body.stale).toBe(false);
    expect(body.gates).toBe(1);
    expect(body.total).toBe(body.adults + body.kids);

    const silentSince = new Date(now - (OCCUPANCY_STALE_AFTER_S + 60) * 1000);
    await db.update(box).set({ lastHeartbeatAt: silentSince }).where(eq(box.id, gateBoxId));
    const stale = LiveOccupancyViewSchema.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/branches/${centralId}/occupancy`,
          headers: { cookie: receptionCookie },
        })
      ).json(),
    );
    expect(stale.stale).toBe(true);
    expect(stale.asOf).toBe(silentSince.toISOString());

    // Calling home but holding a gate fact unsent for too long is stale too.
    await db
      .update(box)
      .set({ lastHeartbeatAt: new Date(now), lastStatus: { outboxDepth: 1, oldestUnackedAgeS: OCCUPANCY_STALE_AFTER_S + 30 } })
      .where(eq(box.id, gateBoxId));
    const held = await liveOccupancy(db, { operatorId, branchId: centralId, now: new Date(now) });
    expect(held.stale).toBe(true);
  });

  it('a branch with no gate is stale with no asOf — nothing counts anyone in there', async () => {
    const chalongId = await branchIdByCode(db, CHALONG_BRANCH_CODE);
    const view = await liveOccupancy(db, { operatorId, branchId: chalongId });
    expect(view).toMatchObject({ gates: 0, stale: true, asOf: null });
  });

  it('is permission-guarded: another park\'s manager and another operator are refused', async () => {
    const chalong = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const refused = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${centralId}/occupancy`,
      headers: { cookie: chalong },
    });
    expect(refused.statusCode).toBe(403);
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const other = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${centralId}/occupancy`,
      headers: { cookie: foreign },
    });
    expect([403, 404]).toContain(other.statusCode);
    const anonymous = await ctx.app.inject({ method: 'GET', url: `/branches/${centralId}/occupancy` });
    expect(anonymous.statusCode).toBe(401);
  });
});
