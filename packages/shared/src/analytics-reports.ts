import { z } from 'zod';
import { AnalyticsSummaryQuerySchema, type AnalyticsSaleKind } from './analytics';
import type { Satang } from './money';
import { summarizeTax, type TaxBreakdown } from './tax';

/**
 * S2-15b (SCRUM-216) rounds 4 and 5 — THE REPORTS PANELS AND THE BOOTH REPORT,
 * READ FROM THE PLATFORM (plan docs/progress/plans/analytics/PLAN.md §3, §7,
 * §8 rounds 4-5).
 *
 * Admin > Reports (Sales, Profitability, Discounts & Comps, Tax & VAT) are the
 * prototype's panels (`components/admin/reports/*`, `lib/reporting.ts`), with
 * their look, words and columns. Only where the figures come from moved: the
 * browser's own copy of the mock sales became the platform's daily report
 * rows, written by the rollup (`apps/api/src/services/analytics-reports.ts`)
 * from the sales ledger, and two per-transaction lists read through a
 * date-bounded report query (plan question 13).
 *
 * The prototype's rules are kept as they are — each one is named where it is
 * applied below — with the plan's §4 data-reliability fixes: a sale's day is
 * its business date at its branch, only finalised and refunded sales count,
 * and participants are counted once per cart line.
 *
 * Money is satang throughout. The field names are `lib/reporting.ts`'s, so the
 * panels read the platform's answer as they read the mock.
 */

// --- The per-day aggregation (written by the rollup) ------------------------------------

/** One category row of a sale's stored tax breakdown (`TaxBreakdown.categories`). */
export interface ReportCategoryFacts {
  category: string;
  base: Satang;
  gross: Satang;
  tax: Satang;
  secondaryTax: Satang;
  taxMode: string;
  secondaryTaxMode: string;
  serviceCharge: Satang;
}

/** One tender taken on a sale, by its code (`payment_attempt.method_code`, else its method). */
export interface ReportTenderFacts {
  code: string;
  method: string;
  takenSatang: Satang;
}

/** One cart line of a sale, as the ticket side of the Sales panel reads it. */
export interface ReportCartLineFacts {
  cartLineId: string;
  /** The ticket package the line was sold under; null for a line that is not a ticket. */
  packageId: string | null;
  packageName: string | null;
  kids: number;
  adults: number;
  /** The play hours recorded on the line at sale time. */
  hours: number | null;
  /** List price before discounts of the line's ticket units: tickets, socks, add-ons. */
  ticketBaseSatang: Satang;
  /** List price before discounts of the line's drop-off / nanny service fee. */
  feeBaseSatang: Satang;
  /** A child's stay: the line carries the service fee or is a check-in's own line. */
  stay: boolean;
  /** The stay's supervision, from its check-in; null when it has none (yet). */
  service: 'drop_off' | 'nanny' | 'none' | null;
  /** A free-item promo's own line (the prototype's `promoItem` stub). */
  promo: boolean;
}

/** One F&B or shop item line. */
export interface ReportItemFacts {
  kind: 'fnb' | 'merch';
  productId: string | null;
  label: string;
  quantity: number;
  /** List price before discounts (`lineTotal`). */
  revenueSatang: Satang;
  /** Cost of the units whose cost is known. */
  costSatang: Satang;
  costUntrackedQuantity: number;
}

/** One discount row of a sale (`pos.sale_discount`). */
export interface ReportDiscountFacts {
  kind: 'manual' | 'promo';
  type: string;
  /** A voucher's code is already masked (`…47WP`). */
  code: string | null;
  label: string | null;
  reason: string | null;
  amountSatang: Satang;
  appliedByAccountId: string | null;
  appliedByName: string | null;
}

/** One finalised or refunded sale of the branch-day, as the report rollup reads it. */
export interface ReportSaleFacts {
  saleId: string;
  kind: AnalyticsSaleKind;
  tier: string;
  /** What the guest paid (`TaxBreakdown.grandTotal`). */
  grossSatang: Satang;
  categories: ReportCategoryFacts[];
  tenders: ReportTenderFacts[];
  /** Every refund slice of the sale, by the tender it went back through. */
  refundSlices: Array<{ code: string; amountSatang: Satang }>;
  cartLines: ReportCartLineFacts[];
  items: ReportItemFacts[];
  discounts: ReportDiscountFacts[];
}

export interface ReportCategoryRow {
  key: string;
  grossSatang: Satang;
  netSatang: Satang;
  taxSatang: Satang;
  taxInclusiveSatang: Satang;
  taxExclusiveSatang: Satang;
  serviceSatang: Satang;
  txnCount: number;
}

export interface ReportTenderRow {
  key: string;
  method: string;
  /** The payment mix's figure, the prototype's rule applied sale by sale (`reportPaymentBumps`). */
  amountSatang: Satang;
  /** Refund slices that went back through this tender, whatever the sale. Kept for the record. */
  refundedSatang: Satang;
  /** Sales that added a non-zero amount. */
  txnCount: number;
}

export type ReportTicketKind = 'tier' | 'ticket_type' | 'service';

export interface ReportTicketRow {
  kind: ReportTicketKind;
  key: string;
  label: string;
  saleCount: number;
  lineCount: number;
  kids: number;
  adults: number;
  hours: number;
  revenueSatang: Satang;
  dropoffSatang: Satang;
}

export interface ReportItemRow {
  key: string;
  kind: 'fnb' | 'merch';
  label: string;
  quantity: number;
  revenueSatang: Satang;
  costSatang: Satang;
  costUntrackedQuantity: number;
}

export interface ReportDiscountRow {
  key: string;
  kind: 'manual' | 'promo';
  discountType: string;
  code: string | null;
  reason: string | null;
  label: string | null;
  appliedByAccountId: string | null;
  appliedByName: string | null;
  amountSatang: Satang;
  useCount: number;
}

export interface ReportDay {
  categories: ReportCategoryRow[];
  tenders: ReportTenderRow[];
  tickets: ReportTicketRow[];
  items: ReportItemRow[];
  discounts: ReportDiscountRow[];
}

/**
 * What one sale adds to the payment mix, by tender: `paymentMix` in the
 * prototype. A ticket sale puts what it took, net of its refunds, under its
 * tender (`netAfterRefunds`); an F&B or shop order puts each tender's amount
 * as taken, credit included, with no refund netting. A zero or negative
 * amount adds nothing and is not counted. The prototype's ticket sale had one
 * tender; a platform sale may be split, so each tender is netted of the
 * refund slices that went back through it.
 */
export function reportPaymentBumps(sale: Pick<ReportSaleFacts, 'kind' | 'tenders' | 'refundSlices'>): Map<string, { method: string; amountSatang: Satang }> {
  const taken = new Map<string, { method: string; amountSatang: Satang }>();
  for (const t of sale.tenders) {
    const held = taken.get(t.code) ?? { method: t.method, amountSatang: 0 };
    held.amountSatang += t.takenSatang;
    taken.set(t.code, held);
  }
  const refunded = new Map<string, Satang>();
  for (const r of sale.refundSlices) refunded.set(r.code, (refunded.get(r.code) ?? 0) + r.amountSatang);
  const out = new Map<string, { method: string; amountSatang: Satang }>();
  for (const [code, t] of taken) {
    const amount = sale.kind === 'ticket' ? Math.max(0, t.amountSatang - (refunded.get(code) ?? 0)) : t.amountSatang;
    if (amount > 0) out.set(code, { method: t.method, amountSatang: amount });
  }
  return out;
}

/** The drop-off category's gross on a sale's breakdown (`ticketSalesByTier`). */
export function reportDropOffGross(categories: readonly ReportCategoryFacts[]): Satang {
  return categories.filter((c) => c.category === 'drop_off').reduce((sum, c) => sum + c.gross, 0);
}

function bumpRow<T>(map: Map<string, T>, key: string, fresh: () => T): T {
  let row = map.get(key);
  if (!row) {
    row = fresh();
    map.set(key, row);
  }
  return row;
}

/** The discount summary's key: one row per kind, type, code or reason, label and who applied it. */
export function reportDiscountKey(d: ReportDiscountFacts): string {
  return [d.kind, d.type, d.code ?? '', d.reason ?? '', d.label ?? '', d.appliedByAccountId ?? '', d.appliedByName ?? ''].join('|');
}

/**
 * ONE BRANCH-DAY'S REPORT ROWS from its counted sales — the prototype's
 * `lib/reporting.ts` sums, per day:
 *
 *   categories  `salesByCategory` and `vatSummary`: every category row of each
 *               sale's tax breakdown, gross of refunds; a sale counts once per
 *               category it touched.
 *   tenders     `paymentMix` (`reportPaymentBumps`).
 *   tickets     ticket sales only (`getFilteredSales`): `ticketSalesByTier`
 *               (the total less the drop-off category, and the drop-off
 *               category), `ticketTypeSalesRows` (a cart line under its
 *               package, the drop-off stay and the free-item stub left out)
 *               and `dropOffNannyRevenueRows` (a stay's session, its play
 *               hours and its fee).
 *   items       `fnbSalesByItem` / `merchSalesByItem`, with the cost the
 *               profitability panel reads.
 *   discounts   `discountAndCompImpact` (every manual row) and
 *               `promoDiscountImpact` (promos that took something).
 */
export function summariseReportDayV1(sales: readonly ReportSaleFacts[]): ReportDay {
  const categories = new Map<string, ReportCategoryRow>();
  const tenders = new Map<string, ReportTenderRow>();
  const tickets = new Map<string, ReportTicketRow>();
  const items = new Map<string, ReportItemRow>();
  const discounts = new Map<string, ReportDiscountRow>();

  const ticketRow = (kind: ReportTicketKind, key: string, label: string) =>
    bumpRow(tickets, `${kind}|${key}`, () => ({
      kind,
      key,
      label,
      saleCount: 0,
      lineCount: 0,
      kids: 0,
      adults: 0,
      hours: 0,
      revenueSatang: 0,
      dropoffSatang: 0,
    }));

  for (const sale of sales) {
    for (const c of sale.categories) {
      const row = bumpRow(categories, c.category, () => ({
        key: c.category,
        grossSatang: 0,
        netSatang: 0,
        taxSatang: 0,
        taxInclusiveSatang: 0,
        taxExclusiveSatang: 0,
        serviceSatang: 0,
        txnCount: 0,
      }));
      row.grossSatang += c.gross;
      row.netSatang += c.base;
      row.taxSatang += c.tax + c.secondaryTax;
      row.taxExclusiveSatang += (c.taxMode === 'exclusive' ? c.tax : 0) + (c.secondaryTaxMode === 'exclusive' ? c.secondaryTax : 0);
      row.taxInclusiveSatang += (c.taxMode === 'inclusive' ? c.tax : 0) + (c.secondaryTaxMode === 'inclusive' ? c.secondaryTax : 0);
      row.serviceSatang += c.serviceCharge;
      row.txnCount += 1;
    }

    for (const [code, bump] of reportPaymentBumps(sale)) {
      const row = bumpRow(tenders, code, () => ({ key: code, method: bump.method, amountSatang: 0, refundedSatang: 0, txnCount: 0 }));
      row.amountSatang += bump.amountSatang;
      row.txnCount += 1;
    }
    for (const slice of sale.refundSlices) {
      const method = sale.tenders.find((t) => t.code === slice.code)?.method ?? slice.code;
      const row = bumpRow(tenders, slice.code, () => ({ key: slice.code, method, amountSatang: 0, refundedSatang: 0, txnCount: 0 }));
      row.refundedSatang += slice.amountSatang;
    }

    if (sale.kind === 'ticket') {
      const dropOff = reportDropOffGross(sale.categories);
      const tier = ticketRow('tier', sale.tier, sale.tier);
      tier.saleCount += 1;
      tier.revenueSatang += sale.grossSatang - dropOff;
      tier.dropoffSatang += dropOff;
      for (const line of sale.cartLines) {
        if (line.stay) {
          if (line.service === 'drop_off' || line.service === 'nanny') {
            const service = ticketRow('service', line.service, line.service);
            service.lineCount += 1;
            service.hours += line.hours ?? 0;
            service.revenueSatang += line.feeBaseSatang;
          }
          continue;
        }
        if (line.promo || !line.packageId) continue;
        const type = ticketRow('ticket_type', line.packageId, line.packageName ?? line.packageId);
        type.lineCount += 1;
        type.kids += line.kids;
        type.adults += line.adults;
        type.revenueSatang += line.ticketBaseSatang;
      }
    }

    for (const item of sale.items) {
      const key = item.productId ?? `${item.kind}:${item.label}`;
      const row = bumpRow(items, key, () => ({
        key,
        kind: item.kind,
        label: item.label,
        quantity: 0,
        revenueSatang: 0,
        costSatang: 0,
        costUntrackedQuantity: 0,
      }));
      row.quantity += item.quantity;
      row.revenueSatang += item.revenueSatang;
      row.costSatang += item.costSatang;
      row.costUntrackedQuantity += item.costUntrackedQuantity;
    }

    for (const d of sale.discounts) {
      if (d.kind === 'promo' && d.amountSatang <= 0) continue;
      const key = reportDiscountKey(d);
      const row = bumpRow(discounts, key, () => ({
        key,
        kind: d.kind,
        discountType: d.type,
        code: d.code,
        reason: d.reason,
        label: d.label,
        appliedByAccountId: d.appliedByAccountId,
        appliedByName: d.appliedByName,
        amountSatang: 0,
        useCount: 0,
      }));
      row.amountSatang += d.amountSatang;
      row.useCount += 1;
    }
  }

  const byKey = <T extends { key: string }>(rows: Iterable<T>) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
  return {
    categories: byKey(categories.values()),
    tenders: byKey(tenders.values()),
    tickets: [...tickets.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)),
    items: byKey(items.values()),
    discounts: byKey(discounts.values()),
  };
}

/**
 * "VAT included ฿4.58": a receipt's tax rows as the bulk export's label column
 * prints them (`taxSummaryLabel` in the prototype's `lib/reporting.ts`).
 */
export function reportTaxSummaryLabel(breakdown: TaxBreakdown): string {
  return summarizeTax(breakdown)
    .map((row) => `${row.label} ฿${(row.amount / 100).toFixed(2)}`)
    .join('; ');
}

/**
 * The tender a receipt row names: the one tender taken, `split` when there
 * were several, `unknown` when none was recorded (`dominantTender`).
 */
export function reportDominantTender(codes: readonly string[]): string {
  const distinct = [...new Set(codes)];
  if (distinct.length === 0) return 'unknown';
  if (distinct.length === 1) return distinct[0]!;
  return 'split';
}

// --- The wire (round 4) -------------------------------------------------------------

/** The longest range a report reads: a year and a day, as the summary. */
export const ANALYTICS_REPORT_MAX_DAYS = 366;
/**
 * The most rows a per-transaction list answers. Past it the request is refused
 * with a message to narrow the dates, as the voucher ledger's export is.
 */
export const ANALYTICS_REPORT_LIST_MAX_ROWS = 20_000;

/** `branches` (absent: every live branch the caller may read), `from`, `to` — business dates. */
export const AnalyticsReportQuerySchema = AnalyticsSummaryQuerySchema.omit({ group: true });
export type AnalyticsReportQuery = z.input<typeof AnalyticsReportQuerySchema>;

export const VAT_SUMMARY_PERIODS = ['range', 'day', 'month'] as const;
export type ReportVatPeriod = (typeof VAT_SUMMARY_PERIODS)[number];

export const AnalyticsVatQuerySchema = AnalyticsReportQuerySchema.extend({
  period: z.enum(VAT_SUMMARY_PERIODS).default('range'),
});

const Money = z.number().int();
const Count = z.number().int().min(0);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ReportScopeSchema = z.object({
  from: Day,
  to: Day,
  /** The branches added up: those requested and readable, or every one the caller may read. */
  branches: z.array(z.object({ branchId: z.string().uuid(), name: z.string() })),
  /** Requested branches of the operator the caller may not read: left out, never added in. */
  omitted: z.array(z.string().uuid()),
});

export const SalesReportSchema = ReportScopeSchema.extend({
  categories: z.array(
    z.object({
      category: z.string(),
      grossRevenueSatang: Money,
      taxCollectedSatang: Money,
      serviceChargeSatang: Money,
      count: Count,
      pctShare: z.number(),
    }),
  ),
  payments: z.array(z.object({ method: z.string(), amountSatang: Money, count: Count })),
  tiers: z.array(
    z.object({ tier: z.string(), ticketRevenueSatang: Money, dropOffRevenueSatang: Money, saleCount: Count }),
  ),
  ticketTypes: z.array(
    z.object({
      ticketTypeId: z.string(),
      name: z.string(),
      lineCount: Count,
      kids: Count,
      adults: Count,
      revenueSatang: Money,
    }),
  ),
  weekdayWeekend: z.array(z.object({ mode: z.enum(['weekday', 'weekend']), saleCount: Count, revenueSatang: Money })),
  dropOffNanny: z.array(
    z.object({ service: z.enum(['drop_off', 'nanny']), sessionCount: Count, totalHours: Count, feesSatang: Money }),
  ),
  fnbItems: z.array(z.object({ itemId: z.string(), name: z.string(), qty: Count, revenueSatang: Money })),
  merchItems: z.array(z.object({ itemId: z.string(), name: z.string(), qty: Count, revenueSatang: Money })),
});
export type SalesReport = z.infer<typeof SalesReportSchema>;

const ProfitabilityRowSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  qty: Count,
  revenueSatang: Money,
  cogsSatang: Money,
  marginSatang: Money,
  marginPercent: z.number(),
  costTracked: z.boolean(),
});
export type ProfitabilityReportRow = z.infer<typeof ProfitabilityRowSchema>;

export const ProfitabilityReportSchema = ReportScopeSchema.extend({
  fnb: z.array(ProfitabilityRowSchema),
  merch: z.array(ProfitabilityRowSchema),
});
export type ProfitabilityReport = z.infer<typeof ProfitabilityReportSchema>;

export const DiscountReportSchema = ReportScopeSchema.extend({
  /** The five tiles: comps, manual discounts, promo codes, the free-item benefit (in promo codes). */
  compSatang: Money,
  manualDiscountSatang: Money,
  promoSatang: Money,
  freeItemBenefitSatang: Money,
  promoByType: z.array(z.object({ type: z.string(), count: Count, amountSatang: Money })),
  byOperator: z.array(
    z.object({
      appliedBy: z.string(),
      compCount: Count,
      compTotalSatang: Money,
      discountCount: Count,
      discountTotalSatang: Money,
    }),
  ),
});
export type DiscountReport = z.infer<typeof DiscountReportSchema>;

export const DiscountTransactionsSchema = ReportScopeSchema.extend({
  /** Every manual discount and comp, newest first (`discountAndCompImpact`). */
  rows: z.array(
    z.object({
      source: z.enum(['sale', 'fnb', 'merch']),
      transactionId: z.string(),
      createdAt: z.string(),
      operatorName: z.string(),
      type: z.string(),
      reason: z.string(),
      note: z.string().nullable(),
      amountSatang: Money,
      appliedBy: z.string(),
    }),
  ),
  /** Every promo that took something, newest first (`promoDiscountImpact`). */
  promoRows: z.array(
    z.object({
      transactionId: z.string(),
      createdAt: z.string(),
      operatorName: z.string(),
      code: z.string(),
      label: z.string(),
      type: z.string(),
      amountSatang: Money,
    }),
  ),
});
export type DiscountTransactions = z.infer<typeof DiscountTransactionsSchema>;

export const VatReportSchema = ReportScopeSchema.extend({
  period: z.enum(VAT_SUMMARY_PERIODS),
  rows: z.array(
    z.object({
      category: z.string(),
      /** The business date (`day`) or month (`month`); null for the whole range. */
      period: z.string().nullable(),
      netBaseSatang: Money,
      serviceChargeSatang: Money,
      exclusiveTaxSatang: Money,
      inclusiveTaxSatang: Money,
      grossSatang: Money,
    }),
  ),
});
export type VatReport = z.infer<typeof VatReportSchema>;

export const TaxReceiptsSchema = ReportScopeSchema.extend({
  /** Every counted sale in the range, newest first (`taxReceiptRows`, unfiltered). */
  rows: z.array(
    z.object({
      kind: z.enum(['ticket', 'fnb', 'merch']),
      transactionId: z.string(),
      createdAt: z.string(),
      branchId: z.string().uuid(),
      branchName: z.string(),
      operatorName: z.string(),
      netSubtotalSatang: Money,
      serviceChargeSatang: Money,
      taxTotalSatang: Money,
      grandTotalSatang: Money,
      taxSummaryLabel: z.string(),
      categories: z.array(z.string()),
      paymentMethod: z.string(),
    }),
  ),
});
export type TaxReceipts = z.infer<typeof TaxReceiptsSchema>;

// --- The booth report (round 5) -----------------------------------------------------

export const BoothReportQuerySchema = AnalyticsReportQuerySchema;

const BoothFunnelSchema = z.object({
  spins: Count,
  prizesWon: Count,
  vouchersIssued: Count,
  vouchersRedeemed: Count,
  /** Redeemed over issued, 0-1; null when nothing was issued. */
  redemptionRate: z.number().nullable(),
  /** Mean seconds from issue to redemption over the redeemed; null when none was. */
  meanRedemptionLagS: z.number().nullable(),
  /** What the prizes won cost the park, as frozen on each voucher at issue. */
  prizeCostSatang: Money,
  /** A prize won here has no cost set (zero is "not costed yet"): the cost is short by it. */
  prizeCostIncomplete: z.boolean(),
});
export type BoothFunnel = z.infer<typeof BoothFunnelSchema>;

export const BoothReportSchema = ReportScopeSchema.extend({
  /** Per booth, the range added up. */
  booths: z.array(
    BoothFunnelSchema.extend({
      boothId: z.string().uuid(),
      name: z.string(),
      branchId: z.string().uuid(),
      branchName: z.string(),
    }),
  ),
  /** Per booth and prize. */
  prizes: z.array(
    BoothFunnelSchema.extend({ boothId: z.string().uuid(), prizeId: z.string().uuid(), name: z.string() }),
  ),
  /** Per booth and staff member signed in; `accountId` null is unattributed. */
  staff: z.array(
    BoothFunnelSchema.extend({ boothId: z.string().uuid(), accountId: z.string().uuid().nullable(), name: z.string() }),
  ),
  /** Per booth and trading day. */
  days: z.array(BoothFunnelSchema.extend({ boothId: z.string().uuid(), businessDate: Day })),
  /** When the booth rollup last ran to the end; null when it never has. */
  lastRolledUpAt: z.string().nullable(),
});
export type BoothReport = z.infer<typeof BoothReportSchema>;

/** The funnel's two ratios from its sums (plan question 14: lag is issue to redemption). */
export function boothFunnelRatios(sums: { vouchersIssued: number; vouchersRedeemed: number; lagSumS: number }): {
  redemptionRate: number | null;
  meanRedemptionLagS: number | null;
} {
  return {
    redemptionRate: sums.vouchersIssued > 0 ? sums.vouchersRedeemed / sums.vouchersIssued : null,
    meanRedemptionLagS: sums.vouchersRedeemed > 0 ? Math.round(sums.lagSumS / sums.vouchersRedeemed) : null,
  };
}
