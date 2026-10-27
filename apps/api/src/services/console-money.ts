import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { factWalletLiabilityDaily, refund, sale, type Db } from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  RECON_TOLERANCE,
  addDaysToIsoDate,
  isCalendarDate,
  lineFlag,
  reconVerdict,
  type AnalyticsSummaryRow,
  type Permission,
  type ReconFlag,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { analyticsSummaryOf, operatorBranches, summaryBranchToday, summaryDayCount, type SummaryBranch } from './analytics-summary';
import { discountReportOf, type ReportScope } from './analytics-reports';
import { benefitReportOf } from './analytics-benefits';
import { boothReportOf } from './analytics-booth';
import { audit } from './audit';
import { getEndOfDay } from './end-of-day';
import { hasPermission, type EffectivePermission } from './permissions';
import { accountNames, refundViewOf } from './refund-slices';
import { settlementSummary } from './settlement';
import { withTx, type Exec, type OpContext, type Tx } from './tx';
import { walletReportOf } from './wallet';

/**
 * SCRUM-647 — MONEY OVERSIGHT (S2-23, `docs/progress/SPRINT_2_PLAN.md`
 * "Money oversight"; PLAN P5-5): the owner's read-only view of the money,
 * across parks and tenders, with no ability to move any.
 *
 * NOTHING HERE COMPUTES A FIGURE A SERVICE ALREADY COMPUTES. Each section is a
 * composition of the reader that owns its figures:
 *
 *   sales        `analyticsSummaryOf` — the stored daily summary per park and
 *                business date, by revenue category, with its own provisional
 *                and freshness marks (S2-15b).
 *   refunds      the refund rows through `refundViewOf` / `accountNames`
 *                (S2-11), each with its original sale; voids off the sale row.
 *   discounts    `discountReportOf` (S2-15b reports): comps, manual and promo.
 *   cash         `getEndOfDay` for each park-day, exactly as the POS End of Day
 *                reads it (S2-15a), flagged by `lineFlag` / `reconVerdict`
 *                against `RECON_TOLERANCE` (฿1).
 *   settlement   `settlementSummary` (S2-15a round 3): terminal batches per
 *                TID, imported 2C2P files, unmatched lines and attempts.
 *   wallets      `analytics.fact_wallet_liability_daily` as the job wrote it,
 *                and `walletReportOf`'s live projection beside its ledger sum.
 *   costs        `boothReportOf` (prize cost) and `benefitReportOf` (staff
 *                benefit relief).
 *
 * The integrity panel is the one place with queries of its own, because no
 * service looks for these failures: each is a read over the ledger, in the
 * same terms the owning service uses (`PAYMENT_ATTEMPT_TAKEN_STATUSES`, the
 * pending job's statuses and station rule, the wallet's signed ledger).
 *
 * READ ONLY BY CONSTRUCTION: every section runs inside a `read only`
 * repeatable-read transaction, so a write anywhere under it is refused by
 * Postgres rather than by convention. The audit row of the read is written
 * after, in its own transaction, naming the section and the filters and never
 * a figure; the answer is handed over only once that row is committed.
 */

export const MONEY_RANGE_MAX_DAYS = 31;
/** The most rows any one list on the page carries; `truncated` says when there were more. */
export const MONEY_ROW_LIMIT = 200;
/** The pending job's own statuses (`flagPendingPayments`, services/payments/gateway.ts). */
const PENDING_ATTEMPT_STATUSES = ['sent_to_terminal', 'unknown', 'inquiring'] as const;
const TAKEN = [...PAYMENT_ATTEMPT_TAKEN_STATUSES];

export type MoneySection = 'sales' | 'refunds' | 'discounts' | 'cash' | 'settlement' | 'wallets' | 'costs' | 'integrity';

export interface MoneyQuery {
  operatorId: string;
  effective: EffectivePermission[];
  branchIds?: readonly string[];
  from: string;
  to: string;
  now?: Date;
}

export interface MoneyPark extends SummaryBranch {
  /** Holds `console:money:investigate` here: the row identifiers and trace links are shown. */
  investigate: boolean;
}

export interface MoneyScope {
  from: string;
  to: string;
  branches: Array<{ branchId: string; name: string }>;
  /** Requested parks of this operator left out because the caller cannot read them here. */
  omitted: string[];
}

interface Selected {
  parks: MoneyPark[];
  scope: MoneyScope;
  now: Date;
}

// --- The door -------------------------------------------------------------------------

/** A range of business dates the page can answer: calendar days, in order, at most a month. */
export function assertMoneyRange(from: string, to: string): void {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw errors.badRequest('A date is YYYY-MM-DD and on the calendar.');
  if (from > to) throw errors.badRequest('The start date must not be after the end date.');
  if (summaryDayCount(from, to) > MONEY_RANGE_MAX_DAYS) {
    throw errors.badRequest(`Money oversight reads at most ${MONEY_RANGE_MAX_DAYS} business days at a time.`);
  }
}

/**
 * The parks one read covers: the named ones (foreign or unknown is 404) or
 * every live park by default, cut to those held on `console:money:read` — and,
 * for the integrity panel, on `console:money:investigate` as well. None left
 * is 403. Read inside the section's own snapshot so ownership cannot drift.
 */
export async function moneySelectionOf(tx: Exec, input: MoneyQuery, need: 'read' | 'investigate'): Promise<Selected> {
  assertMoneyRange(input.from, input.to);
  const own = await operatorBranches(tx, input.operatorId);
  const requested = [...new Set(input.branchIds ?? [])];
  const candidates = requested.length
    ? requested.map((id) => {
        const found = own.find((park) => park.id === id);
        if (!found) throw errors.notFound('Branch not found');
        return found;
      })
    : own.filter((park) => park.archivedAt === null);
  const may = (permission: Permission, id: string) =>
    hasPermission(input.effective, permission, { operatorId: input.operatorId, branchId: id });
  const readable = candidates.filter((park) => may('console:money:read', park.id));
  const selected = need === 'investigate' ? readable.filter((park) => may('console:money:investigate', park.id)) : readable;
  if (selected.length === 0) {
    throw new PermissionDeniedError(need === 'investigate' && readable.length > 0 ? 'console:money:investigate' : 'console:money:read');
  }
  const kept = new Set(selected.map((park) => park.id));
  const parks = selected.map((park) => ({ ...park, investigate: may('console:money:investigate', park.id) }));
  return {
    parks,
    now: input.now ?? new Date(),
    scope: {
      from: input.from,
      to: input.to,
      branches: parks.map((park) => ({ branchId: park.id, name: park.name })),
      omitted: requested.filter((id) => !kept.has(id)),
    },
  };
}

/**
 * THE AUDITED READ. The section runs in a read-only snapshot; its record is
 * written after, naming the section and the filters (never a figure), and the
 * answer is returned only once that row is committed — a money read nobody can
 * account for is not handed over.
 */
export async function auditedMoneyRead<T extends { scope: MoneyScope }>(
  db: Db,
  ctx: OpContext & { requestId: string; actorAccountId: string; operatorId: string },
  section: MoneySection,
  requested: { branchIds: readonly string[]; from: string; to: string },
  read: (tx: Tx) => Promise<T>,
): Promise<T> {
  const answer = await db.transaction(read, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  const action = section === 'integrity' ? 'console.money.investigate' : 'console.money.read';
  await withTx(db, ctx, action, async (tx) => {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: ctx.operatorId,
      branchId: ctx.branchId ?? null,
      action,
      entityType: 'console.money',
      entityId: ctx.requestId,
      requestId: ctx.requestId,
      // Which part of the page and what it was filtered to — never the money.
      after: {
        section,
        filters: { branchIds: [...requested.branchIds], from: requested.from, to: requested.to },
        branchIds: answer.scope.branches.map((b) => b.branchId),
        omitted: answer.scope.omitted,
      },
    });
  });
  return answer;
}

// --- Shared helpers --------------------------------------------------------------------

const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const num = (value: unknown): number => Number(value ?? 0);
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
const day = (value: unknown): string => String(value).slice(0, 10);

export type TraceKind = 'sale' | 'refund' | 'payment_attempt' | 'receipt' | 'wallet';

export interface TraceLink {
  kind: TraceKind;
  id: string;
  /** The Console's support trace (SCRUM-648) with this record named in the query. */
  href: string;
}

/** Where a row opens in the support trace. The page lands with SCRUM-648; the address is fixed now. */
export function supportTraceOf(kind: TraceKind, id: string): TraceLink {
  return { kind, id, href: `/support?${new URLSearchParams({ trace: id, kind }).toString()}` };
}

/** Every business date `from`..`to`, oldest first, that has started at this park. */
function startedDays(park: MoneyPark, from: string, to: string, now: Date): string[] {
  const today = summaryBranchToday(park, now);
  const out: string[] = [];
  for (let d = from; d <= to && d <= today; d = addDaysToIsoDate(d, 1)) out.push(d);
  return out;
}

const reportScopeOf = (selected: Selected): ReportScope => ({
  branches: selected.scope.branches,
  omitted: [],
  from: selected.scope.from,
  to: selected.scope.to,
});

// --- Sales --------------------------------------------------------------------------

export interface MoneySalesRow {
  businessDate: string | null;
  provisional: boolean;
  rolledDays: number;
  computedAt: string | null;
  revenueSatang: number;
  ticketsSatang: number;
  fnbSatang: number;
  merchSatang: number;
  partiesSatang: number;
  dropoffSatang: number;
  refundsSatang: number;
  discountsSatang: number;
  compsSatang: number;
  txnCount: number;
}

export interface MoneySales {
  scope: MoneyScope;
  basis: 'stored-daily-summary';
  branches: Array<{
    branchId: string;
    name: string;
    source: string;
    today: string;
    lastRolledUpAt: string | null;
    total: MoneySalesRow;
    days: MoneySalesRow[];
  }>;
  total: MoneySalesRow;
}

function salesRowOf(row: AnalyticsSummaryRow): MoneySalesRow {
  return {
    businessDate: row.businessDate,
    provisional: row.provisional,
    rolledDays: row.rolledDays,
    computedAt: row.computedAt,
    revenueSatang: row.revenueSatang,
    ticketsSatang: row.ticketsSatang,
    fnbSatang: row.fnbSatang,
    merchSatang: row.merchSatang,
    partiesSatang: row.partiesSatang,
    dropoffSatang: row.dropoffSatang,
    refundsSatang: row.refundsSatang,
    discountsSatang: row.discountsSatang,
    compsSatang: row.compsSatang,
    txnCount: row.txnCount,
  };
}

/** Sales per park, business date and revenue category: the stored summary, exactly as Today and Radar read it. */
export async function moneySalesOf(tx: Tx, input: MoneyQuery): Promise<MoneySales> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const base = { branches: selected.parks, readable: selected.parks, mergeable: selected.parks, omitted: [], from: input.from, to: input.to, now: selected.now };
  const byDay = await analyticsSummaryOf(tx, { ...base, group: 'day' });
  const total = await analyticsSummaryOf(tx, { ...base, group: 'total' });
  const totals = new Map(total.branches.map((b) => [b.branchId, b.rows[0]!]));
  return {
    scope: selected.scope,
    basis: 'stored-daily-summary',
    branches: byDay.branches.map((b) => ({
      branchId: b.branchId,
      name: b.name,
      source: b.source,
      today: b.today,
      lastRolledUpAt: b.lastRolledUpAt,
      total: salesRowOf(totals.get(b.branchId)!),
      days: b.rows.map(salesRowOf),
    })),
    total: salesRowOf(total.merged[0]!),
  };
}

// --- Refunds and voids ---------------------------------------------------------------

export interface MoneyRefundRow {
  branchId: string;
  /** The refund's own number on its own series. */
  number: string;
  amountSatang: number;
  mode: string;
  reason: string;
  approvedBy: string | null;
  createdBy: string | null;
  pending: boolean;
  createdAt: string;
  sale: { receiptNumber: string | null; businessDate: string; grossSatang: number; status: string };
  /** Investigate only: the record ids and their trace. */
  refundId: string | null;
  saleId: string | null;
  trace: TraceLink | null;
}

export interface MoneyVoidRow {
  branchId: string;
  receiptNumber: string | null;
  businessDate: string;
  grossSatang: number;
  voidedAt: string | null;
  voidedBy: string | null;
  reason: string | null;
  saleId: string | null;
  trace: TraceLink | null;
}

export interface MoneyRefunds {
  scope: MoneyScope;
  basis: 'original-sale-business-date';
  refunds: { count: number; totalSatang: number; rows: MoneyRefundRow[]; truncated: boolean };
  voids: { count: number; totalSatang: number; rows: MoneyVoidRow[]; truncated: boolean };
}

/**
 * Refunds and voids with who approved them, why, and the original sale. A
 * refund is placed on its ORIGINAL sale's business date — End of Day's rule —
 * so this list and the day's cash lines describe the same money.
 */
export async function moneyRefundsOf(tx: Tx, input: MoneyQuery): Promise<MoneyRefunds> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const ids = selected.parks.map((p) => p.id);
  const investigate = new Set(selected.parks.filter((p) => p.investigate).map((p) => p.id));
  const refundWhere = and(
    eq(refund.operatorId, input.operatorId),
    eq(sale.operatorId, input.operatorId),
    inArray(refund.branchId, ids),
    gte(sale.businessDate, input.from),
    lte(sale.businessDate, input.to),
  );
  const [refundTotals] = await tx
    .select({ n: sql<string>`count(*)::text`, total: sql<string>`coalesce(sum(${refund.amountSatang}), 0)::text` })
    .from(refund)
    .innerJoin(sale, eq(sale.id, refund.saleId))
    .where(refundWhere);
  const refundRows = await tx
    .select({ row: refund, receiptNumber: sale.receiptNumber, businessDate: sale.businessDate, grossSatang: sale.grossSatang, status: sale.status })
    .from(refund)
    .innerJoin(sale, eq(sale.id, refund.saleId))
    .where(refundWhere)
    .orderBy(sql`${refund.createdAt} desc`, asc(refund.id))
    .limit(MONEY_ROW_LIMIT + 1);

  const voidWhere = and(
    eq(sale.operatorId, input.operatorId),
    inArray(sale.branchId, ids),
    eq(sale.status, 'voided'),
    gte(sale.businessDate, input.from),
    lte(sale.businessDate, input.to),
  );
  const [voidTotals] = await tx
    .select({ n: sql<string>`count(*)::text`, total: sql<string>`coalesce(sum(${sale.grossSatang}), 0)::text` })
    .from(sale)
    .where(voidWhere);
  const voidRows = await tx
    .select({
      id: sale.id, branchId: sale.branchId, receiptNumber: sale.receiptNumber, businessDate: sale.businessDate,
      grossSatang: sale.grossSatang, voidedAt: sale.voidedAt, voidedBy: sale.voidedByAccountId, reason: sale.voidReason,
    })
    .from(sale)
    .where(voidWhere)
    .orderBy(sql`${sale.voidedAt} desc nulls last`, asc(sale.id))
    .limit(MONEY_ROW_LIMIT + 1);

  const shownRefunds = refundRows.slice(0, MONEY_ROW_LIMIT);
  const shownVoids = voidRows.slice(0, MONEY_ROW_LIMIT);
  const nameOf = await accountNames(tx, [
    ...shownRefunds.flatMap((r) => [r.row.approvedByAccountId, r.row.createdByAccountId]),
    ...shownVoids.flatMap((v) => (v.voidedBy ? [v.voidedBy] : [])),
  ]);
  return {
    scope: selected.scope,
    basis: 'original-sale-business-date',
    refunds: {
      count: num(refundTotals?.n),
      totalSatang: num(refundTotals?.total),
      truncated: refundRows.length > MONEY_ROW_LIMIT,
      rows: shownRefunds.map(({ row, receiptNumber, businessDate, grossSatang, status }) => {
        const view = refundViewOf(row, nameOf);
        const open = investigate.has(row.branchId);
        return {
          branchId: row.branchId,
          number: view.number,
          amountSatang: view.amountSatang,
          mode: view.mode,
          reason: view.reason,
          approvedBy: view.approvedBy.name,
          createdBy: view.createdBy.name,
          pending: view.pending,
          createdAt: view.createdAt,
          sale: { receiptNumber, businessDate, grossSatang, status },
          refundId: open ? view.id : null,
          saleId: open ? view.saleId : null,
          trace: open ? supportTraceOf('sale', view.saleId) : null,
        };
      }),
    },
    voids: {
      count: num(voidTotals?.n),
      totalSatang: num(voidTotals?.total),
      truncated: voidRows.length > MONEY_ROW_LIMIT,
      rows: shownVoids.map((v) => {
        const open = investigate.has(v.branchId);
        return {
          branchId: v.branchId,
          receiptNumber: v.receiptNumber,
          businessDate: v.businessDate,
          grossSatang: v.grossSatang,
          voidedAt: iso(v.voidedAt),
          voidedBy: v.voidedBy ? nameOf(v.voidedBy) : null,
          reason: v.reason,
          saleId: open ? v.id : null,
          trace: open ? supportTraceOf('sale', v.id) : null,
        };
      }),
    },
  };
}

// --- Discounts, comps and promotions ---------------------------------------------------

export interface MoneyDiscounts {
  scope: MoneyScope;
  basis: 'stored-report-facts';
  compSatang: number;
  manualDiscountSatang: number;
  promoSatang: number;
  freeItemBenefitSatang: number;
  /** Revenue given up: comps, manual discounts and promotions, as the report adds them. */
  foregoneSatang: number;
  promoByType: Array<{ type: string; count: number; amountSatang: number }>;
  byOperator: Array<{ appliedBy: string; compCount: number; compTotalSatang: number; discountCount: number; discountTotalSatang: number }>;
}

export async function moneyDiscountsOf(tx: Tx, input: MoneyQuery): Promise<MoneyDiscounts> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const report = await discountReportOf(tx, reportScopeOf(selected));
  return {
    scope: selected.scope,
    basis: 'stored-report-facts',
    compSatang: report.compSatang,
    manualDiscountSatang: report.manualDiscountSatang,
    promoSatang: report.promoSatang,
    freeItemBenefitSatang: report.freeItemBenefitSatang,
    foregoneSatang: report.compSatang + report.manualDiscountSatang + report.promoSatang,
    promoByType: report.promoByType,
    byOperator: report.byOperator,
  };
}

// --- Cash days ---------------------------------------------------------------------------

export interface MoneyCashLine {
  channel: string;
  expectedSatang: number;
  actualSatang: number | null;
  differenceSatang: number;
  flag: ReconFlag;
}

export type MoneyCashDay =
  | {
      businessDate: string;
      available: true;
      status: 'open' | 'closed';
      verdict: ReconFlag;
      floatSatang: number | null;
      countedSatang: number | null;
      floatLeftSatang: number | null;
      paidOutSatang: number;
      safeDropSatang: number;
      totalExpectedSatang: number;
      totalActualSatang: number;
      totalDifferenceSatang: number;
      linesOff: number;
      lines: MoneyCashLine[];
      closedBy: string | null;
      closedAt: string | null;
      provisionalBoxes: number;
    }
  | { businessDate: string; available: false; code: string; reason: string };

export interface MoneyCash {
  scope: MoneyScope;
  basis: 'pos-end-of-day';
  toleranceSatang: number;
  branches: Array<{ branchId: string; name: string; days: MoneyCashDay[] }>;
}

/**
 * The cash day per park, read through the POS End of Day itself — a closed
 * day exactly as it was saved, an open day as the till would build it now —
 * so this page and the counter's End of Day cannot disagree. A day End of Day
 * refuses to read (its OTO App party seam unreadable) is shown as not
 * available with the reason, never as a zero day.
 */
export async function moneyCashOf(tx: Tx, input: MoneyQuery): Promise<MoneyCash> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const branches: MoneyCash['branches'] = [];
  for (const park of selected.parks) {
    const days: MoneyCashDay[] = [];
    for (const date of startedDays(park, input.from, input.to, selected.now)) {
      try {
        // A savepoint, so a refused day cannot poison the rest of the snapshot.
        const record = await tx.transaction((sp) => getEndOfDay(sp, input.operatorId, park.id, date, selected.now));
        const lines = record.lines.map((line) => ({ ...line, flag: lineFlag(line) }));
        const moved = (kind: string) =>
          record.cashMovements.filter((m) => m.kind === kind).reduce((sum, m) => sum + m.amountSatang, 0);
        days.push({
          businessDate: date,
          available: true,
          status: record.status,
          verdict: reconVerdict(record),
          floatSatang: record.cashCount.floatSatang,
          countedSatang: record.cashCount.countedSatang,
          floatLeftSatang: record.floatLeftSatang,
          paidOutSatang: moved('paid_out'),
          safeDropSatang: moved('safe_drop'),
          totalExpectedSatang: record.totalExpectedSatang,
          totalActualSatang: record.totalActualSatang,
          totalDifferenceSatang: record.totalDifferenceSatang,
          linesOff: lines.filter((line) => line.flag === 'off').length,
          lines,
          closedBy: record.closedBy?.name ?? null,
          closedAt: record.closedAt,
          provisionalBoxes: record.provisional?.length ?? 0,
        });
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode < 500) throw err;
        days.push({ businessDate: date, available: false, code: err.code, reason: err.message });
      }
    }
    branches.push({ branchId: park.id, name: park.name, days });
  }
  return { scope: selected.scope, basis: 'pos-end-of-day', toleranceSatang: RECON_TOLERANCE, branches };
}

// --- Settlement ------------------------------------------------------------------------

type BatchState = 'pending' | 'matched' | 'attention' | 'failed' | 'unsupported';

export interface MoneySettlementDay {
  businessDate: string;
  terminals: Array<{
    tid: string | null;
    label: string;
    provider: 'digio' | 'ghl' | 'simulator';
    /** The newest batch's state for this terminal; `not_run` when it has none for the day. */
    state: BatchState | 'not_run';
    batches: number;
  }>;
  gateway: {
    /** `no_file` when no 2C2P reconciliation file has been imported for the day — not a matched day. */
    state: BatchState | 'no_file';
    files: number;
  };
  matched: number;
  /** Lines in a settlement file or batch with no single matching attempt. */
  unmatchedLines: Array<{
    source: 'terminal' | '2c2p';
    method: 'card' | 'qr';
    amountSatang: number;
    tid: string | null;
    match: string;
    transactionType: string | null;
    attemptId: string | null;
    trace: TraceLink | null;
  }>;
  /** Taken card and QR money that no settlement line has matched yet. */
  unmatchedAttempts: Array<{
    method: 'card' | 'qr';
    amountSatang: number;
    tid: string | null;
    status: 'approved' | 'awaiting_settlement';
    attemptId: string | null;
    trace: TraceLink | null;
  }>;
}

export interface MoneySettlement {
  scope: MoneyScope;
  basis: 'pos-settlement';
  /**
   * The gateway's reconciliation file is imported in its documented fixture
   * format only; the real provider file's field mapping is not verified yet.
   */
  gatewayFileFormat: 'fixture_only';
  branches: Array<{ branchId: string; name: string; days: MoneySettlementDay[] }>;
}

export async function moneySettlementOf(tx: Tx, input: MoneyQuery): Promise<MoneySettlement> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const branches: MoneySettlement['branches'] = [];
  for (const park of selected.parks) {
    const open = park.investigate;
    const days: MoneySettlementDay[] = [];
    for (const date of startedDays(park, input.from, input.to, selected.now)) {
      const summary = await settlementSummary(tx, input.operatorId, park.id, date);
      const sourceOf = new Map(summary.batches.map((b) => [b.id, b.source]));
      const newest = (rows: typeof summary.batches) => rows[rows.length - 1]?.state;
      const files = summary.batches.filter((b) => b.source === '2c2p');
      days.push({
        businessDate: date,
        terminals: summary.devices.map((d) => {
          const runs = summary.batches.filter((b) => b.source === 'terminal' && b.deviceId === d.id);
          return { tid: d.tid, label: d.label, provider: d.provider, state: newest(runs) ?? 'not_run', batches: runs.length };
        }),
        gateway: { state: newest(files) ?? 'no_file', files: files.length },
        matched: summary.lines.filter((l) => l.match === 'matched').length,
        unmatchedLines: summary.lines.filter((l) => l.match !== 'matched').map((l) => ({
          source: sourceOf.get(l.batchId) ?? 'terminal',
          method: l.method,
          amountSatang: l.amountSatang,
          tid: l.tid,
          match: l.match,
          transactionType: l.transactionType,
          attemptId: open ? l.attemptId : null,
          trace: open && l.attemptId ? supportTraceOf('payment_attempt', l.attemptId) : null,
        })),
        unmatchedAttempts: summary.unmatchedAttempts.map((a) => ({
          method: a.method,
          amountSatang: a.amountSatang,
          tid: a.tid,
          status: a.status,
          attemptId: open ? a.id : null,
          trace: open ? supportTraceOf('payment_attempt', a.id) : null,
        })),
      });
    }
    branches.push({ branchId: park.id, name: park.name, days });
  }
  return { scope: selected.scope, basis: 'pos-settlement', gatewayFileFormat: 'fixture_only', branches };
}

// --- Wallet liability --------------------------------------------------------------------

export type MoneyWalletDay =
  | {
      businessDate: string;
      written: true;
      grantedSatang: number;
      spentSatang: number;
      refundedSatang: number;
      expiredSatang: number;
      reactivatedSatang: number;
      outstandingSatang: number;
    }
  /** No fact row: the day has not ended, or the liability job has not reached it yet. */
  | { businessDate: string; written: false; reason: 'day_not_ended' | 'not_yet_written' };

export interface MoneyWalletOutstanding {
  /** The live balances summed: the guarded projection, now. */
  projectionSatang: number;
  /** Every ledger entry summed: what the projection must equal. */
  ledgerSatang: number;
}

export interface MoneyWallets {
  scope: MoneyScope;
  basis: 'fact-wallet-liability-daily';
  outstanding: MoneyWalletOutstanding;
  branches: Array<{ branchId: string; name: string; outstanding: MoneyWalletOutstanding; days: MoneyWalletDay[] }>;
}

export async function moneyWalletsOf(tx: Tx, input: MoneyQuery): Promise<MoneyWallets> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const ids = selected.parks.map((p) => p.id);
  const facts = await tx
    .select()
    .from(factWalletLiabilityDaily)
    .where(and(
      eq(factWalletLiabilityDaily.operatorId, input.operatorId),
      inArray(factWalletLiabilityDaily.branchId, ids),
      gte(factWalletLiabilityDaily.businessDate, input.from),
      lte(factWalletLiabilityDaily.businessDate, input.to),
    ));
  const byKey = new Map(facts.map((f) => [`${f.branchId}|${f.businessDate}`, f]));
  const outstandingOf = async (branchIds: string[]): Promise<MoneyWalletOutstanding> => {
    const report = await walletReportOf(tx, input.operatorId, { branchIds, from: input.from, to: input.to, limit: 0 });
    return { projectionSatang: report.summary.outstandingSatang, ledgerSatang: report.summary.ledgerOutstandingSatang };
  };
  const branches: MoneyWallets['branches'] = [];
  for (const park of selected.parks) {
    const today = summaryBranchToday(park, selected.now);
    const days: MoneyWalletDay[] = startedDays(park, input.from, input.to, selected.now).map((date) => {
      const f = byKey.get(`${park.id}|${date}`);
      if (!f) return { businessDate: date, written: false, reason: date >= today ? 'day_not_ended' : 'not_yet_written' };
      return {
        businessDate: date,
        written: true,
        grantedSatang: f.grantedSatang,
        spentSatang: f.spentSatang,
        refundedSatang: f.refundedSatang,
        expiredSatang: f.expiredSatang,
        reactivatedSatang: f.reactivatedSatang,
        outstandingSatang: f.outstandingSatang,
      };
    });
    branches.push({ branchId: park.id, name: park.name, outstanding: await outstandingOf([park.id]), days });
  }
  return { scope: selected.scope, basis: 'fact-wallet-liability-daily', outstanding: await outstandingOf(ids), branches };
}

// --- Voucher and benefit cost ----------------------------------------------------------

export interface MoneyCosts {
  scope: MoneyScope;
  booths: {
    prizeCostSatang: number;
    /** A prize was won with no cost set: the cost above is short by it. */
    prizeCostIncomplete: boolean;
    vouchersIssued: number;
    vouchersRedeemed: number;
    lastRolledUpAt: string | null;
    rows: Array<{ name: string; branchId: string; branchName: string; prizeCostSatang: number; prizeCostIncomplete: boolean; vouchersIssued: number; vouchersRedeemed: number }>;
  };
  benefits: {
    totalReliefSatang: number;
    appliedSatang: number;
    compedSatang: number;
    freeItemsSatang: number;
    creditSatang: number;
    discountSatang: number;
    applications: number;
    lastRolledUpAt: string | null;
    byRole: Array<{ role: string; appliedSatang: number; totalReliefSatang: number; applications: number }>;
  };
}

export async function moneyCostsOf(tx: Tx, input: MoneyQuery): Promise<MoneyCosts> {
  const selected = await moneySelectionOf(tx, input, 'read');
  const scope = reportScopeOf(selected);
  const booth = await boothReportOf(tx, scope);
  const benefit = await benefitReportOf(tx, scope);
  return {
    scope: selected.scope,
    booths: {
      prizeCostSatang: booth.booths.reduce((sum, b) => sum + b.prizeCostSatang, 0),
      prizeCostIncomplete: booth.booths.some((b) => b.prizeCostIncomplete),
      vouchersIssued: booth.booths.reduce((sum, b) => sum + b.vouchersIssued, 0),
      vouchersRedeemed: booth.booths.reduce((sum, b) => sum + b.vouchersRedeemed, 0),
      lastRolledUpAt: booth.lastRolledUpAt,
      rows: booth.booths.map((b) => ({
        name: b.name, branchId: b.branchId, branchName: b.branchName, prizeCostSatang: b.prizeCostSatang,
        prizeCostIncomplete: b.prizeCostIncomplete, vouchersIssued: b.vouchersIssued, vouchersRedeemed: b.vouchersRedeemed,
      })),
    },
    benefits: {
      totalReliefSatang: benefit.totals.totalReliefSatang,
      appliedSatang: benefit.totals.appliedSatang,
      compedSatang: benefit.totals.compedSatang,
      freeItemsSatang: benefit.totals.freeItemsSatang,
      creditSatang: benefit.totals.creditSatang,
      discountSatang: benefit.totals.discountSatang,
      applications: benefit.totals.applications,
      lastRolledUpAt: benefit.lastRolledUpAt,
      byRole: benefit.byRole.map((r) => ({ role: r.role, appliedSatang: r.appliedSatang, totalReliefSatang: r.totalReliefSatang, applications: r.applications })),
    },
  };
}

// --- The integrity panel -------------------------------------------------------------------

export type IntegrityKey =
  | 'receipt_gaps'
  | 'sales_without_payment'
  | 'payments_without_sale'
  | 'stuck_attempts'
  | 'refunds_exceed_sale'
  | 'wallet_ledger_mismatch';

/** What each check looks over: a series' whole history, the chosen business dates, or the state now. */
export type IntegrityWindow = 'series_history' | 'business_dates' | 'now';

export interface IntegrityRow {
  branchId: string;
  stationId: string | null;
  stationName: string | null;
  /** The record the row is about, as a person reads it. */
  title: string;
  detail: string;
  businessDate: string | null;
  amountSatang: number | null;
  saleId: string | null;
  attemptId: string | null;
  actionId: string | null;
  receiptNumber: string | null;
  walletId: string | null;
  trace: TraceLink;
}

export interface IntegrityCheck {
  key: IntegrityKey;
  label: string;
  window: IntegrityWindow;
  rows: IntegrityRow[];
  truncated: boolean;
}

export interface MoneyIntegrity {
  scope: MoneyScope;
  pendingMinutes: number;
  generatedAt: string;
  checks: IntegrityCheck[];
}

const LABELS: Record<IntegrityKey, string> = {
  receipt_gaps: 'Receipt-number gaps per station and series',
  sales_without_payment: 'Sales with no settled payment',
  payments_without_sale: 'Payments with no sale',
  stuck_attempts: 'Payment attempts stuck waiting for an answer',
  refunds_exceed_sale: 'Refunds exceeding their sale',
  wallet_ledger_mismatch: 'Wallet balances that disagree with their ledger',
};

const baht = (satang: number) => `฿${(satang / 100).toFixed(2)}`;

function checkOf(key: IntegrityKey, window: IntegrityWindow, rows: IntegrityRow[]): IntegrityCheck {
  return { key, label: LABELS[key], window, rows: rows.slice(0, MONEY_ROW_LIMIT), truncated: rows.length > MONEY_ROW_LIMIT };
}

const empty = { stationId: null, stationName: null, businessDate: null, amountSatang: null, saleId: null, attemptId: null, actionId: null, receiptNumber: null, walletId: null };

/**
 * (a) RECEIPT-NUMBER GAPS. Numbers are per station, series and kind, gapless by
 * construction (`pos.receipt_series`), and a voided sale keeps its number — so
 * every stored document of a series is read, whatever its status and whatever
 * the date filter: a date window must never manufacture a gap. Two kinds of
 * hole are reported: a number missing between two stored documents, and
 * numbers the cloud's high-water mark says were issued past the last stored
 * one. Refund credit notes are read off their own series by their printed
 * number.
 */
async function receiptGaps(tx: Tx, operatorId: string, ids: readonly string[]): Promise<IntegrityRow[]> {
  const { rows } = await tx.execute<{
    branch_id: string; station_id: string; station_name: string | null; kind: string; series: string;
    before_number: string; after_number: string | null; missing_from: string; missing_to: string;
  }>(sql`
    with docs as (
      select s.branch_id, s.station_id, 'sale'::text as kind, s.receipt_series as series, s.receipt_seq as seq, s.receipt_number as number
        from pos.sale s
       where s.operator_id = ${operatorId} and s.branch_id in (${idList(ids)}) and s.receipt_seq is not null
      union all
      select r.branch_id, r.station_id, 'refund'::text, substring(r.number from '^(.*)-[0-9]+$'),
             substring(r.number from '-([0-9]+)$')::bigint, r.number
        from pos.refund r
       where r.operator_id = ${operatorId} and r.branch_id in (${idList(ids)}) and r.number ~ '-[0-9]+$'
    ), ordered as (
      select d.*, lead(d.seq) over w as next_seq, lead(d.number) over w as next_number,
             row_number() over (partition by d.station_id, d.kind, d.series order by d.seq desc) as from_top
        from docs d
      window w as (partition by d.station_id, d.kind, d.series order by d.seq)
    )
    select o.branch_id, o.station_id, st.name as station_name, o.kind, o.series, o.number as before_number,
           o.next_number as after_number, (o.seq + 1)::text as missing_from, (o.next_seq - 1)::text as missing_to
      from ordered o left join core.station st on st.id = o.station_id
     where o.next_seq is not null and o.next_seq > o.seq + 1
    union all
    select o.branch_id, o.station_id, st.name, o.kind, o.series, o.number, null,
           (o.seq + 1)::text, (rs.next_seq - 1)::text
      from ordered o
      join pos.receipt_series rs on rs.station_id = o.station_id and rs.series = o.series and rs.kind = o.kind
        and rs.operator_id = ${operatorId}
      left join core.station st on st.id = o.station_id
     where o.from_top = 1 and rs.next_seq - 1 > o.seq
     order by 1, 3, 4, 5, 8
     limit ${MONEY_ROW_LIMIT + 1}`);
  return rows.map((r) => {
    const from = num(r.missing_from);
    const to = num(r.missing_to);
    const missing = from === to ? `number ${from}` : `numbers ${from} to ${to}`;
    return {
      ...empty,
      branchId: r.branch_id,
      stationId: r.station_id,
      stationName: r.station_name,
      title: `${r.kind === 'refund' ? 'Refund' : 'Sale'} series ${r.series}: ${missing} missing`,
      detail: r.after_number
        ? `No ${r.kind} document is stored between ${r.before_number} and ${r.after_number}.`
        : `The series has issued past ${r.before_number}, the last ${r.kind} document stored.`,
      receiptNumber: r.before_number,
      trace: supportTraceOf('receipt', r.before_number),
    };
  });
}

/** (b) A recorded sale whose taken money (`PAYMENT_ATTEMPT_TAKEN_STATUSES`) is short of its gross — `outstandingAfter`'s rule. */
async function salesWithoutPayment(tx: Tx, input: MoneyQuery, ids: readonly string[]): Promise<IntegrityRow[]> {
  const { rows } = await tx.execute<{
    id: string; branch_id: string; station_id: string; station_name: string | null; receipt_number: string | null;
    business_date: string; status: string; gross: string; taken: string; action_id: string | null;
  }>(sql`
    select s.id, s.branch_id, s.station_id, st.name as station_name, s.receipt_number, s.business_date::text as business_date,
           s.status, s.gross_satang::text as gross,
           coalesce(sum(a.amount_satang) filter (where a.status in (${sql.join(TAKEN.map((t) => sql`${t}`), sql`, `)})), 0)::text as taken,
           s.action_id
      from pos.sale s
      left join core.station st on st.id = s.station_id
      left join pos.payment_attempt a on a.sale_id = s.id and a.operator_id = s.operator_id
     where s.operator_id = ${input.operatorId} and s.branch_id in (${idList(ids)})
       and s.business_date between ${input.from}::date and ${input.to}::date
       and s.status in ('finalised', 'refunded') and s.gross_satang > 0
     group by s.id, st.name
    having coalesce(sum(a.amount_satang) filter (where a.status in (${sql.join(TAKEN.map((t) => sql`${t}`), sql`, `)})), 0) < s.gross_satang
     order by s.business_date, s.receipt_number nulls last, s.id
     limit ${MONEY_ROW_LIMIT + 1}`);
  return rows.map((r) => ({
    ...empty,
    branchId: r.branch_id,
    stationId: r.station_id,
    stationName: r.station_name,
    title: `Sale ${r.receipt_number ?? 'without a receipt number'}: ${baht(num(r.gross) - num(r.taken))} not settled`,
    detail: `Charged ${baht(num(r.gross))}; payments taken ${baht(num(r.taken))}. Status ${r.status}.`,
    businessDate: day(r.business_date),
    amountSatang: num(r.gross) - num(r.taken),
    saleId: r.id,
    actionId: r.action_id,
    receiptNumber: r.receipt_number,
    trace: supportTraceOf('sale', r.id),
  }));
}

/**
 * (c) Money taken with no sale behind it — after the attempts that belong to
 * something else by design: a party payment (`pos.party_payment`, no sale by
 * the party tab's rule) and a booking's own online payment (the booking names
 * it, or it names the booking).
 */
async function paymentsWithoutSale(tx: Tx, input: MoneyQuery, ids: readonly string[]): Promise<IntegrityRow[]> {
  const { rows } = await tx.execute<{
    id: string; branch_id: string; station_id: string | null; station_name: string | null; business_date: string;
    method: string; method_code: string | null; status: string; amount: string; action_id: string | null; invoice_no: string | null;
  }>(sql`
    select a.id, a.branch_id, a.station_id, st.name as station_name, a.business_date::text as business_date,
           a.method, a.method_code, a.status, a.amount_satang::text as amount, a.action_id, a.invoice_no
      from pos.payment_attempt a
      left join core.station st on st.id = a.station_id
     where a.operator_id = ${input.operatorId} and a.branch_id in (${idList(ids)})
       and a.business_date between ${input.from}::date and ${input.to}::date
       and a.sale_id is null
       and a.status in (${sql.join(TAKEN.map((t) => sql`${t}`), sql`, `)})
       and not exists (select 1 from pos.party_payment pp where pp.payment_attempt_id = a.id and pp.operator_id = a.operator_id)
       and not exists (select 1 from pos.booking b where b.payment_attempt_id = a.id and b.operator_id = a.operator_id)
       and not exists (select 1 from pos.booking b where b.id::text = a.payload ->> 'bookingId' and b.operator_id = a.operator_id)
     order by a.business_date, a.created_at, a.id
     limit ${MONEY_ROW_LIMIT + 1}`);
  return rows.map((r) => ({
    ...empty,
    branchId: r.branch_id,
    stationId: r.station_id,
    stationName: r.station_name,
    title: `${baht(num(r.amount))} ${r.method_code ?? r.method} taken with no sale`,
    detail: `Attempt ${r.status}${r.invoice_no ? `, invoice ${r.invoice_no}` : ''}; no sale, party payment or booking owns it.`,
    businessDate: day(r.business_date),
    amountSatang: num(r.amount),
    attemptId: r.id,
    actionId: r.action_id,
    trace: supportTraceOf('payment_attempt', r.id),
  }));
}

/** (d) The pending job's own predicate (`flagPendingPayments`): a till's attempt still waiting past `PAYMENT_PENDING_MIN`. Read, never polled. */
async function stuckAttempts(tx: Tx, input: MoneyQuery, ids: readonly string[], now: Date, pendingMinutes: number): Promise<IntegrityRow[]> {
  const cutoff = new Date(now.getTime() - pendingMinutes * 60_000);
  const { rows } = await tx.execute<{
    id: string; branch_id: string; station_id: string; station_name: string | null; sale_id: string | null; business_date: string;
    method: string; status: string; amount: string; action_id: string | null; created_at: Date | string; receipt_number: string | null;
  }>(sql`
    select a.id, a.branch_id, a.station_id, st.name as station_name, a.sale_id, a.business_date::text as business_date,
           a.method, a.status, a.amount_satang::text as amount, a.action_id, a.created_at, s.receipt_number
      from pos.payment_attempt a
      left join core.station st on st.id = a.station_id
      left join pos.sale s on s.id = a.sale_id
     where a.operator_id = ${input.operatorId} and a.branch_id in (${idList(ids)})
       and a.status in (${sql.join(PENDING_ATTEMPT_STATUSES.map((t) => sql`${t}`), sql`, `)})
       and a.created_at < ${cutoff.toISOString()}::timestamptz
       and a.station_id is not null
     order by a.created_at, a.id
     limit ${MONEY_ROW_LIMIT + 1}`);
  return rows.map((r) => {
    const minutes = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 60_000);
    return {
      ...empty,
      branchId: r.branch_id,
      stationId: r.station_id,
      stationName: r.station_name,
      title: `${baht(num(r.amount))} ${r.method} ${r.status.replace(/_/g, ' ')} for ${minutes} minutes`,
      detail: `Waiting longer than ${pendingMinutes} minutes for the terminal or gateway to answer.`,
      businessDate: day(r.business_date),
      amountSatang: num(r.amount),
      saleId: r.sale_id,
      attemptId: r.id,
      actionId: r.action_id,
      receiptNumber: r.receipt_number,
      trace: supportTraceOf('payment_attempt', r.id),
    };
  });
}

/** (e) The refund ledger of a sale adding up to more than the sale took. */
async function refundsExceedingSale(tx: Tx, input: MoneyQuery, ids: readonly string[]): Promise<IntegrityRow[]> {
  const { rows } = await tx.execute<{
    id: string; branch_id: string; station_id: string; station_name: string | null; receipt_number: string | null;
    business_date: string; gross: string; projected: string; refunded: string; numbers: string[]; action_id: string | null;
  }>(sql`
    select s.id, s.branch_id, s.station_id, st.name as station_name, s.receipt_number, s.business_date::text as business_date,
           s.gross_satang::text as gross, s.refunded_satang::text as projected, sum(r.amount_satang)::text as refunded,
           array_agg(r.number order by r.created_at) as numbers, s.action_id
      from pos.sale s
      join pos.refund r on r.sale_id = s.id and r.operator_id = s.operator_id
      left join core.station st on st.id = s.station_id
     where s.operator_id = ${input.operatorId} and s.branch_id in (${idList(ids)})
       and s.business_date between ${input.from}::date and ${input.to}::date
     group by s.id, st.name
    having sum(r.amount_satang) > s.gross_satang
     order by s.business_date, s.receipt_number nulls last, s.id
     limit ${MONEY_ROW_LIMIT + 1}`);
  return rows.map((r) => ({
    ...empty,
    branchId: r.branch_id,
    stationId: r.station_id,
    stationName: r.station_name,
    title: `Sale ${r.receipt_number ?? 'without a receipt number'}: refunded ${baht(num(r.refunded))} of ${baht(num(r.gross))}`,
    detail: `Refunds ${r.numbers.join(', ')} exceed the sale by ${baht(num(r.refunded) - num(r.gross))}; the sale records ${baht(num(r.projected))} refunded.`,
    businessDate: day(r.business_date),
    amountSatang: num(r.refunded) - num(r.gross),
    saleId: r.id,
    actionId: r.action_id,
    receiptNumber: r.receipt_number,
    trace: supportTraceOf('sale', r.id),
  }));
}

/** (f) A wallet's guarded projection (`wallet.balance_satang`) against its whole signed ledger, read in one snapshot. */
async function walletMismatches(tx: Tx, operatorId: string, ids: readonly string[]): Promise<IntegrityRow[]> {
  const { rows } = await tx.execute<{
    id: string; branch_id: string; status: string; balance: string; ledger: string; entries: string; last_at: Date | string | null;
  }>(sql`
    select w.id, w.branch_id, w.status, w.balance_satang::text as balance,
           coalesce(sum(e.amount_satang), 0)::text as ledger, count(e.id)::text as entries, max(e.created_at) as last_at
      from pos.wallet w
      left join pos.wallet_entry e on e.wallet_id = w.id and e.operator_id = w.operator_id
     where w.operator_id = ${operatorId} and w.branch_id in (${idList(ids)})
     group by w.id
    having w.balance_satang <> coalesce(sum(e.amount_satang), 0)
     order by w.branch_id, w.id
     limit ${MONEY_ROW_LIMIT + 1}`);
  return rows.map((r) => ({
    ...empty,
    branchId: r.branch_id,
    title: `Wallet balance ${baht(num(r.balance))}, ledger ${baht(num(r.ledger))}`,
    detail: `${num(r.entries)} ledger entries; the balance is off by ${baht(num(r.balance) - num(r.ledger))}. Status ${r.status}${r.last_at ? `, last entry ${iso(r.last_at)}` : ''}.`,
    amountSatang: num(r.balance) - num(r.ledger),
    walletId: r.id,
    trace: supportTraceOf('wallet', r.id),
  }));
}

/** The six checks, each over the parks held on both Money permissions. Reads only. */
export async function moneyIntegrityOf(tx: Tx, input: MoneyQuery & { pendingMinutes: number }): Promise<MoneyIntegrity> {
  const selected = await moneySelectionOf(tx, input, 'investigate');
  const ids = selected.parks.map((p) => p.id);
  return {
    scope: selected.scope,
    pendingMinutes: input.pendingMinutes,
    generatedAt: selected.now.toISOString(),
    checks: [
      checkOf('receipt_gaps', 'series_history', await receiptGaps(tx, input.operatorId, ids)),
      checkOf('sales_without_payment', 'business_dates', await salesWithoutPayment(tx, input, ids)),
      checkOf('payments_without_sale', 'business_dates', await paymentsWithoutSale(tx, input, ids)),
      checkOf('stuck_attempts', 'now', await stuckAttempts(tx, input, ids, selected.now, input.pendingMinutes)),
      checkOf('refunds_exceed_sale', 'business_dates', await refundsExceedingSale(tx, input, ids)),
      checkOf('wallet_ledger_mismatch', 'now', await walletMismatches(tx, input.operatorId, ids)),
    ],
  };
}

