import { generateKeyPairSync } from 'node:crypto';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  auditLog,
  band,
  bandEvent,
  branch,
  eventCheckin,
  station,
  syncEvent,
  syncQuarantine,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { bandCopyFrom, decideGate } from '@oto/box-agent/gate';
import {
  EVENT_FACTS,
  addDaysToIsoDate,
  businessDate,
  mintBandCode,
  newId,
  normalizePhone,
  parseDayStart,
  ulidFromUuid,
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
import {
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-20 E3 — REVIEW, ROUND 3, the box lane (SCRUM-217; R2-1, H4, Q1). The R2-1
 * fix asks WHEN a box checked a child in before it lets that check-in set aside
 * a till's check-in the OTO App undid. Attacked here from every side, live on
 * the box door, with two real counter boxes (`createBoxAgent`) and the OTO
 * App's own write code over its own tables:
 *
 *   - THE OLD FACT AFTER THE UNDO (the pinned case): a box check-in made before
 *     the till's — the till's bands stay, the app stays "waiting", the alert
 *     fires, the box's bands are not recorded;
 *   - A FACT BETWEEN the till's check-in and the undo: the same;
 *   - THE BOUNDARY: a fact one millisecond before the app's undo stamp is the
 *     second check-in; one AT the stamp takes the day;
 *   - A FACT GENUINELY AFTER THE UNDO still takes the day: the till's check-in
 *     set aside, its bands revoked, the app told — and a person told;
 *   - TWO BOXES EITHER SIDE OF ONE UNDO, in both arrival orders;
 *   - A REPLAYED OLD FACT: the push's answer lost and the batch re-sent, then
 *     the same fact under a fresh envelope — never a set-aside, one alert;
 *   - REFUSED PATHS after an undo (a band the park does not sign, a band id
 *     already taken, a child moved off the day): nothing revoked, nothing sent;
 *   - an app edit of the day row after the undo makes a later box fact the
 *     second check-in (the conservative reading, with the alert);
 *   - a box whose clock the envelope itself calls untrusted.
 */

const keys = generateKeyPairSync('ed25519');
const MIN = 60_000;

let ctx: TestContext;
/** Reception at Reception Till 1, on box A (virtual-1). */
let cookieA: string;
/** Reception at Counter 2, on box B (virtual-2): also "the till with the internet" while box B is up. */
let cookieB: string;
let tillA: string;
let counterB: string;
let central: string;
let receptionId: string;
let T: string;
let agentA: BoxAgent;
let agentB: BoxAgent;
let appPool: pg.Pool;
const linkA: CuttableLink = { cut: false };
const linkB: CuttableLink = { cut: false };
/** Lose the answer to box A's next push after the platform applied it. */
const loseNextPushAnswerA = { next: false, lost: 0 };
/** Box B's machine clock, ahead of the real one by this much. */
const skewB = { ms: 0 };

const appTenant = newId();
const appCentral = newId();
const camp = newId();

/** Every child is on every day, parent attending, with an allergy line. */
const KIDS = {
  anya: { id: newId(), name: 'Anya', allergy: 'Sesame' },
  bram: { id: newId(), name: 'Bram', allergy: 'Kiwi' },
  bette: { id: newId(), name: 'Bette', allergy: 'Wheat' },
  boaz: { id: newId(), name: 'Boaz', allergy: 'Mustard' },
  cato: { id: newId(), name: 'Cato', allergy: 'Celery' },
  dara: { id: newId(), name: 'Dara', allergy: 'Lupin' },
  elko: { id: newId(), name: 'Elko', allergy: 'Squid' },
  faye: { id: newId(), name: 'Faye', allergy: 'Pecan' },
  gina: { id: newId(), name: 'Gina', allergy: 'Oats' },
  gilo: { id: newId(), name: 'Gilo', allergy: 'Corn' },
  gusta: { id: newId(), name: 'Gusta', allergy: 'Rice' },
  kipa: { id: newId(), name: 'Kipa', allergy: 'Plum' },
  hale: { id: newId(), name: 'Hale', allergy: 'Pear' },
} as const;
type KidKey = keyof typeof KIDS;

interface AppEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
type AppOutcome<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: string; message: string };
let appWrites: {
  findTenantEvent(db: pg.Pool, tenantId: string, eventId: string): Promise<AppEvent | null>;
  createEventAttendee(
    pool: pg.Pool,
    event: AppEvent,
    input: DirectoryAttendeeBody,
  ): Promise<AppOutcome<DirectoryAttendeeAnswer>>;
  recordAttendeeCheckin(
    pool: pg.Pool,
    event: AppEvent,
    attendeeId: string,
    input: DirectoryCheckinBody,
  ): Promise<AppOutcome<DirectoryCheckinAnswer>>;
};
const sentCheckins: string[] = [];

function asOutcome<T>(o: AppOutcome<T>): DirectoryOutcome<T> {
  if (o.ok) return { ok: true, status: o.status, body: o.body };
  return {
    ok: false,
    status: o.status,
    code: `OTOAPP_${o.error.toUpperCase()}`,
    message: o.message,
    retryable: false,
  };
}

const directory: OtoAppDirectory = {
  configured: true,
  async addAttendee(eventId, body) {
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event)
      return {
        ok: false,
        status: 404,
        code: 'OTOAPP_EVENT_NOT_FOUND',
        message: 'Event not found',
        retryable: false,
      };
    return asOutcome(await appWrites.createEventAttendee(appPool, event, body));
  },
  async checkinAttendee(eventId, attendeeId, body) {
    sentCheckins.push(body.id);
    const event = await appWrites.findTenantEvent(appPool, appTenant, eventId);
    if (!event)
      return {
        ok: false,
        status: 404,
        code: 'OTOAPP_EVENT_NOT_FOUND',
        message: 'Event not found',
        retryable: false,
      };
    return asOutcome(await appWrites.recordAttendeeCheckin(appPool, event, attendeeId, body));
  },
};

function makeAgent(
  boxId: string,
  name: string,
  link: CuttableLink,
  opts: { lose?: { next: boolean; lost: number }; now?: () => number } = {},
): BoxAgent {
  const inner = injectedTransport(ctx, link);
  const fetch: AgentFetch = async (url, init) => {
    const res = await inner(url, init);
    if (opts.lose?.next && url.includes('/box/v1/sync/push')) {
      // The platform applied the batch; the answer dies on the way back.
      opts.lose.next = false;
      opts.lose.lost += 1;
      throw new Error('ECONNRESET: the answer was lost on the way back');
    }
    return res;
  };
  return createBoxAgent({
    apiBaseUrl: `http://${name}.test`,
    credentials: memoryCredentialStore(),
    hostname: name,
    fetch,
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
    bands: { key: currentBandKey },
    ...(opts.now ? { now: opts.now } : {}),
  });
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, as: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: as },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return {
    statusCode: res.statusCode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads the answers loosely, field by field
    body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {},
  };
}

/** Push until the outbox is empty, through a lost answer or two. */
async function drain(agent: BoxAgent): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state === 'empty') return;
    if (outcome.state === 'offline' || outcome.state === 'not_registered')
      throw new Error(`cannot drain: ${outcome.state}`);
  }
  throw new Error('the outbox did not drain');
}

async function register(k: KidKey) {
  const kid = KIDS[k];
  await ctx.db.execute(sql`
    insert into otoapp.camp_registrations (
      id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number,
      allergies, attendance_days, parent_signature, signature_date, parent_attending)
    values (${kid.id}, ${appTenant}, ${camp}, ${kid.name}, '2019-04-01', 'May', '+66812360000',
            ${kid.allergy}, '[]'::jsonb, 'signed', ${T}, true)`);
}

/** The OTO App's own "Undo check-in" (routes.ts, undo-check-in), stamped as the app stamps it: naive UTC. */
async function appUndoes(k: KidKey, at?: Date) {
  const stamp = at
    ? sql`(${at.toISOString()}::timestamptz at time zone 'UTC')`
    : sql`(now() at time zone 'UTC')`;
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set status = 'waiting', checked_in_at = null, checked_in_by = null, checked_out_at = null, checked_out_by = null,
           updated_at = ${stamp}
     where camp_registration_id = ${KIDS[k].id} and attendance_date = ${T}`);
}

/** The OTO App's own "Edit attendance metadata" (routes.ts, PATCH …/attendance): a staff note, nothing else. */
async function appEditsNote(k: KidKey) {
  await ctx.db.execute(sql`
    update otoapp.camp_attendance
       set staff_notes = 'parent rang', updated_at = (now() at time zone 'UTC')
     where camp_registration_id = ${KIDS[k].id} and attendance_date = ${T}`);
}

/** The OTO App's own "attendance days updated": today taken off, its waiting row with it. */
async function appMovesOffToday(k: KidKey) {
  await ctx.db.execute(sql`
    update otoapp.camp_registrations set attendance_days = ${JSON.stringify([addDaysToIsoDate(T, 1)])}::jsonb where id = ${KIDS[k].id}`);
  await ctx.db.execute(sql`
    delete from otoapp.camp_attendance where camp_registration_id = ${KIDS[k].id} and attendance_date = ${T} and status = 'waiting'`);
}

async function appRows(k: KidKey) {
  const res = await ctx.db.execute<{ status: string; checkin_ref: string | null }>(sql`
    select status::text as status, checkin_ref from otoapp.camp_attendance
     where camp_registration_id = ${KIDS[k].id} and attendance_date = ${T}`);
  return res.rows;
}

const rowById = async (id: string) =>
  (await ctx.db.select().from(eventCheckin).where(eq(eventCheckin.id, id)))[0] ?? null;
const bandsOn = (checkinId: string) =>
  ctx.db.select().from(band).where(eq(band.eventCheckinId, checkinId));
const bandsById = (ids: string[]) =>
  ids.length ? ctx.db.select().from(band).where(inArray(band.id, ids)) : Promise.resolve([]);
const revocationsOf = (bandIds: string[]) =>
  bandIds.length
    ? ctx.db
        .select()
        .from(bandEvent)
        .where(and(inArray(bandEvent.bandId, bandIds), eq(bandEvent.kind, 'revoked')))
    : Promise.resolve([]);
const twiceAlertsOf = (k: KidKey) =>
  ctx.db
    .select()
    .from(alert)
    .where(
      and(
        eq(alert.category, 'event.checked_in_twice'),
        sql`${alert.summary} like ${`${KIDS[k].name} was %`}`,
      ),
    );
const undoneAuditsOf = (checkinId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'event.checkin_undone'), eq(auditLog.entityId, checkinId)));
const duplicateAuditsOf = (boxCheckinId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'event.checkin_duplicate'),
        sql`${auditLog.after}->>'boxCheckinId' = ${boxCheckinId}`,
      ),
    );
const openQuarantineOf = (checkinId: string) =>
  ctx.db
    .select()
    .from(syncQuarantine)
    .where(
      and(
        eq(syncQuarantine.status, 'open'),
        sql`${syncQuarantine.payload}::text like ${`%${checkinId}%`}`,
      ),
    );
const ledgerOf = (checkinId: string) =>
  ctx.db
    .select()
    .from(syncEvent)
    .where(
      and(
        eq(syncEvent.type, EVENT_FACTS.checkedIn),
        sql`${syncEvent.payload}->>'checkinId' = ${checkinId}`,
      ),
    );

async function scan(code: string) {
  return call('GET', `/wallets/scan?branchId=${central}&key=${encodeURIComponent(code)}`, cookieA);
}

/** The gate's own copy, as it is shipped: the park's active bands. */
async function gateOpensFor(code: string): Promise<boolean> {
  const shipped = JSON.parse(
    JSON.stringify(
      await ctx.db
        .select()
        .from(band)
        .where(and(eq(band.branchId, central), eq(band.status, 'active'))),
    ),
  ) as unknown[];
  const copy = bandCopyFrom(shipped, []);
  const key = currentBandKey()!;
  const decided = decideGate({
    direction: 'entry',
    key,
    code,
    lookup: (id: string) => copy.lookup(id),
    inside: () => false,
    unknownMeans: 'not_found',
  });
  return decided.open;
}

/** A band as a box mints it with the park's key (or, for a poison case, with another key). */
function mintedBand(prefix: string, key: string = currentBandKey()!): { id: string; code: string } {
  const id = newId();
  return { id, code: mintBandCode(prefix, ulidFromUuid(id), key) };
}

/** A fact as a box's outbox carries it, written by hand, its clock where the case needs it. */
function handFact(
  k: KidKey,
  at: Date,
  bands: { kid: { id: string; code: string }; parent: { id: string; code: string } },
): OfflineEventCheckedIn {
  const kid = KIDS[k];
  return {
    checkinId: newId(),
    eventId: camp,
    attendeeId: kid.id,
    eventType: 'camp',
    date: T,
    at: at.toISOString(),
    childName: kid.name,
    parentName: 'May',
    parentAttending: true,
    allergy: kid.allergy,
    dietary: null,
    eventTitle: 'Reef camp',
    startTime: '09:00',
    endTime: '15:00',
    kidBand: bands.kid,
    parentBand: bands.parent,
  };
}

async function queueOn(agent: BoxAgent, stationId: string, fact: OfflineEventCheckedIn) {
  await agent.outbox()!.queue({
    type: EVENT_FACTS.checkedIn,
    payload: fact as unknown as Record<string, unknown>,
    stationId,
    actorKind: 'account',
    actorAccountId: receptionId,
    actionId: `rv3-${newId().slice(-12)}`,
  });
}

/** A check-in on a box with its link down, through its station bridge, as a till on the box lane drives it. */
async function onBox(
  stationId: string,
  cookie: string,
  k: KidKey,
  checkinId: string,
): Promise<EventCheckinAnswer['checkin']> {
  const res = await call('POST', `/box/v1/station/${stationId}/intents`, cookie, {
    type: 'event.checkin',
    lastSeenSequence: 0,
    payload: { eventId: camp, attendeeId: KIDS[k].id, checkinId, staffName: 'Nok' },
    actionId: `rv3-${newId().slice(-12)}`,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const checkin = (res.body.result as EventCheckinAnswer).checkin;
  expect(checkin.kidBand).not.toBeNull();
  expect(checkin.parentBand).not.toBeNull();
  return checkin;
}

/** A till with the internet checks the child in: synced to the app, both bands printed. */
async function atTill(stationId: string, cookie: string, k: KidKey, checkinId: string) {
  const res = await call('POST', `/events/${camp}/attendees/${KIDS[k].id}/checkin`, cookie, {
    branchId: central,
    checkinId,
    stationId,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect((res.body as EventCheckinAnswer).checkin).toMatchObject({
    id: checkinId,
    syncState: 'synced',
  });
  expect(await appRows(k)).toEqual([{ status: 'checked_in', checkin_ref: checkinId }]);
}

/**
 * THE DAY THE TILL'S CHECK-IN STILL HOLDS after a box fact older than the undo:
 * the till's row and both its bands stand, the app still reads "waiting" on the
 * till's check-in, the box's fact left no row and no band, the app was never
 * sent it, nothing was revoked, and a person was told.
 */
async function expectUndoStoodOverOldFact(
  k: KidKey,
  tillCheckin: string,
  boxCheckin: string,
  boxBandIds: string[],
) {
  expect(await appRows(k)).toEqual([{ status: 'waiting', checkin_ref: tillCheckin }]);
  expect(await rowById(tillCheckin)).toMatchObject({ undoneAt: null });
  const tillBands = await bandsOn(tillCheckin);
  expect(tillBands.map((b) => b.status)).toEqual(['active', 'active']);
  expect(await revocationsOf(tillBands.map((b) => b.id))).toEqual([]);
  expect(await undoneAuditsOf(tillCheckin)).toEqual([]);
  expect(await rowById(boxCheckin)).toBeNull();
  expect(await bandsOn(boxCheckin)).toEqual([]);
  expect(await bandsById(boxBandIds)).toEqual([]);
  expect(sentCheckins).not.toContain(boxCheckin);
  expect(await openQuarantineOf(boxCheckin)).toEqual([]);
  const [dup, ...more] = await duplicateAuditsOf(boxCheckin);
  expect(more).toEqual([]);
  expect(dup!.after).toMatchObject({
    duplicateOf: { checkinId: tillCheckin, where: 'pos', takenBack: true },
    bandsRecorded: false,
  });
  const told = await twiceAlertsOf(k);
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({ severity: 'warning', status: 'open' });
  // The food counter reads the band the till printed, allergy line and all.
  const kidBand = tillBands.find((b) => b.kind === 'kid')!;
  const scanned = await scan(kidBand.code);
  expect(scanned.statusCode, JSON.stringify(scanned.body)).toBe(200);
  expect(scanned.body.stay).toMatchObject({
    childName: KIDS[k].name,
    allergiesMedical: KIDS[k].allergy,
  });
  // The gate still admits the parent band the till printed.
  expect(await gateOpensFor(tillBands.find((b) => b.kind === 'adult')!.code)).toBe(true);
}

/**
 * THE BOX'S CHECK-IN TOOK THE DAY from a till check-in the app undid before it:
 * the till's set aside with both bands revoked (and audited), the box's row and
 * both its bands on the platform, the app checked in under the box's id, and
 * "checked in twice" raised naming the set-aside and the bands revoked.
 */
async function expectBoxTookTheDay(k: KidKey, tillCheckin: string, boxCheckin: string) {
  const till = await rowById(tillCheckin);
  expect(till!.undoneAt).not.toBeNull();
  const tillBands = await bandsOn(tillCheckin);
  expect(tillBands.map((b) => b.status)).toEqual(['revoked', 'revoked']);
  const [undone, ...moreUndone] = await undoneAuditsOf(tillCheckin);
  expect(moreUndone).toEqual([]);
  expect(undone!.after).toMatchObject({ reason: 'undone_in_otoapp', nextCheckinId: boxCheckin });
  expect(await rowById(boxCheckin)).toMatchObject({
    origin: 'box',
    syncState: 'synced',
    undoneAt: null,
    allergy: KIDS[k].allergy,
  });
  const boxBands = await bandsOn(boxCheckin);
  expect(boxBands.map((b) => [b.kind, b.status]).sort()).toEqual([
    ['adult', 'active'],
    ['kid', 'active'],
  ]);
  expect(await appRows(k)).toEqual([{ status: 'checked_in', checkin_ref: boxCheckin }]);
  expect(sentCheckins.filter((id) => id === boxCheckin)).toHaveLength(1);
  const told = await twiceAlertsOf(k);
  expect(told).toHaveLength(1);
  return { told: told[0]!, tillBands, boxBands };
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
  const boxA = await boxBySlot(ctx.db, 'virtual-1');
  const boxB = await boxBySlot(ctx.db, 'virtual-2');
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, boxA.id), eq(station.name, 'Reception Till 1')));
  const [counter] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, boxB.id), eq(station.name, 'Counter 2')));
  tillA = till!.id;
  counterB = counter!.id;
  central = till!.branchId;
  expect(counter!.branchId).toBe(central);
  cookieA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await call('PUT', '/me/session/station', cookieA, { stationId: tillA })).statusCode).toBe(
    200,
  );
  expect(
    (await call('PUT', '/me/session/station', cookieB, { stationId: counterB })).statusCode,
  ).toBe(200);
  const [rec] = await ctx.db
    .select()
    .from(account)
    .where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
  appWrites = (await import(
    /* @vite-ignore */ new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url)
      .href
  )) as typeof appWrites;
  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-e3-review-3-offline')`,
  );
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time, end_time,
      entry_price_weekday_thb, entry_price_weekend_thb, num_children, num_adults, status)
    values (${camp}, ${appTenant}, ${appCentral}, 'camp', 'Reef camp', ${addDaysToIsoDate(T, -1)},
            ${addDaysToIsoDate(T, 2)}, '09:00', '15:00', 600, 700, 30, 30, 'upcoming')`);
  for (const k of Object.keys(KIDS) as KidKey[]) await register(k);

  agentA = makeAgent(boxA.id, 'events-review-3-box-a', linkA, { lose: loseNextPushAnswerA });
  agentB = makeAgent(boxB.id, 'events-review-3-box-b', linkB, { now: () => Date.now() + skewB.ms });
  for (const agent of [agentA, agentB]) {
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    attachInProcessBox(agent);
  }
}, 300_000);

afterAll(async () => {
  for (const agent of [agentA, agentB]) {
    if (!agent) continue;
    agent.stop();
    detachInProcessBox(agent);
  }
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

describe('E3 review round 3 — when the box checked the child in, against the OTO App’s undo', () => {
  const id = {
    anyaBox: newId(),
    anyaTill: newId(),
    bramTill: newId(),
    bramBox: newId(),
    betteTill: newId(),
    boazTill: newId(),
    catoTill: newId(),
    catoBox: newId(),
    daraTill: newId(),
    daraBoxA: newId(),
    daraBoxB: newId(),
    elkoTill: newId(),
    elkoBoxB: newId(),
    elkoBoxA: newId(),
    fayeTill: newId(),
    fayeBox: newId(),
    ginaTill: newId(),
    giloTill: newId(),
    gustaTill: newId(),
    kipaTill: newId(),
    kipaBox: newId(),
    haleTill: newId(),
  };
  /** The bands each box printed, by the box's check-in id. */
  const printed: Record<string, string[]> = {};
  const hand: Partial<Record<'bette' | 'boaz' | 'gina' | 'gilo' | 'gusta', OfflineEventCheckedIn>> =
    {};
  let undoStamp: Date;
  const keep = (c: EventCheckinAnswer['checkin']) => {
    printed[c.id] = [c.kidBand!.id, c.parentBand!.id];
  };

  it('both boxes pull the day while the link is up', async () => {
    for (const agent of [agentA, agentB]) {
      await agent.syncCache();
      await agent.syncEvents();
    }
  });

  it('box A loses its link and checks Anya in from its copy — before any till has her', async () => {
    await agentA.setOffline(true, { reason: 'E3 review round 3' });
    linkA.cut = true;
    keep(await onBox(tillA, cookieA, 'anya', id.anyaBox));
  });

  it('the till with the internet (Counter 2, box B still up) checks every child in; the app has each', async () => {
    const tills: Array<[KidKey, string]> = [
      ['anya', id.anyaTill],
      ['bram', id.bramTill],
      ['bette', id.betteTill],
      ['boaz', id.boazTill],
      ['cato', id.catoTill],
      ['dara', id.daraTill],
      ['elko', id.elkoTill],
      ['faye', id.fayeTill],
      ['gina', id.ginaTill],
      ['gilo', id.giloTill],
      ['gusta', id.gustaTill],
      ['kipa', id.kipaTill],
    ];
    for (const [k, checkinId] of tills) await atTill(counterB, cookieB, k, checkinId);
  });

  it("after the till's check-ins and before any undo: box A checks Bram, Dara and Faye in; box B loses its link and checks Elko in", async () => {
    for (const [k, checkinId] of [
      ['bram', id.bramBox],
      ['dara', id.daraBoxA],
      ['faye', id.fayeBox],
    ] as const) {
      const c = await onBox(tillA, cookieA, k, checkinId);
      keep(c);
      // After the till had her, and after the app had it.
      expect(new Date(c.checkedInAt).getTime()).toBeGreaterThan(
        (await rowById(id.bramTill))!.syncedAt!.getTime(),
      );
    }
    await agentB.setOffline(true, { reason: 'E3 review round 3' });
    linkB.cut = true;
    keep(await onBox(counterB, cookieB, 'elko', id.elkoBoxB));
  });

  it('the OTO App undoes every one of those check-ins; Bette and Boaz at a stamp the case sets', async () => {
    for (const k of [
      'anya',
      'bram',
      'cato',
      'dara',
      'elko',
      'faye',
      'gina',
      'gilo',
      'gusta',
      'kipa',
    ] as const)
      await appUndoes(k);
    const synced = [(await rowById(id.betteTill))!, (await rowById(id.boazTill))!].map((r) =>
      r.syncedAt!.getTime(),
    );
    undoStamp = new Date(Math.max(...synced) + 5_000);
    await appUndoes('bette', undoStamp);
    await appUndoes('boaz', undoStamp);
    for (const k of ['anya', 'bram', 'bette', 'boaz', 'cato', 'dara', 'elko', 'faye'] as const) {
      expect((await appRows(k)).map((r) => r.status)).toEqual(['waiting']);
    }
    // And the app moves Gusta off today, after undoing her check-in.
    await appMovesOffToday('gusta');
  });

  it('after the undo: box A checks Cato, Elko and Kipa in from its copy; box B checks Dara in from its own', async () => {
    keep(await onBox(tillA, cookieA, 'cato', id.catoBox));
    keep(await onBox(tillA, cookieA, 'elko', id.elkoBoxA));
    keep(await onBox(tillA, cookieA, 'kipa', id.kipaBox));
    keep(await onBox(counterB, cookieB, 'dara', id.daraBoxB));
    // Kipa: the app's day row is then edited (a staff note) — after the box's check-in.
    await appEditsNote('kipa');
  });

  it('box A also queues facts by hand: Bette 1 ms before the undo stamp, Boaz at it; Gina, Gilo and Gusta after the undo, each with something the platform refuses', async () => {
    hand.bette = handFact('bette', new Date(undoStamp.getTime() - 1), {
      kid: mintedBand('T1'),
      parent: mintedBand('T1'),
    });
    hand.boaz = handFact('boaz', undoStamp, { kid: mintedBand('T1'), parent: mintedBand('T1') });
    const after = new Date(Date.now() + 1);
    // A band this park did not sign.
    hand.gina = handFact('gina', after, {
      kid: mintedBand('T1', 'not-the-park-key-'.repeat(4)),
      parent: mintedBand('T1'),
    });
    // A band id already naming another band: the one the till printed for Gilo.
    const [giloKid] = (await bandsOn(id.giloTill)).filter((b) => b.kind === 'kid');
    hand.gilo = handFact('gilo', after, {
      kid: { id: giloKid!.id, code: giloKid!.code },
      parent: mintedBand('T1'),
    });
    // A child the app moved off today.
    hand.gusta = handFact('gusta', after, { kid: mintedBand('T1'), parent: mintedBand('T1') });
    for (const f of Object.values(hand)) await queueOn(agentA, tillA, f);
  });

  it('box A comes back first; its first push is applied but the answer is lost, so the box sends the same batch again', async () => {
    linkA.cut = false;
    loseNextPushAnswerA.next = true;
    await agentA.setOffline(false);
    await drain(agentA);
    expect(loseNextPushAnswerA.lost).toBe(1);
  });

  describe('the old fact after the undo (the pinned case): the undo stands', () => {
    it("Anya — on box A before the till had her: the till's check-in and bands stand, the app stays waiting, a person is told", async () => {
      await expectUndoStoodOverOldFact('anya', id.anyaTill, id.anyaBox, printed[id.anyaBox]!);
      const [told] = await twiceAlertsOf('anya');
      expect(told!.detail).toMatchObject({
        bandsRecorded: false,
        first: { checkinId: id.anyaTill, where: 'pos', takenBack: true },
        second: { checkinId: id.anyaBox },
      });
      expect(told!.detail).not.toHaveProperty('setAside');
    });
  });

  describe("a fact between the till's check-in and the undo", () => {
    it("Bram — on box A after the till's check-in and its sync, before the undo: the same", async () => {
      await expectUndoStoodOverOldFact('bram', id.bramTill, id.bramBox, printed[id.bramBox]!);
    });
    it('Bette — one millisecond before the undo stamp: the second check-in too', async () => {
      await expectUndoStoodOverOldFact('bette', id.betteTill, hand.bette!.checkinId, [
        hand.bette!.kidBand!.id,
        hand.bette!.parentBand!.id,
      ]);
    });
  });

  describe('a fact genuinely after the undo still takes the day — and a person is told', () => {
    it('Boaz — at the undo stamp itself: takes the day', async () => {
      const { told, tillBands } = await expectBoxTookTheDay(
        'boaz',
        id.boazTill,
        hand.boaz!.checkinId,
      );
      expect(told.detail).toMatchObject({
        bandsRecorded: true,
        setAside: [
          {
            checkinId: id.boazTill,
            revokedBandIds: expect.arrayContaining(tillBands.map((b) => b.id)),
          },
        ],
      });
    });

    it("Cato — on box A after the undo: the till's set aside, the food counter and the gate follow the box's bands", async () => {
      const { told, tillBands, boxBands } = await expectBoxTookTheDay(
        'cato',
        id.catoTill,
        id.catoBox,
      );
      expect(told.detail).toMatchObject({
        bandsRecorded: true,
        first: { checkinId: id.catoTill, where: 'pos', takenBack: true },
        setAside: [
          {
            checkinId: id.catoTill,
            revokedBandIds: expect.arrayContaining(tillBands.map((b) => b.id)),
          },
        ],
        second: { checkinId: id.catoBox },
      });
      expect(
        (told.detail as { setAside: Array<{ revokedBandIds: string[] }> }).setAside[0]!
          .revokedBandIds,
      ).toHaveLength(2);
      expect(told.occurrences).toBe(1);
      const boxKid = boxBands.find((b) => b.kind === 'kid')!;
      const tillKid = tillBands.find((b) => b.kind === 'kid')!;
      expect((await scan(boxKid.code)).body.stay).toMatchObject({
        childName: 'Cato',
        allergiesMedical: 'Celery',
      });
      const old = await scan(tillKid.code);
      expect(old.statusCode === 404 || old.body.stay === null || old.body.stay === undefined).toBe(
        true,
      );
      expect(await gateOpensFor(boxBands.find((b) => b.kind === 'adult')!.code)).toBe(true);
      expect(await gateOpensFor(tillBands.find((b) => b.kind === 'adult')!.code)).toBe(false);
    });
  });

  describe('two boxes either side of one undo', () => {
    it("Dara, old fact first (box A, before the undo): resolved to the till's, which stands", async () => {
      await expectUndoStoodOverOldFact('dara', id.daraTill, id.daraBoxA, printed[id.daraBoxA]!);
    });

    it("Elko, new fact first (box A, after the undo): takes the day from the till's", async () => {
      const { told } = await expectBoxTookTheDay('elko', id.elkoTill, id.elkoBoxA);
      expect(told.detail).toMatchObject({
        bandsRecorded: true,
        setAside: [{ checkinId: id.elkoTill }],
      });
    });

    it('box B comes back', async () => {
      linkB.cut = false;
      await agentB.setOffline(false);
      await drain(agentB);
    });

    it("Dara, then the new fact (box B, after the undo): takes the day, the till's set aside, one alert raised twice", async () => {
      const { told, tillBands } = await expectBoxTookTheDay('dara', id.daraTill, id.daraBoxB);
      expect(told.occurrences).toBe(2);
      expect(told.detail).toMatchObject({
        bandsRecorded: true,
        setAside: [
          {
            checkinId: id.daraTill,
            revokedBandIds: expect.arrayContaining(tillBands.map((b) => b.id)),
          },
        ],
        second: { checkinId: id.daraBoxB },
      });
      // Box A's older fact never left a band behind.
      expect(await bandsById(printed[id.daraBoxA]!)).toEqual([]);
      expect(sentCheckins).not.toContain(id.daraBoxA);
    });

    it("Elko, then the old fact (box B, before the undo): the second check-in of box A's — which stands, bands and all; nothing sent", async () => {
      expect(await rowById(id.elkoBoxA)).toMatchObject({ undoneAt: null, syncState: 'synced' });
      expect((await bandsOn(id.elkoBoxA)).map((b) => b.status)).toEqual(['active', 'active']);
      expect(await rowById(id.elkoBoxB)).toBeNull();
      expect(await bandsById(printed[id.elkoBoxB]!)).toEqual([]);
      expect(await appRows('elko')).toEqual([{ status: 'checked_in', checkin_ref: id.elkoBoxA }]);
      expect(sentCheckins).not.toContain(id.elkoBoxB);
      expect(await undoneAuditsOf(id.elkoBoxA)).toEqual([]);
      const [dup] = await duplicateAuditsOf(id.elkoBoxB);
      expect(dup!.after).toMatchObject({
        duplicateOf: { checkinId: id.elkoBoxA, where: 'pos' },
        bandsRecorded: false,
      });
      const told = await twiceAlertsOf('elko');
      expect(told).toHaveLength(1);
      expect(told[0]!.occurrences).toBe(2);
      expect(told[0]!.detail).toMatchObject({
        bandsRecorded: false,
        first: { checkinId: id.elkoBoxA },
        second: { checkinId: id.elkoBoxB },
      });
    });
  });

  describe('a replayed old fact', () => {
    it('Faye — the batch re-sent after a lost answer: filed once, resolved once, one alert raised once', async () => {
      await expectUndoStoodOverOldFact('faye', id.fayeTill, id.fayeBox, printed[id.fayeBox]!);
      expect(await ledgerOf(id.fayeBox)).toHaveLength(1);
      const [told] = await twiceAlertsOf('faye');
      expect(told!.occurrences).toBe(1);
    });

    it('…and the same fact under a fresh envelope (a restored store): judged again, never a set-aside, still one alert', async () => {
      const [filed] = await ledgerOf(id.fayeBox);
      await queueOn(agentA, tillA, filed!.payload as unknown as OfflineEventCheckedIn);
      await drain(agentA);
      expect(await ledgerOf(id.fayeBox)).toHaveLength(2);
      expect(await appRows('faye')).toEqual([{ status: 'waiting', checkin_ref: id.fayeTill }]);
      expect(await rowById(id.fayeTill)).toMatchObject({ undoneAt: null });
      expect((await bandsOn(id.fayeTill)).map((b) => b.status)).toEqual(['active', 'active']);
      expect(await undoneAuditsOf(id.fayeTill)).toEqual([]);
      expect(await rowById(id.fayeBox)).toBeNull();
      expect(await bandsById(printed[id.fayeBox]!)).toEqual([]);
      expect(sentCheckins).not.toContain(id.fayeBox);
      expect(await twiceAlertsOf('faye')).toHaveLength(1);
    });
  });

  describe('refused paths after an undo: nothing revoked, nothing sent', () => {
    const untouched = async (
      k: KidKey,
      tillCheckin: string,
      fact: OfflineEventCheckedIn,
      appStatus: Array<{ status: string; checkin_ref: string | null }>,
    ) => {
      expect(await rowById(tillCheckin)).toMatchObject({ undoneAt: null });
      const tillBands = await bandsOn(tillCheckin);
      expect(tillBands.map((b) => b.status)).toEqual(['active', 'active']);
      expect(await revocationsOf(tillBands.map((b) => b.id))).toEqual([]);
      expect(await undoneAuditsOf(tillCheckin)).toEqual([]);
      expect(await rowById(fact.checkinId)).toBeNull();
      expect(await bandsOn(fact.checkinId)).toEqual([]);
      expect(sentCheckins).not.toContain(fact.checkinId);
      expect(await appRows(k)).toEqual(appStatus);
      expect(await twiceAlertsOf(k)).toEqual([]);
    };

    it('Gina — a band the park did not sign: quarantined as poison', async () => {
      expect(
        (await openQuarantineOf(hand.gina!.checkinId)).map((q) => [q.reason, q.errorCode]),
      ).toEqual([['poison', 'SYNC_BAND_CODE_INVALID']]);
      await untouched('gina', id.ginaTill, hand.gina!, [
        { status: 'waiting', checkin_ref: id.ginaTill },
      ]);
    });

    it("Gilo — a band id already naming the till's own kid band: quarantined as a conflict, the revocation rolled back", async () => {
      expect(
        (await openQuarantineOf(hand.gilo!.checkinId)).map((q) => [q.reason, q.errorCode]),
      ).toEqual([['conflict', 'SYNC_BAND_ID_TAKEN']]);
      await untouched('gilo', id.giloTill, hand.gilo!, [
        { status: 'waiting', checkin_ref: id.giloTill },
      ]);
    });

    it('Gusta — moved off today in the app after the undo: quarantined as not registered', async () => {
      expect(
        (await openQuarantineOf(hand.gusta!.checkinId)).map((q) => [q.reason, q.errorCode]),
      ).toEqual([['conflict', 'SYNC_EVENT_NOT_REGISTERED']]);
      await untouched('gusta', id.gustaTill, hand.gusta!, []);
    });
  });

  it("Kipa — after the undo, then the app edits the day row: the box's check-in can no longer be shown to follow the undo, so it is the second check-in, and a person is told", async () => {
    await expectUndoStoodOverOldFact('kipa', id.kipaTill, id.kipaBox, printed[id.kipaBox]!);
  });

  it('every set-aside on the box door raised the alert; no other check-in of the day was set aside', async () => {
    const undone = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'event.checkin_undone'),
          sql`${auditLog.after}->>'boxId' is not null`,
        ),
      );
    const setAsideIds = undone.map((a) => a.entityId).sort();
    expect(setAsideIds).toEqual([id.boazTill, id.catoTill, id.daraTill, id.elkoTill].sort());
    // Each of those children has its "checked in twice" alert open (each was
    // checked, as it was raised, above).
    for (const k of ['boaz', 'cato', 'dara', 'elko'] as const) {
      const told = await twiceAlertsOf(k);
      expect(
        told.map((a) => a.status),
        k,
      ).toEqual(['open']);
    }
    // Every band revoked was revoked by one of those set-asides.
    const revoked = await ctx.db.select().from(bandEvent).where(eq(bandEvent.kind, 'revoked'));
    const revokedOwners = new Set(
      revoked.map((r) => (r.detail as { eventCheckinId?: string }).eventCheckinId),
    );
    expect([...revokedOwners].sort()).toEqual(setAsideIds);
  });

  /**
   * OBSERVATION (LOW) — one alert per child-day (`event.checked_in_twice:<event>:<attendee>:<date>`),
   * and `raiseAlert` overwrites an open alert's summary and detail. Elko's
   * set-aside (box A, after the undo) raised the alert naming the till's
   * check-in it set aside and the two bands it revoked; box B's older fact,
   * arriving next, raised the same alert as a plain duplicate of box A's — and
   * the set-aside, with the revoked band ids, is no longer on the alert a
   * person opens (it is in the audit log). Pinned with `it.fails`.
   */
  it.fails(
    "Elko's alert still names the till's check-in it set aside and the bands it revoked, after box B's older fact",
    async () => {
      const [told] = await twiceAlertsOf('elko');
      const tillBands = await bandsOn(id.elkoTill);
      expect(told!.detail).toMatchObject({
        setAside: [
          {
            checkinId: id.elkoTill,
            revokedBandIds: expect.arrayContaining(tillBands.map((b) => b.id)),
          },
        ],
      });
    },
  );

  /**
   * FINDING R3-1 (pinned with `it.fails`) — A BOX WHOSE CLOCK THE ENVELOPE
   * CALLS UNTRUSTED. Box B has never measured its clock against the platform
   * (a Pi that rebooted with the link down), and its machine clock runs ten
   * minutes fast: what it queues is sealed `clockTrust: 'untrusted'`, and the
   * platform's own ledger records it so. Hale is checked in on that box BEFORE
   * the app's undo in real time, at a box time ten minutes AFTER it.
   * (In-process, the station bridge stamps with the platform's clock —
   * `services/station-bridge.ts`, `now: () => new Date()` — so the fact is
   * queued by hand on box B's outbox, as a Pi's bridge would stamp it with the
   * agent's clock.)
   *
   * The fix's own contract (`stoodWhenBoxCheckedIn`): "a fact that cannot be
   * shown to come after the undo is the second check-in". On a clock the
   * envelope itself calls untrusted, nothing is shown — yet `payload.at` alone
   * decides, and the old fact overturns the undo: the till's bands (the paper
   * the child wears) are revoked and the app is written to over its own undo.
   * The alert fires, which is what holds today.
   */
  describe('a box whose clock the envelope calls untrusted', () => {
    let haleFact: OfflineEventCheckedIn;

    it('Hale: box B loses its link; the till with the internet (Till 1, box A up) checks Hale in; box B, its clock ten minutes fast, checks Hale in; then the app undoes', async () => {
      await agentB.setOffline(true, { reason: 'E3 review round 3, the clock' });
      linkB.cut = true;
      await atTill(tillA, cookieA, 'hale', id.haleTill);
      skewB.ms = 10 * MIN;
      haleFact = handFact('hale', new Date(Date.now() + skewB.ms), {
        kid: mintedBand('T2'),
        parent: mintedBand('T2'),
      });
      await queueOn(agentB, counterB, haleFact);
      skewB.ms = 0;
      await appUndoes('hale');
      linkB.cut = false;
      await agentB.setOffline(false);
      await drain(agentB);
      const [filed] = await ledgerOf(haleFact.checkinId);
      expect(filed!.clockTrust).toBe('untrusted');
      expect(filed!.businessDateSource).toBe('received_at');
    });

    it.fails(
      "the platform knows the box's clock is untrusted, yet the old fact overturns the undo: the till's bands revoked, the app checked back in",
      async () => {
        await expectUndoStoodOverOldFact('hale', id.haleTill, haleFact.checkinId, [
          haleFact.kidBand!.id,
          haleFact.parentBand!.id,
        ]);
      },
    );

    it('what holds today: the set-aside happened on that clock, and a person is told', async () => {
      expect(await rowById(id.haleTill)).toMatchObject({ undoneAt: expect.any(Date) });
      expect((await bandsOn(id.haleTill)).map((b) => b.status)).toEqual(['revoked', 'revoked']);
      expect(await appRows('hale')).toEqual([
        { status: 'checked_in', checkin_ref: haleFact.checkinId },
      ]);
      const told = await twiceAlertsOf('hale');
      expect(told).toHaveLength(1);
      expect(told[0]!.detail).toMatchObject({
        bandsRecorded: true,
        setAside: [{ checkinId: id.haleTill }],
      });
    });
  });
});
