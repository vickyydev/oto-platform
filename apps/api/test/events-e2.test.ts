import { and, desc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  branch,
  eventAttendeeLink,
  eventDropInPricing,
  opsRun,
  paymentAttempt,
  sale,
  saleLine,
  station,
} from '@oto/db';
import {
  EventAttendeeWriteAnswerSchema,
  EventDayAnswerSchema,
  addDaysToIsoDate,
  businessDate,
  newId,
  parseDayStart,
  type EventAttendeeWriteAnswer,
  type EventDayAnswer,
  type EventDetailAnswer,
  type EventDropInPricingAnswer,
} from '@oto/shared';
import { resolvePricingScope } from '../src/services/sale';
import { ATTENDEE_CREATE_RUN } from '../src/services/event-writes';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E2 — ATTENDEE CREATE AND PASS SALE (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md, the E2 row of §9: check 2, and
 * the forced write-back failure and its retry from Failures — part of check 7).
 *
 * The OTO App is real here as far as it can be without its server: its tables
 * are built by its own migrations in schema `otoapp`, and the directory the api
 * calls is the app's own write code (`server/directory/eventWrites.ts`, which
 * imports only types) run against them — so "the attendee on the OTO App's own
 * event screen" is read back through the `otoapp_v` views the app publishes.
 * The stub around it can be told to fail, which is how check 7's forced failure
 * is made.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let operatorId: string;
let till: string;
let reception: string;
let manager: string;
let chalongManager: string;
let admin: string;
let T: string;
let mode: 'weekday' | 'weekend';
let appPool: pg.Pool;

const appTenant = newId();
const appCentral = newId();

const ev = {
  camp: newId(),
  openCamp: newId(),
  laterCamp: newId(),
  workshop: newId(),
  free: newId(),
  party: newId(),
  unpriced: newId(),
  archived: newId(),
};

// --- The OTO App's directory, from its own source ------------------------------

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

/** The keys the app's directory body takes (`attendeeBodySchema`, strict). */
const DIRECTORY_KEYS = new Set([
  'id',
  'childFullName',
  'dateOfBirth',
  'ageYears',
  'primaryLanguage',
  'allergies',
  'foodRestrictions',
  'parentName',
  'parentPhone',
  'parentAttending',
  'attendanceDays',
  'notes',
  'bookingId',
  'source',
  'createdBy',
]);

/** How the stub answers its next calls: through to the app, or one of the two failures. */
type Plan = 'app' | 'unreachable' | 'refused' | 'lost_answer';
const plan: Plan[] = [];
const calls: Array<{ eventId: string; body: DirectoryAttendeeBody }> = [];

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body): Promise<DirectoryOutcome<DirectoryAttendeeAnswer>> {
    calls.push({ eventId, body });
    for (const key of Object.keys(body)) expect(DIRECTORY_KEYS.has(key), key).toBe(true);
    const next = plan.shift() ?? 'app';
    if (next === 'unreachable') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    if (next === 'refused') {
      return { ok: false, status: 409, code: 'OTOAPP_ID_IN_USE', message: 'This id already belongs to another attendee', retryable: false };
    }
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.createEventAttendee(appPool, event, body);
    if (next === 'lost_answer') {
      // The app took it; the answer never came back.
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
    return {
      ok: false,
      status: outcome.status,
      code: `OTOAPP_${outcome.error.toUpperCase()}`,
      message: outcome.message,
      retryable: outcome.status >= 500,
    };
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: {
  id: string;
  type: string;
  title: string;
  date: string;
  campEnd?: string | null;
  weekday?: number | null;
  weekend?: number | null;
  archived?: boolean;
}) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, total_value, prepayment_amount,
      child_name, parent_name, num_children, num_adults, status, is_archived)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      '09:00', '15:00', ${e.weekday ?? null}, ${e.weekend ?? null},
      ${e.type === 'birthday' ? 12000 : null}, ${e.type === 'birthday' ? 3000 : null},
      ${e.type === 'birthday' ? 'Mali' : null}, ${e.type === 'birthday' ? 'Nok' : null},
      12, 10, 'upcoming', ${e.archived ?? false})`);
}

async function post<T>(
  cookie: string | null,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

async function get<T>(cookie: string, url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const fee = (weekday: number, weekend: number) => (mode === 'weekend' ? weekend : weekday) * 100;

function child(name: string, extra: Record<string, unknown> = {}) {
  return { name, parentName: 'May', parentPhone: '+66812345678', ...extra };
}

function passBody(o: {
  attendeeId?: string;
  saleId?: string;
  name?: string;
  registerProperly?: boolean;
  tendered?: number;
  amount?: number;
  method?: string;
  extra?: Record<string, unknown>;
}) {
  return {
    branchId: central,
    stationId: till,
    attendeeId: o.attendeeId ?? newId(),
    saleId: o.saleId ?? newId(),
    actionId: newId(),
    registerProperly: o.registerProperly ?? false,
    attendee: child(o.name ?? 'Lin', o.extra),
    tender: {
      method: o.method ?? 'cash',
      kind: o.method === 'card' ? 'card' : 'cash',
      ...(o.amount !== undefined ? { amountSatang: o.amount } : {}),
      ...(o.tendered !== undefined ? { tenderedSatang: o.tendered } : {}),
    },
  };
}

function attendeeBody(o: { attendeeId?: string; name?: string; registerProperly?: boolean; extra?: Record<string, unknown> }) {
  return {
    branchId: central,
    stationId: till,
    attendeeId: o.attendeeId ?? newId(),
    actionId: newId(),
    registerProperly: o.registerProperly ?? false,
    attendee: child(o.name ?? 'Guest', o.extra),
  };
}

/** The app's own rows for one of the till's ids, across both of its attendee tables, read through its views. */
async function appAttendees(eventId: string): Promise<Array<{ id: string; child_name: string; attendance_days: string[]; notes: string | null; parent_attending: boolean }>> {
  const res = await ctx.db.execute<{ id: string; child_name: string; attendance_days: string[]; notes: string | null; parent_attending: boolean }>(
    sql`select id, child_name, attendance_days, notes, parent_attending from otoapp_v.event_attendees where event_id = ${eventId} order by child_name, id`,
  );
  return res.rows;
}

async function linkOf(id: string) {
  const [row] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id));
  return row ?? null;
}

async function counts() {
  const [links] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(eventAttendeeLink);
  const [sales] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(sale).where(eq(sale.branchId, central));
  return { links: links!.n, sales: sales!.n, calls: calls.length };
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  mode = (await resolvePricingScope(ctx.db, central, operatorId, new Date())).pricingMode;
  const [t1] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;

  // The app's pool, as the app runs it: its own tables on its search path.
  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);

  const D = (n: number) => addDaysToIsoDate(T, n);
  await appEvent({ id: ev.camp, type: 'camp', title: 'Ocean camp', date: D(-1), campEnd: D(2), weekday: 600, weekend: 700 });
  await appEvent({ id: ev.openCamp, type: 'camp', title: 'Open camp', date: D(-3), campEnd: null, weekday: 500, weekend: 500 });
  await appEvent({ id: ev.laterCamp, type: 'camp', title: 'Later camp', date: D(5), campEnd: D(8), weekday: 600, weekend: 600 });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Slime workshop', date: T, weekday: 350, weekend: 400 });
  await appEvent({ id: ev.free, type: 'other', title: 'Story time', date: T, weekday: 0, weekend: 0 });
  await appEvent({ id: ev.party, type: 'birthday', title: "Mali's 6th", date: T });
  await appEvent({ id: ev.unpriced, type: 'other', title: 'Parade', date: T });
  await appEvent({ id: ev.archived, type: 'workshop', title: 'Old workshop', date: T, weekday: 100, weekend: 100, archived: true });

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  plan.length = 0;
});

// =============================================================================
// Check 2 — selling a pass for the event
// =============================================================================

describe('check 2 — a pass for the seeded event takes a tender and puts the child on the OTO App', () => {
  const attendeeId = newId();
  const saleId = newId();
  let answer: EventAttendeeWriteAnswer;

  it('sells the pass as an ordinary sale and writes the child to the app under the till\'s id', async () => {
    const before = await counts();
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.workshop}/passes`,
      passBody({
        attendeeId,
        saleId,
        name: 'Lin',
        tendered: 50_000,
        extra: { allergyFlag: true, allergyDetail: 'Peanuts', emergencyContact: 'Joe 081 234 5678', notes: 'Shy' },
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(EventAttendeeWriteAnswerSchema.safeParse(res.body).success).toBe(true);
    answer = res.body;
    const price = fee(350, 400);
    expect(answer).toMatchObject({
      replayed: false,
      attendee: { id: attendeeId, eventId: ev.workshop, billing: 'sale', priceSatang: price, syncState: 'synced', otoappAttendeeId: attendeeId },
      sale: { id: saleId, status: 'finalised', grossSatang: price },
    });
    expect(answer.sale!.receiptNumber).toMatch(/^T1-/);
    const after = await counts();
    expect(after.sales - before.sales).toBe(1);
    expect(after.links - before.links).toBe(1);
    expect(after.calls - before.calls).toBe(1);
  });

  it('the sale is one kid under tickets, the svc id kept, no band and no credit — and no supervision gate', async () => {
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'kids',
      componentKey: 'svc-event-pass',
      label: 'Event entry pass',
      revenueCategory: 'tickets',
      taxableCategory: 'tickets',
      kidCount: 1,
      adultCount: 0,
      ticketPackageId: null,
      stayHours: 0,
      stayDurationLabel: 'One-time',
      cartLineId: attendeeId,
    });
    expect(lines[0]!.payload).toMatchObject({ eventPass: { eventId: ev.workshop, attendeeId } });
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(0);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toMatchObject({ customerTier: 'tourist', salesChannel: 'till', stationId: till, pricingMode: mode });
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempts.map((a) => [a.method, a.amountSatang, a.tenderedSatang, a.changeSatang])).toEqual([
      ['cash', fee(350, 400), 50_000, 50_000 - fee(350, 400)],
    ]);
    const gate = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.supervision_unverified')));
    expect(gate).toHaveLength(0);
  });

  it("the child is on the OTO App's own event, stamped with who added them, the emergency contact kept", async () => {
    const rows = await appAttendees(ev.workshop);
    const lin = rows.filter((r) => r.id === attendeeId);
    expect(lin).toHaveLength(1);
    expect(lin[0]!.child_name).toBe('Lin');
    expect(lin[0]!.notes).toBe('Shy — Emergency contact: Joe 081 234 5678 — Walk-up added by Som (Reception) (today only)');
    // And the till reads it back through the read seam, the allergy with it.
    const { body } = await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`);
    const seen = body.event.attendees!.find((a) => a.id === attendeeId)!;
    expect(seen).toMatchObject({ name: 'Lin', allergy: 'Peanuts', syncState: 'synced', bucket: 'outstanding' });
  });

  it('is recorded: an integration run, the pass sale in Activity with its station and box', async () => {
    const runs = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), sql`${opsRun.detail}->>'linkId' = ${attendeeId}`));
    expect(runs.map((r) => [r.kind, r.outcome, r.stationId, r.branchId])).toEqual([['integration', 'ok', till, central]]);
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.pass_sell'), eq(auditLog.entityId, attendeeId)));
    const [t1] = await ctx.db.select().from(station).where(eq(station.id, till));
    expect(row!.after).toMatchObject({
      eventId: ev.workshop,
      billing: 'sale',
      saleId,
      stationId: till,
      boxId: t1!.boxId,
      receiptNumber: answer.sale!.receiptNumber,
    });
    const saleRows = await ctx.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, saleId));
    // Rung up, paid and its receipt printed, like any ticket sale.
    expect(saleRows.map((r) => r.action).sort()).toEqual(['sale.create', 'sale.finalise', 'sale.print']);
  });

  it('the same attendee id again is the same pass: answered again, no second sale, no second child, no call', async () => {
    const before = await counts();
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.workshop}/passes`,
      passBody({ attendeeId, saleId: newId(), tendered: 50_000 }),
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body).toMatchObject({ replayed: true, attendee: { id: attendeeId, syncState: 'synced' }, sale: { id: saleId } });
    expect(await counts()).toEqual(before);
    expect((await appAttendees(ev.workshop)).filter((r) => r.id === attendeeId)).toHaveLength(1);
  });

  it('an Idempotency-Key replays the stored answer verbatim', async () => {
    const key = newId();
    const body = passBody({ name: 'Key kid', tendered: 50_000 });
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, body, { 'idempotency-key': key });
    const second = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, body, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});

describe('check 2 — no tender, no child (H2)', () => {
  it('a paid event added without a payment is refused: no link, no sale, no directory call', async () => {
    const before = await counts();
    const res = await post<{ error: { code: string } }>(reception, `/events/${ev.workshop}/attendees`, attendeeBody({ name: 'Free rider' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_PASS_NEEDS_PAYMENT');
    expect(await counts()).toEqual(before);
  });

  it('a pass with no tender is not a request at all', async () => {
    const before = await counts();
    const body = passBody({ name: 'No tender' }) as Record<string, unknown>;
    delete body.tender;
    const res = await post(reception, `/events/${ev.workshop}/passes`, body);
    expect(res.status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it('a tender short of the fee writes nothing: the pass is paid in one tender', async () => {
    const before = await counts();
    const res = await post<{ error: { code: string } }>(
      reception,
      `/events/${ev.workshop}/passes`,
      passBody({ name: 'Half', amount: 100, tendered: 100 }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_PASS_PART_PAID');
    expect(await counts()).toEqual(before);
  });

  it('a stale price the till showed is refused, not charged', async () => {
    const before = await counts();
    const res = await post<{ error: { code: string } }>(reception, `/events/${ev.workshop}/passes`, {
      ...passBody({ name: 'Stale' }),
      expectedTotalSatang: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALE_TOTAL_MISMATCH');
    expect(await counts()).toEqual(before);
  });

  it('an event with no entry price is not sold, and an archived one is refused', async () => {
    const before = await counts();
    const res = await post<{ error: { code: string } }>(reception, `/events/${ev.unpriced}/passes`, passBody({}));
    expect(res.body.error.code).toBe('EVENT_NOT_PRICED');
    const archived = await post<{ error: { code: string } }>(reception, `/events/${ev.archived}/passes`, passBody({}));
    expect(archived.body.error.code).toBe('EVENT_ARCHIVED');
    expect(await counts()).toEqual(before);
  });
});

describe('check 2 — the free event and the party walk-up', () => {
  it('a free event creates the attendee with no sale', async () => {
    const attendeeId = newId();
    const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.free}/attendees`, attendeeBody({ attendeeId, name: 'Pim' }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ attendee: { billing: 'free', priceSatang: 0, syncState: 'synced' }, sale: null });
    expect((await appAttendees(ev.free)).map((r) => r.id)).toContain(attendeeId);
    const refused = await post<{ error: { code: string } }>(reception, `/events/${ev.free}/passes`, passBody({}));
    expect(refused.body.error.code).toBe('EVENT_PASS_IS_FREE');
  });

  it('a birthday walk-up adds a party-guest charge to the tab and takes no door payment', async () => {
    const before = await counts();
    const attendeeId = newId();
    const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.party}/attendees`, attendeeBody({ attendeeId, name: 'Ton' }));
    expect(res.status).toBe(200);
    // The seeded HKT party-guest price, the same on both kinds of day (฿450).
    expect(res.body).toMatchObject({ attendee: { billing: 'party_tab', priceSatang: 45_000, syncState: 'synced' }, sale: null });
    const after = await counts();
    expect(after.sales).toBe(before.sales);
    // The party's bill carries it, as the prototype's tab does.
    const { body } = await get<EventDayAnswer>(reception, `/events?branchId=${central}`);
    expect(EventDayAnswerSchema.safeParse(body).success).toBe(true);
    const party = body.events.find((e) => e.id === ev.party)!;
    expect(party.party!.walkUpCharges).toEqual([
      expect.objectContaining({ id: attendeeId, name: 'Ton', amountSatang: 45_000, chargedBy: 'Som (Reception)' }),
    ]);
    expect(party.attendees!.map((a) => a.id)).toContain(attendeeId);
    // A party has no pass.
    const refused = await post<{ error: { code: string } }>(reception, `/events/${ev.party}/passes`, passBody({}));
    expect(refused.body.error.code).toBe('EVENT_PASS_NOT_FOR_PARTY');
  });
});

describe("the camp walk-up's two modes and the note stamp (addEventAttendee)", () => {
  it('today only: the child is registered for today', async () => {
    const attendeeId = newId();
    const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, passBody({ attendeeId, name: 'Today kid', tendered: 100_000 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.attendee).toMatchObject({ attendanceDays: [T], priceSatang: fee(600, 700), syncState: 'synced' });
    const row = (await appAttendees(ev.camp)).find((r) => r.id === attendeeId)!;
    expect(row.attendance_days).toEqual([T]);
    expect(row.notes).toBe('Walk-up added by Som (Reception) (today only)');
    const line = await ctx.db.select().from(saleLine).where(eq(saleLine.cartLineId, attendeeId));
    expect(line[0]).toMatchObject({ componentKey: 'svc-camp-pass', label: 'Camp day pass' });
  });

  it('"Also register for the full camp": every remaining day, today to the last (Q5)', async () => {
    const attendeeId = newId();
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.camp}/passes`,
      passBody({ attendeeId, name: 'Full kid', registerProperly: true, tendered: 100_000 }),
    );
    expect(res.status).toBe(200);
    const days = [0, 1, 2].map((n) => addDaysToIsoDate(T, n));
    expect(res.body.attendee.attendanceDays).toEqual(days);
    // One day's price, once (Q5's default).
    expect(res.body.attendee.priceSatang).toBe(fee(600, 700));
    const row = (await appAttendees(ev.camp)).find((r) => r.id === attendeeId)!;
    expect([...row.attendance_days].sort()).toEqual(days);
    expect(row.notes).toBe('Walk-up added by Som (Reception) (registered for full range)');
  });

  it('an open-ended camp can only be added for today, as the prototype could', async () => {
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.openCamp}/passes`,
      passBody({ name: 'Open kid', registerProperly: true, tendered: 100_000 }),
    );
    expect(res.status).toBe(200);
    expect(res.body.attendee.attendanceDays).toEqual([T]);
  });

  it('a camp that is not running today takes nobody', async () => {
    const before = await counts();
    const res = await post<{ error: { code: string } }>(reception, `/events/${ev.laterCamp}/passes`, passBody({}));
    expect(res.body.error.code).toBe('CAMP_NOT_RUNNING_TODAY');
    expect(await counts()).toEqual(before);
  });

  it("the app's own camp rule: the same child and phone again is merged, and the roster shows them once", async () => {
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, passBody({ name: 'Twin', tendered: 100_000 }));
    const second = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, passBody({ name: 'Twin', tendered: 100_000 }));
    expect(second.status).toBe(200);
    expect(second.body.attendee).toMatchObject({ merged: true, otoappAttendeeId: first.body.attendee.id, syncState: 'synced' });
    const { body } = await get<EventDetailAnswer>(reception, `/events/${ev.camp}?branchId=${central}`);
    expect(body.event.attendees!.filter((a) => a.name === 'Twin')).toHaveLength(1);
  });
});

// =============================================================================
// Check 7 (its write-back part) — a forced failure, and the retry from Failures
// =============================================================================

describe('check 7 — a forced write-back failure is pending, on the roster, and retried from Failures', () => {
  const attendeeId = newId();
  const saleId = newId();

  it('the sale stands and the child waits as pending when the app does not answer', async () => {
    plan.push('unreachable');
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.workshop}/passes`,
      passBody({ attendeeId, saleId, name: 'Nok', tendered: 50_000 }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attendee: { syncState: 'pending', otoappAttendeeId: null }, sale: { id: saleId, status: 'finalised' } });
    expect(res.body.attendee.syncError).toMatch(/OTOAPP_DIRECTORY_UNREACHABLE/);
    expect((await appAttendees(ev.workshop)).filter((r) => r.id === attendeeId)).toHaveLength(0);
  });

  it('the roster shows the child from the POS record, marked pending — never a silent gap', async () => {
    const { body } = await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`);
    const nok = body.event.attendees!.filter((a) => a.id === attendeeId);
    expect(nok).toHaveLength(1);
    expect(nok[0]).toMatchObject({ name: 'Nok', syncState: 'pending', bucket: 'outstanding', source: 'pos' });
  });

  it('Failures groups it as a retryable integration run, and Retry replays the same id', async () => {
    const page = await get<{ groups: Array<{ name: string; kind: string; retryable: boolean; lastRunId: string }> }>(
      admin,
      '/ops/failures?windowHours=1&kind=integration',
    );
    expect(page.status).toBe(200);
    const group = page.body.groups.find((g) => g.name === ATTENDEE_CREATE_RUN)!;
    expect(group).toMatchObject({ kind: 'integration', retryable: true });

    const before = calls.length;
    const retried = await post<{ ok: boolean; outcome: string; syncState: string }>(admin, `/ops/runs/${group.lastRunId}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ ok: true, outcome: 'ok', syncState: 'synced' });
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)!.body.id).toBe(attendeeId);

    expect(await linkOf(attendeeId)).toMatchObject({ syncState: 'synced', otoappAttendeeId: attendeeId, syncAttempts: 2, syncError: null });
    expect((await appAttendees(ev.workshop)).filter((r) => r.id === attendeeId)).toHaveLength(1);
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'ops.run_retry')).orderBy(desc(auditLog.createdAt));
    expect(audit[0]!.after).toMatchObject({ integration: ATTENDEE_CREATE_RUN, linkId: attendeeId, syncState: 'synced' });
  });

  it('a second retry and a till replay change nothing: one sale, one child in the app (H3)', async () => {
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'linkId' = ${attendeeId}`));
    const before = calls.length;
    const again = await post<{ syncState: string }>(admin, `/ops/runs/${run!.id}/retry`, {});
    expect(again.body.syncState).toBe('synced');
    const replay = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, passBody({ attendeeId, saleId: newId() }));
    expect(replay.body).toMatchObject({ replayed: true, sale: { id: saleId } });
    expect(calls.length).toBe(before);
    expect((await appAttendees(ev.workshop)).filter((r) => r.id === attendeeId)).toHaveLength(1);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(1);
  });

  it('an answer lost after the app took the child: shown once, and the retry is a replay in the app', async () => {
    plan.push('lost_answer');
    const attendee = newId();
    const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, passBody({ attendeeId: attendee, name: 'Lost', tendered: 50_000 }));
    expect(res.body.attendee.syncState).toBe('pending');
    // The app has the child; the roster shows them once, still marked pending.
    const { body } = await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`);
    const lost = body.event.attendees!.filter((a) => a.name === 'Lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.syncState).toBe('pending');
    // The till's own retry (the same press again) finishes it, as a replay in the app.
    const replay = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, passBody({ attendeeId: attendee }));
    expect(replay.body).toMatchObject({ replayed: true, attendee: { syncState: 'synced' } });
    expect((await appAttendees(ev.workshop)).filter((r) => r.id === attendee)).toHaveLength(1);
  });

  it('a refusal from the app is failed, not pending, and still offered for a retry', async () => {
    plan.push('refused');
    const attendee = newId();
    const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.free}/attendees`, attendeeBody({ attendeeId: attendee, name: 'Refused' }));
    expect(res.body.attendee).toMatchObject({ syncState: 'failed' });
    expect(res.body.attendee.syncError).toMatch(/OTOAPP_ID_IN_USE/);
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), sql`${opsRun.detail}->>'linkId' = ${attendee}`));
    expect(run).toMatchObject({ kind: 'integration', outcome: 'failed', errorCode: 'OTOAPP_ID_IN_USE' });
    const retried = await post<{ syncState: string }>(admin, `/ops/runs/${run!.id}/retry`, {});
    expect(retried.body.syncState).toBe('synced');
  });
});

// =============================================================================
// Check 7 — one Retry reaches every child an outage left waiting (E2 review, finding 1)
// =============================================================================

describe('check 7 — one Retry from a Failures group sends every child the outage left waiting', () => {
  type RetryAnswer = { ok: boolean; outcome: string; syncState: string; sent: number; synced: number; waiting: number };

  /** The links that still owe the app a write, oldest first. */
  async function waiting(): Promise<string[]> {
    const rows = await ctx.db
      .select({ id: eventAttendeeLink.id })
      .from(eventAttendeeLink)
      .where(sql`${eventAttendeeLink.syncState} <> 'synced'`)
      .orderBy(eventAttendeeLink.createdAt, eventAttendeeLink.id);
    return rows.map((r) => r.id);
  }

  /** The newest failed run of one child — what the page's Retry presses for its group. */
  async function failedRunOf(linkId: string) {
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'linkId' = ${linkId}`))
      .orderBy(desc(opsRun.startedAt));
    return run!;
  }

  /** A pass sold while the app is down: its sale stands and its child waits. */
  async function soldInOutage(name: string): Promise<string> {
    const attendeeId = newId();
    plan.push('unreachable');
    const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, passBody({ attendeeId, name, tendered: 50_000 }));
    expect(res.body.attendee.syncState).toBe('pending');
    return attendeeId;
  }

  it('starts with nothing waiting, so every count below is this block\'s own', async () => {
    expect(await waiting()).toEqual([]);
  });

  it('two children of one outage, one refusal of another kind: the outage\'s Retry sends both of its children and leaves the refusal alone', async () => {
    const first = await soldInOutage('Ploy');
    const second = await soldInOutage('Pim');
    plan.push('refused');
    const refusedId = newId();
    const refused = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.free}/attendees`, attendeeBody({ attendeeId: refusedId, name: 'Fah' }));
    expect(refused.body.attendee.syncState).toBe('failed');
    expect(await waiting()).toEqual([first, second, refusedId]);

    // The page's Retry for the outage's group: its newest run, which names `second`.
    const before = calls.length;
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await failedRunOf(second)).id}/retry`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'ok', syncState: 'synced', sent: 2, synced: 2, waiting: 0 });
    // The pressed run's child first, then the rest oldest first; never the refusal.
    expect(calls.slice(before).map((c) => c.body.id)).toEqual([second, first]);
    expect(await linkOf(first)).toMatchObject({ syncState: 'synced', otoappAttendeeId: first, syncAttempts: 2 });
    expect(await linkOf(second)).toMatchObject({ syncState: 'synced', otoappAttendeeId: second, syncAttempts: 2 });
    expect(await linkOf(refusedId)).toMatchObject({ syncState: 'failed', syncAttempts: 1 });
    expect((await appAttendees(ev.workshop)).filter((r) => r.id === first || r.id === second)).toHaveLength(2);
    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'ops.run_retry')).orderBy(desc(auditLog.createdAt));
    expect(entry!.after).toMatchObject({ integration: ATTENDEE_CREATE_RUN, linkId: second, sent: 2, synced: 2, waiting: 0 });

    // The refusal's own group sends it — the cause fixed at the app, here the stub's next answer.
    const own = await post<RetryAnswer>(admin, `/ops/runs/${(await failedRunOf(refusedId)).id}/retry`, {});
    expect(own.body).toMatchObject({ outcome: 'ok', syncState: 'synced', sent: 1, waiting: 0 });
    expect(await waiting()).toEqual([]);
  });

  it('the app still down: the Retry sends one child, stops, and says how many still wait', async () => {
    const first = await soldInOutage('Nam');
    const second = await soldInOutage('Nan');
    const before = calls.length;
    plan.push('unreachable');
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await failedRunOf(second)).id}/retry`, {});
    expect(res.body).toMatchObject({ ok: true, outcome: 'failed', syncState: 'pending', sent: 1, synced: 0, waiting: 2 });
    expect(calls.length - before).toBe(1);
    expect(await linkOf(first)).toMatchObject({ syncState: 'pending', syncAttempts: 1 });

    // Back up: the same group's Retry finishes both.
    const again = await post<RetryAnswer>(admin, `/ops/runs/${(await failedRunOf(second)).id}/retry`, {});
    expect(again.body).toMatchObject({ outcome: 'ok', sent: 2, synced: 2, waiting: 0 });
    expect(await waiting()).toEqual([]);
  });

  it('a child committed but never sent (the process stopped between the commit and the send) is reached by the next Retry', async () => {
    const stranded = await soldInOutage('Kai');
    // As if the send never ran: no attempt, no error, no run on the Failures page.
    await ctx.db.delete(opsRun).where(sql`${opsRun.detail}->>'linkId' = ${stranded}`);
    await ctx.db
      .update(eventAttendeeLink)
      .set({ syncAttempts: 0, syncError: null, lastSyncAt: null })
      .where(eq(eventAttendeeLink.id, stranded));
    const later = await soldInOutage('Dao');
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await failedRunOf(later)).id}/retry`, {});
    expect(res.body).toMatchObject({ outcome: 'ok', sent: 2, synced: 2, waiting: 0 });
    expect(await linkOf(stranded)).toMatchObject({ syncState: 'synced', syncAttempts: 1 });
  });

  it('bounded, oldest first, and only where the caller may manage ops', async () => {
    const { retryAttendeeWriteBack } = await import('../src/services/event-writes');
    const a = await soldInOutage('A');
    const b = await soldInOutage('B');
    const c = await soldInOutage('C');
    const deps = { db: ctx.db, directory };

    // Reach at another branch only: the pressed child is sent (the route checked
    // its branch), and nobody else at Central is.
    let before = calls.length;
    const narrow = await retryAttendeeWriteBack(deps, {
      operatorId,
      linkId: c,
      errorCode: 'OTOAPP_DIRECTORY_UNREACHABLE',
      reach: { kind: 'branches', branchIds: [chalong] },
    });
    expect(narrow).toMatchObject({ sent: 1, synced: 1, waiting: 0, stoppedEarly: false });
    expect(calls.slice(before).map((x) => x.body.id)).toEqual([c]);
    expect(await waiting()).toEqual([a, b]);

    // A bound of one: the oldest first, and the rest still counted as waiting.
    before = calls.length;
    const bounded = await retryAttendeeWriteBack(deps, {
      operatorId,
      linkId: c,
      errorCode: 'OTOAPP_DIRECTORY_UNREACHABLE',
      reach: { kind: 'operator' },
      limit: 1,
    });
    expect(bounded).toMatchObject({ sent: 1, synced: 1, waiting: 1 });
    expect(calls.slice(before).map((x) => x.body.id)).toEqual([a]);
    expect(await waiting()).toEqual([b]);

    // Another operator's caller reaches nothing of this one.
    await expect(
      retryAttendeeWriteBack(deps, { operatorId: newId(), linkId: b, errorCode: null, reach: { kind: 'operator' } }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const rest = await retryAttendeeWriteBack(deps, { operatorId, linkId: b, errorCode: null, reach: { kind: 'operator' } });
    expect(rest).toMatchObject({ sent: 1, synced: 1, waiting: 0 });
    expect(await waiting()).toEqual([]);
  });
});

describe('who may', () => {
  it('signed out is 401; a role without the permission and another park are refused', async () => {
    const out = await post(null, `/events/${ev.free}/attendees`, attendeeBody({}));
    expect(out.status).toBe(401);
    const otherPark = await post(chalongManager, `/events/${ev.free}/attendees`, attendeeBody({}));
    expect(otherPark.status).toBe(403);
    const otherParkPass = await post(chalongManager, `/events/${ev.workshop}/passes`, passBody({}));
    expect(otherParkPass.status).toBe(403);
  });

  it('only the bundles that sell hold the write permissions', async () => {
    const { ROLE_BUNDLES } = await import('@oto/shared');
    expect(ROLE_BUNDLES.reception).toEqual(expect.arrayContaining(['pos:event:attendee_create', 'pos:event:pass_sell']));
    expect(ROLE_BUNDLES.staff).not.toContain('pos:event:pass_sell');
    expect(ROLE_BUNDLES.reception).not.toContain('admin:event_pricing:manage');
    expect(ROLE_BUNDLES.branch_manager).toContain('admin:event_pricing:manage');
  });
});

describe("the branch's walk-up prices (Q8)", () => {
  it('reads all three, seeded at HKT; a branch nobody priced answers ฿0 and says so', async () => {
    const hkt = await get<EventDropInPricingAnswer>(reception, `/branches/${central}/event-drop-in-pricing`);
    expect(hkt.status).toBe(200);
    expect(hkt.body).toMatchObject({
      configured: true,
      pricing: {
        campDay: { weekday: 60_000, weekend: 60_000 },
        eventDay: { weekday: 35_000, weekend: 35_000 },
        partyGuest: { weekday: 45_000, weekend: 45_000 },
      },
    });
    const chalongPrices = await get<EventDropInPricingAnswer>(chalongManager, `/branches/${chalong}/event-drop-in-pricing`);
    expect(chalongPrices.body).toMatchObject({ configured: false, pricing: { partyGuest: { weekday: 0, weekend: 0 } } });
  });

  it('a manager sets them, audited; reception may not; a negative price is refused', async () => {
    const pricing = {
      campDay: { weekday: 65_000, weekend: 70_000 },
      eventDay: { weekday: 35_000, weekend: 40_000 },
      partyGuest: { weekday: 50_000, weekend: 55_000 },
    };
    const refused = await ctx.app.inject({
      method: 'PUT',
      url: `/branches/${central}/event-drop-in-pricing`,
      headers: { cookie: reception },
      payload: pricing,
    });
    expect(refused.statusCode).toBe(403);
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: `/branches/${central}/event-drop-in-pricing`,
      headers: { cookie: manager },
      payload: { ...pricing, campDay: { weekday: -1, weekend: 0 } },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({
      method: 'PUT',
      url: `/branches/${central}/event-drop-in-pricing`,
      headers: { cookie: manager },
      payload: pricing,
    });
    expect(ok.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(eventDropInPricing).where(eq(eventDropInPricing.branchId, central));
    expect(row).toMatchObject({ campDayWeekendSatang: 70_000, partyGuestWeekdaySatang: 50_000 });
    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'event_pricing.update'))
      .orderBy(desc(auditLog.createdAt));
    expect(entry!.before).toMatchObject({ partyGuest: { weekday: 45_000 } });
    expect(entry!.after).toEqual(pricing);
    // The party walk-up now owes the new price at today's rate mode; a pass still reads its event.
    const walkUp = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.party}/attendees`, attendeeBody({ name: 'Late guest' }));
    expect(walkUp.body.attendee.priceSatang).toBe(mode === 'weekend' ? 55_000 : 50_000);
    const pass = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, passBody({ name: 'Camp kid', tendered: 100_000 }));
    expect(pass.body.attendee.priceSatang).toBe(fee(600, 700));
  });
});

describe('the record of who added whom', () => {
  it('every link names its account, and the walk-up audit names no child', async () => {
    const [me] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
    const links = await ctx.db.select().from(eventAttendeeLink);
    expect(links.length).toBeGreaterThan(5);
    expect(links.every((l) => l.accountId === me!.id || l.accountId !== null)).toBe(true);
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'event.attendee_create'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.stringify(r.after)).not.toMatch(/May|\+668/);
  });
});
