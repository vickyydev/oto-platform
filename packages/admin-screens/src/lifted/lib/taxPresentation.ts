import { satangFromBaht, type TaxBreakdown as EngineTaxBreakdown, type TaxConfigShape } from '@oto/shared';
import type { TaxConfig } from '../model/types';
import type { CategoryTaxLineBaht, TaxBreakdownBaht } from './cartWire';

/** Original unit adapters shared by the tax preview and till. */
export const toSatang = (baht: number): number => satangFromBaht(baht);
const toBaht = (satang: number): number => satang / 100;
export function engineTaxConfig(config: TaxConfig): TaxConfigShape { return config as TaxConfigShape; }

/** The original blank-branch template; callers must label it as unsaved. */
export function blankTaxConfig(): TaxConfig {
  return {
    rates: [],
    categoryRules: (['tickets', 'fnb', 'bar', 'drop_off', 'parties', 'addons', 'merch', 'stored_value'] as const)
      .map(category => ({ category, taxMode: 'none', serviceChargePercent: 0, taxOnServiceCharge: false })),
    discountPlacement: 'before_tax',
  };
}

export function breakdownToBaht(breakdown: EngineTaxBreakdown): TaxBreakdownBaht {
  const categories: CategoryTaxLineBaht[] = breakdown.categories.map((category) => ({
    category: category.category,
    base: toBaht(category.base),
    taxMode: category.taxMode,
    ...(category.taxRateId ? { taxRateId: category.taxRateId } : {}),
    ...(category.taxName ? { taxName: category.taxName } : {}),
    taxPercent: category.taxPercent,
    serviceCharge: toBaht(category.serviceCharge),
    tax: toBaht(category.tax),
    ...(category.secondaryTaxRateId ? { secondaryTaxRateId: category.secondaryTaxRateId } : {}),
    ...(category.secondaryTaxName ? { secondaryTaxName: category.secondaryTaxName } : {}),
    secondaryTaxMode: category.secondaryTaxMode,
    secondaryTaxPercent: category.secondaryTaxPercent,
    secondaryTax: toBaht(category.secondaryTax),
    gross: toBaht(category.gross),
  }));
  return {
    netSubtotal: toBaht(breakdown.netSubtotal),
    discountTotal: toBaht(breakdown.discountTotal),
    serviceChargeTotal: toBaht(breakdown.serviceChargeTotal),
    exclusiveTaxTotal: toBaht(breakdown.exclusiveTaxTotal),
    inclusiveTaxTotal: toBaht(breakdown.inclusiveTaxTotal),
    taxTotal: toBaht(breakdown.taxTotal),
    categories,
    grandTotal: toBaht(breakdown.grandTotal),
  };
}
