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
import { member } from './members';
import { product, ticketPackage } from './catalog';
import { sale } from './future';

// --- Vouchers (schema `promo`) ----------------------------------------------
//
// S2-07a. Two tables, and the line between them is the one that matters: a
// DEFINITION is what a prize is worth and how it behaves, edited by a person
// and shared by every voucher of that kind; a VOUCHER is one piece of paper in
// one family's hand, with a code, an issue time and a life of its own.
//
// Everything that decides value is copied onto the voucher at issue —
// `cost_satang`, `expires_at` — rather than read back through the definition.
// That is not denormalisation for speed. A voucher printed in October under a
// definition an administrator re-costs in November is still worth what the
// paper says: the park handed over a thing at a cost it knew at the time, and
// a report of October's give-away must not move because somebody edited a form
// later. The definition is the template; the voucher is the fact.
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

/**
 * What the holder gets.
 *
 * `manual` is the booth prize handed over at the stand with nothing to ring up
 * — the prototype's third prize kind, "neither a campaign nor a barcode"
 * (`imports/oto-wheel-fortune/artifacts/spin-win/src/config.ts`). It still
 * needs a voucher, because the park still wants to know it was given away.
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
    // --- Redemption. Written by S2-10b; empty until then. --------------------
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' }),
    redeemedByAccountId: uuid('redeemed_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    redeemedBranchId: uuid('redeemed_branch_id').references(() => branch.id, {
      onDelete: 'restrict',
    }),
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
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
  ],
);
