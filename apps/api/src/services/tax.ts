import { and, eq } from 'drizzle-orm';
import { branchTaxConfig, product, productCategory, taxOverride, type Db } from '@oto/db';
import type { TaxConfigShape } from '@oto/shared';

/**
 * Tax resolver (SCRUM-37). Effective VAT + service charge for a target:
 *   1. Branch default: the branch tax config's rule for the taxable category
 *      (the prototype's per-category engine — rate percent → basis points).
 *   2. Category override: a tax_override row scoped to the product category.
 *   3. Product override: a tax_override row scoped to the product (wins).
 */
export interface ResolvedTax {
  taxableCategory: string;
  taxMode: 'inclusive' | 'exclusive' | 'none';
  vatRateBp: number;
  serviceChargeBp: number;
  source: 'branch' | 'category_override' | 'product_override' | 'default';
}

export async function resolveTax(
  db: Db,
  target: { branchId: string; taxableCategory: string; categoryId?: string; productId?: string },
): Promise<ResolvedTax> {
  let taxableCategory = target.taxableCategory;
  let categoryId = target.categoryId ?? null;

  // A product implies its category (and the category its taxable area).
  //
  // Resolution order is the prototype's `effectiveTaxCategory`
  // (`imports/oto-pos/artifacts/oto-till/src/lib/menu.ts:101-110`): the item's
  // own override, else its category's, else — for a sub-category that leaves
  // the field unset to inherit — its parent's. Where the prototype then falls
  // back to 'fnb', the caller here has already declared a taxable area, so that
  // stands instead.
  let itemOverride: string | null = null;
  if (target.productId) {
    const [p] = await db.select().from(product).where(eq(product.id, target.productId)).limit(1);
    if (p?.categoryId) categoryId = categoryId ?? p.categoryId;
    itemOverride = p?.taxCategoryOverride ?? null;
  }
  if (itemOverride) {
    taxableCategory = itemOverride;
  } else if (categoryId) {
    const [c] = await db
      .select()
      .from(productCategory)
      .where(eq(productCategory.id, categoryId))
      .limit(1);
    if (c?.taxableCategory) {
      taxableCategory = c.taxableCategory;
    } else if (c?.parentId) {
      const [parent] = await db
        .select()
        .from(productCategory)
        .where(eq(productCategory.id, c.parentId))
        .limit(1);
      if (parent?.taxableCategory) taxableCategory = parent.taxableCategory;
    }
  }

  // 1. Branch default from the per-category engine config.
  const [cfgRow] = await db
    .select()
    .from(branchTaxConfig)
    .where(eq(branchTaxConfig.branchId, target.branchId))
    .limit(1);
  let resolved: ResolvedTax = {
    taxableCategory,
    taxMode: 'none',
    vatRateBp: 0,
    serviceChargeBp: 0,
    source: 'default',
  };
  if (cfgRow) {
    const cfg = cfgRow.config as TaxConfigShape;
    const rule = cfg.categoryRules.find((r) => r.category === taxableCategory);
    if (rule) {
      const rate = cfg.rates.find((r) => r.id === rule.taxRateId);
      resolved = {
        taxableCategory,
        taxMode: rule.taxMode,
        vatRateBp: rule.taxMode === 'none' ? 0 : Math.round((rate?.percent ?? 0) * 100),
        serviceChargeBp: Math.round((rule.serviceChargePercent ?? 0) * 100),
        source: 'branch',
      };
    }
  }

  // 2. Category override.
  if (categoryId) {
    const [ov] = await db
      .select()
      .from(taxOverride)
      .where(and(eq(taxOverride.branchId, target.branchId), eq(taxOverride.categoryId, categoryId)))
      .limit(1);
    if (ov) {
      resolved = {
        ...resolved,
        vatRateBp: ov.vatRateBp ?? resolved.vatRateBp,
        serviceChargeBp: ov.serviceChargeBp ?? resolved.serviceChargeBp,
        source: 'category_override',
      };
    }
  }

  // 3. Product override wins.
  if (target.productId) {
    const [ov] = await db
      .select()
      .from(taxOverride)
      .where(and(eq(taxOverride.branchId, target.branchId), eq(taxOverride.productId, target.productId)))
      .limit(1);
    if (ov) {
      resolved = {
        ...resolved,
        vatRateBp: ov.vatRateBp ?? resolved.vatRateBp,
        serviceChargeBp: ov.serviceChargeBp ?? resolved.serviceChargeBp,
        source: 'product_override',
      };
    }
  }

  return resolved;
}
