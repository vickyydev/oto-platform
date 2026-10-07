import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, auditLog, band, branch, eventCheckin, station, syncQuarantine } from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type BoxAgent,
  type CredentialStore,
} from '@oto/box-agent';
import {
  addDaysToIsoDate,
  bandShortCode,
  businessDate,
  newId,
  parseDayStart,
  type EventCheckinAnswer,
  type EventsCacheItem,
} from '@oto/shared';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryCheckinAnswer,
  DirectoryCheckinBody,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-20 E3 — AN EVENT CHECK-IN AT A COUNTER WITH THE LINK DOWN (plan §5
 * "Offline"; the E3 row of §9: "box facts offline"; hazard H4's offline half).
 *
 * The platform and a counter box (`createBoxAgent`, the code a Pi runs, over the
 * `edge` schema as the virtual box runs), joined by a link this file cuts. The
 * box pulls today's events (the `events` cache scope); then, with the link
 * down, through the box's station bridge exactly as a till on the box lane
 * drives it: the day read from the copy, a camp child checked in (kid and
 * parent bands minted with the park's key and printed on the box), refused a
 * second time, "Not registered for today" for a child not on the day, the kid
 * band scanned at the food counter, the child checked out. Meanwhile a till
 * with the internet checks in a child the box still has as expected, and the
 * box checks the same child in again from its stale copy.
 *
 * The link comes back: each fact files once, the box's bands are recorded as
 * they were printed, the check-in reaches the OTO App under the box's own id,
 * and the second check-in of the same child-day RESOLVES TO THE FIRST — no
 * second band recorded, a warning naming both (H4).
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let cookieB: string;
let tillId: string;
let counterId: string;
let central: string;
let boxId: string;
let T: string;
let agent: BoxAgent;
let credentials: CredentialStore;
let appPool: pg.Pool;
const link: CuttableLink = { cut: false };

const appTenant = newId();
const appCentral = newId();
const camp = newId();
const kid = {
  lin: newId(),
  edge: newId(),
  twice: newId(),
  /** Registered for today when the box pulls its copy; the OTO App then moves them to tomorrow. */
  moved: newId(),
  /** Checked in at a till; the OTO App's own "Undo check-in" takes it back; the box checks them in. */
  taken: newId(),
};

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; message: string };
let appWrites: {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(pool: pg.Pool, event: AppEvent, input: DirectoryAttendeeBody): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  recordAttendeeCheckin(pool: pg.Pool, event: AppEvent, attendeeId: string, input: DirectoryCheckinBody): Promise<AppOutcome<DirectoryCheckinAnswer>>;
};
const sentCheckins: string[] = [];

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee() {
    return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not here', retryable: true };
  },
  async checkinAttendee(eventId, attendeeId, body) {
    sentCheckins.push(body.id);
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    const outcome = await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body);
    if (outcome.ok) return { ok: true, status: outcome.status, body: outcome.body };
    return { ok: false, status: outcome.status, code: `OTOAPP_${outcome.error.toUpperCase()}`, message: outcome.message, retryable: false };
  },
};

function makeAgent(): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://events-box.test',
    credentials,
    hostname: 'events-box',
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
    bands: { key: currentBandKey },
  });
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as = cookie) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: as },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads the bridge's answers loosely, field by field
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>, actionId = `ev-${newId().slice(-12)}`) {
  return call('POST', `/box/v1/station/${tillId}/intents`, { type, lastSeenSequence: 0, payload, actionId });
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
}

async function register(id: string, name: string, days: string[], o: { allergies?: string; diet?: string; parentAttending?: boolean } = {}) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, food_restrictions, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${camp}, ${name}, '2019-04-01', 'May', '+66812349999',
            ${o.allergies ?? null}, ${o.diet ?? null}, ${JSON.stringify(days)}::jsonb, 'signed', ${T}, ${o.parentAttending ?? false})`);
}

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  boxId = box.id;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  central = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  const [counter] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  counterId = counter!.id;

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3-offline')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (${camp}, ${appTenant}, ${appCentral}, 'camp', 'Ocean camp', ${addDaysToIsoDate(T, -1)},
            ${addDaysToIsoDate(T, 2)}, '09:00', '15:00', 600, 700, 12, 10, 'upcoming')`);
  await register(kid.lin, 'Lin', [], { allergies: 'Peanuts', diet: 'Vegetarian', parentAttending: true });
  await register(kid.edge, 'Edge', [addDaysToIsoDate(T, -1)]);
  await register(kid.twice, 'Twice', []);
  await register(kid.moved, 'Mo', [T]);
  await register(kid.taken, 'Tak', [], { allergies: 'Milk', parentAttending: true });

  credentials = memoryCredentialStore();
  agent = makeAgent();
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 300_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

describe('an event check-in with the link down (S2-20 E3)', () => {
  const checkinId = newId();
  const twiceBoxId = newId();
  let kidCode: string;
  let kidShort: string;
  let parentBandId: string;

  it("the box holds today's events, and reads them to the till with the link down", async () => {
    await agent.syncCache();
    await agent.syncEvents();
    await agent.setOffline(true, { reason: 'offline event check-in' });
    link.cut = true;
    const day = await onBox('events.day', {});
    expect(day.statusCode, JSON.stringify(day.body)).toBe(200);
    const item = day.body.result.item as EventsCacheItem;
    expect(item.date).toBe(T);
    const ocean = item.events.find((e) => e.id === camp)!;
    expect(ocean.attendees.find((a) => a.id === kid.lin)).toMatchObject({ allergy: 'Peanuts', dietary: 'Vegetarian', parentAttending: true, bucket: 'outstanding' });
    expect(ocean.attendees.find((a) => a.id === kid.edge)).toMatchObject({ attendsOnDate: false, bucket: 'notToday' });
  });

  it('a till with the internet checks a child in meanwhile; the box still has them as expected', async () => {
    const online = await call(
      'POST',
      `/events/${camp}/attendees/${kid.twice}/checkin`,
      { branchId: central, checkinId: newId(), stationId: counterId },
      cookieB,
    );
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);
  });

  it('checks the camp child in on the box: kid and parent bands minted and printed there, once', async () => {
    const res = await onBox('event.checkin', { eventId: camp, attendeeId: kid.lin, checkinId, staffName: 'Nok' });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const answer = res.body.result as EventCheckinAnswer;
    expect(answer.checkin).toMatchObject({ id: checkinId, status: 'checked_in', origin: 'box', date: T });
    expect(answer.checkin.kidBand!.shortCode).toMatch(/^T1-/);
    expect(answer.checkin.parentBand).not.toBeNull();
    expect(answer.printJobs.map((j) => j.kind)).toEqual(['kids_wristband', 'adult_wristband']);
    parentBandId = answer.checkin.parentBand!.id;
    kidShort = answer.checkin.kidBand!.shortCode!;

    const again = await onBox('event.checkin', { eventId: camp, attendeeId: kid.lin, checkinId });
    expect(again.statusCode).toBe(200);
    expect(again.body.result.replayed).toBe(true);
    expect(again.body.result.checkin.kidBand.id).toBe(answer.checkin.kidBand!.id);

    const second = await onBox('event.checkin', { eventId: camp, attendeeId: kid.lin, checkinId: newId() });
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'EVENT_ALREADY_CHECKED_IN', message: 'This child is already checked in for today.' });

    const notToday = await onBox('event.checkin', { eventId: camp, attendeeId: kid.edge, checkinId: newId() });
    expect(notToday.statusCode).toBe(409);
    expect(notToday.body.error).toMatchObject({ code: 'EVENT_NOT_REGISTERED_TODAY', message: 'Not registered for today' });

    // The day the till reads back has the child in.
    const day = await onBox('events.day', {});
    const lin = (day.body.result.item as EventsCacheItem).events.find((e) => e.id === camp)!.attendees.find((a) => a.id === kid.lin)!;
    expect(lin).toMatchObject({ bucket: 'in', checkin: { status: 'checked_in', posCheckinId: checkinId } });
  });

  it('a reprint on the box prints the same bands again, as copies', async () => {
    const res = await onBox('event.reprint', { eventId: camp, attendeeId: kid.lin, reason: 'Band torn' });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.checkin.kidBand.shortCode).toBe(kidShort);
    expect(res.body.result.printJobs.map((j: { kind: string }) => j.kind)).toEqual(['kids_wristband', 'adult_wristband']);
    expect(res.body.result.printJobs.every((j: { reprintReason: string | null }) => j.reprintReason !== null)).toBe(true);
  });

  it('the kid band at the food counter, offline: the allergy and diet lines, no food', async () => {
    const scan = await onBox('checkin.band_food', { key: kidShort });
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.result.stay).toMatchObject({
      source: 'event',
      childName: 'Lin',
      allergiesMedical: 'Peanuts',
      foodRestrictions: 'Vegetarian',
      mayOrderFood: false,
    });
  });

  it('the box checks in again a child its stale copy has as expected', async () => {
    const res = await onBox('event.checkin', { eventId: camp, attendeeId: kid.twice, checkinId: twiceBoxId });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  });

  it('checks the child out on the box; a second check-out is refused', async () => {
    const out = await onBox('event.checkout', { eventId: camp, attendeeId: kid.lin });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(out.body.result.checkin).toMatchObject({ id: checkinId, status: 'checked_out' });
    const twice = await onBox('event.checkout', { eventId: camp, attendeeId: kid.lin });
    expect(twice.statusCode).toBe(409);
    expect(twice.body.error.code).toBe('EVENT_ALREADY_CHECKED_OUT');
  });

  it('the link comes back: each fact files once, the bands as printed, and the OTO App has the check-in', async () => {
    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
    const quarantined = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agent.state.boxId!), eq(syncQuarantine.status, 'open')));
    expect(quarantined.map((q) => q.errorCode)).toEqual([]);

    const [row] = await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, checkinId));
    expect(row).toMatchObject({ origin: 'box', attendeeId: kid.lin, attendanceDate: T, allergy: 'Peanuts', boxId });
    expect(row!.checkedOutAt).not.toBeNull();
    const bands = await ctx.db.select().from(band).where(eq(band.eventCheckinId, checkinId)).orderBy(asc(band.kind));
    expect(bands.map((b) => [b.kind, b.gateAccess, b.saleId])).toEqual([
      ['adult', true, null],
      ['kid', false, null],
    ]);
    expect(bands.find((b) => b.kind === 'adult')!.id).toBe(parentBandId);
    kidCode = bands.find((b) => b.kind === 'kid')!.code;
    expect(bandShortCode(kidCode)).toMatch(/^T1-/);

    // Sent to the OTO App once the batch was filed, under the box's own id.
    expect(sentCheckins).toContain(checkinId);
    expect(row!.syncState).toBe('synced');
    const app = await ctx.db.execute<{ status: string; checkin_ref: string }>(sql`
      select status, checkin_ref from otoapp_v.event_attendance
       where event_id = ${camp} and attendee_id = ${kid.lin} and attendance_date = ${T}`);
    expect(app.rows[0]).toMatchObject({ status: 'checked_in', checkin_ref: checkinId });

    const audits = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, checkinId));
    expect(audits.map((a) => a.action).sort()).toEqual(['event.checkin', 'event.checkout']);
  });

  it('H4 offline — the second check-in of one child-day resolves to the first, and no second band is recorded', async () => {
    const rows = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.attendeeId, kid.twice), eq(eventCheckin.attendanceDate, T)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(twiceBoxId);
    expect(rows[0]!.origin).toBe('till');
    expect(await ctx.db.select().from(band).where(eq(band.eventCheckinId, twiceBoxId))).toEqual([]);
    const [dup] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'event.checkin_duplicate'));
    expect(dup!.after).toMatchObject({ boxCheckinId: twiceBoxId, bandsRecorded: false, duplicateOf: { checkinId: rows[0]!.id } });
    const [warned] = await ctx.db.select().from(alert).where(eq(alert.category, 'event.checked_in_twice'));
    expect(warned).toMatchObject({ severity: 'warning', status: 'open' });
  });

  it("the next events pull holds the box's check-in, and its overlay row is let go", async () => {
    expect(await agent.syncEvents()).toBe(true);
    const day = await onBox('events.day', {});
    const lin = (day.body.result.item as EventsCacheItem).events.find((e) => e.id === camp)!.attendees.find((a) => a.id === kid.lin)!;
    expect(lin).toMatchObject({ bucket: 'out', checkin: { status: 'checked_out', posCheckinId: checkinId } });
    const rows = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from edge.box_overlay where box_id = ${agent.state.boxId!} and payload->'record'->>'domain' = 'event'`);
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });
});

/**
 * S2-20 E3 fix round — THE OTO APP IS THE MASTER ON THE BOX LANE TOO (Q1, H5).
 * A box's fact is filed against what the app says when it arrives, not what
 * the box's copy said: a child the app moved off the day waits in quarantine
 * for a person (the app is not told, the box's bands are not recorded, and an
 * alert says so), and a child whose first check-in the app took back (its own
 * "Undo check-in") is checked in by the box's fact.
 */
describe('the OTO App is the master on the box lane too', () => {
  const takenFirst = newId();
  const takenBox = newId();
  const movedBox = newId();

  it('online, a child is checked in and the app undoes it', async () => {
    const online = await call(
      'POST',
      `/events/${camp}/attendees/${kid.taken}/checkin`,
      { branchId: central, checkinId: takenFirst, stationId: counterId },
      cookieB,
    );
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);
    expect(online.body.checkin.syncState).toBe('synced');
    // The app's own "Undo check-in", stamped as the app stamps it: naive UTC, whatever the server's zone.
    await ctx.db.execute(sql`
      update otoapp.camp_attendance
         set status = 'waiting', checked_in_at = null, checked_in_by = null, updated_at = now() at time zone 'UTC'
       where camp_registration_id = ${kid.taken} and attendance_date = ${T}`);
  });

  it('the box pulls the day and the link goes down; the app then moves another child off today', async () => {
    // The copy already reads the undone child as expected: the app's day is what it was.
    await agent.syncEvents();
    await agent.setOffline(true, { reason: 'the app is the master' });
    link.cut = true;
    await ctx.db.execute(sql`
      update otoapp.camp_registrations set attendance_days = ${JSON.stringify([addDaysToIsoDate(T, 1)])}::jsonb where id = ${kid.moved}`);
    await ctx.db.execute(sql`delete from otoapp.camp_attendance where camp_registration_id = ${kid.moved} and attendance_date = ${T}`);
  });

  it('with the link down, the box checks both in from its copy', async () => {
    for (const [attendeeId, checkinId] of [
      [kid.moved, movedBox],
      [kid.taken, takenBox],
    ] as const) {
      const res = await onBox('event.checkin', { eventId: camp, attendeeId, checkinId, staffName: 'Nok' });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    }
  });

  it("the link comes back: the moved child's fact waits in quarantine as a conflict, with an alert; nothing filed, nothing sent", async () => {
    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
    const quarantined = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.status, 'open'), sql`${syncQuarantine.payload}::text like ${`%${movedBox}%`}`));
    expect(quarantined.map((q) => [q.reason, q.errorCode])).toEqual([['conflict', 'SYNC_EVENT_NOT_REGISTERED']]);
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, movedBox))).toEqual([]);
    expect(await ctx.db.select().from(band).where(eq(band.eventCheckinId, movedBox))).toEqual([]);
    expect(sentCheckins).not.toContain(movedBox);
    const app = await ctx.db.execute(sql`
      select 1 from otoapp_v.event_attendance where event_id = ${camp} and attendee_id = ${kid.moved} and attendance_date = ${T}`);
    expect(app.rows).toEqual([]);
    const [warned] = await ctx.db.select().from(alert).where(eq(alert.category, 'event.checkin_off_day'));
    expect(warned).toMatchObject({ severity: 'warning', status: 'open' });
    expect(warned!.summary).toContain('Mo');
  });

  it("…and the child whose check-in the app undid is checked in by the box's fact: the first set aside, its bands revoked, the app told", async () => {
    const rows = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.attendeeId, kid.taken), eq(eventCheckin.attendanceDate, T)));
    const first = rows.find((r) => r.id === takenFirst)!;
    const boxRow = rows.find((r) => r.id === takenBox)!;
    expect(rows).toHaveLength(2);
    expect(first.undoneAt).not.toBeNull();
    expect(boxRow).toMatchObject({ origin: 'box', syncState: 'synced', undoneAt: null, allergy: 'Milk' });
    const firstBands = await ctx.db.select().from(band).where(eq(band.eventCheckinId, takenFirst));
    expect(firstBands.map((b) => b.status)).toEqual(['revoked', 'revoked']);
    const boxBands = await ctx.db.select().from(band).where(eq(band.eventCheckinId, takenBox));
    expect(boxBands.map((b) => [b.kind, b.status]).sort()).toEqual([
      ['adult', 'active'],
      ['kid', 'active'],
    ]);
    const app = await ctx.db.execute<{ status: string; checkin_ref: string }>(sql`
      select status, checkin_ref from otoapp_v.event_attendance
       where event_id = ${camp} and attendee_id = ${kid.taken} and attendance_date = ${T}`);
    expect(app.rows[0]).toMatchObject({ status: 'checked_in', checkin_ref: takenBox });
    const [undone] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin_undone'), eq(auditLog.entityId, takenFirst)));
    expect(undone!.after).toMatchObject({ reason: 'undone_in_otoapp', nextCheckinId: takenBox, boxId });
    expect(undone!.sourceEventId).not.toBeNull();
    // The paper the first check-in printed is revoked, and the child may be wearing it: a person is told.
    const told = await ctx.db
      .select()
      .from(alert)
      .where(and(eq(alert.category, 'event.checked_in_twice'), sql`${alert.summary} like '%Tak%'`));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ severity: 'warning', status: 'open' });
    expect(told[0]!.detail).toMatchObject({
      bandsRecorded: true,
      first: { checkinId: takenFirst, takenBack: true },
      setAside: [{ checkinId: takenFirst, revokedBandIds: expect.arrayContaining(firstBands.map((b) => b.id)) }],
      second: { checkinId: takenBox },
    });
  });
});
