import { sql } from 'drizzle-orm';
import type { Exec } from './tx';

/**
 * THE POS'S ONLY WINDOW ON THE OTO APP'S EVENTS — read-only (events-kiosk PLAN
 * s8 round 0, hazard H1).
 *
 * The OTO App is the master of every event, camp, party, registration and
 * check-in (PLAN Q1, conflict C10). The POS reads them through the four views
 * the app's own migrator publishes in schema `otoapp_v`
 * (`apps/oto-app/migrations/0004_otoapp_v_views.sql`) and writes back only
 * through the app's directory API. It never names an `otoapp` event table, and
 * `test/otoapp-events-seam.test.ts` holds this file — and every other file in
 * `src` — to that by reading the source: this is the only file that may name
 * `otoapp_v`, and it may only read.
 *
 * EVERY READ IS FENCED BY THE PLATFORM BRANCH. The views carry `branch_id`,
 * the platform branch an event's app branch is mapped to (SCRUM-268); an event
 * at an unmapped app branch has no row at all. A platform branch belongs to one
 * operator, so filtering on it is also the tenant fence: a caller that passes
 * its own branch cannot read another operator's events, attendees or children.
 * Callers pass the branch their permission was checked against — never one
 * taken from a request body.
 *
 * A deployment without the OTO App has schema `otoapp` (platform migration
 * 0008) and no `otoapp_v`; every read here then answers empty rather than
 * failing, the way `otoAppBranchesInstalled` does for the branch seam. A
 * deployment that HAS the seam but has not granted this role USAGE on
 * `otoapp_v` and SELECT on its views (the post-import step's grants) is not
 * answered empty: that would tell a till "no events today" when there are. It
 * gets an `OtoAppSeamNotGrantedError` naming the missing grant instead.
 *
 * Dates are the `yyyy-MM-dd` strings the app stores and the platform's
 * business dates are; money is satang; timestamps are real instants.
 */

export type SeamEventType = 'party' | 'camp' | 'event';

export interface SeamEvent {
  id: string;
  branchId: string;
  type: SeamEventType;
  /** The OTO App's own type: birthday, private_event, school_group, other, studio_event, workshop or camp. */
  appEventType: string;
  title: string;
  status: string;
  archived: boolean;
  startDate: string;
  /** A camp's last day; null for an open-ended camp. A one-day event's own date. */
  endDate: string | null;
  cancelledDays: string[];
  startTime: string;
  endTime: string | null;
  location: string | null;
  expectedKids: number | null;
  expectedAdults: number | null;
  entryPriceWeekdaySatang: number | null;
  entryPriceWeekendSatang: number | null;
  childName: string | null;
  kidTurningAge: number | null;
  bookingName: string | null;
  parentName: string | null;
  parentPhone: string | null;
  activities: string | null;
  decoration: string | null;
  totalValueSatang: number | null;
  depositSatang: number | null;
  depositDate: string | null;
  /**
   * S2-20 E4 — when the OTO App last changed the event. A till's edit made
   * before it is refused by the app (its later change stands), so it is not
   * shown over it either. Optional so a seam event built by hand still types.
   */
  updatedAt?: Date | null;
}

export interface SeamAttendee {
  id: string;
  eventId: string;
  eventType: SeamEventType;
  recordKind: 'camp_registration' | 'event_attendee';
  childId: string;
  childName: string;
  parentName: string | null;
  parentPhone: string | null;
  parentAttending: boolean;
  attendanceDays: string[];
  /** The app's camp rule: a registration that names no day attends every day. */
  attendsAllDays: boolean;
  notes: string | null;
  isOneTime: boolean;
  source: string | null;
}

export interface SeamAttendance {
  id: string;
  checkinRef: string | null;
  attendeeId: string;
  eventId: string;
  recordKind: 'camp_registration' | 'event_attendee';
  attendanceDate: string;
  status: 'waiting' | 'checked_in' | 'checked_out';
  checkedInAt: Date | null;
  checkedInBy: string | null;
  checkedOutAt: Date | null;
  checkedOutBy: string | null;
}

export interface SeamChild {
  id: string;
  eventId: string;
  recordKind: 'camp_registration' | 'event_attendee';
  childName: string;
  dateOfBirth: string | null;
  ageYears: number | null;
  language: string | null;
  allergies: string | null;
  allergyNotes: string | null;
  foodRestrictions: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** int8 arrives from the driver as a string. */
const money = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/**
 * The four views, always schema-qualified: a bare `event_attendees` is also
 * the name of the app's table, which the H1 grep rightly refuses here.
 */
const SEAM_VIEWS = [
  'otoapp_v.events',
  'otoapp_v.event_attendees',
  'otoapp_v.event_attendance',
  'otoapp_v.children',
] as const;

/**
 * The seam is on this database but this role may not read it: the deployment
 * is missing the post-import grants (USAGE on `otoapp_v`, SELECT on its
 * views). A fault to fix, never "no events".
 */
export class OtoAppSeamNotGrantedError extends Error {
  readonly code = 'otoapp_seam_not_granted';
  constructor(readonly missing: string[]) {
    super(
      `The OTO App events seam is installed but this database role lacks ${missing.join(', ')}; ` +
        'apply the post-import grants for schema otoapp_v',
    );
    this.name = 'OtoAppSeamNotGrantedError';
  }
}

/**
 * Is the seam on this database, and may this role read it?
 *
 * - No schema `otoapp_v`, or the schema with no views in it yet: false, and
 *   every read answers empty.
 * - The seam is there but a grant is missing: `OtoAppSeamNotGrantedError`.
 *
 * Asked through catalog functions only, so the check itself never raises:
 * `to_regclass` on a schema this role has no USAGE on raises "permission
 * denied for schema" (42501) rather than answering null, which would turn the
 * absent-or-not question into a failed read — and inside a transaction, a
 * failed transaction.
 */
export async function otoAppEventsInstalled(exec: Exec): Promise<boolean> {
  const schema = await exec.execute<{ usage: boolean | null }>(
    sql`select has_schema_privilege(to_regnamespace('otoapp_v')::oid, 'USAGE') as usage`,
  );
  const usage = schema.rows[0]?.usage ?? null;
  if (usage === null) return false;
  if (!usage) throw new OtoAppSeamNotGrantedError(['USAGE on schema otoapp_v']);
  // USAGE is held, so naming a relation in the schema can no longer raise. A
  // view that is missing answers null; one this role may not read, false.
  const views = await exec.execute<{ readable: Array<boolean | null> }>(
    sql`select array[${sql.join(
      SEAM_VIEWS.map((view) => sql`has_table_privilege(to_regclass(${view})::oid, 'SELECT')`),
      sql`, `,
    )}] as readable`,
  );
  const readable = views.rows[0]?.readable ?? [];
  // `otoapp_v.events` absent: a schema made ahead of the app's migrator, not a seam yet.
  if (readable[0] === null || readable[0] === undefined) return false;
  const missing = SEAM_VIEWS.filter((_, i) => readable[i] !== true);
  if (missing.length > 0) {
    throw new OtoAppSeamNotGrantedError(missing.map((view) => `SELECT on ${view}`));
  }
  return true;
}

type EventRow = {
  id: string;
  branch_id: string;
  type: SeamEventType;
  app_event_type: string;
  title: string;
  status: string;
  archived: boolean;
  start_date: string;
  end_date: string | null;
  cancelled_days: string[];
  start_time: string;
  end_time: string | null;
  location: string | null;
  expected_kids: number | null;
  expected_adults: number | null;
  entry_price_weekday_satang: string | null;
  entry_price_weekend_satang: string | null;
  child_name: string | null;
  kid_turning_age: number | null;
  booking_name: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  activities: string | null;
  decoration: string | null;
  total_value_satang: string | null;
  deposit_satang: string | null;
  deposit_date: string | null;
  updated_at: Date | string | null;
};

const EVENT_COLUMNS =
  sql.raw(`id, branch_id, type, app_event_type, title, status, archived, start_date,
  end_date, cancelled_days, start_time, end_time, location, expected_kids, expected_adults,
  entry_price_weekday_satang, entry_price_weekend_satang, child_name, kid_turning_age, booking_name,
  parent_name, parent_phone, activities, decoration, total_value_satang, deposit_satang, deposit_date,
  updated_at`);

const toEvent = (r: EventRow): SeamEvent => ({
  id: r.id,
  branchId: r.branch_id,
  type: r.type,
  appEventType: r.app_event_type,
  title: r.title,
  status: r.status,
  archived: r.archived,
  startDate: r.start_date,
  endDate: r.end_date,
  cancelledDays: r.cancelled_days,
  startTime: r.start_time,
  endTime: r.end_time,
  location: r.location,
  expectedKids: r.expected_kids,
  expectedAdults: r.expected_adults,
  entryPriceWeekdaySatang: money(r.entry_price_weekday_satang),
  entryPriceWeekendSatang: money(r.entry_price_weekend_satang),
  childName: r.child_name,
  kidTurningAge: r.kid_turning_age,
  bookingName: r.booking_name,
  parentName: r.parent_name,
  parentPhone: r.parent_phone,
  activities: r.activities,
  decoration: r.decoration,
  totalValueSatang: money(r.total_value_satang),
  depositSatang: money(r.deposit_satang),
  depositDate: r.deposit_date,
  updatedAt: r.updated_at === null ? null : new Date(r.updated_at),
});

/**
 * The branch's events that touch the days `from`..`to` (inclusive): a one-day
 * event on one of them, a camp whose range overlaps them — an open-ended camp
 * from its first day on. Archived events are left out. Which of these a screen
 * shows on which day (a camp on every day of its range, PLAN Q4) is the
 * caller's rule, not this read's.
 */
export async function listBranchEvents(
  exec: Exec,
  q: { branchId: string; from: string; to: string },
): Promise<SeamEvent[]> {
  if (!UUID.test(q.branchId) || !DATE.test(q.from) || !DATE.test(q.to)) return [];
  if (!(await otoAppEventsInstalled(exec))) return [];
  const res = await exec.execute<EventRow>(sql`
    select ${EVENT_COLUMNS}
      from otoapp_v.events
     where branch_id = ${q.branchId}::uuid
       and not archived
       and start_date <= ${q.to}
       and (end_date is null or end_date >= ${q.from})
     order by start_date, start_time, title`);
  return res.rows.map(toEvent);
}

/** One event of the branch, archived or not; null when it is not this branch's. */
export async function getBranchEvent(
  exec: Exec,
  q: { branchId: string; eventId: string },
): Promise<SeamEvent | null> {
  if (!UUID.test(q.branchId) || !UUID.test(q.eventId)) return null;
  if (!(await otoAppEventsInstalled(exec))) return null;
  const res = await exec.execute<EventRow>(sql`
    select ${EVENT_COLUMNS}
      from otoapp_v.events
     where branch_id = ${q.branchId}::uuid and id = ${q.eventId}::uuid`);
  const row = res.rows[0];
  return row ? toEvent(row) : null;
}

/** The children registered on one of the branch's events. */
export async function listEventAttendees(
  exec: Exec,
  q: { branchId: string; eventId: string },
): Promise<SeamAttendee[]> {
  if (!UUID.test(q.eventId)) return [];
  return listAttendeesOfEvents(exec, { branchId: q.branchId, eventIds: [q.eventId] });
}

/** `sql` for `(id, id, …)`, the ids already checked to be uuids. */
const uuidList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * Some of the branch's events by id, archived or not, in one read — an id that
 * is not one of this branch's events has no row. S2-20 E4: End of Day asks
 * which day each paid party is held on, as the OTO App holds it when the day
 * is read (the prototype's `getPartiesForDate`).
 */
export async function getBranchEvents(
  exec: Exec,
  q: { branchId: string; eventIds: readonly string[] },
): Promise<SeamEvent[]> {
  const eventIds = [...new Set(q.eventIds.filter((id) => UUID.test(id)))];
  if (!UUID.test(q.branchId) || eventIds.length === 0) return [];
  if (!(await otoAppEventsInstalled(exec))) return [];
  const res = await exec.execute<EventRow>(sql`
    select ${EVENT_COLUMNS}
      from otoapp_v.events
     where branch_id = ${q.branchId}::uuid and id in (${uuidList(eventIds)})`);
  return res.rows.map(toEvent);
}

/**
 * The children registered on some of the branch's events, in one read — what
 * a day's list needs (S2-20 E1), where one read per event would be a round of
 * queries per camp. Ordered by event, then as `listEventAttendees` orders.
 */
export async function listAttendeesOfEvents(
  exec: Exec,
  q: { branchId: string; eventIds: readonly string[] },
): Promise<SeamAttendee[]> {
  const eventIds = q.eventIds.filter((id) => UUID.test(id));
  if (!UUID.test(q.branchId) || eventIds.length === 0) return [];
  if (!(await otoAppEventsInstalled(exec))) return [];
  const res = await exec.execute<{
    id: string;
    event_id: string;
    event_type: SeamEventType;
    record_kind: SeamAttendee['recordKind'];
    child_id: string;
    child_name: string;
    parent_name: string | null;
    parent_phone: string | null;
    parent_attending: boolean;
    attendance_days: string[];
    attends_all_days: boolean;
    notes: string | null;
    is_one_time: boolean;
    source: string | null;
  }>(sql`
    select id, event_id, event_type, record_kind, child_id, child_name, parent_name, parent_phone,
           parent_attending, attendance_days, attends_all_days, notes, is_one_time, source
      from otoapp_v.event_attendees
     where branch_id = ${q.branchId}::uuid and event_id in (${uuidList(eventIds)})
     order by event_id, child_name, id`);
  return res.rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventType: r.event_type,
    recordKind: r.record_kind,
    childId: r.child_id,
    childName: r.child_name,
    parentName: r.parent_name,
    parentPhone: r.parent_phone,
    parentAttending: r.parent_attending,
    attendanceDays: r.attendance_days,
    attendsAllDays: r.attends_all_days,
    notes: r.notes,
    isOneTime: r.is_one_time,
    source: r.source,
  }));
}

/** The per-day check-in state of one of the branch's events, for one day or all of them. */
export async function listEventAttendance(
  exec: Exec,
  q: { branchId: string; eventId: string; date?: string },
): Promise<SeamAttendance[]> {
  if (!UUID.test(q.eventId)) return [];
  return listAttendanceOfEvents(exec, { branchId: q.branchId, eventIds: [q.eventId], date: q.date });
}

/**
 * The per-day check-in state of some of the branch's events, in one read, for
 * one day or all of them. Ordered by event, then as `listEventAttendance`
 * orders.
 */
export async function listAttendanceOfEvents(
  exec: Exec,
  q: { branchId: string; eventIds: readonly string[]; date?: string },
): Promise<SeamAttendance[]> {
  const eventIds = q.eventIds.filter((id) => UUID.test(id));
  if (!UUID.test(q.branchId) || eventIds.length === 0) return [];
  if (q.date !== undefined && !DATE.test(q.date)) return [];
  if (!(await otoAppEventsInstalled(exec))) return [];
  const res = await exec.execute<{
    id: string;
    checkin_ref: string | null;
    attendee_id: string;
    event_id: string;
    record_kind: SeamAttendance['recordKind'];
    attendance_date: string;
    status: SeamAttendance['status'];
    checked_in_at: Date | string | null;
    checked_in_by: string | null;
    checked_out_at: Date | string | null;
    checked_out_by: string | null;
  }>(sql`
    select id, checkin_ref, attendee_id, event_id, record_kind, attendance_date, status,
           checked_in_at, checked_in_by, checked_out_at, checked_out_by
      from otoapp_v.event_attendance
     where branch_id = ${q.branchId}::uuid and event_id in (${uuidList(eventIds)})
       ${q.date === undefined ? sql`` : sql`and attendance_date = ${q.date}`}
     order by event_id, attendance_date, attendee_id`);
  const instant = (v: Date | string | null) => (v === null ? null : new Date(v));
  return res.rows.map((r) => ({
    id: r.id,
    checkinRef: r.checkin_ref,
    attendeeId: r.attendee_id,
    eventId: r.event_id,
    recordKind: r.record_kind,
    attendanceDate: r.attendance_date,
    status: r.status,
    checkedInAt: instant(r.checked_in_at),
    checkedInBy: r.checked_in_by,
    checkedOutAt: instant(r.checked_out_at),
    checkedOutBy: r.checked_out_by,
  }));
}

/** The children behind some of the branch's registrations, by registration id. */
export async function listSeamChildren(
  exec: Exec,
  q: { branchId: string; ids: string[] },
): Promise<SeamChild[]> {
  const ids = q.ids.filter((id) => UUID.test(id));
  if (!UUID.test(q.branchId) || ids.length === 0) return [];
  if (!(await otoAppEventsInstalled(exec))) return [];
  const res = await exec.execute<{
    id: string;
    event_id: string;
    record_kind: SeamChild['recordKind'];
    child_name: string;
    date_of_birth: string | null;
    age_years: number | null;
    language: string | null;
    allergies: string | null;
    allergy_notes: string | null;
    food_restrictions: string | null;
    guardian_name: string | null;
    guardian_phone: string | null;
  }>(sql`
    select id, event_id, record_kind, child_name, date_of_birth, age_years, language, allergies,
           allergy_notes, food_restrictions, guardian_name, guardian_phone
      from otoapp_v.children
     where branch_id = ${q.branchId}::uuid
       and id in (${uuidList(ids)})
     order by child_name, id`);
  return res.rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    recordKind: r.record_kind,
    childName: r.child_name,
    dateOfBirth: r.date_of_birth,
    ageYears: r.age_years,
    language: r.language,
    allergies: r.allergies,
    allergyNotes: r.allergy_notes,
    foodRestrictions: r.food_restrictions,
    guardianName: r.guardian_name,
    guardianPhone: r.guardian_phone,
  }));
}
