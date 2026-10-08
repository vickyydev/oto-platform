import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '@oto/db';
import { createTestDatabase } from '@oto/db/testing';
import { newId } from '@oto/shared';
import {
  OtoAppSeamNotGrantedError,
  getBranchEvent,
  listBranchEvents,
  listEventAttendance,
  listEventAttendees,
  listSeamChildren,
  otoAppEventsInstalled,
} from '../src/services/otoapp-events';
import type { Tx } from '../src/services/tx';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * The POS seam onto the OTO App's events (events-kiosk PLAN s8, round 0;
 * SCRUM-217).
 *
 * The app keeps its events, camps, parties, registrations and check-ins; the
 * POS reads them through the views `otoapp_v.events`, `event_attendees`,
 * `event_attendance` and `children` (the app's migration 0004) and nothing
 * else. Two things are proved here:
 *
 *  1. THE READ. A seeded camp, one-off event and party come back through the
 *     views with the POS's types (Q10), platform branch ids, satang and real
 *     instants — and the fences hold: an unmapped app branch, another branch,
 *     another operator and an archived event are not seen.
 *  2. THE GREP (hazard H1). No file in `src` names an OTO App event table, and
 *     the only file that names `otoapp_v` is the read-only repository, which
 *     reads those four views and writes nothing.
 *  3. THE GRANTS. A role the post-import grants have not reached is told so,
 *     never answered "no events".
 *  4. THE WRITE-BACK's ids. A replay sent with the ids in capitals is the same
 *     replay (the app's directory writes, loaded from its source).
 *
 * The app's rows are written with SQL, as the app's own screens would leave
 * them: the platform has no declaration of these tables, by design.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let secondOperatorBranch: string;

const appTenant = newId();
const otherAppTenant = newId();
const appCentral = newId();
const appChalong = newId();
const appHeadOffice = newId();
const appSecond = newId();
/** Another tenant's app branch carrying OTO Central's id in capitals. */
const appShadow = newId();

const D1 = '2026-11-02';
const D2 = '2026-11-03';
const D3 = '2026-11-04';
const D4 = '2026-11-05';
const D5 = '2026-11-06';

const ids = {
  camp: newId(),
  workshop: newId(),
  party: newId(),
  privateEvent: newId(),
  schoolGroup: newId(),
  other: newId(),
  studio: newId(),
  archived: newId(),
  headOffice: newId(),
  chalongEvent: newId(),
  secondOperatorEvent: newId(),
  shadowEvent: newId(),
  ploy: newId(),
  win: newId(),
  oneTime: newId(),
  tee: newId(),
  guest: newId(),
  teeCheckin: newId(),
};

async function appBranch(id: string, tenant: string, name: string, coreBranchId: string | null) {
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${id}, ${tenant}, ${name}, 'Phuket', ${coreBranchId})`);
}

async function appEvent(e: {
  id: string;
  tenant?: string;
  branch?: string;
  type: string;
  title: string;
  date?: string;
  campEnd?: string | null;
  cancelled?: string[];
  weekday?: number | null;
  weekend?: number | null;
  total?: number | null;
  deposit?: number | null;
  archived?: boolean;
}) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, camp_cancelled_days,
      start_time, end_time, entry_price_weekday_thb, entry_price_weekend_thb, total_value,
      prepayment_amount, prepayment_date, child_name, parent_name, whatsapp_phone_e164,
      num_children, num_adults, location_text, is_archived)
    values (
      ${e.id}, ${e.tenant ?? appTenant}, ${e.branch ?? appCentral}, ${e.type}, ${e.title},
      ${e.date ?? D1}, ${e.campEnd ?? null}, ${e.cancelled ? JSON.stringify(e.cancelled) : null}::jsonb,
      '09:00', '15:00', ${e.weekday ?? null}, ${e.weekend ?? null}, ${e.total ?? null},
      ${e.deposit ?? null}, ${e.deposit ? '2026-10-20' : null},
      ${e.type === 'birthday' ? 'Mali' : null}, ${e.type === 'birthday' ? 'Nok' : null},
      ${e.type === 'birthday' ? '+66812345678' : null}, 12, 10, 'Party room', ${e.archived ?? false})`);
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  secondOperatorBranch = await branchIdByCode(
    ctx.db,
    SECOND_OPERATOR_BRANCH_CODE,
    SECOND_OPERATOR_NAME,
  );

  await ctx.db.execute(sql`
    insert into otoapp.tenants (id, name, slug)
    values (${appTenant}, 'OTO', 'oto'), (${otherAppTenant}, 'Second', 'second')`);
  await appBranch(appCentral, appTenant, 'Central Floresta', central);
  await appBranch(appChalong, appTenant, 'Robinson Chalong', chalong);
  await appBranch(appHeadOffice, appTenant, 'Head Office', null);
  await appBranch(appSecond, otherAppTenant, 'Second park', secondOperatorBranch);
  // The column's unique index is over the raw text, so this row is allowed
  // beside appCentral; the views must not map it onto Central too.
  expect(central.toUpperCase()).not.toBe(central);
  await appBranch(appShadow, otherAppTenant, 'Shadow park', central.toUpperCase());

  await appEvent({
    id: ids.camp,
    type: 'camp',
    title: 'Ocean camp',
    campEnd: D5,
    cancelled: [D3],
    weekday: 600,
    weekend: 700,
  });
  await appEvent({
    id: ids.workshop,
    type: 'workshop',
    title: 'Slime workshop',
    weekday: 350,
    weekend: 400,
  });
  await appEvent({
    id: ids.party,
    type: 'birthday',
    title: "Mali's 6th",
    total: 12000,
    deposit: 3000,
  });
  await appEvent({ id: ids.privateEvent, type: 'private_event', title: 'Company day' });
  await appEvent({ id: ids.schoolGroup, type: 'school_group', title: 'School trip' });
  await appEvent({ id: ids.other, type: 'other', title: 'Halloween' });
  await appEvent({ id: ids.studio, type: 'studio_event', title: 'Studio night' });
  await appEvent({
    id: ids.archived,
    type: 'workshop',
    title: 'Cancelled workshop',
    archived: true,
  });
  await appEvent({
    id: ids.headOffice,
    branch: appHeadOffice,
    type: 'other',
    title: 'Staff training',
  });
  await appEvent({
    id: ids.chalongEvent,
    branch: appChalong,
    type: 'workshop',
    title: 'Chalong workshop',
  });
  await appEvent({
    id: ids.secondOperatorEvent,
    tenant: otherAppTenant,
    branch: appSecond,
    type: 'camp',
    title: 'Another park camp',
    campEnd: D5,
  });
  await appEvent({
    id: ids.shadowEvent,
    tenant: otherAppTenant,
    branch: appShadow,
    type: 'workshop',
    title: 'Shadow workshop',
  });

  // A camp's children, as the app's registration form and its one-time add
  // leave them.
  const register = (
    id: string,
    name: string,
    days: string[],
    o: {
      parent?: string;
      phone?: string;
      dob?: string;
      parentAttending?: boolean;
      allergies?: string | null;
      oneTime?: boolean;
    },
  ) =>
    ctx.db.execute(sql`
      insert into otoapp.camp_registrations (
        id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name,
        emergency_contact_number, allergies, food_restrictions, attendance_days, parent_signature,
        signature_date, parent_attending, is_one_time)
      values (${id}, ${appTenant}, ${ids.camp}, ${name}, ${o.dob ?? '2019-04-01'},
              ${o.parent ?? 'Nok'}, ${o.phone ?? '+66812345001'}, ${o.allergies ?? null}, 'No pork',
              ${JSON.stringify(days)}::jsonb, 'signed', ${D1}, ${o.parentAttending ?? false},
              ${o.oneTime ?? false})`);
  await register(ids.ploy, 'Ploy', [D1, D2], { parentAttending: true, allergies: 'Peanuts' });
  await register(ids.win, 'Win', [], { phone: '+66812345002' });
  await register(ids.oneTime, 'Walk-up', [D2], {
    parent: 'Manager Added',
    phone: 'MANAGER_ADDED',
    dob: '1900-01-01',
    oneTime: true,
  });

  // The app's check-in screen wrote Ploy's first day; her second is seeded waiting.
  await ctx.db.execute(sql`
    insert into otoapp.camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at, checked_in_by)
    values (${ids.ploy}, ${appTenant}, ${ids.camp}, ${D1}, 'checked_in', '2026-11-02 02:30:00', 'som'),
           (${ids.ploy}, ${appTenant}, ${ids.camp}, ${D2}, 'waiting', null, null)`);

  // A one-off event's and a party's children: the per-child rows of 0003.
  await ctx.db.execute(sql`
    insert into otoapp.event_attendees (id, tenant_id, event_id, child_full_name, allergies, parent_name, parent_phone, parent_attending, source)
    values (${ids.tee}, ${appTenant}, ${ids.workshop}, 'Tee', 'Shellfish', 'Pim', '+66812345003', true, 'pos'),
           (${ids.guest}, ${appTenant}, ${ids.party}, 'Guest one', null, null, null, false, 'otoapp')`);
  await ctx.db.execute(sql`
    insert into otoapp.event_attendee_checkins (id, tenant_id, event_id, attendee_id, attendance_date, status, checked_in_at, checked_in_by, checkin_ref)
    values (${ids.teeCheckin}, ${appTenant}, ${ids.workshop}, ${ids.tee}, ${D1}, 'checked_in', '2026-11-02T03:00:00Z', 'Som (till 1)', ${ids.teeCheckin})`);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the read: a seeded camp, event and party through otoapp_v', () => {
  it('the seam is installed when the OTO App is', async () => {
    expect(await otoAppEventsInstalled(ctx.db)).toBe(true);
  });

  it("returns the branch's events on a day, with the POS's three types (Q10)", async () => {
    const events = await listBranchEvents(ctx.db, { branchId: central, from: D1, to: D1 });
    const byId = new Map(events.map((e) => [e.id, e]));

    expect(byId.get(ids.camp)?.type).toBe('camp');
    expect(byId.get(ids.party)?.type).toBe('party');
    expect(byId.get(ids.privateEvent)?.type).toBe('party');
    expect(byId.get(ids.schoolGroup)?.type).toBe('party');
    expect(byId.get(ids.workshop)?.type).toBe('event');
    expect(byId.get(ids.other)?.type).toBe('event');
    expect(byId.get(ids.studio)?.type).toBe('event');
    expect(byId.get(ids.party)?.appEventType).toBe('birthday');

    // The fences: archived, an unmapped app branch (Head Office), another
    // branch of the same park, and another operator's park.
    expect(byId.has(ids.archived)).toBe(false);
    expect(byId.has(ids.headOffice)).toBe(false);
    expect(byId.has(ids.chalongEvent)).toBe(false);
    expect(byId.has(ids.secondOperatorEvent)).toBe(false);
    // Another tenant's app branch holding Central's id in capitals maps onto
    // nothing: only the lowercase form the platform writes is a mapping.
    expect(byId.has(ids.shadowEvent)).toBe(false);
    expect(events).toHaveLength(7);
    expect(events.every((e) => e.branchId === central)).toBe(true);
  });

  it('carries a camp as a range, with its prices in satang and its cancelled day', async () => {
    const camp = await getBranchEvent(ctx.db, { branchId: central, eventId: ids.camp });
    expect(camp).toMatchObject({
      startDate: D1,
      endDate: D5,
      cancelledDays: [D3],
      entryPriceWeekdaySatang: 60_000,
      entryPriceWeekendSatang: 70_000,
    });
    // On a later day of its range the camp is still there; a one-day event is not.
    const later = await listBranchEvents(ctx.db, { branchId: central, from: D4, to: D4 });
    expect(later.map((e) => e.id)).toEqual([ids.camp]);
  });

  it("carries a one-off event's flat price and a party's bill in satang", async () => {
    const workshop = await getBranchEvent(ctx.db, { branchId: central, eventId: ids.workshop });
    expect(workshop).toMatchObject({
      endDate: D1,
      entryPriceWeekdaySatang: 35_000,
      entryPriceWeekendSatang: 40_000,
    });
    const party = await getBranchEvent(ctx.db, { branchId: central, eventId: ids.party });
    expect(party).toMatchObject({
      totalValueSatang: 1_200_000,
      depositSatang: 300_000,
      depositDate: '2026-10-20',
      childName: 'Mali',
      parentName: 'Nok',
      parentPhone: '+66812345678',
      entryPriceWeekdaySatang: null,
    });
  });

  it("reads a camp's children with the app's day rule and without its placeholders", async () => {
    const attendees = await listEventAttendees(ctx.db, { branchId: central, eventId: ids.camp });
    const byId = new Map(attendees.map((a) => [a.id, a]));
    expect(attendees).toHaveLength(3);
    expect(byId.get(ids.ploy)).toMatchObject({
      recordKind: 'camp_registration',
      childId: ids.ploy,
      parentAttending: true,
      attendanceDays: [D1, D2],
      attendsAllDays: false,
    });
    // An empty day list is every day, to the app.
    expect(byId.get(ids.win)).toMatchObject({ attendanceDays: [], attendsAllDays: true });
    expect(byId.get(ids.oneTime)).toMatchObject({
      parentName: null,
      parentPhone: null,
      isOneTime: true,
    });
  });

  it("reads a camp's per-day state, the app's naive UTC given its zone", async () => {
    const day1 = await listEventAttendance(ctx.db, {
      branchId: central,
      eventId: ids.camp,
      date: D1,
    });
    expect(day1).toHaveLength(1);
    expect(day1[0]).toMatchObject({
      attendeeId: ids.ploy,
      status: 'checked_in',
      checkedInBy: 'som',
      checkinRef: null,
    });
    expect(day1[0]!.checkedInAt?.toISOString()).toBe('2026-11-02T02:30:00.000Z');
    const all = await listEventAttendance(ctx.db, { branchId: central, eventId: ids.camp });
    expect(all.map((a) => [a.attendanceDate, a.status])).toEqual([
      [D1, 'checked_in'],
      [D2, 'waiting'],
    ]);
  });

  it("reads a one-off event's and a party's per-child rows and check-ins", async () => {
    const tee = await listEventAttendees(ctx.db, { branchId: central, eventId: ids.workshop });
    expect(tee).toEqual([
      expect.objectContaining({
        id: ids.tee,
        recordKind: 'event_attendee',
        parentAttending: true,
        attendsAllDays: true,
        source: 'pos',
      }),
    ]);
    const guests = await listEventAttendees(ctx.db, { branchId: central, eventId: ids.party });
    expect(guests.map((g) => [g.childName, g.eventType])).toEqual([['Guest one', 'party']]);
    const checkins = await listEventAttendance(ctx.db, {
      branchId: central,
      eventId: ids.workshop,
      date: D1,
    });
    expect(checkins).toEqual([
      expect.objectContaining({
        attendeeId: ids.tee,
        checkinRef: ids.teeCheckin,
        status: 'checked_in',
      }),
    ]);
    expect(checkins[0]!.checkedInAt?.toISOString()).toBe('2026-11-02T03:00:00.000Z');
  });

  it('reads the children behind the registrations, for the band and the platform child match', async () => {
    const children = await listSeamChildren(ctx.db, {
      branchId: central,
      ids: [ids.ploy, ids.oneTime, ids.tee],
    });
    const byId = new Map(children.map((c) => [c.id, c]));
    expect(byId.get(ids.ploy)).toMatchObject({
      allergies: 'Peanuts',
      foodRestrictions: 'No pork',
      guardianPhone: '+66812345001',
    });
    expect(byId.get(ids.oneTime)).toMatchObject({
      dateOfBirth: null,
      guardianName: null,
      guardianPhone: null,
    });
    expect(byId.get(ids.tee)).toMatchObject({ allergies: 'Shellfish', guardianName: 'Pim' });
  });

  it("does not read across the fence: another branch's or operator's ids answer nothing", async () => {
    // The second operator's camp, asked for under OTO's branch, is not there;
    // under its own branch it is.
    expect(
      await getBranchEvent(ctx.db, { branchId: central, eventId: ids.secondOperatorEvent }),
    ).toBeNull();
    expect(
      await getBranchEvent(ctx.db, {
        branchId: secondOperatorBranch,
        eventId: ids.secondOperatorEvent,
      }),
    ).not.toBeNull();
    expect(
      await listEventAttendees(ctx.db, { branchId: secondOperatorBranch, eventId: ids.camp }),
    ).toEqual([]);
    expect(await listEventAttendance(ctx.db, { branchId: chalong, eventId: ids.camp })).toEqual([]);
    expect(
      await listSeamChildren(ctx.db, { branchId: secondOperatorBranch, ids: [ids.ploy, ids.tee] }),
    ).toEqual([]);
    expect(
      await getBranchEvent(ctx.db, { branchId: central, eventId: ids.shadowEvent }),
    ).toBeNull();
    // Archived is still this branch's to look up by id; it is only kept off the day list.
    expect(
      (await getBranchEvent(ctx.db, { branchId: central, eventId: ids.archived }))?.archived,
    ).toBe(true);
  });

  it('answers nothing, rather than failing, for ids and dates that are not ids and dates', async () => {
    expect(await listBranchEvents(ctx.db, { branchId: 'central', from: D1, to: D1 })).toEqual([]);
    expect(await listBranchEvents(ctx.db, { branchId: central, from: '2 Nov', to: D1 })).toEqual(
      [],
    );
    expect(await getBranchEvent(ctx.db, { branchId: central, eventId: 'not-an-id' })).toBeNull();
    expect(await listSeamChildren(ctx.db, { branchId: central, ids: ['nope'] })).toEqual([]);
  });
});

describe('a deployment without the OTO App', () => {
  it('answers empty instead of failing', async () => {
    const { url, drop } = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: url });
    try {
      const db = drizzle(pool) as unknown as Db;
      expect(await otoAppEventsInstalled(db)).toBe(false);
      expect(await listBranchEvents(db, { branchId: central, from: D1, to: D1 })).toEqual([]);
      expect(await getBranchEvent(db, { branchId: central, eventId: ids.camp })).toBeNull();
      expect(await listEventAttendees(db, { branchId: central, eventId: ids.camp })).toEqual([]);
      expect(await listEventAttendance(db, { branchId: central, eventId: ids.camp })).toEqual([]);
      expect(await listSeamChildren(db, { branchId: central, ids: [ids.ploy] })).toEqual([]);

      // An administrator made the schema ahead of the app's migrator (0004
      // allows it): still no seam, still empty.
      await pool.query('create schema otoapp_v');
      expect(await otoAppEventsInstalled(db)).toBe(false);
      expect(await listBranchEvents(db, { branchId: central, from: D1, to: D1 })).toEqual([]);
    } finally {
      await pool.end();
      await drop();
    }
  });
});

describe('a role the post-import grants have not reached', () => {
  it('is told which grant is missing, never answered empty, and reads once granted', async () => {
    // A role of its own, named per run: roles are server-wide, test databases are not.
    const role = `seam_reader_${newId().replace(/-/g, '').slice(-12)}`;
    await ctx.db.execute(sql.raw(`create role ${role} nologin`));
    const asRole = <T>(work: (tx: Tx) => Promise<T>) =>
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role ${role}`));
        return work(tx);
      });
    try {
      // No USAGE on the schema: the check answers, it does not raise 42501.
      const noUsage = await asRole((tx) => otoAppEventsInstalled(tx)).catch((e: unknown) => e);
      expect(noUsage).toBeInstanceOf(OtoAppSeamNotGrantedError);
      expect((noUsage as OtoAppSeamNotGrantedError).missing).toEqual(['USAGE on schema otoapp_v']);
      await expect(
        asRole((tx) => listBranchEvents(tx, { branchId: central, from: D1, to: D1 })),
      ).rejects.toThrow(/USAGE on schema otoapp_v/);

      // USAGE but SELECT on one view only: the other three are named.
      await ctx.db.execute(sql.raw(`grant usage on schema otoapp_v to ${role}`));
      await ctx.db.execute(sql.raw(`grant select on otoapp_v.events to ${role}`));
      const partial = await asRole((tx) => otoAppEventsInstalled(tx)).catch((e: unknown) => e);
      expect((partial as OtoAppSeamNotGrantedError).missing).toEqual([
        'SELECT on otoapp_v.event_attendees',
        'SELECT on otoapp_v.event_attendance',
        'SELECT on otoapp_v.children',
      ]);

      // The post-import grants, and nothing on the tables: the views read.
      await ctx.db.execute(sql.raw(`grant select on all tables in schema otoapp_v to ${role}`));
      expect(await asRole((tx) => otoAppEventsInstalled(tx))).toBe(true);
      const events = await asRole((tx) =>
        listBranchEvents(tx, { branchId: central, from: D1, to: D1 }),
      );
      expect(events).toHaveLength(7);
      const checkins = await asRole((tx) =>
        listEventAttendance(tx, { branchId: central, eventId: ids.workshop, date: D1 }),
      );
      expect(checkins.map((c) => c.checkinRef)).toEqual([ids.teeCheckin]);
    } finally {
      await ctx.db.execute(sql.raw(`drop owned by ${role}`));
      await ctx.db.execute(sql.raw(`drop role ${role}`));
    }
  });
});

// --- The write-back's ids ---------------------------------------------------

interface DirectoryEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}
interface WriteOutcome {
  ok: boolean;
  status: number;
  error?: string;
  body?: {
    replayed?: boolean;
    attendee?: { id: string };
    checkin?: { checkinRef: string | null; attendeeId: string; status: string };
  };
}
interface DirectoryWrites {
  findTenantEvent(pool: pg.Pool, tenantId: string, eventId: string): Promise<DirectoryEvent | null>;
  createEventAttendee(
    pool: pg.Pool,
    event: DirectoryEvent,
    input: {
      id: string;
      childFullName: string;
      parentAttending: boolean;
      attendanceDays: string[];
      source: 'pos';
    },
  ): Promise<WriteOutcome>;
  recordAttendeeCheckin(
    pool: pg.Pool,
    event: DirectoryEvent,
    attendeeId: string,
    input: { id: string; date: string },
  ): Promise<WriteOutcome>;
}

describe('the write-back: a replay is found by its ids, whatever their case', () => {
  let appPool: pg.Pool;
  let writes: DirectoryWrites;
  const wb = { workshop: newId(), camp: newId() };

  beforeAll(async () => {
    // The app's writes import only types, so its source loads as is. They name
    // the app's tables unqualified, as the app does: a pool of their own on the
    // app's search path, so ctx.db's stays the platform's.
    const { connectionString } = (ctx.db as unknown as { $client: pg.Pool }).$client.options;
    appPool = new pg.Pool({ connectionString, options: '-c search_path=otoapp', max: 4 });
    writes = (await import(
      /* @vite-ignore */ pathToFileURL(
        fileURLToPath(new URL('../../oto-app/server/directory/eventWrites.ts', import.meta.url)),
      ).href
    )) as DirectoryWrites;
    // At Chalong, so nothing the read tests count at Central moves.
    await appEvent({
      id: wb.workshop,
      branch: appChalong,
      type: 'workshop',
      title: 'Write-back workshop',
    });
    await appEvent({
      id: wb.camp,
      branch: appChalong,
      type: 'camp',
      title: 'Write-back camp',
      campEnd: D5,
    });
  });

  afterAll(async () => {
    await appPool?.end();
  });

  const kid = (attendanceDays: string[]) => ({
    id: newId(),
    childFullName: 'Capital letters',
    parentAttending: false,
    attendanceDays,
    source: 'pos' as const,
  });

  it('a one-off check-in replayed with the attendee and check-in ids in capitals is a replay', async () => {
    const event = (await writes.findTenantEvent(appPool, appTenant, wb.workshop.toUpperCase()))!;
    expect(event.id).toBe(wb.workshop);
    const child = kid([]);
    expect((await writes.createEventAttendee(appPool, event, child)).status).toBe(201);
    const ref = newId();
    const first = await writes.recordAttendeeCheckin(appPool, event, child.id, {
      id: ref,
      date: D1,
    });
    const again = await writes.recordAttendeeCheckin(appPool, event, child.id.toUpperCase(), {
      id: ref.toUpperCase(),
      date: D1,
    });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body).toMatchObject({
      replayed: true,
      checkin: { checkinRef: ref, attendeeId: child.id, status: 'checked_in' },
    });
  });

  it('a camp check-in on its waiting row, sent first in capitals, then replayed in lowercase', async () => {
    const event = (await writes.findTenantEvent(appPool, appTenant, wb.camp))!;
    const child = kid([D2]);
    expect((await writes.createEventAttendee(appPool, event, child)).status).toBe(201);
    const ref = newId();
    const first = await writes.recordAttendeeCheckin(appPool, event, child.id.toUpperCase(), {
      id: ref.toUpperCase(),
      date: D2,
    });
    const again = await writes.recordAttendeeCheckin(appPool, event, child.id, {
      id: ref,
      date: D2,
    });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(first.body?.checkin?.checkinRef).toBe(ref);
    expect(again.body).toMatchObject({ replayed: true, checkin: { checkinRef: ref } });
    const rows = await appPool.query<{ n: string }>(
      `select count(*) as n from camp_attendance where camp_registration_id = $1`,
      [child.id],
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });
});

// --- H1: the grep ------------------------------------------------------------

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const REPOSITORY = 'services/otoapp-events.ts';
/**
 * S2-17b round 2: the employee repository is the one other file in `src` that
 * may name `otoapp_v` — it reads `otoapp_v.employees` and nothing else
 * (`test/g17-round0-review.test.ts` section D holds it to that).
 */
const EMPLOYEE_REPOSITORY = 'services/otoapp-employees.ts';
const VIEWS = ['events', 'event_attendees', 'event_attendance', 'children'];

/**
 * Every table of the OTO App's events module, read from the app's own
 * migrations rather than kept by hand: a hand-kept list missed most of the
 * module (its beo_* tables, studio_event_tasks, event_line_item_templates,
 * birthday_package_templates, guest_invite_tokens, branch_events and more),
 * and a table the app adds later is covered the day its migration lands.
 */
const APP_MIGRATIONS = fileURLToPath(new URL('../../oto-app/migrations', import.meta.url));
const APP_EVENT_TABLES = readdirSync(APP_MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .flatMap((name) => [
    ...readFileSync(join(APP_MIGRATIONS, name), 'utf8').matchAll(/CREATE TABLE "([a-z_0-9]+)"/g),
  ])
  .map((m) => m[1]!)
  .filter((table) =>
    /^(core_events|camp_|beo_|studio_event|rsvp_|event_|birthday_|guest_invite|branch_events)/.test(
      table,
    ),
  );

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  file: relative(SRC, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

/** The text with comments taken out, so a doc comment can explain the rule without breaking it. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('H1 — the POS reads OTO App events through otoapp_v only', () => {
  it('is looking at the source and finds the repository', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.file)).toContain(REPOSITORY);
  });

  it("is checking every table of the app's events module, not a sample of it", () => {
    expect(APP_EVENT_TABLES.length).toBeGreaterThan(30);
    expect(APP_EVENT_TABLES).toEqual(
      expect.arrayContaining([
        'core_events',
        'camp_registrations',
        'camp_attendance',
        'event_attendees',
        'event_attendee_checkins',
        'studio_event_bookings',
        'studio_event_tasks',
        'beo_event_billing',
        'rsvp_entries',
        'event_line_item_templates',
        'birthday_package_templates',
        'guest_invite_tokens',
        'branch_events',
      ]),
    );
  });

  it('no file in src names an OTO App event table, by SQL name or schema-qualified', () => {
    const table = new RegExp(
      `(?<!otoapp_v\\.)\\b(?:otoapp\\.)?(${APP_EVENT_TABLES.join('|')})\\b`,
      'g',
    );
    const hits = files.flatMap(({ file, text }) =>
      [...code(text).matchAll(table)].map((m) => `${file}: ${m[0]}`),
    );
    expect(hits, 'an OTO App event table named outside otoapp_v').toEqual([]);
  });

  it('no Drizzle declaration of an OTO App event table exists for src to import', () => {
    const declarations = readFileSync(
      fileURLToPath(new URL('../../../packages/db/src/schema/otoapp.ts', import.meta.url)),
      'utf8',
    );
    const declared = [...declarations.matchAll(/otoapp\.table\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((t) => APP_EVENT_TABLES.includes(t!))).toEqual([]);
  });

  it('only the repositories name otoapp_v: the events one and, from S2-17b round 2, the employee one', () => {
    const naming = files.filter(({ text }) => /\botoapp_v\b/.test(code(text))).map((f) => f.file);
    expect(naming.sort()).toEqual([EMPLOYEE_REPOSITORY, REPOSITORY].sort());
  });

  it('the repository reads the four views and nothing else, and writes nothing', () => {
    const repo = code(files.find((f) => f.file === REPOSITORY)!.text);
    const relations = [...repo.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)]
      .map((m) => m[1]!)
      // `from 'drizzle-orm'` and its like are imports, not relations.
      .filter((name) => !/^['"]/.test(name));
    expect(relations.length).toBeGreaterThanOrEqual(5);
    for (const relation of relations) {
      expect(relation, `the repository reads ${relation}`).toMatch(
        new RegExp(`^otoapp_v\\.(${VIEWS.join('|')})$`),
      );
    }
    for (const view of VIEWS) expect(repo).toContain(`otoapp_v.${view}`);
    expect(repo).not.toMatch(
      /\b(insert\s+into|update\s+\w|delete\s+from|truncate|merge\s+into|alter\s+|create\s+|drop\s+)/i,
    );
    expect(repo).not.toMatch(/from '@oto\/db'/);
  });
});
