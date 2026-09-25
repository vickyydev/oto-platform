import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, promo, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { station } from './fleet';
import { member } from './members';
import { product, ticketPackage } from './catalog';
import { sale } from './sales';

// --- Vouchers (schema `promo`) ----------------------------------------------
//
// S2-07a. Two tables, and the line between them is the one that matters: a
// DEFINITION is what a prize is worth and how it behaves, edited by a person
// and shared by every voucher of that kind; a VOUCHER is one piece of paper in
// one family's hand, with a code, an issue time and a life of its own.
//
// Two things are copied onto the voucher at issue rather than read back
// through the definition: what the park pays for it (`cost_satang`) and when
// it lapses (`expires_at`). That is not denormalisation for speed. A voucher
// printed in October under a definition an administrator re-costs in November
// still cost what it cost then: the park handed over a thing at a cost it knew
// at the time, and a report of October's give-away must not move because
// somebody edited a form later.
//
// What a voucher is WORTH at the till is not copied. Its kind, amount,
// percentage, product or package are read from the definition when it is
// redeemed (`resolveVoucherEffect` in `apps/api/src/services/vouchers.ts`), so
// an edit to them applies to every voucher of that type not yet redeemed,
// slips already printed included. That is the owner's decision 3 ("the value
// comes from the voucher type on the server",
// `docs/progress/plans/booth/PLAN.md`), and it is what lets a slip printed
// before its free product or 1+1 package was linked be honoured once the link
// is set.
//
// **Redemption columns are here and empty.** `redeemed_at`,
// `redeemed_by_account_id`, `redeemed_branch_id` and `sale_id` are written by
// S2-10b, not by this ticket. They exist now because the alternative is a
// migration on a table that by then holds every voucher the booth has printed,
// and because a voucher whose redemption cannot be attributed to a person, a
// branch and a sale is exactly the hole the outgoing system has: Radar's
// `/redeem` page stores the time and nothing else (`docs/features/booth.md`).
//
// **ON DELETE is `restrict` throughout**, for the reason `fleet.ts` gives:
// nothing here is ever hard-deleted, and a cascade would take the record of
// who gave away what away with the row somebody deleted.
//
// **What exists as this file lands**: the two tables, the migration, and six
// seeded definitions for the booth's launch prizes. Nothing issues a voucher
// yet — that is the booth box role — and nothing redeems one, which is S2-10b.
//
// **S2-10b (migration 0021) is where they are redeemed.** It adds the hold on
// `promo.voucher` (a till has it on a cart), the station it was redeemed at,
// the append-only `voucher_redemption` ledger and the per-till
// `redemption_throttle`; `apps/api/src/services/vouchers.ts` is the one
// writer of all of it.

/**
 * What the holder gets.
 *
 * `manual` is the hand-over prize: a thing given as it is, with no price on
 * the bill — the prototype's third prize kind, "neither a campaign nor a
 * barcode" (`imports/oto-wheel-fortune/artifacts/spin-win/src/config.ts`). It
 * still needs a voucher, because the park still wants to know it was given
 * away. The family brings the slip to reception, where it is rung up as a ฿0
 * sale carrying the voucher, and the prize is handed over once that sale
 * closes, which is what uses the voucher up (Q2, answer A, of the booth's
 * closing audit: `docs/progress/plans/booth/AUDIT-CLOSING-2026-09-25.md`).
 *
 * Text + CHECK rather than a pg enum (S2-01b), so S2-10b and S2-21 widen the
 * list in one statement instead of taking a DDL lock.
 */
export const VOUCHER_KINDS = [
  'discount',
  'free_item',
  'free_ticket',
  'wallet_credit',
  'manual',
] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];

/** How the value is expressed. `none` is a `manual` prize with no number on it. */
export const VOUCHER_VALUE_TYPES = ['amount', 'percent', 'item', 'none'] as const;
export type VoucherValueType = (typeof VOUCHER_VALUE_TYPES)[number];

/**
 * Whether a till with no internet may accept it.
 *
 * `allow` is the default and the honest one for a booth voucher: it is a
 * printed piece of paper worth a fixed amount, and the worst an offline
 * double-redemption costs is one free ice cream. `refuse` exists for the
 * definitions that will not be so cheap — a wallet top-up, a high-value
 * campaign code — where the right answer offline is "ask the guest to come
 * back" rather than "hope".
 */
export const VOUCHER_OFFLINE_POLICIES = ['allow', 'refuse'] as const;
export type VoucherOfflinePolicy = (typeof VOUCHER_OFFLINE_POLICIES)[number];

export const voucherDefinition = promo.table(
  'voucher_definition',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /**
     * A stable slug — `spin-voucher-100`, `spin-kids-pizza`. It is what a seed,
     * an import and a report name a definition by, so that none of them has to
     * match on a display name somebody may translate or re-word.
     */
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    /** Printed on the voucher beside the English (wheel spec v2 §, booth.md). */
    nameTh: text('name_th'),
    kind: text('kind').$type<VoucherKind>().notNull(),
    valueType: text('value_type').$type<VoucherValueType>().notNull().default('none'),
    /** Satang, for `amount` and `wallet_credit`. Null for the rest. */
    valueSatang: integer('value_satang'),
    /** Basis points, for `percent` — 1500 is 15 %. Integers only (D4). */
    valueBp: integer('value_bp'),
    /** What a `free_item` hands over, when the park stocks it as a product. */
    productId: uuid('product_id').references(() => product.id, { onDelete: 'restrict' }),
    /** What a `free_ticket` admits to. */
    ticketPackageId: uuid('ticket_package_id').references(() => ticketPackage.id, {
      onDelete: 'restrict',
    }),
    /**
     * How long a voucher of this kind lasts, counted from issue. **Null means
     * it never expires**, which is not a placeholder: the legacy Radar codes
     * this table will hold after the S2-10b import never expired and are still
     * being presented at reception (`docs/features/booth.md`).
     */
    expiryDays: integer('expiry_days'),
    offlinePolicy: text('offline_policy')
      .$type<VoucherOfflinePolicy>()
      .notNull()
      .default('allow'),
    singleUse: boolean('single_use').notNull().default(true),
    /**
     * What the park pays when one is redeemed, in satang. Copied onto each
     * voucher at issue. Zero means "not costed yet" rather than "free" — the
     * launch fixture leaves the activity prizes at zero because nobody has put
     * a number on a bracelet workshop, and the prize editor (S2-07b) is where
     * that number is entered.
     */
    costSatang: integer('cost_satang').notNull().default(0),
    /** The small print on the paper. Free text, length-capped by zod at the API. */
    termsEn: text('terms_en'),
    termsTh: text('terms_th'),
    /**
     * The park's own words for the slip (SCRUM-400, migration 0022): the
     * prize's title and the line that tells the family what to do with it, in
     * English and in Thai, printed exactly as typed.
     *
     * Null is "not written yet", and the slip then prints what it printed
     * before this column existed — the prize's own names and the generic
     * "Show this QR at OTO Reception to claim" line — so a definition nobody
     * has worded yet still produces a complete voucher. The words reach a booth
     * inside the published wheel (`voucherDefinitions` in the bundle,
     * `@oto/shared` booth.ts), so a change here is on paper once the booth is
     * published again, and a version records what its slips said.
     */
    titleEn: text('title_en'),
    titleTh: text('title_th'),
    instructionEn: text('instruction_en'),
    instructionTh: text('instruction_th'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('voucher_definition_operator_idx').on(t.operatorId),
    /**
     * The slug is the handle a seed and an import re-run against, so it is
     * unique for the life of the operator rather than only while the
     * definition is live: archiving one must not let a second definition claim
     * a code that vouchers in circulation already point at.
     */
    uniqueIndex('voucher_definition_code_unique').on(t.operatorId, t.code),
    index('voucher_definition_product_idx').on(t.productId),
    index('voucher_definition_package_idx').on(t.ticketPackageId),
    check(
      'voucher_definition_kind_check',
      sql`${t.kind} in ('discount','free_item','free_ticket','wallet_credit','manual')`,
    ),
    check(
      'voucher_definition_value_type_check',
      sql`${t.valueType} in ('amount','percent','item','none')`,
    ),
    check(
      'voucher_definition_offline_policy_check',
      sql`${t.offlinePolicy} in ('allow','refuse')`,
    ),
    check('voucher_definition_value_satang_check', sql`${t.valueSatang} is null or ${t.valueSatang} >= 0`),
    /** A percentage above 100 % is a typo, not a discount. */
    check(
      'voucher_definition_value_bp_check',
      sql`${t.valueBp} is null or (${t.valueBp} >= 0 and ${t.valueBp} <= 10000)`,
    ),
    check('voucher_definition_expiry_days_check', sql`${t.expiryDays} is null or ${t.expiryDays} > 0`),
    check('voucher_definition_cost_check', sql`${t.costSatang} >= 0`),
  ],
);

/**
 * Where a voucher came from.
 *
 * `legacy` is the S2-10b import of Radar's 4-digit ledger and the older
 * `campaign_qrs`, which is why the code CHECK below is deliberately loose.
 */
export const VOUCHER_SOURCES = ['booth', 'legacy', 'manual'] as const;
export type VoucherSource = (typeof VOUCHER_SOURCES)[number];

export const VOUCHER_STATUSES = ['issued', 'redeemed', 'expired', 'void'] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export const voucher = promo.table(
  'voucher',
  {
    /** UUIDv7, minted on the box in the transaction that records the spin. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /** Where it was ISSUED. Where it is redeemed is `redeemed_branch_id`. */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    voucherDefinitionId: uuid('voucher_definition_id')
      .notNull()
      .references(() => voucherDefinition.id, { onDelete: 'restrict' }),
    /**
     * A booth code is a two-character booth prefix plus eight characters of
     * the unambiguous alphabet (D8) — `B1` + 8, ten in all, per
     * `imports/oto-wheel-fortune`'s addendum. It is minted on the box, so a
     * booth with no internet can still print one; the minting itself belongs
     * to the booth box role, and this column is where it lands.
     *
     * The CHECK is a shape, not the alphabet, and that is deliberate: the same
     * table holds the imported legacy codes, which are four digits or four
     * characters beginning with a letter (`docs/features/booth.md`). A CHECK
     * tight enough to describe a booth code would refuse every code the park
     * is still honouring at reception. What stops a collision is the unique
     * index below — the constraint the box's bounded retry is meant to collide
     * against rather than a rule nobody checks.
     */
    code: text('code').notNull(),
    source: text('source').$type<VoucherSource>().notNull().default('booth'),
    status: text('status').$type<VoucherStatus>().notNull().default('issued'),
    /** Captured from the definition at issue. See the note at the top of the file. */
    costSatang: integer('cost_satang').notNull().default(0),
    /**
     * The staff member signed in at the booth when it was issued. **Null is a
     * real and expected value**: the specification is explicit that a login
     * problem must never take the booth down, so a spin with nobody signed in
     * still prints a voucher and the voucher is flagged unattributed. The
     * alert that opens on the first one (`booth.unattributed`) is what makes
     * that visible without blocking a child at the wheel.
     */
    issuedByAccountId: uuid('issued_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Resolved from `voucher_definition.expiry_days` at issue. Null never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    /** Set only where the guest was identified; a mall booth issues to nobody. */
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'restrict' }),
    /**
     * How many times paper has been produced for this code. Incremented beside
     * a `booth.voucher_print` row rather than derived from one, because
     * `edge.print_job` is swept after 90 days and "has this been reprinted"
     * must still be answerable in a year.
     */
    printCount: integer('print_count').notNull().default(0),
    // --- Redemption. Written by S2-10b (`services/vouchers.ts`). -------------
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' }),
    redeemedByAccountId: uuid('redeemed_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    redeemedBranchId: uuid('redeemed_branch_id').references(() => branch.id, {
      onDelete: 'restrict',
    }),
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    /**
     * S2-10b — the till it was redeemed at. The three columns above say who,
     * where and which sale; this says which counter, so "Already redeemed on …
     * at Central Floresta / Reception Till 1 by …" is answerable from the row.
     */
    redeemedStationId: uuid('redeemed_station_id').references(() => station.id, {
      onDelete: 'restrict',
    }),
    // --- The hold (S2-10b). Set while a till has it on a cart. ---------------
    /**
     * The sale a till has put this voucher on, while that sale is being rung
     * up. A voucher is HELD when it is scanned and USED UP when the sale is
     * paid; the hold is what makes a second scan at another till say "in use
     * at …" instead of letting two carts price the same paper.
     *
     * **No foreign key, deliberately.** The id is the one the till minted for
     * its cart, and the `pos.sale` row does not exist until Pay is pressed
     * (`commitSale`), which is after the scan. The redemption service checks
     * the row itself whenever there is one to check.
     */
    heldSaleId: uuid('held_sale_id'),
    /** The till holding it: where "in use at …" points. */
    heldStationId: uuid('held_station_id').references(() => station.id, {
      onDelete: 'restrict',
    }),
    /** Who scanned it onto the cart. */
    heldByAccountId: uuid('held_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** When — the clock a forgotten hold lapses on. */
    heldAt: timestamp('held_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    /**
     * The constraint the whole code scheme rests on, and the one the box's
     * bounded retry (D8) collides against. Per operator, because two operators
     * running booths are two code spaces, and a collision between them is not
     * one.
     */
    uniqueIndex('voucher_code_unique').on(t.operatorId, t.code),
    index('voucher_definition_idx').on(t.voucherDefinitionId),
    index('voucher_branch_issued_idx').on(t.branchId, t.issuedAt),
    index('voucher_operator_status_idx').on(t.operatorId, t.status),
    index('voucher_issued_by_idx').on(t.issuedByAccountId),
    index('voucher_member_idx').on(t.memberId),
    index('voucher_redeemed_by_idx').on(t.redeemedByAccountId),
    index('voucher_redeemed_branch_idx').on(t.redeemedBranchId),
    index('voucher_sale_idx').on(t.saleId),
    index('voucher_redeemed_station_idx').on(t.redeemedStationId),
    /**
     * ONE VOUCHER PER SALE, as a constraint rather than a read (owner, 24
     * Sept: not combinable with another voucher on the same sale). Two tills
     * racing to put two vouchers on one cart cannot both win, whatever the
     * service checked first. Partial, because most vouchers are held by
     * nothing.
     */
    uniqueIndex('voucher_held_sale_unique')
      .on(t.heldSaleId)
      .where(sql`held_sale_id is not null`),
    index('voucher_held_station_idx').on(t.heldStationId),
    index('voucher_held_by_idx').on(t.heldByAccountId),
    /**
     * The expiry sweep, and only vouchers that can still expire: one that never
     * expires, or has already been used, is not what that job is looking for.
     */
    index('voucher_expiring_idx')
      .on(t.expiresAt)
      .where(sql`expires_at is not null and status = 'issued'`),
    check(
      'voucher_source_check',
      sql`${t.source} in ('booth','legacy','manual')`,
    ),
    check(
      'voucher_status_check',
      sql`${t.status} in ('issued','redeemed','expired','void')`,
    ),
    /** Loose on purpose — see the note on `code`. */
    check('voucher_code_shape_check', sql`${t.code} ~ '^[0-9A-Z-]{4,32}$'`),
    check('voucher_cost_check', sql`${t.costSatang} >= 0`),
    check('voucher_print_count_check', sql`${t.printCount} >= 0`),
    check('voucher_expiry_check', sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.issuedAt}`),
    /**
     * A redeemed voucher says when. One-directional on purpose: S2-10b may
     * want to keep the redemption stamps on a voucher later voided for fraud,
     * and a two-way check would make that an impossible state rather than an
     * unusual one.
     */
    check(
      'voucher_redeemed_check',
      sql`${t.status} <> 'redeemed' or ${t.redeemedAt} is not null`,
    ),
    /**
     * A hold is all of its parts or none of them, and only an unused voucher
     * can be held: a redeemed, expired or void one on somebody's cart is a
     * state the service must never be able to write.
     */
    check(
      'voucher_hold_check',
      sql`(${t.heldSaleId} is null and ${t.heldStationId} is null and ${t.heldAt} is null and ${t.heldByAccountId} is null)
          or (${t.heldSaleId} is not null and ${t.heldStationId} is not null and ${t.heldAt} is not null and ${t.status} = 'issued')`,
    ),
  ],
);

// --- Redemption (S2-10b) -----------------------------------------------------

/**
 * What happened to a voucher at a till, one row per fact.
 *
 *   held      scanned onto a cart (`POST /sales/:id/vouchers`).
 *   applied   priced into a sale when Pay was pressed. The sale's discount
 *             row says how much; this says which voucher, so the payment step
 *             can tell a voucher that is still the sale's from one that has
 *             moved on.
 *   consumed  used up, in the transaction that closed the sale. One per
 *             use: the guarded update of `promo.voucher` in the service is
 *             what refuses a second.
 *   released  let go — the line was removed, the sale was voided, or a
 *             forgotten hold lapsed — with the reason beside it.
 */
export const VOUCHER_REDEMPTION_KINDS = ['held', 'applied', 'consumed', 'released'] as const;
export type VoucherRedemptionKind = (typeof VOUCHER_REDEMPTION_KINDS)[number];

/**
 * Why a hold ended without the voucher being used.
 *
 *   line_removed  the till took it off the cart.
 *   sale_voided   the sale it was on was voided (the database trigger in
 *                 migration 0021 writes this one, whatever voided the sale).
 *   moved         the same till put it on a new cart; the old cart was
 *                 abandoned before any money was taken.
 *   lapsed        another till wanted it and the hold was older than the
 *                 lapse window with no money taken against it.
 *   sale_closed   the sale it named was closed without it.
 */
export const VOUCHER_RELEASE_REASONS = [
  'line_removed',
  'sale_voided',
  'moved',
  'lapsed',
  'sale_closed',
] as const;
export type VoucherReleaseReason = (typeof VOUCHER_RELEASE_REASONS)[number];

/**
 * The redemption ledger. **Append-only**: migration 0021 installs a trigger
 * that refuses every UPDATE and DELETE, so the history of a voucher cannot be
 * edited into a different history. `promo.voucher`'s own columns mirror the
 * latest of these facts; this table is how they got there.
 *
 * `sale_id` has no foreign key for the reason `held_sale_id` has none: a
 * `held` row names the till's sale id before Pay has written the sale.
 */
export const voucherRedemption = promo.table(
  'voucher_redemption',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => voucher.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<VoucherRedemptionKind>().notNull(),
    saleId: uuid('sale_id').notNull(),
    /** Where it happened: the till's branch, which may not be where it was issued. */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /** Who. Null only on a release the void trigger wrote for a sale voided by nobody named. */
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    reason: text('reason').$type<VoucherReleaseReason>(),
    /** The request that did it, when a request did. */
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('voucher_redemption_voucher_idx').on(t.voucherId, t.occurredAt),
    index('voucher_redemption_sale_idx').on(t.saleId),
    index('voucher_redemption_operator_idx').on(t.operatorId),
    index('voucher_redemption_branch_idx').on(t.branchId, t.occurredAt),
    index('voucher_redemption_station_idx').on(t.stationId),
    index('voucher_redemption_account_idx').on(t.accountId),
    /**
     * NOT unique on consumed rows, deliberately. "Used up once" is guarded in
     * one place, the conditional update of `promo.voucher` that consumes it
     * (`consumeSaleVouchers`), and a second guard here would only hide that
     * one's absence from the test that exists to catch it. It would also
     * refuse the legitimate second life a refund may give a voucher (S2-11).
     */
    check(
      'voucher_redemption_kind_check',
      sql`${t.kind} in ('held','applied','consumed','released')`,
    ),
    check(
      'voucher_redemption_reason_check',
      sql`(${t.kind} = 'released') = (${t.reason} is not null)
          and (${t.reason} is null or ${t.reason} in ('line_removed','sale_voided','moved','lapsed','sale_closed'))`,
    ),
  ],
);

/**
 * The guessing limit, per till (S2-10b): five wrong codes — invalid, or not
 * found — inside a minute lock that station's voucher redemption for ten
 * minutes and raise `redemption.probing`.
 *
 * In the database rather than in memory for the reason `core.auth_throttle`
 * is: Render restarts the api on every deploy, and a counter that a restart
 * clears is a counter an attacker resets by waiting for one. One row per
 * station; `recent_misses` holds the misses inside the last minute and is
 * cleared when the lock is set, so the budget after a lock is a fresh one.
 */
export const redemptionThrottle = promo.table(
  'redemption_throttle',
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
    recentMisses: timestamp('recent_misses', { withTimezone: true, mode: 'date' })
      .array()
      .notNull()
      .default(sql`'{}'::timestamptz[]`),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    /** How many times this till has been locked, for the alert and for a person reading it later. */
    lockCount: integer('lock_count').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('redemption_throttle_operator_idx').on(t.operatorId),
    index('redemption_throttle_branch_idx').on(t.branchId),
    check('redemption_throttle_lock_count_check', sql`${t.lockCount} >= 0`),
  ],
);
