import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { product, type ProductVariant } from '@oto/db';
import { isProductBarcode } from '@oto/box-agent';
import type { ProductVariant as ProductVariantBody } from '@oto/shared';
import { errors } from '../lib/errors';
import type { Exec } from './tx';

/**
 * An item's sizes — `pos.product.variants`, the owner's decision of 2026-09-24
 * (S2-09b).
 *
 * The column holds a list and the database checks only that it IS a list. The
 * rules below are the ones a list cannot state about itself, held here because
 * the Merch panel's routes are where sizes are written, and because each one
 * can be refused in a sentence the panel's toast can show:
 *
 *   - within one item, no two sizes share an id or a label, and no two carry
 *     the same barcode;
 *   - a size's barcode is digits, eight to fourteen of them — the shape the
 *     box's scanner claims (`isProductBarcode`), so a tag that could never be
 *     read is refused rather than stored;
 *   - across the operator's LIVE items, a barcode names one thing: another
 *     item's own barcode, or a size of any item.
 *
 * The last rule is a question about other rows, asked inside the transaction
 * that writes this one, behind an advisory lock per operator — so two saves
 * racing for one barcode cannot both find it free. Two items' OWN barcodes are
 * the one collision left to the database: `product_sku_unique` already refuses
 * that pair, and is exact where a check here could only be early.
 */

/**
 * The advisory lock namespace for one operator's barcodes. The others in this
 * api: `0x070a` the job runner, `0x070b` the QR invoice number, `0x070e` the
 * virtual box lease.
 */
const BARCODE_LOCK_NAMESPACE = 0x070c;

/** A size as it is stored: trimmed, and with no empty `sku` or `barcode`. */
export function normaliseVariants(input: readonly ProductVariantBody[]): ProductVariant[] {
  return input.map((v) => {
    const sku = v.sku?.trim();
    const barcode = v.barcode?.trim();
    return {
      id: v.id.trim(),
      label: v.label.trim(),
      ...(sku ? { sku } : {}),
      ...(barcode ? { barcode } : {}),
    };
  });
}

/** How a sale line, a receipt and a barcode refusal name one size of an item. */
export function variantLineLabel(itemName: string, variantLabel: string): string {
  return `${itemName} — ${variantLabel}`;
}

/** The labels of an item's sizes, as a person would list them: "S, M, L". */
function labelList(variants: readonly ProductVariant[]): string {
  return variants.map((v) => v.label).join(', ');
}

/**
 * The rules that need only the item itself.
 *
 * `ownSku` is the item's own code — the whole-item barcode — because a size
 * carrying the same digits would make one scan mean two different things.
 */
export function assertVariantsWellFormed(
  itemName: string,
  variants: readonly ProductVariant[],
  ownSku: string | null,
): void {
  const ids = new Set<string>();
  const labels = new Map<string, string>();
  const barcodes = new Map<string, string>();
  for (const v of variants) {
    if (ids.has(v.id)) {
      throw errors.badRequest(`Two sizes of "${itemName}" have the id "${v.id}" — each size needs its own`, {
        field: 'variants',
        variantId: v.id,
      });
    }
    ids.add(v.id);

    const key = v.label.toLocaleLowerCase();
    if (labels.has(key)) {
      throw errors.badRequest(`"${itemName}" has two sizes called "${v.label}"`, {
        field: 'variants',
        label: v.label,
      });
    }
    labels.set(key, v.label);

    if (!v.barcode) continue;
    if (!isProductBarcode(v.barcode)) {
      throw errors.badRequest(
        `The barcode on size "${v.label}" is not one a scanner can read — a barcode is 8 to 14 digits`,
        { field: 'variants', variantId: v.id },
      );
    }
    const twin = barcodes.get(v.barcode);
    if (twin) {
      throw errors.badRequest(
        `Sizes "${twin}" and "${v.label}" of "${itemName}" carry the same barcode, ${v.barcode}`,
        { field: 'variants', barcode: v.barcode },
      );
    }
    barcodes.set(v.barcode, v.label);
    if (ownSku && ownSku === v.barcode) {
      throw errors.badRequest(
        `${v.barcode} is both "${itemName}"'s own barcode and size "${v.label}"'s — a scan has to name one of them`,
        { field: 'variants', barcode: v.barcode },
      );
    }
  }
}

/**
 * "One of this row's sizes carries this barcode" — a containment test the GIN
 * index on `product.variants` answers. The scanner asks it too
 * (`services/scanning-product.ts`), so the rule that refuses a second holder
 * and the lookup that finds the first are the same question.
 */
export function hasVariantBarcode(code: string): SQL {
  return sql`${product.variants} @> ${JSON.stringify([{ barcode: code }])}::jsonb`;
}

/**
 * Refuse a barcode another live item of this operator already answers to.
 *
 * `item.id` is null on a create. `item.variants` and `item.sku` are what the
 * row WILL hold once the write lands — the caller merges a PATCH over the row
 * before asking.
 *
 * Checked: each size's barcode against every other live item's own barcode and
 * sizes; and the item's own barcode against every other live item's sizes. An
 * archived item is ignored, exactly as `product_sku_unique` ignores it —
 * withdrawing an item frees its codes for whatever replaces it.
 */
export async function assertBarcodesFree(
  tx: Exec,
  operatorId: string,
  item: { id: string | null; sku: string | null; variants: readonly ProductVariant[] },
): Promise<void> {
  const sizeCodes = item.variants.map((v) => v.barcode).filter((b): b is string => !!b);
  const ownCode = item.sku?.trim() || null;
  if (sizeCodes.length === 0 && !ownCode) return;

  // One writer of this operator's barcodes at a time, until this transaction
  // ends. Without it two saves that each checked before the other committed
  // would both find the barcode free.
  const key = createHash('sha256').update(operatorId).digest().readInt32BE(0);
  await tx.execute(
    sql`select pg_advisory_xact_lock(${BARCODE_LOCK_NAMESPACE}::int4, ${key}::int4)`,
  );

  const reaches: SQL[] = [];
  if (sizeCodes.length > 0) reaches.push(inArray(product.sku, sizeCodes));
  for (const code of new Set([...sizeCodes, ...(ownCode ? [ownCode] : [])])) {
    reaches.push(hasVariantBarcode(code));
  }
  const others = await tx
    .select({ id: product.id, name: product.name, sku: product.sku, variants: product.variants })
    .from(product)
    .where(
      and(
        eq(product.operatorId, operatorId),
        isNull(product.archivedAt),
        item.id ? ne(product.id, item.id) : undefined,
        or(...reaches),
      ),
    );
  if (others.length === 0) return;

  const refuse = (code: string, holder: string, details: Record<string, unknown>): never => {
    throw errors.conflict(
      'BARCODE_IN_USE',
      `The barcode ${code} is already on "${holder}" — a barcode can name only one thing`,
      { barcode: code, ...details },
    );
  };

  for (const code of sizeCodes) {
    for (const other of others) {
      if (other.sku === code) refuse(code, other.name, { productId: other.id });
      const size = other.variants.find((v) => v.barcode === code);
      if (size) {
        refuse(code, variantLineLabel(other.name, size.label), {
          productId: other.id,
          variantId: size.id,
        });
      }
    }
  }
  if (ownCode) {
    for (const other of others) {
      const size = other.variants.find((v) => v.barcode === ownCode);
      if (size) {
        refuse(ownCode, variantLineLabel(other.name, size.label), {
          productId: other.id,
          variantId: size.id,
        });
      }
    }
  }
}

/**
 * The size a sale line names, checked against the item it names.
 *
 * A size the item does not have is refused and named — never recorded as
 * sent: the size is what a later stock count will take the unit from, and a
 * size nobody defined is a shelf nobody can find.
 *
 * A line that names NO size is refused when the item comes in two sizes or
 * more — the owner's decision of 2026-09-24 — and the refusal names the sizes
 * it does come in. An item in one size, or in none, sells without one exactly
 * as it did before sizes existed, and the answer is null.
 */
export function resolveLineVariant(
  itemName: string,
  variants: readonly ProductVariant[],
  sent: { variantId: string } | null | undefined,
  details: Record<string, unknown>,
): ProductVariant | null {
  if (!sent) {
    if (variants.length < 2) return null;
    throw errors.badRequest(
      `A size has to be chosen before "${itemName}" can be sold — it comes in ${labelList(variants)}`,
      { ...details, required: true },
    );
  }
  const found = variants.find((v) => v.id === sent.variantId);
  if (found) return found;
  throw errors.badRequest(
    variants.length === 0
      ? `"${itemName}" does not come in sizes, so a size cannot be sold on it`
      : `"${itemName}" has no size "${sent.variantId}" — it comes in ${labelList(variants)}`,
    { ...details, variantId: sent.variantId },
  );
}
