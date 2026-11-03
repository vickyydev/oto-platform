import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  auditLog,
  branch,
  eventAttendeeLink,
  eventPassHold,
  partyPayment,
  paymentAttempt,
  sale,
  saleLine,
  station,
  stationDevice,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import {
  businessDate,
  newId,
  parseDayStart,
  type EndOfDayRecord,
  type EventAttendeeWriteAnswer,
  type EventDetailAnswer,
  type EventPassOpenAnswer,
  type PartyWriteAnswer,
} from '@oto/shared';
import { boxStoreFor } from '../src/lib/box-store';
import { partyFactsOf } from '../src/services/analytics-parties';
import { attachInProcessBox, provisionVirtualBox } from '../src/services/box';
import { simulateGatewayEvent } from '../src/services/payments/gateway';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-732 — A PASS AND A PARTY'S BALANCE TAKE QR AND CARD AS THE TICKET TILL
 * DOES: money is recorded only when it has really been taken.
 *
 * Driven through the routes the till calls. The gateway is the simulator, signed
 * and delivered through the real notification path; the terminal is the box
 * agent's own simulator over the real command queue, as in
 * `payments-terminal.test.ts`; the OTO App's directory is its own write code
 * against its own tables, as in `events-e2.test.ts`. No real payment is taken.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let reception: string;
let receptionId: string;
let T: string;
let appPool: pg.Pool;
let agent: BoxAgent;

const appTenant = newId();
const appCentral = newId();
const ev = { workshop: newId(), party: newId(), second: newId(), third: newId(), fourth: newId() };
const FEE = 35_000;

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(
    pool: pg.Pool,
    event: AppEvent,
    input: DirectoryAttendeeBody,
  ): Promise<
    | { ok: true; status: number; body: DirectoryAttendeeAnswer }
    | { ok: false; status: number; error: string; message: string }
  >;
}
let appWrites: AppWrites;
const calls: string[] = [];

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body): Promise<DirectoryOutcome<DirectoryAttendeeAnswer>> {
    calls.push(body.id);
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.createEventAttendee(appPool, event, body);
    if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
    return { ok: false, status: outcome.status, code: `OTOAPP_${outcome.error.toUpperCase()}`, message: outcome.message, retryable: outcome.status >= 500 };
  },
  async checkinAttendee() {
    return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_NOT_CONFIGURED', message: 'Not in this suite', retryable: true };
  },
};

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

async function appEvent(e: { id: string; type: string; title: string; total?: number; deposit?: number; weekday?: number; weekend?: number }) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, total_value, prepayment_amount, prepayment_date,
      child_name, parent_name, whatsapp_phone_e164, num_children, num_adults, status, created_at, updated_at)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${T}, '09:00', '15:00',
      ${e.weekday ?? null}, ${e.weekend ?? null}, ${e.total ?? null}, ${e.deposit ?? null}, ${e.deposit ? T : null},
      'Mali', 'Nok', '+66812345678', 12, 10, 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
}

async function call<T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie: reception },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

const routeTill = (routing: Record<string, string>) =>
  ctx.db.update(station).set({ paymentRouting: routing }).where(eq(station.id, till));

function child(name: string) {
  return { name, parentName: 'May', parentPhone: '+66812345678' };
}

function openBody(o: { attendeeId?: string; saleId?: string; name?: string } = {}) {
  return {
    branchId: central,
    stationId: till,
    attendeeId: o.attendeeId ?? newId(),
    saleId: o.saleId ?? newId(),
    actionId: newId(),
    registerProperly: false,
    attendee: child(o.name ?? 'Lin'),
  };
}

const openPass = (body: ReturnType<typeof openBody>, event = ev.workshop) =>
  call<EventPassOpenAnswer>('POST', `/events/${event}/passes/open`, body);

const startQr = (saleId: string) =>
  call<TenderAnswer>('POST', '/payments/attempts', {
    saleId,
    tender: 'qr',
    method: 'promptpay',
    kind: 'qr',
    requestQrPayload: true,
    qrDirection: 'show',
    actionId: newId(),
  });

const startCard = (saleId: string) =>
  call<TenderAnswer>('POST', '/payments/attempts', { saleId, tender: 'card', method: 'card', kind: 'card', actionId: newId() });

interface TenderAnswer {
  route: 'card_terminal' | 'manual' | 'gateway';
  attempt: { id: string; status: string; saleId: string | null; amountSatang: number; approvalCode?: string | null } | null;
  replayed: boolean;
  outstandingSatang: number;
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
}

/** The gateway says it was paid, through the notification path. */
const gatewaySays = (attemptId: string, event: 'paid' | 'decline' | 'expire' = 'paid') =>
  simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId, event, operatorId });

/** The till's confirm: no second tender, only the close (`NO_TENDER` in `api/sales.ts`). */
const closeSale = (saleId: string) =>
  call<{ finalised: boolean; replay: boolean; sale: { status: string; receiptNumber: string | null } }>('POST', `/sales/${saleId}/finalise`, {
    actionId: newId(),
    method: 'none',
    kind: 'other',
    amountSatang: 0,
  });

const passAnswer = (attendeeId: string, event = ev.workshop) =>
  call<EventAttendeeWriteAnswer>('GET', `/events/${event}/passes/${attendeeId}?branchId=${central}`);

async function linkOf(id: string) {
  const [row] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id));
  return row ?? null;
}
async function holdOf(id: string) {
  const [row] = await ctx.db.select().from(eventPassHold).where(eq(eventPassHold.id, id));
  return row ?? null;
}
async function saleOf(id: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, id));
  return row ?? null;
}
const attemptsOfSale = (saleId: string) => ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));

async function endOfDay(): Promise<EndOfDayRecord> {
  const res = await call<EndOfDayRecord>('GET', `/branches/${central}/end-of-day?date=${T}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
const line = (rec: EndOfDayRecord, channel: string) => rec.lines.find((l) => l.channel === channel)?.expectedSatang ?? 0;

const owedOn = async (id: string) => {
  const res = await call<EventDetailAnswer>('GET', `/parties/${id}?branchId=${central}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.event.party!.bill!.outstandingSatang;
};

function tenderBody(o: { paymentId?: string; amount: number; method?: string; kind?: string; expected?: number }) {
  return {
    branchId: central,
    stationId: till,
    paymentId: o.paymentId ?? newId(),
    actionId: newId(),
    amountSatang: o.amount,
    tender: { method: o.method ?? 'promptpay', kind: o.kind ?? 'qr' },
    ...(o.expected !== undefined ? { expectedOutstandingSatang: o.expected } : {}),
  };
}

const startPartyTender = (party: string, body: ReturnType<typeof tenderBody>) =>
  call<TenderAnswer>('POST', `/parties/${party}/payments/tender`, body);

const payParty = (party: string, body: Record<string, unknown>) =>
  call<PartyWriteAnswer>('POST', `/parties/${party}/payments`, body);

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: MERCHANT,
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [som] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionId = som!.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-732')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'ZZ TEST slime workshop', weekday: FEE / 100, weekend: FEE / 100 });
  await appEvent({ id: ev.party, type: 'birthday', title: "ZZ TEST Mali's 6th", total: 12_000, deposit: 3_000 });
  await appEvent({ id: ev.second, type: 'birthday', title: "ZZ TEST Ton's 5th", total: 5_000, deposit: 0 });
  await appEvent({ id: ev.third, type: 'birthday', title: "ZZ TEST Pim's 4th", total: 3_000, deposit: 0 });
  await appEvent({ id: ev.fourth, type: 'birthday', title: "ZZ TEST Noi's 7th", total: 2_000, deposit: 0 });
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;

  agent = createBoxAgent({
    apiBaseUrl: 'http://terminal.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-terminal-732',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 300_000);

afterAll(async () => {
  agent?.stop();
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(async () => {
  await routeTill({ qr: 'gateway', card: 'card_terminal' });
});

/** The box works through what it has been given, the receipts queued by earlier sales included. */
async function runBox() {
  for (let round = 0; round < 10; round += 1) {
    if ((await agent.runPendingCommands()) === 0) return;
  }
}

/** The simulated terminal this till's card goes to, told what to do next. */
async function cardWill(outcome: 'approved' | 'declined') {
  const [row] = await ctx.db
    .select({ deviceId: stationDevice.deviceId })
    .from(stationDevice)
    .where(and(eq(stationDevice.stationId, till), eq(stationDevice.role, 'card_terminal')));
  const applied = agent.terminal()?.setOutcome(row!.deviceId, outcome);
  expect(applied).toBe(true);
}

// =============================================================================
// An event pass
// =============================================================================

describe('an event pass paid by QR', () => {
  const attendeeId = newId();
  const saleId = newId();
  let attemptId: string;
  let promptpayBefore: number;
  let callsBefore: number;

  it('rings the sale up and holds the child: no money, no roster entry, nothing sent to the OTO App', async () => {
    promptpayBefore = line(await endOfDay(), 'promptpay');
    callsBefore = calls.length;
    const res = await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Lin' }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ attendeeId, replayed: false, sale: { id: saleId, status: 'tendering', totals: { grossSatang: FEE } } });
    expect(await linkOf(attendeeId)).toBeNull();
    expect(await holdOf(attendeeId)).toMatchObject({ saleId, status: 'pending', priceSnapshotSatang: FEE, accountId: receptionId });
    expect((await saleOf(saleId))!.receiptNumber).toBeNull();
    expect(calls.length).toBe(callsBefore);
    const [audit] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.pass_open'), eq(auditLog.entityId, attendeeId)));
    expect(audit!.after).toMatchObject({ saleId, priceSatang: FEE });
  });

  it('the same attendee id again is the same sale, with one hold', async () => {
    const res = await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Lin' }));
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body).toMatchObject({ replayed: true, sale: { id: saleId } });
    expect(await ctx.db.select().from(eventPassHold).where(eq(eventPassHold.saleId, saleId))).toHaveLength(1);
  });

  it('asks the gateway: a real code, shown pending, and still nothing recorded as paid', async () => {
    const res = await startQr(saleId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.route).toBe('gateway');
    expect(res.body.qrPayload).toBeTruthy();
    expect(res.body.expiresAt).toBeTruthy();
    expect(res.body.attempt).toMatchObject({ status: 'sent_to_terminal', amountSatang: FEE, saleId });
    attemptId = res.body.attempt!.id;
    const [row] = await attemptsOfSale(saleId);
    expect(row!.paidAt).toBeNull();
    expect(row!.invoiceNo).toBeTruthy();
    expect((await saleOf(saleId))!.status).toBe('tendering');
    expect(await linkOf(attendeeId)).toBeNull();
    const asked = await passAnswer(attendeeId);
    expect(asked.status).toBe(409);
    expect((asked.body as unknown as { error: { code: string } }).error.code).toBe('EVENT_PASS_NOT_PAID');
    expect(line(await endOfDay(), 'promptpay')).toBe(promptpayBefore);
  });

  it('the gateway confirms: paid, one sale closed and numbered, the child on the roster, the OTO App told, with no till in the path', async () => {
    const outcome = await gatewaySays(attemptId);
    expect(outcome.webhookOutcome).toBeTruthy();
    const [row] = await attemptsOfSale(saleId);
    expect(row).toMatchObject({ status: 'approved', amountSatang: FEE });
    expect(row!.paidAt).not.toBeNull();
    const closed = await saleOf(saleId);
    expect(closed!.status).toBe('finalised');
    expect(closed!.receiptNumber).toBeTruthy();
    const link = await linkOf(attendeeId);
    const [soldLine] = await ctx.db.select().from(saleLine).where(and(eq(saleLine.saleId, saleId), eq(saleLine.cartLineId, attendeeId)));
    expect(link).toMatchObject({ saleId, saleLineId: soldLine!.id, billing: 'sale', priceSnapshotSatang: FEE, accountId: receptionId, syncState: 'synced' });
    expect(await holdOf(attendeeId)).toMatchObject({ status: 'applied' });
    expect(calls.filter((id) => id === attendeeId)).toHaveLength(1);
    const [audit] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.pass_sell'), eq(auditLog.entityId, attendeeId)));
    expect(audit!.after).toMatchObject({ saleId, billing: 'sale', receiptNumber: closed!.receiptNumber });
  });

  it('the till then reads what it came to; its close and a repeat write nothing more', async () => {
    const closeAgain = await closeSale(saleId);
    expect(closeAgain.status, JSON.stringify(closeAgain.body)).toBe(200);
    expect(closeAgain.body).toMatchObject({ sale: { status: 'finalised' } });
    const read = await passAnswer(attendeeId);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ attendee: { id: attendeeId, syncState: 'synced' }, sale: { id: saleId, status: 'finalised', grossSatang: FEE } });
    const again = await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Lin' }));
    expect(again.body).toMatchObject({ replayed: true, sale: { id: saleId, status: 'finalised' } });
    expect(await attemptsOfSale(saleId)).toHaveLength(1);
    expect(calls.filter((id) => id === attendeeId)).toHaveLength(1);
  });

  it('counts where any QR on a sale counts', async () => {
    expect(line(await endOfDay(), 'promptpay')).toBe(promptpayBefore + FEE);
  });
});

describe('a cash pass is unchanged', () => {
  it('sells and records in one press, the child on the roster at once', async () => {
    const attendeeId = newId();
    const saleId = newId();
    const res = await call<EventAttendeeWriteAnswer>('POST', `/events/${ev.workshop}/passes`, {
      ...openBody({ attendeeId, saleId, name: 'ZZ TEST Cash' }),
      tender: { method: 'cash', kind: 'cash', tenderedSatang: FEE },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ replayed: false, attendee: { id: attendeeId, syncState: 'synced' }, sale: { id: saleId, status: 'finalised', grossSatang: FEE } });
    expect(await holdOf(attendeeId)).toBeNull();
    const [row] = await attemptsOfSale(saleId);
    expect(row).toMatchObject({ method: 'cash', status: 'approved', amountSatang: FEE, tenderedSatang: FEE, changeSatang: 0 });
  });
});

describe('a card or QR named on the one-press route', () => {
  it.each([
    ['qr', 'promptpay'],
    ['card', 'card'],
  ])('%s is refused, with nothing written: the call is not confirmation of that money', async (kind, method) => {
    const attendeeId = newId();
    const saleId = newId();
    const res = await call<{ error: { code: string } }>('POST', `/events/${ev.workshop}/passes`, {
      ...openBody({ attendeeId, saleId, name: 'ZZ TEST Refused' }),
      tender: { method, kind },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_PASS_TENDER_ROUTED');
    expect(await saleOf(saleId)).toBeNull();
    expect(await linkOf(attendeeId)).toBeNull();
    expect(await holdOf(attendeeId)).toBeNull();
  });
});

describe('an event pass paid by card', () => {
  it('goes to the terminal, and the child lands with the close that follows the approval', async () => {
    await cardWill('approved');
    const attendeeId = newId();
    const saleId = newId();
    expect((await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Card' }))).status).toBe(200);
    const started = await startCard(saleId);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ route: 'card_terminal', attempt: { status: 'sent_to_terminal', saleId, amountSatang: FEE } });
    expect(await linkOf(attendeeId)).toBeNull();
    await runBox();
    const [row] = await attemptsOfSale(saleId);
    expect(row).toMatchObject({ method: 'card', status: 'approved' });
    const closed = await closeSale(saleId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.finalised).toBe(true);
    expect(await linkOf(attendeeId)).toMatchObject({ saleId, billing: 'sale', syncState: 'synced' });
    expect(await attemptsOfSale(saleId)).toHaveLength(1);
  });

  it('approved with the till gone: the sale closes and the child lands, and a till that comes back finds it done', async () => {
    await cardWill('approved');
    const attendeeId = newId();
    const saleId = newId();
    expect((await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST No Till' }))).status).toBe(200);
    expect((await startCard(saleId)).status).toBe(200);
    expect(await linkOf(attendeeId)).toBeNull();

    // Nobody presses anything more: only the box answers.
    await runBox();
    expect(await saleOf(saleId)).toMatchObject({ status: 'finalised' });
    expect((await saleOf(saleId))!.receiptNumber).toBeTruthy();
    expect(await linkOf(attendeeId)).toMatchObject({ saleId, billing: 'sale', syncState: 'synced' });
    expect(await holdOf(attendeeId)).toMatchObject({ status: 'applied' });
    const [row] = await attemptsOfSale(saleId);
    expect(row).toMatchObject({ method: 'card', status: 'approved' });
    const [sold] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.pass_sell'), eq(auditLog.entityId, attendeeId)));
    expect(sold!.actorAccountId).toBe(receptionId);

    const closed = await closeSale(saleId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ finalised: true, replay: true });
    expect(await attemptsOfSale(saleId)).toHaveLength(1);
    expect((await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.pass_sell'), eq(auditLog.entityId, attendeeId))))).toHaveLength(1);
    const answer = await passAnswer(attendeeId);
    expect(answer.body).toMatchObject({ attendee: { id: attendeeId }, sale: { id: saleId, status: 'finalised' } });
  });

  it('a sale with no pass on it is still closed by its till', async () => {
    await cardWill('approved');
    const attendeeId = newId();
    const saleId = newId();
    expect((await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Released' }))).status).toBe(200);
    // The same sale with its hold let go, as a ticket sale has none: nothing here to land.
    await ctx.db.update(eventPassHold).set({ status: 'released' }).where(eq(eventPassHold.id, attendeeId));
    expect((await startCard(saleId)).status).toBe(200);
    await runBox();
    const [row] = await attemptsOfSale(saleId);
    expect(row).toMatchObject({ method: 'card', status: 'approved' });
    expect(await saleOf(saleId)).toMatchObject({ status: 'tendering' });
    expect(await linkOf(attendeeId)).toBeNull();
    expect((await closeSale(saleId)).body.finalised).toBe(true);
  });

  it('a decline leaves the sale unpaid and no child; cash then pays the same sale, once', async () => {
    await cardWill('declined');
    const attendeeId = newId();
    const saleId = newId();
    const body = openBody({ attendeeId, saleId, name: 'ZZ TEST Declined' });
    expect((await openPass(body)).status).toBe(200);
    const started = await startCard(saleId);
    expect(started.status).toBe(200);
    await runBox();
    const [declined] = await attemptsOfSale(saleId);
    expect(declined!.status).toBe('declined');
    expect((await saleOf(saleId))!.status).toBe('tendering');
    expect(await linkOf(attendeeId)).toBeNull();

    const cash = await call<EventAttendeeWriteAnswer>('POST', `/events/${ev.workshop}/passes`, {
      ...body,
      actionId: newId(),
      tender: { method: 'cash', kind: 'cash', tenderedSatang: FEE },
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(cash.body).toMatchObject({ attendee: { id: attendeeId, syncState: 'synced' }, sale: { id: saleId, status: 'finalised' } });
    const attempts = await attemptsOfSale(saleId);
    expect(attempts.map((a) => a.status).sort()).toEqual(['approved', 'declined']);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(1);
  });

  it('a station that keys cards in opens nothing until the slip is typed in', async () => {
    await routeTill({ qr: 'gateway', card: 'manual' });
    const attendeeId = newId();
    const saleId = newId();
    expect((await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Slip' }))).status).toBe(200);
    const started = await startCard(saleId);
    expect(started.body).toMatchObject({ route: 'manual', attempt: null });
    expect(await attemptsOfSale(saleId)).toHaveLength(0);
    const keyed = await call<{ attempt: { status: string }; outstandingSatang: number }>('POST', '/payments/manual', {
      saleId,
      method: 'card',
      kind: 'card',
      approvalCode: '123456',
      tid: 'TID1',
      actionId: newId(),
    });
    expect(keyed.status, JSON.stringify(keyed.body)).toBe(200);
    expect(keyed.body.outstandingSatang).toBe(0);
    expect((await closeSale(saleId)).body.finalised).toBe(true);
    expect(await linkOf(attendeeId)).toMatchObject({ saleId, billing: 'sale' });
  });
});

describe('a pass whose QR is walked away from', () => {
  it('cancelled, then voided: no money, no roster entry, and its ids are spent', async () => {
    const attendeeId = newId();
    const saleId = newId();
    const body = openBody({ attendeeId, saleId, name: 'ZZ TEST Walked' });
    expect((await openPass(body)).status).toBe(200);
    const started = await startQr(saleId);
    const attemptId = started.body.attempt!.id;
    const cannotVoid = await call<{ error: { code: string } }>('POST', `/sales/${saleId}/void`, { reason: 'ZZ TEST walked away' });
    expect(cannotVoid.status).toBe(409);
    expect(cannotVoid.body.error.code).toBe('PAYMENT_IN_FLIGHT');
    const cancelled = await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${attemptId}/cancel`, {});
    expect(cancelled.body.attempt.status).toBe('cancelled');
    const voided = await call<{ sale: { status: string } }>('POST', `/sales/${saleId}/void`, { reason: 'ZZ TEST walked away' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.sale.status).toBe('voided');
    expect(await holdOf(attendeeId)).toMatchObject({ status: 'released' });
    expect(await linkOf(attendeeId)).toBeNull();
    const read = await passAnswer(attendeeId);
    expect(read.status).toBe(409);
    expect((read.body as unknown as { error: { code: string } }).error.code).toBe('EVENT_PASS_RELEASED');
    const again = await openPass(body);
    expect(again.status).toBe(409);
    expect((again.body as unknown as { error: { code: string } }).error.code).toBe('EVENT_PASS_RELEASED');
  });
});

// =============================================================================
// A party's balance
// =============================================================================

describe('a pass whose QR waits for a person', () => {
  async function flagged(name: string) {
    const attendeeId = newId();
    const saleId = newId();
    expect((await openPass(openBody({ attendeeId, saleId, name }))).status).toBe(200);
    const started = await startQr(saleId);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const attemptId = started.body.attempt!.id;
    const late = await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId, event: 'late_paid', operatorId });
    expect(late.webhookOutcome).toBe('late_paid');
    const [row] = await attemptsOfSale(saleId);
    expect(row!.status).toBe('awaiting_staff_confirmation');
    expect(await saleOf(saleId)).toMatchObject({ status: 'tendering' });
    expect(await linkOf(attendeeId)).toBeNull();
    return { attendeeId, saleId, attemptId };
  }

  it('Money taken closes the sale and lands the child, whoever is at the till', async () => {
    const { attendeeId, saleId, attemptId } = await flagged('ZZ TEST Late Paid');
    const said = await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${attemptId}/confirm`, { took: true, note: 'Saw the bank slip' });
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    expect(said.body.attempt.status).toBe('approved');
    expect(await saleOf(saleId)).toMatchObject({ status: 'finalised' });
    expect(await linkOf(attendeeId)).toMatchObject({ saleId, billing: 'sale', syncState: 'synced' });
    const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
    expect(row!.staffConfirmedByAccountId).toBe(receptionId);
  });

  it('No money taken leaves the sale unpaid with no child, free to be voided or paid another way', async () => {
    const { attendeeId, saleId, attemptId } = await flagged('ZZ TEST Not Paid');
    const said = await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${attemptId}/confirm`, { took: false, note: 'Nothing on the bank slip' });
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    expect(said.body.attempt.status).toBe('declined');
    expect(await saleOf(saleId)).toMatchObject({ status: 'tendering' });
    expect(await linkOf(attendeeId)).toBeNull();
    const voided = await call<{ sale: { status: string } }>('POST', `/sales/${saleId}/void`, { reason: 'Event pass left unpaid at the till', actionId: newId() });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await holdOf(attendeeId)).toMatchObject({ status: 'released' });
  });
});

describe('a pass whose QR runs out', () => {
  it('leaves the sale open and nobody on the roster; a new QR on the same sale can still pay it', async () => {
    const attendeeId = newId();
    const saleId = newId();
    expect((await openPass(openBody({ attendeeId, saleId, name: 'ZZ TEST Expired' }))).status).toBe(200);
    const first = await startQr(saleId);
    await gatewaySays(first.body.attempt!.id, 'expire');
    const [closed] = await attemptsOfSale(saleId);
    expect(closed!.status).toBe('cancelled');
    expect((await saleOf(saleId))!.status).toBe('tendering');
    expect(await linkOf(attendeeId)).toBeNull();
    const second = await startQr(saleId);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    await gatewaySays(second.body.attempt!.id);
    expect((await saleOf(saleId))!.status).toBe('finalised');
    expect(await linkOf(attendeeId)).toMatchObject({ saleId, billing: 'sale' });
  });
});

describe("a party's balance paid by QR", () => {
  const paymentId = newId();
  let attemptId: string;
  let before: EndOfDayRecord;
  let factsBefore: number;

  it('asks the gateway for a real code; the bill does not move and End of Day counts nothing', async () => {
    before = await endOfDay();
    factsBefore = (await partyFactsOf(ctx.db, { id: central, operatorId, timezone: 'Asia/Bangkok' }, T)).payments.length;
    const owed = await owedOn(ev.party);
    expect(owed).toBe(900_000);
    const res = await startPartyTender(ev.party, tenderBody({ paymentId, amount: 500_000, expected: owed }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.route).toBe('gateway');
    expect(res.body.qrPayload).toBeTruthy();
    expect(res.body.attempt).toMatchObject({ status: 'sent_to_terminal', saleId: null, amountSatang: 500_000 });
    attemptId = res.body.attempt!.id;
    expect(await owedOn(ev.party)).toBe(owed);
    const mid = await endOfDay();
    expect(line(mid, 'party_prepay')).toBe(line(before, 'party_prepay'));
    expect(line(mid, 'promptpay')).toBe(line(before, 'promptpay'));
    expect((await partyFactsOf(ctx.db, { id: central, operatorId, timezone: 'Asia/Bangkok' }, T)).payments).toHaveLength(factsBefore);
    const [audit] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.payment_tender'), eq(auditLog.entityId, paymentId)));
    expect(audit!.after).toMatchObject({ eventId: ev.party, amountSatang: 500_000, attemptId, stationId: till });
  });

  it('the same payment id again is the same tender', async () => {
    const res = await startPartyTender(ev.party, tenderBody({ paymentId, amount: 500_000 }));
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body.attempt!.id).toBe(attemptId);
    expect(res.body.qrPayload).toBeTruthy();
    expect(await ctx.db.select().from(partyPayment).where(eq(partyPayment.id, paymentId))).toHaveLength(1);
  });

  it('asking the record for it before it is paid is refused, and records nothing', async () => {
    const res = await payParty(ev.party, tenderBody({ paymentId, amount: 500_000 }));
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_PAYMENT_NOT_TAKEN');
  });

  it('what it asked for is reserved: a cash press over the rest of the balance is refused', async () => {
    const over = await payParty(ev.party, { ...tenderBody({ amount: 500_000 }), tender: { method: 'cash', kind: 'cash' } });
    expect(over.status).toBe(409);
    expect((over.body as unknown as { error: { code: string } }).error.code).toBe('PAYMENT_IN_FLIGHT');
    expect(await owedOn(ev.party)).toBe(900_000);
    const within = await payParty(ev.party, { ...tenderBody({ amount: 100_000 }), tender: { method: 'cash', kind: 'cash' } });
    expect(within.status, JSON.stringify(within.body)).toBe(200);
    expect(await owedOn(ev.party)).toBe(800_000);
  });

  it('the gateway confirms: the money is on the bill, on the party line and never on the QR line', async () => {
    const midLine = line(await endOfDay(), 'party_prepay');
    await gatewaySays(attemptId);
    const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
    expect(row).toMatchObject({ status: 'approved', saleId: null });
    expect(row!.paidAt).not.toBeNull();
    expect(await owedOn(ev.party)).toBe(300_000);
    const after = await endOfDay();
    expect(line(after, 'party_prepay')).toBe(midLine + 500_000);
    expect(line(after, 'promptpay')).toBe(line(before, 'promptpay'));
    const facts = await partyFactsOf(ctx.db, { id: central, operatorId, timezone: 'Asia/Bangkok' }, T);
    expect(facts.payments.map((p) => p.amountSatang)).toContain(500_000);
  });

  it('the till then reads what it took, under the same id', async () => {
    const res = await payParty(ev.party, tenderBody({ paymentId, amount: 500_000 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body).toMatchObject({ replayed: true, payment: { id: paymentId, amountSatang: 500_000 } });
    expect(await ctx.db.select().from(partyPayment).where(eq(partyPayment.paymentAttemptId, attemptId))).toHaveLength(1);
  });
});

describe("a party's balance paid by card", () => {
  it('goes to the terminal; approved, it is on the bill, with no sale behind it', async () => {
    await cardWill('approved');
    const paymentId = newId();
    const owed = await owedOn(ev.second);
    expect(owed).toBe(500_000);
    const started = await startPartyTender(ev.second, tenderBody({ paymentId, amount: 200_000, method: 'card', kind: 'card', expected: owed }));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ route: 'card_terminal', attempt: { status: 'sent_to_terminal', saleId: null } });
    expect(await owedOn(ev.second)).toBe(owed);
    const attemptId = started.body.attempt!.id;
    await runBox();
    const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
    expect(row).toMatchObject({ method: 'card', status: 'approved', saleId: null });
    expect(await owedOn(ev.second)).toBe(owed - 200_000);
    const [settled] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'payment.settled'), eq(auditLog.entityId, attemptId)));
    expect(settled!.after).toMatchObject({ source: 'terminal', amountSatang: 200_000 });
    const read = await payParty(ev.second, tenderBody({ paymentId, amount: 200_000 }));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ replayed: true, payment: { id: paymentId, amountSatang: 200_000 } });
  });

  it('declined, the bill is untouched and the balance is free for the next press', async () => {
    await cardWill('declined');
    const owed = await owedOn(ev.second);
    const started = await startPartyTender(ev.second, tenderBody({ amount: owed, method: 'card', kind: 'card', expected: owed }));
    expect(started.status).toBe(200);
    await runBox();
    const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, started.body.attempt!.id));
    expect(row!.status).toBe('declined');
    expect(await owedOn(ev.second)).toBe(owed);
    const cash = await payParty(ev.second, { ...tenderBody({ amount: owed }), tender: { method: 'cash', kind: 'cash' } });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(await owedOn(ev.second)).toBe(0);
  });

  it('a station that keys cards in opens nothing; the slip is recorded on the payment route', async () => {
    await routeTill({ qr: 'gateway', card: 'manual' });
    const owed = await owedOn(ev.third);
    const paymentId = newId();
    const started = await startPartyTender(ev.third, tenderBody({ paymentId, amount: 100_000, method: 'card', kind: 'card', expected: owed }));
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ route: 'manual', attempt: null });
    expect(await ctx.db.select().from(partyPayment).where(eq(partyPayment.id, paymentId))).toHaveLength(0);
    const keyed = await payParty(ev.third, {
      ...tenderBody({ paymentId, amount: 100_000, expected: owed }),
      tender: { method: 'card', kind: 'card', approvalCode: '654321', tid: 'TID9' },
    });
    expect(keyed.status, JSON.stringify(keyed.body)).toBe(200);
    expect(await owedOn(ev.third)).toBe(owed - 100_000);
    const [row] = await ctx.db
      .select({ attempt: paymentAttempt })
      .from(partyPayment)
      .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
      .where(eq(partyPayment.id, paymentId));
    expect(row!.attempt).toMatchObject({ provider: 'manual', approvalCode: '654321', tid: 'TID9', status: 'approved' });
    // A slip keyed in is the record of the money, named as the ticket till's manual route names it.
    expect(row!.attempt.payload).toMatchObject({ takenByAccountId: receptionId, manual: { accountId: receptionId } });
    const [recorded] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.payment'), eq(auditLog.entityId, paymentId)));
    expect(recorded!.actorAccountId).toBe(receptionId);
    expect(recorded!.after).toMatchObject({ provider: 'manual', approvalCode: '654321', tid: 'TID9', takenByAccountId: receptionId });
  });
});

describe("what a party's payment route will not take on the till's word", () => {
  it.each([
    ['a QR', { method: 'promptpay', kind: 'qr' }],
    ['a card with no slip', { method: 'card', kind: 'card' }],
    ['a QR with a slip', { method: 'promptpay', kind: 'qr', approvalCode: '111111' }],
  ])('%s is refused with nothing taken', async (_label, tender) => {
    const owed = await owedOn(ev.fourth);
    const paymentId = newId();
    const res = await payParty(ev.fourth, { ...tenderBody({ paymentId, amount: 50_000 }), tender });
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_TENDER_ROUTED');
    expect(await owedOn(ev.fourth)).toBe(owed);
    expect(await ctx.db.select().from(partyPayment).where(eq(partyPayment.id, paymentId))).toHaveLength(0);
  });

  it('cash is unchanged: taken and on the bill in one press', async () => {
    const owed = await owedOn(ev.fourth);
    const paymentId = newId();
    const res = await payParty(ev.fourth, { ...tenderBody({ paymentId, amount: 50_000, expected: owed }), tender: { method: 'cash', kind: 'cash', tenderedSatang: 60_000 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ replayed: false, payment: { amountSatang: 50_000, method: 'cash' } });
    expect(await owedOn(ev.fourth)).toBe(owed - 50_000);
    const [recorded] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.payment'), eq(auditLog.entityId, paymentId)));
    expect(recorded!.after).not.toHaveProperty('approvalCode');
    expect(recorded!.after).not.toHaveProperty('provider');
  });
});

describe('where a party tender is refused before anything is asked of anyone', () => {
  it('a counter set to take no QR', async () => {
    await routeTill({ qr: 'none', card: 'card_terminal' });
    const paymentId = newId();
    const res = await startPartyTender(ev.fourth, tenderBody({ paymentId, amount: 10_000 }));
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('QR_DISABLED_FOR_STATION');
    expect(await ctx.db.select().from(partyPayment).where(eq(partyPayment.id, paymentId))).toHaveLength(0);
  });

  it('a balance that moved since the till showed it', async () => {
    const owed = await owedOn(ev.fourth);
    const paymentId = newId();
    const res = await startPartyTender(ev.fourth, tenderBody({ paymentId, amount: 10_000, expected: owed + 100 }));
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_BALANCE_CHANGED');
    expect(await ctx.db.select().from(partyPayment).where(eq(partyPayment.id, paymentId))).toHaveLength(0);
  });

  it('a tender that is not routed at all', async () => {
    const res = await startPartyTender(ev.fourth, tenderBody({ amount: 10_000, method: 'cash', kind: 'cash' }));
    expect(res.status).toBe(400);
  });

  it('a QR that runs out frees the balance and is never on the bill', async () => {
    const owed = await owedOn(ev.fourth);
    const started = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await gatewaySays(started.body.attempt!.id, 'expire');
    const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, started.body.attempt!.id));
    expect(row!.status).toBe('cancelled');
    expect(await owedOn(ev.fourth)).toBe(owed);
    const read = await payParty(ev.fourth, tenderBody({ paymentId: (await ctx.db.select({ id: partyPayment.id }).from(partyPayment).where(eq(partyPayment.paymentAttemptId, row!.id)))[0]!.id, amount: owed }));
    expect(read.status).toBe(409);
    expect((read.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_PAYMENT_NOT_TAKEN');
  });

  it('a QR paid after its time waits for a person: not on the bill, the balance still spoken for, until they say', async () => {
    const owed = await owedOn(ev.fourth);
    const started = await startPartyTender(ev.fourth, tenderBody({ amount: 100_000, expected: owed }));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const attemptId = started.body.attempt!.id;
    const late = await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId, event: 'late_paid', operatorId });
    expect(late.webhookOutcome).toBe('late_paid');
    const [flagged] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
    expect(flagged!.status).toBe('awaiting_staff_confirmation');
    expect(await owedOn(ev.fourth)).toBe(owed);
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `payments.late_payment:${attemptId}`));
    expect(raised!.summary).toContain("the party's payment screen");
    expect(raised!.summary).not.toContain('sale');
    const blocked = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(blocked.status).toBe(409);
    const refused = (blocked.body as unknown as { error: { code: string; details: { waiting: unknown[] } } }).error;
    expect(refused.code).toBe('PAYMENT_IN_FLIGHT');
    // The till reads this to bring the tender back at any counter, for a person to answer.
    expect(refused.details.waiting).toEqual([expect.objectContaining({ attemptId, status: 'awaiting_staff_confirmation', stationId: till })]);
    const said = await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${attemptId}/confirm`, { took: true });
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    expect(await owedOn(ev.fourth)).toBe(owed - 100_000);
  });

  it('a person saying no money was taken frees the balance, and nothing is on the bill', async () => {
    const owed = await owedOn(ev.fourth);
    const started = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const attemptId = started.body.attempt!.id;
    await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId, event: 'late_paid', operatorId });
    const said = await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${attemptId}/confirm`, { took: false, note: 'Nothing on the bank slip' });
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    expect(said.body.attempt.status).toBe('declined');
    expect(await owedOn(ev.fourth)).toBe(owed);
    const next = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect((await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${next.body.attempt!.id}/cancel`, {})).status).toBe(200);
  });

  it('a QR walked away from frees the balance for the next press', async () => {
    const owed = await owedOn(ev.fourth);
    const started = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const blocked = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(blocked.status).toBe(409);
    expect((blocked.body as unknown as { error: { code: string } }).error.code).toBe('PAYMENT_IN_FLIGHT');
    const cancelled = await call<{ attempt: { status: string } }>('POST', `/payments/attempts/${started.body.attempt!.id}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.attempt.status).toBe('cancelled');
    expect(await owedOn(ev.fourth)).toBe(owed);
    const next = await startPartyTender(ev.fourth, tenderBody({ amount: owed, expected: owed }));
    expect(next.status, JSON.stringify(next.body)).toBe(200);
  });
});
