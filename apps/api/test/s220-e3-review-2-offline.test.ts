import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, alert, auditLog, band, branch, eventCheckin, station, syncQuarantine } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent } from '@oto/box-agent';
import { bandCopyFrom, decideGate } from '@oto/box-agent/gate';
import {
  EVENT_FACTS,
  addDaysToIsoDate,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type EventAttendeeWriteAnswer,
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
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-20 E3 — REVIEW, ROUND 2, the box lane (SCRUM-217; PLAN §5 "Offline", §4,
 * Q1, H4, H5, H9). The fix round's box door re-checked from the outside:
 *
 *   - "WHATEVER IDS ARE SENT" ON THE BOX DOOR: a box fact naming the till's own
 *     link id for a walk-up the OTO App merged into its registration is judged
 *     by the app's registration — quarantined when the app moved the child off
 *     the day, and resolved to the first check-in (made online by the app's
 *     id) when the child is already in. Never a second check-in.
 *   - THE APP'S OWN CHECK-IN WEARING THE BOX'S BANDS (F5's fix) works past the
 *     sync: the gate's own copy admits the parent band the box printed and
 *     refuses the kid band, the till checks the child out on that mirror, and
 *     the food counter reads nobody behind the band afterwards. The app is
 *     never written to for it.
 *   - A FACT ALREADY FILED IS NOT JUDGED AGAIN: once a box's check-in is on the
 *     platform, the app moving the child off the day and the same fact arriving
 *     again under a fresh envelope changes nothing — no quarantine, no alert.
 *   - (pinned, finding R2-1) A BOX FACT OLDER THAN THE APP'S UNDO does not
 *     overturn it: the fix round's set-aside takes a day back from a till
 *     check-in the app undid even when the box's check-in came first, revokes
 *     the till's bands without an alert, and writes the child back in.
 *
 * A defect found is pinned with `it.fails` (the E1 review's convention): the
 * suite stays green while it stands and turns red the day it is fixed, so the
 * fix flips it to `it`.
 *
 * A real counter box (`createBoxAgent` over the `edge` schema); the OTO App is
 * its own write code (`server/directory/eventWrites.ts`) over its own tables.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
/** A second reception session, at the other till: online while this box is down. */
let cookieB: string;
let tillId: string;
/** A second till at the same park, on another box: online while this box is down. */
let otherTillId: string;
let central: string;
let receptionId: string;
let T: string;
let agent: BoxAgent;
let appPool: pg.Pool;
const link: CuttableLink = { cut: false };

const appTenant = newId();
const appCentral = newId();
const camp = newId();
const kid = {
  /** Registered for tomorrow; sold today's pass at the till (merged); then moved off today in the app. */
  mona: newId(),
  /** Registered for tomorrow; sold today's pass at the till (merged); checked in online by the app's id. */
  nia: newId(),
  /** Every day, parent attending, an allergy: checked in at the app's own screen while the box is down. */
  fifi: newId(),
  /** Today and tomorrow: a box fact files; then the app moves them off today. */
  remy: newId(),
  /** Every day, parent attending, an allergy: checked in on the box (link down), then at a till, then undone in the app. */
  tia: newId(),
};
const PHONE = { mona: '+66812350001', nia: '+66812350002' };

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

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as: string = cookie) {
  const res = await ctx.app.inject({ method, url, headers: { cookie: as }, ...(payload === undefined ? {} : { payload: payload as never }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads the answers loosely, field by field
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
}

async function register(id: string, name: string, days: string[], o: { phone: string; allergies?: string; parentAttending?: boolean }) {
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${id}, ${appTenant}, ${camp}, ${name}, '2019-04-01', 'May', ${o.phone},
            ${o.allergies ?? null}, ${JSON.stringify(days)}::jsonb, 'signed', ${T}, ${o.parentAttending ?? false})`);
}

/** The OTO App's own "attendance days updated": the day taken off, its waiting row with it. */
async function appMovesOffToday(registrationId: string) {
  await ctx.db.execute(sql`
    update otoapp.camp_registrations set attendance_days = ${JSON.stringify([addDaysToIsoDate(T, 1)])}::jsonb where id = ${registrationId}`);
  await ctx.db.execute(sql`
    delete from otoapp.camp_attendance where camp_registration_id = ${registrationId} and attendance_date = ${T} and status = 'waiting'`);
}

async function appRows(attendeeId: string, date: string) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null }>(sql`
    select status::text as status, checkin_ref from otoapp.camp_attendance
     where camp_registration_id = ${attendeeId} and attendance_date = ${date}`);
  return res.rows;
}

const posRowsOf = (attendeeId: string) =>
  ctx.db
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.attendeeId, attendeeId), eq(eventCheckin.attendanceDate, T)));

const rowById = async (id: string) => (await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id)))[0] ?? null;

const openQuarantineOf = (checkinId: string) =>
  ctx.db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.status, 'open'), sql`${syncQuarantine.payload}::text like ${`%${checkinId}%`}`));

/** A fact as a box's outbox carries it, written by hand: what a box's fact can say, whatever its copy said. */
function handFact(attendeeId: string, name: string) {
  const fact: OfflineEventCheckedIn = {
    checkinId: newId(),
    eventId: camp,
    attendeeId,
    eventType: 'camp',
    date: T,
    at: new Date().toISOString(),
    childName: name,
    parentName: 'May',
    parentAttending: false,
    allergy: null,
    dietary: null,
    eventTitle: 'Coral camp',
    startTime: '09:00',
    endTime: '15:00',
    kidBand: null,
    parentBand: null,
  };
  return fact;
}

async function queueFact(fact: OfflineEventCheckedIn) {
  await agent.outbox()!.queue({
    type: EVENT_FACTS.checkedIn,
    payload: fact as unknown as Record<string, unknown>,
    stationId: tillId,
    actorKind: 'account',
    actorAccountId: receptionId,
    actionId: `rv2-${newId().slice(-12)}`,
  });
}

async function sellMergedPass(name: string, phone: string): Promise<string> {
  const res = await call('POST', `/events/${camp}/passes`, {
    branchId: central,
    stationId: tillId,
    attendeeId: newId(),
    saleId: newId(),
    actionId: newId(),
    registerProperly: false,
    attendee: { name, parentName: 'May', parentPhone: phone },
    tender: { method: 'cash', kind: 'cash', tenderedSatang: 100_000 },
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const sold = res.body as EventAttendeeWriteAnswer;
  expect(sold.attendee).toMatchObject({ merged: true, syncState: 'synced' });
  return sold.attendee.id;
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
  const [t2] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T2')));
  otherTillId = t2!.id;
  expect(t2!.boxId).not.toBe(box.id);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call('PUT', '/me/session/station', { stationId: otherTillId }, cookieB)).statusCode).toBe(200);
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
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3-review-2-offline')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (${camp}, ${appTenant}, ${appCentral}, 'camp', 'Coral camp', ${addDaysToIsoDate(T, -1)},
            ${addDaysToIsoDate(T, 2)}, '09:00', '15:00', 600, 700, 12, 10, 'upcoming')`);
  await register(kid.mona, 'Mona', [addDaysToIsoDate(T, 1)], { phone: PHONE.mona });
  await register(kid.nia, 'Nia', [addDaysToIsoDate(T, 1)], { phone: PHONE.nia, allergies: 'Nuts' });
  await register(kid.fifi, 'Fifi', [], { phone: '+66812350003', allergies: 'Egg', parentAttending: true });
  await register(kid.remy, 'Remy', [T, addDaysToIsoDate(T, 1)], { phone: '+66812350004' });
  await register(kid.tia, 'Tia', [], { phone: '+66812350005', allergies: 'Soy', parentAttending: true });

  agent = createBoxAgent({
    apiBaseUrl: 'http://events-review-2-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'events-review-2-box',
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

describe('E3 review round 2 — the box door, whatever ids it names', () => {
  let monaLink: string;
  let niaLink: string;
  const niaOnline = newId();
  const fifiBox = newId();
  const tiaBox = newId();
  const tiaTill = newId();
  const facts: { mona?: OfflineEventCheckedIn; nia?: OfflineEventCheckedIn; remy?: OfflineEventCheckedIn } = {};

  it('online: two walk-ups the app merges into its registrations; one is moved off today in the app, the other checked in by the app id', async () => {
    monaLink = await sellMergedPass('Mona', PHONE.mona);
    niaLink = await sellMergedPass('Nia', PHONE.nia);
    expect([monaLink, niaLink]).not.toContain(kid.mona);
    await appMovesOffToday(kid.mona);
    const res = await call('POST', `/events/${camp}/attendees/${kid.nia}/checkin`, {
      branchId: central,
      checkinId: niaOnline,
      stationId: tillId,
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as EventCheckinAnswer).checkin).toMatchObject({ id: niaOnline, syncState: 'synced' });
  });

  it('the box pulls the day; the link goes down; the app checks Fifi in at its own screen', async () => {
    await agent.syncCache();
    await agent.syncEvents();
    await agent.setOffline(true, { reason: 'E3 review round 2' });
    link.cut = true;
    await ctx.db.execute(sql`
      insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at, checked_in_by)
      values (${kid.fifi}, ${appTenant}, ${camp}, ${T}, 'checked_in', now() at time zone 'UTC', 'App staff')
      on conflict (camp_registration_id, attendance_date) do update set status = 'checked_in', checked_in_by = 'App staff'`);
  });

  it('with the link down the box checks Fifi in from its copy, both bands printed there', async () => {
    const res = await call('POST', `/box/v1/station/${tillId}/intents`, {
      type: 'event.checkin',
      lastSeenSequence: 0,
      payload: { eventId: camp, attendeeId: kid.fifi, checkinId: fifiBox, staffName: 'Nok' },
      actionId: `rv2-${newId().slice(-12)}`,
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const answer = res.body.result as EventCheckinAnswer;
    expect(answer.checkin).toMatchObject({ id: fifiBox, origin: 'box' });
    expect(answer.checkin.kidBand).not.toBeNull();
    expect(answer.checkin.parentBand).not.toBeNull();
  });

  it('Tia arrives: checked in on the box with its link down, then — nobody at the till can see that — at the till too; then the app undoes the check-in it has', async () => {
    const onBox = await call('POST', `/box/v1/station/${tillId}/intents`, {
      type: 'event.checkin',
      lastSeenSequence: 0,
      payload: { eventId: camp, attendeeId: kid.tia, checkinId: tiaBox, staffName: 'Nok' },
      actionId: `rv2-${newId().slice(-12)}`,
    });
    expect(onBox.statusCode, JSON.stringify(onBox.body)).toBe(200);
    expect((onBox.body.result as EventCheckinAnswer).checkin.kidBand).not.toBeNull();
    // The till has the internet: it does not know the box's check-in yet.
    const atTill = await call(
      'POST',
      `/events/${camp}/attendees/${kid.tia}/checkin`,
      { branchId: central, checkinId: tiaTill, stationId: otherTillId },
      cookieB,
    );
    expect(atTill.statusCode, JSON.stringify(atTill.body)).toBe(200);
    expect((atTill.body as EventCheckinAnswer).checkin).toMatchObject({ id: tiaTill, syncState: 'synced' });
    expect(await appRows(kid.tia, T)).toEqual([{ status: 'checked_in', checkin_ref: tiaTill }]);
    // Later, the OTO App's own "Undo check-in": the child's day is "waiting" again.
    await ctx.db.execute(sql`
      update otoapp.camp_attendance
         set status = 'waiting', checked_in_at = null, checked_in_by = null, updated_at = now()
       where camp_registration_id = ${kid.tia} and attendance_date = ${T}`);
  });

  it("three facts by hand: Mona and Nia by the till's own link ids, Remy by the app's", async () => {
    facts.mona = handFact(monaLink, 'Mona');
    facts.nia = handFact(niaLink, 'Nia');
    facts.remy = handFact(kid.remy, 'Remy');
    for (const f of [facts.mona, facts.nia, facts.remy]) await queueFact(f);
  });

  it('the link comes back and everything is pushed', async () => {
    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
  });

  it("Mona by the till's link id is judged by the app's registration: quarantined as not registered, nothing filed, the app untouched", async () => {
    expect(await rowById(facts.mona!.checkinId)).toBeNull();
    expect(await posRowsOf(kid.mona)).toEqual([]);
    expect(await posRowsOf(monaLink)).toEqual([]);
    const q = await openQuarantineOf(facts.mona!.checkinId);
    expect(q.map((r) => [r.reason, r.errorCode])).toEqual([['conflict', 'SYNC_EVENT_NOT_REGISTERED']]);
    expect(await appRows(kid.mona, T)).toEqual([]);
    expect(sentCheckins).not.toContain(facts.mona!.checkinId);
  });

  it("Nia by the till's link id, already in by the app's id: resolved to that first check-in — no second row, nothing sent", async () => {
    expect(await rowById(facts.nia!.checkinId)).toBeNull();
    expect((await posRowsOf(kid.nia)).map((r) => [r.id, r.linkId])).toEqual([[niaOnline, niaLink]]);
    const [dup] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin_duplicate'), sql`${auditLog.after}->>'boxCheckinId' = ${facts.nia!.checkinId}`));
    expect(dup!.after).toMatchObject({ duplicateOf: { checkinId: niaOnline, where: 'pos' }, bandsRecorded: false });
    expect(await appRows(kid.nia, T)).toEqual([{ status: 'checked_in', checkin_ref: niaOnline }]);
    expect(sentCheckins).not.toContain(facts.nia!.checkinId);
    expect(await openQuarantineOf(facts.nia!.checkinId)).toEqual([]);
  });

  it('Remy files once and reaches the app under the box fact’s id', async () => {
    expect(await rowById(facts.remy!.checkinId)).toMatchObject({ attendeeId: kid.remy, origin: 'box', syncState: 'synced', undoneAt: null });
    expect(await appRows(kid.remy, T)).toEqual([{ status: 'checked_in', checkin_ref: facts.remy!.checkinId }]);
  });

  it("Fifi's box check-in sits on the app's own, wearing the box's two bands; the app was never written to for it", async () => {
    const rows = await posRowsOf(kid.fifi);
    expect(rows.map((r) => [r.id, r.origin, r.syncState])).toEqual([[fifiBox, 'otoapp', 'synced']]);
    expect(rows[0]!.kidBandId).not.toBeNull();
    expect(rows[0]!.parentBandId).not.toBeNull();
    expect(sentCheckins).not.toContain(fifiBox);
    expect(await appRows(kid.fifi, T)).toEqual([{ status: 'checked_in', checkin_ref: null }]);
  });

  it("the gate's own copy admits the parent band the box printed and refuses the kid band", async () => {
    const bands = await ctx.db.select().from(band).where(eq(band.eventCheckinId, fifiBox));
    const shipped = JSON.parse(
      JSON.stringify(await ctx.db.select().from(band).where(and(eq(band.branchId, central), eq(band.status, 'active')))),
    ) as unknown[];
    const copy = bandCopyFrom(shipped, []);
    const key = currentBandKey()!;
    const gate = (code: string) =>
      decideGate({ direction: 'entry', key, code, lookup: (id: string) => copy.lookup(id), inside: () => false, unknownMeans: 'not_found' });
    expect(gate(bands.find((b) => b.kind === 'adult')!.code)).toMatchObject({ open: true });
    expect(gate(bands.find((b) => b.kind === 'kid')!.code)).toMatchObject({ open: false, reason: 'KID_BAND' });
  });

  it("the till checks Fifi out by the app's id on that mirror; the food counter then reads nobody behind the box's kid band", async () => {
    const [kb] = await ctx.db.select().from(band).where(and(eq(band.eventCheckinId, fifiBox), eq(band.kind, 'kid')));
    const before = await call('GET', `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kb!.code)}`);
    expect(before.body.stay).toMatchObject({ childName: 'Fifi', allergiesMedical: 'Egg' });
    const out = await call('POST', `/events/${camp}/attendees/${kid.fifi}/checkout`, { branchId: central, stationId: tillId });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect((out.body as EventCheckinAnswer).checkin).toMatchObject({ id: fifiBox, status: 'checked_out' });
    expect(await posRowsOf(kid.fifi)).toHaveLength(1);
    const after = await call('GET', `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kb!.code)}`);
    expect(after.statusCode === 404 || after.body.stay === null).toBe(true);
  });

  /**
   * FINDING R2-1 (MEDIUM; Q1, H4, H9) — the box door's set-aside
   * (`applyEventCheckedIn`: `takenBackBy` → `undoTakenBack`, sync-events.ts)
   * never asks WHEN the box checked the child in. Tia was checked in on the
   * box (link down) BEFORE the till checked her in online; the app had the
   * till's check-in, and its own "Undo check-in" then took the day back. When
   * the box's fact arrives — older than the till's check-in and older than the
   * undo — it is treated as a new check-in after the undo:
   *   - the till's check-in is set aside and its two bands revoked, with no
   *     alert (only an `event.checkin_undone` audit row). The till's bands are
   *     the later paper, likely the ones the child wears: the food counter
   *     now reads NOTHING behind her kid band — no "Soy" line — and the gate
   *     refuses her parent's band;
   *   - the box's check-in is filed and written back, so the OTO App shows her
   *     checked in again after its own undo — the master's undo overturned by
   *     a fact that predates it.
   * Before the fix round this exact case took H4's duplicate path: the first
   * check-in stood, the box's bands were not recorded, the app was not told,
   * and "checked in twice" asked a person to check the band.
   *
   * Expected: a box fact whose check-in is older than the check-in the app
   * took back (it predates `checkedInAt`/`syncedAt` of the row set aside, so
   * the app's undo came after it) is that same arrival, not a new one —
   * resolved as H4's duplicate of the taken-back row: no set-aside, no
   * write-back, the alert raised. (A box fact made AFTER the undo — the
   * builder's own case in events-e3-offline — keeps taking the day.)
   *
   * Observed (this file, before pinning): the till's row `undone_at` set at
   * the box fact's time; its kid and adult bands `revoked`; the box's row
   * filed `synced`; the app's day `checked_in` with the box's id as its ref;
   * `GET /wallets/scan` on the till's kid band 404; no alert of any category
   * naming Tia.
   */
  describe('R2-1: a box fact older than a till check-in the OTO App then undid', () => {
    it.fails("the app's undo stands: the box's older fact neither checks Tia back in at the app nor sets the till's check-in aside", async () => {
      expect(await appRows(kid.tia, T)).toEqual([{ status: 'waiting', checkin_ref: tiaTill }]);
      expect(await rowById(tiaTill)).toMatchObject({ undoneAt: null });
      expect(sentCheckins).not.toContain(tiaBox);
    });

    it.fails('the band the till printed for Tia still names her allergy at the food counter', async () => {
      const [kb] = await ctx.db.select().from(band).where(and(eq(band.eventCheckinId, tiaTill), eq(band.kind, 'kid')));
      expect(kb!.status).toBe('active');
      const scanned = await call('GET', `/wallets/scan?branchId=${central}&key=${encodeURIComponent(kb!.code)}`);
      expect(scanned.statusCode, JSON.stringify(scanned.body)).toBe(200);
      expect(scanned.body.stay).toMatchObject({ childName: 'Tia', allergiesMedical: 'Soy' });
    });

    it.fails('a person is told Tia was checked in twice, as H4 tells one of any second check-in from a box', async () => {
      const told = await ctx.db
        .select()
        .from(alert)
        .where(and(eq(alert.category, 'event.checked_in_twice'), sql`${alert.summary} like '%Tia%'`));
      expect(told).toHaveLength(1);
    });

    it('what holds today regardless: one check-in stands for her day, and the box fact did not wait in quarantine', async () => {
      const standing = (await posRowsOf(kid.tia)).filter((r) => r.undoneAt === null);
      expect(standing).toHaveLength(1);
      expect(await openQuarantineOf(tiaBox)).toEqual([]);
    });
  });

  it('a fact already filed is not judged again: the app moves Remy off today, the same fact arrives again, nothing changes', async () => {
    await appMovesOffToday(kid.remy);
    await queueFact(facts.remy!);
    await flushAll();
    const rows = await posRowsOf(kid.remy);
    expect(rows.map((r) => [r.id, r.undoneAt, r.syncState])).toEqual([[facts.remy!.checkinId, null, 'synced']]);
    expect(await openQuarantineOf(facts.remy!.checkinId)).toEqual([]);
    const alerts = await ctx.db
      .select()
      .from(alert)
      .where(and(eq(alert.category, 'event.checkin_off_day'), sql`${alert.summary} like '%Remy%'`));
    expect(alerts).toEqual([]);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'event.checkin'), eq(auditLog.entityId, facts.remy!.checkinId)));
    expect(audits).toHaveLength(1);
    expect(sentCheckins.filter((id) => id === facts.remy!.checkinId)).toHaveLength(1);
  });
});
