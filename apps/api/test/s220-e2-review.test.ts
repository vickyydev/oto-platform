import { hash } from '@node-rs/argon2';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  eventAttendeeLink,
  opsRun,
  paymentAttempt,
  role,
  roleAssignment,
  rolePermission,
  sale,
  saleLine,
  station,
} from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type EventAttendeeWriteAnswer,
  type EventDayAnswer,
  type EventDetailAnswer,
  type EventDropInPricingAnswer,
} from '@oto/shared';
import { resolvePricingScope } from '../src/services/sale';
import { ATTENDEE_CREATE_RUN } from '../src/services/event-writes';
import {
  buildOtoAppDirectory,
  type DirectoryAttendeeAnswer,
  type DirectoryAttendeeBody,
  type OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-20 E2 — REVIEW, from the outside (SCRUM-217; events-kiosk PLAN, the E2 row
 * of §9, §3 to §8, §10, Q5, Q8, hazards H2 and H3).
 *
 * Written against the lane, not beside it: nothing here is taken from the
 * builder's suite (`events-e2.test.ts`). The directory the api calls is the
 * REAL client (`buildOtoAppDirectory`) over a fetch that hands each request to
 * the OTO App's own write code (`server/directory/eventWrites.ts`) after the
 * app's strict body rules, so the status mapping (no answer, 5xx, 4xx) is the
 * shipped one. It attacks five things.
 *
 *  1. THE MONEY. A pass whose write-back fails tells one story: one finalised
 *     sale, one tender equal to the price, a link that waits honestly, a
 *     Failures entry, retries that resend the SAME id and the SAME body and
 *     never make a second child. A refused event (unpriced, a camp outside
 *     its range, a sale id in use, a tender the park does not take) is
 *     refused with nothing written — no sale, no tender, no link, no call.
 *  2. THE LINK TABLE. One row per till id; (event, attendee) shared only by
 *     the app's own merge; `sync_state` honest under a replay and under a
 *     directory 409; the price kept in satang and frozen at the sale.
 *  3. WHO MAY, WHERE, TWICE. Each POST under its own permission, another
 *     operator 404 with nothing written, and an Idempotency-Key on both.
 *  4. Q5 AND Q8 AS STATED. Full camp from today to its last day for one day's
 *     price; three walk-up prices kept, only the party guest's read.
 *  5. The Failures page retries a GROUP by its latest run. It was a defect,
 *     pinned with `it.fails` (one child pushed, the rest of the outage stranded);
 *     fixed in the E2 fix round, the pin now holds as a plain `it`: one Retry
 *     sends every child the outage left waiting.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let secondBranch: string;
let operatorId: string;
let till: string;
let reception: string;
let admin: string;
let chalongManager: string;
let secondAdmin: string;
let attendeeOnly: string;
let passOnly: string;
let T: string;
let mode: 'weekday' | 'weekend';
let appPool: pg.Pool;

const D = (n: number) => addDaysToIsoDate(T, n);
const appTenant = newId();
const appBranch = { central: newId(), chalong: newId() };

const ev = {
  workshop: newId(),
  outage: newId(),
  other: newId(),
  camp: newId(),
  campFuture: newId(),
  campPast: newId(),
  campStartsToday: newId(),
  campEndsToday: newId(),
  campCancelledToday: newId(),
  unpriced: newId(),
  free: newId(),
  party: newId(),
  chalongParty: newId(),
};

// --- The OTO App, as far as it can be without its server --------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome =
  | { ok: true; status: number; body: DirectoryAttendeeAnswer }
  | { ok: false; status: number; error: string; message: string };
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome>;
}
let appWrites: AppWrites;

/**
 * The app's `attendeeBodySchema` (server/directory/eventRoutes.ts), restated:
 * that module imports express at run time, which CI does not install for the
 * app. Strict, as the app's is — a key the app does not take is a 400 there.
 */
const appText = (max: number) => z.string().max(max).nullish();
const appDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const AppAttendeeBody = z
  .object({
    id: z.string().uuid(),
    childFullName: z.string().trim().min(1).max(200),
    dateOfBirth: appDate.nullish(),
    ageYears: z.number().int().min(0).max(30).nullish(),
    primaryLanguage: appText(100),
    allergies: appText(2000),
    foodRestrictions: appText(2000),
    parentName: appText(200),
    parentPhone: appText(50),
    parentAttending: z.boolean().default(false),
    attendanceDays: z.array(appDate).max(366).default([]),
    notes: appText(2000),
    bookingId: z.string().uuid().nullish(),
    source: z.enum(['pos', 'booking', 'kiosk']).default('pos'),
    createdBy: appText(255),
  })
  .strict();

const DIRECTORY_KEY = 'odk_review_e2';

/** How the app answers its next calls. `down` throws (no answer); `lost` writes and then throws. */
type Answer = 'app' | 'down' | 'lost' | { status: number; error: string };
const answers: Answer[] = [];
const sent: Array<{ eventId: string; body: DirectoryAttendeeBody; auth: string | null }> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const appFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const match = /^\/api\/directory\/events\/([^/]+)\/attendees$/.exec(url.pathname);
  if (!match || init?.method !== 'POST') return json(404, { error: 'not_found' });
  const eventId = decodeURIComponent(match[1]!);
  const body = JSON.parse(String(init!.body)) as DirectoryAttendeeBody;
  sent.push({ eventId, body, auth: new Headers(init!.headers).get('authorization') });
  const next = answers.shift() ?? 'app';
  if (next === 'down') throw new TypeError('fetch failed');
  if (typeof next === 'object') return json(next.status, { error: next.error, message: `The OTO App answered ${next.status}` });
  if (new Headers(init!.headers).get('authorization') !== `Bearer ${DIRECTORY_KEY}`) {
    return json(401, { error: 'unauthorized', message: 'No key' });
  }
  const parsed = AppAttendeeBody.safeParse(body);
  if (!parsed.success) return json(400, { error: 'Validation error', message: parsed.error.message });
  const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
  if (!event) return json(404, { error: 'event_not_found', message: 'Event not found' });
  const outcome = await appWrites.createEventAttendee(appPool, event, parsed.data as DirectoryAttendeeBody);
  if (next === 'lost') throw new TypeError('socket hang up');
  return outcome.ok
    ? json(outcome.status, outcome.body)
    : json(outcome.status, { error: outcome.error, message: outcome.message });
}) as typeof fetch;

// --- Helpers -------------------------------------------------------------------------

async function appEvent(e: {
  id: string;
  branch?: string;
  type: string;
  title: string;
  date: string;
  campEnd?: string | null;
  weekday?: number | null;
  weekend?: number | null;
  cancelled?: string[];
}) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, camp_cancelled_days,
      start_time, end_time, entry_price_weekday_thb, entry_price_weekend_thb, total_value,
      prepayment_amount, child_name, parent_name, num_children, num_adults, status, is_archived)
    values (
      ${e.id}, ${appTenant}, ${e.branch ?? appBranch.central}, ${e.type}, ${e.title}, ${e.date},
      ${e.campEnd ?? null}, ${e.cancelled ? JSON.stringify(e.cancelled) : null}::jsonb,
      '09:00', '15:00', ${e.weekday ?? null}, ${e.weekend ?? null},
      ${e.type === 'birthday' ? 15000 : null}, ${e.type === 'birthday' ? 5000 : null},
      ${e.type === 'birthday' ? 'Ploy' : null}, ${e.type === 'birthday' ? 'Ann' : null},
      12, 8, 'upcoming', false)`);
}

interface Res<B> {
  status: number;
  body: B;
  headers: Record<string, unknown>;
}

async function send<B>(
  method: 'POST' | 'PUT' | 'GET',
  cookie: string | null,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<B>> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.json() as B, headers: res.headers };
}
const post = <B>(cookie: string | null, url: string, payload: unknown, headers?: Record<string, string>) =>
  send<B>('POST', cookie, url, payload, headers);
const get = <B>(cookie: string | null, url: string) => send<B>('GET', cookie, url);

type Refusal = { error: { code: string; message: string } };

/** The fee at today's rate mode, in satang, from the app's whole-baht pair. */
const fee = (weekday: number, weekend: number) => (mode === 'weekend' ? weekend : weekday) * 100;

function kid(name: string, extra: Record<string, unknown> = {}) {
  return { name, parentName: 'Ann', parentPhone: `+6681${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, ...extra };
}

function pass(o: {
  name: string;
  attendeeId?: string;
  saleId?: string;
  registerProperly?: boolean;
  method?: string;
  kind?: string;
  tendered?: number;
  extra?: Record<string, unknown>;
  phone?: string;
}) {
  const attendee = kid(o.name, o.extra);
  return {
    branchId: central,
    stationId: till,
    attendeeId: o.attendeeId ?? newId(),
    saleId: o.saleId ?? newId(),
    actionId: newId(),
    registerProperly: o.registerProperly ?? false,
    attendee: o.phone ? { ...attendee, parentPhone: o.phone } : attendee,
    tender: {
      method: o.method ?? 'cash',
      kind: o.kind ?? 'cash',
      ...(o.tendered !== undefined ? { tenderedSatang: o.tendered } : {}),
    },
  };
}

function walkUp(o: { name: string; attendeeId?: string; branchId?: string; stationId?: string | null }) {
  return {
    branchId: o.branchId ?? central,
    ...(o.stationId === null ? {} : { stationId: o.stationId ?? till }),
    attendeeId: o.attendeeId ?? newId(),
    actionId: newId(),
    registerProperly: false,
    attendee: kid(o.name),
  };
}

async function linkOf(id: string) {
  const [row] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id));
  return row ?? null;
}

/** The app's own row(s) for an id, read through the views it publishes. */
async function appRows(id: string) {
  const res = await ctx.db.execute<{ id: string; event_id: string; child_name: string; attendance_days: string[] }>(
    sql`select id, event_id, child_name, attendance_days from otoapp_v.event_attendees where id = ${id}`,
  );
  return res.rows;
}

async function runsOf(linkId: string) {
  return ctx.db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), sql`${opsRun.detail}->>'linkId' = ${linkId}`))
    .orderBy(asc(opsRun.startedAt), asc(opsRun.id));
}

/** Everything a write could leave behind at Central. */
async function ledger() {
  const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
  return {
    sales: await n(ctx.db.select({ n: sql<number>`count(*)::int` }).from(sale).where(eq(sale.branchId, central))),
    tenders: await n(
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(paymentAttempt).where(eq(paymentAttempt.branchId, central)),
    ),
    links: await n(ctx.db.select({ n: sql<number>`count(*)::int` }).from(eventAttendeeLink)),
    passAudits: await n(
      ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(sql`${auditLog.action} in ('event.pass_sell', 'event.attendee_create')`),
    ),
    calls: sent.length,
  };
}

interface FailureGroup {
  fingerprint: string;
  name: string;
  kind: string;
  count: number;
  retryable: boolean;
  lastRunId: string;
  lastError: string | null;
}
async function failureGroup(code: string): Promise<FailureGroup | undefined> {
  const page = await get<{ groups: FailureGroup[] }>(admin, '/ops/failures?windowHours=2&kind=integration');
  expect(page.status).toBe(200);
  return page.body.groups.find((g) => g.name === ATTENDEE_CREATE_RUN && (g.lastError ?? '').startsWith(code));
}

async function customRole(name: string, phone: string, permissions: string[]): Promise<string> {
  const roleId = newId();
  await ctx.db.insert(role).values({ id: roleId, operatorId, name });
  await ctx.db
    .insert(rolePermission)
    .values(['app:pos:access', 'pos:event:read', ...permissions].map((permission) => ({ id: newId(), roleId, permission })));
  const accountId = newId();
  await ctx.db.insert(account).values({
    id: accountId,
    operatorId,
    phone: normalizePhone(phone)!,
    passwordHash: await hash('review1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId, roleId, scopeType: 'branch', scopeId: central });
  return signInAs(ctx.app, phone, 'review1234');
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  secondBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  secondAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  mode = (await resolvePricingScope(ctx.db, central, operatorId, new Date())).pricingMode;
  const [t1] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;

  attendeeOnly = await customRole('review_e2_attendee_only', '+66900000181', ['pos:event:attendee_create']);
  passOnly = await customRole('review_e2_pass_only', '+66900000182', ['pos:event:pass_sell']);

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e2-review')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appBranch.central}, ${appTenant}, 'Central', 'Phuket', ${central}),
           (${appBranch.chalong}, ${appTenant}, 'Chalong', 'Phuket', ${chalong})`);

  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Clay workshop', date: T, weekday: 350, weekend: 400 });
  await appEvent({ id: ev.outage, type: 'studio_event', title: 'Magic show', date: T, weekday: 200, weekend: 250 });
  await appEvent({ id: ev.other, type: 'workshop', title: 'Paint workshop', date: T, weekday: 150, weekend: 150 });
  await appEvent({ id: ev.camp, type: 'camp', title: 'Jungle camp', date: D(-2), campEnd: D(2), weekday: 600, weekend: 700 });
  await appEvent({ id: ev.campFuture, type: 'camp', title: 'Next camp', date: D(1), campEnd: D(3), weekday: 600, weekend: 600 });
  await appEvent({ id: ev.campPast, type: 'camp', title: 'Last camp', date: D(-4), campEnd: D(-1), weekday: 600, weekend: 600 });
  await appEvent({ id: ev.campStartsToday, type: 'camp', title: 'Fresh camp', date: T, campEnd: D(2), weekday: 500, weekend: 500 });
  await appEvent({ id: ev.campEndsToday, type: 'camp', title: 'Closing camp', date: D(-2), campEnd: T, weekday: 500, weekend: 500 });
  await appEvent({
    id: ev.campCancelledToday,
    type: 'camp',
    title: 'Rained-off camp',
    date: D(-1),
    campEnd: D(1),
    weekday: 400,
    weekend: 400,
    cancelled: [T],
  });
  await appEvent({ id: ev.unpriced, type: 'other', title: 'Parade', date: T });
  await appEvent({ id: ev.free, type: 'other', title: 'Story time', date: T, weekday: 0, weekend: 0 });
  await appEvent({ id: ev.party, type: 'birthday', title: "Ploy's 7th", date: T });
  await appEvent({ id: ev.chalongParty, branch: appBranch.chalong, type: 'birthday', title: "Chalong party", date: T });

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = buildOtoAppDirectory(
    { OTOAPP_DIRECTORY_URL: 'https://oto-app.review.test/', OTOAPP_DIRECTORY_KEY: DIRECTORY_KEY, OTOAPP_DIRECTORY_TIMEOUT_MS: 8000 },
    undefined,
    appFetch,
  );
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  answers.length = 0;
});

// =============================================================================
// 1. The money
// =============================================================================

describe('1. a pass whose write-back fails tells one story (H3)', () => {
  const attendeeId = newId();
  const saleId = newId();
  const price = () => fee(350, 400);
  let firstBody: DirectoryAttendeeBody;

  it('the app does not answer: one finalised sale, one tender of exactly the price, the link pending — and the child on the roster, once', async () => {
    const before = await ledger();
    answers.push('down');
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.workshop}/passes`,
      pass({ name: 'Mint', attendeeId, saleId, tendered: 100_000 }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      replayed: false,
      attendee: { id: attendeeId, billing: 'sale', priceSatang: price(), syncState: 'pending', otoappAttendeeId: null },
      sale: { id: saleId, status: 'finalised', grossSatang: price() },
    });

    const after = await ledger();
    expect(after.sales - before.sales).toBe(1);
    expect(after.tenders - before.tenders).toBe(1);
    expect(after.links - before.links).toBe(1);
    expect(after.calls - before.calls).toBe(1);

    const [s] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const tenders = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const link = (await linkOf(attendeeId))!;
    // One price, said four times in satang, and all four agree.
    expect(Number.isInteger(link.priceSnapshotSatang)).toBe(true);
    expect(s!.grossSatang).toBe(link.priceSnapshotSatang);
    expect(lines.map((l) => [l.grossSatang, l.kidCount, l.revenueCategory])).toEqual([[price(), 1, 'tickets']]);
    expect(tenders.map((t) => [t.method, t.amountSatang, t.status, t.tenderedSatang, t.changeSatang])).toEqual([
      ['cash', price(), 'approved', 100_000, 100_000 - price()],
    ]);
    expect(link).toMatchObject({ saleId, saleLineId: lines[0]!.id, syncState: 'pending', syncAttempts: 1, otoappAttendeeId: null });
    expect(link.syncError).toMatch(/^OTOAPP_DIRECTORY_UNREACHABLE/);

    // The key went with the call, and the call carried the till's own id.
    firstBody = sent.at(-1)!.body;
    expect(sent.at(-1)!.auth).toBe(`Bearer ${DIRECTORY_KEY}`);
    expect(firstBody.id).toBe(attendeeId);
    expect(await appRows(attendeeId)).toHaveLength(0);

    const runs = await runsOf(attendeeId);
    expect(runs.map((r) => [r.kind, r.outcome, r.errorCode, r.branchId, r.stationId])).toEqual([
      ['integration', 'failed', 'OTOAPP_DIRECTORY_UNREACHABLE', central, till],
    ]);

    const roster = await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`);
    const mint = roster.body.event.attendees!.filter((a) => a.name === 'Mint');
    expect(mint).toHaveLength(1);
    expect(mint[0]).toMatchObject({ id: attendeeId, syncState: 'pending', source: 'pos' });
  });

  it('Failures offers it; a retry while the app is still down resends the same id and body, changes no money, and stays pending', async () => {
    const group = (await failureGroup('OTOAPP_DIRECTORY_UNREACHABLE'))!;
    expect(group).toMatchObject({ kind: 'integration', retryable: true });
    const [latest] = await ctx.db.select().from(opsRun).where(eq(opsRun.id, group.lastRunId));
    expect((latest!.detail as { linkId: string }).linkId).toBe(attendeeId);

    const before = await ledger();
    answers.push('down');
    const retried = await post<{ ok: boolean; outcome: string; syncState: string }>(admin, `/ops/runs/${group.lastRunId}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ ok: true, outcome: 'failed', syncState: 'pending' });

    const after = await ledger();
    expect({ ...after, calls: 0 }).toEqual({ ...before, calls: 0 });
    expect(after.calls - before.calls).toBe(1);
    expect(sent.at(-1)!.body).toEqual(firstBody);
    expect(await linkOf(attendeeId)).toMatchObject({ syncState: 'pending', syncAttempts: 2 });
    expect((await runsOf(attendeeId)).map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(await appRows(attendeeId)).toHaveLength(0);
  });

  it('with the app back, a retry lands the child once under the till id — and every later press sends nothing and charges nothing', async () => {
    const runs = await runsOf(attendeeId);
    const before = await ledger();
    const retried = await post<{ syncState: string }>(admin, `/ops/runs/${runs.at(-1)!.id}/retry`, {});
    expect(retried.body.syncState).toBe('synced');
    expect(sent.at(-1)!.body).toEqual(firstBody);
    const link = (await linkOf(attendeeId))!;
    expect(link).toMatchObject({ syncState: 'synced', otoappAttendeeId: attendeeId, merged: false, syncAttempts: 3, syncError: null });
    expect(link.syncedAt).not.toBeNull();
    expect((await appRows(attendeeId)).map((r) => [r.event_id, r.child_name])).toEqual([[ev.workshop, 'Mint']]);

    // The first failed run, retried again; the till's own press again under a
    // new sale id and another tender: answered from the record, nothing sent.
    const sentBefore = sent.length;
    const again = await post<{ syncState: string }>(admin, `/ops/runs/${runs[0]!.id}/retry`, {});
    expect(again.body.syncState).toBe('synced');
    const replay = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.workshop}/passes`,
      pass({ name: 'Mint', attendeeId, saleId: newId(), method: 'card', kind: 'card' }),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.body).toMatchObject({ replayed: true, sale: { id: saleId, grossSatang: fee(350, 400) }, attendee: { syncState: 'synced' } });
    expect(sent.length).toBe(sentBefore);
    const after = await ledger();
    expect({ ...after, calls: 0 }).toEqual({ ...before, calls: 0 });
    expect(await appRows(attendeeId)).toHaveLength(1);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);

    // Once in the app, the roster has the child once, from the app, marked as the till's.
    const roster = await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`);
    expect(roster.body.event.attendees!.filter((a) => a.name === 'Mint').map((a) => [a.id, a.syncState])).toEqual([
      [attendeeId, 'synced'],
    ]);
  });

  it('the pass sale reads in History like any ticket sale, and refunds whole — the child stays on the event, as the prototype never undid one', async () => {
    const detail = await get<{ sale: { id: string; status: string; grossSatang: number }; lines: Array<{ label: string }> }>(
      admin,
      `/sales/${saleId}`,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(JSON.stringify(detail.body)).toContain('Event entry pass');
    const refunded = await post<{ refund: { amountSatang: number } }>(admin, `/sales/${saleId}/refunds`, {
      mode: 'whole',
      reason: 'Changed their mind',
      actionId: newId(),
    });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    const [s] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(s!.status).toBe('refunded');
    expect(await linkOf(attendeeId)).toMatchObject({ saleId, syncState: 'synced' });
    expect(await appRows(attendeeId)).toHaveLength(1);
  });

  it('two presses of one pass at the same moment: one sale, one tender, one child — the other press is the replay', async () => {
    const id = newId();
    const before = await ledger();
    const [a, b] = await Promise.all([
      post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Twice', attendeeId: id, tendered: 100_000 })),
      post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Twice', attendeeId: id, tendered: 100_000 })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    expect(a.body.sale!.id).toBe(b.body.sale!.id);
    const after = await ledger();
    expect(after.sales - before.sales).toBe(1);
    expect(after.tenders - before.tenders).toBe(1);
    expect(after.links - before.links).toBe(1);
    expect(await appRows(id)).toHaveLength(1);
  });

  it('a 5xx from the app is pending (worth a retry); a 4xx refusal is failed — the shipped client maps both, and the sale stands', async () => {
    answers.push({ status: 503, error: 'service_unavailable' });
    const flaky = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Flaky', tendered: 100_000 }));
    expect(flaky.body).toMatchObject({ attendee: { syncState: 'pending' }, sale: { status: 'finalised' } });
    expect(flaky.body.attendee.syncError).toMatch(/^OTOAPP_SERVICE_UNAVAILABLE/);

    answers.push({ status: 422, error: 'unprocessable' });
    const refused = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Refused', tendered: 100_000 }));
    expect(refused.body).toMatchObject({ attendee: { syncState: 'failed' }, sale: { status: 'finalised' } });
    expect(refused.body.attendee.syncError).toMatch(/^OTOAPP_UNPROCESSABLE/);
  });
});

describe('1b. a refused event is refused before any money is asked — and nothing is written (H2)', () => {
  it('no entry price: refused on both routes; no sale, no tender, no link, no audit, no call', async () => {
    const before = await ledger();
    const sold = await post<Refusal>(reception, `/events/${ev.unpriced}/passes`, pass({ name: 'Nobody', tendered: 100_000 }));
    const added = await post<Refusal>(reception, `/events/${ev.unpriced}/attendees`, walkUp({ name: 'Nobody' }));
    expect([sold.status, sold.body.error.code]).toEqual([409, 'EVENT_NOT_PRICED']);
    expect([added.status, added.body.error.code]).toEqual([409, 'EVENT_NOT_PRICED']);
    expect(await ledger()).toEqual(before);
  });

  it('a camp outside its range — not begun, already over — takes nobody; on its first and its last day it does', async () => {
    const before = await ledger();
    for (const id of [ev.campFuture, ev.campPast]) {
      const sold = await post<Refusal>(reception, `/events/${id}/passes`, pass({ name: 'Early', tendered: 100_000 }));
      expect([sold.status, sold.body.error.code]).toEqual([409, 'CAMP_NOT_RUNNING_TODAY']);
    }
    expect(await ledger()).toEqual(before);
    for (const id of [ev.campStartsToday, ev.campEndsToday]) {
      const sold = await post<EventAttendeeWriteAnswer>(reception, `/events/${id}/passes`, pass({ name: 'Edge day', tendered: 100_000 }));
      expect(sold.status, JSON.stringify(sold.body)).toBe(200);
      expect(sold.body.attendee.attendanceDays).toEqual([T]);
    }
  });

  it('a sale id already in use: refused, no second tender against that sale, no link, nothing sent', async () => {
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.other}/passes`, pass({ name: 'Owner', tendered: 100_000 }));
    expect(first.status).toBe(200);
    const before = await ledger();
    const reuse = await post<Refusal>(
      reception,
      `/events/${ev.other}/passes`,
      pass({ name: 'Borrower', saleId: first.body.sale!.id, tendered: 100_000 }),
    );
    expect(reuse.status).toBe(409);
    expect(await ledger()).toEqual(before);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, first.body.sale!.id))).toHaveLength(1);
  });

  it('a tender the park does not take: refused with nothing written', async () => {
    const before = await ledger();
    const res = await post<Refusal>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Coins', method: 'seashells', kind: 'seashells' }));
    expect(res.status).toBe(400);
    expect(await ledger()).toEqual(before);
  });

  it('the attendee route never takes money: a paid camp there is refused, whatever the switch says', async () => {
    const before = await ledger();
    const res = await post<Refusal>(reception, `/events/${ev.camp}/attendees`, { ...walkUp({ name: 'Sneak' }), registerProperly: true });
    expect([res.status, res.body.error.code]).toEqual([409, 'EVENT_PASS_NEEDS_PAYMENT']);
    expect(await ledger()).toEqual(before);
  });

  /**
   * NOT A REFUSAL, AS BUILT — pinned so the answer to the open question is a
   * visible change. A camp day the OTO App marks cancelled is still a camp
   * day to the till: E1 lists the camp (round 0 review, "cancelled day
   * included"), the till never reads `cancelledDays`, and a pass is sold for
   * it. That is the plan's Q12 default (the prototype has no cancelled days;
   * "one answer with … cancelled camp days"), not something E2 invented.
   */
  it("a camp day the app marks cancelled is sold like any other (Q12's default, open)", async () => {
    const sold = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.campCancelledToday}/passes`,
      pass({ name: 'Rain kid', tendered: 100_000 }),
    );
    expect(sold.status).toBe(200);
    expect(sold.body.attendee.attendanceDays).toEqual([T]);
  });
});

// =============================================================================
// 2. The link table
// =============================================================================

describe('2. the link table', () => {
  it('one row per till id: the primary key refuses a second row with it', async () => {
    const [any] = await ctx.db.select().from(eventAttendeeLink).limit(1);
    const err = await ctx.db
      .execute(sql`insert into pos.event_attendee_link
        (id, operator_id, branch_id, otoapp_event_id, event_type, billing, writeback)
        values (${any!.id}, ${any!.operatorId}, ${any!.branchId}, ${any!.otoappEventId}, 'event', 'free', '{}'::jsonb)`)
      .then(() => null)
      .catch((e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code ?? 'unknown');
    expect(err).toBe('23505');
  });

  it('(event, app attendee) is shared only where the app merged a second walk-up into its registration — the reason it is not UNIQUE', async () => {
    const phone = '+66812223344';
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, pass({ name: 'Joy', phone, tendered: 100_000 }));
    const second = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.camp}/passes`,
      pass({ name: 'joy ', phone, registerProperly: true, tendered: 100_000 }),
    );
    expect(second.body.attendee).toMatchObject({ merged: true, otoappAttendeeId: first.body.attendee.id, syncState: 'synced' });
    // Two sales, as the till took two payments; one registration in the app,
    // holding the second walk-up's days too.
    expect(first.body.sale!.id).not.toBe(second.body.sale!.id);
    const [reg] = await appRows(first.body.attendee.id);
    expect([...reg!.attendance_days].sort()).toEqual([T, D(1), D(2)]);

    const shared = await ctx.db.execute<{ n: number; merged: number }>(sql`
      select count(*)::int as n, count(*) filter (where merged)::int as merged
        from pos.event_attendee_link where otoapp_attendee_id is not null
       group by otoapp_event_id, otoapp_attendee_id having count(*) > 1`);
    expect(shared.rows.length).toBeGreaterThan(0);
    for (const g of shared.rows) expect(g.merged).toBe(g.n - 1);
    const idx = await ctx.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where schemaname = 'pos' and indexname = 'event_attendee_link_event_idx'`,
    );
    expect(idx.rows[0]!.indexdef).not.toMatch(/UNIQUE/);
  });

  it('a directory 409 (the id is the app\'s, under another event): failed, honestly — the sale stands, a replay retries and stays failed', async () => {
    const taken = newId();
    const event = (await appWrites.findTenantEvent(appPool, appTenant, ev.other))!;
    const made = await appWrites.createEventAttendee(appPool, event, {
      id: taken,
      childFullName: 'Already here',
      parentAttending: false,
      attendanceDays: [],
      source: 'pos',
    });
    expect(made.ok).toBe(true);

    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.workshop}/passes`,
      pass({ name: 'Clash', attendeeId: taken, tendered: 100_000 }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attendee: { syncState: 'failed', otoappAttendeeId: null }, sale: { status: 'finalised' } });
    expect(res.body.attendee.syncError).toMatch(/^OTOAPP_ID_IN_USE/);
    const replay = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Clash', attendeeId: taken }));
    expect(replay.body).toMatchObject({ replayed: true, attendee: { syncState: 'failed' } });
    expect(await linkOf(taken)).toMatchObject({ syncState: 'failed', syncAttempts: 2 });
    // The app still holds the one child it had, under its own event.
    expect((await appRows(taken)).map((r) => r.event_id)).toEqual([ev.other]);
    // The roster shows the till's child from its own record, not as synced.
    const roster = await get<EventDetailAnswer>(reception, `/events/${ev.workshop}?branchId=${central}`);
    expect(roster.body.event.attendees!.find((a) => a.id === taken)).toMatchObject({ name: 'Clash', syncState: 'failed' });
  });

  it('the till reusing one attendee id on another event is refused before any money or call', async () => {
    const id = newId();
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.free}/attendees`, walkUp({ name: 'Solo', attendeeId: id }));
    expect(first.status).toBe(200);
    const before = await ledger();
    const reuse = await post<Refusal>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Other', attendeeId: id, tendered: 100_000 }));
    expect([reuse.status, reuse.body.error.code]).toEqual([409, 'ATTENDEE_ID_IN_USE']);
    expect(await ledger()).toEqual(before);
  });

  it('the database will not call a link synced without the app\'s attendee', async () => {
    const [pending] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.syncState, 'failed')).limit(1);
    const err = await ctx.db
      .execute(sql`update pos.event_attendee_link set sync_state = 'synced', synced_at = now() where id = ${pending!.id}`)
      .then(() => null)
      .catch((e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code ?? 'unknown');
    expect(err).toBe('23514');
  });
});

// =============================================================================
// 3. Who may, where, and twice
// =============================================================================

describe('3. who may, where, and twice', () => {
  it('each POST asks its own permission: walk-ups without selling, selling without walk-ups', async () => {
    const before = await ledger();
    const noPass = await post<Refusal>(attendeeOnly, `/events/${ev.workshop}/passes`, pass({ name: 'No', tendered: 100_000 }));
    const noWalkUp = await post<Refusal>(passOnly, `/events/${ev.party}/attendees`, walkUp({ name: 'No' }));
    expect([noPass.status, noWalkUp.status]).toEqual([403, 403]);
    expect(await ledger()).toEqual(before);

    const walked = await post<EventAttendeeWriteAnswer>(attendeeOnly, `/events/${ev.party}/attendees`, walkUp({ name: 'Bee' }));
    const sold = await post<EventAttendeeWriteAnswer>(passOnly, `/events/${ev.workshop}/passes`, pass({ name: 'Bo', tendered: 100_000 }));
    expect([walked.status, sold.status]).toEqual([200, 200]);
    const signedOut = await post<Refusal>(null, `/events/${ev.workshop}/passes`, pass({ name: 'Ghost' }));
    expect(signedOut.status).toBe(401);
  });

  it("another operator: OTO's branch, OTO's event, OTO's prices and OTO's runs are all not found — and nothing is written", async () => {
    const before = await ledger();
    const passAtCentral = await post<Refusal>(secondAdmin, `/events/${ev.workshop}/passes`, pass({ name: 'Foreign', tendered: 100_000 }));
    const walkUpAtCentral = await post<Refusal>(secondAdmin, `/events/${ev.party}/attendees`, walkUp({ name: 'Foreign' }));
    const ownBranch = await post<Refusal>(
      secondAdmin,
      `/events/${ev.party}/attendees`,
      walkUp({ name: 'Foreign', branchId: secondBranch, stationId: null }),
    );
    const prices = await get<Refusal>(secondAdmin, `/branches/${central}/event-drop-in-pricing`);
    const setPrices = await send<Refusal>('PUT', secondAdmin, `/branches/${central}/event-drop-in-pricing`, {
      campDay: { weekday: 1, weekend: 1 },
      eventDay: { weekday: 1, weekend: 1 },
      partyGuest: { weekday: 1, weekend: 1 },
    });
    const [oneRun] = await ctx.db.select().from(opsRun).where(eq(opsRun.name, ATTENDEE_CREATE_RUN)).limit(1);
    const retry = await post<Refusal>(secondAdmin, `/ops/runs/${oneRun!.id}/retry`, {});
    expect([passAtCentral, walkUpAtCentral, ownBranch, prices, setPrices, retry].map((r) => r.status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(await ledger()).toEqual(before);
  });

  it('an Idempotency-Key on /passes: the same body twice is one sale answered twice; another body under it is 409 with nothing new', async () => {
    const key = newId();
    const body = pass({ name: 'Keyed', tendered: 100_000 });
    const before = await ledger();
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, body, { 'idempotency-key': key });
    const second = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, body, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const mid = await ledger();
    expect(mid.sales - before.sales).toBe(1);
    expect(mid.tenders - before.tenders).toBe(1);
    const other = await post<Refusal>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'Keyed again', tendered: 100_000 }), {
      'idempotency-key': key,
    });
    expect([other.status, other.body.error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
    expect(await ledger()).toEqual(mid);
  });

  it('an Idempotency-Key on /attendees: the same, for a party walk-up and its tab charge', async () => {
    const key = newId();
    const body = walkUp({ name: 'Keyed guest' });
    const before = await ledger();
    const first = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.party}/attendees`, body, { 'idempotency-key': key });
    const second = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.party}/attendees`, body, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const mid = await ledger();
    expect(mid.links - before.links).toBe(1);
    expect(mid.calls - before.calls).toBe(1);
    const other = await post<Refusal>(reception, `/events/${ev.party}/attendees`, walkUp({ name: 'Other guest' }), { 'idempotency-key': key });
    expect([other.status, other.body.error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
    expect(await ledger()).toEqual(mid);
    const day = await get<EventDayAnswer>(reception, `/events?branchId=${central}`);
    const charges = day.body.events.find((e) => e.id === ev.party)!.party!.walkUpCharges;
    expect(charges.filter((c) => c.name === 'Keyed guest')).toHaveLength(1);
  });
});

// =============================================================================
// 4. Q5 and Q8, as the plan states their defaults
// =============================================================================

describe("4. Q5 and Q8's defaults", () => {
  it('Q5: "Also register for the full camp" registers today to the last day — never the days already gone — for one day\'s price, once', async () => {
    const res = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.camp}/passes`,
      pass({ name: 'Whole camp', registerProperly: true, tendered: 100_000 }),
    );
    expect(res.status).toBe(200);
    expect(res.body.attendee.attendanceDays).toEqual([T, D(1), D(2)]);
    expect(res.body.attendee.priceSatang).toBe(fee(600, 700));
    expect(res.body.sale!.grossSatang).toBe(fee(600, 700));
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, res.body.sale!.id));
    expect(lines.map((l) => [l.kidCount, l.grossSatang, l.label])).toEqual([[1, fee(600, 700), 'Camp day pass']]);
    // A camp on its first day: every day of it; on its last day: that day.
    const fresh = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.campStartsToday}/passes`,
      pass({ name: 'Fresh whole', registerProperly: true, tendered: 100_000 }),
    );
    expect(fresh.body.attendee.attendanceDays).toEqual([T, D(1), D(2)]);
    const closing = await post<EventAttendeeWriteAnswer>(
      reception,
      `/events/${ev.campEndsToday}/passes`,
      pass({ name: 'Closing whole', registerProperly: true, tendered: 100_000 }),
    );
    expect(closing.body.attendee.attendanceDays).toEqual([T]);
  });

  it('Q8: all three prices are kept and answered; camp day and event day price nothing; the party guest is read at today\'s rate, frozen per walk-up', async () => {
    const seeded = await get<EventDropInPricingAnswer>(reception, `/branches/${central}/event-drop-in-pricing`);
    expect(seeded.body.pricing).toEqual({
      campDay: { weekday: 60_000, weekend: 60_000 },
      eventDay: { weekday: 35_000, weekend: 35_000 },
      partyGuest: { weekday: 45_000, weekend: 45_000 },
    });

    const firstGuest = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.party}/attendees`, walkUp({ name: 'Early guest' }));
    expect(firstGuest.body).toMatchObject({ attendee: { billing: 'party_tab', priceSatang: 45_000 }, sale: null });

    const changed = await send<EventDropInPricingAnswer>('PUT', admin, `/branches/${central}/event-drop-in-pricing`, {
      campDay: { weekday: 999_900, weekend: 999_900 },
      eventDay: { weekday: 888_800, weekend: 888_800 },
      partyGuest: { weekday: 51_000, weekend: 52_000 },
    });
    expect(changed.status).toBe(200);
    const read = await get<EventDropInPricingAnswer>(reception, `/branches/${central}/event-drop-in-pricing`);
    expect(read.body).toMatchObject({ configured: true, pricing: { campDay: { weekday: 999_900 }, eventDay: { weekend: 888_800 } } });

    // A pass is still its event's price, never the branch's day prices.
    const campPass = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.camp}/passes`, pass({ name: 'After', tendered: 100_000 }));
    const eventPass = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.workshop}/passes`, pass({ name: 'After', tendered: 100_000 }));
    expect([campPass.body.attendee.priceSatang, eventPass.body.attendee.priceSatang]).toEqual([fee(600, 700), fee(350, 400)]);

    // The party guest at today's rate; the earlier guest keeps the price they were charged.
    const laterGuest = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.party}/attendees`, walkUp({ name: 'Late guest' }));
    expect(laterGuest.body.attendee.priceSatang).toBe(mode === 'weekend' ? 52_000 : 51_000);
    const day = await get<EventDayAnswer>(reception, `/events?branchId=${central}`);
    const charges = day.body.events.find((e) => e.id === ev.party)!.party!.walkUpCharges;
    expect(charges.find((c) => c.name === 'Early guest')!.amountSatang).toBe(45_000);
    expect(charges.find((c) => c.name === 'Late guest')!.amountSatang).toBe(mode === 'weekend' ? 52_000 : 51_000);
  });

  it('Q8: a branch nobody priced charges its party guest ฿0 on the tab, as the prototype\'s second branch did — no sale either way', async () => {
    const before = await ledger();
    const res = await post<EventAttendeeWriteAnswer>(
      chalongManager,
      `/events/${ev.chalongParty}/attendees`,
      walkUp({ name: 'Chalong guest', branchId: chalong, stationId: null }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ attendee: { billing: 'party_tab', priceSatang: 0 }, sale: null });
    expect((await ledger()).sales).toBe(before.sales);
  });
});

// =============================================================================
// 5. The Failures page retries a group by its latest run — the whole outage, not one child
// =============================================================================

describe('5. an outage that leaves several children pending, and the Failures page', () => {
  const ids = { older: newId(), newer: newId() };
  const outage = { status: 502, error: 'bad_gateway' };

  it('two passes sold through one outage: two links pending, ONE Failures group, Retry offered on its latest run', async () => {
    answers.push(outage);
    const older = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.outage}/passes`, pass({ name: 'Older', attendeeId: ids.older, tendered: 100_000 }));
    answers.push(outage);
    const newer = await post<EventAttendeeWriteAnswer>(reception, `/events/${ev.outage}/passes`, pass({ name: 'Newer', attendeeId: ids.newer, tendered: 100_000 }));
    expect([older.body.attendee.syncState, newer.body.attendee.syncState]).toEqual(['pending', 'pending']);
    const group = (await failureGroup('OTOAPP_BAD_GATEWAY'))!;
    expect(group).toMatchObject({ count: 2, retryable: true });
    const [latest] = await ctx.db.select().from(opsRun).where(eq(opsRun.id, group.lastRunId));
    expect((latest!.detail as { linkId: string }).linkId).toBe(ids.newer);
  });

  /**
   * WAS A DEFECT (pinned with `it.fails`, fixed in the E2 fix round). The
   * Console's Failures page offers one action per group — "Retry the latest
   * run" (apps/console/src/pages/Failures.tsx, `RetryButton`,
   * `failuresApi.retry(group.lastRunId)`) — and the group is the fingerprint
   * (kind, name, error code), so every child one outage left behind shares it.
   * For a job, re-running the latest run is a sweep and covers them all; for
   * `otoapp:attendee.create` it pushed the ONE link that run named, and every
   * other child stayed pending with nothing on the page to reach it.
   */
  it('one Retry from that group, with the app back, brings every child the outage left pending to the app', async () => {
    const group = (await failureGroup('OTOAPP_BAD_GATEWAY'))!;
    const retried = await post<{ syncState: string }>(admin, `/ops/runs/${group.lastRunId}/retry`, {});
    expect(retried.status).toBe(200);
    expect(await linkOf(ids.newer)).toMatchObject({ syncState: 'synced' });
    expect(await linkOf(ids.older)).toMatchObject({ syncState: 'synced' });
  });

  it('as fixed: nothing is stranded — a later Retry of the group, and the older run by its own id, send nothing more', async () => {
    expect(await linkOf(ids.newer)).toMatchObject({ syncState: 'synced' });
    expect(await linkOf(ids.older)).toMatchObject({ syncState: 'synced' });
    expect(await appRows(ids.older)).toHaveLength(1);
    expect(await appRows(ids.newer)).toHaveLength(1);
    const group = (await failureGroup('OTOAPP_BAD_GATEWAY'))!;
    const sentBefore = sent.length;
    await post(admin, `/ops/runs/${group.lastRunId}/retry`, {});
    await post(admin, `/ops/runs/${group.lastRunId}/retry`, {});
    const [olderRun] = await runsOf(ids.older);
    const direct = await post<{ syncState: string }>(admin, `/ops/runs/${olderRun!.id}/retry`, {});
    expect(direct.body.syncState).toBe('synced');
    expect(sent.length).toBe(sentBefore);
    expect(await appRows(ids.older)).toHaveLength(1);
  });
});
