import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, box, branch, endOfDay, receiptSeries, station } from '@oto/db';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type EndOfDayRecord } from '@oto/shared';
import { payParty } from '../src/services/parties';
import type { OtoAppDirectory } from '../src/services/otoapp-directory';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E4 — FOCUSED RE-REVIEW of the third fix round: END OF DAY'S SILENT ZERO
 * (SCRUM-217; events-kiosk PLAN, the E4 row of §9, §6, Q3's default).
 *
 * The third round answers 503 `EVENTS_SEAM_MISSING` when a day has party money
 * and the OTO App events seam is not on the database, where every seam read
 * answers empty and the day used to read party_prepay ฿0 with a 200 — a zero
 * Close Day would then have stored. These tests attack it from each side:
 *
 *   1. paid parties and no seam: the read is a 503 for every reader, whether
 *      the schema is gone or only its events view; money taken today for a
 *      party held on another day is party money all the same (the read cannot
 *      tell whose day it is without the seam);
 *   2. no party money on the day: the read is a 200 with ฿0 and the day
 *      closes with ฿0, seam or no seam — that zero is the right one;
 *   3. Close Day refused with no seam stores nothing — no closed day, no End
 *      of Day receipt number burnt — and gives its Idempotency-Key back, so
 *      the same close, once the seam is back, closes the day on the right
 *      party_prepay line, on the counter's next receipt number;
 *   4. a closed day reads as it was locked, seam or no seam.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let operatorId: string;
let receptionId: string;
let reception: string;
let manager: string;
let admin: string;
let till: { id: string; codePrefix: string };
let T: string;
let yesterday: string;
let later: string;

const appTenant = newId();
const appCentral = newId();
const ev = { today: newId(), nextWeek: newId() };

const directory: OtoAppDirectory = {
  configured: true,
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

const actor = () => ({
  accountId: receptionId,
  operatorId,
  branchId: central,
  requestId: 'e4-review-silentzero',
  assertBranchAllowed: async () => {},
});
const payAt = (partyId: string, amount: number, now: Date) =>
  payParty(
    { db: ctx.db, directory },
    {},
    actor(),
    partyId,
    {
      branchId: central,
      stationId: till.id,
      paymentId: newId(),
      actionId: newId(),
      amountSatang: amount,
      tender: { method: 'card', kind: 'card' },
    },
    now,
  );
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

// Reception and the manager are Central's; the operator's admin reads any branch's day.
const read = (date: string, branchId = central, cookie = reception) =>
  call<EndOfDayRecord>('GET', branchId === central ? cookie : admin, `/branches/${branchId}/end-of-day?date=${date}`);
const prepayOf = (rec: EndOfDayRecord) => rec.lines.find((l) => l.channel === 'party_prepay')?.expectedSatang ?? 0;

/** With the seam taken away as `how`, run `body`; the seam is always put back. */
async function withoutSeam(how: 'schema' | 'events view', body: () => Promise<void>) {
  if (how === 'schema') await ctx.db.execute(sql`alter schema otoapp_v rename to otoapp_v_away`);
  else await ctx.db.execute(sql`alter view otoapp_v.events rename to events_away`);
  try {
    await body();
  } finally {
    if (how === 'schema') await ctx.db.execute(sql`alter schema otoapp_v_away rename to otoapp_v`);
    else await ctx.db.execute(sql`alter view otoapp_v.events_away rename to events`);
  }
}

const closeBody = (date: string, partyActual: number, cash = 0) => ({
  date,
  stationId: till.id,
  countedSatang: 500_000 + cash,
  floatLeftSatang: 500_000,
  actuals: [{ channel: 'party_prepay', actualSatang: partyActual }],
  vouchers: { handedOut: null, redeemed: null },
});
const closedRows = (date: string) =>
  ctx.db.select().from(endOfDay).where(and(eq(endOfDay.branchId, central), eq(endOfDay.businessDate, date)));
const eodSeries = () =>
  ctx.db
    .select()
    .from(receiptSeries)
    .where(and(eq(receiptSeries.stationId, till.id), eq(receiptSeries.kind, 'end_of_day')));

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  yesterday = addDaysToIsoDate(T, -1);
  later = addDaysToIsoDate(T, 2);
  const [som] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionId = som!.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = { id: t1!.id, codePrefix: t1!.codePrefix! };
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, t1!.boxId!));
  await takeStation(ctx.app, manager, till.id);

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e4-silentzero')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await appEvent(ev.today, "Today's party", T);
  await appEvent(ev.nextWeek, "Next week's party", addDaysToIsoDate(later, 7));

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;

  // Today: a party held today, paid today. Two days on: a party held the week after, paid that day.
  await payAt(ev.today, 70_000, new Date());
  await payAt(ev.nextWeek, 40_000, at(later, '12:00'));
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// 1. Paid parties and no seam: never a 200 with ฿0
// =============================================================================

describe('1 — party money on the day and no seam to place it: a 503, never a silent ฿0', () => {
  it('with the seam: today reads its party money; the day two on reads ฿0 (its party is held the week after)', async () => {
    const today = await read(T);
    expect(today.status, today.raw).toBe(200);
    expect(prepayOf(today.body)).toBe(70_000);
    const on = await read(later);
    expect(on.status, on.raw).toBe(200);
    expect(prepayOf(on.body)).toBe(0);
  });

  it.each(['schema', 'events view'] as const)('the seam %s gone: today is a 503 EVENTS_SEAM_MISSING for reception and the manager alike', async (how) => {
    await withoutSeam(how, async () => {
      for (const cookie of [reception, manager]) {
        const res = await read(T, central, cookie);
        expect(res.status, res.raw).toBe(503);
        expect(JSON.parse(res.raw)).toMatchObject({ error: { code: 'EVENTS_SEAM_MISSING' } });
      }
    });
    expect(prepayOf((await read(T)).body)).toBe(70_000);
  });

  it('money taken for a party held on another day is party money too: with no seam the day cannot say it is not its own — a 503', async () => {
    await withoutSeam('schema', async () => {
      const res = await read(later);
      expect(res.status, res.raw).toBe(503);
      expect(JSON.parse(res.raw)).toMatchObject({ error: { code: 'EVENTS_SEAM_MISSING' } });
    });
    const back = await read(later);
    expect(back.status, back.raw).toBe(200);
    expect(prepayOf(back.body)).toBe(0);
  });
});

// =============================================================================
// 2. No party money on the day: ฿0 is the right answer
// =============================================================================

describe('2 — no party money on the day: a 200 with ฿0, seam or no seam, and the day closes on it', () => {
  it('another branch today, and yesterday here: 200, party_prepay ฿0, with the seam gone', async () => {
    await withoutSeam('schema', async () => {
      const other = await read(T, chalong);
      expect(other.status, other.raw).toBe(200);
      expect(prepayOf(other.body)).toBe(0);
      const before = await read(yesterday);
      expect(before.status, before.raw).toBe(200);
      expect(prepayOf(before.body)).toBe(0);
    });
  });

  it('yesterday closes with the seam gone, on party_prepay ฿0 — the right zero', async () => {
    await withoutSeam('schema', async () => {
      const res = await call<EndOfDayRecord>('POST', manager, `/branches/${central}/end-of-day/close`, closeBody(yesterday, 0), {
        'idempotency-key': `eod-close:${newId()}`,
      });
      expect(res.status, res.raw).toBe(200);
      expect(res.body.status).toBe('closed');
      expect(prepayOf(res.body)).toBe(0);
    });
  });
});

// =============================================================================
// 3. Close Day refused with no seam: nothing stored, nothing burnt, the key given back
// =============================================================================

describe('3 — Close Day with paid parties and no seam stores nothing, and the same close later closes on the right line', () => {
  it('refused 503; no closed day, no receipt number; the seam back, the same Idempotency-Key closes the day on ฿700 with the next receipt number', async () => {
    const key = { 'idempotency-key': `eod-close:${newId()}` };
    const seriesBefore = (await eodSeries()).map((r) => ({ ...r }));
    // The counter's End of Day receipts so far (yesterday's close, when section 2 ran).
    const printedBefore = (
      await ctx.db.select().from(endOfDay).where(eq(endOfDay.receiptStationId, till.id))
    ).length;
    // The close as staff send it: the party money they counted is the ฿700 the till knows.
    const body = closeBody(T, 70_000);

    for (const how of ['schema', 'events view'] as const) {
      await withoutSeam(how, async () => {
        const refused = await call<EndOfDayRecord>('POST', manager, `/branches/${central}/end-of-day/close`, body, key);
        expect(refused.status, refused.raw).toBe(503);
        expect(JSON.parse(refused.raw)).toMatchObject({ error: { code: 'EVENTS_SEAM_MISSING' } });
      });
      expect(await closedRows(T), `${how}: no closed day stored`).toHaveLength(0);
      expect((await eodSeries()).map((r) => ({ ...r })), `${how}: no End of Day receipt number taken`).toEqual(seriesBefore);
      const open = await read(T);
      expect(open.body.status).toBe('open');
      expect(prepayOf(open.body)).toBe(70_000);
    }

    // The seam back: the same request under the same key is run, not a stored 503 replayed.
    const closed = await call<EndOfDayRecord>('POST', manager, `/branches/${central}/end-of-day/close`, body, key);
    expect(closed.status, closed.raw).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.lines.find((l) => l.channel === 'party_prepay')).toMatchObject({
      expectedSatang: 70_000,
      actualSatang: 70_000,
    });
    // The next number on the counter's series: the refused closes took none.
    expect(closed.body.receipt).toMatchObject({
      number: `${till.codePrefix}-EOD-${String(printedBefore + 1).padStart(6, '0')}`,
    });
    const rows = await closedRows(T);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.lines as Array<{ channel: string; expectedSatang: number }>).find((l) => l.channel === 'party_prepay'))
      .toMatchObject({ expectedSatang: 70_000 });
  });
});

// =============================================================================
// 4. A closed day reads as it was locked, seam or no seam (last: today is closed above)
// =============================================================================

describe('4 — a closed day is read as it was locked, with or without the seam', () => {
  it('today, closed on ฿700 of party money: a 200 with its line, the seam gone', async () => {
    await withoutSeam('schema', async () => {
      const res = await read(T);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.status).toBe('closed');
      expect(prepayOf(res.body)).toBe(70_000);
    });
  });
});
