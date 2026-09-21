import { sql } from 'drizzle-orm';
import {
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
} from 'drizzle-orm/pg-core';
import { archivedAt, booth, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, station } from './fleet';
import { stockItem } from './future';
import { voucher, voucherDefinition } from './promo';

// --- The Lucky Wheel (schema `booth`) ---------------------------------------
//
// S2-07a. A child presses a red button at a mall booth, a wheel spins on a
// television, and a printed voucher brings the family to the park. Six tables,
// arranged around one distinction that the outgoing game does not make at all:
//
//   **what an administrator is editing** — `booth_settings`, `booth_layout`,
//   `booth_prize`, `booth_staff_assignment` — mutable, cloud-authoritative,
//   changed from the Console whenever somebody likes;
//
//   **what a booth was actually running when a child pressed the button** —
//   `booth_config_version`, which is immutable, and which every `spin` points
//   at. Change a weight from 14 % to 30 % and last week's spins still say what
//   the wheel was that day.
//
// The outgoing game has neither half: its six prizes and their odds are
// hard-coded in four places plus Radar, and the outcome is drawn in the
// browser with `Math.random()` (`docs/features/booth.md`). Everything below
// exists so that the odds are configuration, the draw happens on the box, and
// the record of what happened survives the next edit.
//
// **The booth IS a station** (`core.station`, kind `booth`), on a box, with
// devices and a code prefix, exactly like a till. There is no second identity:
// everything that belongs to one booth keys on `station_id`, `booth_settings`
// has it as its primary key, and the Console's booth list is the branch's
// booth-kind stations joined to their settings. (`booth_layout` is the
// exception, and not one: a design is shared between booths and belongs to the
// operator.) A separate `booth` entity would mean two ids for one thing and a
// week of "which id is this".
//
// **Why the settings live here and not on `core.station`.** They are per-booth
// configuration, so `core.station` is where they would naturally hang — beside
// `capabilities` and `payment_routing`, which are just as kind-specific. What
// rules it out is `layout_id`: `core` would then hold a foreign key into
// `booth`, and the schema layering in `helpers.ts` puts `core` underneath
// everything. The settings sit on the booth side of that line instead, with
// the station's id as their key.
//
// **ON DELETE is `restrict` on every key here.** A spin is a business record —
// somebody was given something — and the rule `sync.ts` draws applies: a sweep
// with a number attached to it may delete rows; a side effect of deleting a
// box may not.
//
// **What exists as this file lands.** The tables, the migration and a seeded
// fixture booth — one layout, six prizes and version 1 of the bundle — and
// nothing that reads them: the draw, the code minting, the print queue and the
// Console's prize editor are the rest of S2-07a and S2-07b. Several comments
// below describe how a box will use a column; where they do, they are
// describing the shape the column was given and the reason for it, not
// behaviour that runs today.

/**
 * The wheel's design, separate from what is on it.
 *
 * A layout is the artwork and the geometry — slice palette, label placement,
 * the asset slot — and is reusable across booths and seasons; the prizes are
 * what that wheel is offering this month. Keeping them apart is what makes
 * "seasonal wheel layouts" (S2-07b) a picker rather than a re-entry of six
 * prizes.
 *
 * **No licence-encumbered asset is copied out of `imports/` (D23).** The
 * booth ships an asset SLOT: `asset_manifest` names what a layout wants — a
 * face image, a tick sound, a font — and the booth resolves each name against
 * what has actually been uploaded, falling back to an open-licensed face and
 * silent audio. Thai on the television renders in Noto Sans Thai. Nothing in
 * this column is itself an asset; it is a list of names and where they are
 * expected to come from.
 */
export const boothLayout = booth.table(
  'booth_layout',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Palette, label rules, rotation geometry. Shape validated by zod in
     * `@oto/shared` at the API boundary, as the catalogue jsonb is — held as
     * one document because a layout is applied whole and half a design is not
     * a design.
     */
    design: jsonb('design').notNull().default({}),
    /** See the note above: names and sources, never bytes. */
    assetManifest: jsonb('asset_manifest').notNull().default({}),
    /** Bumped on every edit, so a published bundle can name the design it took. */
    version: integer('version').notNull().default(1),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('booth_layout_operator_idx').on(t.operatorId),
    /** Partial, so archiving a design frees its name for the one replacing it. */
    uniqueIndex('booth_layout_name_unique')
      .on(t.operatorId, t.name)
      .where(sql`archived_at is null`),
    check('booth_layout_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * Who is allowed a spin.
 *
 * `none` is the default and the only mode a mall booth can use: visitors at a
 * shopping centre have no wristband, and the owner's latest instruction is not
 * to collect a phone number on the television (D15, `docs/features/booth.md`
 * open question 1). `band` and `phone` exist because the base specification
 * asks for one spin per band or per phone, and they become usable the day
 * there is a booth inside the park — until then, publishing one is refused
 * with a message (S2-07b), not silently accepted.
 */
export const BOOTH_ELIGIBILITY_MODES = ['none', 'band', 'phone'] as const;
export type BoothEligibilityMode = (typeof BOOTH_ELIGIBILITY_MODES)[number];

/**
 * What an administrator has set for one booth, before any of it is published.
 *
 * Primary key is the station: one booth, one row, and no second identity. A
 * booth with no row is a booth nobody has configured — the reader takes the
 * defaults declared here, which is why `eligibility` and `button_key` are not
 * nullable and `daily_spin_cap` is.
 */
export const boothSettings = booth.table(
  'booth_settings',
  {
    stationId: uuid('station_id')
      .primaryKey()
      .references(() => station.id, { onDelete: 'restrict' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** Null until somebody picks a design; publishing requires one (S2-07b). */
    layoutId: uuid('layout_id').references(() => boothLayout.id, { onDelete: 'restrict' }),
    /**
     * **Nullable and unenforced, deliberately.** Whether one child spinning two
     * hundred times is a problem to cap or the entire point of a marketing
     * booth is the owner's call and has not been made. Nothing in this ticket
     * reads this column; a nullable column costs nothing now and saves a
     * migration on a table full of live booths later. Null is "no cap".
     */
    dailySpinCap: integer('daily_spin_cap'),
    /**
     * The key the red button sends. Configurable because nobody has yet read
     * it off the real booth (`docs/features/booth.md` open question 2), and
     * `Space` is a default rather than an answer.
     *
     * **Never Enter.** The park's USB badge scanner types digits and then
     * Enter, so a booth bound to Enter would spin the wheel every time a staff
     * member scanned their badge. The outgoing game spins on any key and any
     * click, which is the same bug with a wider surface.
     *
     * The CHECK below refuses the exact string `Enter`, which is the value
     * `KeyboardEvent.key` reports for both the main and the numpad return key
     * — so one comparison covers the vocabulary this column holds. It is a
     * backstop under the admin form's own validation, not a substitute for it:
     * a value that is not a `KeyboardEvent.key` at all is the form's to
     * refuse.
     */
    buttonKey: text('button_key').notNull().default('Space'),
    eligibility: text('eligibility')
      .$type<BoothEligibilityMode>()
      .notNull()
      .default('none'),
    ...timestamps,
  },
  (t) => [
    index('booth_settings_operator_idx').on(t.operatorId),
    index('booth_settings_branch_idx').on(t.branchId),
    index('booth_settings_layout_idx').on(t.layoutId),
    check(
      'booth_settings_eligibility_check',
      sql`${t.eligibility} in ('none','band','phone')`,
    ),
    check(
      'booth_settings_daily_spin_cap_check',
      sql`${t.dailySpinCap} is null or ${t.dailySpinCap} > 0`,
    ),
    check('booth_settings_button_key_check', sql`${t.buttonKey} <> 'Enter'`),
  ],
);

/**
 * One slice of one booth's wheel.
 *
 * The row is the prize's IDENTITY — "the 100 baht voucher" — and it outlives
 * every change to its odds. What weight it carried on a given day is in the
 * config version a spin points at; what it is called and what it costs is
 * here. That split is what lets a report say "the bracelet workshop converted
 * best in October" after November's re-weighting.
 *
 * **`weight_bp` is basis points and sums to 10,000 across the active prizes
 * (D4).** Integers, because "the weights must add up to 100" is a rule that
 * has to hold for every list somebody types, not only for a lucky one.
 * Today's launch weights are halves — 23.5 / 27.5 / 17.5 / 14.5 / 14.5 / 2.5 —
 * and halves happen to be exact in binary floating point, so a float version
 * would pass today and go wrong the first time a slice is split three ways
 * (33.33 / 33.33 / 33.34) or nudged by a tenth, because 0.1 + 0.2 is not 0.3.
 * In basis points the same list is 2350 / 2750 / 1750 / 1450 / 1450 / 250,
 * and integer addition is exact whatever anybody types. The database cannot
 * check a sum across rows, so the CHECK here is only the per-row range; the
 * sum is validated with integer arithmetic where a version is published
 * (S2-07b).
 *
 * **Eligibility is renormalised, not zeroed (D5).** The draw happens over the
 * prizes that are active AND under their daily cap AND in stock, with the
 * weights renormalised across that set, computed once per press. A prize that
 * has hit its cap stops being given away; it does not stop the wheel. If
 * nothing at all is eligible the press is refused with "Booth not ready —
 * please call staff" rather than silently drawing something.
 */
export const boothPrize = booth.table(
  'booth_prize',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The booth this prize belongs to. Prize lists are per booth (S2-07b). */
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /**
     * What winning it produces. Nullable so a half-made prize can be saved;
     * publishing a version with a prize that has none is refused with the
     * field named (S2-07b).
     */
    voucherDefinitionId: uuid('voucher_definition_id').references(() => voucherDefinition.id, {
      onDelete: 'restrict',
    }),
    nameEn: text('name_en').notNull(),
    /** The television and the printed voucher both show Thai beside English. */
    nameTh: text('name_th'),
    /**
     * The short text on the slice itself — "100 ฿", "1+1 Kids\nTicket". Null
     * means use `name_en`, which is what a prize nobody has shortened should
     * do rather than overflow the slice.
     */
    wheelLabel: text('wheel_label'),
    weightBp: integer('weight_bp').notNull().default(0),
    active: boolean('active').notNull().default(true),
    /** Overrides the definition's. Null takes the definition's. */
    expiryDays: integer('expiry_days'),
    /** Null is uncapped. A cap is per booth per trading day. */
    dailyCap: integer('daily_cap'),
    /** What the park pays when this one is won, in satang. Zero is "not costed yet". */
    costSatang: integer('cost_satang').notNull().default(0),
    /**
     * A soft link to stock, so an inventory-linked prize leaves the wheel at
     * zero (the v2 addendum). Nullable, and nothing in this ticket decrements
     * it — the stock path arrives in S2-15a.
     */
    stockItemId: uuid('stock_item_id').references(() => stockItem.id, { onDelete: 'restrict' }),
    /** Null takes the layout's palette for this position. */
    sliceColor: text('slice_color'),
    textColor: text('text_color'),
    /** Wheel order. The prototype alternates money and activity prizes on purpose. */
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    /** The prize editor's query, and the one a publish reads. */
    index('booth_prize_station_idx')
      .on(t.stationId)
      .where(sql`archived_at is null`),
    index('booth_prize_operator_idx').on(t.operatorId),
    index('booth_prize_branch_idx').on(t.branchId),
    index('booth_prize_definition_idx').on(t.voucherDefinitionId),
    index('booth_prize_stock_item_idx').on(t.stockItemId),
    /** Two live slices with one name is a mistake nobody can read off the wheel. */
    uniqueIndex('booth_prize_name_unique')
      .on(t.stationId, t.nameEn)
      .where(sql`archived_at is null`),
    check(
      'booth_prize_weight_check',
      sql`${t.weightBp} >= 0 and ${t.weightBp} <= 10000`,
    ),
    check('booth_prize_daily_cap_check', sql`${t.dailyCap} is null or ${t.dailyCap} > 0`),
    check('booth_prize_expiry_days_check', sql`${t.expiryDays} is null or ${t.expiryDays} > 0`),
    check('booth_prize_cost_check', sql`${t.costSatang} >= 0`),
    check('booth_prize_sort_check', sql`${t.sortOrder} >= 0`),
  ],
);

/**
 * A published wheel, frozen.
 *
 * Publishing takes the booth's settings, its layout and its prize list and
 * writes them into `bundle` as one document; the box polls, sees a higher
 * `version`, and applies it **whole or not at all** — half a prize list is a
 * wheel whose odds do not add up.
 *
 * Nothing edits a row here afterwards. That is the point: `spin` points at a
 * version, so "what were the odds when my daughter won" has an answer that
 * cannot be changed by tonight's edit, and the 200-spin distribution check in
 * the `#debug` overlay compares observed frequencies against the weights in
 * the version the booth is actually running rather than against the current
 * draft.
 *
 * The current version of a booth is its highest `version` — there is no
 * `active` flag, because a second source of truth about which one is live is
 * exactly the thing that goes wrong at three in the afternoon.
 */
export const boothConfigVersion = booth.table(
  'booth_config_version',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /** Per booth, 1 upwards. The number Health shows beside the booth. */
    version: integer('version').notNull(),
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => boothLayout.id, { onDelete: 'restrict' }),
    /**
     * The snapshot the box runs: `{ schemaVersion, settings, layout, prizes }`,
     * each field named exactly as its column is. Deliberately the least
     * surprising projection of the rows above, because the agent reads it and
     * the two ends must not need a translation table between them.
     */
    bundle: jsonb('bundle').notNull(),
    /**
     * SHA-256, lower-case hex, over the canonical JSON of `bundle`. The box
     * compares this rather than the document, so an unchanged republish is one
     * string comparison and a corrupted download is caught before it is
     * applied.
     */
    bundleHash: text('bundle_hash').notNull(),
    /** Null for a version created by the seed, which nobody published. */
    publishedByAccountId: uuid('published_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** What changed, in a person's words. Shown in the version history. */
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('booth_config_version_unique').on(t.stationId, t.version),
    /** The version history, and "what is this booth on now". */
    index('booth_config_version_published_idx').on(t.stationId, t.publishedAt),
    index('booth_config_version_operator_idx').on(t.operatorId),
    index('booth_config_version_branch_idx').on(t.branchId),
    index('booth_config_version_layout_idx').on(t.layoutId),
    index('booth_config_version_published_by_idx').on(t.publishedByAccountId),
    check('booth_config_version_number_check', sql`${t.version} > 0`),
    check('booth_config_version_hash_check', sql`${t.bundleHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Who may sign in on a booth.
 *
 * Distinct from `core.station_staff`, which decides who SEES a station in the
 * POS picker. This is a different question with a different answer: a booth is
 * unattended hardware in a mall, and the person at it identifies with a PIN or
 * a badge on the booth's own overlay rather than with a password in the POS.
 * Somebody may well be on this list and have no business picking the booth in
 * the till's station picker, and the reverse.
 *
 * Removal is a plain delete, as on `station_staff`: who was on the list and
 * when is carried by the audit row the service writes, which is where that
 * question gets asked from anyway.
 */
export const boothStaffAssignment = booth.table(
  'booth_staff_assignment',
  {
    id: idPk(),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /** Not nullable: access to a booth is always given by somebody. */
    addedBy: uuid('added_by')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('booth_staff_assignment_unique').on(t.stationId, t.accountId),
    /** "Which booths may this person work?" — the booth's own sign-in check. */
    index('booth_staff_assignment_account_idx').on(t.accountId),
    index('booth_staff_assignment_added_by_idx').on(t.addedBy),
  ],
);

/**
 * What a spin ended in.
 *
 * Two words, because two things can happen: a prize was drawn, or the wheel
 * landed on a slice that gives nothing. The owner's launch list has no losing
 * slice — 2350 + 2750 + 1750 + 1450 + 1450 + 250 is the whole wheel — but a
 * layout may have one, and a spin row that could not say so would be a lie.
 * Widening this list later is one statement (S2-01b).
 */
export const BOOTH_SPIN_OUTCOMES = ['prize', 'no_prize'] as const;
export type BoothSpinOutcome = (typeof BOOTH_SPIN_OUTCOMES)[number];

/**
 * Every press of the button — **not only the wins** (v2 addendum).
 *
 * The row is written on the box BEFORE the wheel animates, which is the order
 * the specification asks for and the one that survives a power cut: a spin
 * that was recorded and not shown is a reconcilable discrepancy, while a prize
 * shown on a television and recorded nowhere is a family at reception with a
 * voucher the park has never heard of.
 *
 * **No `created_at` / `updated_at`.** A spin is an immutable fact with its own
 * two clocks — `occurred_at` as the box stamped it and `received_at` as the
 * cloud took it — exactly like `edge.sync_event`, and a third pair of
 * timestamps would only invite somebody to trust the wrong one.
 */
export const spin = booth.table(
  'spin',
  {
    /** UUIDv7, minted on the box in the transaction that records the press. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** The wheel that was running. Not nullable: a draw without its odds is unexplainable. */
    boothConfigVersionId: uuid('booth_config_version_id')
      .notNull()
      .references(() => boothConfigVersion.id, { onDelete: 'restrict' }),
    outcome: text('outcome').$type<BoothSpinOutcome>().notNull().default('prize'),
    prizeId: uuid('prize_id').references(() => boothPrize.id, { onDelete: 'restrict' }),
    voucherId: uuid('voucher_id').references(() => voucher.id, { onDelete: 'restrict' }),
    /**
     * The staff member signed in at the booth. **Null means unattributed**, a
     * state the specification requires to keep working: a login problem must
     * never take the booth down. The alert is what makes it visible.
     */
    staffAccountId: uuid('staff_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /**
     * The box could not vouch for its own clock when it stamped `occurred_at`
     * — a Pi has no clock battery, and a booth that came up after a mall power
     * cut with no NTP will happily stamp 1970 on a morning's spins. The flag
     * travels with the row so a day's figures that look wrong can be explained
     * from the row itself, the same job `edge.sync_event.clock_trust` does.
     */
    clockSuspect: boolean('clock_suspect').notNull().default(false),
    /**
     * A spin from the `#debug` overlay's "spin 200 times" distribution check,
     * not a child at the wheel.
     *
     * It is a column rather than a separate table because the distribution
     * check has to exercise the real draw — same eligibility, same
     * renormalisation, same code path — or it proves nothing about the thing
     * it is checking. What must not happen is a test run appearing in a
     * report or eating a daily cap, so readers filter on it; the partial index
     * below is for exactly that query.
     */
    simulated: boolean('simulated').notNull().default(false),
    /** When the box says the button was pressed. Never overwritten. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /**
     * The trading day, resolved once from the branch's `business_day_start`
     * (`businessDate` in `@oto/shared`) rather than derived on each read.
     * Daily caps and every booth report count on this column, and a booth that
     * runs past midnight must not split a day's spins across two.
     */
    businessDate: date('business_date').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** `x-oto-action-id`, carried booth -> box -> cloud. */
    actionId: text('action_id'),
    /**
     * The `edge.sync_event` this arrived as. No foreign key, deliberately: the
     * ledger is swept after a year and a spin is not, so the pointer has to
     * outlive what it points at. Same rule as `core.audit_log.source_event_id`.
     */
    sourceEventId: uuid('source_event_id'),
  },
  (t) => [
    /** The booth's own day: the report, and the daily spin count. */
    index('spin_station_date_idx').on(t.stationId, t.businessDate),
    /**
     * The daily cap's question — "how many of this prize has this booth given
     * away today" — with the test runs left out of the index rather than
     * filtered after the read.
     */
    index('spin_prize_date_idx')
      .on(t.prizeId, t.businessDate)
      .where(sql`simulated = false`),
    index('spin_box_occurred_idx').on(t.boxId, t.occurredAt),
    index('spin_branch_date_idx').on(t.branchId, t.businessDate),
    index('spin_operator_idx').on(t.operatorId),
    index('spin_staff_idx').on(t.staffAccountId),
    index('spin_config_version_idx').on(t.boothConfigVersionId),
    index('spin_action_idx').on(t.actionId),
    /**
     * One voucher belongs to one spin. Unique rather than a plain index
     * because the alternative — two spins claiming the same printed code — is
     * a family holding one voucher the park counts twice.
     */
    uniqueIndex('spin_voucher_unique')
      .on(t.voucherId)
      .where(sql`voucher_id is not null`),
    check('spin_outcome_check', sql`${t.outcome} in ('prize','no_prize')`),
    /** A win names what was won. Without this, `outcome` is decoration. */
    check('spin_prize_check', sql`${t.outcome} <> 'prize' or ${t.prizeId} is not null`),
  ],
);

/** Why paper was produced. A reprint is staff-only and never draws a new prize. */
export const VOUCHER_PRINT_REASONS = ['initial', 'reprint'] as const;
export type VoucherPrintReason = (typeof VOUCHER_PRINT_REASONS)[number];

/**
 * One attempt to put one voucher on paper.
 *
 * `edge.print_job` already records every attempt to push bytes at a printer,
 * so this table earns its place on one difference: retention. A print job
 * carries a 90-day retention policy (`PRINT_JOB_RETENTION_DAYS`), because the
 * questions it answers — is the queue stuck, which printer eats paper — are
 * asked within days. "How many times was this voucher printed, and who asked
 * for the second one" is asked when a family turns up at reception with two
 * copies of the same code, and it has to be answerable for as long as the
 * voucher is.
 *
 * `print_job_id` therefore carries **no foreign key**: it points into a table
 * that is swept on a shorter clock than this one, and a restricting key would
 * block that sweep while a cascading one would delete the record of the
 * reprint along with the job. Same rule as `edge.print_job.reprint_of` and
 * `edge.box_command.action_id` — a pointer has to be able to outlive what it
 * points at.
 */
export const voucherPrint = booth.table(
  'voucher_print',
  {
    /** UUIDv7, minted on the box with the print. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /** Null for a reprint raised from the Console rather than at the booth. */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => voucher.id, { onDelete: 'restrict' }),
    /** See the note above: no foreign key, on purpose. */
    printJobId: uuid('print_job_id'),
    reason: text('reason').$type<VoucherPrintReason>().notNull().default('initial'),
    /**
     * Who asked. Null for the automatic first print that follows a spin; a
     * reprint is staff-only, so a `reprint` row with nobody on it is the thing
     * an investigation is looking for.
     */
    requestedByAccountId: uuid('requested_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    actionId: text('action_id'),
  },
  (t) => [
    /** "Show me every copy of this voucher, oldest first." */
    index('voucher_print_voucher_idx').on(t.voucherId, t.queuedAt),
    index('voucher_print_box_idx').on(t.boxId, t.queuedAt),
    index('voucher_print_branch_idx').on(t.branchId, t.queuedAt),
    index('voucher_print_operator_idx').on(t.operatorId),
    index('voucher_print_station_idx').on(t.stationId),
    index('voucher_print_job_idx').on(t.printJobId),
    index('voucher_print_requested_by_idx').on(t.requestedByAccountId),
    index('voucher_print_action_idx').on(t.actionId),
    check('voucher_print_reason_check', sql`${t.reason} in ('initial','reprint')`),
  ],
);
