import type { Pool, PoolClient } from "pg";

/**
 * The directory API's two event writes (events-kiosk PLAN s8, round 0): add a
 * child to an event, and check an attendee in for a day.
 *
 * WHO CALLS THESE. The POS, writing back what happened at the till or the
 * door. This app stays the master of every registration and check-in (PLAN
 * Q1); the POS keeps a mirror and reads this app's state through the
 * `otoapp_v` views. So nothing here is a new rule: a camp child is added the
 * way the app's own one-time add adds one, and a check-in lands in the same
 * `camp_attendance` row the app's check-in screen writes.
 *
 * EVERY WRITE CARRIES THE CALLER'S OWN ID. The POS mints the attendee's id and
 * the check-in's id before it calls, and sends them again on a retry. The id
 * is looked up first, so a retry after a lost answer is a REPLAY — the stored
 * result comes back and nothing is written twice — and the same id offered for
 * a different event, attendee or day is refused rather than reused.
 *
 * THE TENANT IS THE KEY'S. Every lookup below is fenced by the tenant of the
 * directory key the request was authenticated with (`clientAuth.ts`), so an
 * event, attendee or booking in another tenant is "not found", exactly like
 * one that does not exist.
 *
 * Timestamps: `camp_attendance` and `camp_registrations` keep the app's naive
 * UTC timestamps, so every value written there is converted explicitly with
 * `at time zone 'UTC'` rather than left to the process time zone; the new
 * tables are `timestamptz`.
 */

type Queryable = Pool | PoolClient;

/** What the directory API answers with. `status` is the HTTP status. */
export type WriteOutcome<T> =
  | { ok: true; status: 200 | 201; body: T }
  | { ok: false; status: 400 | 404 | 409; error: string; message: string; details?: unknown };

const refuse = (
  status: 400 | 404 | 409,
  error: string,
  message: string,
  details?: unknown,
): { ok: false; status: 400 | 404 | 409; error: string; message: string; details?: unknown } =>
  details === undefined ? { ok: false, status, error, message } : { ok: false, status, error, message, details };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The app's placeholders for a parent, a phone and a date of birth nobody gave (its manager add). */
const NO_PARENT = "Manager Added";
const NO_PHONE = "MANAGER_ADDED";
const NO_SIGNATURE = "MANAGER_ADDED";
const NO_DATE_OF_BIRTH = "1900-01-01";

// --- The event --------------------------------------------------------------

export interface DirectoryEvent {
  id: string;
  tenantId: string;
  isCamp: boolean;
  branchTimezone: string;
}

/**
 * The event, if it is this tenant's and not archived. An id that is not a
 * uuid is simply not found: the column is a uuid and asking would raise.
 */
export async function findTenantEvent(
  db: Queryable,
  tenantId: string,
  eventId: string,
): Promise<DirectoryEvent | null> {
  if (!UUID.test(eventId)) return null;
  const { rows } = await db.query<{ id: string; tenant_id: string; event_type: string; timezone: string | null }>(
    `select e.id, e.tenant_id, e.event_type::text as event_type, b.timezone
       from core_events e
       left join branches b on b.id = e.branch_id
      where e.id = $1 and e.tenant_id = $2 and not e.is_archived`,
    [eventId, tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    isCamp: row.event_type === "camp",
    branchTimezone: row.timezone || "Asia/Bangkok",
  };
}

// --- Adding a child ---------------------------------------------------------

export interface AttendeeInput {
  id: string;
  childFullName: string;
  dateOfBirth?: string | null;
  ageYears?: number | null;
  primaryLanguage?: string | null;
  allergies?: string | null;
  foodRestrictions?: string | null;
  parentName?: string | null;
  parentPhone?: string | null;
  parentAttending: boolean;
  attendanceDays: string[];
  notes?: string | null;
  bookingId?: string | null;
  source: "pos" | "booking" | "kiosk";
  createdBy?: string | null;
}

export interface AttendeeResult {
  attendee: {
    id: string;
    eventId: string;
    recordKind: "camp_registration" | "event_attendee";
    childName: string;
    parentName: string | null;
    parentPhone: string | null;
    parentAttending: boolean;
    attendanceDays: string[];
    createdAt: string;
  };
  /** The same id was sent before; this is what that request made. */
  replayed: boolean;
  /**
   * A camp only: the child was already registered on this camp under the same
   * name and phone, so the days were added to that registration instead of a
   * second child being made (the app's own rule). `attendee.id` is then that
   * registration's id, not the one sent.
   */
  merged: boolean;
}

const blank = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

interface StoredAttendee {
  id: string;
  event_id: string;
  tenant_id: string;
  record_kind: "camp_registration" | "event_attendee";
  child_name: string;
  parent_name: string | null;
  parent_phone: string | null;
  parent_attending: boolean;
  attendance_days: unknown;
  created_at: Date;
}

/** One attendee by id, in either table — the id space the POS mints into is one space. */
async function storedAttendee(db: Queryable, id: string): Promise<StoredAttendee | null> {
  const { rows } = await db.query<StoredAttendee>(
    `select id, event_id, tenant_id, 'camp_registration' as record_kind, child_full_name as child_name,
            nullif(parent_guardian_name, '${NO_PARENT}') as parent_name,
            nullif(emergency_contact_number, '${NO_PHONE}') as parent_phone,
            parent_attending, attendance_days, created_at at time zone 'UTC' as created_at
       from camp_registrations where id = $1
     union all
     select id, event_id, tenant_id, 'event_attendee', child_full_name, parent_name, parent_phone,
            parent_attending, '[]'::jsonb, created_at
       from event_attendees where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

const daysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : [];

function shape(row: StoredAttendee): AttendeeResult["attendee"] {
  return {
    id: row.id,
    eventId: row.event_id,
    recordKind: row.record_kind,
    childName: row.child_name,
    parentName: row.parent_name,
    parentPhone: row.parent_phone,
    parentAttending: row.parent_attending,
    attendanceDays: daysOf(row.attendance_days),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** The answer for an id that is already taken: a replay if it is this event's, a conflict if not. */
function answerForTakenId(
  existing: StoredAttendee,
  event: DirectoryEvent,
): WriteOutcome<AttendeeResult> {
  if (existing.event_id === event.id && existing.tenant_id === event.tenantId) {
    return { ok: true, status: 200, body: { attendee: shape(existing), replayed: true, merged: false } };
  }
  return refuse(409, "id_in_use", "This id already belongs to another attendee");
}

async function inTransaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const result = await work(tx);
    await tx.query("commit");
    return result;
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

/**
 * Add a child to an event, by the caller's id.
 *
 * A camp: a `camp_registrations` row made the way the app's own ONE-TIME add
 * makes one (`POST /api/admin/events/:eventId/camp-registrations/manager`,
 * mode `one_time` — "minimum info only, convertible to a full profile later"),
 * which is what a walk-up added at the till is. Its placeholders for a missing
 * parent, phone and date of birth are the app's, its "waiting" attendance rows
 * are made for each day, and its duplicate rule holds: the same name and phone
 * already on this camp gets the new days merged in rather than a second row.
 * A camp add must name its days — an empty list means EVERY day to the app,
 * which no caller should get by leaving a field out.
 *
 * A one-off event or a party: an `event_attendees` row (PLAN Q7). There is no
 * duplicate rule for these in the app and none is invented here.
 */
export async function createEventAttendee(
  pool: Pool,
  event: DirectoryEvent,
  input: AttendeeInput,
): Promise<WriteOutcome<AttendeeResult>> {
  if (event.isCamp && input.attendanceDays.length === 0) {
    return refuse(400, "attendance_days_required", "A camp registration must name the days the child attends");
  }
  if (!event.isCamp && input.attendanceDays.length > 0) {
    return refuse(400, "attendance_days_not_applicable", "Only a camp registers a child for days");
  }
  if (event.isCamp && input.bookingId) {
    return refuse(400, "booking_not_applicable", "A camp registration does not belong to a group booking");
  }

  return inTransaction(pool, async (tx) => {
    const taken = await storedAttendee(tx, input.id);
    if (taken) return answerForTakenId(taken, event);
    return event.isCamp ? addCampChild(tx, event, input) : addEventChild(tx, event, input);
  });
}

async function addCampChild(
  tx: PoolClient,
  event: DirectoryEvent,
  input: AttendeeInput,
): Promise<WriteOutcome<AttendeeResult>> {
  const days = [...new Set(input.attendanceDays)];
  const name = input.childFullName.trim();
  const phone = blank(input.parentPhone);

  // The app's duplicate rule, as its manager add applies it: only with a real
  // phone, because a missing phone cannot say two entries are one child.
  if (phone) {
    const { rows } = await tx.query<{ id: string; attendance_days: unknown }>(
      `select id, attendance_days from camp_registrations
        where tenant_id = $1 and event_id = $2
          and lower(trim(child_full_name)) = lower($3)
          and emergency_contact_number = $4
        order by created_at
        limit 1
        for update`,
      [event.tenantId, event.id, name, phone],
    );
    const same = rows[0];
    if (same) {
      const current = daysOf(same.attendance_days);
      const added = days.filter((d) => !current.includes(d));
      if (added.length > 0) {
        await tx.query(
          `update camp_registrations
              set attendance_days = $2::jsonb, updated_at = now() at time zone 'UTC'
            where id = $1`,
          [same.id, JSON.stringify([...current, ...added])],
        );
        await seedWaitingDays(tx, event, same.id, added);
      }
      const merged = await storedAttendee(tx, same.id);
      return { ok: true, status: 200, body: { attendee: shape(merged!), replayed: false, merged: true } };
    }
  }

  const notes = [blank(input.notes), input.ageYears != null ? `Age: ${input.ageYears}` : null]
    .filter((line): line is string => line !== null)
    .join("\n");

  const inserted = await tx.query<{ id: string }>(
    `insert into camp_registrations (
        id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name,
        emergency_contact_number, allergies, food_restrictions, special_notes, primary_language,
        attendance_days, agreed_camp_rules, agreed_child_healthy, agreed_camp_rules_date,
        parent_signature, signature_date, is_one_time, added_by_manager, parent_attending)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, true, true,
             now() at time zone 'UTC', $13, to_char(now() at time zone $14, 'YYYY-MM-DD'),
             true, true, $15)
     on conflict do nothing
     returning id`,
    [
      input.id,
      event.tenantId,
      event.id,
      name,
      input.dateOfBirth || NO_DATE_OF_BIRTH,
      blank(input.parentName) ?? NO_PARENT,
      phone ?? NO_PHONE,
      blank(input.allergies),
      blank(input.foodRestrictions),
      notes || null,
      blank(input.primaryLanguage),
      JSON.stringify(days),
      NO_SIGNATURE,
      event.branchTimezone,
      input.parentAttending,
    ],
  );
  if (inserted.rowCount === 0) {
    // The same id, sent twice at once: the other request made it.
    const taken = await storedAttendee(tx, input.id);
    if (taken) return answerForTakenId(taken, event);
    throw new Error("camp registration insert conflicted, and no row holds its id");
  }
  await seedWaitingDays(tx, event, input.id, days);
  const made = await storedAttendee(tx, input.id);
  return { ok: true, status: 201, body: { attendee: shape(made!), replayed: false, merged: false } };
}

/** The "waiting" attendance rows the app makes for each day a camp child is registered for. */
async function seedWaitingDays(tx: PoolClient, event: DirectoryEvent, registrationId: string, days: string[]) {
  for (const day of days) {
    await tx.query(
      `insert into camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status)
       values ($1, $2, $3, $4, 'waiting')
       on conflict do nothing`,
      [registrationId, event.tenantId, event.id, day],
    );
  }
}

async function addEventChild(
  tx: PoolClient,
  event: DirectoryEvent,
  input: AttendeeInput,
): Promise<WriteOutcome<AttendeeResult>> {
  if (input.bookingId) {
    const { rowCount } = await tx.query(
      `select 1 from studio_event_bookings where id = $1 and event_id = $2`,
      [input.bookingId, event.id],
    );
    if (!rowCount) return refuse(404, "booking_not_found", "No such booking on this event");
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into event_attendees (
        id, tenant_id, event_id, booking_id, child_full_name, date_of_birth, age_years,
        primary_language, allergies, food_restrictions, parent_name, parent_phone,
        parent_attending, notes, source, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict do nothing
     returning id`,
    [
      input.id,
      event.tenantId,
      event.id,
      input.bookingId ?? null,
      input.childFullName.trim(),
      input.dateOfBirth ?? null,
      input.ageYears ?? null,
      blank(input.primaryLanguage),
      blank(input.allergies),
      blank(input.foodRestrictions),
      blank(input.parentName),
      blank(input.parentPhone),
      input.parentAttending,
      blank(input.notes),
      input.source,
      blank(input.createdBy),
    ],
  );
  if (inserted.rowCount === 0) {
    const taken = await storedAttendee(tx, input.id);
    if (taken) return answerForTakenId(taken, event);
    throw new Error("event attendee insert conflicted, and no row holds its id");
  }
  const made = await storedAttendee(tx, input.id);
  return { ok: true, status: 201, body: { attendee: shape(made!), replayed: false, merged: false } };
}

// --- Checking in ------------------------------------------------------------

export interface CheckinInput {
  /** The caller's id for this check-in. */
  id: string;
  /** The day, `yyyy-MM-dd`, in the branch's calendar — the caller's business date. */
  date: string;
  /** When it happened, if not now: a check-in queued offline arrives late. */
  checkedInAt?: string | null;
  checkedInBy?: string | null;
}

export interface CheckinResult {
  checkin: {
    id: string;
    checkinRef: string | null;
    attendeeId: string;
    eventId: string;
    date: string;
    status: "waiting" | "checked_in" | "checked_out";
    checkedInAt: string | null;
    checkedInBy: string | null;
  };
  replayed: boolean;
}

/**
 * The two tables a check-in can land in, and how each keeps its time. The
 * app's own `camp_attendance` stores naive UTC; the new one-off table stores
 * `timestamptz`.
 */
interface CheckinTable {
  table: "camp_attendance" | "event_attendee_checkins";
  attendeeColumn: "camp_registration_id" | "attendee_id";
  /** A `timestamptz` parameter, as this table's column wants it written. */
  write: (param: string) => string;
  /** This table's column, read back as `timestamptz`. */
  read: (column: string) => string;
}

const CAMP: CheckinTable = {
  table: "camp_attendance",
  attendeeColumn: "camp_registration_id",
  write: (p) => `(${p}::timestamptz at time zone 'UTC')`,
  read: (c) => `${c} at time zone 'UTC'`,
};

const ONE_OFF: CheckinTable = {
  table: "event_attendee_checkins",
  attendeeColumn: "attendee_id",
  write: (p) => `${p}::timestamptz`,
  read: (c) => c,
};

interface StoredCheckin {
  id: string;
  checkin_ref: string | null;
  attendee_id: string;
  event_id: string;
  attendance_date: string;
  status: "waiting" | "checked_in" | "checked_out";
  checked_in_at: Date | null;
  checked_in_by: string | null;
}

function checkinSelect(t: CheckinTable): string {
  return `select id, checkin_ref, ${t.attendeeColumn} as attendee_id, event_id,
                 to_char(attendance_date, 'YYYY-MM-DD') as attendance_date, status::text as status,
                 ${t.read("checked_in_at")} as checked_in_at, checked_in_by
            from ${t.table}`;
}

const checkinShape = (row: StoredCheckin): CheckinResult["checkin"] => ({
  id: row.id,
  checkinRef: row.checkin_ref,
  attendeeId: row.attendee_id,
  eventId: row.event_id,
  date: row.attendance_date,
  status: row.status,
  checkedInAt: row.checked_in_at ? new Date(row.checked_in_at).toISOString() : null,
  checkedInBy: row.checked_in_by,
});

/**
 * Check an attendee in for a day, by the caller's id.
 *
 * - The id was used before: for this attendee and day it is a replay, and the
 *   row as it stands now comes back; for anything else it is refused.
 * - The day's row is "waiting" (the app seeds these for camp days) or absent:
 *   it becomes "checked_in" with the caller's time and name, and the id is
 *   kept on it.
 * - The day's row already carries this id: a copy of this same check-in got
 *   there first while this one queued on the row's lock (both passed the
 *   lookup above before either committed). That is a replay too.
 * - The day's row is already checked in or out under some other id — the app's
 *   own check-in screen, or another caller — so this is refused as
 *   `already_checked_in` with the row that stands. One check-in per attendee
 *   per day, held by the table's unique key and by the row lock taken here.
 *
 * Ids are compared as Postgres returns them, lowercase, so the attendee id from
 * the path and the check-in id are lowercased first: an id the caller sends in
 * capitals is the same id.
 */
export async function recordAttendeeCheckin(
  pool: Pool,
  event: DirectoryEvent,
  rawAttendeeId: string,
  rawInput: CheckinInput,
): Promise<WriteOutcome<CheckinResult>> {
  if (!UUID.test(rawAttendeeId)) return refuse(404, "attendee_not_found", "No such attendee on this event");
  const attendeeId = rawAttendeeId.toLowerCase();
  const input: CheckinInput = { ...rawInput, id: rawInput.id.toLowerCase() };
  const t = event.isCamp ? CAMP : ONE_OFF;
  const attendeeTable = event.isCamp ? "camp_registrations" : "event_attendees";

  return inTransaction(pool, async (tx) => {
    const owner = await tx.query(
      `select 1 from ${attendeeTable} where id = $1 and event_id = $2 and tenant_id = $3`,
      [attendeeId, event.id, event.tenantId],
    );
    if (!owner.rowCount) return refuse(404, "attendee_not_found", "No such attendee on this event");

    const replay = await replayOf(tx, t, input, attendeeId);
    if (replay) return replay;

    const at = input.checkedInAt ?? new Date().toISOString();
    const by = blank(input.checkedInBy);

    let day = await dayRow(tx, t, attendeeId, input.date);
    if (!day) {
      const inserted = await tx.query(
        `insert into ${t.table} (id, ${t.attendeeColumn}, tenant_id, event_id, attendance_date, status,
                                 checked_in_at, checked_in_by, checkin_ref)
         values ($1, $2, $3, $4, $5, 'checked_in', ${t.write("$6")}, $7, $1)
         on conflict do nothing`,
        [input.id, attendeeId, event.tenantId, event.id, input.date, at, by],
      );
      if (inserted.rowCount) return { ok: true, status: 201, body: { checkin: (await checkinShapeById(tx, t, input.id))!, replayed: false } };
      // Somebody else made the day's row first, or the same id arrived twice
      // at once. Either way the row exists now and is decided below.
      const raced = await replayOf(tx, t, input, attendeeId);
      if (raced) return raced;
      day = await dayRow(tx, t, attendeeId, input.date);
      if (!day) throw new Error(`${t.table} insert conflicted, and the day has no row`);
    }

    // This attendee's row for this day, read under its lock, already holds this
    // very id: another copy of this check-in committed while this one waited
    // for the lock, after both had passed the replay lookup above. Same id,
    // same attendee, same day — a replay, not a second check-in.
    if (day.checkin_ref === input.id) {
      return { ok: true, status: 200, body: { checkin: checkinShape(day), replayed: true } };
    }

    if (day.status !== "waiting") {
      return refuse(409, "already_checked_in", "This child is already checked in for that day", {
        checkin: checkinShape(day),
      });
    }

    await tx.query(
      `update ${t.table}
          set status = 'checked_in', checked_in_at = ${t.write("$2")}, checked_in_by = $3,
              checkin_ref = $4, updated_at = ${t.write("now()")}
        where id = $1`,
      [day.id, at, by, input.id],
    );
    return { ok: true, status: 201, body: { checkin: (await checkinShapeById(tx, t, day.id))!, replayed: false } };
  });
}

/** The row an id was already used for: a replay when it is this attendee's day, a refusal when not. */
async function replayOf(
  tx: PoolClient,
  t: CheckinTable,
  input: CheckinInput,
  attendeeId: string,
): Promise<WriteOutcome<CheckinResult> | null> {
  const { rows } = await tx.query<StoredCheckin>(`${checkinSelect(t)} where checkin_ref = $1`, [input.id]);
  const used = rows[0];
  if (!used) return null;
  if (used.attendee_id === attendeeId && used.attendance_date === input.date) {
    return { ok: true, status: 200, body: { checkin: checkinShape(used), replayed: true } };
  }
  return refuse(409, "id_in_use", "This check-in id already belongs to another attendee or day");
}

async function dayRow(tx: PoolClient, t: CheckinTable, attendeeId: string, date: string): Promise<StoredCheckin | null> {
  const { rows } = await tx.query<StoredCheckin>(
    `${checkinSelect(t)} where ${t.attendeeColumn} = $1 and attendance_date = $2 for update`,
    [attendeeId, date],
  );
  return rows[0] ?? null;
}

async function checkinShapeById(tx: PoolClient, t: CheckinTable, id: string): Promise<CheckinResult["checkin"] | null> {
  const { rows } = await tx.query<StoredCheckin>(`${checkinSelect(t)} where id = $1`, [id]);
  return rows[0] ? checkinShape(rows[0]) : null;
}
