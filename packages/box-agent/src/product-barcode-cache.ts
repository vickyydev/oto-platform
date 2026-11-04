import type { ProductBarcodeLookup, ProductBarcodeMatch } from './scan';

/**
 * A retail barcode, resolved on the box from its own catalogue copy (SCRUM-736).
 *
 * The api resolves a barcode against Postgres (`resolveProductBarcode` in
 * `apps/api/src/services/scanning-product.ts`) and registers that handler on
 * the scanner of the box it runs in-process, the virtual box. A Raspberry Pi
 * has no database, so a barcode its cradle read was claimed by nothing: it
 * classified `unknown`, and the shop screen added nothing, online or offline.
 * A relayed copy could not be resolved upstream either, because a scan crosses
 * the wire as a fingerprint and never as the code.
 *
 * The box already holds what the answer needs. The `catalogue` scope it pulls
 * for offline selling carries the product rows whole (`catalogueCacheItem` in
 * `apps/api/src/services/sync.ts`): this branch's and the operator-wide ones,
 * withdrawn rows left out, each with its `sku` and its sizes'
 * `variants[].barcode`. So this reads that copy and gives the api's answer:
 *
 *   - merch only, for the reason the api gives: a plate of food is sold from a
 *     grid a person taps, never from a label a scanner reads;
 *   - the item's own code first, then a size's code only when no item answers
 *     to the digits whole, the older row answering when two sizes carry the
 *     same code, so one code never adds a different thing on the next scan;
 *   - a retired but listed row (`active = false`) still answers; the shop
 *     screen is where "we stopped selling this" belongs.
 *
 * Null when nothing in the copy sells the code, and when the box holds no copy
 * yet: both read "Unknown barcode" at the till, and a box with no catalogue
 * cannot ring up the sale in any case.
 */
export function resolveCataloguedBarcode(
  payload: Record<string, unknown> | null | undefined,
  code: string,
): ProductBarcodeMatch | null {
  const items = Array.isArray(payload?.items) ? (payload.items as unknown[]) : [];
  const item = record(items[0]);
  if (!item || !Array.isArray(item.products)) return null;
  const merch = item.products
    .map(record)
    .filter((row): row is Record<string, unknown> =>
      !!row && typeof row.id === 'string' && row.kind === 'merch' && !row.archivedAt,
    );

  const whole = merch.find((row) => row.sku === code);
  if (whole) return matchOf(whole, code, null);

  const sized = merch
    .map((row) => ({ row, size: sizes(row).find((v) => v.barcode === code) }))
    .filter((hit): hit is { row: Record<string, unknown>; size: CachedSize } => !!hit.size)
    .sort((a, b) => order(a.row).localeCompare(order(b.row)));
  const first = sized[0];
  return first ? matchOf(first.row, code, { id: first.size.id, label: first.size.label }) : null;
}

/** The lookup half of `productBarcodeHandler`, over whatever reads the box's catalogue copy. */
export function catalogueProductBarcodeLookup(
  readCatalogue: () => Promise<Record<string, unknown> | null>,
): ProductBarcodeLookup {
  return async (ctx) => resolveCataloguedBarcode(await readCatalogue(), ctx.code);
}

interface CachedSize {
  id: string;
  label: string;
  barcode: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sizes(row: Record<string, unknown>): CachedSize[] {
  if (!Array.isArray(row.variants)) return [];
  return row.variants.flatMap((value) => {
    const size = record(value);
    return size && typeof size.id === 'string' && typeof size.barcode === 'string'
      ? [{ id: size.id, label: typeof size.label === 'string' ? size.label : size.id, barcode: size.barcode }]
      : [];
  });
}

/** The api's tie-break, `created_at` then `id`, over the copy's ISO strings. */
function order(row: Record<string, unknown>): string {
  return `${typeof row.createdAt === 'string' ? row.createdAt : ''}|${String(row.id)}`;
}

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function matchOf(
  row: Record<string, unknown>,
  code: string,
  variant: { id: string; label: string } | null,
): ProductBarcodeMatch {
  return {
    productId: String(row.id),
    name: text(row.name) ?? 'Item',
    // The code as the catalogue holds it: the item's own, or the size's.
    sku: variant ? code : (text(row.sku) ?? code),
    priceSatang: int(row.priceSatang) ?? 0,
    priceWeekendSatang: int(row.priceWeekendSatang),
    categoryId: text(row.categoryId),
    branchId: text(row.branchId),
    variant,
  };
}
