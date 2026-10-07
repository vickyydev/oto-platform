import { hash } from '@node-rs/argon2';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
  station,
} from '@oto/db';
import {
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type EventAttendeeWriteAnswer,
} from '@oto/shared';
import { ATTENDEE_CREATE_RUN, WRITE_BACK_SWEEP_LIMIT, pushAttendee } from '../src/services/event-writes';
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
 * S2-20 E2 — REVIEW, second round (SCRUM-217): the Failures page's Retry of a
 * write-back, as the fix round rebuilt it (`retryAttendeeWriteBack`, a sweep
 * over every child that still owes the OTO App a write).
 *
 * The first review pinned the defect: one Retry per Failures group, and the
 * integration pushed only the child its latest run named. The fix sends that
 * child, then every other waiting child in the caller's reach, oldest first and
 * bounded. A sweep is a wider write than a single push, so this file attacks the
 * width, through the real route and the REAL directory client over a fetch that
 * hands each call to the OTO App's own write code:
 *
 *  1. THE MONEY. A swept outage moves no money: the same sales, the same single
 *     tender each, every child sent under its own id with its stored body byte
 *     for byte, each landing once in the app; a refusal of another kind is not
 *     sent; a second press sends nothing.
 *  2. REACH. Only the caller's operator, and only the branches where the caller
 *     holds `admin:ops:manage`; a run at a branch outside it is 403 with nothing
 *     sent. Another operator's press never sends OTO's children, nor OTO's theirs.
 *  3. WHEN TO STOP. No answer stops at the first child; a refused key stops at
 *     the first child, and that group's own Retry later sends the refusals and
 *     the rest.
 *  4. TWICE AT ONCE. Two presses, and a press racing a live pass sale: each
 *     child lands once in the app, and the money is what the till took.
 *  5. THE EDGES. The bound through the route; an archived child is neither sent
 *     nor counted; and a waiting row with no stored body (the schema allows it).
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let secondBranch: string;
let operatorId: string;
let secondOperatorId: string;
let till: string;
let reception: string;
let admin: string;
let chalongManager: string;
let secondAdmin: string;
let centralOps: string;
let T: string;
let appPool: pg.Pool;

const appTenant = newId();
const appBranch = { central: newId(), chalong: newId() };

const ev = {
  outage: newId(),
  refusal: newId(),
  reach: newId(),
  chalongParty: newId(),
  stop: newId(),
  race: newId(),
  bulk: newId(),
  edge: newId(),
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

/** The app's `attendeeBodySchema` (server/directory/eventRoutes.ts), restated strict, as in the first review. */
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

const DIRECTORY_KEY = 'odk_review_e2_r2';

/** How the app answers its next calls. `down` throws (no answer). */
type Answer = 'app' | 'down' | { status: number; error: string };
const answers: Answer[] = [];
/** Every call the api made, with the exact text it sent. */
const sent: Array<{ eventId: string; id: string; raw: string; body: DirectoryAttendeeBody }> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const appFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const match = /^\/api\/directory\/events\/([^/]+)\/attendees$/.exec(url.pathname);
  if (!match || init?.method !== 'POST') return json(404, { error: 'not_found' });
  const eventId = decodeURIComponent(match[1]!);
  const raw = String(init!.body);
  const body = JSON.parse(raw) as DirectoryAttendeeBody;
  sent.push({ eventId, id: body.id, raw, body });
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
  return outcome.ok
    ? json(outcome.status, outcome.body)
    : json(outcome.status, { error: outcome.error, message: outcome.message });
}) as typeof fetch;

// --- Helpers -------------------------------------------------------------------------

async function appEvent(e: { id: string; branch?: string; type: string; title: string; weekday?: number | null; weekend?: number | null }) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, camp_cancelled_days,
      start_time, end_time, entry_price_weekday_thb, entry_price_weekend_thb, total_value,
      prepayment_amount, child_name, parent_name, num_children, num_adults, status, is_archived)
    values (
      ${e.id}, ${appTenant}, ${e.branch ?? appBranch.central}, ${e.type}, ${e.title}, ${T},
      null, null, '09:00', '15:00', ${e.weekday ?? null}, ${e.weekend ?? null},
      ${e.type === 'birthday' ? 15000 : null}, ${e.type === 'birthday' ? 5000 : null},
      ${e.type === 'birthday' ? 'Ploy' : null}, ${e.type === 'birthday' ? 'Ann' : null},
      12, 8, 'upcoming', false)`);
}

interface Res<B> {
  status: number;
  body: B;
}
async function post<B>(cookie: string | null, url: string, payload: unknown): Promise<Res<B>> {
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: cookie ? { cookie } : {},
  });
  return { status: res.statusCode, body: res.json() as B };
}

type RetryAnswer = { ok: boolean; outcome: string; syncState: string; sent: number; synced: number; waiting: number };
type Refusal = { error: { code: string; message: string } };

function kid(name: string) {
  return { name, parentName: 'Ann', parentPhone: `+6681${Math.floor(1_000_000 + Math.random() * 8_999_999)}` };
}

function pass(o: { name: string; attendeeId?: string }) {
  return {
    branchId: central,
    stationId: till,
    attendeeId: o.attendeeId ?? newId(),
    saleId: newId(),
    actionId: newId(),
    registerProperly: false,
    attendee: kid(o.name),
    tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
  };
}

function walkUp(o: { name: string; branchId: string; stationId?: string | null }) {
  return {
    branchId: o.branchId,
    ...(o.stationId ? { stationId: o.stationId } : {}),
    attendeeId: newId(),
    actionId: newId(),
    registerProperly: false,
    attendee: kid(o.name),
  };
}

/** A pass sold while the app answers `answer`: its sale stands, and its child waits. */
async function soldThrough(eventId: string, name: string, answer: Answer): Promise<string> {
  answers.push(answer);
  const res = await post<EventAttendeeWriteAnswer>(reception, `/events/${eventId}/passes`, pass({ name }));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.sale).toMatchObject({ status: 'finalised' });
  expect(answers).toEqual([]);
  return res.body.attendee.id;
}

async function linkOf(id: string) {
  const [row] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, id));
  return row!;
}

async function appRows(id: string) {
  const res = await ctx.db.execute<{ id: string }>(sql`select id from otoapp_v.event_attendees where id = ${id}`);
  return res.rows;
}

/** The newest failed run of one child — what the page's Retry presses for its group. */
async function lastFailedRun(linkId: string) {
  const [run] = await ctx.db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, ATTENDEE_CREATE_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'linkId' = ${linkId}`))
    .orderBy(desc(opsRun.startedAt), desc(opsRun.id))
    .limit(1);
  return run!;
}

/** The links of one operator that still owe the app a write, oldest first. */
async function waitingOf(op: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: eventAttendeeLink.id })
    .from(eventAttendeeLink)
    .where(and(eq(eventAttendeeLink.operatorId, op), sql`${eventAttendeeLink.syncState} <> 'synced'`, sql`${eventAttendeeLink.archivedAt} is null`))
    .orderBy(asc(eventAttendeeLink.createdAt), asc(eventAttendeeLink.id));
  return rows.map((r) => r.id);
}

/** Every sale and every tender anywhere, with its amount: what money a press could move. */
async function money() {
  const sales = await ctx.db
    .select({ id: sale.id, status: sale.status, gross: sale.grossSatang })
    .from(sale)
    .orderBy(asc(sale.id));
  const tenders = await ctx.db
    .select({ id: paymentAttempt.id, saleId: paymentAttempt.saleId, amount: paymentAttempt.amountSatang, status: paymentAttempt.status })
    .from(paymentAttempt)
    .orderBy(asc(paymentAttempt.id));
  return { sales, tenders };
}

/**
 * Leaves nothing waiting before a block starts, so every count in it is its
 * own. Archiving is how a leftover is taken out of the sweep's reach.
 */
async function settle(): Promise<void> {
  await ctx.db
    .update(eventAttendeeLink)
    .set({ archivedAt: new Date() })
    .where(and(sql`${eventAttendeeLink.syncState} <> 'synced'`, sql`${eventAttendeeLink.archivedAt} is null`));
}

/** A link written straight into the table, with the stored body a till would have sent. */
async function insertLink(o: {
  id?: string;
  operator?: string;
  branchId?: string;
  eventId: string;
  name: string;
  createdAt?: Date;
  writeback?: DirectoryAttendeeBody | null;
  source?: 'till' | 'booking';
}): Promise<string> {
  const id = o.id ?? newId();
  const body: DirectoryAttendeeBody | null =
    o.writeback === undefined
      ? ({
          id,
          childFullName: o.name,
          parentName: 'Ann',
          parentPhone: null,
          parentAttending: false,
          attendanceDays: [],
          source: 'pos',
          createdBy: 'Review',
        } as unknown as DirectoryAttendeeBody)
      : o.writeback;
  const at = o.createdAt ?? new Date();
  await ctx.db.insert(eventAttendeeLink).values({
    id,
    operatorId: o.operator ?? operatorId,
    branchId: o.branchId ?? central,
    otoappEventId: o.eventId,
    eventType: 'event',
    billing: 'free',
    priceSnapshotSatang: 0,
    source: o.source ?? 'till',
    syncState: 'pending',
    writeback: body,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

async function opsRole(name: string, phone: string, permissions: string[], scope: { type: 'branch'; id: string }): Promise<string> {
  const roleId = newId();
  await ctx.db.insert(role).values({ id: roleId, operatorId, name });
  await ctx.db.insert(rolePermission).values(permissions.map((permission) => ({ id: newId(), roleId, permission })));
  const accountId = newId();
  await ctx.db.insert(account).values({
    id: accountId,
    operatorId,
    phone: normalizePhone(phone)!,
    passwordHash: await hash('review1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId, roleId, scopeType: scope.type, scopeId: scope.id });
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
  const [second] = await ctx.db.select().from(branch).where(eq(branch.id, secondBranch));
  secondOperatorId = second!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;

  // Ops at Central only: may press Retry for Central's runs, and nobody else's.
  centralOps = await opsRole('review_e2_ops_central', '+66900000191', ['admin:ops:manage', 'admin:health:read'], {
    type: 'branch',
    id: central,
  });

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 6 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e2-review-2')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appBranch.central}, ${appTenant}, 'Central', 'Phuket', ${central}),
           (${appBranch.chalong}, ${appTenant}, 'Chalong', 'Phuket', ${chalong})`);

  await appEvent({ id: ev.outage, type: 'workshop', title: 'Clay workshop', weekday: 350, weekend: 400 });
  await appEvent({ id: ev.refusal, type: 'workshop', title: 'Paint workshop', weekday: 150, weekend: 150 });
  await appEvent({ id: ev.reach, type: 'studio_event', title: 'Magic show', weekday: 200, weekend: 250 });
  await appEvent({ id: ev.chalongParty, branch: appBranch.chalong, type: 'birthday', title: 'Chalong party' });
  await appEvent({ id: ev.stop, type: 'workshop', title: 'Lego workshop', weekday: 300, weekend: 300 });
  await appEvent({ id: ev.race, type: 'workshop', title: 'Slime workshop', weekday: 250, weekend: 250 });
  await appEvent({ id: ev.bulk, type: 'other', title: 'Story time', weekday: 0, weekend: 0 });
  await appEvent({ id: ev.edge, type: 'other', title: 'Puppet show', weekday: 0, weekend: 0 });

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

const directoryOf = () => (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory;

// =============================================================================
// 1. A swept outage moves no money, and sends each child once, as stored
// =============================================================================

describe('1. one Retry over an outage: every waiting child once, as stored, and no money moved', () => {
  it('three passes through a 502, a no-answer pass, and a 422 refusal: the 502 group\'s Retry sends the four waiting, not the refusal, and nothing else changes', async () => {
    const outage = { status: 502, error: 'bad_gateway' };
    const a = await soldThrough(ev.outage, 'Arm', outage);
    const b = await soldThrough(ev.outage, 'Bam', outage);
    const c = await soldThrough(ev.outage, 'Cha', outage);
    const quiet = await soldThrough(ev.outage, 'Dao', 'down');
    const refused = await soldThrough(ev.refusal, 'Eve', { status: 422, error: 'unprocessable' });
    expect(await waitingOf(operatorId)).toEqual([a, b, c, quiet, refused]);
    expect((await linkOf(refused)).syncState).toBe('failed');

    // The body each child was first sent with, byte for byte.
    const firstText = new Map(sent.map((s) => [s.id, s.raw]));
    const before = await money();
    const sentBefore = sent.length;

    const pressed = await lastFailedRun(c);
    expect(pressed.errorCode).toBe('OTOAPP_BAD_GATEWAY');
    const res = await post<RetryAnswer>(admin, `/ops/runs/${pressed.id}/retry`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'ok', syncState: 'synced', sent: 4, synced: 4, waiting: 0 });

    // The pressed child first, then the rest oldest first — the refusal never.
    const calls = sent.slice(sentBefore);
    expect(calls.map((x) => x.id)).toEqual([c, a, b, quiet]);
    for (const call of calls) {
      expect(call.raw, `the body of ${call.id}`).toBe(firstText.get(call.id));
      expect(call.body).toEqual((await linkOf(call.id)).writeback);
      expect(call.eventId).toBe(ev.outage);
    }
    for (const id of [a, b, c, quiet]) {
      expect(await linkOf(id)).toMatchObject({ syncState: 'synced', otoappAttendeeId: id, syncAttempts: 2, syncError: null });
      expect(await appRows(id)).toHaveLength(1);
    }
    expect(await linkOf(refused)).toMatchObject({ syncState: 'failed', syncAttempts: 1 });
    expect(await appRows(refused)).toHaveLength(0);

    // No sale, no tender, no amount touched; each pass still one sale and one tender of its price.
    expect(await money()).toEqual(before);
    for (const id of [a, b, c, quiet]) {
      const link = await linkOf(id);
      const [s] = await ctx.db.select().from(sale).where(eq(sale.id, link.saleId!));
      const tenders = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, link.saleId!));
      expect(s!.grossSatang).toBe(link.priceSnapshotSatang);
      expect(tenders.map((t) => t.amountSatang)).toEqual([link.priceSnapshotSatang]);
    }

    // One audit row for the press, saying what it did.
    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ops.run_retry'), eq(auditLog.entityId, pressed.id)));
    expect(entry!.after).toMatchObject({ integration: ATTENDEE_CREATE_RUN, linkId: c, sent: 4, synced: 4, waiting: 0 });

    // Every run of the group again — nothing more is sent, nothing charged. The
    // 422 refusal is its own group's, so it is not "waiting" for these presses.
    const again = sent.length;
    for (const id of [a, b, c, quiet]) {
      const r = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(id)).id}/retry`, {});
      expect(r.body).toMatchObject({ outcome: 'ok', syncState: 'synced', sent: 0, synced: 0, waiting: 0 });
    }
    expect(sent.length).toBe(again);
    expect(await money()).toEqual(before);
  });

  it("the refusal's own group, once the cause is fixed, sends the refusal — and only then is nothing waiting", async () => {
    const [refused] = await waitingOf(operatorId);
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(refused!)).id}/retry`, {});
    expect(res.body).toMatchObject({ outcome: 'ok', syncState: 'synced', sent: 1, synced: 1, waiting: 0 });
    expect(await waitingOf(operatorId)).toEqual([]);
    expect(await appRows(refused!)).toHaveLength(1);
  });
});

// =============================================================================
// 2. Reach: the caller's operator, and the branches where it may manage ops
// =============================================================================

describe('2. a Retry reaches only where its caller may manage ops', () => {
  it('ops at Central only: a Chalong run is 403 with nothing sent; a Central run sends Central\'s children and leaves Chalong\'s waiting', async () => {
    await settle();
    const outage = { status: 503, error: 'service_unavailable' };
    answers.push(outage);
    const atChalong = await post<EventAttendeeWriteAnswer>(
      chalongManager,
      `/events/${ev.chalongParty}/attendees`,
      walkUp({ name: 'Fon', branchId: chalong }),
    );
    expect(atChalong.status, JSON.stringify(atChalong.body)).toBe(200);
    const chalongChild = atChalong.body.attendee.id;
    const centralOne = await soldThrough(ev.reach, 'Gun', outage);
    const centralTwo = await soldThrough(ev.reach, 'Hom', outage);
    expect(await waitingOf(operatorId)).toEqual([chalongChild, centralOne, centralTwo]);

    const sentBefore = sent.length;
    const refused = await post<Refusal>(centralOps, `/ops/runs/${(await lastFailedRun(chalongChild)).id}/retry`, {});
    expect(refused.status).toBe(403);
    expect(sent.length).toBe(sentBefore);
    expect(await linkOf(chalongChild)).toMatchObject({ syncState: 'pending', syncAttempts: 1 });

    const res = await post<RetryAnswer>(centralOps, `/ops/runs/${(await lastFailedRun(centralTwo)).id}/retry`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // `waiting` counts only what this caller reaches: Chalong is not theirs.
    expect(res.body).toMatchObject({ outcome: 'ok', sent: 2, synced: 2, waiting: 0 });
    expect(sent.slice(sentBefore).map((x) => x.id)).toEqual([centralTwo, centralOne]);
    expect(await linkOf(chalongChild)).toMatchObject({ syncState: 'pending', syncAttempts: 1 });

    // The operator's administrator reaches Chalong from a Central run already synced.
    const wide = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(centralTwo)).id}/retry`, {});
    expect(wide.body).toMatchObject({ outcome: 'ok', syncState: 'synced', sent: 1, synced: 1, waiting: 0 });
    expect(sent.at(-1)!.id).toBe(chalongChild);
    expect(await waitingOf(operatorId)).toEqual([]);
  });

  it("another operator's Retry sends only its own child, and OTO's Retry never sends theirs", async () => {
    await settle();
    // OTO has a child waiting.
    const otoChild = await soldThrough(ev.reach, 'Ice', 'down');

    // The second operator has one too, with a failed run of its own at its branch.
    const foreignEvent = newId();
    const foreign = await insertLink({ operator: secondOperatorId, branchId: secondBranch, eventId: foreignEvent, name: 'Foreign' });
    answers.push('down');
    await pushAttendee({ db: ctx.db, directory: directoryOf() }, foreign);
    const foreignRun = await lastFailedRun(foreign);
    expect(foreignRun).toMatchObject({ operatorId: secondOperatorId, branchId: secondBranch });

    // Their press: their child only (the app does not know their event: refused, theirs to fix).
    let before = sent.length;
    const theirs = await post<RetryAnswer>(secondAdmin, `/ops/runs/${foreignRun.id}/retry`, {});
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(sent.slice(before).map((x) => x.id)).toEqual([foreign]);
    expect(await linkOf(otoChild)).toMatchObject({ syncState: 'pending', syncAttempts: 1 });

    // OTO's press for its own child: never the other operator's, waiting or refused.
    before = sent.length;
    const ours = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(otoChild)).id}/retry`, {});
    expect(ours.body).toMatchObject({ outcome: 'ok', sent: 1, synced: 1, waiting: 0 });
    expect(sent.slice(before).map((x) => x.id)).toEqual([otoChild]);
    const foreignAfter = await linkOf(foreign);
    expect(foreignAfter.syncAttempts).toBe(2);

    // And OTO cannot press the other operator's run at all.
    const cross = await post<Refusal>(admin, `/ops/runs/${foreignRun.id}/retry`, {});
    expect(cross.status).toBe(404);
    expect((await linkOf(foreign)).syncAttempts).toBe(2);
    // Their child stays theirs to settle.
    await ctx.db.update(eventAttendeeLink).set({ archivedAt: new Date() }).where(eq(eventAttendeeLink.id, foreign));
  });
});

// =============================================================================
// 3. When a sweep stops
// =============================================================================

describe('3. a sweep stops where every other send would end the same way', () => {
  it('the app still down: one call, the others untouched; the key refused: one call, then that group\'s Retry sends the refusal and the rest', async () => {
    await settle();
    const outage = { status: 504, error: 'gateway_timeout' };
    const p = await soldThrough(ev.stop, 'Jay', outage);
    const q = await soldThrough(ev.stop, 'Kat', outage);
    const r = await soldThrough(ev.stop, 'Lek', outage);
    const pressed = (await lastFailedRun(r)).id;

    // Still down.
    let before = sent.length;
    answers.push('down');
    const down = await post<RetryAnswer>(admin, `/ops/runs/${pressed}/retry`, {});
    expect(down.body).toMatchObject({ ok: true, outcome: 'failed', syncState: 'pending', sent: 1, synced: 0, waiting: 3 });
    expect(sent.length - before).toBe(1);
    expect([(await linkOf(p)).syncAttempts, (await linkOf(q)).syncAttempts]).toEqual([1, 1]);

    // The key refused (rotated at the app): stop at the first child.
    before = sent.length;
    answers.push({ status: 401, error: 'unauthorized' });
    const keyed = await post<RetryAnswer>(admin, `/ops/runs/${pressed}/retry`, {});
    expect(keyed.body).toMatchObject({ outcome: 'failed', syncState: 'failed', sent: 1, synced: 0 });
    expect(sent.length - before).toBe(1);
    expect(await linkOf(r)).toMatchObject({ syncState: 'failed' });
    expect((await linkOf(r)).syncError).toMatch(/^OTOAPP_UNAUTHORIZED: /);
    expect([(await linkOf(p)).syncAttempts, (await linkOf(q)).syncAttempts]).toEqual([1, 1]);

    // The key fixed: the 401 group's Retry sends the refused child and the waiting ones.
    const keyRun = await lastFailedRun(r);
    expect(keyRun.errorCode).toBe('OTOAPP_UNAUTHORIZED');
    before = sent.length;
    const fixed = await post<RetryAnswer>(admin, `/ops/runs/${keyRun.id}/retry`, {});
    expect(fixed.body).toMatchObject({ outcome: 'ok', syncState: 'synced', sent: 3, synced: 3, waiting: 0 });
    expect(sent.slice(before).map((x) => x.id)).toEqual([r, p, q]);
    for (const id of [p, q, r]) expect(await appRows(id)).toHaveLength(1);
  });

  it("a refusal of another kind is not resent by an outage's Retry, even when it is older", async () => {
    await settle();
    const refused = await soldThrough(ev.stop, 'Mon', { status: 409, error: 'conflict' });
    const waiting = await soldThrough(ev.stop, 'Nok', 'down');
    const before = sent.length;
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(waiting)).id}/retry`, {});
    expect(res.body).toMatchObject({ outcome: 'ok', sent: 1, waiting: 0 });
    expect(sent.slice(before).map((x) => x.id)).toEqual([waiting]);
    expect(await linkOf(refused)).toMatchObject({ syncState: 'failed', syncAttempts: 1 });
  });
});

// =============================================================================
// 4. Twice at once
// =============================================================================

describe('4. two presses at once, and a press racing a live sale', () => {
  it('two Retry presses at the same moment: every child lands once in the app, and no money moves', async () => {
    await settle();
    const outage = { status: 502, error: 'bad_gateway' };
    const ids = [
      await soldThrough(ev.race, 'Oat', outage),
      await soldThrough(ev.race, 'Pam', outage),
      await soldThrough(ev.race, 'Pun', outage),
    ];
    const before = await money();
    const run = (await lastFailedRun(ids[2]!)).id;
    const [x, y] = await Promise.all([
      post<RetryAnswer>(admin, `/ops/runs/${run}/retry`, {}),
      post<RetryAnswer>(admin, `/ops/runs/${run}/retry`, {}),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    // A press that lost a race to the app's own insert is answered as not reached;
    // the next press settles it. Whatever happened, no child is in the app twice.
    if ((await waitingOf(operatorId)).length > 0) {
      await post<RetryAnswer>(admin, `/ops/runs/${run}/retry`, {});
    }
    for (const id of ids) {
      expect(await linkOf(id)).toMatchObject({ syncState: 'synced', otoappAttendeeId: id });
      expect(await appRows(id)).toHaveLength(1);
    }
    expect(await money()).toEqual(before);
  });

  it('a Retry racing a till selling a pass: the new child lands once, the till takes one sale and one tender', async () => {
    await settle();
    const stale = await soldThrough(ev.race, 'Rin', 'down');
    const fresh = newId();
    const before = await money();
    const [press, sold] = await Promise.all([
      post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(stale)).id}/retry`, {}),
      post<EventAttendeeWriteAnswer>(reception, `/events/${ev.race}/passes`, pass({ name: 'Sai', attendeeId: fresh })),
    ]);
    expect([press.status, sold.status]).toEqual([200, 200]);
    const after = await money();
    expect(after.sales.length - before.sales.length).toBe(1);
    expect(after.tenders.length - before.tenders.length).toBe(1);
    if ((await waitingOf(operatorId)).length > 0) {
      await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(stale)).id}/retry`, {});
    }
    for (const id of [stale, fresh]) {
      expect(await linkOf(id)).toMatchObject({ syncState: 'synced' });
      expect(await appRows(id)).toHaveLength(1);
    }
    expect((await money()).tenders.length).toBe(after.tenders.length);
  });
});

// =============================================================================
// 5. The edges
// =============================================================================

describe('5. the bound, an archived child, and a waiting row with no stored body', () => {
  it(`the route's bound: ${WRITE_BACK_SWEEP_LIMIT} children in one press, oldest first, and the rest counted as waiting for the next`, async () => {
    await settle();
    const base = Date.now() - 60 * 60_000;
    const many: string[] = [];
    for (let i = 0; i < WRITE_BACK_SWEEP_LIMIT + 2; i += 1) {
      many.push(await insertLink({ eventId: ev.bulk, name: `Bulk ${i}`, createdAt: new Date(base + i * 1000) }));
    }
    // The newest has a failed run, as the page would show it.
    const pressed = many.at(-1)!;
    answers.push('down');
    await pushAttendee({ db: ctx.db, directory: directoryOf() }, pressed);

    const before = sent.length;
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(pressed)).id}/retry`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // `outcome` is whether everything in reach is now in the app: two still wait.
    expect(res.body).toMatchObject({ outcome: 'failed', syncState: 'synced', sent: WRITE_BACK_SWEEP_LIMIT, synced: WRITE_BACK_SWEEP_LIMIT, waiting: 2 });
    expect(sent.slice(before).map((x) => x.id)).toEqual([pressed, ...many.slice(0, WRITE_BACK_SWEEP_LIMIT - 1)]);
    expect(await waitingOf(operatorId)).toEqual(many.slice(WRITE_BACK_SWEEP_LIMIT - 1, -1));

    const next = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(pressed)).id}/retry`, {});
    expect(next.body).toMatchObject({ outcome: 'ok', sent: 2, synced: 2, waiting: 0 });
    expect(await waitingOf(operatorId)).toEqual([]);
    const landed = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from otoapp_v.event_attendees where event_id = ${ev.bulk}`,
    );
    expect(landed.rows[0]!.n).toBe(many.length);
  }, 120_000);

  it('an archived child is neither sent nor counted as waiting', async () => {
    await settle();
    const archived = await insertLink({ eventId: ev.edge, name: 'Gone', createdAt: new Date(Date.now() - 60_000) });
    await ctx.db.update(eventAttendeeLink).set({ archivedAt: new Date() }).where(eq(eventAttendeeLink.id, archived));
    const live = await soldThrough(ev.reach, 'Tan', 'down');
    const before = sent.length;
    const res = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(live)).id}/retry`, {});
    expect(res.body).toMatchObject({ outcome: 'ok', sent: 1, waiting: 0 });
    expect(sent.slice(before).map((x) => x.id)).toEqual([live]);
    expect(await linkOf(archived)).toMatchObject({ syncState: 'pending', syncAttempts: 0 });
  });

  /**
   * The schema lets a link wait with no stored body (`writeback` is nullable
   * and `sync_state` defaults to 'pending'), and `sendAttendee` throws a plain
   * Error for one. No E2 path writes such a row — every till link stores its
   * body — but a later round that adds booking or kiosk links could. Before
   * the fix, only a press of that row's own run met it; the sweep now meets it
   * on EVERY write-back Retry of the operator, oldest first.
   *
   * Fixed at landing: the sweep walks past a row with no body (it stays
   * counted as waiting), so the press answers and the children after it are
   * reached.
   */
  it('a waiting row with no stored body is walked past, still counted as waiting', async () => {
    await settle();
    const bodiless = await insertLink({
      eventId: ev.edge,
      name: 'No body',
      writeback: null,
      source: 'booking',
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    const later = await insertLink({ eventId: ev.edge, name: 'After it', createdAt: new Date(Date.now() - 20 * 60_000) });
    const pressedChild = await soldThrough(ev.reach, 'Uma', 'down');
    const run = (await lastFailedRun(pressedChild)).id;
    const auditsBefore = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, 'ops.run_retry'));
    try {
      const res = await post<RetryAnswer>(admin, `/ops/runs/${run}/retry`, {});
      expect(res.status).toBe(200);
      // The pressed child and the row after the bodiless one both landed;
      // the bodiless row is untouched and still counted as waiting.
      expect(await linkOf(pressedChild)).toMatchObject({ syncState: 'synced' });
      expect(await linkOf(later)).toMatchObject({ syncState: 'synced' });
      expect(await linkOf(bodiless)).toMatchObject({ syncState: 'pending', syncAttempts: 0 });
      expect(res.body.waiting).toBe(1);
      const auditsAfter = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, 'ops.run_retry'));
      expect(auditsAfter.length).toBe(auditsBefore.length + 1);
    } finally {
      await ctx.db.update(eventAttendeeLink).set({ archivedAt: new Date() }).where(inArray(eventAttendeeLink.id, [bodiless, later]));
    }
  });

  it('a press skips the bodiless row and still reaches the children after it', async () => {
    await settle();
    const bodiless = await insertLink({
      eventId: ev.edge,
      name: 'No body again',
      writeback: null,
      source: 'booking',
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    const later = await insertLink({ eventId: ev.edge, name: 'After it again', createdAt: new Date(Date.now() - 20 * 60_000) });
    const pressedChild = await soldThrough(ev.reach, 'Vee', 'down');
    try {
      const res = await post<RetryAnswer>(admin, `/ops/runs/${(await lastFailedRun(pressedChild)).id}/retry`, {});
      expect(res.status).toBe(200);
      expect(await linkOf(later)).toMatchObject({ syncState: 'synced' });
    } finally {
      await ctx.db.update(eventAttendeeLink).set({ archivedAt: new Date() }).where(inArray(eventAttendeeLink.id, [bodiless, later]));
    }
  });
});
