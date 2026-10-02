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
import { analytics, archivedAt, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, station } from './fleet';
import { product } from './catalog';
import { refund, sale, saleLine } from './sales';

// --- Stock (S2-14b, migration 0048) -------------------------------------------
// Plan: docs/progress/plans/stock/PLAN.md §2.1.
//
// The park keeps merchandise, socks and bottled drinks in a few places — the
// store room (bulk), the back of house, and the counter shelf that is the one
// sell point — and the prototype's stock rules are the behaviour
// (`imports/oto-pos/artifacts/oto-till/src/store/catalogStore.ts:1112-1447`,
// `lib/inventory.ts`, `lib/stockUnits.ts`).
//
// THE SHAPE, in one paragraph. `stock_item` is ONE STOCKED SIZE at one branch
// (the prototype's `InventoryVariant`), linked to the sellable it stocks — a
// product and, when the product comes in sizes, which size. `stock_location`
// is a place in the branch. `stock_movement` is the append-only ledger: every
// change to what a place holds is a row there, and `stock_level` is the
// projection of those rows, written ONLY inside the transaction that writes its
// movement (`apps/api/src/services/stock.ts`, `applyMovements`). The level
// always equals the sum of its movements.
//
// THE NEVER-NEGATIVE RULE AND THE OFFLINE PATH. `stock_level.quantity >= 0` is
// a CHECK, with no exception. A sale that has already been paid — a card
// approved after another till sold the last unit, an offline sale replayed on
// reconnect — is never refused, so it records what it could take (the
// movement, down to zero) and the units it could not take as the movement's
// `shortfall` plus a `stock_attention` row. The level floors at zero, the
// ledger still adds up, and the oversell is on the record for a person to
// look at. (The plan's §2.4 allows the level below zero on the offline path;
// this is the stricter reading, chosen so one CHECK holds everywhere.)

/** Where a place in the branch sits in the flow — the prototype's `StockLocationType`. */
export const STOCK_LOCATION_TYPES = ['bulk', 'back_of_house', 'rotation'] as const;
export type StockLocationType = (typeof STOCK_LOCATION_TYPES)[number];

/** What moved stock. The signs are held by `stock_movement_sign_check`. */
export const STOCK_MOVEMENT_KINDS = [
  'sale',
  'refund',
  'receive',
  'transfer_out',
  'transfer_in',
  'adjust',
  'count',
  'offline_sale',
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/** What a stock attention row is about. Round 1 writes the first two. */
export const STOCK_ATTENTION_KINDS = ['stock_shortfall', 'size_unknown', 'low_stock', 'reorder'] as const;
export type StockAttentionKind = (typeof STOCK_ATTENTION_KINDS)[number];

export const STOCK_TAKE_STATUSES = ['open', 'committed'] as const;
export const STOCK_TAKE_LINE_STATUSES = ['pending', 'confirmed', 'adjusted'] as const;
export const PURCHASE_ORDER_STATES = ['to_order', 'ordered', 'received'] as const;
export type PurchaseOrderState = (typeof PURCHASE_ORDER_STATES)[number];

/**
 * ONE STOCKED SIZE AT ONE BRANCH — the Sprint 1 placeholder reshaped.
 *
 * `product_id` + `variant_id` is the link to what the till sells: the product,
 * and — when `product.variants` lists sizes — which size (`variant_id` is the
 * size's id, `s`/`m`/`l`; null for a product sold in one size). At most one
 * live row per branch, product and size (`stock_item_sellable_unique`), so a
 * sale line resolves to exactly one shelf. `product.stock_item_id` stays as
 * the prototype's "set = stock-tracked" marker and is kept in step by the
 * service that writes links.
 *
 * Reorder settings are the prototype's `ReorderSettings` (free-text supplier,
 * as the prototype chose); `par_by_location` is its `parByLocation`
 * (location id → minimum on the shelf).
 */
export const stockItem = pos.table(
  'stock_item',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    /** S2-14b — the branch whose stock pool this is. */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** "Grip Socks" — the item's name; the size's label is `variant_label`. */
    name: text('name').notNull(),
    /** This size's own code, when it has one (`InventoryVariant.sku`). */
    sku: text('sku'),
    payload: jsonb('payload'),
    /** Free text for display and reporting ("Apparel") — not the taxable area. */
    category: text('category'),
    /** False = retired: hidden from staff stock operations, kept for history. */
    active: boolean('active').notNull().default(true),
    productId: uuid('product_id').references((): AnyPgColumn => product.id, { onDelete: 'restrict' }),
    /** The size's id within `product.variants`; null = the product's one size. */
    variantId: text('variant_id'),
    /** The size's label as the stock screens show it ("S"); null on a one-size item. */
    variantLabel: text('variant_label'),
    /** Cost to the park per each, satang. Null = no cost set ("no cost set" in the value report). */
    unitCostSatang: integer('unit_cost_satang'),
    /** At or below this the size is "low" (`lib/inventory.ts:variantStatus`). Null = never low. */
    lowStockThreshold: integer('low_stock_threshold'),
    /** location id → par on that shelf (`InventoryVariant.parByLocation`). */
    parByLocation: jsonb('par_by_location').$type<Record<string, number>>().notNull().default({}),
    reorderPoint: integer('reorder_point'),
    /** In eaches. */
    reorderQuantity: integer('reorder_quantity'),
    leadTimeDays: integer('lead_time_days'),
    supplierName: text('supplier_name'),
    supplierContact: text('supplier_contact'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('stock_item_operator_idx').on(t.operatorId),
    index('stock_item_branch_idx').on(t.branchId),
    index('stock_item_product_idx').on(t.productId),
    /** One live shelf per branch, product and size. */
    uniqueIndex('stock_item_sellable_unique')
      .on(t.branchId, t.productId, sql`coalesce(${t.variantId}, '')`)
      .where(sql`product_id is not null and archived_at is null`),
    check('stock_item_variant_needs_product_check', sql`${t.variantId} is null or ${t.productId} is not null`),
    check('stock_item_unit_cost_check', sql`${t.unitCostSatang} is null or ${t.unitCostSatang} >= 0`),
    check(
      'stock_item_thresholds_check',
      sql`(${t.lowStockThreshold} is null or ${t.lowStockThreshold} >= 0) and (${t.reorderPoint} is null or ${t.reorderPoint} >= 0) and (${t.reorderQuantity} is null or ${t.reorderQuantity} > 0) and (${t.leadTimeDays} is null or ${t.leadTimeDays} >= 0)`,
    ),
    check('stock_item_par_object_check', sql`jsonb_typeof(${t.parByLocation}) = 'object'`),
  ],
);

/**
 * A PACK SIZE — `lib/stockUnits.ts`'s `StockUnit`: "Dozen = 12 eaches",
 * "Case = 24". The base unit is always the each and is implicit. Quantities
 * are stored in whole eaches everywhere; a pack exists only at entry and on
 * screen, and an entry that does not land on a whole each is refused, never
 * rounded (`parsePackQuantity` in `@oto/shared`).
 */
export const stockUnit = pos.table(
  'stock_unit',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItem.id, { onDelete: 'restrict' }),
    /** Stable slug, `dozen`. */
    code: text('code').notNull(),
    /** What staff type and read, `Dozen`. */
    label: text('label').notNull(),
    /** How many eaches one pack holds. An integer above one. */
    eaches: integer('eaches').notNull(),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('stock_unit_operator_idx').on(t.operatorId),
    index('stock_unit_item_idx').on(t.stockItemId),
    uniqueIndex('stock_unit_code_unique').on(t.stockItemId, t.code).where(sql`archived_at is null`),
    check('stock_unit_eaches_check', sql`${t.eaches} >= 2`),
  ],
);

/**
 * A place in the branch. Exactly one ACTIVE `rotation` place per branch is the
 * sell point a sale takes from first (`stock_location_sell_point_unique`), and
 * only a rotation place can be it — the prototype's `setStockLocationSellPoint`
 * guard, held by `stock_location_sell_point_type_check`.
 */
export const stockLocation = pos.table(
  'stock_location',
  {
    id: idPk(),
    /** S2-14b. */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').notNull().references(() => branch.id),
    name: text('name').notNull(),
    type: text('type').$type<StockLocationType>().notNull(),
    sellPoint: boolean('sell_point').notNull().default(false),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('stock_location_branch_idx').on(t.branchId),
    index('stock_location_operator_idx').on(t.operatorId),
    uniqueIndex('stock_location_sell_point_unique')
      .on(t.branchId)
      .where(sql`sell_point and active and archived_at is null`),
    uniqueIndex('stock_location_name_unique')
      .on(t.branchId, sql`lower(${t.name})`)
      .where(sql`archived_at is null`),
    check('stock_location_type_check', sql`${t.type} in ('bulk','back_of_house','rotation')`),
    check('stock_location_sell_point_type_check', sql`not ${t.sellPoint} or ${t.type} = 'rotation'`),
  ],
);

/**
 * WHAT A PLACE HOLDS OF A SIZE — a PROJECTION of `stock_movement`, never
 * written except by the movement writer in the same transaction. Never below
 * zero: see the file header for how a paid oversell is recorded instead.
 */
export const stockLevel = pos.table(
  'stock_level',
  {
    id: idPk(),
    stockLocationId: uuid('stock_location_id').notNull().references(() => stockLocation.id),
    stockItemId: uuid('stock_item_id').notNull().references(() => stockItem.id),
    quantity: integer('quantity').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('stock_level_location_idx').on(t.stockLocationId),
    index('stock_level_item_idx').on(t.stockItemId),
    uniqueIndex('stock_level_location_item_unique').on(t.stockLocationId, t.stockItemId),
    check('stock_level_quantity_check', sql`${t.quantity} >= 0`),
  ],
);

/**
 * A count of a branch's shelves. The OPENING position of a branch (OD-S5) is a
 * stock take with `opening = true` whose lines write the first movements.
 */
export const stockTake = pos.table(
  'stock_take',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('open'),
    /** The counted opening a branch starts from (OD-S5). */
    opening: boolean('opening').notNull().default(false),
    countedByAccountId: uuid('counted_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }),
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    index('stock_take_operator_idx').on(t.operatorId),
    index('stock_take_branch_idx').on(t.branchId, t.createdAt),
    index('stock_take_counted_by_idx').on(t.countedByAccountId),
    check('stock_take_status_check', sql`${t.status} in ('open','committed')`),
  ],
);

/**
 * One counted shelf: expected, counted, the difference, and the flag the
 * prototype raises above a difference of three (`StockTakeFlow.tsx:102`). A
 * count auto-adjusts with the flag and an audit row (OD-S1).
 */
export const stockTakeLine = pos.table(
  'stock_take_line',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    stockTakeId: uuid('stock_take_id')
      .notNull()
      .references(() => stockTake.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItem.id, { onDelete: 'restrict' }),
    stockLocationId: uuid('stock_location_id')
      .notNull()
      .references(() => stockLocation.id, { onDelete: 'restrict' }),
    expectedQuantity: integer('expected_quantity').notNull(),
    countedQuantity: integer('counted_quantity').notNull(),
    /** counted − expected; negative is a shortage. */
    difference: integer('difference').notNull(),
    flagged: boolean('flagged').notNull().default(false),
    status: text('status').notNull().default('pending'),
    countedByAccountId: uuid('counted_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    countedAt: timestamp('counted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    confirmedByAccountId: uuid('confirmed_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('stock_take_line_operator_idx').on(t.operatorId),
    index('stock_take_line_take_idx').on(t.stockTakeId),
    index('stock_take_line_item_idx').on(t.stockItemId),
    index('stock_take_line_location_idx').on(t.stockLocationId),
    index('stock_take_line_counted_by_idx').on(t.countedByAccountId),
    index('stock_take_line_confirmed_by_idx').on(t.confirmedByAccountId),
    uniqueIndex('stock_take_line_unique').on(t.stockTakeId, t.stockItemId, t.stockLocationId),
    check(
      'stock_take_line_quantities_check',
      sql`${t.expectedQuantity} >= 0 and ${t.countedQuantity} >= 0 and ${t.difference} = ${t.countedQuantity} - ${t.expectedQuantity}`,
    ),
    check('stock_take_line_status_check', sql`${t.status} in ('pending','confirmed','adjusted')`),
  ],
);

/**
 * A purchase order to one supplier — the prototype's state machine
 * `to_order → ordered → received`, with where it is received into. One open
 * `to_order` order per supplier and branch (`purchase_order_open_unique`).
 */
export const purchaseOrder = pos.table(
  'purchase_order',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    supplierName: text('supplier_name').notNull(),
    supplierContact: text('supplier_contact'),
    state: text('state').$type<PurchaseOrderState>().notNull().default('to_order'),
    receiveLocationId: uuid('receive_location_id').references(() => stockLocation.id, { onDelete: 'restrict' }),
    createdByAccountId: uuid('created_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    orderedAt: timestamp('ordered_at', { withTimezone: true, mode: 'date' }),
    orderedByAccountId: uuid('ordered_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    expectedArrivalDate: date('expected_arrival_date'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),
    receivedByAccountId: uuid('received_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('purchase_order_operator_idx').on(t.operatorId),
    index('purchase_order_branch_idx').on(t.branchId, t.state),
    index('purchase_order_receive_location_idx').on(t.receiveLocationId),
    index('purchase_order_created_by_idx').on(t.createdByAccountId),
    index('purchase_order_ordered_by_idx').on(t.orderedByAccountId),
    index('purchase_order_received_by_idx').on(t.receivedByAccountId),
    uniqueIndex('purchase_order_open_unique')
      .on(t.branchId, sql`lower(${t.supplierName})`)
      .where(sql`state = 'to_order' and archived_at is null`),
    check('purchase_order_state_check', sql`${t.state} in ('to_order','ordered','received')`),
  ],
);

/** One size on an order. A repeat line merges (`purchase_order_line_unique`). */
export const purchaseOrderLine = pos.table(
  'purchase_order_line',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItem.id, { onDelete: 'restrict' }),
    /** Snapshots, so the order reads the same after a rename. */
    itemName: text('item_name').notNull(),
    variantLabel: text('variant_label'),
    orderedQuantity: integer('ordered_quantity').notNull(),
    receivedQuantity: integer('received_quantity').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('purchase_order_line_operator_idx').on(t.operatorId),
    index('purchase_order_line_order_idx').on(t.purchaseOrderId),
    index('purchase_order_line_item_idx').on(t.stockItemId),
    uniqueIndex('purchase_order_line_unique').on(t.purchaseOrderId, t.stockItemId),
    check(
      'purchase_order_line_quantities_check',
      sql`${t.orderedQuantity} > 0 and ${t.receivedQuantity} >= 0`,
    ),
  ],
);

/**
 * THE LEDGER — append-only (a trigger refuses UPDATE and DELETE).
 *
 * `quantity` is signed, in eaches; `level_after` is the place's level once this
 * row applied, so a reader can walk the history without re-summing it.
 * `action_id` is unique per operator and is the double-count defence: every
 * writer derives it from what it is moving (a sale line, a refund line, a
 * count line), so a replay lands on the row that exists. `shortfall` is the
 * units a paid sale could not take from this place because they were not on
 * record — see the file header.
 */
export const stockMovement = pos.table(
  'stock_movement',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItem.id, { onDelete: 'restrict' }),
    stockLocationId: uuid('stock_location_id')
      .notNull()
      .references(() => stockLocation.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<StockMovementKind>().notNull(),
    quantity: integer('quantity').notNull(),
    levelAfter: integer('level_after').notNull(),
    shortfall: integer('shortfall').notNull().default(0),
    actionId: text('action_id').notNull(),
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    saleLineId: uuid('sale_line_id').references(() => saleLine.id, { onDelete: 'restrict' }),
    refundId: uuid('refund_id').references(() => refund.id, { onDelete: 'restrict' }),
    purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLine.id, {
      onDelete: 'restrict',
    }),
    stockTakeLineId: uuid('stock_take_line_id').references(() => stockTakeLine.id, { onDelete: 'restrict' }),
    /** Pairs a transfer's out and in rows. No table: the pair IS the transfer. */
    transferId: uuid('transfer_id'),
    reason: text('reason'),
    /** The cost per each when it moved, satang — frozen for cost of goods. */
    unitCostSatang: integer('unit_cost_satang'),
    businessDate: date('business_date').notNull(),
    actorAccountId: uuid('actor_account_id').references(() => account.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /** True when the units left the shelf at a counter with no internet. */
    offline: boolean('offline').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_movement_action_unique').on(t.operatorId, t.actionId),
    index('stock_movement_operator_idx').on(t.operatorId),
    index('stock_movement_item_location_idx').on(t.stockItemId, t.stockLocationId),
    index('stock_movement_location_idx').on(t.stockLocationId),
    index('stock_movement_branch_date_idx').on(t.branchId, t.businessDate),
    index('stock_movement_sale_idx').on(t.saleId),
    index('stock_movement_sale_line_idx').on(t.saleLineId),
    index('stock_movement_refund_idx').on(t.refundId),
    index('stock_movement_po_line_idx').on(t.purchaseOrderLineId),
    index('stock_movement_take_line_idx').on(t.stockTakeLineId),
    index('stock_movement_actor_idx').on(t.actorAccountId),
    index('stock_movement_station_idx').on(t.stationId),
    index('stock_movement_box_idx').on(t.boxId),
    check(
      'stock_movement_kind_check',
      sql`${t.kind} in ('sale','refund','receive','transfer_out','transfer_in','adjust','count','offline_sale')`,
    ),
    check(
      'stock_movement_sign_check',
      sql`(${t.kind} not in ('sale','transfer_out','offline_sale') or ${t.quantity} <= 0) and (${t.kind} not in ('refund','receive','transfer_in') or ${t.quantity} >= 0)`,
    ),
    check('stock_movement_nonzero_check', sql`${t.quantity} <> 0 or ${t.shortfall} > 0`),
    check('stock_movement_shortfall_check', sql`${t.shortfall} >= 0 and (${t.shortfall} = 0 or ${t.kind} in ('sale','offline_sale'))`),
    check('stock_movement_level_after_check', sql`${t.levelAfter} >= 0`),
    check('stock_movement_unit_cost_check', sql`${t.unitCostSatang} is null or ${t.unitCostSatang} >= 0`),
  ],
);

/**
 * SOMETHING ABOUT STOCK A PERSON SHOULD LOOK AT — deduped by `dedupe_key`
 * while open. Round 1 raises `stock_shortfall` (a paid sale took more than the
 * record held) and `size_unknown` (a paid sale of a sized item named no size);
 * round 2 adds `low_stock` and `reorder` with the rule that fired.
 */
export const stockAttention = pos.table(
  'stock_attention',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id').references(() => stockItem.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<StockAttentionKind>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    /** Which rule fired, in words ("Below par at Counter", "≤ reorder point"). */
    rule: text('rule'),
    /** The units at issue — the shortfall, the amount below par. */
    quantity: integer('quantity').notNull().default(0),
    summary: text('summary').notNull(),
    detail: jsonb('detail'),
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    saleLineId: uuid('sale_line_id').references(() => saleLine.id, { onDelete: 'restrict' }),
    occurrences: integer('occurrences').notNull().default(1),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolvedByAccountId: uuid('resolved_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('stock_attention_operator_idx').on(t.operatorId),
    index('stock_attention_branch_idx').on(t.branchId, t.resolvedAt),
    index('stock_attention_item_idx').on(t.stockItemId),
    index('stock_attention_sale_idx').on(t.saleId),
    index('stock_attention_sale_line_idx').on(t.saleLineId),
    index('stock_attention_resolved_by_idx').on(t.resolvedByAccountId),
    uniqueIndex('stock_attention_open_unique')
      .on(t.operatorId, t.dedupeKey)
      .where(sql`resolved_at is null`),
    check(
      'stock_attention_kind_check',
      sql`${t.kind} in ('stock_shortfall','size_unknown','low_stock','reorder')`,
    ),
    check('stock_attention_quantity_check', sql`${t.quantity} >= 0`),
  ],
);

/**
 * A DAY OF ONE SIZE AT ONE BRANCH, from the ledger (round 4 writes it). Every
 * figure is in eaches; `transferred` is the units moved between this branch's
 * places that day (gross — within a branch they net to nothing); `value_satang`
 * is closing × unit cost, null when no cost is set.
 *
 * SIGNED, by business date (round 4, migration 0050): every other figure is the
 * signed sum of its kind's movements dated that day, so
 * `opening + sold + refunded + received + adjusted + counted = closing`
 * exactly. Opening and closing may be below zero: a movement that ARRIVES
 * after a later-dated one (yesterday's offline sale synced after today's
 * delivery) leaves its own day short on the record, which is the truth.
 */
export const factStockDaily = analytics.table(
  'fact_stock_daily',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItem.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    opening: integer('opening').notNull().default(0),
    sold: integer('sold').notNull().default(0),
    refunded: integer('refunded').notNull().default(0),
    received: integer('received').notNull().default(0),
    transferred: integer('transferred').notNull().default(0),
    adjusted: integer('adjusted').notNull().default(0),
    counted: integer('counted').notNull().default(0),
    shortfall: integer('shortfall').notNull().default(0),
    closing: integer('closing').notNull().default(0),
    valueSatang: bigint('value_satang', { mode: 'number' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_stock_daily_unique').on(t.branchId, t.stockItemId, t.businessDate),
    index('fact_stock_daily_operator_idx').on(t.operatorId),
    index('fact_stock_daily_item_idx').on(t.stockItemId),
    index('fact_stock_daily_branch_date_idx').on(t.branchId, t.businessDate),
  ],
);
