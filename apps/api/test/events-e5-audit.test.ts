import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, alert, auditLog, band, branch, eventCheckin, station, syncQuarantine } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent } from '@oto/box-agent';
import {
  EVENT_FACTS,
  addDaysToIsoDate,
  businessDate,
  mintBandCode,
  newId,
  normalizePhone,
  parseDayStart,
  ulidFromUuid,
  type EventAttendeeWriteAnswer,
  type EventCheckinAnswer,
  type EventDayAnswer,
  type OfflineEventCheckedIn,
  type OfflineEventCheckedOut,
} from '@oto/shared';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { checkinViewOf } from '../src/services/event-checkins';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryCheckinAnswer,
  DirectoryCheckinBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-20 E5 — THE CLOSING AUDIT OF THE CHECK-IN SEAM (SCRUM-217; the notes the
 * E3 review carried to E5, from its code-read of the same `undone_at` seam).
 * Each is driven here against a real counter box (`createBoxAgent`) and the
 * OTO App's own write code over its own tables, and each now holds:
 *
 *   (a) a late replay of a check-in the OTO App took back (set aside since) is
 *       told so — never answered "checked in" with the codes of bands the gate
 *       now refuses;
 *   (b) a box's check-out of its own check-in that was set aside ends the
 *       check-in that stands when it came after it — the child is not left "in"
 *       with live bands — and ends only the set-aside one when it came before;
 *   (c) a till's mirror of an OTO App check-in that meets a box's row filed in
 *       the same instant is decided again with that row standing — never a 500
 *       — and so is a box's fact that meets a till's;
 *   (d) a box's check-in for an event the OTO App archived is refused into
 *       quarantine with an alert, as the till refuses it — never filed and owed
 *       to a directory that answers 404;
 *   (f) a stray, non-ISO date in the OTO App drops its event, never the day:
 *       the list, the passes and the box's copy still answer;
 *   (g) a synced walk-up whose registration the OTO App has since removed is
 *       "not on this event" by the till's link id and by the app's id alike.
 *
 * (e), the set-aside list surviving a later duplicate on the alert, is the E3
 * round-3 pin (`s220-e3-review-3-offline.test.ts`), flipped there.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let tillId: string;
let central: string;
let receptionId: string;
let T: string;
let agent: BoxAgent;
let appPool: pg.Pool;
let dbUrl: string;
const link: CuttableLink = { cut: false };
const D = (n: number) => addDaysToIsoDate(T, n);

const appTenant = newId();
const appCentral = newId();
const camp = newId();
const workshop = newId();
const archived = newId();
const stray = { camp: newId(), event: newId() };
const kid = {
  /** (a) checked in at the till, undone in the app, checked in again. */
  ada: newId(),
  /** (b) checked in on the box, undone in the app, checked in at the till, then the box's check-out after. */
  ben: newId(),
  /** (b) the same, the box's check-out from before the till's check-in. */
  cora: newId(),
  /** (c) checked in at the OTO App's own screen; the till checks her out while a box files her. */
  dina: newId(),
  /** (c) waiting; the box's fact meets a till's row filed in the same instant. */
  eli: newId(),
  /** (g) registered for tomorrow; sold a pass today the app merges in; then the app removes the registration. */
  gia: newId(),
};
const PHONE_GIA = '+66812355007';

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

function asOutcome<T>(o: AppOutcome<T>): DirectoryOutcome<T> {
  if (o.ok) return { ok: true, status: o.status, body: o.body };
  return { ok: false, status: o.status, code: `OTOAPP_${o.error.toUpperCase()}`, message: o.message, retryable: false };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.createEventAttendee(appPool, event, body));
  },
  async checkinAttendee(eventId, attendeeId, body) {
    sentCheckins.push(body.id);
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event) return { ok: false, status: 404, code: 'OTOAPP_EVENT_NOT_FOUND', message: 'Event not found', retryable: false };
    return asOutcome(await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body));
  },
};

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads the answers loosely, field by field
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function register(id: string, eventId: string, name: string, days: string[], phone = '+66812355000') {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${eventId}, ${name}, '2019-04-01', 'May', ${phone},
            'Sesame', ${JSON.stringify(days)}::jsonb, 'signed', ${T}, true)`);
}

/** The OTO App's own "Undo check-in" (routes.ts, undo-check-in), stamped as the app stamps it. */
async function appUndoes(registrationId: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'waiting', checked_in_at = null, checked_in_by = null, checked_out_at = null, checked_out_by = null,
           updated_at = (now() at time zone 'UTC')
     where camp_registration_id = ${registrationId} and attendance_date = ${T}`);
}

/** The OTO App's own check-in screen, which prints no band. */
async function appChecksIn(registrationId: string) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at, checked_in_by)
    values (${registrationId}, ${appTenant}, ${camp}, ${T}, 'checked_in', (now() at time zone 'UTC'), 'app staff')
    on conflict (camp_registration_id, attendance_date)
    do update set status = 'checked_in', checked_in_at = (now() at time zone 'UTC'), checked_in_by = 'app staff'`);
}

async function atTill(attendeeId: string, checkinId: string) {
  const res = await call('POST', `/events/${camp}/attendees/${attendeeId}/checkin`, { branchId: central, checkinId, stationId: tillId });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body as EventCheckinAnswer;
}

const rowById = async (id: string) => (await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id)))[0] ?? null;

function mintedBand(prefix = 'T1'): { id: string; code: string } {
  const id = newId();
  return { id, code: mintBandCode(prefix, ulidFromUuid(id), currentBandKey()!) };
}

function handIn(attendeeId: string, name: string, at: Date, eventId = camp): OfflineEventCheckedIn {
  return {
    checkinId: newId(),
    eventId,
    attendeeId,
    eventType: 'camp',
    date: T,
    at: at.toISOString(),
    childName: name,
    parentName: 'May',
    parentAttending: true,
    allergy: 'Sesame',
    dietary: null,
    eventTitle: 'Reef camp',
    startTime: '09:00',
    endTime: '15:00',
    kidBand: mintedBand(),
    parentBand: mintedBand(),
  };
}

async function queue(type: string, payload: OfflineEventCheckedIn | OfflineEventCheckedOut) {
  await agent.outbox()!.queue({
    type,
    payload: payload as unknown as Record<string, unknown>,
    stationId: tillId,
    actorKind: 'account',
    actorAccountId: receptionId,
    actionId: `e5a-${newId().slice(-12)}`,
  });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state === 'empty') return;
    if (outcome.state === 'offline' || outcome.state === 'not_registered') throw new Error(`cannot drain: ${outcome.state}`);
  }
  throw new Error('the outbox did not drain');
}

/** Wait until some statement on this database is waiting on a lock (a unique key held by an open transaction). */
async function someoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const res = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`);
    if ((res.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing waited on the open transaction');
}

/** A check-in row as the other side would write it, in a transaction of its own left open. */
async function openRowElsewhere(attendeeId: string, origin: 'box' | 'till'): Promise<{ id: string; commit: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  await client.query('begin');
  const id = newId();
  const [st] = await ctx.db.select().from(station).where(eq(station.id, tillId));
  await client.query(
    `insert into pos.event_checkin (
       id, operator_id, branch_id, otoapp_event_id, attendee_id, event_type, attendance_date, child_name,
       event_title, checked_in_at, origin, sync_state, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'camp', $6, 'Elsewhere', 'Reef camp', now(), $7, 'pending', now(), now())`,
    [id, st!.operatorId, central, camp, attendeeId, T, origin],
  );
  return {
    id,
    commit: async () => {
      await client.query('commit');
      await client.end();
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
  const boxRow = await boxBySlot(ctx.db, 'virtual-1');
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, boxRow.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  central = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [rec] = await ctx.db.select().from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));

  dbUrl = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url).href
  )) as typeof appWrites;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e5-audit')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  const event = async (id: string, type: string, title: string, date: string, campEnd: string | null) =>
    ctx.db.execute(sql`
      insert into otoapp.core_events (
        id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
        entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
      values (${id}, ${appTenant}, ${appCentral}, ${type}, ${title}, ${date}, ${campEnd}, '09:00', '15:00', 600, 700, 30, 30, 'upcoming')`);
  await event(camp, 'camp', 'Reef camp', D(-1), D(2));
  await event(workshop, 'workshop', 'Clay workshop', T, null);
  await event(archived, 'camp', 'Old camp', D(-1), D(2));
  for (const [k, name] of [['ada', 'Ada'], ['ben', 'Ben'], ['cora', 'Cora'], ['dina', 'Dina'], ['eli', 'Eli']] as const) {
    await register(kid[k], camp, name, []);
  }
  await register(kid.gia, camp, 'Gia', [D(1)], PHONE_GIA);
  await register(newId(), archived, 'Olly', []);

  agent = createBoxAgent({
    apiBaseUrl: 'http://events-e5-audit-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'events-e5-audit-box',
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxRow.id)).code,
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

describe('(a) a late replay of a check-in the OTO App took back', () => {
  const first = newId();
  const second = newId();

  it('the till checks Ada in, the app undoes it, the till checks her in again: the first is set aside, its bands revoked', async () => {
    await atTill(kid.ada, first);
    await appUndoes(kid.ada);
    await atTill(kid.ada, second);
    expect(await rowById(first)).toMatchObject({ undoneAt: expect.any(Date) });
    expect((await ctx.db.select().from(band).where(eq(band.eventCheckinId, first))).map((b) => b.status)).toEqual(['revoked', 'revoked']);
  });

  it('the first press sent again is told its check-in was taken back — no "checked in", no revoked band code', async () => {
    const replay = await call('POST', `/events/${camp}/attendees/${kid.ada}/checkin`, { branchId: central, checkinId: first, stationId: tillId });
    expect(replay.statusCode).toBe(409);
    expect(replay.body.error).toMatchObject({ code: 'EVENT_CHECKIN_TAKEN_BACK' });
    expect(replay.body.error.details).toMatchObject({ checkinId: first, undoneAt: expect.any(String) });
    expect(JSON.stringify(replay.body)).not.toMatch(/T1-/);
    // Nothing moved: the second check-in and its bands stand.
    expect(await rowById(second)).toMatchObject({ undoneAt: null });
    expect((await ctx.db.select().from(band).where(eq(band.eventCheckinId, second))).map((b) => b.status)).toEqual(['active', 'active']);
  });

  it('the record of a set-aside check-in never reads its bands back, and says when it was undone', async () => {
    const view = await checkinViewOf(ctx.db, (await rowById(first))!);
    expect(view).toMatchObject({ kidBand: null, parentBand: null, undoneAt: expect.any(String) });
    const standing = await checkinViewOf(ctx.db, (await rowById(second))!);
    expect(standing.kidBand).not.toBeNull();
    expect(standing.undoneAt).toBeNull();
  });
});

describe('(b) a box’s check-out of its own check-in that was set aside', () => {
  const benBox = { in: null as OfflineEventCheckedIn | null, till: newId() };
  const coraBox = { in: null as OfflineEventCheckedIn | null, till: newId() };
  let tillAt: number;

  it('the box checks Ben and Cora in; the app has them, then undoes both; the till checks both in again', async () => {
    benBox.in = handIn(kid.ben, 'Ben', new Date());
    coraBox.in = handIn(kid.cora, 'Cora', new Date());
    await queue(EVENT_FACTS.checkedIn, benBox.in);
    await queue(EVENT_FACTS.checkedIn, coraBox.in);
    await drain();
    expect(await rowById(benBox.in.checkinId)).toMatchObject({ origin: 'box', syncState: 'synced', undoneAt: null });
    await appUndoes(kid.ben);
    await appUndoes(kid.cora);
    // The box's check-out of Cora is from before the till's new check-in.
    const coraOutAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await atTill(kid.ben, benBox.till);
    await atTill(kid.cora, coraBox.till);
    tillAt = Date.now();
    expect(await rowById(benBox.in.checkinId)).toMatchObject({ undoneAt: expect.any(Date) });
    await queue(EVENT_FACTS.checkedOut, { checkinId: coraBox.in.checkinId, eventId: camp, attendeeId: kid.cora, date: T, at: coraOutAt.toISOString() });
  });

  it('Ben leaves after his new check-in: the box’s check-out ends the check-in that stands, not only the set-aside one', async () => {
    await queue(EVENT_FACTS.checkedOut, {
      checkinId: benBox.in!.checkinId,
      eventId: camp,
      attendeeId: kid.ben,
      date: T,
      at: new Date(Math.max(Date.now(), tillAt) + 1000).toISOString(),
    });
    await drain();
    expect(await rowById(benBox.till)).toMatchObject({ checkedOutAt: expect.any(Date) });
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkout'), eq(auditLog.entityId, benBox.till)));
    expect(audit!.after).toMatchObject({ boxCheckinId: benBox.in!.checkinId, endedStanding: true });
    // The roster reads him out.
    const day = await call('GET', `/events?branchId=${central}&date=${T}`);
    const ben = (day.body as EventDayAnswer).events.find((e) => e.id === camp)!.attendees!.find((a) => a.id === kid.ben)!;
    expect(ben.bucket).toBe('out');
  });

  it('Cora’s check-out came before her new check-in: it ends the set-aside visit, and she stays in', async () => {
    expect(await rowById(coraBox.till)).toMatchObject({ checkedOutAt: null, undoneAt: null });
    expect(await rowById(coraBox.in!.checkinId)).toMatchObject({ checkedOutAt: expect.any(Date), undoneAt: expect.any(Date) });
    const day = await call('GET', `/events?branchId=${central}&date=${T}`);
    const cora = (day.body as EventDayAnswer).events.find((e) => e.id === camp)!.attendees!.find((a) => a.id === kid.cora)!;
    expect(cora.bucket).toBe('in');
  });
});

describe('(c) a mirror that meets a row filed in the same instant', () => {
  it('the till checks out a child the OTO App checked in while a box files her: decided again with the box’s row — never a 500', async () => {
    await appChecksIn(kid.dina);
    const elsewhere = await openRowElsewhere(kid.dina, 'box');
    const pressed = call('POST', `/events/${camp}/attendees/${kid.dina}/checkout`, { branchId: central, stationId: tillId });
    await someoneWaitsOnALock();
    await elsewhere.commit();
    const res = await pressed;
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as EventCheckinAnswer).checkin).toMatchObject({ id: elsewhere.id, status: 'checked_out' });
    const rows = await ctx.db
      .select()
      .from(eventCheckin)
      .where(and(eq(eventCheckin.otoappEventId, camp), eq(eventCheckin.attendeeId, kid.dina)));
    expect(rows).toHaveLength(1);
  });

  it('a box’s check-in that meets a till’s row filed in the same instant is that day’s second check-in — filed, not quarantined', async () => {
    const elsewhere = await openRowElsewhere(kid.eli, 'till');
    const fact = handIn(kid.eli, 'Eli', new Date());
    await queue(EVENT_FACTS.checkedIn, fact);
    const pushed = drain();
    await someoneWaitsOnALock();
    await elsewhere.commit();
    await pushed;
    expect(await rowById(fact.checkinId)).toBeNull();
    expect(await ctx.db.select().from(band).where(eq(band.id, fact.kidBand!.id))).toEqual([]);
    const quarantined = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(sql`${syncQuarantine.payload}::text like ${`%${fact.checkinId}%`}`);
    expect(quarantined).toEqual([]);
    const [dup] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin_duplicate'), sql`${auditLog.after}->>'boxCheckinId' = ${fact.checkinId}`));
    expect(dup!.after).toMatchObject({ duplicateOf: { checkinId: elsewhere.id, where: 'pos' }, bandsRecorded: false });
  });
});

describe('(d) a box’s check-in for an event the OTO App archived', () => {
  it('is refused into quarantine with an alert, as the till refuses it — nothing filed, nothing owed to the app', async () => {
    await ctx.db.execute(sql`update otoapp.core_events set is_archived = true where id = ${archived}`);
    const [olly] = (
      await ctx.db.execute<{ id: string }>(sql`select id from otoapp.camp_registrations where event_id = ${archived}`)
    ).rows;
    const fact = handIn(olly!.id, 'Olly', new Date(), archived);
    const before = sentCheckins.length;
    await queue(EVENT_FACTS.checkedIn, fact);
    await drain();
    expect(await rowById(fact.checkinId)).toBeNull();
    expect(sentCheckins.length).toBe(before);
    const quarantined = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.status, 'open'), sql`${syncQuarantine.payload}::text like ${`%${fact.checkinId}%`}`));
    expect(quarantined.map((q) => [q.reason, q.errorCode])).toEqual([['conflict', 'SYNC_EVENT_ARCHIVED']]);
    const [told] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `event.checkin_off_day:${archived}:${olly!.id}:${T}`));
    expect(told).toMatchObject({ category: 'event.checkin_off_day', severity: 'warning' });
    expect(told!.summary).toContain('the event has been archived');
    // The till's own refusal, for the same event.
    const online = await call('POST', `/events/${archived}/attendees/${olly!.id}/checkin`, { branchId: central, checkinId: newId(), stationId: tillId });
    expect(online.statusCode).toBe(409);
    expect(online.body.error.code).toBe('EVENT_ARCHIVED');
  });
});

describe('(f) a stray date drops its event, never the day', () => {
  it('a camp with a mistyped last day and an event with a slashed date: the day, the passes and the box’s copy still answer', async () => {
    const unpadded = `${D(2).slice(0, 8)}${Number(D(2).slice(8))}`;
    const strayEnd = unpadded === D(2) ? `${D(2)}x` : unpadded;
    await ctx.db.execute(sql`
      insert into otoapp.core_events (
        id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
        entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
      values (${stray.camp}, ${appTenant}, ${appCentral}, 'camp', 'Mistyped camp', ${D(-1)}, ${strayEnd}, '09:00', '15:00', 600, 600, 5, 5, 'upcoming'),
             (${stray.event}, ${appTenant}, ${appCentral}, 'workshop', 'Slashed date', ${`${T.slice(8)}/${T.slice(5, 7)}/${T.slice(0, 4)}`}, null, '10:00', '11:00', 300, 300, 5, 5, 'upcoming')`);
    const day = await call('GET', `/events?branchId=${central}&date=${T}`);
    expect(day.statusCode, JSON.stringify(day.body)).toBe(200);
    const ids = (day.body as EventDayAnswer).events.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([camp, workshop]));
    expect(ids).not.toContain(stray.camp);
    expect(ids).not.toContain(stray.event);
    const passes = await call('GET', `/events/passes?branchId=${central}&date=${T}`);
    expect(passes.statusCode, JSON.stringify(passes.body)).toBe(200);
    expect((passes.body.passes as Array<{ id: string }>).map((p) => p.id)).not.toContain(stray.camp);
    const one = await call('GET', `/events/${stray.camp}?branchId=${central}`);
    expect(one.statusCode).toBe(404);
    const roster = await call('GET', `/events/${camp}/roster?branchId=${central}&date=${T}`);
    expect(roster.statusCode).toBe(200);
    // The box's copy of today is built from the same read, and still answers.
    expect(await agent.syncCache()).toBeTruthy();
  });
});

describe('(g) a synced walk-up whose registration the OTO App has removed', () => {
  let linkId: string;

  it('a pass sold today the app merges into Gia’s registration; then the app removes the registration', async () => {
    const res = await call('POST', `/events/${camp}/passes`, {
      branchId: central,
      stationId: tillId,
      attendeeId: newId(),
      saleId: newId(),
      actionId: newId(),
      registerProperly: false,
      attendee: { name: 'Gia', parentName: 'May', parentPhone: PHONE_GIA },
      tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const sold = res.body as EventAttendeeWriteAnswer;
    expect(sold.attendee).toMatchObject({ merged: true, syncState: 'synced', otoappAttendeeId: kid.gia });
    linkId = sold.attendee.id;
    await ctx.db.execute(sql`delete from otoapp.camp_attendance where camp_registration_id = ${kid.gia}`);
    await ctx.db.execute(sql`delete from otoapp.camp_registrations where id = ${kid.gia}`);
  });

  it('by the till’s link id and by the app’s id alike: not on this event — nothing checked in, nothing sent', async () => {
    const before = sentCheckins.length;
    for (const id of [linkId, kid.gia]) {
      const res = await call('POST', `/events/${camp}/attendees/${id}/checkin`, { branchId: central, checkinId: newId(), stationId: tillId });
      expect(res.statusCode, `${id}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error.code).toBe('EVENT_ATTENDEE_NOT_FOUND');
      const out = await call('POST', `/events/${camp}/attendees/${id}/checkout`, { branchId: central, stationId: tillId });
      expect(out.statusCode).toBe(404);
      const reprint = await call('POST', `/events/${camp}/attendees/${id}/reprint`, { branchId: central, stationId: tillId });
      expect(reprint.statusCode).toBe(404);
    }
    expect(sentCheckins.length).toBe(before);
    expect(
      await ctx.db
        .select()
        .from(eventCheckin)
        .where(and(eq(eventCheckin.otoappEventId, camp), eq(eventCheckin.linkId, linkId))),
    ).toEqual([]);
    // As the roster says it: Gia is not listed.
    const day = await call('GET', `/events?branchId=${central}&date=${T}`);
    const names = (day.body as EventDayAnswer).events.find((e) => e.id === camp)!.attendees!.map((a) => a.name);
    expect(names).not.toContain('Gia');
  });
});
