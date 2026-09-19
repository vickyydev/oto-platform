import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, pos, timestamps } from './helpers';
import { branch, operator } from './tenancy';

// --- The catalogue (schema `pos`) ------------------------------------------
// What the till sells and the rules that price it. It sits with the sales it
// prices rather than with tenancy configuration: a package, its holiday
// calendar and its tax rules are only ever read together, and only by the POS.

// --- Ticket packages -------------------------------------------------------
// Shape follows the prototype's approved pricing model (ARCHITECTURE.md D1),
// not the flat columns sketched in CLAUDE.md §4: per-tier kid prices as
// {weekday, weekend} satang pairs, per-tier adult rules, optional derivation
// rules / freebies / F&B credit rule. The jsonb payloads are validated by zod
// schemas in @oto/shared (catalog-shapes) at the API boundary.

export const ticketPackage = pos.table(
  'ticket_package',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    name: text('name').notNull(),
    description: text('description'),
    /** e.g. "1 Hour", "All Day + Meal" (prototype durationLabel). */
    durationLabel: text('duration_label').notNull(),
    /** Play duration in hours (prototype `hours`; drives later nanny pricing). */
    hours: integer('hours').notNull(),
    /** Record<tierCode, {weekday, weekend}> — satang. */
    prices: jsonb('prices').notNull(),
    /** Record<tierCode, TierPriceRule> — how non-base tiers derive from base. */
    tierPricing: jsonb('tier_pricing'),
    /** Record<tierCode, TierAdultRule> — same_as_kid | set_price | free_adults. */
    adultRules: jsonb('adult_rules'),
    /** TicketFreebie[] — free adults/children/add-ons bundled into the rate. */
    freebies: jsonb('freebies'),
    /** TicketCreditRule — F&B credit give-back (replaces §4 wallet_credit_amount). */
    creditRule: jsonb('credit_rule'),
    /** Wristband gate rights (prototype boolean today; jsonb-ready later). */
    gateAccess: boolean('gate_access').notNull().default(false),
    /** Display-only translations keyed by language. */
    translations: jsonb('translations'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('ticket_package_operator_idx').on(t.operatorId),
    index('ticket_package_branch_idx').on(t.branchId),
    uniqueIndex('ticket_package_name_unique').on(t.branchId, t.name),
  ],
);

/** Named inclusive date range that bills at weekend rates (prototype PricingOverride). */
export const branchHoliday = pos.table(
  'branch_holiday',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    ...timestamps,
    /** Withdrawn rather than deleted (S2-01b): last year's calendar still has
     *  to explain last year's prices. */
    ...archivedAt,
  },
  (t) => [index('branch_holiday_branch_idx').on(t.branchId), index('branch_holiday_dates_idx').on(t.startsOn, t.endsOn)],
);

// --- Tax -------------------------------------------------------------------
// The prototype's accountant-specified engine (ARCHITECTURE.md D3): a named
// rate table + per-taxable-category rules + discount placement, stored as one
// config row per branch. `tax_override` (CLAUDE.md §4) then applies
// product-category / product precedence on top.

export const branchTaxConfig = pos.table(
  'branch_tax_config',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    /** TaxConfig: { rates: TaxRate[], categoryRules: CategoryTaxRule[], discountPlacement }. */
    config: jsonb('config').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('branch_tax_config_unique').on(t.branchId)],
);

export const productCategory = pos.table(
  'product_category',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    name: text('name').notNull(),
    /** Which taxable area this category belongs to ('fnb', 'merch', …). */
    taxableCategory: text('taxable_category').notNull().default('fnb'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [index('product_category_operator_idx').on(t.operatorId)],
);

export const product = pos.table(
  'product',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    categoryId: uuid('category_id').references(() => productCategory.id),
    name: text('name').notNull(),
    /** Satang. */
    priceSatang: integer('price_satang').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('product_operator_idx').on(t.operatorId),
    index('product_branch_idx').on(t.branchId),
    index('product_category_idx').on(t.categoryId),
  ],
);

/**
 * VAT / service-charge override for a product category or a single product.
 * Resolver precedence (SCRUM-37): product > category > branch config rule.
 */
export const taxOverride = pos.table(
  'tax_override',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    categoryId: uuid('category_id').references(() => productCategory.id),
    productId: uuid('product_id').references(() => product.id),
    /** Basis points, e.g. 700 = 7%. Null = keep the resolved value. */
    vatRateBp: integer('vat_rate_bp'),
    serviceChargeBp: integer('service_charge_bp'),
    ...timestamps,
  },
  (t) => [
    index('tax_override_branch_idx').on(t.branchId),
    index('tax_override_category_idx').on(t.categoryId),
    index('tax_override_product_idx').on(t.productId),
  ],
);
