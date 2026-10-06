import {
  Sale,
  FnbOrder,
  MerchOrder,
  ManualDiscount,
  Discount,
  TaxableCategory,
  Wristband,
  WalletEntry,
} from '@/types';
import {
  getAllSalesForReporting,
  getAllFnbOrdersForReporting,
  getAllMerchOrdersForReporting,
  getAllEventsForReporting,
  getMockWristbands,
  getInventory,
} from '@/mockApi';
import {
  getBranches,
  getTaxConfig,
  getMerchItems,
  getDiscounts,
} from '@/store/catalogStore';
import { itemOrderTotals, ticketTotals, toSatang } from '@/lib/cartWire';
import { summarizeTax, type Satang, type TaxBreakdown } from '@oto/shared';
import { getRateModeForDate, resolveRate, RateMode } from '@/lib/pricingMode';
import { getWalletReport } from '@/api/wallet';
import type { ReportQuery } from '@/api/analyticsReports';
import { fetchCostOfGoods } from '@/api/stock';

/*
 * SCRUM-271 — EVERY FIGURE HERE IS SATANG. These reports used to re-derive each
 * record with the prototype's baht-float calculator and add the floats up over
 * a month of rows (`grossRevenue`, `taxCollected`, `serviceCharge`, …), which is
 * exactly where a VAT report stops reconciling with the receipts it summarises.
 * Each record is now re-derived by the satang engine (`ticketTotals`,
 * `itemOrderTotals` in `lib/cartWire.ts`), every accumulator is an integer
 * number of satang — a stored baht figure (a wallet entry, a recorded discount,
 * a cost) is converted once, where it is read — and the one place a figure is
 * turned back into baht is the edge: the panels' `thbFromSatang` on screen and
 * `csvBaht` in an export (`components/admin/reports/shared.tsx`). Every money
 * field says so in its name.
 */

// ── Shared filters ───────────────────────────────────────────────────────
// Every report in the manager Reports module filters by an inclusive date
// range and an optional branch. Records with no branchId (legacy/global
// seed data) always pass the branch filter, mirroring getTransactions().

export interface ReportFilters {
  startDate: string; // ISO YYYY-MM-DD, inclusive
  endDate: string; // ISO YYYY-MM-DD, inclusive
  branchId: string; // a Branch.id, or 'all'
}

/** Default filters: the current month to date, all branches. */
export function defaultReportFilters(): ReportFilters {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
    branchId: 'all',
  };
}

export interface BranchOption {
  id: string;
  name: string;
}

export function getBranchOptions(): BranchOption[] {
  return getBranches().map((b) => ({ id: b.id, name: b.name }));
}

function inDateRange(iso: string, filters: ReportFilters): boolean {
  const day = iso.slice(0, 10);
  return day >= filters.startDate && day <= filters.endDate;
}

function matchesBranch(branchId: string | undefined, filters: ReportFilters): boolean {
  if (filters.branchId === 'all') return true;
  return !branchId || branchId === filters.branchId;
}

function withinFilters(createdAt: string, branchId: string | undefined, filters: ReportFilters): boolean {
  return inDateRange(createdAt, filters) && matchesBranch(branchId, filters);
}

export function getFilteredSales(filters: ReportFilters): Sale[] {
  return getAllSalesForReporting().filter((s) => withinFilters(s.createdAt, s.branchId, filters));
}

export function getFilteredFnbOrders(filters: ReportFilters): FnbOrder[] {
  return getAllFnbOrdersForReporting().filter((o) => withinFilters(o.createdAt, o.branchId, filters));
}

export function getFilteredMerchOrders(filters: ReportFilters): MerchOrder[] {
  return getAllMerchOrdersForReporting().filter((o) => withinFilters(o.createdAt, o.branchId, filters));
}

/**
 * True when a Sale carries a drop-off / nanny service line. Matches the
 * EXACT catalog id ('svc-dropoff' — see mockApi.ts seed) rather than a
 * generic 'svc-' prefix: camp/event passes sold at the till also use a
 * synthetic 'svc-camp-pass' / 'svc-event-pass' ticketType id (lib/eventPass.ts)
 * and must NOT be counted as drop-off revenue.
 */
export function isDropOffSale(sale: Sale): boolean {
  return sale.lines.some((l) => l.ticketType.id === 'svc-dropoff');
}

/** True when a Sale is a camp/event day-pass sold at the till (lib/eventPass.ts sellEventPass). */
function isEventPassLine(ticketTypeId: string): boolean {
  return ticketTypeId === 'svc-camp-pass' || ticketTypeId === 'svc-event-pass';
}

// ── Tax re-derivation (never store parallel tax math — always recompute
// through the engine, exactly like TransactionDetail.tsx does for a single
// receipt). Each breakdown is the engine's own, in satang. ─────────────────

export function saleTaxBreakdown(sale: Sale, config = getTaxConfig()): TaxBreakdown {
  return ticketTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts, { config }).satang
    .taxBreakdown;
}

export function fnbOrderTaxBreakdown(order: FnbOrder, config = getTaxConfig()): TaxBreakdown {
  return itemOrderTotals(order.lines, order.manualDiscounts, { config }).satang.taxBreakdown;
}

export function merchOrderTaxBreakdown(order: MerchOrder, config = getTaxConfig()): TaxBreakdown {
  return itemOrderTotals(order.lines, order.manualDiscounts, { config }).satang.taxBreakdown;
}

/** Net-of-refunds satang for any recorded transaction (refunds always reduce, never negative). */
export function netAfterRefunds(total: number, refunds: { amountTHB: number }[]): Satang {
  const refunded = refunds.reduce((sum, r) => sum + toSatang(r.amountTHB), 0);
  return Math.max(0, toSatang(total) - refunded);
}

// ── 1. Sales reports ─────────────────────────────────────────────────────

export interface CategoryTotal {
  category: TaxableCategory;
  grossRevenueSatang: Satang; // sum of category gross (post tax/service, pre-order-level refund)
  taxCollectedSatang: Satang;
  serviceChargeSatang: Satang;
  count: number; // number of source transactions contributing to this category
  /** This category's share of total gross revenue across all categories, 0-100. */
  pctShare: number;
}

/** Revenue broken down by taxable category, across tickets + drop-off + F&B + merch. */
export function salesByCategory(filters: ReportFilters): CategoryTotal[] {
  const config = getTaxConfig();
  const byCategory = new Map<TaxableCategory, Omit<CategoryTotal, 'pctShare'>>();
  const bump = (category: TaxableCategory, gross: Satang, tax: Satang, service: Satang) => {
    const cur = byCategory.get(category) ?? {
      category,
      grossRevenueSatang: 0,
      taxCollectedSatang: 0,
      serviceChargeSatang: 0,
      count: 0,
    };
    cur.grossRevenueSatang += gross;
    cur.taxCollectedSatang += tax;
    cur.serviceChargeSatang += service;
    cur.count += 1;
    byCategory.set(category, cur);
  };

  for (const sale of getFilteredSales(filters)) {
    const bd = saleTaxBreakdown(sale, config);
    for (const c of bd.categories) {
      bump(c.category, c.gross, c.tax + c.secondaryTax, c.serviceCharge);
    }
  }
  for (const order of getFilteredFnbOrders(filters)) {
    const bd = fnbOrderTaxBreakdown(order, config);
    for (const c of bd.categories) {
      bump(c.category, c.gross, c.tax + c.secondaryTax, c.serviceCharge);
    }
  }
  for (const order of getFilteredMerchOrders(filters)) {
    const bd = merchOrderTaxBreakdown(order, config);
    for (const c of bd.categories) {
      bump(c.category, c.gross, c.tax + c.secondaryTax, c.serviceCharge);
    }
  }

  const totalGross = [...byCategory.values()].reduce((s, c) => s + c.grossRevenueSatang, 0);
  return [...byCategory.values()]
    .map((c) => ({ ...c, pctShare: totalGross > 0 ? (c.grossRevenueSatang / totalGross) * 100 : 0 }))
    .sort((a, b) => b.grossRevenueSatang - a.grossRevenueSatang);
}

export interface PaymentMixRow {
  method: string;
  amountSatang: Satang;
  count: number;
}

/** Payment-method mix across tickets (single `paymentMethod` token) + F&B/merch (split payment). */
export function paymentMix(filters: ReportFilters): PaymentMixRow[] {
  const byMethod = new Map<string, PaymentMixRow>();
  const bump = (method: string, amount: Satang) => {
    if (amount <= 0) return;
    const cur = byMethod.get(method) ?? { method, amountSatang: 0, count: 0 };
    cur.amountSatang += amount;
    cur.count += 1;
    byMethod.set(method, cur);
  };

  for (const sale of getFilteredSales(filters)) {
    bump(sale.paymentMethod ?? 'unknown', netAfterRefunds(sale.total, sale.refunds));
  }
  for (const order of getFilteredFnbOrders(filters)) {
    bump('cash', toSatang(order.payment.cash));
    bump('card', toSatang(order.payment.card));
    bump('promptpay', toSatang(order.payment.promptpay));
    bump('wallet_credit', toSatang(order.payment.creditUsed));
  }
  for (const order of getFilteredMerchOrders(filters)) {
    bump('cash', toSatang(order.payment.cash));
    bump('card', toSatang(order.payment.card));
    bump('promptpay', toSatang(order.payment.promptpay));
    bump('wallet_credit', toSatang(order.payment.creditUsed));
  }

  return [...byMethod.values()].sort((a, b) => b.amountSatang - a.amountSatang);
}

export interface TicketTierRow {
  tier: string;
  ticketRevenueSatang: Satang;
  dropOffRevenueSatang: Satang;
  saleCount: number;
}

/** Ticket sales split by customer tier, separating regular play revenue from drop-off fees. */
export function ticketSalesByTier(filters: ReportFilters): TicketTierRow[] {
  const byTier = new Map<string, TicketTierRow>();
  for (const sale of getFilteredSales(filters)) {
    const cur = byTier.get(sale.tier) ?? {
      tier: sale.tier,
      ticketRevenueSatang: 0,
      dropOffRevenueSatang: 0,
      saleCount: 0,
    };
    const bd = saleTaxBreakdown(sale);
    const dropOff = bd.categories.find((c) => c.category === 'drop_off')?.gross ?? 0;
    const ticket = bd.grandTotal - dropOff;
    cur.ticketRevenueSatang += ticket;
    cur.dropOffRevenueSatang += dropOff;
    cur.saleCount += 1;
    byTier.set(sale.tier, cur);
  }
  return [...byTier.values()].sort(
    (a, b) =>
      b.ticketRevenueSatang + b.dropOffRevenueSatang - (a.ticketRevenueSatang + a.dropOffRevenueSatang),
  );
}

export interface ItemSalesRow {
  itemId: string;
  name: string;
  qty: number;
  revenueSatang: Satang;
}

/** F&B item sales, aggregated by menu item across all filtered orders. */
export function fnbSalesByItem(filters: ReportFilters): ItemSalesRow[] {
  const byItem = new Map<string, ItemSalesRow>();
  for (const order of getFilteredFnbOrders(filters)) {
    for (const line of order.lines) {
      const cur = byItem.get(line.menuItem.id) ?? {
        itemId: line.menuItem.id,
        name: line.menuItem.name,
        qty: 0,
        revenueSatang: 0,
      };
      cur.qty += line.qty;
      cur.revenueSatang += toSatang(line.lineTotal);
      byItem.set(line.menuItem.id, cur);
    }
  }
  return [...byItem.values()].sort((a, b) => b.revenueSatang - a.revenueSatang);
}

/** Merch item sales, aggregated by item across all filtered orders. */
export function merchSalesByItem(filters: ReportFilters): ItemSalesRow[] {
  const byItem = new Map<string, ItemSalesRow>();
  for (const order of getFilteredMerchOrders(filters)) {
    for (const line of order.lines) {
      const cur = byItem.get(line.merchItem.id) ?? {
        itemId: line.merchItem.id,
        name: line.merchItem.name,
        qty: 0,
        revenueSatang: 0,
      };
      cur.qty += line.qty;
      cur.revenueSatang += toSatang(line.lineTotal);
      byItem.set(line.merchItem.id, cur);
    }
  }
  return [...byItem.values()].sort((a, b) => b.revenueSatang - a.revenueSatang);
}

export interface TicketTypeSalesRow {
  ticketTypeId: string;
  name: string;
  lineCount: number;
  kids: number;
  adults: number;
  revenueSatang: Satang; // sum of lineTotal (ticket + socks + addOns for that line, excludes drop-off fee)
}

/**
 * Revenue by catalog ticket type (per task-232's "ticket-type breakdown").
 * Reads sale.lines directly — excludes the synthetic drop-off ('svc-dropoff')
 * and event-pass ('svc-camp-pass'/'svc-event-pass') service lines, which are
 * their own reports below, and excludes promo-item stub lines (kids=adults=0).
 */
export function ticketTypeSalesRows(filters: ReportFilters): TicketTypeSalesRow[] {
  const byType = new Map<string, TicketTypeSalesRow>();
  for (const sale of getFilteredSales(filters)) {
    for (const line of sale.lines) {
      if (line.promoItem) continue;
      if (line.ticketType.id === 'svc-dropoff' || isEventPassLine(line.ticketType.id)) continue;
      const cur = byType.get(line.ticketType.id) ?? {
        ticketTypeId: line.ticketType.id,
        name: line.ticketType.name,
        lineCount: 0,
        kids: 0,
        adults: 0,
        revenueSatang: 0,
      };
      cur.lineCount += 1;
      cur.kids += line.kids;
      cur.adults += line.adults;
      cur.revenueSatang += toSatang(line.lineTotal);
      byType.set(line.ticketType.id, cur);
    }
  }
  return [...byType.values()].sort((a, b) => b.revenueSatang - a.revenueSatang);
}

export interface WeekdayWeekendRow {
  mode: RateMode;
  saleCount: number;
  revenueSatang: Satang;
}

/**
 * Ticket revenue split by weekday vs weekend rate mode (lib/pricingMode.ts —
 * the same mode the till locked in at sale time via createdAt's date), per
 * task-232's "weekday/weekend split". Uses total sale revenue (grandTotal),
 * not just ticket lines, since the whole sale was priced under one mode.
 */
export function ticketWeekdayWeekendSplit(filters: ReportFilters): WeekdayWeekendRow[] {
  const byMode = new Map<RateMode, WeekdayWeekendRow>();
  for (const sale of getFilteredSales(filters)) {
    const mode = getRateModeForDate(new Date(sale.createdAt)).mode;
    const cur = byMode.get(mode) ?? { mode, saleCount: 0, revenueSatang: 0 };
    cur.saleCount += 1;
    cur.revenueSatang += saleTaxBreakdown(sale).grandTotal;
    byMode.set(mode, cur);
  }
  return [...byMode.values()].sort((a, b) => b.revenueSatang - a.revenueSatang);
}

export interface EventCampRevenueRow {
  eventId: string;
  name: string;
  type: 'camp' | 'event';
  date: string;
  passesSold: number;
  attended: number;
  /**
   * ESTIMATE, not a ledger total: till-sold event passes (lib/eventPass.ts
   * sellEventPass) are recorded as ordinary Sale records with no eventId back-
   * link, so exact per-event revenue can't be re-derived from the sales
   * ledger. This is passesSold × the event's CURRENT entryPriceTHB (resolved
   * for the event's date's rate mode) — flagged in the UI as an estimate.
   */
  estimatedRevenueSatang: Satang;
}

/** Camp/event attendance + estimated revenue, read from OtoEvent.attendees (the exact roster). */
export function eventCampRevenueRows(filters: ReportFilters): EventCampRevenueRow[] {
  return getAllEventsForReporting()
    .filter((e) => withinFilters(e.date, e.branchId, filters))
    .map((e) => {
      const attendees = e.attendees ?? [];
      const passesSold = attendees.length;
      const attended = attendees.filter((a) =>
        Object.values(a.checkinByDate ?? {}).some((c) => !!c?.checkedInAt),
      ).length;
      const mode = getRateModeForDate(new Date(e.date)).mode;
      const priceNow = e.entryPriceTHB ? resolveRate(e.entryPriceTHB, mode) : 0;
      return {
        eventId: e.id,
        name: e.title,
        type: e.type as 'camp' | 'event',
        date: e.date,
        passesSold,
        attended,
        estimatedRevenueSatang: passesSold * toSatang(priceNow),
      };
    })
    .sort((a, b) => b.estimatedRevenueSatang - a.estimatedRevenueSatang);
}

export interface DropOffNannyRow {
  service: 'drop_off' | 'nanny';
  sessionCount: number;
  totalHours: number;
  feesSatang: Satang;
}

/** Drop-off / nanny session volume + fees, read from each sale's DropOffLine (the buildSale gotcha's bare CartLine). */
export function dropOffNannyRevenueRows(filters: ReportFilters): DropOffNannyRow[] {
  const byService = new Map<'drop_off' | 'nanny', DropOffNannyRow>();
  for (const sale of getFilteredSales(filters)) {
    for (const line of sale.lines) {
      const d = line.dropOff;
      if (!d || (d.service !== 'drop_off' && d.service !== 'nanny')) continue;
      const cur = byService.get(d.service) ?? { service: d.service, sessionCount: 0, totalHours: 0, feesSatang: 0 };
      cur.sessionCount += 1;
      cur.totalHours += d.hours;
      cur.feesSatang += toSatang(d.serviceFeeTHB);
      byService.set(d.service, cur);
    }
  }
  return [...byService.values()].sort((a, b) => b.feesSatang - a.feesSatang);
}

// ── 2. Profitability (F&B + merch COGS) ─────────────────────────────────
// F&B COGS reads InventoryItem.unitCostTHB (the stock module's per-unit cost,
// Admin → Stock), joined back to the menu item via
// InventoryItem.linkedKind==='menu' && linkedId===MenuItem.id — NOT
// MenuItem.cost (that field only backs the stock-value snapshot elsewhere).
// Merch COGS still reads MerchItem.cost; merch has no InventoryItem link for
// a per-unit landed cost in the catalog today. Items with no cost tracked are
// flagged so margin isn't silently understated.

export interface ProfitabilityRow {
  itemId: string;
  name: string;
  qty: number;
  revenueSatang: Satang;
  cogsSatang: Satang;
  marginSatang: Satang; // revenue - cogs
  marginPercent: number; // 0 when revenue is 0
  costTracked: boolean; // false = no cost set on the catalog item (cogs is 0, not "free")
}

export function fnbProfitability(filters: ReportFilters): ProfitabilityRow[] {
  const menuCostByItemId = new Map<string, number>();
  for (const inv of getInventory()) {
    if (inv.linkedKind === 'menu' && inv.unitCostTHB !== undefined) {
      menuCostByItemId.set(inv.linkedId, inv.unitCostTHB);
    }
  }
  return fnbSalesByItem(filters).map((row) => {
    const unitCost = menuCostByItemId.get(row.itemId);
    const costTracked = unitCost !== undefined;
    const cogs = costTracked ? toSatang(unitCost!) * row.qty : 0;
    const margin = row.revenueSatang - cogs;
    return {
      ...row,
      cogsSatang: cogs,
      marginSatang: margin,
      marginPercent: row.revenueSatang > 0 ? (margin / row.revenueSatang) * 100 : 0,
      costTracked,
    };
  });
}

export function merchProfitability(filters: ReportFilters): ProfitabilityRow[] {
  const catalog = new Map(getMerchItems().map((m) => [m.id, m]));
  return merchSalesByItem(filters).map((row) => {
    const item = catalog.get(row.itemId);
    const costTracked = item?.cost !== undefined;
    const cogs = costTracked ? toSatang(item!.cost ?? 0) * row.qty : 0;
    const margin = row.revenueSatang - cogs;
    return {
      ...row,
      cogsSatang: cogs,
      marginSatang: margin,
      marginPercent: row.revenueSatang > 0 ? (margin / row.revenueSatang) * 100 : 0,
      costTracked,
    };
  });
}

/**
 * S2-14b round 4 — COST OF GOODS FROM THE STOCK LEDGER, per product: what the
 * platform's sales of it took net of refunds, at the cost FROZEN on each sale
 * line when it sold (`GET /branches/:id/stock/reports/cost-of-goods`) — not the
 * catalogue's cost today, which the prototype read (`lib/reporting.ts:423-475`)
 * and which moves under every past sale when a manager edits it.
 */
export interface LedgerCost {
  quantity: number;
  cogsSatang: Satang;
  costTracked: boolean;
}

/**
 * The ledger's cost of goods over the report's range: one branch, or every
 * branch the platform knows ('all'). Null when there is nothing to read (a
 * branch known only on this device) — the rows then keep the catalogue's cost.
 */
export async function platformCostOfGoods(filters: ReportFilters): Promise<Map<string, LedgerCost> | null> {
  const branches = getBranches().filter((b) => (filters.branchId === 'all' || b.id === filters.branchId) && b.apiId);
  if (branches.length === 0) return null;
  const answers = await Promise.all(
    branches.map((b) => fetchCostOfGoods(b.apiId!, filters.startDate, filters.endDate)),
  );
  const out = new Map<string, LedgerCost>();
  for (const answer of answers) {
    for (const row of answer.rows) {
      const held = out.get(row.productId) ?? { quantity: 0, cogsSatang: 0, costTracked: true };
      held.quantity += row.quantity;
      held.cogsSatang += row.cogsSatang;
      held.costTracked = held.costTracked && row.costTracked;
      out.set(row.productId, held);
    }
  }
  return out;
}

/**
 * THE PROFITABILITY ROWS ON THE LEDGER'S COST. A row the ledger holds takes
 * its frozen cost: exactly the ledger's figure when the units agree, else the
 * ledger's cost per unit over the row's own units (the sales this report's
 * revenue reads may be fewer than the ledger's). A row the ledger does not hold
 * keeps the catalogue's cost, flagged as before when there is none.
 */
export function withLedgerCost(rows: readonly ProfitabilityRow[], ledger: ReadonlyMap<string, LedgerCost> | null): ProfitabilityRow[] {
  if (!ledger) return [...rows];
  return rows.map((row) => {
    const held = ledger.get(row.itemId);
    if (!held || held.quantity <= 0) return row;
    const cogs = held.quantity === row.qty ? held.cogsSatang : Math.round((held.cogsSatang * row.qty) / held.quantity);
    const margin = row.revenueSatang - cogs;
    return {
      ...row,
      cogsSatang: cogs,
      marginSatang: margin,
      marginPercent: row.revenueSatang > 0 ? (margin / row.revenueSatang) * 100 : 0,
      costTracked: held.costTracked,
    };
  });
}

// ── 3. Wallet / F&B credit ledger ────────────────────────────────────────
// Wristband.creditBalanceTHB is the single source of truth for the live
// balance; `ledger` is the audit trail we read here. NOTE: Wristband records
// are not branch-tagged in the data model, so this report is network-wide
// regardless of the branch filter (flagged in the UI).

export interface WalletLedgerSummary {
  grantedSatang: Satang;
  spentSatang: Satang;
  refundedSatang: Satang;
  expiredSatang: Satang;
  netOutstandingSatang: Satang; // sum of live creditBalanceTHB across all bands (today's snapshot, not date-ranged)
  entryCount: number;
  /** S2-14a round 3 — expired credit a manager brought back (the platform's own entry kind; the mock has none). */
  reactivatedSatang?: Satang;
  /** S2-14a round 3 — the ledger's own sum of what is outstanding; equals netOutstandingSatang on the platform. */
  ledgerOutstandingSatang?: Satang;
}

export function walletCreditSummary(filters: ReportFilters): WalletLedgerSummary {
  const bands: Wristband[] = getMockWristbands();
  let granted = 0;
  let spent = 0;
  let refunded = 0;
  let expired = 0;
  let entryCount = 0;

  for (const band of bands) {
    for (const entry of band.ledger ?? []) {
      if (!inDateRange(entry.at, filters)) continue;
      entryCount += 1;
      const amt = toSatang(entry.amountTHB);
      if (entry.kind === 'grant') granted += amt;
      else if (entry.kind === 'spend') spent += Math.abs(amt);
      else if (entry.kind === 'refund') refunded += amt;
      else if (entry.kind === 'expire') expired += Math.abs(amt);
    }
  }

  const netOutstandingSatang = bands.reduce((sum, b) => sum + toSatang(b.creditBalanceTHB || 0), 0);

  return {
    grantedSatang: granted,
    spentSatang: spent,
    refundedSatang: refunded,
    expiredSatang: expired,
    netOutstandingSatang,
    entryCount,
  };
}

export interface WalletLedgerRow {
  wristbandCode: string;
  customerNickname: string;
  /** S2-14a round 3 — the platform's ledger adds `reactivate`. */
  kind: WalletEntry['kind'] | 'reactivate';
  amountSatang: Satang;
  source: string;
  at: string;
  by?: string;
}

export function walletLedgerRows(filters: ReportFilters): WalletLedgerRow[] {
  const rows: WalletLedgerRow[] = [];
  for (const band of getMockWristbands()) {
    for (const entry of band.ledger ?? []) {
      if (!inDateRange(entry.at, filters)) continue;
      rows.push({
        wristbandCode: band.code,
        customerNickname: band.customerNickname,
        kind: entry.kind,
        amountSatang: toSatang(entry.amountTHB),
        source: entry.source,
        at: entry.at,
        by: entry.by,
      });
    }
  }
  return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/**
 * S2-14a round 3 — THE WALLET REPORT, OFF MOCK. The platform's ledger in the
 * prototype's two shapes (`WalletLedgerSummary`, `WalletLedgerRow`), so the
 * panel's visuals stay exactly as they were: granted / spent / refunded /
 * expired over the range's business dates, the live-balance snapshot, and the
 * newest entries. The ledger IS branch-tagged now (a wallet belongs to the park
 * that issued it), so the branch filter applies: 'all' asks for every park
 * this account reads reports for. A branch the console only knows locally
 * (no platform id) has no platform figures and reads as empty.
 *
 * `walletCreditSummary` / `walletLedgerRows` above are the prototype's mock
 * path, kept for the parity fixture; the panel no longer reads them.
 */
export interface WalletCreditReport {
  summary: WalletLedgerSummary;
  rows: WalletLedgerRow[];
  /** Entries in range beyond the rows returned. */
  totalEntries: number;
}

export async function platformWalletCreditReport(filters: ReportFilters, limit = 100): Promise<WalletCreditReport> {
  let branchApiId: string | null = null;
  if (filters.branchId !== 'all') {
    branchApiId = getBranches().find((b) => b.id === filters.branchId)?.apiId ?? null;
    if (!branchApiId) {
      return {
        summary: { grantedSatang: 0, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, netOutstandingSatang: 0, entryCount: 0 },
        rows: [],
        totalEntries: 0,
      };
    }
  }
  const { summary, rows } = await getWalletReport({ branchApiId, from: filters.startDate, to: filters.endDate, limit });
  return {
    summary: {
      grantedSatang: summary.grantedSatang,
      spentSatang: summary.spentSatang,
      refundedSatang: summary.refundedSatang,
      expiredSatang: summary.expiredSatang,
      reactivatedSatang: summary.reactivatedSatang,
      netOutstandingSatang: summary.outstandingSatang,
      ledgerOutstandingSatang: summary.ledgerOutstandingSatang,
      entryCount: summary.entryCount,
    },
    rows: rows.map((r) => ({
      wristbandCode: r.keyDisplay,
      customerNickname: r.holderName ?? 'Guest',
      kind: r.kind,
      amountSatang: r.amountSatang,
      source: r.source,
      at: r.at,
      ...(r.by ? { by: r.by } : {}),
    })),
    totalEntries: summary.entryCount,
  };
}

// ── 4. Promo / discount usage ────────────────────────────────────────────

export interface PromoUsageRow {
  code: string;
  label: string;
  type: Discount['type'];
  usedCount: number;
  usageLimit?: number;
  active: boolean;
  /** Total discount value (satang) redeemed under this code within the filtered date range/branch. */
  totalDiscountValueSatang: Satang;
}

/**
 * Promo-code usage as tracked on the catalog Discount records (usedCount/usageLimit
 * are lifetime, network-wide counters on the catalog record itself), joined with the
 * ฿ discount value actually redeemed within the filtered range (from promoDiscountImpact,
 * the same scanned-code ledger the Discount/Comp report uses — no parallel math).
 */
export function promoUsageSummary(filters: ReportFilters): PromoUsageRow[] {
  const valueByCode = new Map<string, Satang>();
  for (const row of promoDiscountImpact(filters)) {
    valueByCode.set(row.code, (valueByCode.get(row.code) ?? 0) + row.amountSatang);
  }
  return getDiscounts()
    .filter((d) => (d.usedCount ?? 0) > 0 || d.usageLimit !== undefined)
    .map((d) => ({
      code: d.code,
      label: d.label,
      type: d.type,
      usedCount: d.usedCount ?? 0,
      usageLimit: d.usageLimit,
      active: d.active !== false,
      totalDiscountValueSatang: valueByCode.get(d.code) ?? 0,
    }))
    .sort((a, b) => b.usedCount - a.usedCount);
}

// ── 5. Discount / comp impact ────────────────────────────────────────────

export interface DiscountImpactRow {
  source: 'sale' | 'fnb' | 'merch';
  transactionId: string;
  createdAt: string;
  operatorName: string;
  type: ManualDiscount['type'];
  reason: string;
  note?: string;
  amountSatang: Satang;
  appliedBy: string;
}

/** Every manual discount / comp applied within the filtered range, per transaction. */
export function discountAndCompImpact(filters: ReportFilters): DiscountImpactRow[] {
  const rows: DiscountImpactRow[] = [];
  for (const sale of getFilteredSales(filters)) {
    for (const md of sale.manualDiscounts) {
      rows.push({
        source: 'sale',
        transactionId: sale.id,
        createdAt: sale.createdAt,
        operatorName: sale.operatorName,
        type: md.type,
        reason: md.reason,
        note: md.note,
        amountSatang: toSatang(md.amountTHB),
        appliedBy: md.appliedBy,
      });
    }
  }
  for (const order of getFilteredFnbOrders(filters)) {
    for (const md of order.manualDiscounts) {
      rows.push({
        source: 'fnb',
        transactionId: order.id,
        createdAt: order.createdAt,
        operatorName: order.operatorName,
        type: md.type,
        reason: md.reason,
        note: md.note,
        amountSatang: toSatang(md.amountTHB),
        appliedBy: md.appliedBy,
      });
    }
  }
  for (const order of getFilteredMerchOrders(filters)) {
    for (const md of order.manualDiscounts) {
      rows.push({
        source: 'merch',
        transactionId: order.id,
        createdAt: order.createdAt,
        operatorName: order.operatorName,
        type: md.type,
        reason: md.reason,
        note: md.note,
        amountSatang: toSatang(md.amountTHB),
        appliedBy: md.appliedBy,
      });
    }
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export interface PromoDiscountImpactRow {
  transactionId: string;
  createdAt: string;
  operatorName: string;
  code: string;
  label: string;
  type: Discount['type'];
  amountSatang: Satang;
}

/**
 * Scanned promo-code impact (separate from manual comps/discounts above).
 * FnbOrder/MerchOrder carry no `discounts` field — only ticket sales apply
 * promo codes today — so this is ticket-only. Re-derives each code's
 * contribution via the engine's applied promos (`ticketTotals`; never
 * re-implements the discount math here).
 */
export function promoDiscountImpact(filters: ReportFilters): PromoDiscountImpactRow[] {
  const rows: PromoDiscountImpactRow[] = [];
  for (const sale of getFilteredSales(filters)) {
    if (!sale.discounts || sale.discounts.length === 0) continue;
    const { appliedPromos } = ticketTotals(sale.lines, sale.discounts, sale.manualDiscounts).satang;
    for (const sd of appliedPromos) {
      if (sd.amount <= 0) continue;
      rows.push({
        transactionId: sale.id,
        createdAt: sale.createdAt,
        operatorName: sale.operatorName,
        code: sd.code,
        label: sd.label,
        type: sd.type,
        amountSatang: sd.amount,
      });
    }
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export interface CompByOperatorRow {
  appliedBy: string;
  compCount: number;
  compTotalSatang: Satang;
  discountCount: number;
  discountTotalSatang: Satang;
}

/** Manual discounts/comps grouped per operator, for the "who's granting comps" view. */
export function discountImpactByOperator(filters: ReportFilters): CompByOperatorRow[] {
  const byOperator = new Map<string, CompByOperatorRow>();
  for (const row of discountAndCompImpact(filters)) {
    const cur = byOperator.get(row.appliedBy) ?? {
      appliedBy: row.appliedBy,
      compCount: 0,
      compTotalSatang: 0,
      discountCount: 0,
      discountTotalSatang: 0,
    };
    if (row.type === 'comp') {
      cur.compCount += 1;
      cur.compTotalSatang += row.amountSatang;
    } else {
      cur.discountCount += 1;
      cur.discountTotalSatang += row.amountSatang;
    }
    byOperator.set(row.appliedBy, cur);
  }
  return [...byOperator.values()].sort(
    (a, b) => b.compTotalSatang + b.discountTotalSatang - (a.compTotalSatang + a.discountTotalSatang),
  );
}

export interface PromoImpactByTypeRow {
  type: Discount['type'];
  count: number;
  amountSatang: Satang;
}

/**
 * Scanned promo-code impact grouped by discount type, so 'free_item' redemptions
 * (a benefit — the guest gets a menu/merch item at ฿0, valued at the item's cart
 * price via the engine's applied promos) are broken out and attributable
 * separately from straightforward percent/fixed money-off codes. This is the
 * benefit/credit-consumption side of "discount and comp impact" — free_item value
 * is already computed by the tax engine's scannedDiscounts, never re-derived here.
 */
export function promoDiscountImpactByType(filters: ReportFilters): PromoImpactByTypeRow[] {
  const byType = new Map<Discount['type'], PromoImpactByTypeRow>();
  for (const row of promoDiscountImpact(filters)) {
    const cur = byType.get(row.type) ?? { type: row.type, count: 0, amountSatang: 0 };
    cur.count += 1;
    cur.amountSatang += row.amountSatang;
    byType.set(row.type, cur);
  }
  return [...byType.values()].sort((a, b) => b.amountSatang - a.amountSatang);
}

// ── 6. Tax receipts + VAT summary ────────────────────────────────────────

export interface TaxReceiptRow {
  kind: 'ticket' | 'fnb' | 'merch';
  transactionId: string;
  createdAt: string;
  branchId?: string;
  operatorName: string;
  netSubtotalSatang: Satang;
  serviceChargeSatang: Satang;
  taxTotalSatang: Satang;
  grandTotalSatang: Satang;
  taxSummaryLabel: string; // e.g. "VAT ฿12.34, Service ฿5.00"
  /** Every taxable category this transaction touched (for the category filter + CSV column). */
  categories: TaxableCategory[];
  /**
   * Dominant tender for this transaction. Ticket sales carry one
   * `paymentMethod` token; F&B/merch orders split across cash/card/promptpay/
   * credit tenders — 'split' when more than one tender has a nonzero amount,
   * otherwise the single nonzero tender (or 'unknown' if none recorded).
   */
  paymentMethod: string;
}

function dominantTender(payment: { cash: number; card: number; promptpay: number; creditUsed: number }): string {
  const all: [string, number][] = [
    ['cash', payment.cash],
    ['card', payment.card],
    ['promptpay', payment.promptpay],
    ['wallet_credit', payment.creditUsed],
  ];
  const tenders = all.filter(([, amt]) => amt > 0);
  if (tenders.length === 0) return 'unknown';
  if (tenders.length === 1) return tenders[0][0];
  return 'split';
}

/**
 * "VAT included ฿4.58": one transaction's receipt rows as the export's label
 * column prints them — summed in satang by the engine and formatted here, the
 * one place this file writes a baht figure, in the words and the two decimals
 * the prototype's label used.
 */
function taxSummaryLabel(breakdown: TaxBreakdown): string {
  return summarizeTax(breakdown)
    .map((row) => `${row.label} ฿${(row.amount / 100).toFixed(2)}`)
    .join('; ');
}

export interface TaxReportFilters extends ReportFilters {
  category?: TaxableCategory | 'all';
  paymentMethod?: string | 'all';
}

/**
 * One row per filtered transaction, with its recomputed tax breakdown — the
 * source for the bulk tax-receipt export. `category`/`paymentMethod` narrow
 * to transactions that touched that category / were paid via that tender
 * (both default to 'all').
 *
 * Note: this is a prototype export shell — it re-derives numbers already on
 * file for the accountant's reference; it is NOT a fiscal e-receipt/e-tax
 * invoice (Thai VAT e-Tax Invoice/e-Receipt requires signed, backend-issued
 * documents). Wiring a real e-receipt provider is backend work, out of scope here.
 */
export function taxReceiptRows(filters: TaxReportFilters): TaxReceiptRow[] {
  const rows: TaxReceiptRow[] = [];
  const config = getTaxConfig();
  const categoryFilter = filters.category ?? 'all';
  const paymentFilter = filters.paymentMethod ?? 'all';

  const passesFilters = (categories: TaxableCategory[], paymentMethod: string) => {
    if (categoryFilter !== 'all' && !categories.includes(categoryFilter)) return false;
    if (paymentFilter !== 'all' && paymentMethod !== paymentFilter) return false;
    return true;
  };

  for (const sale of getFilteredSales(filters)) {
    const bd = saleTaxBreakdown(sale, config);
    const categories = bd.categories.map((c) => c.category);
    const paymentMethod = sale.paymentMethod ?? 'unknown';
    if (!passesFilters(categories, paymentMethod)) continue;
    rows.push({
      kind: 'ticket',
      transactionId: sale.id,
      createdAt: sale.createdAt,
      branchId: sale.branchId,
      operatorName: sale.operatorName,
      netSubtotalSatang: bd.netSubtotal,
      serviceChargeSatang: bd.serviceChargeTotal,
      taxTotalSatang: bd.taxTotal,
      grandTotalSatang: bd.grandTotal,
      taxSummaryLabel: taxSummaryLabel(bd),
      categories,
      paymentMethod,
    });
  }
  for (const order of getFilteredFnbOrders(filters)) {
    const bd = fnbOrderTaxBreakdown(order, config);
    const categories = bd.categories.map((c) => c.category);
    const paymentMethod = dominantTender(order.payment);
    if (!passesFilters(categories, paymentMethod)) continue;
    rows.push({
      kind: 'fnb',
      transactionId: order.id,
      createdAt: order.createdAt,
      branchId: order.branchId,
      operatorName: order.operatorName,
      netSubtotalSatang: bd.netSubtotal,
      serviceChargeSatang: bd.serviceChargeTotal,
      taxTotalSatang: bd.taxTotal,
      grandTotalSatang: bd.grandTotal,
      taxSummaryLabel: taxSummaryLabel(bd),
      categories,
      paymentMethod,
    });
  }
  for (const order of getFilteredMerchOrders(filters)) {
    const bd = merchOrderTaxBreakdown(order, config);
    const categories = bd.categories.map((c) => c.category);
    const paymentMethod = dominantTender(order.payment);
    if (!passesFilters(categories, paymentMethod)) continue;
    rows.push({
      kind: 'merch',
      transactionId: order.id,
      createdAt: order.createdAt,
      branchId: order.branchId,
      operatorName: order.operatorName,
      netSubtotalSatang: bd.netSubtotal,
      serviceChargeSatang: bd.serviceChargeTotal,
      taxTotalSatang: bd.taxTotal,
      grandTotalSatang: bd.grandTotal,
      taxSummaryLabel: taxSummaryLabel(bd),
      categories,
      paymentMethod,
    });
  }

  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Every payment-method token seen across filtered transactions, for the tax-receipt filter dropdown. */
export function taxReceiptPaymentMethods(filters: ReportFilters): string[] {
  const set = new Set<string>();
  for (const sale of getFilteredSales(filters)) set.add(sale.paymentMethod ?? 'unknown');
  for (const order of getFilteredFnbOrders(filters)) set.add(dominantTender(order.payment));
  for (const order of getFilteredMerchOrders(filters)) set.add(dominantTender(order.payment));
  return [...set].sort();
}

export interface VatSummaryRow {
  category: TaxableCategory;
  /** Set only when vatSummary() is called with period !== 'range' — the ISO day (YYYY-MM-DD) or month (YYYY-MM) bucket. */
  period?: string;
  netBaseSatang: Satang;
  serviceChargeSatang: Satang;
  exclusiveTaxSatang: Satang;
  inclusiveTaxSatang: Satang;
  grossSatang: Satang;
}

export type VatSummaryPeriod = 'range' | 'day' | 'month';

/** Bucket key for a period grouping: 'range' collapses everything to one bucket, else the ISO day/month prefix. */
function periodKey(iso: string, period: VatSummaryPeriod): string {
  if (period === 'range') return 'range';
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/**
 * Category-level VAT summary across every filtered transaction (for the
 * period VAT return). `period` groups rows by day or by month in addition to
 * category — pass 'range' (default) to collapse the whole filtered date
 * range into one row per category, as before.
 */
export function vatSummary(filters: ReportFilters, period: VatSummaryPeriod = 'range'): VatSummaryRow[] {
  const config = getTaxConfig();
  const byKey = new Map<string, VatSummaryRow>();
  const bump = (breakdown: TaxBreakdown, createdAt: string) => {
    const bucket = periodKey(createdAt, period);
    for (const c of breakdown.categories) {
      const key = `${bucket}::${c.category}`;
      const cur = byKey.get(key) ?? {
        category: c.category,
        period: period === 'range' ? undefined : bucket,
        netBaseSatang: 0,
        serviceChargeSatang: 0,
        exclusiveTaxSatang: 0,
        inclusiveTaxSatang: 0,
        grossSatang: 0,
      };
      cur.netBaseSatang += c.base;
      cur.serviceChargeSatang += c.serviceCharge;
      cur.exclusiveTaxSatang += (c.taxMode === 'exclusive' ? c.tax : 0) + (c.secondaryTaxMode === 'exclusive' ? c.secondaryTax : 0);
      cur.inclusiveTaxSatang += (c.taxMode === 'inclusive' ? c.tax : 0) + (c.secondaryTaxMode === 'inclusive' ? c.secondaryTax : 0);
      cur.grossSatang += c.gross;
      byKey.set(key, cur);
    }
  };

  for (const sale of getFilteredSales(filters)) bump(saleTaxBreakdown(sale, config), sale.createdAt);
  for (const order of getFilteredFnbOrders(filters)) bump(fnbOrderTaxBreakdown(order, config), order.createdAt);
  for (const order of getFilteredMerchOrders(filters)) bump(merchOrderTaxBreakdown(order, config), order.createdAt);

  return [...byKey.values()].sort((a, b) => {
    if (a.period !== b.period) return (a.period ?? '').localeCompare(b.period ?? '');
    return b.grossSatang - a.grossSatang;
  });
}

// ── S2-15b round 4 — the platform's report rows ─────────────────────────
// The Sales, Profitability, Discounts & Comps and Tax & VAT panels read the
// platform (`GET /analytics/reports/*`, `api/analyticsReports.ts`): the daily
// report rows the rollup writes from the sales ledger, and two date-bounded
// per-transaction lists. The functions above are the prototype's mock path,
// kept for the parity fixture; the panels no longer read them.

/**
 * The platform request a filter bar's state stands for. `all` asks for every
 * park this account reads reports for. A branch this device knows only
 * locally (no platform id) has no platform figures: null, and the panel reads
 * as empty — as the wallet report does.
 */
export function platformReportQuery(filters: ReportFilters): ReportQuery | null {
  if (filters.branchId === 'all') return { from: filters.startDate, to: filters.endDate };
  const apiId = getBranches().find((b) => b.id === filters.branchId)?.apiId;
  return apiId ? { branches: [apiId], from: filters.startDate, to: filters.endDate } : null;
}
