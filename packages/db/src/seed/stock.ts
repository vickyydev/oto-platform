/**
 * Stock (S2-14b round 1) — the prototype's places, items and figures (OD-S2),
 * opened by a COUNT (OD-S5).
 *
 * Every figure is the prototype's own seed,
 * `imports/oto-pos/artifacts/oto-till/src/store/catalogStore.ts:491-650`: the
 * three places (Store = bulk, BOH = back of house, FOH = the sell point), and
 * per stocked size what sits in back of house and at the counter, its low-stock
 * threshold, its par at the counter, its unit cost, its pack size and its
 * reorder settings. Nothing starts in bulk, as nothing does there.
 *
 * TWO PLACES THE PROTOTYPE AND THE PLATFORM DIFFER, both stated rather than
 * smoothed over:
 *
 *   - The shop's Grip Socks (`MR-SOCKS`) are sold in S, M and L since the
 *     owner's decision of 2026-09-24; the prototype counts them as one size,
 *     six at the counter (`catalogStore.ts:585`), a figure with no size to put
 *     it on. They take the prototype's own per-size grip-sock figures instead
 *     — S 25, M 40, L 20 (`inv-a-grip-socks`, `:617-621`), the figures the
 *     plan's OD-S2 names for the socks — with that item's thresholds and pars
 *     and the shop item's cost and supplier. The ticket add-on's grip socks
 *     (`AO-GRIPSOCKS`) carry the same figures as their own pool, as in the
 *     prototype, where the two are separate stock.
 *   - The prototype's reorder settings are per item, read against the item's
 *     TOTAL across sizes (`lib/inventory.ts:getReorderAlerts`). A stock item
 *     here is one size, so each size row carries the item's settings; the
 *     reorder rule (round 2) reads them per product, across its sizes.
 *
 * THE OPENING. Each branch starts from a stock take marked `opening` whose
 * lines are the counted figures, and the movements those lines write (`count`)
 * are the first rows of the ledger; each level is written beside its movement,
 * so a level is the sum of its movements from the first row. Older refunds are
 * not replayed (OD-S5).
 *
 * Runs once per branch: a branch that already has a place is left alone.
 */
import { businessDate as tradingDate, newId, parseDayStart, satangFromBaht } from '@oto/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';
import type { ProductVariant } from '../schema/catalog';

const b = satangFromBaht;

interface Reorder {
  point: number;
  leadDays: number;
  supplier: string;
  contact?: string;
  quantity: number;
}

interface SizeSeed {
  /** The product size id; absent for a product sold in one size. */
  variantId?: string;
  boh: number;
  foh: number;
  threshold: number;
  par?: number;
}

interface StockSeed {
  /** The product it stocks, by its seed code (`seed/menu.ts`). */
  productCode: string;
  /** The prototype's inventory item name. */
  name: string;
  sizes: SizeSeed[];
  costBaht?: number;
  pack?: { code: string; label: string; eaches: number };
  reorder?: Reorder;
}

const DOZEN = { code: 'dozen', label: 'Dozen', eaches: 12 };
const CASE24 = { code: 'case', label: 'Case', eaches: 24 };
const MERCH_CO: Omit<Reorder, 'point' | 'quantity'> = { leadDays: 7, supplier: 'Bangkok Merch Co.', contact: '02-555-0100' };
const SOCKS_LTD = { supplier: 'Phuket Socks Ltd.', contact: 'socks@pkt.th' };
const ISLAND_BEV = { leadDays: 2, supplier: 'Island Beverages Co.' };

/** The sizes the seed gives two products, which the prototype counts in sizes (`catalogStore.ts:617`, `:642`). */
export const STOCK_SIZED_PRODUCTS: Record<string, ProductVariant[]> = {
  'AO-GRIPSOCKS': [
    { id: 's', label: 'S' },
    { id: 'm', label: 'M' },
    { id: 'l', label: 'L' },
  ],
  'FB-SLUSHIE': [
    { id: 'red', label: 'Red' },
    { id: 'blue', label: 'Blue' },
    { id: 'green', label: 'Green' },
  ],
};

const STOCK: StockSeed[] = [
  {
    productCode: 'MR-TSHIRT',
    name: 'Oto T-Shirt',
    sizes: [{ boh: 28, foh: 12, threshold: 8, par: 15 }],
    costBaht: 120,
    reorder: { ...MERCH_CO, point: 20, quantity: 48 },
  },
  {
    productCode: 'MR-CAP',
    name: 'Oto Cap',
    sizes: [{ boh: 18, foh: 7, threshold: 6, par: 10 }],
    costBaht: 90,
    reorder: { ...MERCH_CO, point: 15, quantity: 24 },
  },
  {
    productCode: 'MR-SOCKS',
    name: 'Grip Socks (Merch)',
    sizes: [
      { variantId: 's', boh: 18, foh: 7, threshold: 8, par: 10 },
      { variantId: 'm', boh: 28, foh: 12, threshold: 8, par: 15 },
      { variantId: 'l', boh: 14, foh: 6, threshold: 8, par: 10 },
    ],
    costBaht: 35,
    reorder: { ...SOCKS_LTD, leadDays: 5, point: 15, quantity: 120 },
  },
  {
    productCode: 'MR-BOTTLE',
    name: 'Water Bottle',
    sizes: [{ boh: 22, foh: 8, threshold: 8, par: 10 }],
    costBaht: 60,
    reorder: { leadDays: 10, supplier: 'Bottle House TH', point: 20, quantity: 48 },
  },
  { productCode: 'MR-PLUSH', name: 'Oto Mascot Plush', sizes: [{ boh: 14, foh: 4, threshold: 5, par: 8 }], costBaht: 160 },
  {
    productCode: 'MR-STICKERS',
    name: 'Sticker Pack',
    sizes: [{ boh: 60, foh: 20, threshold: 15, par: 25 }],
    costBaht: 12,
    pack: DOZEN,
  },
  {
    productCode: 'MR-KEYRING',
    name: 'Mascot Keyring',
    sizes: [{ boh: 0, foh: 0, threshold: 6, par: 8 }],
    costBaht: 25,
    reorder: { ...SOCKS_LTD, leadDays: 14, point: 5, quantity: 24 },
  },
  { productCode: 'MR-LANYARD', name: 'Old Lanyard (retired)', sizes: [{ boh: 4, foh: 0, threshold: 0 }] },
  {
    productCode: 'AO-SOCKS',
    name: 'Regular Socks',
    sizes: [{ boh: 80, foh: 20, threshold: 20, par: 30 }],
    costBaht: 15,
    pack: DOZEN,
    reorder: { ...SOCKS_LTD, leadDays: 5, point: 50, quantity: 120 },
  },
  {
    productCode: 'AO-GRIPSOCKS',
    name: 'Grip Socks',
    sizes: [
      { variantId: 's', boh: 18, foh: 7, threshold: 8, par: 10 },
      { variantId: 'm', boh: 28, foh: 12, threshold: 8, par: 15 },
      { variantId: 'l', boh: 14, foh: 6, threshold: 8, par: 10 },
    ],
    costBaht: 28,
    pack: DOZEN,
    reorder: { ...SOCKS_LTD, leadDays: 5, point: 30, quantity: 72 },
  },
  { productCode: 'AO-LOCKER', name: 'Locker Rental', sizes: [{ boh: 10, foh: 5, threshold: 3, par: 5 }] },
  { productCode: 'AO-CUP', name: 'Refillable Drink Cup', sizes: [{ boh: 38, foh: 12, threshold: 10, par: 15 }], costBaht: 65 },
  { productCode: 'AO-GLOW', name: 'Glow Band', sizes: [{ boh: 60, foh: 20, threshold: 15, par: 20 }] },
  {
    productCode: 'FB-WATER',
    name: 'Bottled Water',
    sizes: [{ boh: 48, foh: 12, threshold: 12, par: 24 }],
    costBaht: 12,
    pack: CASE24,
    reorder: { ...ISLAND_BEV, point: 30, quantity: 120 },
  },
  {
    productCode: 'FB-SLUSHIE',
    name: 'Slushie',
    sizes: [
      { variantId: 'red', boh: 15, foh: 5, threshold: 5, par: 8 },
      { variantId: 'blue', boh: 12, foh: 3, threshold: 5, par: 8 },
      { variantId: 'green', boh: 2, foh: 2, threshold: 5, par: 8 },
    ],
    costBaht: 35,
    reorder: { ...ISLAND_BEV, point: 10, quantity: 48 },
  },
];

/** Who wrote it, on the record: the deploy's platform sync, not a person (round 4, handover Q3). */
export const PLATFORM_SYNC_ACTOR = 'platform sync';
export const PRODUCT_SIZES_AUDIT_ACTION = 'product.sizes_seeded';

/**
 * THE AUDIT ROW FOR A PRODUCT GIVEN ITS SIZES by the stock setup — a change to
 * what the till sells (the size picker), so it is on the record like every
 * other catalogue write: no account (nobody pressed anything), the platform
 * sync named as the actor, the sizes before (none) and after.
 */
async function auditSizesSeeded(
  tx: Pick<Db, 'insert'>,
  input: { operatorId: string; branchId: string | null; productId: string; code: string; variants: ProductVariant[] },
): Promise<void> {
  await tx.insert(s.auditLog).values({
    id: newId(),
    operatorId: input.operatorId,
    branchId: input.branchId,
    actorAccountId: null,
    requestId: 'platform:sync',
    action: PRODUCT_SIZES_AUDIT_ACTION,
    entityType: 'product',
    entityId: input.productId,
    before: { variants: [] },
    after: { variants: input.variants, code: input.code, by: PLATFORM_SYNC_ACTOR },
  });
}

export interface StockSeedCounts {
  locations: number;
  items: number;
  movements: number;
}

export async function seedStock(
  db: Db,
  scope: { operatorId: string; branchId: string },
): Promise<StockSeedCounts> {
  const { operatorId, branchId } = scope;
  const counts: StockSeedCounts = { locations: 0, items: 0, movements: 0 };

  const codes = STOCK.map((x) => x.productCode);
  const products = await db
    .select({ id: s.product.id, code: s.product.code, variants: s.product.variants, branchId: s.product.branchId })
    .from(s.product)
    .where(and(eq(s.product.operatorId, operatorId), inArray(s.product.code, codes)));
  const byCode = new Map(products.map((p) => [p.code!, p]));

  // The two products the prototype counts in sizes get them — once, on a
  // product that has none yet, so a size a manager has since edited stays.
  for (const [code, variants] of Object.entries(STOCK_SIZED_PRODUCTS)) {
    const row = byCode.get(code);
    if (!row || row.variants.length > 0) continue;
    await db.update(s.product).set({ variants }).where(eq(s.product.id, row.id));
    await auditSizesSeeded(db, { operatorId, branchId: row.branchId, productId: row.id, code, variants });
    row.variants = variants;
  }

  const [existing] = await db
    .select({ id: s.stockLocation.id })
    .from(s.stockLocation)
    .where(eq(s.stockLocation.branchId, branchId))
    .limit(1);
  if (existing) return counts;

  await db.transaction(async (tx) => {
    const [branch] = await tx
      .select({ timezone: s.branch.timezone, businessDayStart: s.branch.businessDayStart })
      .from(s.branch)
      .where(eq(s.branch.id, branchId));
    if (!branch) throw new Error('Stock seed branch not found');

    const store = newId();
    const boh = newId();
    const foh = newId();
    await tx.insert(s.stockLocation).values([
      { id: store, operatorId, branchId, name: 'Store', type: 'bulk' as const },
      { id: boh, operatorId, branchId, name: 'BOH', type: 'back_of_house' as const },
      { id: foh, operatorId, branchId, name: 'FOH', type: 'rotation' as const, sellPoint: true },
    ]);
    counts.locations = 3;

    const now = new Date();
    const businessDate = tradingDate(now, branch.timezone, parseDayStart(branch.businessDayStart));
    const takeId = newId();
    await tx.insert(s.stockTake).values({
      id: takeId,
      operatorId,
      branchId,
      status: 'committed',
      opening: true,
      committedAt: now,
      note: 'Opening count — the prototype’s seed figures (OD-S2, OD-S5)',
    });

    for (const seedItem of STOCK) {
      const productRow = byCode.get(seedItem.productCode);
      if (!productRow) continue;
      const productItems: string[] = [];
      for (const size of seedItem.sizes) {
        const variant = size.variantId ? productRow.variants.find((v) => v.id === size.variantId) : undefined;
        if (size.variantId && !variant) continue;
        const itemId = newId();
        productItems.push(itemId);
        await tx.insert(s.stockItem).values({
          id: itemId,
          operatorId,
          branchId,
          name: seedItem.name,
          productId: productRow.id,
          variantId: size.variantId ?? null,
          variantLabel: variant?.label ?? null,
          unitCostSatang: seedItem.costBaht === undefined ? null : b(seedItem.costBaht),
          lowStockThreshold: size.threshold,
          parByLocation: size.par === undefined ? {} : { [foh]: size.par },
          reorderPoint: seedItem.reorder?.point ?? null,
          reorderQuantity: seedItem.reorder?.quantity ?? null,
          leadTimeDays: seedItem.reorder?.leadDays ?? null,
          supplierName: seedItem.reorder?.supplier ?? null,
          supplierContact: seedItem.reorder?.contact ?? null,
        });
        counts.items += 1;
        if (seedItem.pack) {
          await tx.insert(s.stockUnit).values({ id: newId(), operatorId, stockItemId: itemId, ...seedItem.pack });
        }
        // The opening count: one take line per place, a `count` movement for
        // what is there, and the level written beside it.
        for (const [locationId, counted] of [
          [store, 0],
          [boh, size.boh],
          [foh, size.foh],
        ] as const) {
          const lineId = newId();
          await tx.insert(s.stockTakeLine).values({
            id: lineId,
            operatorId,
            stockTakeId: takeId,
            stockItemId: itemId,
            stockLocationId: locationId,
            expectedQuantity: 0,
            countedQuantity: counted,
            difference: counted,
            flagged: false,
            opening: true,
            status: 'adjusted',
            countedAt: now,
          });
          await tx.insert(s.stockLevel).values({
            id: newId(),
            stockItemId: itemId,
            stockLocationId: locationId,
            quantity: counted,
          });
          if (counted === 0) continue;
          await tx.insert(s.stockMovement).values({
            id: newId(),
            operatorId,
            branchId,
            stockItemId: itemId,
            stockLocationId: locationId,
            kind: 'count',
            quantity: counted,
            levelAfter: counted,
            actionId: `opening:${lineId}`,
            stockTakeLineId: lineId,
            reason: 'Opening count',
            unitCostSatang: seedItem.costBaht === undefined ? null : b(seedItem.costBaht),
            businessDate,
            occurredAt: now,
          });
          counts.movements += 1;
        }
      }
      // The prototype's "set = stock-tracked" marker on the product: its
      // one-size item, else its first size (`services/stock.ts`, setProductStockLinks).
      if (productItems[0]) {
        await tx
          .update(s.product)
          .set({ stockItemId: productItems[0], updatedAt: new Date() })
          .where(eq(s.product.id, productRow.id));
      }
    }
  });
  return counts;
}

export interface StockSetupCounts {
  /** Branches that were given their three places this run. */
  branchesWithPlaces: number;
  /** Branches that were given their stocked items this run. */
  branchesWithItems: number;
  items: number;
}

/**
 * THE DEPLOY'S STOCK SETUP (round 2, handover H4) — run by `platformSync`.
 *
 * Staging's pre-deploy runs migrations plus `platform:sync`, never the full
 * seed (`render.yaml`; the S2-01b rule), so a database that predates 0048 came
 * up with the stock tables and nothing in them: no places, no items, no sizes,
 * no links, and so a till that tracked nothing. This lays down, per live
 * branch, what the seed would have:
 *
 *   - the three places — Store (bulk), BOH (back of house), FOH (the sell
 *     point) — when the branch has NO place at all;
 *   - the stocked items, one row per size, their pack, pars at the sell point,
 *     cost and reorder settings, and the link to the product each stocks — when
 *     the branch has NO stock item at all; the two products the prototype
 *     counts in sizes are given those sizes once, if they have none.
 *
 * And NO OPENING QUANTITIES (OD-S5): the opening is a stock take done in the
 * app by somebody standing at the shelf. Nothing here writes a level or a
 * movement, so every level still starts as the sum of movements.
 *
 * Idempotent by construction: each half acts only on a branch that has none of
 * what it lays down, so a second run, or a park whose manager has since
 * renamed, retired or unlinked anything, is left exactly as it is.
 */
export async function syncStockSetup(db: Db): Promise<StockSetupCounts> {
  const counts: StockSetupCounts = { branchesWithPlaces: 0, branchesWithItems: 0, items: 0 };
  const branches = await db
    .select({ id: s.branch.id, operatorId: s.branch.operatorId })
    .from(s.branch)
    .where(isNull(s.branch.archivedAt));
  for (const br of branches) {
    await db.transaction(async (tx) => {
      // Two deploys racing must not both decide the branch is empty.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock_setup:${br.id}`}))`);
      const [anyPlace] = await tx
        .select({ id: s.stockLocation.id })
        .from(s.stockLocation)
        .where(eq(s.stockLocation.branchId, br.id))
        .limit(1);
      if (!anyPlace) {
        await tx.insert(s.stockLocation).values([
          { id: newId(), operatorId: br.operatorId, branchId: br.id, name: 'Store', type: 'bulk' as const },
          { id: newId(), operatorId: br.operatorId, branchId: br.id, name: 'BOH', type: 'back_of_house' as const },
          { id: newId(), operatorId: br.operatorId, branchId: br.id, name: 'FOH', type: 'rotation' as const, sellPoint: true },
        ]);
        counts.branchesWithPlaces += 1;
      }

      const [anyItem] = await tx
        .select({ id: s.stockItem.id })
        .from(s.stockItem)
        .where(eq(s.stockItem.branchId, br.id))
        .limit(1);
      if (anyItem) return;

      // This branch's products by code — its own first, then any the operator sells everywhere.
      const products = await tx
        .select({ id: s.product.id, code: s.product.code, variants: s.product.variants, branchId: s.product.branchId })
        .from(s.product)
        .where(
          and(
            eq(s.product.operatorId, br.operatorId),
            inArray(
              s.product.code,
              STOCK.map((x) => x.productCode),
            ),
            isNull(s.product.archivedAt),
            or(eq(s.product.branchId, br.id), isNull(s.product.branchId)),
          ),
        );
      const byCode = new Map<string, (typeof products)[number]>();
      for (const p of products) {
        const held = byCode.get(p.code!);
        if (!held || (held.branchId === null && p.branchId === br.id)) byCode.set(p.code!, p);
      }
      if (byCode.size === 0) return;

      for (const [code, variants] of Object.entries(STOCK_SIZED_PRODUCTS)) {
        const row = byCode.get(code);
        if (!row || row.variants.length > 0) continue;
        await tx.update(s.product).set({ variants }).where(eq(s.product.id, row.id));
        // Round 4 (Q3): the size picker changed, so the record says so.
        await auditSizesSeeded(tx, { operatorId: br.operatorId, branchId: row.branchId, productId: row.id, code, variants });
        row.variants = variants;
      }

      const [sellPoint] = await tx
        .select({ id: s.stockLocation.id })
        .from(s.stockLocation)
        .where(
          and(
            eq(s.stockLocation.branchId, br.id),
            eq(s.stockLocation.sellPoint, true),
            eq(s.stockLocation.active, true),
            isNull(s.stockLocation.archivedAt),
          ),
        )
        .limit(1);

      let laid = 0;
      for (const seedItem of STOCK) {
        const productRow = byCode.get(seedItem.productCode);
        if (!productRow) continue;
        const sized = productRow.variants.length > 0;
        const sizes = seedItem.sizes.filter((size) =>
          sized ? !!size.variantId && productRow.variants.some((v) => v.id === size.variantId) : !size.variantId,
        );
        // All of a sized product's sizes or none (H3): a product whose sizes the
        // seed does not name exactly is left untracked for a manager to set up.
        if (sized && sizes.length !== productRow.variants.length) continue;
        if (sizes.length === 0) continue;
        const productItems: string[] = [];
        for (const size of sizes) {
          const variant = size.variantId ? productRow.variants.find((v) => v.id === size.variantId) : undefined;
          const itemId = newId();
          productItems.push(itemId);
          await tx.insert(s.stockItem).values({
            id: itemId,
            operatorId: br.operatorId,
            branchId: br.id,
            name: seedItem.name,
            productId: productRow.id,
            variantId: size.variantId ?? null,
            variantLabel: variant?.label ?? null,
            unitCostSatang: seedItem.costBaht === undefined ? null : b(seedItem.costBaht),
            lowStockThreshold: size.threshold,
            parByLocation: size.par === undefined || !sellPoint ? {} : { [sellPoint.id]: size.par },
            reorderPoint: seedItem.reorder?.point ?? null,
            reorderQuantity: seedItem.reorder?.quantity ?? null,
            leadTimeDays: seedItem.reorder?.leadDays ?? null,
            supplierName: seedItem.reorder?.supplier ?? null,
            supplierContact: seedItem.reorder?.contact ?? null,
          });
          if (seedItem.pack) {
            await tx.insert(s.stockUnit).values({ id: newId(), operatorId: br.operatorId, stockItemId: itemId, ...seedItem.pack });
          }
          laid += 1;
        }
        // The prototype's "set = stock-tracked" marker, as the seed and the link writer keep it.
        await tx
          .update(s.product)
          .set({ stockItemId: productItems[0]!, updatedAt: new Date() })
          .where(eq(s.product.id, productRow.id));
      }
      if (laid > 0) {
        counts.branchesWithItems += 1;
        counts.items += laid;
      }
    });
  }
  return counts;
}
