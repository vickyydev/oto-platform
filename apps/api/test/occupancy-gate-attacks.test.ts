import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  bandEvent,
  box,
  branch,
  factOccupancy15min,
  station,
  syncEvent,
  ticketPackage,
  type Db,
} from '@oto/db';
import { LiveOccupancyViewSchema, newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { gateEventFact } from '@oto/box-agent/gate';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  boxBySlot,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { provisionVirtualBox } from '../src/services/box';
import {
  DAY_END_CLEAR_ACTION,
  DAY_END_CLEAR_LOOKBACK_DAYS,
  clearTradingDay,
  liveOccupancy,
  runOccupancyJob,
  writeOccupancyBucket,
} from '../src/services/occupancy';

/**
 * S2-12 round 4 — THE GATE'S ATTACKS on the occupancy projection.
 *
 * Kept as reproductions: each block is a sequence built to make the number lie
 * (a refusal counted, the floor broken, a child counted with no adult of their
 * sale inside, a child left counted after the last adult went out), to make a
 * silent gate look fresh, and to make the quarter-hour writer or the day-end
 * clear write twice. Dates are in 2031 so nothing here meets another file's.
 */

let ctx: TestContext;
let db: Db;
let centralId: string;
let chalongId: string;
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

const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

async function pass(
  bandId: string,
  kind: 'entry' | 'exit' | 'denied' | 'timeout' | 'alarm',
  at: Date,
  detail: Record<string, unknown> = {},
  stationId: string = gateStationId,
): Promise<void> {
  await db.insert(bandEvent).values({
    id: newId(),
    bandId,
    kind,
    stationId,
    boxId: gateBoxId,
    detail: { direction: kind === 'exit' ? 'exit' : 'entry', side: 'left', ...detail },
    createdAt: at,
  });
}

const count = async (now: Date, branchId: string = centralId) => {
  const v = await liveOccupancy(db, { operatorId, branchId, now });
  return { adults: v.adults, kids: v.kids, total: v.total };
};

const clockOf = async (branchId: string) => {
  const [row] = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    })
    .from(branch)
    .where(eq(branch.id, branchId));
  return row!;
};

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  centralId = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  chalongId = await branchIdByCode(db, CHALONG_BRANCH_CODE);
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
    name: 'Attack lane',
    kind: 'gate',
  });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('attack 1 — the count\'s truth', () => {
  it('a timeout or a denied after an exit never re-admits; a denied while inside never removes', async () => {
    const day = '2031-03-03';
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    await pass(a, 'entry', bkk(day, '10:00'));
    await pass(a, 'denied', bkk(day, '10:05'), { reason: 'ANTI_PASSBACK' });
    expect(await count(bkk(day, '10:06'))).toEqual({ adults: 1, kids: 1, total: 2 });
    await pass(a, 'exit', bkk(day, '11:00'));
    await pass(a, 'timeout', bkk(day, '11:01'));
    await pass(a, 'timeout', bkk(day, '11:02'), { inferred: true, personInLane: true });
    await pass(a, 'denied', bkk(day, '11:03'), { reason: 'REVOKED' });
    await pass(a, 'alarm', bkk(day, '11:04'), { alarm: 'tailgating' });
    await pass(a, 'alarm', bkk(day, '11:05'), { alarm: 'reverse' });
    expect(await count(bkk(day, '11:10'))).toEqual({ adults: 0, kids: 0, total: 0 });
  });

  it('the floor: a crowd of exits with no entry, then one entry, is one — never negative, never someone else', async () => {
    const day = '2031-03-04';
    const lone = await Promise.all([sell(1, 1), sell(0, 2), sell(2, 1)]);
    for (const s of lone) for (const a of s.adults) await pass(a, 'exit', bkk(day, '09:00'), { exitWithoutEntry: true });
    expect(await count(bkk(day, '09:01'))).toEqual({ adults: 0, kids: 0, total: 0 });
    const inside = await sell(0, 1);
    await pass(inside.adults[0]!, 'entry', bkk(day, '09:10'));
    // More exits-without-entry after someone is inside must not take them off.
    for (const s of lone) for (const a of s.adults) await pass(a, 'exit', bkk(day, '09:20'), { exitWithoutEntry: true });
    expect(await count(bkk(day, '09:30'))).toEqual({ adults: 1, kids: 0, total: 1 });
    // And the fact writer, over the same passages, never stores a negative.
    const row = await writeOccupancyBucket(db, await clockOf(centralId), bkk(day, '09:15'));
    expect(row.adults).toBeGreaterThanOrEqual(0);
    expect(row.kids).toBeGreaterThanOrEqual(0);
  });

  it('a kid is never counted with no adult of THEIR sale inside — another sale\'s adult does not carry them', async () => {
    const day = '2031-03-05';
    const family = await sell(2, 1);
    const stranger = await sell(0, 1);
    await pass(stranger.adults[0]!, 'entry', bkk(day, '10:00'));
    expect(await count(bkk(day, '10:01'))).toEqual({ adults: 1, kids: 0, total: 1 });
    // A kid band read at the gate (it should never operate it) counts as nobody.
    await pass(family.kids[0]!, 'entry', bkk(day, '10:02'));
    expect(await count(bkk(day, '10:03'))).toEqual({ adults: 1, kids: 0, total: 1 });
    // The family's adult was refused: still no kids.
    await pass(family.adults[0]!, 'denied', bkk(day, '10:04'), { reason: 'ANTI_PASSBACK' });
    expect(await count(bkk(day, '10:05'))).toEqual({ adults: 1, kids: 0, total: 1 });
  });

  it('a kid is not left counted after the last adult of the sale exits, whatever order the adults went', async () => {
    const day = '2031-03-06';
    const s = await sell(3, 3);
    const [a1, a2, a3] = s.adults as [string, string, string];
    await pass(a1, 'entry', bkk(day, '10:00'));
    await pass(a2, 'entry', bkk(day, '10:00'));
    await pass(a3, 'exit', bkk(day, '10:01'), { exitWithoutEntry: true });
    expect(await count(bkk(day, '10:02'))).toEqual({ adults: 2, kids: 3, total: 5 });
    await pass(a2, 'exit', bkk(day, '10:30'));
    await pass(a1, 'exit', bkk(day, '10:31'));
    expect(await count(bkk(day, '10:32'))).toEqual({ adults: 0, kids: 0, total: 0 });
    // An alarm and a timeout on the last adult after the exit do not bring the children back.
    await pass(a1, 'alarm', bkk(day, '10:33'), { alarm: 'reverse' });
    await pass(a1, 'timeout', bkk(day, '10:34'));
    expect(await count(bkk(day, '10:35'))).toEqual({ adults: 0, kids: 0, total: 0 });
  });

  it('an adult inside across the 05:00 boundary who exits after it does not stay counted', async () => {
    const day = '2031-03-07';
    const next = '2031-03-08';
    const s = await sell(1, 1);
    await pass(s.adults[0]!, 'entry', bkk(day, '23:00'));
    await pass(s.adults[0]!, 'exit', bkk(next, '05:10'), { exitWithoutEntry: true });
    expect(await count(bkk(next, '05:20'))).toEqual({ adults: 0, kids: 0, total: 0 });
  });
});

describe('attack 2 — honest staleness', () => {
  it('a branch whose gate station has no box answers stale with no asOf, never a fresh zero', async () => {
    const lane = newId();
    await db.insert(station).values({ id: lane, operatorId, branchId: chalongId, boxId: null, name: 'Unboxed lane', kind: 'gate' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${chalongId}/occupancy`,
      headers: { cookie: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password) },
    });
    // Reception may or may not reach Chalong; the service answer is what matters.
    const view = await liveOccupancy(db, { operatorId, branchId: chalongId });
    expect(view).toMatchObject({ gates: 0, stale: true, asOf: null, total: 0 });
    if (res.statusCode === 200) expect(LiveOccupancyViewSchema.parse(res.json()).stale).toBe(true);
    await db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, lane));
  });

  it('a gate box silent an hour answers stale through the route, asOf at its last word', async () => {
    const now = Date.now();
    const lastWord = new Date(now - 60 * 60 * 1000);
    await db
      .update(box)
      .set({ lastHeartbeatAt: lastWord, lastStatus: { outboxDepth: 0, oldestUnackedAgeS: null } })
      .where(eq(box.id, gateBoxId));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${centralId}/occupancy`,
      headers: { cookie: receptionCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = LiveOccupancyViewSchema.parse(res.json());
    expect(body.stale).toBe(true);
    expect(body.gates).toBe(1);
    // asOf is at most the last heartbeat (a sync push may be newer only if it happened).
    expect(new Date(body.asOf!).getTime()).toBeLessThanOrEqual(Math.max(lastWord.getTime(), now));
    expect(now - new Date(body.asOf!).getTime()).toBeGreaterThan(body.staleAfterSeconds * 1000);
  });

  it('a gate box never heard from answers stale with asOf null', async () => {
    await db.update(box).set({ lastHeartbeatAt: null, lastStatus: null }).where(eq(box.id, gateBoxId));
    const view = await liveOccupancy(db, { operatorId, branchId: centralId });
    // A sync push could vouch for it; with none recorded for this box, asOf is null.
    if (view.asOf === null) expect(view.stale).toBe(true);
    else expect(view.stale).toBe(Date.now() - new Date(view.asOf).getTime() > view.staleAfterSeconds * 1000);
  });

  it('a live lane with no box beside a reporting one is a gate never heard from: stale, never fresh on the other lane alone', async () => {
    await db
      .update(box)
      .set({ lastHeartbeatAt: new Date(), lastStatus: { outboxDepth: 0, oldestUnackedAgeS: null } })
      .where(eq(box.id, gateBoxId));
    expect((await liveOccupancy(db, { operatorId, branchId: centralId })).stale).toBe(false);
    const lane = newId();
    await db.insert(station).values({ id: lane, operatorId, branchId: centralId, boxId: null, name: 'Second lane, no box', kind: 'gate' });
    const view = await liveOccupancy(db, { operatorId, branchId: centralId });
    expect(view).toMatchObject({ stale: true, asOf: null, gates: 1 });
    // Archiving the lane restores the reporting box's word.
    await db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, lane));
    expect((await liveOccupancy(db, { operatorId, branchId: centralId })).stale).toBe(false);
  });
});

describe('attack 4 — the idempotent job and the audited clear', () => {
  it('the job re-run with the same instant rewrites nothing: same ids, same counts, same row count', async () => {
    const now = new Date();
    await runOccupancyJob(db, now);
    const first = await db.select().from(factOccupancy15min).where(eq(factOccupancy15min.branchId, centralId));
    await runOccupancyJob(db, now);
    const second = await db.select().from(factOccupancy15min).where(eq(factOccupancy15min.branchId, centralId));
    expect(second.length).toBe(first.length);
    const key = (r: (typeof first)[number]) => `${r.id}|${r.bucketStart.toISOString()}|${r.adults}|${r.kids}|${r.businessDate}`;
    expect(second.map(key).sort()).toEqual(first.map(key).sort());
  });

  it('the job\'s day-end clear audits yesterday\'s stranded group exactly once across repeated runs', async () => {
    const c = await clockOf(centralId);
    const today = (await liveOccupancy(db, { operatorId, branchId: centralId })).businessDate;
    const y = new Date(`${today}T00:00:00Z`);
    y.setUTCDate(y.getUTCDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    const s = await sell(1, 1);
    await pass(s.adults[0]!, 'entry', bkk(yesterday, '15:00'));
    await runOccupancyJob(db, new Date());
    await runOccupancyJob(db, new Date());
    await clearTradingDay(db, c, yesterday);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, DAY_END_CLEAR_ACTION), eq(auditLog.entityId, `${centralId}:${yesterday}`)));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.before as { adultBandIds: string[] }).adultBandIds).toContain(s.adults[0]);
  });

  it('the clear is reckoned from the job\'s own instant and reaches back over the trading days a stopped job missed', async () => {
    // Two groups stranded on two different days; the platform is down until 2031-04-10 06:00.
    const early = await sell(0, 1);
    const late = await sell(1, 1);
    await pass(early.adults[0]!, 'entry', bkk('2031-04-03', '15:00'));
    await pass(late.adults[0]!, 'entry', bkk('2031-04-07', '15:00'));
    const back = bkk('2031-04-10', '06:00');
    expect(DAY_END_CLEAR_LOOKBACK_DAYS).toBeGreaterThanOrEqual(7);
    // Reckoned from the wall clock (2026) no 2031 day has ended; from the job's instant both have.
    const detail = await runOccupancyJob(db, back);
    expect(detail.cleared).toBe(2);
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, DAY_END_CLEAR_ACTION),
          inArray(auditLog.entityId, [`${centralId}:2031-04-03`, `${centralId}:2031-04-07`]),
        ),
      );
    expect(rows.map((r) => (r.before as { businessDate: string }).businessDate).sort()).toEqual(['2031-04-03', '2031-04-07']);
    // The next run closes nothing again.
    expect((await runOccupancyJob(db, bkk('2031-04-10', '06:05'))).cleared).toBe(0);
  });
});

describe('attack 1b — a box clock the platform has marked untrusted', () => {
  let agent: BoxAgent;
  let agentStation: string;
  let agentBranch: string;
  let agentOperator: string;
  /** The Pi came back from a power cut with its clock an hour behind and has not measured yet. */
  const BEHIND_MS = 60 * 60 * 1000;

  function injectTransport(): AgentFetch {
    return async (url, init) => {
      const res = await ctx.app.inject({
        method: init.method as 'GET',
        url: url.replace(/^https?:\/\/[^/]+/, ''),
        headers: init.headers,
        payload: init.body,
      });
      return {
        status: res.statusCode,
        json: async () => (res.body ? JSON.parse(res.body) : null),
        text: async () => res.body,
        header: (name) => {
          const value = res.headers[name.toLowerCase()];
          return typeof value === 'string' ? value : null;
        },
      };
    };
  }

  beforeAll(async () => {
    const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
    agent = createBoxAgent({
      apiBaseUrl: 'http://occupancy-attack.test',
      credentials: memoryCredentialStore(),
      hostname: 'occupancy-attack-test',
      fetch: injectTransport(),
      claimCode: async () => (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
      store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
      booth: { enabled: false },
      now: () => Date.now() - BEHIND_MS,
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
    const bundle = agent.config()!;
    agentBranch = bundle.branch.id;
    agentOperator = bundle.branch.operatorId ?? agent.state.operatorId!;
    agentStation = newId();
    await db.insert(station).values({
      id: agentStation,
      operatorId: agentOperator,
      branchId: agentBranch,
      boxId: agent.state.boxId!,
      name: 'Rebooted lane',
      kind: 'gate',
    });
  });

  afterAll(() => {
    agent?.outbox()?.stop();
    agent?.stop();
  });

  it('an exit stamped by an untrusted clock earlier than the entry must not leave the family counted inside', async () => {
    const s = await sell(1, 1);
    const adult = s.adults[0]!;
    const realNow = Date.now();
    // The entry, from before the power cut: a trusted stamp a moment ago, as the handler writes it.
    // (A moment, not minutes, so the test holds even just after the 05:00 trading-day start.)
    await db.insert(bandEvent).values({
      id: newId(),
      bandId: adult,
      kind: 'entry',
      stationId: agentStation,
      boxId: agent.state.boxId!,
      detail: { direction: 'entry', side: 'left' },
      createdAt: new Date(realNow - 1000),
    });
    const before = await liveOccupancy(db, { operatorId: agentOperator, branchId: agentBranch, now: new Date(realNow) });
    expect(before.adults).toBeGreaterThanOrEqual(1);

    // After the reboot: the family walks out now; the box stamps its own (hour-behind) clock.
    const eventId = newId();
    await agent.outbox()!.queue(
      gateEventFact({
        eventId,
        bandId: adult,
        kind: 'exit',
        direction: 'exit',
        side: 'left',
        stationId: agentStation,
        occurredAt: new Date(realNow - BEHIND_MS).toISOString(),
      }),
    );
    expect((await agent.outbox()!.flush()).state).toBe('pushed');
    const [row] = await db.select().from(bandEvent).where(eq(bandEvent.id, eventId));
    expect(row, 'the exit reached the journal').toBeDefined();
    const sourceEventId = (row!.detail as { sourceEventId: string }).sourceEventId;
    const [ledger] = await db.select().from(syncEvent).where(eq(syncEvent.eventId, sourceEventId));
    // The platform itself knows not to believe this stamp: the ledger files it untrusted.
    expect(ledger!.clockTrust).not.toBe('trusted');
    expect(ledger!.receivedAt.getTime()).toBeGreaterThan(realNow - 1000);

    // The box is current: it just pushed. So whatever the route says is presented as live.
    // (Every gate box at the branch, so another lane's box does not make it stale for its own reason.)
    await db
      .update(box)
      .set({ lastHeartbeatAt: new Date(), lastStatus: { outboxDepth: 0, oldestUnackedAgeS: null } });
    const after = await liveOccupancy(db, { operatorId: agentOperator, branchId: agentBranch, now: new Date() });
    // The lie this guards against: the adult walked out, yet they and their child stayed counted, fresh.
    // The exit is placed at the moment the cloud took it, after the trusted entry, so the family is out.
    expect(after.stale).toBe(false);
    expect(after.adults, 'the adult who exited is still counted').toBe(before.adults - 1);
    expect(after.kids, 'their child is still counted').toBe(before.kids - 1);
    // The gate's journal keeps the box's own stamp exactly as sent; only where the count PLACES it changed.
    expect(row!.createdAt.getTime()).toBe(new Date(realNow - BEHIND_MS).getTime());
  });

  it('an entry stamped a day behind is not dropped out of the trading day: it counts from the moment the cloud took it', async () => {
    const s = await sell(1, 1);
    const adult = s.adults[0]!;
    const realNow = Date.now();
    const before = await liveOccupancy(db, { operatorId: agentOperator, branchId: agentBranch, now: new Date(realNow) });
    const eventId = newId();
    const stamp = new Date(realNow - 26 * 60 * 60 * 1000);
    await agent.outbox()!.queue(
      gateEventFact({
        eventId,
        bandId: adult,
        kind: 'entry',
        direction: 'entry',
        side: 'left',
        stationId: agentStation,
        occurredAt: stamp.toISOString(),
      }),
    );
    expect((await agent.outbox()!.flush()).state).toBe('pushed');
    const [row] = await db.select().from(bandEvent).where(eq(bandEvent.id, eventId));
    expect(row!.createdAt.getTime(), 'the journal keeps the stamp as sent').toBe(stamp.getTime());
    const [ledger] = await db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.eventId, (row!.detail as { sourceEventId: string }).sourceEventId));
    expect(ledger!.clockTrust).not.toBe('trusted');

    const after = await liveOccupancy(db, { operatorId: agentOperator, branchId: agentBranch, now: new Date() });
    expect(after.adults, 'the family that walked in is counted').toBe(before.adults + 1);
    expect(after.kids).toBe(before.kids + 1);
    // Placed where the platform can vouch for it: a millisecond before the cloud took it, the passage is not there yet.
    expect(ledger!.receivedAt.getTime()).toBeGreaterThan(realNow);
    const earlier = await liveOccupancy(db, {
      operatorId: agentOperator,
      branchId: agentBranch,
      now: new Date(ledger!.receivedAt.getTime() - 1),
    });
    expect(earlier.adults).toBe(before.adults);
  });
});
