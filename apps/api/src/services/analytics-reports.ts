import { sql, type SQL } from 'drizzle-orm';
import {
  dailyCategorySummary,
  dailyDiscountSummary,
  dailyItemSummary,
  dailyTenderSummary,
  dailyTicketSummary,
} from '@oto/db';
import {
  ANALYTICS_PLATFORM_SOURCE,
  ANALYTICS_REPORT_LIST_MAX_ROWS,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  newId,
  reportDominantTender,
  reportTaxSummaryLabel,
  summariseReportDayV1,
  type DiscountReport,
  type DiscountTransactions,
  type ProfitabilityReport,
  type ProfitabilityReportRow,
  type ReportCartLineFacts,
  type ReportCategoryFacts,
  type ReportDay,
  type ReportDiscountFacts,
  type ReportItemFacts,
  type ReportSaleFacts,
  type ReportTenderFacts,
  type ReportVatPeriod,
  type AnalyticsSaleKind,
  type SalesReport,
  type TaxBreakdown,
  type TaxReceipts,
  type VatReport,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import type { Exec, Tx } from './tx';
import { maskVoucherCode, maskedVoucherLineLabel } from './vouchers';

/**
 * S2-15b (SCRUM-216) round 4 — THE REPORTS PANELS' ROWS (plan
 * docs/progress/plans/analytics/PLAN.md §3, §7, §8 round 4).
 *
 * WRITTEN BY THE DAILY ROLLUP, in the same transaction and under the same
 * branch-day lock as the day's `daily_summary` row (`rollupDailyBranchDay`),
 * so a day's report rows and its Performance figures are always of one read
 * of the ledger: `reportFactsOf` gathers each counted sale's facts and
 * `summariseReportDayV1` (in `@oto/shared`) applies the prototype's
 * `lib/reporting.ts` sums. Every row is upserted only when a figure moved, and
 * a key the day no longer has is removed, so a replayed rollup writes nothing.
 *
 * READ BY THE REPORTS ROUTES (`routes/analytics.ts`), from these tables alone,
 * over the branches the caller may read — except the two per-transaction
 * lists (the discount and comp transactions, the bulk tax-receipt export),
 * which are not summaries and are read from the sales through a date-bounded
 * query (plan question 13, its default).
 */

const SOURCE = ANALYTICS_PLATFORM_SOURCE;

/** The sales the reports count: §4, finalised and refunded only. */
const COUNTED = sql`('finalised', 'refunded')`;

const taken = () =>
  sql.join(
    PAYMENT_ATTEMPT_TAKEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );

/**
 * SCRUM-433 — a voucher's discount row as every read of a sale shows it: the
 * code as its last four (`maskVoucherCode`), and a label still in the old
 * form that names the whole code rewritten the same way
 * (`maskedVoucherLineLabel`: a row an older api wrote, or a database restored
 * from before migration 0025). No report row and no report answer carries the
 * whole code, whatever a row says. Any other row is answered as it is.
 */
function maskedDiscount(row: { code: string | null; label: string | null; voucher: boolean }): {
  code: string | null;
  label: string | null;
} {
  if (!row.voucher || row.code === null) return { code: row.code, label: row.label };
  return {
    code: maskVoucherCode(row.code),
    label: row.label === null ? null : maskedVoucherLineLabel(row.label, row.code),
  };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** A stored `TaxBreakdown`'s category rows, read defensively: a row the engine wrote is the figure. */
function categoriesOf(breakdown: unknown): ReportCategoryFacts[] {
  const rows = (breakdown as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const c = raw as Record<string, unknown>;
    return {
      category: String(c.category ?? ''),
      base: num(c.base),
      gross: num(c.gross),
      tax: num(c.tax),
      secondaryTax: num(c.secondaryTax),
      taxMode: String(c.taxMode ?? 'none'),
      secondaryTaxMode: String(c.secondaryTaxMode ?? 'none'),
      serviceCharge: num(c.serviceCharge),
    };
  });
}

// --- The facts ------------------------------------------------------------------------

/**
 * WHAT KIND OF RECORD A SALE IS, in the prototype's terms. The lane the till
 * recorded it under decides (`sales_channel`: `fnb`, `shop`). Before SCRUM-343
 * every sale was recorded under `till`, F&B and shop orders included, so a
 * `till` sale with no ticket-side line and only F&B or merch items is read by
 * its lines.
 */
export function saleKindOf(row: { sales_channel: string; ticket_lines: number; fnb_lines: number; merch_lines: number }): AnalyticsSaleKind {
  if (row.sales_channel === 'fnb') return 'fnb';
  if (row.sales_channel === 'shop') return 'merch';
  if (row.ticket_lines === 0 && row.fnb_lines > 0) return 'fnb';
  if (row.ticket_lines === 0 && row.merch_lines > 0) return 'merch';
  return 'ticket';
}


/**
 * EVERY COUNTED SALE OF ONE BRANCH-DAY, with what the Reports panels read of
 * it: the tax breakdown the receipt printed, the tenders taken and the refund
 * slices that went back through them, the cart lines (participants once per
 * cart line, §4), the F&B and shop items with their cost, and the discounts.
 */
export async function reportFactsOf(db: Exec, branchId: string, date: string): Promise<ReportSaleFacts[]> {
  const day = sql`s.branch_id = ${branchId}::uuid and s.business_date = ${date}::date and s.status in ${COUNTED}`;

  const { rows: sales } = await db.execute<{
    id: string;
    sales_channel: string;
    customer_tier: string;
    gross_satang: string | number;
    tax_breakdown: unknown;
    ticket_lines: number;
    fnb_lines: number;
    merch_lines: number;
  }>(sql`
    select s.id, s.sales_channel, s.customer_tier, s.gross_satang, s.tax_breakdown,
           (select count(*) from pos.sale_line l where l.sale_id = s.id
              and l.kind in ('kids', 'adults_paid', 'adults_free', 'socks', 'addon', 'service_fee', 'food_provision'))::int as ticket_lines,
           (select count(*) from pos.sale_line l where l.sale_id = s.id and l.kind = 'fnb_item')::int as fnb_lines,
           (select count(*) from pos.sale_line l where l.sale_id = s.id and l.kind = 'merch_item')::int as merch_lines
      from pos.sale s
     where ${day}
     order by s.id`);
  if (sales.length === 0) return [];

  const { rows: tenders } = await db.execute<{ sale_id: string; code: string; method: string; taken: string | number }>(sql`
    select a.sale_id, coalesce(a.method_code, a.method) as code, min(a.method) as method, sum(a.amount_satang)::bigint as taken
      from pos.payment_attempt a
      join pos.sale s on s.id = a.sale_id
     where ${day} and a.status in (${taken()})
     group by a.sale_id, coalesce(a.method_code, a.method)`);

  const { rows: refunds } = await db.execute<{ sale_id: string; amount_satang: string | number; tender_allocation: unknown }>(sql`
    select r.sale_id, r.amount_satang, r.tender_allocation
      from pos.refund r
      join pos.sale s on s.id = r.sale_id
     where ${day}
     order by r.created_at, r.id`);

  const { rows: lines } = await db.execute<{
    sale_id: string;
    cart_line_id: string;
    package_id: string | null;
    package_name: string | null;
    kids: number;
    adults: number;
    hours: number | null;
    ticket_base: string | number;
    fee_base: string | number;
    stay: boolean;
    service: string | null;
    promo: boolean;
  }>(sql`
    select g.sale_id, g.cart_line_id, g.package_id, p.name as package_name, g.kids, g.adults, g.hours,
           g.ticket_base, g.fee_base, g.stay, g.service, g.promo
      from (
        select l.sale_id, l.cart_line_id,
               (array_agg(l.ticket_package_id order by l.line_no) filter (where l.ticket_package_id is not null))[1] as package_id,
               max(l.kid_count)::int as kids,
               max(l.adult_count)::int as adults,
               max(l.stay_hours)::int as hours,
               coalesce(sum(l.base_satang) filter (where l.kind in ('kids', 'adults_paid', 'adults_free', 'socks', 'addon')), 0)::bigint as ticket_base,
               coalesce(sum(l.base_satang) filter (where l.kind = 'service_fee'), 0)::bigint as fee_base,
               bool_or(l.kind = 'service_fee' or c.id is not null) as stay,
               max(c.service) as service,
               bool_or(l.kind = 'promo_item') as promo
          from pos.sale_line l
          join pos.sale s on s.id = l.sale_id
          left join pos.checkin c on c.id = l.cart_line_id
         where ${day} and l.kind not in ('fnb_item', 'merch_item')
         group by l.sale_id, l.cart_line_id
      ) g
      left join pos.ticket_package p on p.id = g.package_id
     order by g.sale_id, g.cart_line_id`);

  const { rows: items } = await db.execute<{
    sale_id: string;
    kind: 'fnb_item' | 'merch_item';
    product_id: string | null;
    label: string;
    quantity: number;
    base_satang: string | number;
    moved: boolean;
    moved_cost: string | number | null;
    moved_untracked: boolean;
    catalog_cost: number | null;
  }>(sql`
    select l.sale_id, l.kind, l.product_id, l.label, l.quantity, l.base_satang,
           mv.moved, mv.moved_cost, mv.moved_untracked, p.cost_satang as catalog_cost
      from pos.sale_line l
      join pos.sale s on s.id = l.sale_id
      left join pos.product p on p.id = l.product_id
      cross join lateral (
        select count(*) > 0 as moved,
               sum((-m.quantity + m.shortfall)::bigint * m.unit_cost_satang)::bigint as moved_cost,
               bool_or(m.unit_cost_satang is null) as moved_untracked
          from pos.stock_movement m
         where m.sale_line_id = l.id and m.kind in ('sale', 'offline_sale')
      ) mv
     where ${day} and l.kind in ('fnb_item', 'merch_item')
     order by l.sale_id, l.line_no`);

  const { rows: discounts } = await db.execute<{
    sale_id: string;
    kind: 'manual' | 'promo';
    discount_type: string;
    code: string | null;
    label: string | null;
    reason: string | null;
    amount_satang: string | number;
    applied_by_account_id: string | null;
    applied_by_name: string | null;
    voucher: boolean;
  }>(sql`
    select d.sale_id, d.kind, d.discount_type, d.code, d.label, d.reason, d.amount_satang,
           d.applied_by_account_id, d.applied_by_name,
           exists (select 1 from promo.voucher_redemption vr join promo.voucher v on v.id = vr.voucher_id
                    where vr.sale_id = d.sale_id and v.code = d.code) as voucher
      from pos.sale_discount d
      join pos.sale s on s.id = d.sale_id
     where ${day}
     order by d.sale_id, d.sequence`);

  const tendersOf = new Map<string, ReportTenderFacts[]>();
  for (const t of tenders) {
    const list = tendersOf.get(t.sale_id) ?? [];
    list.push({ code: t.code, method: t.method, takenSatang: num(t.taken) });
    tendersOf.set(t.sale_id, list);
  }
  const slicesOf = new Map<string, Array<{ code: string; amountSatang: number }>>();
  for (const r of refunds) {
    const list = slicesOf.get(r.sale_id) ?? [];
    const allocation = Array.isArray(r.tender_allocation) ? (r.tender_allocation as Array<Record<string, unknown>>) : [];
    let allocated = 0;
    for (const slice of allocation) {
      const amount = num(slice.amountSatang);
      allocated += amount;
      list.push({ code: String(slice.methodCode ?? slice.method ?? 'unknown'), amountSatang: amount });
    }
    // A refund with no allocation recorded for part of it goes back through
    // the sale's largest tender: the prototype's one-tender sale, netted whole.
    const remainder = num(r.amount_satang) - allocated;
    if (remainder > 0) {
      const largest = [...(tendersOf.get(r.sale_id) ?? [])].sort(
        (a, b) => b.takenSatang - a.takenSatang || a.code.localeCompare(b.code),
      )[0];
      list.push({ code: largest?.code ?? 'unknown', amountSatang: remainder });
    }
    slicesOf.set(r.sale_id, list);
  }
  const linesOf = new Map<string, ReportCartLineFacts[]>();
  for (const l of lines) {
    const list = linesOf.get(l.sale_id) ?? [];
    list.push({
      cartLineId: l.cart_line_id,
      packageId: l.package_id,
      packageName: l.package_name,
      kids: num(l.kids),
      adults: num(l.adults),
      hours: l.hours === null ? null : num(l.hours),
      ticketBaseSatang: num(l.ticket_base),
      feeBaseSatang: num(l.fee_base),
      stay: l.stay,
      service: (l.service as ReportCartLineFacts['service']) ?? null,
      promo: l.promo,
    });
    linesOf.set(l.sale_id, list);
  }
  const itemsOf = new Map<string, ReportItemFacts[]>();
  for (const i of items) {
    const list = itemsOf.get(i.sale_id) ?? [];
    const quantity = num(i.quantity);
    // The cost frozen on the stock ledger when the line sold; the product's
    // catalogue cost where nothing moved; none known otherwise.
    const cost = i.moved
      ? { costSatang: num(i.moved_cost), costUntrackedQuantity: i.moved_untracked ? quantity : 0 }
      : i.catalog_cost !== null
        ? { costSatang: num(i.catalog_cost) * quantity, costUntrackedQuantity: 0 }
        : { costSatang: 0, costUntrackedQuantity: quantity };
    list.push({
      kind: i.kind === 'fnb_item' ? 'fnb' : 'merch',
      productId: i.product_id,
      label: i.label,
      quantity,
      revenueSatang: num(i.base_satang),
      ...cost,
    });
    itemsOf.set(i.sale_id, list);
  }
  const discountsOf = new Map<string, ReportDiscountFacts[]>();
  for (const d of discounts) {
    const list = discountsOf.get(d.sale_id) ?? [];
    list.push({
      kind: d.kind,
      type: d.discount_type,
      ...maskedDiscount(d),
      reason: d.reason,
      amountSatang: num(d.amount_satang),
      appliedByAccountId: d.applied_by_account_id,
      appliedByName: d.applied_by_name,
    });
    discountsOf.set(d.sale_id, list);
  }

  return sales.map((s) => ({
    saleId: s.id,
    kind: saleKindOf(s),
    tier: s.customer_tier,
    grossSatang: num(s.gross_satang),
    categories: categoriesOf(s.tax_breakdown),
    tenders: tendersOf.get(s.id) ?? [],
    refundSlices: slicesOf.get(s.id) ?? [],
    cartLines: linesOf.get(s.id) ?? [],
    items: itemsOf.get(s.id) ?? [],
    discounts: discountsOf.get(s.id) ?? [],
  }));
}

// --- Writing one branch-day ---------------------------------------------------------------

export interface ReportWriteCounts {
  written: number;
  removed: number;
}

const CHUNK = 400;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/** Excluded's value of a column, for the change test of an upsert. */
const ex = (column: string) => sql.raw(`excluded.${column}`);

/**
 * Write one branch-day's report rows: every key upserted where a figure moved,
 * every key the day no longer has removed. Runs inside the rollup's
 * transaction, under its branch-day lock.
 */
export async function writeReportDay(
  tx: Tx,
  scope: { operatorId: string; branchId: string; date: string; now: Date },
  day: ReportDay,
): Promise<ReportWriteCounts> {
  const { operatorId, branchId, date, now } = scope;
  const base = { operatorId, branchId, businessDate: date, source: SOURCE, computedAt: now, createdAt: now, updatedAt: now };
  const counts: ReportWriteCounts = { written: 0, removed: 0 };

  // Categories.
  {
    const t = dailyCategorySummary;
    for (const part of chunks(day.categories)) {
      const written = await tx
        .insert(t)
        .values(part.map((r) => ({ id: newId(), ...base, ...r })))
        .onConflictDoUpdate({
          target: [t.branchId, t.businessDate, t.source, t.key],
          set: {
            grossSatang: sql`${ex('gross_satang')}`,
            netSatang: sql`${ex('net_satang')}`,
            taxSatang: sql`${ex('tax_satang')}`,
            taxInclusiveSatang: sql`${ex('tax_inclusive_satang')}`,
            taxExclusiveSatang: sql`${ex('tax_exclusive_satang')}`,
            serviceSatang: sql`${ex('service_satang')}`,
            txnCount: sql`${ex('txn_count')}`,
            computedAt: now,
            updatedAt: now,
          },
          setWhere: sql`(${t.grossSatang}, ${t.netSatang}, ${t.taxSatang}, ${t.taxInclusiveSatang}, ${t.taxExclusiveSatang}, ${t.serviceSatang}, ${t.txnCount})
            is distinct from (excluded.gross_satang, excluded.net_satang, excluded.tax_satang, excluded.tax_inclusive_satang, excluded.tax_exclusive_satang, excluded.service_satang, excluded.txn_count)`,
        })
        .returning({ id: t.id });
      counts.written += written.length;
    }
    counts.removed += await removeStale(tx, 'analytics.daily_category_summary', branchId, date, 'key', day.categories.map((r) => r.key));
  }

  // Tenders.
  {
    const t = dailyTenderSummary;
    for (const part of chunks(day.tenders)) {
      const written = await tx
        .insert(t)
        .values(part.map((r) => ({ id: newId(), ...base, ...r })))
        .onConflictDoUpdate({
          target: [t.branchId, t.businessDate, t.source, t.key],
          set: {
            method: sql`${ex('method')}`,
            amountSatang: sql`${ex('amount_satang')}`,
            refundedSatang: sql`${ex('refunded_satang')}`,
            txnCount: sql`${ex('txn_count')}`,
            computedAt: now,
            updatedAt: now,
          },
          setWhere: sql`(${t.method}, ${t.amountSatang}, ${t.refundedSatang}, ${t.txnCount})
            is distinct from (excluded.method, excluded.amount_satang, excluded.refunded_satang, excluded.txn_count)`,
        })
        .returning({ id: t.id });
      counts.written += written.length;
    }
    counts.removed += await removeStale(tx, 'analytics.daily_tender_summary', branchId, date, 'key', day.tenders.map((r) => r.key));
  }

  // The ticket side.
  {
    const t = dailyTicketSummary;
    for (const part of chunks(day.tickets)) {
      const written = await tx
        .insert(t)
        .values(part.map((r) => ({ id: newId(), ...base, ...r })))
        .onConflictDoUpdate({
          target: [t.branchId, t.businessDate, t.source, t.kind, t.key],
          set: {
            label: sql`${ex('label')}`,
            saleCount: sql`${ex('sale_count')}`,
            lineCount: sql`${ex('line_count')}`,
            kids: sql`${ex('kids')}`,
            adults: sql`${ex('adults')}`,
            hours: sql`${ex('hours')}`,
            revenueSatang: sql`${ex('revenue_satang')}`,
            dropoffSatang: sql`${ex('dropoff_satang')}`,
            computedAt: now,
            updatedAt: now,
          },
          setWhere: sql`(${t.label}, ${t.saleCount}, ${t.lineCount}, ${t.kids}, ${t.adults}, ${t.hours}, ${t.revenueSatang}, ${t.dropoffSatang})
            is distinct from (excluded.label, excluded.sale_count, excluded.line_count, excluded.kids, excluded.adults, excluded.hours, excluded.revenue_satang, excluded.dropoff_satang)`,
        })
        .returning({ id: t.id });
      counts.written += written.length;
    }
    counts.removed += await removeStale(
      tx,
      'analytics.daily_ticket_summary',
      branchId,
      date,
      "kind || '|' || key",
      day.tickets.map((r) => `${r.kind}|${r.key}`),
    );
  }

  // Items.
  {
    const t = dailyItemSummary;
    for (const part of chunks(day.items)) {
      const written = await tx
        .insert(t)
        .values(part.map((r) => ({ id: newId(), ...base, ...r })))
        .onConflictDoUpdate({
          target: [t.branchId, t.businessDate, t.source, t.key],
          set: {
            kind: sql`${ex('kind')}`,
            label: sql`${ex('label')}`,
            quantity: sql`${ex('quantity')}`,
            revenueSatang: sql`${ex('revenue_satang')}`,
            costSatang: sql`${ex('cost_satang')}`,
            costUntrackedQuantity: sql`${ex('cost_untracked_quantity')}`,
            computedAt: now,
            updatedAt: now,
          },
          setWhere: sql`(${t.kind}, ${t.label}, ${t.quantity}, ${t.revenueSatang}, ${t.costSatang}, ${t.costUntrackedQuantity})
            is distinct from (excluded.kind, excluded.label, excluded.quantity, excluded.revenue_satang, excluded.cost_satang, excluded.cost_untracked_quantity)`,
        })
        .returning({ id: t.id });
      counts.written += written.length;
    }
    counts.removed += await removeStale(tx, 'analytics.daily_item_summary', branchId, date, 'key', day.items.map((r) => r.key));
  }

  // Discounts.
  {
    const t = dailyDiscountSummary;
    for (const part of chunks(day.discounts)) {
      const written = await tx
        .insert(t)
        .values(part.map((r) => ({ id: newId(), ...base, ...r })))
        .onConflictDoUpdate({
          target: [t.branchId, t.businessDate, t.source, t.key],
          set: {
            amountSatang: sql`${ex('amount_satang')}`,
            useCount: sql`${ex('use_count')}`,
            computedAt: now,
            updatedAt: now,
          },
          setWhere: sql`(${t.amountSatang}, ${t.useCount}) is distinct from (excluded.amount_satang, excluded.use_count)`,
        })
        .returning({ id: t.id });
      counts.written += written.length;
    }
    counts.removed += await removeStale(tx, 'analytics.daily_discount_summary', branchId, date, 'key', day.discounts.map((r) => r.key));
  }

  return counts;
}

/** Remove the branch-day's rows of one report table whose key the day no longer has. */
async function removeStale(
  tx: Tx,
  table: string,
  branchId: string,
  date: string,
  keyExpr: string,
  keep: readonly string[],
): Promise<number> {
  const kept =
    keep.length > 0
      ? sql`and ${sql.raw(keyExpr)} not in (${sql.join(
          keep.map((k) => sql`${k}`),
          sql`, `,
        )})`
      : sql``;
  const { rows } = await tx.execute<{ id: string }>(sql`
    delete from ${sql.raw(table)}
     where branch_id = ${branchId}::uuid and business_date = ${date}::date and source = ${SOURCE} ${kept}
    returning id`);
  return rows.length;
}

/** Recompute one branch-day's report rows inside the rollup's transaction. */
export async function rollupReportDay(
  tx: Tx,
  scope: { operatorId: string; branchId: string; date: string; now: Date },
): Promise<ReportWriteCounts> {
  const day = summariseReportDayV1(await reportFactsOf(tx, scope.branchId, scope.date));
  return writeReportDay(tx, scope, day);
}

// --- Reading the panels ----------------------------------------------------------------

/** The branches a report adds up, and the ones requested that the caller may not read. */
export interface ReportScope {
  branches: Array<{ branchId: string; name: string }>;
  omitted: string[];
  from: string;
  to: string;
}

const idsOf = (scope: ReportScope) =>
  sql.join(
    scope.branches.map((b) => sql`${b.branchId}::uuid`),
    sql`, `,
  );

/** The report rows of the scope's branches and dates, as a WHERE over a summary table alias. */
function within(alias: string, scope: ReportScope): SQL {
  const a = sql.raw(alias);
  return sql`${a}.branch_id in (${idsOf(scope)}) and ${a}.source = ${SOURCE}
    and ${a}.business_date between ${scope.from}::date and ${scope.to}::date`;
}

const head = (scope: ReportScope) => ({
  from: scope.from,
  to: scope.to,
  branches: scope.branches,
  omitted: scope.omitted,
});

const byAmount = <T>(amount: (row: T) => number, name: (row: T) => string) => (a: T, b: T) =>
  amount(b) - amount(a) || name(a).localeCompare(name(b));

/** Admin > Reports > Sales. */
export async function salesReportOf(db: Exec, scope: ReportScope): Promise<SalesReport> {
  if (scope.branches.length === 0) {
    return {
      ...head(scope),
      categories: [],
      payments: [],
      tiers: [],
      ticketTypes: [],
      weekdayWeekend: [],
      dropOffNanny: [],
      fnbItems: [],
      merchItems: [],
    };
  }
  const { rows: categoryRows } = await db.execute<{ key: string; gross: string; tax: string; service: string; n: number }>(sql`
    select c.key, sum(c.gross_satang)::bigint as gross, sum(c.tax_satang)::bigint as tax,
           sum(c.service_satang)::bigint as service, sum(c.txn_count)::int as n
      from analytics.daily_category_summary c
     where ${within('c', scope)}
     group by c.key`);
  const totalGross = categoryRows.reduce((sum, r) => sum + num(r.gross), 0);
  const categories = categoryRows
    .map((r) => ({
      category: r.key,
      grossRevenueSatang: num(r.gross),
      taxCollectedSatang: num(r.tax),
      serviceChargeSatang: num(r.service),
      count: num(r.n),
      pctShare: totalGross > 0 ? (num(r.gross) / totalGross) * 100 : 0,
    }))
    .sort(byAmount((r) => r.grossRevenueSatang, (r) => r.category));

  const { rows: tenderRows } = await db.execute<{ key: string; amount: string; n: number }>(sql`
    select t.key, sum(t.amount_satang)::bigint as amount, sum(t.txn_count)::int as n
      from analytics.daily_tender_summary t
     where ${within('t', scope)}
     group by t.key
    having sum(t.txn_count) > 0`);
  const payments = tenderRows
    .map((r) => ({ method: r.key, amountSatang: num(r.amount), count: num(r.n) }))
    .sort(byAmount((r) => r.amountSatang, (r) => r.method));

  const { rows: ticketRows } = await db.execute<{
    kind: string;
    key: string;
    label: string;
    sales: number;
    lines: number;
    kids: number;
    adults: number;
    hours: number;
    revenue: string;
    dropoff: string;
  }>(sql`
    select t.kind, t.key, (array_agg(t.label order by t.business_date desc, t.branch_id))[1] as label,
           sum(t.sale_count)::int as sales, sum(t.line_count)::int as lines, sum(t.kids)::int as kids,
           sum(t.adults)::int as adults, sum(t.hours)::int as hours,
           sum(t.revenue_satang)::bigint as revenue, sum(t.dropoff_satang)::bigint as dropoff
      from analytics.daily_ticket_summary t
     where ${within('t', scope)}
     group by t.kind, t.key`);
  const tiers = ticketRows
    .filter((r) => r.kind === 'tier')
    .map((r) => ({
      tier: r.key,
      ticketRevenueSatang: num(r.revenue),
      dropOffRevenueSatang: num(r.dropoff),
      saleCount: num(r.sales),
    }))
    .sort(byAmount((r) => r.ticketRevenueSatang + r.dropOffRevenueSatang, (r) => r.tier));
  const ticketTypes = ticketRows
    .filter((r) => r.kind === 'ticket_type')
    .map((r) => ({
      ticketTypeId: r.key,
      name: r.label,
      lineCount: num(r.lines),
      kids: num(r.kids),
      adults: num(r.adults),
      revenueSatang: num(r.revenue),
    }))
    .sort(byAmount((r) => r.revenueSatang, (r) => r.name));
  const dropOffNanny = ticketRows
    .filter((r) => r.kind === 'service' && (r.key === 'drop_off' || r.key === 'nanny'))
    .map((r) => ({
      service: r.key as 'drop_off' | 'nanny',
      sessionCount: num(r.lines),
      totalHours: num(r.hours),
      feesSatang: num(r.revenue),
    }))
    .sort(byAmount((r) => r.feesSatang, (r) => r.service));

  // The day's rate mode by the pricing resolver's rule (`analytics.dim_date`:
  // a holiday is priced as a weekend, `RateMode` has the two words); a day the
  // calendar has not reached falls back to Saturday and Sunday.
  const { rows: modeRows } = await db.execute<{ mode: 'weekday' | 'weekend'; sales: number; revenue: string }>(sql`
    select case when coalesce(dd.rate_mode,
                              case when extract(isodow from t.business_date) in (6, 7) then 'weekend' else 'weekday' end) = 'weekday'
                then 'weekday' else 'weekend' end as mode,
           sum(t.sale_count)::int as sales,
           sum(t.revenue_satang + t.dropoff_satang)::bigint as revenue
      from analytics.daily_ticket_summary t
      left join analytics.dim_date dd on dd.branch_id = t.branch_id and dd.date = t.business_date
     where ${within('t', scope)} and t.kind = 'tier'
     group by 1`);
  const weekdayWeekend = modeRows
    .map((r) => ({ mode: r.mode, saleCount: num(r.sales), revenueSatang: num(r.revenue) }))
    .sort(byAmount((r) => r.revenueSatang, (r) => r.mode));

  const items = await itemRowsOf(db, scope);
  const asSales = (kind: 'fnb' | 'merch') =>
    items
      .filter((r) => r.kind === kind)
      .map((r) => ({ itemId: r.key, name: r.label, qty: r.quantity, revenueSatang: r.revenue }));

  return {
    ...head(scope),
    categories,
    payments,
    tiers,
    ticketTypes,
    weekdayWeekend,
    dropOffNanny,
    fnbItems: asSales('fnb'),
    merchItems: asSales('merch'),
  };
}

interface ItemTotals {
  key: string;
  kind: 'fnb' | 'merch';
  label: string;
  quantity: number;
  revenue: number;
  cost: number;
  untracked: number;
}

/** Item rows over the scope, newest label, by revenue (`fnbSalesByItem`'s order). */
async function itemRowsOf(db: Exec, scope: ReportScope): Promise<ItemTotals[]> {
  const { rows } = await db.execute<{
    key: string;
    kind: 'fnb' | 'merch';
    label: string;
    quantity: number;
    revenue: string;
    cost: string;
    untracked: number;
  }>(sql`
    select i.key, i.kind, (array_agg(i.label order by i.business_date desc, i.branch_id))[1] as label,
           sum(i.quantity)::int as quantity, sum(i.revenue_satang)::bigint as revenue,
           sum(i.cost_satang)::bigint as cost, sum(i.cost_untracked_quantity)::int as untracked
      from analytics.daily_item_summary i
     where ${within('i', scope)}
     group by i.key, i.kind`);
  return rows
    .map((r) => ({
      key: r.key,
      kind: r.kind,
      label: r.label,
      quantity: num(r.quantity),
      revenue: num(r.revenue),
      cost: num(r.cost),
      untracked: num(r.untracked),
    }))
    .sort(byAmount((r) => r.revenue, (r) => r.label));
}

/**
 * Admin > Reports > Profitability: every F&B and shop item with its cost of
 * goods — the cost frozen on the stock ledger when it sold, the catalogue's
 * where nothing moved — and margin. An item with units of no known cost is
 * flagged (`costTracked` false), its margin understated.
 */
export async function profitabilityReportOf(db: Exec, scope: ReportScope): Promise<ProfitabilityReport> {
  const items = scope.branches.length === 0 ? [] : await itemRowsOf(db, scope);
  const rowOf = (r: ItemTotals): ProfitabilityReportRow => {
    const margin = r.revenue - r.cost;
    return {
      itemId: r.key,
      name: r.label,
      qty: r.quantity,
      revenueSatang: r.revenue,
      cogsSatang: r.cost,
      marginSatang: margin,
      marginPercent: r.revenue > 0 ? (margin / r.revenue) * 100 : 0,
      costTracked: r.untracked === 0,
    };
  };
  return {
    ...head(scope),
    fnb: items.filter((r) => r.kind === 'fnb').map(rowOf),
    merch: items.filter((r) => r.kind === 'merch').map(rowOf),
  };
}

/** The name a summary row gives a manual discount's applier when none was frozen. */
const UNNAMED = 'Unnamed account';

/** Admin > Reports > Discounts & Comps: the tiles, promo impact by type, and by operator. */
export async function discountReportOf(db: Exec, scope: ReportScope): Promise<DiscountReport> {
  const empty: DiscountReport = {
    ...head(scope),
    compSatang: 0,
    manualDiscountSatang: 0,
    promoSatang: 0,
    freeItemBenefitSatang: 0,
    promoByType: [],
    byOperator: [],
  };
  if (scope.branches.length === 0) return empty;
  const { rows } = await db.execute<{ kind: 'manual' | 'promo'; discount_type: string; applied_by_name: string | null; amount: string; n: number }>(sql`
    select d.kind, d.discount_type, d.applied_by_name, sum(d.amount_satang)::bigint as amount, sum(d.use_count)::int as n
      from analytics.daily_discount_summary d
     where ${within('d', scope)}
     group by d.kind, d.discount_type, d.applied_by_name`);
  const report = empty;
  const promoByType = new Map<string, { type: string; count: number; amountSatang: number }>();
  const byOperator = new Map<string, DiscountReport['byOperator'][number]>();
  for (const r of rows) {
    const amount = num(r.amount);
    const count = num(r.n);
    if (r.kind === 'promo') {
      report.promoSatang += amount;
      if (r.discount_type === 'free_item') report.freeItemBenefitSatang += amount;
      const held = promoByType.get(r.discount_type) ?? { type: r.discount_type, count: 0, amountSatang: 0 };
      held.count += count;
      held.amountSatang += amount;
      promoByType.set(r.discount_type, held);
      continue;
    }
    const name = r.applied_by_name ?? UNNAMED;
    const held = byOperator.get(name) ?? {
      appliedBy: name,
      compCount: 0,
      compTotalSatang: 0,
      discountCount: 0,
      discountTotalSatang: 0,
    };
    if (r.discount_type === 'comp') {
      report.compSatang += amount;
      held.compCount += count;
      held.compTotalSatang += amount;
    } else {
      report.manualDiscountSatang += amount;
      held.discountCount += count;
      held.discountTotalSatang += amount;
    }
    byOperator.set(name, held);
  }
  report.promoByType = [...promoByType.values()].sort(byAmount((r) => r.amountSatang, (r) => r.type));
  report.byOperator = [...byOperator.values()].sort(
    byAmount((r) => r.compTotalSatang + r.discountTotalSatang, (r) => r.appliedBy),
  );
  return report;
}

/** Admin > Reports > Tax & VAT: the VAT summary by category, for the range or by day or month. */
export async function vatReportOf(db: Exec, scope: ReportScope, period: ReportVatPeriod): Promise<VatReport> {
  if (scope.branches.length === 0) return { ...head(scope), period, rows: [] };
  const bucket =
    period === 'range'
      ? sql`null::text`
      : period === 'day'
        ? sql`c.business_date::text`
        : sql`to_char(c.business_date, 'YYYY-MM')`;
  const { rows } = await db.execute<{
    period: string | null;
    key: string;
    net: string;
    service: string;
    exclusive: string;
    inclusive: string;
    gross: string;
  }>(sql`
    select ${bucket} as period, c.key, sum(c.net_satang)::bigint as net, sum(c.service_satang)::bigint as service,
           sum(c.tax_exclusive_satang)::bigint as exclusive, sum(c.tax_inclusive_satang)::bigint as inclusive,
           sum(c.gross_satang)::bigint as gross
      from analytics.daily_category_summary c
     where ${within('c', scope)}
     group by 1, c.key`);
  return {
    ...head(scope),
    period,
    rows: rows
      .map((r) => ({
        category: r.key,
        period: r.period === null ? null : String(r.period).slice(0, period === 'day' ? 10 : 7),
        netBaseSatang: num(r.net),
        serviceChargeSatang: num(r.service),
        exclusiveTaxSatang: num(r.exclusive),
        inclusiveTaxSatang: num(r.inclusive),
        grossSatang: num(r.gross),
      }))
      .sort((a, b) => (a.period ?? '').localeCompare(b.period ?? '') || b.grossSatang - a.grossSatang || a.category.localeCompare(b.category)),
  };
}

// --- The per-transaction lists (plan question 13) -----------------------------------------

function refuseLongList(count: number): void {
  if (count > ANALYTICS_REPORT_LIST_MAX_ROWS) {
    throw new AppError(
      400,
      'ANALYTICS_REPORT_TOO_LARGE',
      `Narrow the dates: this list is limited to ${ANALYTICS_REPORT_LIST_MAX_ROWS.toLocaleString('en-US')} transactions at a time.`,
    );
  }
}

/** The counted sales of the scope, as the WHERE of a query over `pos.sale s`. */
function countedSales(scope: ReportScope): SQL {
  return sql`s.branch_id in (${idsOf(scope)}) and s.business_date between ${scope.from}::date and ${scope.to}::date
    and s.status in ${COUNTED}`;
}

/** How a report names the staff member who rang a sale up. */
const operatorName = sql`coalesce(e.nickname, e.name, ${UNNAMED})`;

const lineCounts = sql`
  (select count(*) from pos.sale_line l where l.sale_id = s.id
     and l.kind in ('kids', 'adults_paid', 'adults_free', 'socks', 'addon', 'service_fee', 'food_provision'))::int as ticket_lines,
  (select count(*) from pos.sale_line l where l.sale_id = s.id and l.kind = 'fnb_item')::int as fnb_lines,
  (select count(*) from pos.sale_line l where l.sale_id = s.id and l.kind = 'merch_item')::int as merch_lines`;

/**
 * Every manual discount and comp, and every promo that took something, on the
 * scope's counted sales, newest first — the Discounts & Comps panel's two
 * lists. A voucher's code is shown as its last four, in its code and in its
 * label (`maskedDiscount`).
 */
export async function discountTransactionsOf(db: Exec, scope: ReportScope): Promise<DiscountTransactions> {
  if (scope.branches.length === 0) return { ...head(scope), rows: [], promoRows: [] };
  const { rows } = await db.execute<{
    sale_id: string;
    receipt_number: string | null;
    occurred_at: Date | string;
    sales_channel: string;
    ticket_lines: number;
    fnb_lines: number;
    merch_lines: number;
    operator_name: string;
    kind: 'manual' | 'promo';
    discount_type: string;
    code: string | null;
    label: string | null;
    reason: string | null;
    note: string | null;
    amount_satang: string | number;
    applied_by_name: string | null;
    voucher: boolean;
  }>(sql`
    select s.id as sale_id, s.receipt_number, s.occurred_at, s.sales_channel, ${lineCounts},
           ${operatorName} as operator_name,
           d.kind, d.discount_type, d.code, d.label, d.reason, d.note, d.amount_satang, d.applied_by_name,
           exists (select 1 from promo.voucher_redemption vr join promo.voucher v on v.id = vr.voucher_id
                    where vr.sale_id = d.sale_id and v.code = d.code) as voucher
      from pos.sale_discount d
      join pos.sale s on s.id = d.sale_id
      left join core.account a on a.id = s.created_by_account_id
      left join core.employee e on e.id = a.employee_id
     where ${countedSales(scope)} and (d.kind = 'manual' or d.amount_satang > 0)
     order by s.occurred_at desc, s.id desc, d.sequence
     limit ${ANALYTICS_REPORT_LIST_MAX_ROWS + 1}`);
  refuseLongList(rows.length);
  const source = { ticket: 'sale', fnb: 'fnb', merch: 'merch' } as const;
  const out: DiscountTransactions = { ...head(scope), rows: [], promoRows: [] };
  for (const r of rows) {
    const transactionId = r.receipt_number ?? r.sale_id;
    const createdAt = new Date(r.occurred_at).toISOString();
    if (r.kind === 'manual') {
      out.rows.push({
        source: source[saleKindOf(r)],
        transactionId,
        createdAt,
        operatorName: r.operator_name,
        type: r.discount_type,
        reason: r.reason ?? '',
        note: r.note,
        amountSatang: num(r.amount_satang),
        appliedBy: r.applied_by_name ?? UNNAMED,
      });
    } else {
      const shown = maskedDiscount(r);
      out.promoRows.push({
        transactionId,
        createdAt,
        operatorName: r.operator_name,
        code: shown.code ?? '',
        label: shown.label ?? '',
        type: r.discount_type,
        amountSatang: num(r.amount_satang),
      });
    }
  }
  return out;
}

/**
 * Every counted sale of the scope with its receipt's tax figures, newest first
 * — the bulk tax-receipt export. Read from the tax breakdown the receipt
 * printed, never re-derived. Unfiltered: the panel narrows by category and
 * tender on the rows it holds, as the prototype's did.
 */
export async function taxReceiptsOf(db: Exec, scope: ReportScope): Promise<TaxReceipts> {
  if (scope.branches.length === 0) return { ...head(scope), rows: [] };
  const { rows } = await db.execute<{
    id: string;
    receipt_number: string | null;
    occurred_at: Date | string;
    branch_id: string;
    branch_name: string;
    sales_channel: string;
    ticket_lines: number;
    fnb_lines: number;
    merch_lines: number;
    operator_name: string;
    tax_breakdown: unknown;
    tenders: string[] | null;
  }>(sql`
    select s.id, s.receipt_number, s.occurred_at, s.branch_id, b.name as branch_name, s.sales_channel, ${lineCounts},
           ${operatorName} as operator_name, s.tax_breakdown,
           (select array_agg(distinct coalesce(pa.method_code, pa.method))
              from pos.payment_attempt pa
             where pa.sale_id = s.id and pa.status in (${taken()}) and pa.amount_satang > 0) as tenders
      from pos.sale s
      join core.branch b on b.id = s.branch_id
      left join core.account a on a.id = s.created_by_account_id
      left join core.employee e on e.id = a.employee_id
     where ${countedSales(scope)}
     order by s.occurred_at desc, s.id desc
     limit ${ANALYTICS_REPORT_LIST_MAX_ROWS + 1}`);
  refuseLongList(rows.length);
  return {
    ...head(scope),
    rows: rows.map((r) => {
      const breakdown = r.tax_breakdown as TaxBreakdown;
      return {
        kind: saleKindOf(r),
        transactionId: r.receipt_number ?? r.id,
        createdAt: new Date(r.occurred_at).toISOString(),
        branchId: r.branch_id,
        branchName: r.branch_name,
        operatorName: r.operator_name,
        netSubtotalSatang: num(breakdown?.netSubtotal),
        serviceChargeSatang: num(breakdown?.serviceChargeTotal),
        taxTotalSatang: num(breakdown?.taxTotal),
        grandTotalSatang: num(breakdown?.grandTotal),
        taxSummaryLabel: breakdown && Array.isArray(breakdown.categories) ? reportTaxSummaryLabel(breakdown) : '',
        categories: categoriesOf(breakdown).map((c) => c.category),
        paymentMethod: reportDominantTender(r.tenders ?? []),
      };
    }),
  };
}
