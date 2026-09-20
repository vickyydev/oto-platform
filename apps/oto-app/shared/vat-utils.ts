// VAT Calculation Utilities for Thailand (7% VAT)
// All prices are stored VAT-inclusive, but we need to display both

export const VAT_RATE = 0.07;
export const VAT_MULTIPLIER = 1 + VAT_RATE; // 1.07

export interface VatBreakdown {
  amountIncVat: number;
  amountExVat: number;
  vatAmount: number;
}

/**
 * Calculate VAT breakdown from a VAT-inclusive amount
 * Uses consistent rounding to 2 decimal places
 */
export function calculateVatFromInclusive(amountIncVat: number): VatBreakdown {
  const amountExVat = Math.round((amountIncVat / VAT_MULTIPLIER) * 100) / 100;
  const vatAmount = Math.round((amountIncVat - amountExVat) * 100) / 100;
  return {
    amountIncVat,
    amountExVat,
    vatAmount,
  };
}

/**
 * Calculate VAT breakdown from a VAT-exclusive amount
 */
export function calculateVatFromExclusive(amountExVat: number): VatBreakdown {
  const vatAmount = Math.round(amountExVat * VAT_RATE * 100) / 100;
  const amountIncVat = Math.round((amountExVat + vatAmount) * 100) / 100;
  return {
    amountIncVat,
    amountExVat,
    vatAmount,
  };
}

export interface LineItemVatCalculation {
  subtotalIncVat: number;
  subtotalExVat: number;
  vatAmount: number;
  referenceValueIncVat: number; // For "included" items, shows what it would cost
}

/**
 * Calculate line item totals with VAT
 * If item is included, actual totals are 0 but reference value is computed
 */
export function calculateLineItemVat(
  qty: number,
  unitPriceIncVat: number,
  isIncluded: boolean
): LineItemVatCalculation {
  const referenceValueIncVat = qty * unitPriceIncVat;
  
  if (isIncluded) {
    return {
      subtotalIncVat: 0,
      subtotalExVat: 0,
      vatAmount: 0,
      referenceValueIncVat,
    };
  }
  
  const { amountExVat, vatAmount } = calculateVatFromInclusive(referenceValueIncVat);
  return {
    subtotalIncVat: referenceValueIncVat,
    subtotalExVat: amountExVat,
    vatAmount,
    referenceValueIncVat,
  };
}

export interface BillingTotals {
  totalIncVat: number;
  totalExVat: number;
  totalVat: number;
  depositAmount: number;
  outstandingAmount: number;
  overpaidAmount: number;
  paymentStatus: 'NOT_PAID' | 'PART_PAID' | 'PAID';
}

/**
 * Calculate billing totals from line items and deposit
 */
export function calculateBillingTotals(
  lineItems: Array<{ qty: number; unitPriceIncVat: number; isIncluded: boolean }>,
  depositAmount: number = 0
): BillingTotals {
  let totalIncVat = 0;
  
  for (const item of lineItems) {
    if (!item.isIncluded) {
      totalIncVat += item.qty * item.unitPriceIncVat;
    }
  }
  
  const { amountExVat: totalExVat, vatAmount: totalVat } = calculateVatFromInclusive(totalIncVat);
  
  const outstanding = Math.max(0, totalIncVat - depositAmount);
  const overpaid = Math.max(0, depositAmount - totalIncVat);
  
  let paymentStatus: 'NOT_PAID' | 'PART_PAID' | 'PAID';
  if (depositAmount <= 0) {
    paymentStatus = 'NOT_PAID';
  } else if (depositAmount >= totalIncVat) {
    paymentStatus = 'PAID';
  } else {
    paymentStatus = 'PART_PAID';
  }
  
  return {
    totalIncVat,
    totalExVat,
    totalVat,
    depositAmount,
    outstandingAmount: outstanding,
    overpaidAmount: overpaid,
    paymentStatus,
  };
}

/**
 * Format currency for display (Thai Baht)
 */
export function formatThb(amount: number): string {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}
