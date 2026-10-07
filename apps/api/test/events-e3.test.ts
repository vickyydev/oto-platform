import { and, asc, desc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  auditLog,
  band,
  bandEvent,
  branch,
  checkin,
  eventAttendeeLink,
  eventCheckin,
  opsRun,
  printJob,
  station,
} from '@oto/db';
import {
  EventCheckinAnswerSchema,
  addDaysToIsoDate,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type EventCheckinAnswer,
  type EventDayAnswer,
  type EventRosterAnswer,
} from '@oto/shared';
import { decideGate } from '@oto/box-agent/gate';
import { ATTENDEE_CHECKIN_RUN, checkInEventAttendee } from '../src/services/event-checkins';
import { currentBandKey } from '../src/services/bands';
import { countAt } from '../src/services/occupancy';
import { buildPrintDocument } from '../src/services/sale-printing';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryCheckinAnswer,
  DirectoryCheckinBody,
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
 * S2-20 E3 — CHECK-IN, CHECK-OUT AND REPRINT AT AN EVENT (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md, the E3 row of §9: check 4; hazards
 * H4, H5, H6, H7, H8 and H9; part of check 7 for the check-in write-back).
 *
 * Check 4: "Checking in a camp attendee prints a kid band, and a parent band
 * when the parent is attending, both carrying the event title, date and
 * dietary or allergy flag; checking the same attendee in again the same day is
 * refused with 'already checked in'; checking in the next camp day succeeds; no
 * supervision gate appears at any point."
 *
 * The OTO App is real as far as it can be without its server: its tables are
 * built by its own migrations in schema `otoapp`, and the directory the api
 * calls is the app's own write code (`server/directory/eventWrites.ts`) run
 * against them — so the check-in the app holds is read back through the
 * `otoapp_v` views. The stub around it can be told to fail.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let tillBox: string;
let reception: string;
let admin: string;
let accountId: string;
let T: string;
let appPool: pg.Pool;
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();

const ev = {
  camp: newId(),
  oldOpenCamp: newId(),
  workshop: newId(),
  party: newId(),
  tomorrowWorkshop: newId(),
};
const kid = {
  /** Every camp day, parent staying, an allergy and a diet. */
  allDays: newId(),
  /** The camp's two edge days only: not today (H5). */
  edges: newId(),
  /** Today only, no parent. */
  today: newId(),
  /** Two tills at once (H4). */
  race: newId(),
  /** Checked in at the OTO App's own screen. */
  appOnly: newId(),
  /** For the write-back's forced failure and its retry. */
  flaky: newId(),
  /** Every day of a camp that began over a year ago and has no end (item 6). */
  club: newId(),
  /** Checked in at the till; the OTO App's own "Undo check-in" takes it back; checked in again. */
  undo: newId(),
};
let workshopKid: string;
let partyKid: string;

// --- The OTO App's directory, from its own source ------------------------------

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; message: string };
interface AppWrites {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  recordAttendeeCheckin(
    pool: pg.Pool,
    event: AppEvent,
    attendeeId: string,
    input: DirectoryCheckinBody,
  ): Promise<AppOutcome<DirectoryCheckinAnswer>>;
}
let appWrites: AppWrites;

type Plan = 'app' | 'unreachable' | 'lost_answer';
const plan: { attendee: Plan[]; checkin: Plan[] } = { attendee: [], checkin: [] };
const calls: { checkin: Array<{ eventId: string; attendeeId: string; body: DirectoryCheckinBody }> } = { checkin: [] };

const unreachable = { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };

function asOutcome<T>(outcome: AppOutcome<T>): DirectoryOutcome<T> {
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
    const next = plan.attendee.shift() ?? 'app';
    if (next === 'unreachable') return unreachable;
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.createEventAttendee(appPool, event, body);
    if (next === 'lost_answer') return unreachable;
    return asOutcome(outcome);
  },
  async checkinAttendee(eventId, attendeeId, body) {
    calls.checkin.push({ eventId, attendeeId, body });
    // The app's directory takes these keys and no others (`checkinBodySchema`, strict).
    for (const key of Object.keys(body)) expect(['id', 'date', 'checkedInAt', 'checkedInBy']).toContain(key);
    const next = plan.checkin.shift() ?? 'app';
    if (next === 'unreachable') return unreachable;
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body);
    if (next === 'lost_answer') return unreachable;
    return asOutcome(outcome);
  },
};

// --- Helpers ---------------------------------------------------------------------

async function appEvent(e: { id: string; type: string; title: string; date: string; campEnd?: string | null }) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, child_name, parent_name, num_children, num_adults, status)
    values (
      ${e.id}, ${appTenant}, ${appCentral}, ${e.type}, ${e.title}, ${e.date}, ${e.campEnd ?? null},
      '09:00', '15:00', 600, 700,
      ${e.type === 'birthday' ? 'Mali' : null}, ${e.type === 'birthday' ? 'Nok' : null}, 12, 10, 'upcoming')`);
}

async function register(o: {
  id: string;
  eventId: string;
  name: string;
  days: string[];
  allergies?: string | null;
  diet?: string | null;
  parentAttending?: boolean;
}) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, food_restrictions, attendance_days, parent_signature, signature_date, parent_attending)
    values (${o.id}, ${appTenant}, ${o.eventId}, ${o.name}, '2019-04-01', 'May', '+66812349999',
            ${o.allergies ?? null}, ${o.diet ?? null}, ${JSON.stringify(o.days)}::jsonb, 'signed', ${T},
            ${o.parentAttending ?? false})`);
}

async function post<T>(cookie: string | null, url: string, payload: unknown): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: cookie ? { cookie } : {},
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

async function get<T>(cookie: string, url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

const checkinUrl = (eventId: string, attendeeId: string) => `/events/${eventId}/attendees/${attendeeId}/checkin`;
const checkoutUrl = (eventId: string, attendeeId: string) => `/events/${eventId}/attendees/${attendeeId}/checkout`;
const reprintUrl = (eventId: string, attendeeId: string) => `/events/${eventId}/attendees/${attendeeId}/reprint`;

function checkinBody(o: { checkinId?: string; stationId?: string | null } = {}) {
  return {
    branchId: central,
    checkinId: o.checkinId ?? newId(),
    ...(o.stationId === null ? {} : { stationId: o.stationId ?? till }),
    actionId: newId(),
  };
}

async function bandsOfCheckin(checkinId: string) {
  return ctx.db.select().from(band).where(eq(band.eventCheckinId, checkinId)).orderBy(asc(band.createdAt));
}

/** The OTO App's own day for one child, read through its view. */
async function appDay(eventId: string, attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null; checked_in_by: string | null }>(sql`
    select status, checkin_ref, checked_in_by from otoapp_v.event_attendance
     where event_id = ${eventId} and attendee_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows[0] ?? null;
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [t1] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillBox = t1!.boxId!;
  const [rec] = await ctx.db.select().from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  accountId = rec!.id;

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as AppWrites;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);

  await appEvent({ id: ev.camp, type: 'camp', title: 'Ocean camp', date: D(-1), campEnd: D(2) });
  await appEvent({ id: ev.oldOpenCamp, type: 'camp', title: 'Year-round club', date: D(-400), campEnd: null });
  await appEvent({ id: ev.workshop, type: 'workshop', title: 'Slime workshop', date: T });
  await appEvent({ id: ev.party, type: 'birthday', title: "Mali's 6th", date: T });
  await appEvent({ id: ev.tomorrowWorkshop, type: 'workshop', title: 'Tomorrow workshop', date: D(1) });

  await register({ id: kid.allDays, eventId: ev.camp, name: 'Lin', days: [], allergies: 'Peanuts', diet: 'Vegetarian', parentAttending: true });
  await register({ id: kid.edges, eventId: ev.camp, name: 'Edge', days: [D(-1), D(2)] });
  await register({ id: kid.today, eventId: ev.camp, name: 'Toda', days: [T] });
  await register({ id: kid.race, eventId: ev.camp, name: 'Racer', days: [] });
  await register({ id: kid.appOnly, eventId: ev.camp, name: 'Appy', days: [] });
  await register({ id: kid.flaky, eventId: ev.camp, name: 'Flaky', days: [] });
  await register({ id: kid.club, eventId: ev.oldOpenCamp, name: 'Clubber', days: [] });
  await register({ id: kid.undo, eventId: ev.camp, name: 'Undine', days: [], allergies: 'Shellfish', parentAttending: true });

  const workshop = (await appWrites.findTenantEvent(appPool, appTenant, ev.workshop))!;
  workshopKid = newId();
  expect(
    (await appWrites.createEventAttendee(appPool, workshop, {
      id: workshopKid,
      childFullName: 'Wren',
      foodRestrictions: 'No pork',
      parentAttending: false,
      attendanceDays: [],
      source: 'pos',
    })).status,
  ).toBe(201);
  const party = (await appWrites.findTenantEvent(appPool, appTenant, ev.party))!;
  partyKid = newId();
  expect(
    (await appWrites.createEventAttendee(appPool, party, {
      id: partyKid,
      childFullName: 'Pim',
      parentName: 'Ning',
      parentAttending: true,
      attendanceDays: [],
      source: 'pos',
    })).status,
  ).toBe(201);

  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  plan.attendee.length = 0;
  plan.checkin.length = 0;
});

// =============================================================================
// Check 4
// =============================================================================

describe('check 4 — a camp child checked in: a kid band and a parent band, refused twice, the next day fine', () => {
  const checkinId = newId();
  let answer: EventCheckinAnswer;

  it('checks the child in, mints a kid band and a parent band, and prints both at the till', async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.allDays), checkinBody({ checkinId }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(EventCheckinAnswerSchema.safeParse(res.body).success).toBe(true);
    answer = res.body;
    expect(answer).toMatchObject({
      replayed: false,
      checkin: { id: checkinId, eventId: ev.camp, attendeeId: kid.allDays, date: T, status: 'checked_in', origin: 'till' },
    });
    expect(answer.checkin.kidBand).toMatchObject({ kind: 'kid', shortCode: expect.stringMatching(/^T1-/) });
    expect(answer.checkin.parentBand).toMatchObject({ kind: 'adult', shortCode: expect.stringMatching(/^T1-/) });
    expect(answer.printJobs.map((j) => [j.kind, j.status])).toEqual([
      ['kids_wristband', 'queued'],
      ['adult_wristband', 'queued'],
    ]);
    expect(answer.notes).toEqual([]);

    const bands = await bandsOfCheckin(checkinId);
    expect(bands.map((b) => [b.kind, b.gateAccess, b.saleId, b.status])).toEqual([
      ['kid', false, null, 'active'],
      ['adult', true, null, 'active'],
    ]);
    // Each band's paper is the job the check-in queued, at the till's box.
    for (const b of bands) {
      const [job] = await ctx.db.select().from(printJob).where(eq(printJob.id, b.printedJobId!));
      expect(job).toMatchObject({ subjectType: 'band', subjectId: b.id, boxId: tillBox, stationId: till });
    }
  });

  it('both bands carry the event title and the date; the kid band the allergy and diet lines', async () => {
    const [kidBand, parentBand] = await bandsOfCheckin(checkinId);
    const docOf = async (jobId: string) => (await buildPrintDocument(ctx.db, { boxId: tillBox, operatorId }, jobId)).job;
    const kidDoc = await docOf(kidBand!.printedJobId!);
    expect(kidDoc).toMatchObject({
      kind: 'kids_wristband',
      data: {
        holderName: 'Lin',
        partyName: 'Ocean camp',
        duration: T,
        startEndTime: '09:00 – 15:00',
        allergy: 'Peanuts',
        dietaryRequirement: 'Vegetarian',
        bandCode: kidBand!.code,
      },
    });
    const parentDoc = await docOf(parentBand!.printedJobId!);
    expect(parentDoc).toMatchObject({
      kind: 'adult_wristband',
      data: { holderName: 'May', partyName: 'Ocean camp', duration: T, bandCode: parentBand!.code },
    });
    // The allergy and diet lines are the kid band's alone.
    expect((parentDoc as unknown as { data: Record<string, unknown> }).data.allergy).toBeUndefined();
    expect((parentDoc as unknown as { data: Record<string, unknown> }).data.dietaryRequirement).toBeUndefined();
  });

  it("the OTO App has the check-in, under the till's id, for today", async () => {
    expect(answer.checkin.syncState).toBe('synced');
    expect(await appDay(ev.camp, kid.allDays, T)).toMatchObject({ status: 'checked_in', checkin_ref: checkinId });
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CHECKIN_RUN), sql`${opsRun.detail}->>'checkinId' = ${checkinId}`));
    expect(run).toMatchObject({ kind: 'integration', outcome: 'ok' });
  });

  it('the same child again the same day is refused "already checked in", and no band is minted', async () => {
    const before = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(band);
    const res = await post<{ error: { code: string; message: string } }>(reception, checkinUrl(ev.camp, kid.allDays), checkinBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'EVENT_ALREADY_CHECKED_IN', message: 'This child is already checked in for today.' });
    const after = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(band);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('the same check-in id again is the same press, answered again — no second band', async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.allDays), checkinBody({ checkinId }));
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body.replayed).toBe(true);
    expect(res.body.checkin.kidBand!.id).toBe(answer.checkin.kidBand!.id);
    expect(await bandsOfCheckin(checkinId)).toHaveLength(2);
  });

  it('checking in the next camp day succeeds, with bands of its own', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const next = await checkInEventAttendee(
      { db: ctx.db, directory },
      {},
      { accountId, operatorId, branchId: central },
      ev.camp,
      kid.allDays,
      { branchId: central, checkinId: newId(), stationId: till },
      tomorrow,
    );
    expect(next.answer.checkin).toMatchObject({ date: D(1), status: 'checked_in' });
    expect(next.answer.checkin.kidBand!.id).not.toBe(answer.checkin.kidBand!.id);
    expect(await appDay(ev.camp, kid.allDays, D(1))).toMatchObject({ status: 'checked_in' });
  });

  it('no supervision gate appears at any point (H6): no stay, no supervision audit row', async () => {
    const stays = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(checkin);
    expect(stays[0]!.n).toBe(0);
    const supervision = await ctx.db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} like 'sale.supervision%' or ${auditLog.action} like 'supervision%'`);
    expect(supervision).toEqual([]);
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin'), eq(auditLog.entityId, checkinId)));
    expect(row!.after).toMatchObject({ stationId: till, boxId: tillBox, origin: 'till' });
  });

  it('the roster shows the child in, with the short codes of the bands they wear', async () => {
    const { body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${T}`);
    expect(body.groups.in).toContain(kid.allDays);
    const lin = body.event.attendees!.find((a) => a.id === kid.allDays)!;
    expect(lin.checkins[0]).toMatchObject({
      date: T,
      status: 'checked_in',
      posCheckinId: checkinId,
      kidBandShortCode: answer.checkin.kidBand!.shortCode,
      parentBandShortCode: answer.checkin.parentBand!.shortCode,
      syncState: 'synced',
    });
  });
});

// =============================================================================
// H5 — not registered today
// =============================================================================

describe('H5 — a camp child is not checked in on a day they are not registered', () => {
  it('is refused "Not registered for today" by the platform, whatever the screen shows, with nothing written', async () => {
    const id = newId();
    const res = await post<{ error: { code: string; message: string } }>(reception, checkinUrl(ev.camp, kid.edges), checkinBody({ checkinId: id }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'EVENT_NOT_REGISTERED_TODAY', message: 'Not registered for today' });
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id))).toEqual([]);
    expect(calls.checkin.some((c) => c.body.id === id)).toBe(false);
  });

  it('an event that is not on today is refused too', async () => {
    const res = await post<{ error: { code: string } }>(reception, checkinUrl(ev.tomorrowWorkshop, workshopKid), checkinBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_TODAY');
  });
});

// =============================================================================
// H4 — two tills, one child
// =============================================================================

describe('H4 — two tills check the same child in at once', () => {
  it('one succeeds and the other is refused "already checked in"; one set of bands', async () => {
    const a = newId();
    const b = newId();
    const [r1, r2] = await Promise.all([
      post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.race), checkinBody({ checkinId: a })),
      post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.race), checkinBody({ checkinId: b })),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const rows = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.attendeeId, kid.race), eq(eventCheckin.attendanceDate, T)));
    expect(rows).toHaveLength(1);
    expect(await bandsOfCheckin(rows[0]!.id)).toHaveLength(1);
  });
});

// =============================================================================
// A one-off event and a party: one day, one check-in
// =============================================================================

describe('a one-off event and a party', () => {
  it('a workshop child is checked in with a kid band carrying their diet line, and the app holds the check-in', async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.workshop, workshopKid), checkinBody());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.parentBand).toBeNull();
    const [kidBand] = await bandsOfCheckin(res.body.checkin.id);
    const doc = await buildPrintDocument(ctx.db, { boxId: tillBox, operatorId }, kidBand!.printedJobId!);
    expect(doc.job).toMatchObject({ data: { holderName: 'Wren', partyName: 'Slime workshop', dietaryRequirement: 'No pork' } });
    expect(await appDay(ev.workshop, workshopKid, T)).toMatchObject({ status: 'checked_in', checkin_ref: res.body.checkin.id });
  });

  it('a party guest whose parent stays gets a kid band and a parent band', async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.party, partyKid), checkinBody());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.kidBand).not.toBeNull();
    expect(res.body.checkin.parentBand).not.toBeNull();
  });

  it('a device that is no station checks the child in and prints nothing, and says so', async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.today), checkinBody({ stationId: null }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.kidBand).toBeNull();
    expect(res.body.printJobs).toEqual([]);
    expect(res.body.notes.join(' ')).toMatch(/no band was printed/);
  });
});

// =============================================================================
// Reprint and check-out
// =============================================================================

describe('reprint and check-out', () => {
  it('a reprint of a check-in with no band issues its bands once, then fresh paper for the same bands', async () => {
    const first = await post<EventCheckinAnswer>(reception, reprintUrl(ev.camp, kid.today), { branchId: central, stationId: till });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const kidBand = first.body.checkin.kidBand!;
    expect(kidBand).toBeTruthy();
    const again = await post<EventCheckinAnswer>(reception, reprintUrl(ev.camp, kid.today), {
      branchId: central,
      stationId: till,
      reason: 'Band torn',
    });
    expect(again.status).toBe(200);
    expect(again.body.checkin.kidBand!.id).toBe(kidBand.id);
    expect(again.body.printJobs).toHaveLength(1);
    expect(again.body.printJobs[0]).toMatchObject({ kind: 'kids_wristband', reprintReason: 'Band torn', reprintOf: first.body.printJobs[0]!.reprintOf ?? first.body.printJobs[0]!.id });
    const events = await ctx.db.select().from(bandEvent).where(and(eq(bandEvent.bandId, kidBand.id), eq(bandEvent.kind, 'reprinted')));
    expect(events.length).toBe(2);
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'event.band_reprint'));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('checks the child out; a second check-out and a second check-in the same day are refused', async () => {
    const out = await post<EventCheckinAnswer>(reception, checkoutUrl(ev.camp, kid.today), { branchId: central, stationId: till });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.checkin).toMatchObject({ status: 'checked_out', checkedOutBy: expect.any(String) });
    const twice = await post<{ error: { code: string } }>(reception, checkoutUrl(ev.camp, kid.today), { branchId: central });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('EVENT_ALREADY_CHECKED_OUT');
    const backIn = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, kid.today), checkinBody());
    expect(backIn.status).toBe(409);
    expect(backIn.body.error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    // Reprint only while in and not out.
    const reprint = await post<{ error: { code: string } }>(reception, reprintUrl(ev.camp, kid.today), { branchId: central, stationId: till });
    expect(reprint.status).toBe(409);
    const [row] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'event.checkout'));
    expect(row!.after).toMatchObject({ writtenBack: false, stationId: till });
  });

  it('a child nobody checked in is refused at check-out', async () => {
    const res = await post<{ error: { code: string; message: string } }>(reception, checkoutUrl(ev.camp, kid.flaky), { branchId: central });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'EVENT_NOT_CHECKED_IN', message: 'This child is not checked in for today.' });
  });

  it('a child the OTO App checked in is "already checked in" here, checks out, and is mirrored as the app\'s', async () => {
    await ctx.db.execute(sql`
      insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status,
        checked_in_at, checked_in_by)
      values (${kid.appOnly}, ${appTenant}, ${ev.camp}, ${T}, 'checked_in', now() at time zone 'UTC', 'App staff')`);
    const res = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, kid.appOnly), checkinBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    const out = await post<EventCheckinAnswer>(reception, checkoutUrl(ev.camp, kid.appOnly), { branchId: central });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.checkin).toMatchObject({ origin: 'otoapp', status: 'checked_out', checkedInBy: 'App staff', syncState: 'synced' });
    const { body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${T}`);
    expect(body.groups.out).toContain(kid.appOnly);
  });
});

// =============================================================================
// The write-back: a forced failure and its retry from Failures (part of check 7)
// =============================================================================

describe('the check-in write-back fails, waits as pending, and Failures sends it again', () => {
  const checkinId = newId();

  it('an unreachable OTO App leaves the check-in pending — the child is still in, banded', async () => {
    plan.checkin.push('unreachable');
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.flaky), checkinBody({ checkinId }));
    expect(res.status).toBe(200);
    expect(res.body.checkin).toMatchObject({ status: 'checked_in', syncState: 'pending' });
    expect(res.body.checkin.syncError).toMatch(/^OTOAPP_DIRECTORY_UNREACHABLE/);
    expect(res.body.checkin.kidBand).not.toBeNull();
    expect(await appDay(ev.camp, kid.flaky, T)).toBeNull();
    const { body } = await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${T}`);
    const flaky = body.event.attendees!.find((a) => a.id === kid.flaky)!;
    expect(flaky.bucket).toBe('in');
    expect(flaky.checkins[0]!.syncState).toBe('pending');
  });

  it('the Failures page offers Retry, and the press writes it once, under the same id', async () => {
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CHECKIN_RUN), eq(opsRun.outcome, 'failed'), sql`${opsRun.detail}->>'checkinId' = ${checkinId}`))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect(run).toBeTruthy();
    const res = await post<{ ok: boolean; syncState: string; sent: number }>(admin, `/ops/runs/${run!.id}/retry`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, syncState: 'synced' });
    expect(await appDay(ev.camp, kid.flaky, T)).toMatchObject({ status: 'checked_in', checkin_ref: checkinId });
    const sent = calls.checkin.filter((c) => c.body.id === checkinId);
    expect(sent.length).toBe(2);
    expect(new Set(sent.map((c) => JSON.stringify(c.body))).size).toBe(1);
  });
});

describe('a walk-up the OTO App does not have yet is checked in, and the app is told the child first', () => {
  it("the check-in waits for the child; one Retry sends the child, then the check-in", async () => {
    plan.attendee.push('unreachable');
    const attendeeId = newId();
    const added = await post<{ attendee: { syncState: string } }>(reception, `/events/${ev.party}/attendees`, {
      branchId: central,
      stationId: till,
      attendeeId,
      actionId: newId(),
      attendee: { name: 'Late Leo', parentName: 'Lee', parentAttending: false, allergyFlag: true, allergyDetail: 'Egg' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.attendee.syncState).toBe('pending');

    plan.attendee.push('unreachable');
    const checkinId = newId();
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.party, attendeeId), checkinBody({ checkinId }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin).toMatchObject({ status: 'checked_in', syncState: 'pending' });
    expect(res.body.checkin.syncError).toMatch(/^OTOAPP_ATTENDEE_NOT_SYNCED/);
    // The kid band carries the allergy the till captured.
    const [kidBand] = await bandsOfCheckin(checkinId);
    const doc = await buildPrintDocument(ctx.db, { boxId: tillBox, operatorId }, kidBand!.printedJobId!);
    expect(doc.job).toMatchObject({ data: { holderName: 'Late Leo', allergy: 'Egg' } });

    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, ATTENDEE_CHECKIN_RUN), sql`${opsRun.detail}->>'checkinId' = ${checkinId}`))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    const retried = await post<{ syncState: string }>(admin, `/ops/runs/${run!.id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.syncState).toBe('synced');
    const [link] = await ctx.db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, attendeeId));
    expect(link!.syncState).toBe('synced');
    expect(await appDay(ev.party, attendeeId, T)).toMatchObject({ status: 'checked_in', checkin_ref: checkinId });
  });
});

// =============================================================================
// Item 6 — a camp on every day of its range, end to end
// =============================================================================

describe('a camp that began over a year ago and has no end, on every day of its range', () => {
  it('lists its every-day child as expected today, and checks them in', async () => {
    const day = await get<EventDayAnswer>(reception, `/events?branchId=${central}&date=${T}`);
    const club = day.body.events.find((e) => e.id === ev.oldOpenCamp)!;
    const child = club.attendees!.find((a) => a.id === kid.club)!;
    expect(child).toMatchObject({ attendsAllDays: true, attendsOnDate: true, bucket: 'outstanding' });
    // The written-out days hold today, so the board lights it.
    expect(child.attendanceDays).toContain(T);
    expect(child.attendanceDays.length).toBeLessThanOrEqual(366);
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.oldOpenCamp, kid.club), checkinBody());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

// =============================================================================
// H7, H8, H9 — the readers of a band that has no sale
// =============================================================================

describe('an event band at the food counter, the gate, History and the occupancy count', () => {
  let kidCode: string;
  let parentCode: string;
  let kidId: string;
  let parentId: string;

  beforeAll(async () => {
    const [row] = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.attendeeId, kid.allDays), eq(eventCheckin.attendanceDate, T)));
    const bands = await bandsOfCheckin(row!.id);
    kidCode = bands.find((b) => b.kind === 'kid')!.code;
    kidId = bands.find((b) => b.kind === 'kid')!.id;
    parentCode = bands.find((b) => b.kind === 'adult')!.code;
    parentId = bands.find((b) => b.kind === 'adult')!.id;
  });

  it('H9 — the kid band at F&B returns the allergy and diet lines, and mayOrderFood=false', async () => {
    const res = await get<{ stay: Record<string, unknown> | null }>(
      reception,
      `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kidCode)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stay).toMatchObject({
      source: 'event',
      childName: 'Lin',
      allergiesMedical: 'Peanuts',
      foodRestrictions: 'Vegetarian',
      mayOrderFood: false,
      foodProvision: null,
    });
  });

  it('H8 — at the gate the kid band is denied and the parent band admitted', () => {
    const key = currentBandKey()!;
    const lookup = (id: string) =>
      id === kidId
        ? ({ state: 'active', kind: 'kid', gateAccess: false } as const)
        : id === parentId
          ? ({ state: 'active', kind: 'adult', gateAccess: true } as const)
          : ({ state: 'unknown' } as const);
    const common = { direction: 'entry' as const, key, lookup, inside: () => false, unknownMeans: 'not_found' as const };
    expect(decideGate({ ...common, code: kidCode })).toMatchObject({ open: false, reason: 'KID_BAND' });
    expect(decideGate({ ...common, code: parentCode })).toMatchObject({ open: true, bandId: parentId });
  });

  it('H7 — History finds the band and names no sale; the occupancy count takes the kid with the parent', async () => {
    const res = await get<{ match: { bandIds: string[] }; sales: unknown[] }>(
      reception,
      `/sales/lookup?band=${encodeURIComponent(kidCode)}&branchId=${central}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.match.bandIds).toEqual([kidId]);

    const from = new Date(Date.now() - 3600_000);
    const before = await countAt(ctx.db, central, from, new Date());
    await ctx.db.insert(bandEvent).values({ id: newId(), bandId: parentId, kind: 'entry', stationId: till, boxId: tillBox, detail: {} });
    const after = await countAt(ctx.db, central, from, new Date(Date.now() + 1000));
    expect(after.adults - before.adults).toBe(1);
    expect(after.kids - before.kids).toBe(1);
  });
});

// =============================================================================
// Q1 — the OTO App's own "Undo check-in" after it had the till's check-in
// =============================================================================

describe("an undo in the OTO App after it had the till's check-in (Q1: the app is the master)", () => {
  const first = newId();
  const second = newId();
  let firstBands: (typeof band.$inferSelect)[];

  const scan = (code: string) =>
    get<{ stay: Record<string, unknown> | null }>(reception, `/wallets/scan?branchId=${central}&key=${encodeURIComponent(code)}`);
  const roster = async () =>
    (await get<EventRosterAnswer>(reception, `/events/${ev.camp}/roster?branchId=${central}&date=${T}`)).body;

  beforeAll(async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.undo), checkinBody({ checkinId: first }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin.syncState).toBe('synced');
    firstBands = await bandsOfCheckin(first);
    expect(firstBands.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
    // The OTO App's own "Undo check-in" (`POST /api/core/camp-checkins/:id/undo-check-in`), as SQL.
    await ctx.db.execute(sql`
      update otoapp.camp_attendance
         set status = 'waiting', checked_in_at = null, checked_in_by = null, updated_at = now()
       where camp_registration_id = ${kid.undo} and attendance_date = ${T}`);
  });

  it('the roster follows the app: the child is expected again, and the till cannot check out or reprint a day the app took back', async () => {
    const body = await roster();
    expect(body.groups.outstanding).toContain(kid.undo);
    expect(body.groups.in).not.toContain(kid.undo);
    const out = await post<{ error: { code: string } }>(reception, checkoutUrl(ev.camp, kid.undo), { branchId: central });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe('EVENT_NOT_CHECKED_IN');
    const reprint = await post<{ error: { code: string } }>(reception, reprintUrl(ev.camp, kid.undo), { branchId: central, stationId: till });
    expect(reprint.status).toBe(409);
    expect(reprint.body.error.code).toBe('EVENT_NOT_CHECKED_IN');
  });

  it('the till checks the child in again: new bands, the app holds the new check-in, the first one set aside with its bands revoked', async () => {
    const res = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.undo), checkinBody({ checkinId: second }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.checkin).toMatchObject({ id: second, status: 'checked_in', syncState: 'synced' });
    expect(await appDay(ev.camp, kid.undo, T)).toMatchObject({ status: 'checked_in', checkin_ref: second });

    const [old] = await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, first));
    expect(old!.undoneAt).not.toBeNull();
    const oldNow = await bandsOfCheckin(first);
    expect(oldNow.map((b) => b.status)).toEqual(['revoked', 'revoked']);
    const revoked = await ctx.db
      .select()
      .from(bandEvent)
      .where(and(eq(bandEvent.kind, 'revoked'), sql`${bandEvent.detail}->>'eventCheckinId' = ${first}`));
    expect(revoked).toHaveLength(2);
    const [undone] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin_undone'), eq(auditLog.entityId, first)));
    expect(undone!.after).toMatchObject({ reason: 'undone_in_otoapp', nextCheckinId: second });
    expect([...(undone!.after as { revokedBandIds: string[] }).revokedBandIds].sort()).toEqual(firstBands.map((b) => b.id).sort());

    const fresh = await bandsOfCheckin(second);
    expect(fresh.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
    expect(fresh.map((b) => b.id)).not.toEqual(firstBands.map((b) => b.id));

    // The board shows the new check-in, with its own bands.
    const body = await roster();
    expect(body.groups.in).toContain(kid.undo);
    const undine = body.event.attendees!.find((a) => a.id === kid.undo)!;
    expect(undine.checkins.find((c) => c.date === T)).toMatchObject({ posCheckinId: second, checkinRef: second });

    // The food counter reads the new kid band, and nobody behind the revoked one.
    const oldKid = firstBands.find((b) => b.kind === 'kid')!;
    const was = await scan(oldKid.code);
    expect(was.status === 404 || was.body.stay === null).toBe(true);
    const now = await scan(fresh.find((b) => b.kind === 'kid')!.code);
    expect(now.body.stay).toMatchObject({ childName: 'Undine', allergiesMedical: 'Shellfish', mayOrderFood: false });
  });

  it('the day is held again: a third check-in is refused, and the replay of the second answers the second', async () => {
    const third = await post<{ error: { code: string } }>(reception, checkinUrl(ev.camp, kid.undo), checkinBody());
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('EVENT_ALREADY_CHECKED_IN');
    const replay = await post<EventCheckinAnswer>(reception, checkinUrl(ev.camp, kid.undo), checkinBody({ checkinId: second }));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, checkin: { id: second } });
    const rows = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.attendeeId, kid.undo), eq(eventCheckin.attendanceDate, T)));
    expect(rows.map((r) => [r.id, r.undoneAt === null])).toEqual(
      expect.arrayContaining([
        [first, false],
        [second, true],
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

// =============================================================================
// Permission
// =============================================================================

describe('pos:event:checkin', () => {
  it('signed out: 401 on check-in, check-out and reprint', async () => {
    expect((await post(null, checkinUrl(ev.camp, kid.allDays), checkinBody())).status).toBe(401);
    expect((await post(null, checkoutUrl(ev.camp, kid.allDays), { branchId: central })).status).toBe(401);
    expect((await post(null, reprintUrl(ev.camp, kid.allDays), { branchId: central, stationId: till })).status).toBe(401);
  });

  it('no alert was raised for anything above', async () => {
    const raised = await ctx.db.select().from(alert).where(sql`${alert.category} like 'event.%'`);
    expect(raised).toEqual([]);
  });
});

// =============================================================================
// A replayed check-out answers what it answered
// =============================================================================

describe('the idempotency store keeps the route’s answer', () => {
  it('a check-out sent twice under one Idempotency-Key answers the same check-in both times', async () => {
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: checkoutUrl(ev.workshop, workshopKid),
        payload: { branchId: central, stationId: till },
        headers: { cookie: reception, 'idempotency-key': 'e3-checkout-replay' },
      });
    const first = await send();
    expect(first.statusCode, first.body).toBe(200);
    const again = await send();
    expect(again.statusCode, again.body).toBe(200);
    expect(EventCheckinAnswerSchema.safeParse(again.json()).success).toBe(true);
    expect(again.json()).toEqual(first.json());
  });
});
