import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  type EndOfDayRecord,
  type StrandedResolveAnswer,
} from '@oto/shared';
import {
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
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
import { countAt } from '../src/services/occupancy';
import { boxBacklogOf, stationLink } from '../src/services/station-session';
import { buildPrintDocument } from '../src/services/sale-printing';

/**
 * S2-15a round 2 — the provisional close, stranded occupancy and the End of
 * Day receipt (plan docs/progress/plans/cash/PLAN.md §4, §7; SCRUM-215).
 *
 * Today (D) carries the resolution scenarios and is never closed here;
 * yesterday (Y) is held provisional by a box, then by somebody still counted
 * inside, and is finally closed by a manager's override at Reception Till 1,
 * which prints the receipt.
 */

const TZ = 'Asia/Bangkok';
const DAY_START = 5 * 60;
const D = businessDate(new Date(), TZ, DAY_START);
const Y = addDaysToIsoDate(D, -1);
const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

let ctx: TestContext;
let operatorId: string;
let central: string;
let till1: { id: string; boxId: string; codePrefix: string };
let gateStation: string;
let piBox: string;
let receptionId: string;
let managerId: string;
let receptionCookie: string;
let managerCookie: string;

async function accountIdOf(phone: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.operatorId, operatorId), eq(schema.account.phone, phone)))
    .limit(1);
  return row!.id;
}

const getDay = async (cookie: string, date: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/branches/${central}/end-of-day?date=${date}`, headers: { cookie } });
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

const resolve = (cookie: string, payload: Record<string, unknown>, key: string = newId()) =>
  ctx.app.inject({
    method: 'POST',
    url: `/branches/${central}/end-of-day/stranded/resolve`,
    headers: { cookie, 'idempotency-key': key },
    payload,
  });

/** A sale with one adult band (Gate access) and one kid band, as the gate counts them. */
async function soldGroup(at: Date): Promise<{ saleId: string; adult: string; kid: string }> {
  const saleId = newId();
  await ctx.db.insert(schema.sale).values({
    id: saleId,
    operatorId,
    branchId: central,
    stationId: till1.id,
    businessDate: businessDate(at, TZ, DAY_START),
    businessDayStart: '05:00',
    timezone: TZ,
    occurredAt: at,
    createdByAccountId: receptionId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: 'eod-r2-test',
    taxConfig: {},
    taxBreakdown: {},
    subtotalSatang: 0,
    netSatang: 0,
    grossSatang: 0,
    receiptSeries: 'EODR2',
    receiptSeq: Math.floor(Math.random() * 1e9),
    receiptNumber: `EODR2-${saleId.slice(-6)}`,
    status: 'finalised',
    finalisedAt: at,
  });
  const adult = newId();
  const kid = newId();
  await ctx.db.insert(schema.band).values([
    { id: adult, operatorId, branchId: central, saleId, kind: 'adult', gateAccess: true, code: `A${adult.slice(-10)}` },
    { id: kid, operatorId, branchId: central, saleId, kind: 'kid', gateAccess: false, code: `K${kid.slice(-10)}` },
  ]);
  return { saleId, adult, kid };
}

async function entry(bandId: string, at: Date): Promise<void> {
  await ctx.db.insert(schema.bandEvent).values({ id: newId(), bandId, kind: 'entry', stationId: gateStation, detail: {}, createdAt: at });
}

async function checkedInChild(at: Date, name: string): Promise<string> {
  const registrationId = newId();
  await ctx.db.insert(schema.registration).values({
    id: registrationId,
    operatorId,
    branchId: central,
    guardianName: 'Khun Malee',
    guardianPhone: '+66811112222',
    acknowledgedConfirmations: [],
  });
  const id = newId();
  await ctx.db.insert(schema.checkin).values({
    id,
    operatorId,
    branchId: central,
    registrationId,
    childName: name,
    childAgeYears: 6,
    service: 'drop_off',
    status: 'in_park',
    checkedInAt: at,
  });
  return id;
}

const audits = (action: string, entityId?: string) =>
  ctx.db
    .select()
    .from(schema.auditLog)
    .where(entityId ? and(eq(schema.auditLog.action, action), eq(schema.auditLog.entityId, entityId)) : eq(schema.auditLog.action, action));

beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [t1] = await ctx.db
    .select()
    .from(schema.station)
    .where(and(eq(schema.station.branchId, central), eq(schema.station.codePrefix, 'T1')))
    .limit(1);
  till1 = { id: t1!.id, boxId: t1!.boxId!, codePrefix: t1!.codePrefix! };
  gateStation = newId();
  await ctx.db.insert(schema.station).values({
    id: gateStation,
    operatorId,
    branchId: central,
    boxId: till1.boxId,
    name: 'EOD r2 lane',
    kind: 'gate',
  });
  receptionId = await accountIdOf(RECEPTION.phone);
  managerId = await accountIdOf(BRANCH_MANAGER.phone);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  await takeStation(ctx.app, receptionCookie, till1.id);
  await takeStation(ctx.app, managerCookie, till1.id);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- The provisional close --------------------------------------------------------

describe('eod-r2 provisional: a box still holding records keeps the day provisional', () => {
  it('nothing waiting: the open day is not provisional and lists nobody', async () => {
    const rec = await getDay(receptionCookie, Y);
    expect(rec.status).toBe('open');
    expect(rec.provisional).toEqual([]);
    expect(rec.stranded).toEqual([]);
  });

  it("a virtual box's waiting outbox makes the day provisional and refuses the close with its name", async () => {
    const [virtualBox] = await ctx.db.select().from(schema.box).where(eq(schema.box.id, till1.boxId));
    // The seeded virtual box, registered so it is one the close waits on.
    await ctx.db.update(schema.box).set({ registeredAt: new Date(), status: 'online' }).where(eq(schema.box.id, till1.boxId));
    const eventId = newId();
    await ctx.db.insert(schema.boxOutbox).values({
      eventId,
      boxId: till1.boxId,
      journalEpoch: 1,
      boxSeq: 999_001,
      type: 'sale.finalised',
      occurredAt: new Date(Date.now() - 5 * 60_000),
      payload: {},
      payloadHash: 'a'.repeat(64),
      sig: 'x',
      state: 'queued',
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    const rec = await getDay(receptionCookie, Y);
    expect(rec.provisional).toHaveLength(1);
    expect(rec.provisional![0]).toMatchObject({ boxId: till1.boxId, name: virtualBox!.name, reason: 'outbox', waiting: 1 });
    expect(rec.provisional![0]!.since).not.toBeNull();

    const res = await close(receptionCookie, { date: Y });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('DAY_PROVISIONAL');
    expect(res.json().error.message).toContain(virtualBox!.name);
    expect(await ctx.db.select().from(schema.endOfDay).where(eq(schema.endOfDay.branchId, central))).toHaveLength(0);

    await ctx.db.delete(schema.boxOutbox).where(eq(schema.boxOutbox.eventId, eventId));
    expect((await getDay(receptionCookie, Y)).provisional).toEqual([]);
  });

  it("a Pi whose heartbeat reports a depth is counted, though its outbox is not in this database", async () => {
    piBox = newId();
    await ctx.db.insert(schema.box).values({
      id: piBox,
      operatorId,
      branchId: central,
      name: 'Counter Pi',
      slot: 'eod-r2-pi',
      role: 'counter',
      status: 'online',
      registeredAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 3, oldestUnackedAgeS: 600, clockOffsetMs: 40 },
    });
    const rec = await getDay(receptionCookie, Y);
    expect(rec.provisional).toEqual([
      expect.objectContaining({ boxId: piBox, name: 'Counter Pi', reason: 'outbox', waiting: 3 }),
    ]);
    expect(rec.provisional![0]!.message).toContain('Counter Pi has 3 records it has not sent yet');
    const res = await close(receptionCookie, { date: Y });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Counter Pi');

    // The station link reads the same depth for a counter on the Pi.
    const lane = newId();
    await ctx.db.insert(schema.station).values({ id: lane, operatorId, branchId: central, boxId: piBox, name: 'Pi till', kind: 'till' });
    const link = await stationLink(ctx.db, lane);
    expect(link.outboxDepth).toBe(3);
    expect(link.oldestUnackedSeconds).toBeGreaterThanOrEqual(600);
  });

  it('boxBacklogOf: rows here win; a virtual box never reads its heartbeat', () => {
    const empty = { depth: 0, oldestCreatedAt: null };
    expect(boxBacklogOf('counter', empty, { outboxDepth: 2, receivedAt: '2026-10-02T10:00:00.000Z', oldestUnackedAgeS: 60 })).toEqual({
      depth: 2,
      since: new Date('2026-10-02T09:59:00.000Z'),
    });
    expect(boxBacklogOf('virtual', empty, { outboxDepth: 2 }).depth).toBe(0);
    expect(boxBacklogOf('counter', { depth: 5, oldestCreatedAt: null }, { outboxDepth: 2 }).depth).toBe(5);
    expect(boxBacklogOf('counter', empty, null).depth).toBe(0);
  });

  it('a clock out of tolerance and not measured by the box refuses the close; once measured it does not', async () => {
    await ctx.db
      .update(schema.box)
      .set({ lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 0, clockOffsetMs: 12 * 60_000, clockMeasuredBy: 'platform' } })
      .where(eq(schema.box.id, piBox));
    const rec = await getDay(receptionCookie, Y);
    expect(rec.provisional).toEqual([expect.objectContaining({ boxId: piBox, reason: 'clock', waiting: null })]);
    expect(rec.provisional![0]!.message).toContain("Counter Pi's clock is 12 minutes ahead");
    const res = await close(receptionCookie, { date: Y });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DAY_PROVISIONAL');
    expect(res.json().error.message).toContain('clock');

    await ctx.db
      .update(schema.box)
      .set({ lastStatus: { receivedAt: new Date().toISOString(), outboxDepth: 0, clockOffsetMs: 12 * 60_000, clockMeasuredBy: 'box' } })
      .where(eq(schema.box.id, piBox));
    expect((await getDay(receptionCookie, Y)).provisional).toEqual([]);
  });
});

// --- Stranded occupancy -------------------------------------------------------------

describe('eod-r2 stranded: listed at close, resolved by hand, audited', () => {
  let group: { saleId: string; adult: string; kid: string };
  let childCheckin: string;
  const entered = new Date(Date.now() - 60_000);

  it('a band still inside and a child still checked in are listed with the gate event, the sale and the guardian', async () => {
    group = await soldGroup(entered);
    await entry(group.adult, entered);
    childCheckin = await checkedInChild(entered, 'Ploy');
    const rec = await getDay(receptionCookie, D);
    expect(rec.stranded).toHaveLength(2);
    const bandRow = rec.stranded!.find((r) => r.kind === 'band')!;
    expect(bandRow).toMatchObject({
      subjectId: group.adult,
      childrenWithBand: 1,
      sale: { saleId: group.saleId },
      lastGateEvent: { kind: 'entry', stationName: 'EOD r2 lane' },
    });
    const childRow = rec.stranded!.find((r) => r.kind === 'checkin')!;
    expect(childRow).toMatchObject({ subjectId: childCheckin, childName: 'Ploy', guardian: { name: 'Khun Malee', phone: '+66811112222' } });
  });

  it('a manual resolution clears the band from the count, keeps the history, and is audited gate.manual_resolution', async () => {
    const before = await countAt(ctx.db, central, new Date(entered.getTime() - 3_600_000), new Date());
    expect(before.adults).toBe(1);
    expect(before.kids).toBe(2); // the sale's child, and the drop-off child
    const actionId = newId();
    const res = await resolve(receptionCookie, { date: D, kind: 'band', subjectId: group.adult, reason: 'band_lost', actionId });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json() as StrandedResolveAnswer;
    expect(answer.replayed).toBe(false);
    expect(answer.stranded.map((r) => r.kind)).toEqual(['checkin']);

    const after = await countAt(ctx.db, central, new Date(entered.getTime() - 3_600_000), new Date());
    expect(after).toMatchObject({ adults: 0, kids: 1 });
    // The count at an earlier instant is unchanged: nothing was zeroed.
    const earlier = await countAt(ctx.db, central, new Date(entered.getTime() - 3_600_000), new Date(entered.getTime() + 1));
    expect(earlier.adults).toBe(1);
    // The gate journal is untouched.
    expect(await ctx.db.select().from(schema.bandEvent).where(eq(schema.bandEvent.bandId, group.adult))).toHaveLength(1);

    const rows = await audits('gate.manual_resolution', answer.resolutionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorAccountId).toBe(receptionId);
    expect(rows[0]!.after).toMatchObject({ kind: 'band', subjectId: group.adult, reason: 'band_lost' });

    // A retry of the same press records once.
    const again = await resolve(receptionCookie, { date: D, kind: 'band', subjectId: group.adult, reason: 'band_lost', actionId });
    expect(again.statusCode).toBe(200);
    expect((again.json() as StrandedResolveAnswer)).toMatchObject({ resolutionId: answer.resolutionId, replayed: true });
    const changed = await resolve(receptionCookie, { date: D, kind: 'band', subjectId: group.adult, reason: 'gate_fault', actionId });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('ACTION_ID_REUSED');
    expect(
      await ctx.db.select().from(schema.occupancyResolution).where(eq(schema.occupancyResolution.bandId, group.adult)),
    ).toHaveLength(1);

    // A new press for a row no longer counted inside is refused in the counter's words.
    const twice = await resolve(receptionCookie, { date: D, kind: 'band', subjectId: group.adult, reason: 'gate_fault' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.message).toBe('That band is no longer counted inside.');
  });

  it('the same idempotency key with another body is refused; the same key and body replays', async () => {
    const key = newId();
    const actionId = newId();
    const body = { date: D, kind: 'checkin', subjectId: childCheckin, reason: 'left_without_scanning', actionId };
    const first = await resolve(receptionCookie, body, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await resolve(receptionCookie, body, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    const other = await resolve(receptionCookie, { ...body, reason: 'gate_fault' }, key);
    expect(other.statusCode).toBe(409);
    expect((await getDay(receptionCookie, D)).stranded).toEqual([]);
  });

  it('a resolution is append-only', async () => {
    await expect(ctx.db.update(schema.occupancyResolution).set({ note: 'x' })).rejects.toThrow();
  });
});

// --- Override and receipt -------------------------------------------------------------

describe('eod-r2 close: unresolved rows refuse, a manager overrides with a reason, the receipt prints once', () => {
  let group: { saleId: string; adult: string; kid: string };
  let closed: EndOfDayRecord;
  const closeKey = newId();

  it('an unresolved row refuses the close; reception cannot override', async () => {
    group = await soldGroup(bkk(Y, '12:00'));
    await entry(group.adult, bkk(Y, '12:00'));
    const rec = await getDay(receptionCookie, Y);
    expect(rec.stranded).toHaveLength(1);

    const refused = await close(receptionCookie, { date: Y });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'STRANDED_OCCUPANCY' });
    expect(refused.json().error.message).toContain('1 is still counted inside the park');

    const notManager = await close(receptionCookie, { date: Y, override: { reason: 'Gate lost power at 20:00' } });
    expect(notManager.statusCode).toBe(403);
    expect(notManager.json().error.code).toBe('OVERRIDE_NOT_ALLOWED');
    expect(await audits('end_of_day.override')).toHaveLength(0);
  });

  it('a manager closes with a reason: audited end_of_day.override, shown on the closed day, receipt queued on the counter', async () => {
    const res = await close(
      managerCookie,
      { date: Y, stationId: till1.id, countedSatang: 600_000, floatLeftSatang: 600_000, override: { reason: 'Gate lost power at 20:00' } },
      closeKey,
    );
    expect(res.statusCode, res.body).toBe(200);
    closed = res.json() as EndOfDayRecord;
    expect(closed.status).toBe('closed');
    expect(closed.override).toMatchObject({ by: { accountId: managerId }, reason: 'Gate lost power at 20:00' });
    expect(closed.override!.stranded.map((r) => r.subjectId)).toEqual([group.adult]);

    const overrides = await audits('end_of_day.override', closed.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.actorAccountId).toBe(managerId);

    expect(closed.receipt).toMatchObject({ number: `${till1.codePrefix}-EOD-000001`, stationId: till1.id });
    expect(closed.receipt!.jobs).toHaveLength(1);
    expect(closed.receipt!.jobs[0]!.reprint).toBe(false);
    const [job] = await ctx.db.select().from(schema.printJob).where(eq(schema.printJob.id, closed.receipt!.jobs[0]!.id));
    expect(job).toMatchObject({ stationId: till1.id, boxId: till1.boxId, kind: 'receipt', subjectType: 'end_of_day', subjectId: closed.id });
    // Routed to the counter's own receipt printer, and handed to its box.
    expect(job!.status).toBe('queued');
    expect(job!.deviceId).not.toBeNull();
    const commands = await ctx.db.select().from(schema.boxCommand).where(eq(schema.boxCommand.boxId, till1.boxId));
    expect(commands.filter((c) => (c.payload as { printJobId?: string }).printJobId === job!.id)).toHaveLength(1);

    // What the box prints: the receipt template, the day as it was locked.
    const doc = await buildPrintDocument(ctx.db, { boxId: till1.boxId, operatorId }, job!.id);
    expect(doc.job.kind).toBe('receipt');
    const data = doc.job.data as { title: string; receiptNumber?: string; tenders?: { label: string; amount: string }[]; orderNote?: string };
    expect(data.title).toBe('End of Day');
    expect(data.receiptNumber).toBe(`${till1.codePrefix}-EOD-000001`);
    expect(data.tenders!.find((t) => t.label === 'Counted cash')!.amount).toBe('฿6,000');
    expect(data.tenders!.find((t) => t.label === 'Cash to bank tonight')!.amount).toBe('฿0');
    expect(data.orderNote).toContain('Closed by');
    expect(data.orderNote).toContain('Gate lost power at 20:00');
  });

  it('a replay of the close answers the same day and prints nothing more', async () => {
    const replay = await close(
      managerCookie,
      { date: Y, stationId: till1.id, countedSatang: 600_000, floatLeftSatang: 600_000, override: { reason: 'Gate lost power at 20:00' } },
      closeKey,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(closed);
    const jobs = await ctx.db.select().from(schema.printJob).where(eq(schema.printJob.subjectId, closed.id));
    expect(jobs).toHaveLength(1);
    expect((await getDay(receptionCookie, Y)).receipt!.jobs).toHaveLength(1);
  });

  it('a reprint from the closed day is a copy of the original; a replay of it prints once', async () => {
    const key = newId();
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/branches/${central}/end-of-day/reprint`,
        headers: { cookie: receptionCookie, 'idempotency-key': key },
        payload: { date: Y, stationId: till1.id },
      });
    const res = await send();
    expect(res.statusCode, res.body).toBe(200);
    const rec = res.json() as EndOfDayRecord;
    expect(rec.receipt!.jobs).toHaveLength(2);
    expect(rec.receipt!.jobs[1]!.reprint).toBe(true);
    const [copy] = await ctx.db.select().from(schema.printJob).where(eq(schema.printJob.id, rec.receipt!.jobs[1]!.id));
    expect(copy!.reprintOf).toBe(closed.receipt!.jobs[0]!.id);
    expect(await audits('print_job.reprint', copy!.id)).toHaveLength(1);
    const doc = await buildPrintDocument(ctx.db, { boxId: till1.boxId, operatorId }, copy!.id);
    expect((doc.job.data as { orderNote?: string }).orderNote).toContain('COPY');

    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(await ctx.db.select().from(schema.printJob).where(eq(schema.printJob.subjectId, closed.id))).toHaveLength(2);
  });

  it('an open day has no receipt to reprint', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/reprint`,
      headers: { cookie: receptionCookie, 'idempotency-key': newId() },
      payload: { date: D, stationId: till1.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DAY_NOT_CLOSED');
  });

  it('the closed day is frozen: a later resolution is refused', async () => {
    const res = await resolve(receptionCookie, { date: Y, kind: 'band', subjectId: group.adult, reason: 'gate_fault' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DAY_CLOSED');
  });
});
