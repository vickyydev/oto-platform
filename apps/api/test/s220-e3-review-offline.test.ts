import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, band, branch, eventCheckin, station, syncQuarantine } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent, type CredentialStore } from '@oto/box-agent';
import {
  EVENT_FACTS,
  addDaysToIsoDate,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type EventCheckinAnswer,
  type OfflineEventCheckedIn,
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
 * S2-20 E3 — REVIEW of the box lane (SCRUM-217; events-kiosk PLAN §5
 * "Offline", §4 "Two tills, one child", H4, H5, H9). Written against the lane,
 * not beside it: nothing is taken from `events-e3-offline.test.ts`.
 *
 * A real counter box (`createBoxAgent` over the `edge` schema) pulls today's
 * events and loses its link. While it is down, the OTO App moves one child off
 * today and checks another in at its own screen; the box checks both in from
 * its now stale copy, and a third child once. Two facts are also queued on the
 * box's outbox by hand — what a box's fact can say, whatever the copy said: a
 * child not registered for the day, and a day the camp is not on. The link
 * comes back.
 *
 *   - A check-in made with the link down reconciles ONCE: one row, its bands,
 *     one audit, one write to the OTO App — and the same again (a replayed
 *     batch, a re-sent fact under a fresh envelope) changes nothing.
 *   - (pinned, finding) A box fed a stale copy cannot check in a child the app
 *     moved to another day: the platform files it, bands it and writes the
 *     app an attendance for a day the child is not registered.
 *   - (pinned, finding) "Not registered for today" holds on the box replay
 *     door too, and so does "this event is not on that day".
 *   - (pinned, finding) A child the app checked in at its own screen while the
 *     box was down keeps an allergy line at the food counter on the band the
 *     box printed — the only band they have.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let tillId: string;
let central: string;
let receptionId: string;
let T: string;
let agent: BoxAgent;
let credentials: CredentialStore;
let appPool: pg.Pool;
const link: CuttableLink = { cut: false };

const appTenant = newId();
const appCentral = newId();
const camp = newId();
const kid = { once: newId(), mover: newId(), appFirst: newId(), edge: newId(), every: newId() };

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

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads the bridge's answers loosely, field by field
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>) {
  return call('POST', `/box/v1/station/${tillId}/intents`, { type, lastSeenSequence: 0, payload, actionId: `rv-${newId().slice(-12)}` });
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
}

async function register(id: string, name: string, days: string[], o: { allergies?: string; parentAttending?: boolean } = {}) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${camp}, ${name}, '2019-04-01', 'May', ${`+668100${id.slice(-5).replace(/[^0-9]/g, '7')}`},
            ${o.allergies ?? null}, ${JSON.stringify(days)}::jsonb, 'signed', ${T}, ${o.parentAttending ?? false})`);
}

async function appRows(attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null }>(sql`
    select status::text as status, checkin_ref from otoapp.camp_attendance
     where camp_registration_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows;
}

const posRows = (attendeeId: string, date: string) =>
  ctx.db
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.attendeeId, attendeeId), eq(eventCheckin.attendanceDate, date)));

/** A fact as a box's outbox carries it: what the box's events desk would queue, written by hand. */
function handFact(attendeeId: string, name: string, date: string) {
  const fact: OfflineEventCheckedIn = {
    checkinId: newId(),
    eventId: camp,
    attendeeId,
    eventType: 'camp',
    date,
    at: new Date().toISOString(),
    childName: name,
    parentName: 'May',
    parentAttending: false,
    allergy: null,
    dietary: null,
    eventTitle: 'Harbour camp',
    startTime: '09:00',
    endTime: '15:00',
    kidBand: null,
    parentBand: null,
  };
  return {
    fact,
    queued: {
      type: EVENT_FACTS.checkedIn,
      payload: fact as unknown as Record<string, unknown>,
      stationId: tillId,
      actorKind: 'account' as const,
      actorAccountId: receptionId,
      actionId: `rv-${newId().slice(-12)}`,
    },
  };
}

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: { OPS_TEST_CONTROLS: 'true', STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, box.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  central = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [rec] = await ctx.db.select().from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3-review-offline')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (${camp}, ${appTenant}, ${appCentral}, 'camp', 'Harbour camp', ${addDaysToIsoDate(T, -1)},
            ${addDaysToIsoDate(T, 2)}, '09:00', '15:00', 600, 700, 12, 10, 'upcoming')`);
  await register(kid.once, 'Once', [], { allergies: 'Kiwi', parentAttending: true });
  await register(kid.mover, 'Mover', [T, addDaysToIsoDate(T, 1)]);
  await register(kid.appFirst, 'Appfirst', [], { allergies: 'Egg' });
  await register(kid.edge, 'Edgar', [addDaysToIsoDate(T, -1)]);
  await register(kid.every, 'Every', []);

  credentials = memoryCredentialStore();
  agent = createBoxAgent({
    apiBaseUrl: 'http://events-review-box.test',
    credentials,
    hostname: 'events-review-box',
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, box.id)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
    bands: { key: currentBandKey },
  });
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

describe('E3 review — event check-ins on the box lane', () => {
  const onceId = newId();
  const moverId = newId();
  const appFirstId = newId();
  let appFirstKidShort: string;
  let onceFact: { queuedAgain: boolean } = { queuedAgain: false };
  const edgeFact = { id: '' };
  const rangeFact = { id: '' };

  it('the box pulls the day; the link goes down; the app then moves one child off today and checks another in at its screen', async () => {
    await agent.syncCache();
    await agent.syncEvents();
    await agent.setOffline(true, { reason: 'E3 review' });
    link.cut = true;
    await ctx.db.execute(sql`
      update otoapp.camp_registrations set attendance_days = ${JSON.stringify([addDaysToIsoDate(T, 1)])}::jsonb where id = ${kid.mover}`);
    await ctx.db.execute(sql`delete from otoapp.camp_attendance where camp_registration_id = ${kid.mover} and attendance_date = ${T}`);
    await ctx.db.execute(sql`
      insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at, checked_in_by)
      values (${kid.appFirst}, ${appTenant}, ${camp}, ${T}, 'checked_in', now() at time zone 'UTC', 'App staff')
      on conflict (camp_registration_id, attendance_date) do update set status = 'checked_in', checked_in_by = 'App staff'`);
  });

  it('with the link down, the box checks all three in from its copy, bands minted and printed there', async () => {
    for (const [attendeeId, checkinId] of [
      [kid.once, onceId],
      [kid.mover, moverId],
      [kid.appFirst, appFirstId],
    ] as const) {
      const res = await onBox('event.checkin', { eventId: camp, attendeeId, checkinId, staffName: 'Nok' });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect((res.body.result as EventCheckinAnswer).checkin).toMatchObject({ id: checkinId, origin: 'box', date: T });
      if (attendeeId === kid.appFirst) appFirstKidShort = (res.body.result as EventCheckinAnswer).checkin.kidBand!.shortCode!;
    }
  });

  it('two facts written by hand on the outbox: a child not registered today, and a day the camp is not on', async () => {
    const edge = handFact(kid.edge, 'Edgar', T);
    edgeFact.id = edge.fact.checkinId;
    await agent.outbox()!.queue(edge.queued);
    const range = handFact(kid.every, 'Every', addDaysToIsoDate(T, 5));
    rangeFact.id = range.fact.checkinId;
    await agent.outbox()!.queue(range.queued);
  });

  it('the link comes back: the plain check-in files once — one row, its two bands, one audit, one write to the app', async () => {
    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
    const rows = await posRows(kid.once, T);
    expect(rows.map((r) => [r.id, r.origin, r.syncState])).toEqual([[onceId, 'box', 'synced']]);
    expect(await ctx.db.select().from(band).where(eq(band.eventCheckinId, onceId))).toHaveLength(2);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.checkin'), eq(auditLog.entityId, onceId)));
    expect(audits).toHaveLength(1);
    expect(await appRows(kid.once, T)).toEqual([{ status: 'checked_in', checkin_ref: onceId }]);
    expect(sentCheckins.filter((id) => id === onceId)).toHaveLength(1);
  });

  it('…and never twice: the batch replayed, and the same fact re-sent under a fresh envelope, change nothing', async () => {
    const replayed = await agent.outbox()!.replayLastBatch(10);
    expect(replayed).toBeGreaterThan(0);
    await flushAll();
    const [first] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.checkin'), eq(auditLog.entityId, onceId)));
    // The fact again, as a restored store would mint it: a new envelope, the same check-in.
    const [row] = await posRows(kid.once, T);
    const bands = await ctx.db.select().from(band).where(eq(band.eventCheckinId, onceId));
    await agent.outbox()!.queue({
      type: EVENT_FACTS.checkedIn,
      payload: {
        checkinId: onceId,
        eventId: camp,
        attendeeId: kid.once,
        eventType: 'camp',
        date: T,
        at: row!.checkedInAt.toISOString(),
        childName: 'Once',
        parentName: 'May',
        parentAttending: true,
        allergy: 'Kiwi',
        dietary: null,
        eventTitle: 'Harbour camp',
        startTime: '09:00',
        endTime: '15:00',
        kidBand: { id: bands.find((b) => b.kind === 'kid')!.id, code: bands.find((b) => b.kind === 'kid')!.code },
        parentBand: { id: bands.find((b) => b.kind === 'adult')!.id, code: bands.find((b) => b.kind === 'adult')!.code },
      },
      stationId: tillId,
      actorKind: 'account',
      actorAccountId: receptionId,
    });
    onceFact = { queuedAgain: true };
    await flushAll();
    expect(onceFact.queuedAgain).toBe(true);
    expect(await posRows(kid.once, T)).toHaveLength(1);
    expect(await ctx.db.select().from(band).where(eq(band.eventCheckinId, onceId))).toHaveLength(2);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'event.checkin'), eq(auditLog.entityId, onceId)));
    expect(audits.map((a) => a.id)).toEqual([first!.id]);
    expect(await appRows(kid.once, T)).toHaveLength(1);
    expect(sentCheckins.filter((id) => id === onceId)).toHaveLength(1);
    const open = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.status, 'open'), sql`${syncQuarantine.payload}->>'checkinId' = ${onceId}`));
    expect(open).toEqual([]);
  });

  /**
   * FINDING (H5 on the box door) — `applyEventCheckedIn` (sync-events.ts) never
   * asks whether the child attends the day, so a box whose copy was taken
   * before the OTO App moved the child files the check-in as it stands, keeps
   * its bands live and writes the app a `checked_in` attendance for a day the
   * child is not registered. Expected: refused into quarantine for a person
   * (the drop-off path's own answer to a fact the platform cannot take), the
   * app untouched.
   */
  it.fails('a box fed a stale copy does not check in a child the app moved to another day: the app gets no attendance for it', async () => {
    expect(await appRows(kid.mover, T)).toEqual([]);
    const rows = await posRows(kid.mover, T);
    expect(rows.filter((r) => r.syncState === 'synced')).toEqual([]);
  });

  it.fails('a hand-written fact for a child not registered today is not filed as a check-in, and not sent to the app', async () => {
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, edgeFact.id))).toEqual([]);
    expect(await appRows(kid.edge, T)).toEqual([]);
  });

  it.fails('a hand-written fact for a day the camp is not on is not filed as a check-in, and not sent to the app', async () => {
    expect(await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, rangeFact.id))).toEqual([]);
    expect(await appRows(kid.every, addDaysToIsoDate(T, 5))).toEqual([]);
  });

  it('a child the app checked in meanwhile: the box fact resolves to the app’s check-in, with a warning — no second POS check-in', async () => {
    const rows = await posRows(kid.appFirst, T);
    expect(rows).toEqual([]);
    expect(await ctx.db.select().from(band).where(eq(band.eventCheckinId, appFirstId))).toEqual([]);
    const [dup] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin_duplicate'), sql`${auditLog.after}->>'boxCheckinId' = ${appFirstId}`));
    expect(dup!.after).toMatchObject({ bandsRecorded: false, duplicateOf: { where: 'otoapp' } });
  });

  /**
   * FINDING (H9, ties to the builder's question 2) — when the first check-in
   * is the OTO App's own, it has no band: the bands the box printed are the
   * ONLY ones the child wears, yet they are not recorded, so the food counter
   * reads no allergy on the child's band (and the gate refuses the parent's).
   * Expected: the app's check-in mirrored, and the box's bands recorded on it.
   */
  it.fails("the band the box printed for that child still names their allergy at the food counter", async () => {
    const scan = await call('GET', `/wallets/scan?branchId=${central}&key=${encodeURIComponent(appFirstKidShort)}`);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.stay).toMatchObject({ childName: 'Appfirst', allergiesMedical: 'Egg', mayOrderFood: false });
  });
});
