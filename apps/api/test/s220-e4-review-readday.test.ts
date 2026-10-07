import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, box, branch, partyPayment, paymentAttempt, station } from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type PartyWriteAnswer,
} from '@oto/shared';
import { payParty } from '../src/services/parties';
import type { OtoAppDirectory } from '../src/services/otoapp-directory';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E4 — RE-REVIEW of the second fix round: THE PARTY'S DAY WORKED OUT WHEN
 * END OF DAY IS READ (SCRUM-217; events-kiosk PLAN, the E4 row of §9, §6, Q3's
 * default; the prototype's `getEndOfDay` 2298-2304 over `getPartiesForDate`).
 *
 * The prototype counts a party payment on a day's party_prepay line when the
 * money was taken that day AND the party is held that day as the day is read.
 * These pins move parties in the OTO App itself after their money was taken —
 * the plain case of the rule, with no till edit in the way — and read the
 * lines again:
 *
 *   1. the 05:00 boundary under a move: money taken at 04:30 and 04:59 the
 *      next calendar morning is the finishing day's, money taken at 05:00 the
 *      next day's, and each follows its party's CURRENT date;
 *   2. what the read finds: an archived party still counts on its day, a party
 *      the OTO App moved to another branch counts at neither;
 *   3. a replay after the move answers the payment first given;
 *   4. the seam gone from the database while party money is on the day — the
 *      read has nothing to work a day out from, so it answers 503 and Close
 *      Day closes nothing (pinned `it.fails`, flipped by the third fix round);
 *   5. a closed day keeps the line it was closed with when the party moves
 *      afterwards.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let operatorId: string;
let receptionId: string;
let reception: string;
let admin: string;
let till: string;
let T: string;
let d1: string;

const appTenant = newId();
const appCentral = newId();
const appChalong = newId();

const ev = {
  at0430: newId(),
  at0500: newId(),
  at0459: newId(),
  archived: newId(),
  rebranched: newId(),
  replayed: newId(),
  seam: newId(),
  closed: newId(),
};

const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    // This suite never checks a child in; the seam only has to type.
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async addAttendee() {
    return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true };
  },
  async editEvent() {
    return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true };
  },
};

async function appEvent(id: string, title: string, date: string) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, prepayment_date, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, decoration, status, created_at, updated_at)
    values (
      ${id}, ${appTenant}, ${appCentral}, 'birthday', ${title}, ${date}, '13:00', '16:00',
      10000, 0, null, 'Mali', 'Nok', '+66812345678',
      6, 15, 12, 'Party room 1', 'Ocean', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
}

/** The OTO App's own staff move the party: its date in the app's table, as the app writes it. */
const moveInApp = (id: string, date: string) =>
  ctx.db.execute(sql`update otoapp.core_events set event_date = ${date}, updated_at = (now() at time zone 'UTC') where id = ${id}`);

async function call<R>(
  method: 'GET' | 'POST',
  cookie: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: R; raw: string }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie, ...headers },
  });
  return { status: res.statusCode, body: res.json() as R, raw: res.body };
}

function paymentBody(amount: number, paymentId = newId()) {
  return {
    branchId: central,
    stationId: till,
    paymentId,
    actionId: newId(),
    amountSatang: amount,
    tender: { method: 'card', kind: 'card' },
  };
}

const actor = () => ({
  accountId: receptionId,
  operatorId,
  branchId: central,
  requestId: 'e4-review-readday',
  assertBranchAllowed: async () => {},
});
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);
const payAt = (partyId: string, amount: number, now: Date) =>
  payParty({ db: ctx.db, directory }, {}, actor(), partyId, paymentBody(amount), now);

async function endOfDay(date: string, branchId = central): Promise<EndOfDayRecord> {
  // Reception is Central's; the operator's admin reads any branch's day.
  const cookie = branchId === central ? reception : admin;
  const res = await call<EndOfDayRecord>('GET', cookie, `/branches/${branchId}/end-of-day?date=${date}`);
  expect(res.status, res.raw).toBe(200);
  return res.body;
}
const prepay = async (date: string, branchId = central) =>
  (await endOfDay(date, branchId)).lines.find((l) => l.channel === 'party_prepay')?.expectedSatang ?? 0;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  d1 = addDaysToIsoDate(T, 1);
  expect(hkt!.businessDayStart.startsWith('05:00')).toBe(true);
  const [som] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionId = som!.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, t1!.boxId!));

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e4-readday')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central}),
           (${appChalong}, ${appTenant}, 'Chalong', 'Phuket', ${chalong})`);
  await appEvent(ev.at0430, 'Paid at 04:30', T);
  await appEvent(ev.at0500, 'Paid at 05:00', T);
  await appEvent(ev.at0459, 'Paid at 04:59', d1);
  await appEvent(ev.archived, 'Archived after', T);
  await appEvent(ev.rebranched, 'Moved branch after', T);
  await appEvent(ev.replayed, 'Replayed after', T);
  await appEvent(ev.seam, 'Seam party', T);
  await appEvent(ev.closed, 'Closed day party', T);

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// 1. The 05:00 boundary under a move made in the OTO App
// =============================================================================

describe('1 — the boundary and a move the OTO App makes after the money was taken', () => {
  it("04:30 the next calendar morning, today's party: on today's line; moved to tomorrow, off it — and on no line of tomorrow", async () => {
    const today = await prepay(T);
    const tomorrow = await prepay(d1);
    const { answer } = await payAt(ev.at0430, 10_000, at(d1, '04:30'));
    expect(answer.payment).toMatchObject({ businessDate: T, amountSatang: 10_000 });
    expect(await prepay(T)).toBe(today + 10_000);

    await moveInApp(ev.at0430, d1);
    expect(await prepay(T)).toBe(today);
    expect(await prepay(d1)).toBe(tomorrow);
  });

  it("05:00 the next morning is tomorrow's money: today's party on no line; moved to tomorrow, on tomorrow's line", async () => {
    const today = await prepay(T);
    const tomorrow = await prepay(d1);
    const { answer } = await payAt(ev.at0500, 20_000, at(d1, '05:00'));
    expect(answer.payment).toMatchObject({ businessDate: d1, amountSatang: 20_000 });
    expect(await prepay(T)).toBe(today);
    expect(await prepay(d1)).toBe(tomorrow);

    await moveInApp(ev.at0500, d1);
    expect(await prepay(T)).toBe(today);
    expect(await prepay(d1)).toBe(tomorrow + 20_000);
  });

  it("04:59 the next morning, tomorrow's party: on no line; pulled in to today by the OTO App, on today's line", async () => {
    const today = await prepay(T);
    const tomorrow = await prepay(d1);
    const { answer } = await payAt(ev.at0459, 30_000, at(d1, '04:59'));
    expect(answer.payment).toMatchObject({ businessDate: T });
    expect(await prepay(T)).toBe(today);

    await moveInApp(ev.at0459, T);
    expect(await prepay(T)).toBe(today + 30_000);
    expect(await prepay(d1)).toBe(tomorrow);
  });
});

// =============================================================================
// 2. What the read finds
// =============================================================================

describe('2 — what the read finds at the OTO App', () => {
  it('a party archived in the OTO App after it was paid still counts on its day', async () => {
    const today = await prepay(T);
    await payAt(ev.archived, 40_000, new Date());
    expect(await prepay(T)).toBe(today + 40_000);
    await ctx.db.execute(sql`update otoapp.core_events set is_archived = true where id = ${ev.archived}`);
    expect(await prepay(T)).toBe(today + 40_000);
  });

  it('a party the OTO App moved to another branch after it was paid counts at neither branch (the prototype finds it at neither)', async () => {
    const today = await prepay(T);
    const chalongToday = await prepay(T, chalong);
    await payAt(ev.rebranched, 50_000, new Date());
    expect(await prepay(T)).toBe(today + 50_000);
    await ctx.db.execute(sql`update otoapp.core_events set branch_id = ${appChalong} where id = ${ev.rebranched}`);
    expect(await prepay(T)).toBe(today);
    expect(await prepay(T, chalong)).toBe(chalongToday);
    // The money itself is still taken: the attempt is Central's, on today.
    const [row] = await ctx.db
      .select({ attempt: paymentAttempt })
      .from(partyPayment)
      .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
      .where(eq(partyPayment.otoappEventId, ev.rebranched));
    expect(row!.attempt).toMatchObject({ branchId: central, businessDate: T, amountSatang: 50_000 });
  });
});

// =============================================================================
// 3. A replay after the move
// =============================================================================

describe('3 — a replay after the party moved', () => {
  it('by key: the stored answer verbatim; by id: the same payment; one attempt; the line follows the party', async () => {
    const today = await prepay(T);
    const body = paymentBody(60_000);
    const key = { 'idempotency-key': `party-payment:${body.paymentId}` };
    const first = await call<PartyWriteAnswer>('POST', reception, `/parties/${ev.replayed}/payments`, body, key);
    expect(first.status, first.raw).toBe(200);
    expect(await prepay(T)).toBe(today + 60_000);

    await moveInApp(ev.replayed, d1);
    const byKey = await call<PartyWriteAnswer>('POST', reception, `/parties/${ev.replayed}/payments`, body, key);
    expect(byKey.status, byKey.raw).toBe(200);
    expect(byKey.body).toEqual(first.body);
    const byId = await call<PartyWriteAnswer>('POST', reception, `/parties/${ev.replayed}/payments`, { ...body, actionId: newId() });
    expect(byId.status, byId.raw).toBe(200);
    expect(byId.body).toMatchObject({ replayed: true });
    expect(byId.body.payment).toEqual(first.body.payment);
    const attempts = await ctx.db.select().from(partyPayment).where(eq(partyPayment.otoappEventId, ev.replayed));
    expect(attempts).toHaveLength(1);
    expect(await prepay(T)).toBe(today);
  });
});

// =============================================================================
// 4. The seam gone while party money is on the day
// =============================================================================

describe('4 — the events seam gone from the database while party money is on the day', () => {
  /**
   * The fix round made End of Day depend on the seam at READ time (before it,
   * the line was read off the payment rows alone). It answers 503 when the
   * seam is installed but not granted — "never a silent ฿0" — but when the
   * schema is not there at all `getBranchEvents` answers [] and the day reads
   * party_prepay ฿0 with a 200, and Close Day would store that ฿0. Party money
   * on the day with no seam to read is the same fault as a seam not granted.
   *
   * The third fix round: party money on the day and no seam is a 503, as the
   * seam not granted is (`EVENTS_SEAM_MISSING`), and Close Day, which works the
   * expected side out again, closes nothing.
   */
  it('PINNED (minor, fixed): party money taken today and no seam to read it by — End of Day says so, it never reads ฿0', async () => {
    await payAt(ev.seam, 70_000, new Date());
    const withSeam = await prepay(T);
    expect(withSeam).toBeGreaterThanOrEqual(70_000);
    await ctx.db.execute(sql`alter schema otoapp_v rename to otoapp_v_away`);
    try {
      const res = await call<EndOfDayRecord>('GET', reception, `/branches/${central}/end-of-day?date=${T}`);
      const line = res.status === 200 ? (res.body.lines.find((l) => l.channel === 'party_prepay')?.expectedSatang ?? 0) : null;
      // Either the read refuses (a fault to fix) or it still knows the money: never a silent ฿0.
      expect(res.status === 200 && line === 0, `status ${res.status}, party_prepay ${line}`).toBe(false);
      expect(res.status, res.raw).toBe(503);
      expect(JSON.parse(res.raw)).toMatchObject({ error: { code: 'EVENTS_SEAM_MISSING' } });

      // Close Day works the expected side out again: refused the same way, nothing stored.
      const close = await call<EndOfDayRecord>('POST', admin, `/branches/${central}/end-of-day/close`, {
        date: T,
        countedSatang: 500_000,
        floatLeftSatang: 500_000,
        actuals: [{ channel: 'party_prepay', actualSatang: 0 }],
        vouchers: { handedOut: null, redeemed: null },
      });
      expect(close.status, close.raw).toBe(503);
    } finally {
      await ctx.db.execute(sql`alter schema otoapp_v_away rename to otoapp_v`);
    }
    const open = await endOfDay(T);
    expect(open.status).toBe('open');
    expect(open.lines.find((l) => l.channel === 'party_prepay')!.expectedSatang).toBe(withSeam);
  });
});

// =============================================================================
// 5. A closed day keeps its line (last: it closes today)
// =============================================================================

describe('5 — a closed day keeps the line it was closed with', () => {
  it("today closed with a party's money on party_prepay; the OTO App moves the party after: the closed day is unchanged, tomorrow gains nothing", async () => {
    await payAt(ev.closed, 80_000, new Date());
    const open = await endOfDay(T);
    const line = open.lines.find((l) => l.channel === 'party_prepay')!.expectedSatang;
    expect(line).toBeGreaterThanOrEqual(80_000);
    const cash = open.lines.find((l) => l.channel === 'cash')?.expectedSatang ?? 0;
    const res = await call<EndOfDayRecord>('POST', admin, `/branches/${central}/end-of-day/close`, {
      date: T,
      countedSatang: 500_000 + cash,
      floatLeftSatang: 500_000,
      actuals: [{ channel: 'party_prepay', actualSatang: line }],
      vouchers: { handedOut: null, redeemed: null },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.lines.find((l) => l.channel === 'party_prepay')).toMatchObject({ expectedSatang: line });

    const tomorrow = await prepay(d1);
    await moveInApp(ev.closed, d1);
    const closed = await endOfDay(T);
    expect(closed.status).toBe('closed');
    expect(closed.lines.find((l) => l.channel === 'party_prepay')!.expectedSatang).toBe(line);
    expect(await prepay(d1)).toBe(tomorrow);
  });
});
