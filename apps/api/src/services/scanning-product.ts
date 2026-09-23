import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { product, station, type Db } from '@oto/db';
import {
  PRODUCT_BARCODE_HANDLER,
  productBarcodeHandler,
  type ProductBarcodeMatch,
  type ScanHandlerContext,
  type ScanRouter,
} from '@oto/box-agent';
import { hasVariantBarcode } from './product-variants';

/**
 * A scanned barcode becomes a merch line (S2-09b).
 *
 * `packages/box-agent` decides what a barcode LOOKS like — digits, eight to
 * fourteen of them, which is GS1's answer and not ours — and this file decides
 * what one MEANS, because that is a question only the catalogue can answer.
 * The two halves meet at `ProductBarcodeLookup`, so the box keeps no product
 * table and this service keeps no opinion about scanners.
 *
 * **Where the barcode is stored.** Two places, asked in this order:
 *
 *   1. `pos.product.sku`, the WHOLE item's code — the column migration 0015
 *      gave merch, unique per operator over live rows
 *      (`product_sku_unique … where sku is not null and archived_at is null`).
 *      A merch SKU and the number printed on its label are the same string at
 *      this park, so there is no separate barcode column for the item.
 *   2. `pos.product.variants[].barcode`, the code on ONE SIZE's tag (migration
 *      0020, the owner's decision of 2026-09-24). A scan of it names the item
 *      and the size, so the till adds that size without asking.
 *
 * A barcode names one thing across the operator's live items and sizes: the
 * Merch panel's routes refuse a second holder (`services/product-variants.ts`),
 * and the two lookups below cannot both answer for one code on a catalogue
 * written through them.
 *
 * **Why the lookup is scoped to the station's own operator and branch.** The
 * uniqueness constraint is per OPERATOR, so the same thirteen digits can
 * legitimately name a different product at a different operator — and a second
 * operator on this platform must never be able to put a line on this park's
 * till by printing a label. The scope is read from the station row the scan
 * arrived at rather than passed in, because the caller of a scan is a piece of
 * hardware and the box must not be able to nominate whose catalogue it reads.
 */

/** Whose catalogue a station's scanner reads. */
export interface StationCatalogScope {
  operatorId: string;
  branchId: string;
}

/**
 * The operator and branch behind one station id.
 *
 * Null for a station that is not there: a scan from a station the database does
 * not know resolves to "unknown barcode" rather than throwing, which is the
 * same thing the guest at the counter sees either way and keeps a deleted
 * station from turning every scan into a 500.
 */
export async function stationCatalogScope(
  db: Db,
  stationId: string,
): Promise<StationCatalogScope | null> {
  const [row] = await db
    .select({ operatorId: station.operatorId, branchId: station.branchId })
    .from(station)
    .where(and(eq(station.id, stationId), isNull(station.archivedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The live merch row this barcode names inside one park — and, when the code is
 * on one of its sizes, which size — or null.
 *
 * `kind = 'merch'` is deliberate: an F&B item and a ticket add-on are sold from
 * a grid a person taps, not from a label a scanner reads, and letting a barcode
 * reach them would mean a scanned code could add a plate of food to a shop
 * cart. Withdrawn rows (`archived_at`) are excluded — their code is free for
 * whatever replaced them, which is exactly what the partial unique index
 * allows. A RETIRED but unarchived row (`active = false`) is still returned:
 * the shop screen is where "we stopped selling this" belongs, and answering
 * "unknown barcode" for a product the admin panel still lists is the version of
 * this that wastes somebody's afternoon.
 *
 * The branch clause is the same `or(branch, null)` the menu read uses: an item
 * belongs to one park, and a row with no branch belongs to all of them.
 *
 * The item's own code is asked first. A size's code is asked only when no item
 * answers to the digits whole — and if two rows' sizes both carried them, which
 * the Merch panel refuses but a hand-written row could still do, the older row
 * answers, so the same code never adds a different thing on the next scan.
 */
export async function resolveProductBarcode(
  db: Db,
  scope: StationCatalogScope,
  code: string,
): Promise<ProductBarcodeMatch | null> {
  const columns = {
    id: product.id,
    name: product.name,
    sku: product.sku,
    variants: product.variants,
    priceSatang: product.priceSatang,
    priceWeekendSatang: product.priceWeekendSatang,
    categoryId: product.categoryId,
    branchId: product.branchId,
  };
  const inThisPark = (matches: SQL) =>
    and(
      eq(product.operatorId, scope.operatorId),
      matches,
      eq(product.kind, 'merch'),
      isNull(product.archivedAt),
      or(eq(product.branchId, scope.branchId), isNull(product.branchId)),
    );

  const [whole] = await db
    .select(columns)
    .from(product)
    .where(inThisPark(eq(product.sku, code)))
    .limit(1);
  if (whole) {
    return {
      productId: whole.id,
      name: whole.name,
      // Non-null by the WHERE clause above; the column is nullable for the menu
      // rows that carry no code at all.
      sku: whole.sku ?? code,
      priceSatang: whole.priceSatang,
      priceWeekendSatang: whole.priceWeekendSatang,
      categoryId: whole.categoryId,
      branchId: whole.branchId,
      // The whole item's code names no size. The till asks for one when the
      // item has more than one, exactly as a tap on its tile does.
      variant: null,
    };
  }

  const [sized] = await db
    .select(columns)
    .from(product)
    .where(inThisPark(hasVariantBarcode(code)))
    .orderBy(asc(product.createdAt), asc(product.id))
    .limit(1);
  const size = sized?.variants.find((v) => v.barcode === code);
  if (!sized || !size) return null;
  return {
    productId: sized.id,
    name: sized.name,
    // The code as the catalogue holds it: on this size.
    sku: code,
    priceSatang: sized.priceSatang,
    priceWeekendSatang: sized.priceWeekendSatang,
    categoryId: sized.categoryId,
    branchId: sized.branchId,
    variant: { id: size.id, label: size.label },
  };
}

/** The lookup half of the handler, bound to one database. */
export function productBarcodeLookup(db: Db) {
  return async (ctx: ScanHandlerContext): Promise<ProductBarcodeMatch | null> => {
    const scope = await stationCatalogScope(db, ctx.stationId);
    if (!scope) return null;
    return resolveProductBarcode(db, scope, ctx.code);
  };
}

/**
 * Put the handler on a router, once.
 *
 * Idempotent because the router this is handed may be the agent's own, which
 * outlives the request: `routerFor` in `routes/scanning.ts` returns the
 * agent's router when this process runs that box's agent, and registering on
 * every scan would stack one copy of the handler per scan behind each other,
 * each doing the same query.
 *
 * Registered LAST by construction — `register` is match order and this matcher
 * is the broad one, so a band or a booking handler added later still gets first
 * refusal only if it registers before the first scan. When S2-11 and S2-12
 * arrive their registration belongs above this call for that reason.
 */
export function registerProductBarcodeHandler(router: ScanRouter, db: Db): void {
  if (router.registered().includes(PRODUCT_BARCODE_HANDLER)) return;
  router.register(productBarcodeHandler(productBarcodeLookup(db)));
}
