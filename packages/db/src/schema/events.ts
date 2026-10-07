import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, station } from './fleet';
import { child, member } from './members';
import { booking } from './future';
import { band, sale, saleLine } from './sales';

// --- Events, camps and parties: what the POS writes (schema `pos`) ----------
//
// S2-20 E2 (SCRUM-217; plan docs/progress/plans/events-kiosk/PLAN.md §8). The
// OTO App owns every event, registration and check-in (conflict C10, Q1); the
// POS reads them through its views and writes back through its directory API.
// What lives here is the POS's own half of a write: which sale paid for the
// child, what was charged, who added them and from where, and whether the OTO
// App has the child yet — so a write-back that fails is a row somebody can see
// and retry, never a child who silently is not on the roster.
//
// The unused `pos.attendee` placeholder (`future.ts`) is left untouched until
// the sprint's clean-up (plan §8).

/** party | camp | event, as the views map the OTO App's types (Q10). */
export const EVENT_ATTENDEE_TYPES = ['party', 'camp', 'event'] as const;
export type EventAttendeeType = (typeof EVENT_ATTENDEE_TYPES)[number];

/** Where the attendee came from. Only `till` is written by E2; the rest are the later rounds'. */
export const EVENT_ATTENDEE_SOURCES = ['till', 'booking', 'kiosk', 'otoapp'] as const;
export type EventAttendeeSource = (typeof EVENT_ATTENDEE_SOURCES)[number];

/**
 * Whether the OTO App has the child yet.
 *
 *   - `synced`  — the directory answered with the attendee;
 *   - `pending` — not yet: the call is in flight, or it failed in a way a retry
 *                 can fix (no answer, a server fault, a busy app);
 *   - `failed`  — the app refused the write (an event it no longer has, an id
 *                 it holds for another child). A retry is still offered, and
 *                 replays the same id, but somebody has to look first.
 */
export const EVENT_ATTENDEE_SYNC_STATES = ['synced', 'pending', 'failed'] as const;
export type EventAttendeeSyncState = (typeof EVENT_ATTENDEE_SYNC_STATES)[number];

/**
 * How the attendee was paid for (`sellEventPass`, lib/eventPass.ts):
 *
 *   - `sale`      — a paid camp or event pass: an ordinary sale at the till;
 *   - `party_tab` — a party walk-up: the party-guest price, owed on the party's
 *                   tab, with no door payment;
 *   - `free`      — an event whose entry price is ฿0: the attendee, no sale;
 *   - `booking`   — S2-20 E5: a pass bought online (mockApi.ts `createBooking`
 *                   1085-1115), paid with the booking's one payment. It names
 *                   the booking from its registration at payment, and the
 *                   redemption sale that files the booking's money — the pass
 *                   among it — once the booking is redeemed.
 */
export const EVENT_ATTENDEE_BILLINGS = ['sale', 'party_tab', 'free', 'booking'] as const;
export type EventAttendeeBilling = (typeof EVENT_ATTENDEE_BILLINGS)[number];

/**
 * ONE CHILD THE POS ADDED TO AN OTO APP EVENT — the C10 link from the app's
 * attendee to the platform's sale, member and child.
 *
 * `id` IS THE ATTENDEE ID THE TILL MINTED, and the id the directory call
 * carries: the OTO App stores the attendee under it, so a retry — the till's
 * after a lost answer, or the Failures page's after a failed write — is a
 * replay there, never a second child. `otoapp_attendee_id` is what the app
 * answered: the same id, except when the app's own camp rule merged the child
 * into a registration it already held under the same name and phone. That is
 * also why the pair (`otoapp_event_id`, `otoapp_attendee_id`) is indexed but
 * not unique: two walk-up sales of one child on one camp are two links — two
 * sales, two prices — onto one registration.
 *
 * `writeback` is the body the directory is sent, exactly as sent: what a retry
 * replays, what the roster shows for a child the app does not have yet, and
 * the name a party walk-up's charge is printed with ("Walk-up guest — name").
 * The OTO App stays the master of the child; this is the POS's record of what
 * it asked the app to hold.
 */
export const eventAttendeeLink = pos.table(
  'event_attendee_link',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The OTO App's event. No foreign key: the app's tables are its own (C10). */
    otoappEventId: uuid('otoapp_event_id').notNull(),
    /** The OTO App's attendee, once it answered. Null until `synced`. */
    otoappAttendeeId: uuid('otoapp_attendee_id'),
    eventType: text('event_type').$type<EventAttendeeType>().notNull(),
    /** The saved child the till pre-filled from, when it did. */
    childId: uuid('child_id').references(() => child.id, { onDelete: 'restrict' }),
    /** The member the till identified, when it did. */
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'restrict' }),
    /**
     * The pass sale; null for a party walk-up and a free event. For a pass
     * bought online (`booking`), null until the booking is redeemed, then the
     * redemption sale the pass's money was filed on.
     */
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    saleLineId: uuid('sale_line_id').references(() => saleLine.id, { onDelete: 'restrict' }),
    billing: text('billing').$type<EventAttendeeBilling>().notNull(),
    /** S2-20 E5 — the online booking that bought the pass (`source = 'booking'`). */
    bookingId: uuid('booking_id').references(() => booking.id, { onDelete: 'restrict' }),
    /**
     * What this child was charged, frozen: the pass's flat entry price, or the
     * party-guest price that went on the tab, at the rate mode of the day.
     */
    priceSnapshotSatang: bigint('price_snapshot_satang', { mode: 'number' }).notNull().default(0),
    parentAttending: boolean('parent_attending').notNull().default(false),
    /** A camp's days; empty for a one-off event or a party. */
    attendanceDays: date('attendance_days', { mode: 'string' })
      .array()
      .notNull()
      .default(sql`'{}'::date[]`),
    source: text('source').$type<EventAttendeeSource>().notNull().default('till'),
    syncState: text('sync_state').$type<EventAttendeeSyncState>().notNull().default('pending'),
    /** Directory calls made for this link, the first included. */
    syncAttempts: integer('sync_attempts').notNull().default(0),
    /** The last refusal or fault, as `CODE: message`, short and scrubbed. Null once synced. */
    syncError: text('sync_error'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    /** The app merged the child into a registration it already held (its camp rule). */
    merged: boolean('merged').notNull().default(false),
    /** The directory body as sent, replayed on a retry. */
    writeback: jsonb('writeback'),
    /** Who added the child. */
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /** `x-oto-action-id` of the press — the sale's, the audit row's and the ops runs'. */
    actionId: text('action_id'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('event_attendee_link_operator_idx').on(t.operatorId),
    index('event_attendee_link_branch_idx').on(t.branchId, t.createdAt),
    /** A day's roster reads the links of its events. */
    index('event_attendee_link_event_idx').on(t.otoappEventId, t.otoappAttendeeId),
    index('event_attendee_link_child_idx').on(t.childId),
    index('event_attendee_link_member_idx').on(t.memberId),
    index('event_attendee_link_sale_idx').on(t.saleId),
    index('event_attendee_link_sale_line_idx').on(t.saleLineId),
    index('event_attendee_link_account_idx').on(t.accountId),
    index('event_attendee_link_station_idx').on(t.stationId),
    index('event_attendee_link_box_idx').on(t.boxId),
    index('event_attendee_link_booking_idx').on(t.bookingId),
    /** What still owes the OTO App a write. */
    index('event_attendee_link_unsynced_idx')
      .on(t.syncState, t.createdAt)
      .where(sql`sync_state <> 'synced'`),
    check('event_attendee_link_type_check', sql`${t.eventType} in ('party','camp','event')`),
    check('event_attendee_link_source_check', sql`${t.source} in ('till','booking','kiosk','otoapp')`),
    check('event_attendee_link_sync_check', sql`${t.syncState} in ('synced','pending','failed')`),
    check('event_attendee_link_billing_check', sql`${t.billing} in ('sale','party_tab','free','booking')`),
    check('event_attendee_link_price_check', sql`${t.priceSnapshotSatang} >= 0`),
    /**
     * A till's paid pass names its sale; a walk-up on a party's tab and a free
     * event never do; a pass bought online names its redemption sale once the
     * booking is redeemed (S2-20 E5).
     */
    check(
      'event_attendee_link_sale_check',
      sql`(${t.billing} <> 'sale' or ${t.saleId} is not null) and (${t.billing} not in ('party_tab','free') or ${t.saleId} is null)`,
    ),
    /** A pass bought online names the booking that paid for it. */
    check(
      'event_attendee_link_booking_check',
      sql`${t.billing} <> 'booking' or ${t.bookingId} is not null`,
    ),
    /** Synced means the app answered with an attendee. */
    check(
      'event_attendee_link_synced_check',
      sql`${t.syncState} <> 'synced' or (${t.otoappAttendeeId} is not null and ${t.syncedAt} is not null)`,
    ),
  ],
);

/** Where a check-in was made: a till online, a box with the link down, or the OTO App itself. */
export const EVENT_CHECKIN_ORIGINS = ['till', 'box', 'otoapp'] as const;
export type EventCheckinOrigin = (typeof EVENT_CHECKIN_ORIGINS)[number];

/**
 * ONE CHILD'S DAY AT AN EVENT, AS THE POS KEEPS IT (S2-20 E3; plan §8, Q1).
 *
 * The OTO App stays the master of who attended which day (`camp_attendance`,
 * and `event_attendee_checkins` for a one-off event): this row is the POS's
 * MIRROR of a check-in it made — the bands it minted and printed, who did it
 * and where — and the record of the write that tells the app. Its `id` is the
 * check-in id the till (or the box) minted, and the id the directory call
 * carries: the app keeps the check-in under it, so a retry is a replay there.
 *
 * `attendee_id` is the child as the roster named them when they were checked
 * in: the app's registration (or one-off attendee) id, or — for a child the
 * till added that the app does not have yet — the till's own attendee id, with
 * `link_id` naming that link. A child the app merged into a registration of
 * its own is stored under the app's id, whichever id the till named them by.
 * ONE CHECK-IN PER CHILD PER DAY is the unique key (H4): a second till, or a
 * box's fact from the link-down hours, meets it and mints no second band. A
 * check-in the app took back (`undone_at`) stands aside from that key. A child
 * checked in at the OTO App alone is mirrored here when the till checks them
 * out or reprints their band, or when a box checked them in offline and its
 * bands are the only ones they wear (`origin = 'otoapp'`).
 *
 * The child's name, allergy and diet lines, the parent and the event's title
 * and times are what the bands printed, frozen: a reprint prints the same
 * paper, and the food counter's scan of the kid band reads its allergy and
 * diet lines from here (R-50, R-68).
 *
 * A check-out is kept here and NOT written back: the OTO App's directory has a
 * check-in write and no check-out write yet (E3 report, QUESTIONS).
 */
export const eventCheckin = pos.table(
  'event_checkin',
  {
    /** The check-in id the till or the box minted — the directory call's `id`. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The OTO App's event. No foreign key: the app's tables are its own (C10). */
    otoappEventId: uuid('otoapp_event_id').notNull(),
    /** The child as the roster named them (see above). No foreign key, for the same reason. */
    attendeeId: uuid('attendee_id').notNull(),
    /** The till's link, when the child is one the POS added. */
    linkId: uuid('link_id').references(() => eventAttendeeLink.id, { onDelete: 'restrict' }),
    eventType: text('event_type').$type<EventAttendeeType>().notNull(),
    /** The branch's business date the check-in is for. */
    attendanceDate: date('attendance_date', { mode: 'string' }).notNull(),
    // What the bands printed, frozen.
    childName: text('child_name').notNull(),
    parentName: text('parent_name'),
    parentAttending: boolean('parent_attending').notNull().default(false),
    /** The OTO App's allergy and medical text, as the roster showed it (Q13: any text). */
    allergy: text('allergy'),
    dietary: text('dietary'),
    eventTitle: text('event_title').notNull(),
    startTime: text('start_time'),
    endTime: text('end_time'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true, mode: 'date' }).notNull(),
    checkedInByAccountId: uuid('checked_in_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    /** The name the OTO App is told, and the board shows: a nickname, as the park calls its staff. */
    checkedInByName: text('checked_in_by_name'),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true, mode: 'date' }),
    checkedOutByAccountId: uuid('checked_out_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    checkedOutByName: text('checked_out_by_name'),
    /**
     * The OTO App took this check-in back after it had it (its own "Undo
     * check-in": the day reads "waiting" again). Set when the till, or a box's
     * fact, next checks the child in for the day — this row's bands are revoked
     * then. An undone row is history: the roster, the food counter and the next
     * check-in pass it by, and one check-in per child per day holds among the
     * rows that are not undone.
     */
    undoneAt: timestamp('undone_at', { withTimezone: true, mode: 'date' }),
    /** The bands it printed. Each band names this row back (`band.event_checkin_id`). */
    kidBandId: uuid('kid_band_id').references((): AnyPgColumn => band.id, { onDelete: 'restrict' }),
    parentBandId: uuid('parent_band_id').references((): AnyPgColumn => band.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    origin: text('origin').$type<EventCheckinOrigin>().notNull().default('till'),
    /** A box's check-in: the fact that carried it, and its place in the box's journal. */
    sourceEventId: uuid('source_event_id'),
    boxSeq: bigint('box_seq', { mode: 'number' }),
    /** The OTO App's row for the day, once it answered. */
    otoappCheckinId: uuid('otoapp_checkin_id'),
    syncState: text('sync_state').$type<EventAttendeeSyncState>().notNull().default('pending'),
    syncAttempts: integer('sync_attempts').notNull().default(0),
    /** The last refusal or fault, as `CODE: message`, short and scrubbed. Null once synced. */
    syncError: text('sync_error'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    /** The directory body as sent, replayed on a retry. Null for a mirror of the app's own check-in. */
    writeback: jsonb('writeback'),
    /** `x-oto-action-id` of the press — the audit row's and the ops runs'. */
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    /** One check-in per child per day (R-97, H4), among the check-ins the OTO App has not taken back. */
    uniqueIndex('event_checkin_attendee_day_unique')
      .on(t.otoappEventId, t.attendeeId, t.attendanceDate)
      .where(sql`undone_at is null`),
    index('event_checkin_operator_idx').on(t.operatorId),
    index('event_checkin_branch_day_idx').on(t.branchId, t.attendanceDate),
    index('event_checkin_link_idx').on(t.linkId),
    index('event_checkin_kid_band_idx').on(t.kidBandId),
    index('event_checkin_parent_band_idx').on(t.parentBandId),
    index('event_checkin_in_by_idx').on(t.checkedInByAccountId),
    index('event_checkin_out_by_idx').on(t.checkedOutByAccountId),
    index('event_checkin_station_idx').on(t.stationId),
    index('event_checkin_box_idx').on(t.boxId),
    index('event_checkin_source_event_idx').on(t.sourceEventId),
    /** What still owes the OTO App a write. */
    index('event_checkin_unsynced_idx')
      .on(t.syncState, t.createdAt)
      .where(sql`sync_state <> 'synced'`),
    check('event_checkin_type_check', sql`${t.eventType} in ('party','camp','event')`),
    check('event_checkin_origin_check', sql`${t.origin} in ('till','box','otoapp')`),
    check('event_checkin_sync_check', sql`${t.syncState} in ('synced','pending','failed')`),
    check(
      'event_checkin_out_after_in_check',
      sql`${t.checkedOutAt} is null or ${t.checkedOutAt} >= ${t.checkedInAt}`,
    ),
    check('event_checkin_synced_check', sql`${t.syncState} <> 'synced' or ${t.syncedAt} is not null`),
  ],
);

/**
 * THE BRANCH'S WALK-UP PRICES — three weekday/weekend pairs, in satang
 * (`EventDropInPricing`, types.ts:1876; seeded camp ฿600, event ฿350, party
 * guest ฿450 at HKT and ฿0 at the second branch, catalogStore.ts).
 *
 * All three are stored and shown on the Admin Events panel; only the party
 * guest price is read anywhere — a camp or event pass is priced from the
 * event's own flat entry price, as in the prototype (Q8's default). A branch
 * with no row has never been configured, and answers ฿0 for each, which is the
 * prototype's own value for a branch nobody priced.
 */
export const eventDropInPricing = pos.table(
  'event_drop_in_pricing',
  {
    /** One row per branch: the branch is the key. */
    branchId: uuid('branch_id')
      .primaryKey()
      .references(() => branch.id, { onDelete: 'restrict' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    campDayWeekdaySatang: bigint('camp_day_weekday_satang', { mode: 'number' }).notNull().default(0),
    campDayWeekendSatang: bigint('camp_day_weekend_satang', { mode: 'number' }).notNull().default(0),
    eventDayWeekdaySatang: bigint('event_day_weekday_satang', { mode: 'number' }).notNull().default(0),
    eventDayWeekendSatang: bigint('event_day_weekend_satang', { mode: 'number' }).notNull().default(0),
    partyGuestWeekdaySatang: bigint('party_guest_weekday_satang', { mode: 'number' }).notNull().default(0),
    partyGuestWeekendSatang: bigint('party_guest_weekend_satang', { mode: 'number' }).notNull().default(0),
    updatedByAccountId: uuid('updated_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (t) => [
    index('event_drop_in_pricing_operator_idx').on(t.operatorId),
    index('event_drop_in_pricing_updated_by_idx').on(t.updatedByAccountId),
    check(
      'event_drop_in_pricing_non_negative_check',
      sql`${t.campDayWeekdaySatang} >= 0 and ${t.campDayWeekendSatang} >= 0 and ${t.eventDayWeekdaySatang} >= 0 and ${t.eventDayWeekendSatang} >= 0 and ${t.partyGuestWeekdaySatang} >= 0 and ${t.partyGuestWeekendSatang} >= 0`,
    ),
  ],
);
