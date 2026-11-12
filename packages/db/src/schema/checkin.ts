import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, crm, idPk, pos, timestamps } from './helpers';
import { account, branch, employee, operator } from './tenancy';
import { station } from './fleet';
import { child, member, visit } from './members';
import { fileObject } from './platform';
import { band, refund, sale } from './sales';

/**
 * S2-13 — CHILD CHECK-IN AND SUPERVISION (plan docs/progress/plans/checkin/
 * PLAN.md §2.1). One migration for the whole domain: the till flow writes
 * registrations, check-ins and waivers from round 1; the board, the pickups
 * and the release write the rest in rounds 2 and 3.
 *
 * Shaped from the prototype's records — `CheckIn`, `SupervisionWaiver`,
 * `SupervisionPolicy`, `DropOffPricing`, `Nanny` (prototype `types.ts:1654-
 * 2092`, `store/catalogStore.ts:678-712`, `mockApi.ts:4716-5101`).
 *
 * WHAT IS NOT HERE: a jsonb change log on the check-in. The prototype kept one
 * (`CheckIn.changeLog`); here the audit rows ARE the log (OD-C5), read back
 * filtered for the board's history view, so the two can never disagree.
 *
 * THE PHOTO (OD-C2): ONE combined child-and-guardian photo per visit, stored as
 * a `core.file_object` owned by the registration, kept until `retention_until`,
 * never on the child record. No column anywhere holds an identity-document
 * photo, and none is ever taken.
 */

// --- Shared vocabularies -------------------------------------------------------

/** What the park requires of a child (prototype `SupervisionRequirement`). */
export const SUPERVISION_SERVICES = ['none', 'drop_off', 'nanny'] as const;
export type SupervisionService = (typeof SUPERVISION_SERVICES)[number];

/**
 * A stay's life: registered at the till, in the park, collected — or, for a
 * waiting booking nobody paid for, cancelled by staff (SCRUM-862). A cancelled
 * stay keeps its row, its registration and the signed consent; it is never on
 * a sale, a board or the till's waiting-bookings picker again.
 */
export const CHECKIN_STATUSES = ['registered', 'in_park', 'out', 'cancelled'] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];

/** Where a registration was taken. */
export const REGISTRATION_SOURCES = ['till', 'board', 'booking'] as const;
export type RegistrationSource = (typeof REGISTRATION_SOURCES)[number];

/** How an authorised collector came to be on the list. */
export const GUARDIAN_SOURCES = ['in_person', 'from_chat', 'on_the_spot'] as const;
export type GuardianSource = (typeof GUARDIAN_SOURCES)[number];

/**
 * Where a nanny or a nanny shift came from (SCRUM-699): the demo seed, the OTO
 * App's rota (`apps/api/src/services/nanny-duty.ts` writes these and only
 * these), or a person adding one by hand on the Console.
 */
export const NANNY_SOURCES = ['seed', 'app_schedule', 'manual'] as const;
export type NannySource = (typeof NANNY_SOURCES)[number];

/** What happens to prepaid food a child did not use (prototype `prepaidFoodRefundPolicy`). */
export const PREPAID_FOOD_POLICIES = ['refund', 'forfeit'] as const;
export type PrepaidFoodPolicy = (typeof PREPAID_FOOD_POLICIES)[number];

/** One confirmation the guardian ticked, frozen with its wording and its moment. */
export interface AcknowledgedConfirmationRow {
  itemId: string;
  text: string;
  acknowledgedAt: string;
}

/** The prepaid food chosen at consent, in satang (prototype `ChildFoodProvision`). */
export interface FoodProvisionRow {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  creditSatang?: number;
  items?: { menuItemId: string; menuItemName: string; unitSatang: number; qty: number; redeemedQty: number }[];
}

/** One age band of the policy (prototype `SupervisionBand`). */
export interface SupervisionBandRow {
  id: string;
  label: string;
  minAge: number;
  maxAge: number | null;
  requirement: SupervisionService;
}

// --- Config (per branch) -------------------------------------------------------

/**
 * The age → service policy and the sibling waiver, one row per branch.
 * Seeded with the prototype's values: 0–4 nanny, 5–8 drop-off, 9+ none; a
 * sibling of nine or more may cover a drop-off child, staff only.
 */
export const supervisionPolicy = pos.table(
  'supervision_policy',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    bands: jsonb('bands').$type<SupervisionBandRow[]>().notNull(),
    siblingWaiverEnabled: boolean('sibling_waiver_enabled').notNull().default(true),
    waivableRequirement: text('waivable_requirement').$type<SupervisionService>().notNull().default('drop_off'),
    guardianMinAge: integer('guardian_min_age').notNull().default(9),
    /** Always true today (OD-C3): a waiver is accepted by signed-in staff, never self-service. */
    waiverStaffOnly: boolean('waiver_staff_only').notNull().default(true),
    /** The nanny ratio the board WARNS at — never a block (prototype `nannyRatioSoftMax`). */
    nannyRatioSoftMax: integer('nanny_ratio_soft_max').notNull().default(3),
    /** How long a registration's photo is kept after the stay ends (OD-C2). */
    photoRetentionDays: integer('photo_retention_days').notNull().default(30),
    /**
     * SCRUM-699 (D1): the text that makes somebody on the OTO App's rota a
     * nanny at this park — matched, case-folded, inside the shift row's group,
     * department or one of its roles. "พี่เลี้ยง" always matches as well; an
     * empty text turns off only the English term.
     */
    nannyMatchText: text('nanny_match_text').notNull().default('Nanny'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('supervision_policy_branch_unique').on(t.branchId),
    index('supervision_policy_operator_idx').on(t.operatorId),
    check(
      'supervision_policy_waivable_check',
      sql`${t.waivableRequirement} in ('none','drop_off','nanny')`,
    ),
    check(
      'supervision_policy_numbers_check',
      sql`${t.guardianMinAge} >= 0 and ${t.nannyRatioSoftMax} >= 1 and ${t.photoRetentionDays} >= 0`,
    ),
    check('supervision_policy_nanny_match_text_check', sql`char_length(${t.nannyMatchText}) <= 100`),
  ],
);

/** The confirmations a guardian ticks at consent, per branch, in order. */
export const confirmationItem = pos.table(
  'confirmation_item',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The prototype's own stable key (`confirm-15min`), so a seed re-run finds its row. */
    code: text('code').notNull(),
    text: text('text').notNull(),
    required: boolean('required').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    uniqueIndex('confirmation_item_branch_code_unique')
      .on(t.branchId, t.code)
      .where(sql`archived_at is null`),
    index('confirmation_item_operator_idx').on(t.operatorId),
  ],
);

/**
 * The drop-off and nanny fees, per branch, weekday and weekend, in satang.
 * Seeded ฿225 flat drop-off, ฿330 an hour for a nanny, ฿300 an extra hour
 * (DISPLAY ONLY — overstay is shown, never billed), unused prepaid food
 * refunded.
 */
export const dropOffPricing = pos.table(
  'drop_off_pricing',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    oneTimeFeeWeekdaySatang: integer('one_time_fee_weekday_satang').notNull(),
    oneTimeFeeWeekendSatang: integer('one_time_fee_weekend_satang').notNull(),
    nannyHourlyWeekdaySatang: integer('nanny_hourly_weekday_satang').notNull(),
    nannyHourlyWeekendSatang: integer('nanny_hourly_weekend_satang').notNull(),
    extraHourWeekdaySatang: integer('extra_hour_weekday_satang').notNull(),
    extraHourWeekendSatang: integer('extra_hour_weekend_satang').notNull(),
    fullDayHours: integer('full_day_hours').notNull().default(8),
    prepaidFoodUnused: text('prepaid_food_unused').$type<PrepaidFoodPolicy>().notNull().default('refund'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('drop_off_pricing_branch_unique').on(t.branchId),
    index('drop_off_pricing_operator_idx').on(t.operatorId),
    check('drop_off_pricing_policy_check', sql`${t.prepaidFoodUnused} in ('refund','forfeit')`),
    check(
      'drop_off_pricing_money_check',
      sql`${t.oneTimeFeeWeekdaySatang} >= 0 and ${t.oneTimeFeeWeekendSatang} >= 0 and ${t.nannyHourlyWeekdaySatang} >= 0 and ${t.nannyHourlyWeekendSatang} >= 0 and ${t.extraHourWeekdaySatang} >= 0 and ${t.extraHourWeekendSatang} >= 0 and ${t.fullDayHours} > 0`,
    ),
  ],
);

// --- The nanny roster (OD-C4) ----------------------------------------------------

/**
 * A nanny the park can assign. The demo seed wrote the first ones; since
 * SCRUM-699 the OTO App's rota feeds them (`source` 'app_schedule', keyed by
 * the app's employee id) and the Console adds one by hand when nobody is
 * rostered ('manual'). A sync never archives or deletes a nanny (D3): a
 * check-in names her for good.
 */
export const nanny = pos.table(
  'nanny',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    employeeId: uuid('employee_id').references(() => employee.id, { onDelete: 'restrict' }),
    source: text('source').$type<NannySource>().notNull().default('manual'),
    /** The OTO App's `employees.id` (varchar there, so text; no FK) — set exactly on 'app_schedule' rows. */
    appEmployeeId: text('app_employee_id'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('nanny_operator_idx').on(t.operatorId),
    index('nanny_branch_idx').on(t.branchId),
    index('nanny_employee_idx').on(t.employeeId),
    uniqueIndex('nanny_branch_app_employee_unique')
      .on(t.branchId, t.appEmployeeId)
      .where(sql`app_employee_id is not null and archived_at is null`),
    check('nanny_source_check', sql`${t.source} in ('seed','app_schedule','manual')`),
    check('nanny_app_employee_check', sql`(${t.source} = 'app_schedule') = (${t.appEmployeeId} is not null)`),
  ],
);

/**
 * On shift = a shift row covering now. The load is derived from in-park
 * assignments. A sync writes and removes only its own 'app_schedule' rows,
 * keyed by the app's assignment id; manual and seed rows belong to people and
 * are never touched by it.
 */
export const nannyShift = pos.table(
  'nanny_shift',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    nannyId: uuid('nanny_id')
      .notNull()
      .references(() => nanny.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    source: text('source').$type<NannySource>().notNull().default('manual'),
    /** The trading day an app or manual shift was written for; null on seed rows and rows tests insert directly. */
    businessDate: date('business_date'),
    /** `otoapp.schedule_assignments.id` — set exactly on 'app_schedule' rows. */
    appAssignmentId: text('app_assignment_id'),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    addedByAccountId: uuid('added_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('nanny_shift_operator_idx').on(t.operatorId),
    index('nanny_shift_nanny_idx').on(t.nannyId, t.startsAt),
    index('nanny_shift_branch_idx').on(t.branchId, t.startsAt),
    uniqueIndex('nanny_shift_app_assignment_unique')
      .on(t.branchId, t.appAssignmentId, t.nannyId)
      .where(sql`app_assignment_id is not null`),
    index('nanny_shift_branch_date_idx').on(t.branchId, t.businessDate),
    index('nanny_shift_added_by_idx').on(t.addedByAccountId),
    check('nanny_shift_span_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('nanny_shift_source_check', sql`${t.source} in ('seed','app_schedule','manual')`),
    check(
      'nanny_shift_app_check',
      sql`(${t.source} = 'app_schedule') = (${t.appAssignmentId} is not null) and (${t.source} <> 'app_schedule' or ${t.businessDate} is not null)`,
    ),
  ],
);

/**
 * The day's nanny sync, one row per branch and trading day (SCRUM-699): when
 * the OTO App's rota was last read, what the read found about the app itself,
 * and whom it could not make a nanny. Its existence is also what tells the
 * morning job the branch is done for the day — the booth's `booth_duty_sync`,
 * per branch rather than per booth.
 */
export const nannySync = pos.table(
  'nanny_sync',
  {
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** `ok`, `app_not_installed`, `no_app_branch` or `ambiguous_app_branch`. */
    appState: text('app_state').notNull(),
    /** `[{ name, reason }]`, reason `no_employee_row`, `no_name` or `casual_worker`. */
    unmatched: jsonb('unmatched').notNull().default([]),
    /** Null for the morning job; the person who pressed "Sync now" otherwise. */
    syncedByAccountId: uuid('synced_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.branchId, t.businessDate] }),
    index('nanny_sync_operator_idx').on(t.operatorId),
    index('nanny_sync_synced_by_idx').on(t.syncedByAccountId),
    check(
      'nanny_sync_app_state_check',
      sql`${t.appState} in ('ok','app_not_installed','no_app_branch','ambiguous_app_branch')`,
    ),
  ],
);

// --- The family-level act (schema `crm`) -------------------------------------------

/**
 * ONE REGISTRATION: a guardian leaving children with the park, with their
 * consent. Siblings left together share it (prototype `registrationId`).
 *
 * `member_id` is null for a walk-in whose guardian gave no number. The
 * guardian's name and number are the registration's own copy, because they
 * are what the counter was told today — the member record may say something
 * else, and a pickup is checked against what was said at drop-off.
 */
export const registration = crm.table(
  'registration',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'restrict' }),
    guardianName: text('guardian_name').notNull(),
    /** E.164 when given. */
    guardianPhone: text('guardian_phone'),
    contactChannel: text('contact_channel').notNull().default('whatsapp'),
    /**
     * SCRUM-857 — when the family confirmed that `guardian_phone` is the number
     * for `contact_channel`, and who gave the tick: the family on their own
     * screen, or staff on the till with the family beside them. Null on a
     * registration taken without the confirmation (a station's offline path,
     * the booking site, a registration from before the field).
     */
    contactConfirmedAt: timestamp('contact_confirmed_at', { withTimezone: true, mode: 'date' }),
    contactConfirmedBy: text('contact_confirmed_by').$type<'family' | 'staff'>(),
    /** When the guardian gave consent; null only on a registration with no supervised child. */
    consentRecordedAt: timestamp('consent_recorded_at', { withTimezone: true, mode: 'date' }),
    /** Each ticked confirmation: its id, its wording at the time, and when. */
    acknowledgedConfirmations: jsonb('acknowledged_confirmations')
      .$type<AcknowledgedConfirmationRow[]>()
      .notNull()
      .default([]),
    source: text('source').$type<RegistrationSource>().notNull().default('till'),
    /** The ONE combined child-and-guardian photo (OD-C2). Owned by this registration. */
    photoFileId: uuid('photo_file_id').references(() => fileObject.id, { onDelete: 'restrict' }),
    /** When the photo and the consent copy may be purged. Set when the last child leaves. */
    retentionUntil: timestamp('retention_until', { withTimezone: true, mode: 'date' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    createdByAccountId: uuid('created_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('registration_operator_idx').on(t.operatorId),
    index('registration_branch_idx').on(t.branchId, t.createdAt),
    index('registration_member_idx').on(t.memberId),
    index('registration_phone_idx').on(t.guardianPhone),
    index('registration_photo_idx').on(t.photoFileId),
    index('registration_station_idx').on(t.stationId),
    index('registration_created_by_idx').on(t.createdByAccountId),
    index('registration_retention_idx').on(t.retentionUntil),
    check('registration_source_check', sql`${t.source} in ('till','board','booking')`),
    check(
      'registration_phone_check',
      sql`${t.guardianPhone} is null or ${t.guardianPhone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    // SCRUM-857 — a confirmation names who gave it, and confirms a number that is there.
    check('registration_contact_confirmed_by_check', sql`${t.contactConfirmedBy} is null or ${t.contactConfirmedBy} in ('family','staff')`),
    check(
      'registration_contact_confirmed_check',
      sql`(${t.contactConfirmedAt} is null) = (${t.contactConfirmedBy} is null) and (${t.contactConfirmedAt} is null or ${t.guardianPhone} is not null)`,
    ),
  ],
);

/**
 * An AUTHORISED COLLECTOR on a registration. The dropper-off is the implicit
 * first entry (the registration's own guardian), so this table holds the
 * others. Never deleted: `revoked_at` takes someone off the list and the
 * audit row says who did (R-91).
 */
export const guardian = crm.table(
  'guardian',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registration.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    relationship: text('relationship'),
    phone: text('phone'),
    photoFileId: uuid('photo_file_id').references(() => fileObject.id, { onDelete: 'restrict' }),
    source: text('source').$type<GuardianSource>().notNull().default('in_person'),
    addedByAccountId: uuid('added_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedByAccountId: uuid('revoked_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('guardian_operator_idx').on(t.operatorId),
    index('guardian_registration_idx').on(t.registrationId),
    index('guardian_photo_idx').on(t.photoFileId),
    index('guardian_added_by_idx').on(t.addedByAccountId),
    index('guardian_revoked_by_idx').on(t.revokedByAccountId),
    check('guardian_source_check', sql`${t.source} in ('in_person','from_chat','on_the_spot')`),
    check('guardian_phone_check', sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
  ],
);

// --- One child's stay (schema `pos`) -----------------------------------------------

/**
 * ONE ROW PER CHILD PER STAY (prototype `CheckIn`).
 *
 * The child's name, age, allergies and food choices are SNAPSHOTS: they are
 * what the guardian told the counter for this stay and what the band printed.
 * `child_id` links the saved record when there is one (a walk-in whose
 * guardian left no number has none).
 *
 * THE ID IS THE TILL'S DROP-OFF CART LINE ID. The till mints the drop-off line
 * for this child under this id, so the sale line the platform writes for it
 * carries `cart_line_id = checkin.id` — which is how finalisation knows to
 * leave this child's band for the check-in choice ("Check in now" mints it,
 * "Leave as booked" does not).
 */
export const checkin = pos.table(
  'checkin',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registration.id, { onDelete: 'restrict' }),
    childId: uuid('child_id').references(() => child.id, { onDelete: 'restrict' }),
    childName: text('child_name').notNull(),
    childAgeYears: integer('child_age_years').notNull(),
    dateOfBirth: date('date_of_birth'),
    allergies: text('allergies'),
    foodRestrictions: text('food_restrictions'),
    mayOrderFood: boolean('may_order_food').notNull().default(false),
    foodProvision: jsonb('food_provision').$type<FoodProvisionRow>(),
    service: text('service').$type<SupervisionService>().notNull(),
    status: text('status').$type<CheckinStatus>().notNull().default('registered'),
    /** "Leave as booked": the booked play-start time, no band, no timer. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    bookedMinutes: integer('booked_minutes'),
    nannyId: uuid('nanny_id').references(() => nanny.id, { onDelete: 'restrict' }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true, mode: 'date' }),
    checkedInByAccountId: uuid('checked_in_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true, mode: 'date' }),
    checkedOutByAccountId: uuid('checked_out_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    bandId: uuid('band_id').references(() => band.id, { onDelete: 'restrict' }),
    visitId: uuid('visit_id').references(() => visit.id, { onDelete: 'restrict' }),
    /** This child's own photo with the guardian, when the counter took one per child. */
    photoFileId: uuid('photo_file_id').references(() => fileObject.id, { onDelete: 'restrict' }),
    /** Written on a box with no internet (round 4). */
    offline: boolean('offline').notNull().default(false),
    /** SCRUM-862 — a waiting booking cancelled by staff: when, by whom, and the reason they gave. */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelledByAccountId: uuid('cancelled_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    cancelReason: text('cancel_reason'),
    ...timestamps,
  },
  (t) => [
    index('checkin_operator_idx').on(t.operatorId),
    index('checkin_branch_status_idx').on(t.branchId, t.status),
    index('checkin_registration_idx').on(t.registrationId),
    index('checkin_child_idx').on(t.childId),
    index('checkin_nanny_idx').on(t.nannyId),
    index('checkin_sale_idx').on(t.saleId),
    index('checkin_band_idx').on(t.bandId),
    index('checkin_visit_idx').on(t.visitId),
    index('checkin_photo_idx').on(t.photoFileId),
    index('checkin_checked_in_by_idx').on(t.checkedInByAccountId),
    index('checkin_checked_out_by_idx').on(t.checkedOutByAccountId),
    index('checkin_scheduled_idx').on(t.branchId, t.scheduledFor),
    index('checkin_cancelled_by_idx').on(t.cancelledByAccountId),
    check('checkin_service_check', sql`${t.service} in ('none','drop_off','nanny')`),
    check('checkin_status_check', sql`${t.status} in ('registered','in_park','out','cancelled')`),
    check('checkin_age_check', sql`${t.childAgeYears} >= 0 and ${t.childAgeYears} <= 17`),
    check('checkin_booked_minutes_check', sql`${t.bookedMinutes} is null or ${t.bookedMinutes} > 0`),
    /** Only a nanny-service child names a nanny. */
    check('checkin_nanny_service_check', sql`${t.nannyId} is null or ${t.service} = 'nanny'`),
    /** In the park means it was checked in, and when. */
    check('checkin_in_park_check', sql`${t.status} in ('registered','cancelled') or ${t.checkedInAt} is not null`),
    /** Cancelled means staff cancelled it, and when. */
    check('checkin_cancelled_check', sql`${t.status} <> 'cancelled' or ${t.cancelledAt} is not null`),
  ],
);

/**
 * A STAFF-ACCEPTED SIBLING WAIVER (OD-C3): a younger child's requirement
 * waived because an older sibling covers them. Offered by the resolver, never
 * auto-applied, and accepted only by signed-in staff holding the permission.
 *
 * `checkin_id` and `registration_id` are nullable on purpose: a waived child
 * drops to a plain ticket and has no stay row of its own, and a family whose
 * every younger child was waived has no registration at all. The child and the
 * sibling are named here either way — the waiver must be readable without the
 * stay it prevented.
 */
export const supervisionWaiver = pos.table(
  'supervision_waiver',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    registrationId: uuid('registration_id').references(() => registration.id, { onDelete: 'restrict' }),
    checkinId: uuid('checkin_id').references(() => checkin.id, { onDelete: 'restrict' }),
    childId: uuid('child_id').references(() => child.id, { onDelete: 'restrict' }),
    childName: text('child_name').notNull(),
    childAgeYears: integer('child_age_years').notNull(),
    waivedRequirement: text('waived_requirement').$type<SupervisionService>().notNull(),
    siblingChildId: uuid('sibling_child_id').references(() => child.id, { onDelete: 'restrict' }),
    siblingName: text('sibling_name').notNull(),
    siblingAgeYears: integer('sibling_age_years').notNull(),
    acceptedByAccountId: uuid('accepted_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('supervision_waiver_operator_idx').on(t.operatorId),
    index('supervision_waiver_branch_idx').on(t.branchId, t.createdAt),
    index('supervision_waiver_registration_idx').on(t.registrationId),
    index('supervision_waiver_checkin_idx').on(t.checkinId),
    index('supervision_waiver_child_idx').on(t.childId),
    index('supervision_waiver_sibling_idx').on(t.siblingChildId),
    index('supervision_waiver_accepted_by_idx').on(t.acceptedByAccountId),
    index('supervision_waiver_station_idx').on(t.stationId),
    check('supervision_waiver_requirement_check', sql`${t.waivedRequirement} in ('drop_off','nanny')`),
  ],
);

/**
 * A CHILD HANDED BACK (round 3 writes it). One per stay. The collector is a
 * listed guardian, or — on the spot — a name and a photo; the verifying staff
 * member and the live pickup photo are always recorded. Unused prepaid food
 * is settled by the branch's policy against the linked sale's refund, or
 * recorded as `refund_no_sale` when there was nothing to refund against.
 */
export const release = pos.table(
  'release',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    checkinId: uuid('checkin_id')
      .notNull()
      .references(() => checkin.id, { onDelete: 'restrict' }),
    guardianId: uuid('guardian_id').references(() => guardian.id, { onDelete: 'restrict' }),
    collectorName: text('collector_name').notNull(),
    verifiedByAccountId: uuid('verified_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    pickupPhotoFileId: uuid('pickup_photo_file_id').references(() => fileObject.id, { onDelete: 'restrict' }),
    offline: boolean('offline').notNull().default(false),
    photoPendingUpload: boolean('photo_pending_upload').notNull().default(false),
    prepaidPolicy: text('prepaid_policy').$type<PrepaidFoodPolicy>(),
    prepaidUnusedSatang: integer('prepaid_unused_satang').notNull().default(0),
    refundId: uuid('refund_id').references(() => refund.id, { onDelete: 'restrict' }),
    refundNoSale: boolean('refund_no_sale').notNull().default(false),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('release_checkin_unique').on(t.checkinId),
    index('release_operator_idx').on(t.operatorId),
    index('release_branch_idx').on(t.branchId, t.createdAt),
    index('release_guardian_idx').on(t.guardianId),
    index('release_verified_by_idx').on(t.verifiedByAccountId),
    index('release_photo_idx').on(t.pickupPhotoFileId),
    index('release_refund_idx').on(t.refundId),
    index('release_station_idx').on(t.stationId),
    check(
      'release_policy_check',
      sql`${t.prepaidPolicy} is null or ${t.prepaidPolicy} in ('refund','forfeit')`,
    ),
    check('release_unused_check', sql`${t.prepaidUnusedSatang} >= 0`),
  ],
);
