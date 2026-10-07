import { and, desc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  box,
  branch,
  opsRun,
  partyPayment,
  paymentAttempt,
  station,
} from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type EventDetailAnswer,
  type PartyWriteAnswer,
} from '@oto/shared';
import { PARTY_UPDATE_RUN } from '../src/services/parties';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryEventEditAnswer,
  DirectoryEventEditBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E4 — RE-CHECK REVIEW (SCRUM-217; events-kiosk PLAN, the E4 row of §9,
 * §6, Q3's default).
 *
 * The re-check pinned the first fix round's snapshot rule as built: a party
 * payment kept under the date the OTO App held when the money was taken, so a
 * date edit the app took later left the money on the old day's line. The
 * second fix round takes the PROTOTYPE'S RULE instead (the owner's standing
 * ruling): End of Day works a party's day out when it is read, from the date
 * the OTO App holds for the party then, as `getPartiesForDate` does. This file
 * now pins that rule through the ways a till's pending date edit resolves:
 *
 *   - the OTO App TAKES a move to tomorrow later: while the edit is pending
 *     the money is on today's line (the app still holds today); once it is
 *     taken the money leaves today's line with the party, and — taken today
 *     for a party held tomorrow — is on no line (Q3, plan §6), like money
 *     taken today for a party confirmed for tomorrow all along;
 *   - the till pulls a party IN to today, takes its money today, and the OTO
 *     App takes the edit: today's party, paid today, on today's line;
 *   - a replay of either payment, by key and by id, answers the same payment:
 *     the payment carries no party day, so a move cannot change its answer;
 *   - the date the app held when the money was taken stays on the row as a
 *     record of the moment, and nothing counts by it;
 *   - a pending PRICE edit raises the bill the payment is capped against; if
 *     the OTO App refuses it, the party is paid past its bill and the screen
 *     says ฿0 owed (the owner's note; unchanged).
 */

let ctx: TestContext;
let central: string;
let till: string;
let tillBox: string;
let reception: string;
let admin: string;
let T: string;
let appPool: pg.Pool;

const appTenant = newId();
const appCentral = newId();

const ev = {
  /** Confirmed today; the till moves it to tomorrow; the OTO App takes that later. */
  movedOut: newId(),
  /** Confirmed tomorrow, and left there: Q3's plain case. */
  tomorrow: newId(),
  /** Confirmed tomorrow; the till pulls it in to today; the OTO App takes that later. */
  pulledIn: newId(),
  /** Confirmed today, and left there. */
  today: newId(),
  /** Confirmed today at ฿3,000; the till raises the price to ฿4,000; the OTO App refuses. */
  repriced: newId(),
};

// --- The OTO App's directory, from its own source ------------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
  isParty?: boolean;
}
type AppOutcome<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; message: string };
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  editPartyEvent(pool: pg.Pool, event: AppEvent, input: DirectoryEventEditBody): Promise<AppOutcome<DirectoryEventEditAnswer>>;
}
let appWrites: AppWrites;

/** The keys the app's edit body takes (`editBodySchema`, strict). */
const EDIT_KEYS = new Set(['id', 'editedAt', 'fields']);
const EDIT_FIELD_KEYS = new Set([
  'title',
  'status',
  'eventDate',
  'startTime',
  'endTime',
  'location',
  'numChildren',
  'numAdults',
  'childName',
  'kidTurningAge',
  'parentName',
  'whatsappPhone',
  'decoration',
  'activities',
  'totalValueThb',
  'prepaymentAmountThb',
  'prepaymentDate',
]);

type Plan = 'app' | 'unreachable' | 'refused';
const editPlan: Plan[] = [];
const editCalls: Array<{ eventId: string; body: DirectoryEventEditBody }> = [];

function refusalOf<T>(outcome: AppOutcome<T>): DirectoryOutcome<T> {
  if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
  return {
    ok: false,
    status: outcome.status,
    code: `OTOAPP_${outcome.error.toUpperCase()}`,
    message: outcome.message,
    retryable: outcome.status >= 500,
  };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return refusalOf(await appWrites.createEventAttendee(appPool, event, body));
  },
  async editEvent(eventId, body) {
    editCalls.push({ eventId, body });
    for (const key of Object.keys(body)) expect(EDIT_KEYS.has(key), key).toBe(true);
    for (const key of Object.keys(body.fields)) expect(EDIT_FIELD_KEYS.has(key), key).toBe(true);
    const next = editPlan.shift() ?? 'app';
    if (next === 'unreachable') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    if (next === 'refused') {
      return { ok: false, status: 400, code: 'OTOAPP_VALIDATION_ERROR', message: 'The request body is not valid', retryable: false };
    }
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return refusalOf(await appWrites.editPartyEvent(appPool, event, body));
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: {
  id: string;
  type: string;
  title: string;
  date: string;
  total?: number | null;
  deposit?: number | null;
  campEnd?: string | null;
}) {
  // Written as the app writes them: naive UTC, whatever the session's zone.
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      total_value, prepayment_amount, prepayment_date, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, decoration, status, created_at, updated_at)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null}, '13:00', '16:00',
      ${e.total ?? null}, ${e.deposit ?? null}, ${e.deposit ? T : null}, 'Mali', 'Nok', '+66812345678',
      6, 15, 12, 'Party room 1', 'Ocean', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  cookie: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie, ...headers },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

const getParty = (id: string, cookie = reception) =>
  call<EventDetailAnswer>('GET', cookie, `/parties/${id}?branchId=${central}`);

function paymentBody(o: {
  paymentId?: string;
  amount: number;
  method?: string;
  kind?: string;
  tendered?: number;
  expected?: number;
}) {
  return {
    branchId: central,
    stationId: till,
    paymentId: o.paymentId ?? newId(),
    actionId: newId(),
    amountSatang: o.amount,
    tender: {
      method: o.method ?? 'cash',
      kind: o.kind ?? (o.method === 'card' ? 'card' : o.method === 'promptpay' ? 'qr' : 'cash'),
      ...(o.tendered !== undefined ? { tenderedSatang: o.tendered } : {}),
    },
    ...(o.expected !== undefined ? { expectedOutstandingSatang: o.expected } : {}),
  };
}

const pay = (id: string, body: ReturnType<typeof paymentBody>, cookie = reception) =>
  call<PartyWriteAnswer>('POST', cookie, `/parties/${id}/payments`, body);
const patch = (id: string, body: Record<string, unknown>, cookie = reception) =>
  call<PartyWriteAnswer>('PATCH', cookie, `/parties/${id}`, { branchId: central, editId: newId(), ...body });

async function endOfDay(date: string): Promise<EndOfDayRecord> {
  const res = await call<EndOfDayRecord>('GET', reception, `/branches/${central}/end-of-day?date=${date}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
const line = (rec: EndOfDayRecord, channel: string) => rec.lines.find((l) => l.channel === channel)?.expectedSatang ?? 0;

async function attemptsOfParty(eventId: string) {
  return ctx.db
    .select({ attempt: paymentAttempt, payment: partyPayment })
    .from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .where(eq(partyPayment.otoappEventId, eventId));
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillBox = t1!.boxId!;
  // A command is queued only for a box that has registered, as the park's box
  // does when it is first switched on (payments-cash.test.ts).
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, tillBox));

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e4')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  const d1 = addDaysToIsoDate(T, 1);
  await appEvent({ id: ev.movedOut, type: 'birthday', title: "Pim's 4th", date: T, total: 3_000, deposit: 0 });
  await appEvent({ id: ev.tomorrow, type: 'birthday', title: "Ton's 5th", date: d1, total: 3_000, deposit: 0 });
  await appEvent({ id: ev.pulledIn, type: 'birthday', title: "Fah's 7th", date: d1, total: 3_000, deposit: 0 });
  await appEvent({ id: ev.today, type: 'birthday', title: "Mali's 6th", date: T, total: 3_000, deposit: 0 });
  await appEvent({ id: ev.repriced, type: 'birthday', title: "Nam's 3rd", date: T, total: 3_000, deposit: 0 });

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  editPlan.length = 0;
});


const d1 = () => addDaysToIsoDate(T, 1);

/** The Failures page's Retry of one party edit, with what the OTO App does this time. */
async function retryEditOf(editId: string, plan: Plan) {
  const [run] = await ctx.db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, PARTY_UPDATE_RUN), sql`${opsRun.detail}->>'editId' = ${editId}`))
    .orderBy(desc(opsRun.startedAt));
  expect(run, 'the ops run of the edit').toBeDefined();
  editPlan.push(plan);
  const res = await call<{ syncState: string }>('POST', admin, `/ops/runs/${run!.id}/retry`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/**
 * party_prepay for a day, summed straight from the tables: taken that day, for
 * the parties the OTO App holds on that day as it is read now — never the date
 * kept on the payment row.
 */
async function partyPrepayFromTables(date: string): Promise<number> {
  const rows = await ctx.db
    .select({ amount: paymentAttempt.amountSatang, businessDate: paymentAttempt.businessDate, eventId: partyPayment.otoappEventId })
    .from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .where(eq(partyPayment.branchId, central));
  const held = await ctx.db.execute<{ id: string }>(
    sql`select id::text as id from otoapp.core_events where event_date = ${date}`,
  );
  const heldThatDay = new Set(held.rows.map((r) => r.id));
  return rows.filter((r) => r.businessDate === date && heldThatDay.has(r.eventId)).reduce((s, r) => s + r.amount, 0);
}

/** The party's day as the OTO App held it when the money was taken: the row's record of the moment. */
async function keptDateOf(paymentId: string): Promise<string> {
  const [row] = await ctx.db.select({ partyDate: partyPayment.partyDate }).from(partyPayment).where(eq(partyPayment.id, paymentId));
  return row!.partyDate;
}

// =============================================================================
// (2) The day rule after the fix round: a pending date edit the OTO App TAKES later
// =============================================================================

describe("Q3's day rule and a till's pending date edit — the party's day worked out when End of Day is read (the prototype's getPartiesForDate)", () => {
  it('moved out to tomorrow while the OTO App is unreachable, paid today, then taken by the OTO App: the money leaves today’s line with the party', async () => {
    const today = line(await endOfDay(T), 'party_prepay');
    const tomorrow = line(await endOfDay(d1()), 'party_prepay');

    editPlan.push('unreachable');
    const moved = await patch(ev.movedOut, { date: d1() });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.edit).toMatchObject({ syncState: 'pending' });
    expect(moved.body.party).toMatchObject({ startDate: d1() });
    const owed = moved.body.party.party!.bill!.outstandingSatang;
    expect(owed).toBe(300_000);

    const key = `party-payment:${newId()}`;
    const body = paymentBody({ amount: 100_000, method: 'card', expected: owed });
    const paid = await call<PartyWriteAnswer>('POST', reception, `/parties/${ev.movedOut}/payments`, body, { 'idempotency-key': key });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ amountSatang: 100_000, businessDate: T });
    expect(paid.body.payment).not.toHaveProperty('partyDate');

    // While the move is pending the OTO App still holds the party today: today's line.
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today + 100_000);
    expect(line(await endOfDay(T), 'party_prepay')).toBe(await partyPrepayFromTables(T));

    // The OTO App is back and takes the move: the party is held tomorrow.
    expect(await retryEditOf(moved.body.edit!.id, 'app')).toMatchObject({ syncState: 'synced' });
    const shown = (await getParty(ev.movedOut)).body.event;
    expect(shown.startDate).toBe(d1());
    expect(shown.party!.editSync).toBeNull();
    expect(shown.party!.payments).toEqual([paid.body.payment]);

    // A party confirmed for tomorrow all along, paid today: on no line (Q3, plan §6).
    const plain = await pay(ev.tomorrow, paymentBody({ amount: 100_000, method: 'card' }));
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.payment).toMatchObject({ businessDate: T });

    // Two parties, both held tomorrow, both paid ฿1,000 today: one story — on no line of either day.
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today);
    expect(line(await endOfDay(T), 'party_prepay')).toBe(await partyPrepayFromTables(T));
    expect(line(await endOfDay(d1()), 'party_prepay')).toBe(tomorrow);
    // The row still says where the party was when the money was taken; nothing counts by it.
    expect(await keptDateOf(body.paymentId)).toBe(T);

    // A replay of the payment answers the same payment, by key (the stored answer, verbatim) and by id.
    const byKey = await call<PartyWriteAnswer>('POST', reception, `/parties/${ev.movedOut}/payments`, body, { 'idempotency-key': key });
    expect(byKey.status).toBe(200);
    expect(byKey.body).toEqual(paid.body);
    const byId = await pay(ev.movedOut, { ...body, actionId: newId() });
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    expect(byId.body).toMatchObject({ replayed: true });
    expect(byId.body.payment).toEqual(paid.body.payment);
    expect(await attemptsOfParty(ev.movedOut)).toHaveLength(1);
    // ... and the replays moved no money between lines.
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today);
  });

  it("pulled in to today while the OTO App is unreachable, paid today, then taken: today's party, paid today, is on today's line", async () => {
    const today = line(await endOfDay(T), 'party_prepay');

    editPlan.push('unreachable');
    const pulled = await patch(ev.pulledIn, { date: T });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect(pulled.body.party).toMatchObject({ startDate: T });
    const paid = await pay(ev.pulledIn, paymentBody({ amount: 100_000, method: 'card', expected: 300_000 }));
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ businessDate: T });
    // Pending, the OTO App still holds it tomorrow: not on today's line yet.
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today);

    expect(await retryEditOf(pulled.body.edit!.id, 'app')).toMatchObject({ syncState: 'synced' });
    expect((await getParty(ev.pulledIn)).body.event.startDate).toBe(T);
    // Taken: the party is today's, and so is its money.
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today + 100_000);
    expect(await keptDateOf(paid.body.payment!.id)).toBe(d1());

    // A party confirmed for today all along, paid today: on today's line.
    const plain = await pay(ev.today, paymentBody({ amount: 100_000, method: 'card' }));
    expect(plain.body.payment).toMatchObject({ businessDate: T });

    // Two parties, both held today, both paid ฿1,000 today: both count today.
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today + 200_000);
    expect(line(await endOfDay(T), 'party_prepay')).toBe(await partyPrepayFromTables(T));
    expect(line(await endOfDay(d1()), 'party_prepay')).toBe(await partyPrepayFromTables(d1()));
  });
});

// =============================================================================
// (1) Money against a pending edit: a price the OTO App then refuses
// =============================================================================

describe('a payment capped against a pending price edit the OTO App then refuses (owner note)', () => {
  it('the till raises the price ฿3,000 → ฿4,000 and takes ฿4,000; the OTO App refuses: the party is paid ฿1,000 past its bill and shows ฿0 owed', async () => {
    const today = line(await endOfDay(T), 'party_prepay');
    editPlan.push('unreachable');
    const raised = await patch(ev.repriced, { basePriceSatang: 400_000 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body.edit).toMatchObject({ syncState: 'pending' });
    expect(raised.body.party.party!.bill).toMatchObject({ totalSatang: 400_000, outstandingSatang: 400_000 });

    const paid = await pay(ev.repriced, paymentBody({ amount: 400_000, method: 'card', expected: 400_000 }));
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment).toMatchObject({ amountSatang: 400_000 });

    expect(await retryEditOf(raised.body.edit!.id, 'refused')).toMatchObject({ syncState: 'failed' });
    const bill = (await getParty(ev.repriced)).body.event.party!.bill!;
    // The OTO App's price stands; so does the money taken against the till's.
    expect(bill).toMatchObject({ totalSatang: 300_000, paidSatang: 400_000, outstandingSatang: 0 });
    expect(bill.paidSatang - bill.totalSatang).toBe(100_000);
    expect(line(await endOfDay(T), 'party_prepay')).toBe(today + 400_000);
    expect(line(await endOfDay(T), 'party_prepay')).toBe(await partyPrepayFromTables(T));
  });
});
