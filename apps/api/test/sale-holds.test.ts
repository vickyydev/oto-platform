import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  band,
  branch,
  member,
  sale,
  saleHold,
  station,
  ticketPackage,
} from '@oto/db';
import { HELD_SALE_NOT_COLLECTED, addDaysToIsoDate, isoDateInTz, newId, type EndOfDayRecord } from '@oto/shared';
import { runHeldSalesMidnight } from '../src/services/sale-holds';
import {
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-774 — HOLD SALE AND SAVE AS PARTLY PAID.
 *
 * Every rule goes in through the routes a till calls, with real sessions at
 * two tills of the same branch, and is read back out of Postgres: a sale is
 * parked with nothing issued, the list is the branch's, another till takes it
 * back and only the balance is asked for, bands and the receipt come only when
 * the balance reaches zero, a held sale nobody came back for is voided at
 * MIDNIGHT (driven here by the job's own clock, never waited for) while a
 * part-paid one is flagged and never voided, and the End of Day refuses to
 * close over a part-paid sale with a message that names it.
 */

let ctx: TestContext;
let till1Cookie: string;
let till2Cookie: string;
let managerCookie: string;
let branchId: string;
let timezone: string;
let till1: string;
let till2: string;
let twoHoursId: string;
let jamesId: string;

const cart = (saleId: string): Record<string, unknown> => ({
  id: saleId,
  stationId: till1,
  memberId: jamesId,
  lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
  finalise: true,
});

async function ringUp(): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie: till1Cookie }, payload: cart(saleId) });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().outstandingSatang as number };
}

const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie, 'idempotency-key': newId() }, payload });

const hold = (cookie: string, saleId: string, body: Record<string, unknown>) =>
  post(cookie, `/sales/${saleId}/hold`, body);
const resume = (cookie: string, saleId: string, body: Record<string, unknown> = {}) =>
  post(cookie, `/sales/${saleId}/resume`, body);
const payCash = (cookie: string, saleId: string, amountSatang: number) =>
  post(cookie, `/sales/${saleId}/finalise`, { method: 'cash', kind: 'cash', amountSatang, tenderedSatang: amountSatang });
const heldList = (cookie: string) =>
  ctx.app.inject({ method: 'GET', url: `/sales/held?branchId=${branchId}`, headers: { cookie } });

async function saleRow(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  return row!;
}
async function bandsOf(saleId: string) {
  return ctx.db.select().from(band).where(eq(band.saleId, saleId));
}
async function auditsOf(saleId: string, action: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, action)));
}

/** The first instant of the calendar day after `at`, in the branch's timezone (no DST in Bangkok). */
function nextMidnight(at: Date): Date {
  expect(timezone).toBe('Asia/Bangkok');
  return new Date(`${addDaysToIsoDate(isoDateInTz(at, timezone), 1)}T00:00:00+07:00`);
}

beforeAll(async () => {
  ctx = await createTestContext();
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  timezone = hkt.timezone;
  const tills = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  till1 = tills.find((s) => s.codePrefix === 'T1')!.id;
  till2 = tills.find((s) => s.codePrefix === 'T2')!.id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const members = await ctx.db.select().from(member).where(eq(member.operatorId, hkt.operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  till1Cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await takeStation(ctx.app, till1Cookie, till1);
  till2Cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await takeStation(ctx.app, till2Cookie, till2);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  await takeStation(ctx.app, managerCookie, till1);
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('Hold sale: parked under a name, nothing issued, resumed at another till', () => {
  let saleId: string;
  let owed: number;

  it('parks the whole sale with its name and note, and issues nothing while it waits', async () => {
    ({ saleId, owed } = await ringUp());
    const res = await hold(till1Cookie, saleId, { kind: 'held', label: 'ZZ TEST Khun Anna', note: 'Back after lunch' });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json();
    expect(answer.hold).toMatchObject({
      saleId,
      kind: 'held',
      label: 'ZZ TEST Khun Anna',
      note: 'Back after lunch',
      paidSatang: 0,
      balanceSatang: owed,
      heldStation: { id: till1 },
    });
    const row = await saleRow(saleId);
    expect(row.status).toBe('tendering');
    expect(row.receiptNumber).toBeNull();
    expect(await bandsOf(saleId)).toHaveLength(0);
    expect(await auditsOf(saleId, 'sale.hold')).toHaveLength(1);
  });

  it('is on the Held sales list every till at the branch reads, and marked on the sale list', async () => {
    const list = await heldList(till2Cookie);
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json();
    expect(body.sales.map((s: { saleId: string }) => s.saleId)).toContain(saleId);
    expect(body.counts.held).toBeGreaterThanOrEqual(1);
    // The left-behind card reads this and never offers a held sale back to its screen.
    const open = await ctx.app.inject({
      method: 'GET',
      url: `/sales?branchId=${branchId}&stationId=${till1}&status=tendering`,
      headers: { cookie: till1Cookie },
    });
    const listed = open.json().sales.find((s: { id: string }) => s.id === saleId);
    expect(listed.hold).toMatchObject({ kind: 'held', label: 'ZZ TEST Khun Anna' });
  });

  it('refuses a second hold, and a tender taken without resuming, each with its reason', async () => {
    const again = await hold(till2Cookie, saleId, { kind: 'held', label: 'Someone else' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'SALE_ALREADY_HELD' });
    expect(again.json().error.message).toContain('ZZ TEST Khun Anna');

    const pay = await payCash(till1Cookie, saleId, owed);
    expect(pay.statusCode).toBe(409);
    expect(pay.json().error.code).toBe('SALE_HELD');
    expect(pay.json().error.message).toBe(
      'This sale is parked in Held sales under ZZ TEST Khun Anna — resume it from Held sales on this till to take payment.',
    );
    expect((await saleRow(saleId)).status).toBe('tendering');
  });

  it('another till at the branch resumes it: the sale moves there and a second resume is told who took it', async () => {
    const res = await resume(till2Cookie, saleId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ saleId, stationId: till2, kind: 'held', paidSatang: 0, balanceSatang: owed });
    expect((await saleRow(saleId)).stationId).toBe(till2);
    const [ended] = await ctx.db.select().from(saleHold).where(eq(saleHold.saleId, saleId));
    expect(ended).toMatchObject({ releasedReason: 'resumed', resumedStationId: till2 });
    expect(await auditsOf(saleId, 'sale.hold.resume')).toHaveLength(1);

    const second = await resume(till1Cookie, saleId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SALE_HOLD_RESUMED');
    expect(second.json().error.message).toContain('Counter 2');
    expect((await heldList(till1Cookie)).json().sales.map((s: { saleId: string }) => s.saleId)).not.toContain(saleId);
  });

  it('bands and the receipt come when the balance is paid, at the till that took it', async () => {
    const res = await payCash(till2Cookie, saleId, owed);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().finalised).toBe(true);
    const row = await saleRow(saleId);
    expect(row.status).toBe('finalised');
    expect(row.receiptNumber).toMatch(/^T2-/);
    expect((await bandsOf(saleId)).length).toBeGreaterThan(0);
  });
});

describe('Save as partly paid: the balance only, and nothing issued until it is zero', () => {
  let saleId: string;
  let owed: number;
  const part = 20_000;

  it('takes a part payment and issues nothing', async () => {
    ({ saleId, owed } = await ringUp());
    const res = await payCash(till1Cookie, saleId, part);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ finalised: false, outstandingSatang: owed - part });
    expect(await bandsOf(saleId)).toHaveLength(0);
    expect((await saleRow(saleId)).receiptNumber).toBeNull();
  });

  it('refuses Hold sale on money already taken, and Save as partly paid on a sale with none', async () => {
    const wrong = await hold(till1Cookie, saleId, { kind: 'held', label: 'ZZ TEST Khun Ben' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toMatchObject({
      code: 'SALE_PART_PAID',
      message: '฿200 has already been paid on this sale — save it as partly paid instead.',
    });
    const fresh = await ringUp();
    const none = await hold(till1Cookie, fresh.saleId, { kind: 'part_paid', label: 'ZZ TEST Nobody' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatchObject({
      code: 'NOTHING_PAID',
      message: 'Nothing has been paid on this sale yet — take a part payment first, or hold the sale.',
    });
    const blank = await hold(till1Cookie, fresh.saleId, { kind: 'held', label: '   ' });
    expect(blank.statusCode).toBe(400);
    await post(till1Cookie, `/sales/${fresh.saleId}/void`, { reason: 'ZZ TEST tidy' });
  });

  it('parks it showing the amount paid and the balance', async () => {
    const res = await hold(till1Cookie, saleId, { kind: 'part_paid', label: 'ZZ TEST Khun Ben', actionId: `hold-${saleId}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().hold).toMatchObject({ kind: 'part_paid', paidSatang: part, balanceSatang: owed - part });
    // The same press again answers the hold it made.
    const replay = await hold(till1Cookie, saleId, { kind: 'part_paid', label: 'ZZ TEST Khun Ben', actionId: `hold-${saleId}` });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replay: true, hold: { holdId: res.json().hold.holdId } });
    const listed = (await heldList(till2Cookie)).json().sales.find((s: { saleId: string }) => s.saleId === saleId);
    expect(listed).toMatchObject({ kind: 'part_paid', paidSatang: part, balanceSatang: owed - part });
  });

  it('resumed at another till, it asks for the balance only; bands come at zero', async () => {
    const res = await resume(till2Cookie, saleId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'part_paid', paidSatang: part, balanceSatang: owed - part });
    const tooMuch = await payCash(till2Cookie, saleId, owed);
    expect(tooMuch.statusCode).toBeGreaterThanOrEqual(400);
    expect(await bandsOf(saleId)).toHaveLength(0);
    const rest = await payCash(till2Cookie, saleId, owed - part);
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json().finalised).toBe(true);
    expect((await bandsOf(saleId)).length).toBeGreaterThan(0);
  });
});

describe('cancelling a held or part-paid sale', () => {
  it('a held sale voided from the list leaves Held sales', async () => {
    const { saleId } = await ringUp();
    await hold(till1Cookie, saleId, { kind: 'held', label: 'ZZ TEST Khun Cara' });
    const res = await post(till2Cookie, `/sales/${saleId}/void`, { reason: 'Customer left' });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await ctx.db.select().from(saleHold).where(eq(saleHold.saleId, saleId));
    expect(row!.releasedReason).toBe('voided');
  });

  it('a part-paid sale is refunded the normal way, whole, and leaves Held sales', async () => {
    const { saleId } = await ringUp();
    await payCash(till1Cookie, saleId, 10_000);
    await hold(till1Cookie, saleId, { kind: 'part_paid', label: 'ZZ TEST Khun Dan' });
    const refund = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/refunds`,
      headers: { cookie: managerCookie, 'idempotency-key': newId() },
      payload: { mode: 'whole', reason: 'Customer cancelled', actionId: newId() },
    });
    expect(refund.statusCode, refund.body).toBe(200);
    expect((await saleRow(saleId)).status).toBe('voided');
    const [row] = await ctx.db.select().from(saleHold).where(eq(saleHold.saleId, saleId));
    expect(row!.releasedReason).toBe('refunded');
  });
});

describe('midnight: a held sale is voided as not collected, a part-paid one is flagged', () => {
  let heldId: string;
  let partId: string;
  let heldAt: Date;

  it('leaves both alone until the calendar day ends', async () => {
    heldId = (await ringUp()).saleId;
    await hold(till1Cookie, heldId, { kind: 'held', label: 'ZZ TEST Khun Eve' });
    partId = (await ringUp()).saleId;
    await payCash(till1Cookie, partId, 15_000);
    await hold(till1Cookie, partId, { kind: 'part_paid', label: 'ZZ TEST Khun Finn' });
    const [row] = await ctx.db.select().from(saleHold).where(eq(saleHold.saleId, heldId));
    heldAt = row!.heldAt;
    const before = new Date(nextMidnight(heldAt).getTime() - 1000);
    const summary = await runHeldSalesMidnight(ctx.db, { ALERT_FLAP_WINDOW_S: 300 }, before);
    expect(summary).toMatchObject({ voided: 0, flagged: 0 });
    expect((await saleRow(heldId)).status).toBe('tendering');
  });

  it('at 00:00 in the branch the held sale is voided "not collected" by the platform, and logged', async () => {
    const midnight = nextMidnight(heldAt);
    const summary = await runHeldSalesMidnight(ctx.db, { ALERT_FLAP_WINDOW_S: 300 }, midnight);
    expect(summary.voided).toBeGreaterThanOrEqual(1);
    const voided = await saleRow(heldId);
    expect(voided).toMatchObject({ status: 'voided', voidReason: HELD_SALE_NOT_COLLECTED, voidedByAccountId: null });
    const [voidAudit] = await auditsOf(heldId, 'sale.void');
    expect(voidAudit!.actorAccountId).toBeNull();
    const [release] = await auditsOf(heldId, 'sale.hold.release');
    expect(release!.after).toMatchObject({ reason: 'not_collected' });
    const [row] = await ctx.db.select().from(saleHold).where(eq(saleHold.saleId, heldId));
    expect(row!.releasedReason).toBe('not_collected');
  });

  it('the part-paid sale is never voided: it is flagged once and its branch alert opens', async () => {
    const part = await saleRow(partId);
    expect(part.status).toBe('tendering');
    const [row] = await ctx.db
      .select()
      .from(saleHold)
      .where(and(eq(saleHold.saleId, partId), isNull(saleHold.releasedAt)));
    expect(row!.flaggedAt).not.toBeNull();
    expect(await auditsOf(partId, 'sale.hold.flag')).toHaveLength(1);
    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(and(eq(alert.key, `sales.part_paid:${branchId}`), isNull(alert.resolvedAt)));
    expect(raised!.summary).toContain('ZZ TEST Khun Finn');
    // A second tick an hour later flags nothing twice.
    const later = await runHeldSalesMidnight(
      ctx.db,
      { ALERT_FLAP_WINDOW_S: 300 },
      new Date(nextMidnight(heldAt).getTime() + 3_600_000),
    );
    expect(later.flagged).toBe(0);
    expect(await auditsOf(partId, 'sale.hold.flag')).toHaveLength(1);
  });
});

describe('End of Day', () => {
  it('shows the held and part-paid counts, and refuses to close over a part-paid sale with its reason', async () => {
    const { saleId } = await ringUp();
    await payCash(till1Cookie, saleId, 35_000);
    await hold(till1Cookie, saleId, { kind: 'part_paid', label: 'ZZ TEST Khun Gail' });
    const date = (await saleRow(saleId)).businessDate;
    const day = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/end-of-day?date=${date}`,
      headers: { cookie: managerCookie },
    });
    expect(day.statusCode, day.body).toBe(200);
    const record = day.json() as EndOfDayRecord;
    expect(record.openSales!.partPaid).toBeGreaterThanOrEqual(1);
    expect(record.openSales!.rows.find((r) => r.saleId === saleId)).toMatchObject({
      kind: 'part_paid',
      held: true,
      label: 'ZZ TEST Khun Gail',
      paidSatang: 35_000,
    });

    const close = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/end-of-day/close`,
      headers: { cookie: managerCookie, 'idempotency-key': newId() },
      payload: { date, actuals: [], countedSatang: null, floatLeftSatang: null },
    });
    expect(close.statusCode).toBe(409);
    const error = close.json().error;
    expect(error.code).toBe('PART_PAID_SALES');
    expect(error.message).toMatch(/^End of Day cannot close: \d+ sales? (is|are) partly paid — /);
    expect(error.message).toContain('ZZ TEST Khun Gail (in Held sales), ฿350 paid, balance ฿');
    expect(error.message).toContain('Take the balance or refund what was paid, from Held sales on a till, then close the day.');
  });
});
