import { z } from 'zod';
import { AnalyticsSummaryQuerySchema, analyticsSummaryBranchIds } from '@oto/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app';
import {
  auditedMoneyRead, moneyCashOf, moneyCostsOf, moneyDiscountsOf, moneyIntegrityOf, moneyRefundsOf,
  moneySalesOf, moneySettlementOf, moneyWalletsOf, type MoneyQuery, type MoneyScope, type MoneySection,
} from '../services/console-money';
import { opCtx, type Tx } from '../services/tx';

/**
 * SCRUM-647 — Money oversight, `/console/money/*`. Eight reads and nothing
 * else: no route here takes a body, and every one answers from a read-only
 * snapshot and writes only its own audit row (`console.money.read`, or
 * `console.money.investigate` for the integrity panel).
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');
const UUID = z.string().uuid();
const satang = z.number().int();
const count = z.number().int().nonnegative();
const reconFlag = z.enum(['pending', 'ok', 'off']);
const batchState = z.enum(['pending', 'matched', 'attention', 'failed', 'unsupported']);

export const MoneyQuerySchema = z.object({
  branches: AnalyticsSummaryQuerySchema.shape.branches,
  from: DATE,
  to: DATE,
}).strict();

const scope = z.object({
  from: DATE, to: DATE,
  branches: z.array(z.object({ branchId: UUID, name: z.string() }).strict()),
  omitted: z.array(UUID),
}).strict();

const trace = z.object({
  kind: z.enum(['sale', 'refund', 'payment_attempt', 'receipt', 'wallet']),
  id: z.string(),
  href: z.string().startsWith('/support?'),
}).strict();

const salesRow = z.object({
  businessDate: DATE.nullable(), provisional: z.boolean(), rolledDays: count, computedAt: z.string().nullable(),
  revenueSatang: satang, ticketsSatang: satang, fnbSatang: satang, merchSatang: satang, partiesSatang: satang,
  dropoffSatang: satang, refundsSatang: satang, discountsSatang: satang, compsSatang: satang, txnCount: count,
}).strict();

export const MoneySalesSchema = z.object({
  scope, basis: z.literal('stored-daily-summary'),
  branches: z.array(z.object({
    branchId: UUID, name: z.string(), source: z.string(), today: DATE, lastRolledUpAt: z.string().nullable(),
    total: salesRow, days: z.array(salesRow),
  }).strict()),
  total: salesRow,
}).strict();

export const MoneyRefundsSchema = z.object({
  scope, basis: z.literal('original-sale-business-date'),
  refunds: z.object({
    count, totalSatang: satang, truncated: z.boolean(),
    rows: z.array(z.object({
      branchId: UUID, number: z.string(), amountSatang: satang, mode: z.string(), reason: z.string(),
      approvedBy: z.string().nullable(), createdBy: z.string().nullable(), pending: z.boolean(), createdAt: z.string(),
      sale: z.object({ receiptNumber: z.string().nullable(), businessDate: DATE, grossSatang: satang, status: z.string() }).strict(),
      refundId: UUID.nullable(), saleId: UUID.nullable(), trace: trace.nullable(),
    }).strict()),
  }).strict(),
  voids: z.object({
    count, totalSatang: satang, truncated: z.boolean(),
    rows: z.array(z.object({
      branchId: UUID, receiptNumber: z.string().nullable(), businessDate: DATE, grossSatang: satang,
      voidedAt: z.string().nullable(), voidedBy: z.string().nullable(), reason: z.string().nullable(),
      saleId: UUID.nullable(), trace: trace.nullable(),
    }).strict()),
  }).strict(),
}).strict();

export const MoneyDiscountsSchema = z.object({
  scope, basis: z.literal('stored-report-facts'),
  compSatang: satang, manualDiscountSatang: satang, promoSatang: satang, freeItemBenefitSatang: satang, foregoneSatang: satang,
  promoByType: z.array(z.object({ type: z.string(), count, amountSatang: satang }).strict()),
  byOperator: z.array(z.object({
    appliedBy: z.string(), compCount: count, compTotalSatang: satang, discountCount: count, discountTotalSatang: satang,
  }).strict()),
}).strict();

const cashDay = z.union([
  z.object({
    businessDate: DATE, available: z.literal(true), status: z.enum(['open', 'closed']), verdict: reconFlag,
    floatSatang: satang.nullable(), countedSatang: satang.nullable(), floatLeftSatang: satang.nullable(),
    paidOutSatang: satang, safeDropSatang: satang,
    totalExpectedSatang: satang, totalActualSatang: satang, totalDifferenceSatang: satang, linesOff: count,
    lines: z.array(z.object({
      channel: z.string(), expectedSatang: satang, actualSatang: satang.nullable(), differenceSatang: satang, flag: reconFlag,
    }).strict()),
    closedBy: z.string().nullable(), closedAt: z.string().nullable(), provisionalBoxes: count,
  }).strict(),
  z.object({ businessDate: DATE, available: z.literal(false), code: z.string(), reason: z.string() }).strict(),
]);

export const MoneyCashSchema = z.object({
  scope, basis: z.literal('pos-end-of-day'), toleranceSatang: satang,
  branches: z.array(z.object({ branchId: UUID, name: z.string(), days: z.array(cashDay) }).strict()),
}).strict();

export const MoneySettlementSchema = z.object({
  scope, basis: z.literal('pos-settlement'), gatewayFileFormat: z.literal('fixture_only'),
  branches: z.array(z.object({
    branchId: UUID, name: z.string(),
    days: z.array(z.object({
      businessDate: DATE,
      terminals: z.array(z.object({
        tid: z.string().nullable(), label: z.string(), provider: z.enum(['digio', 'ghl', 'simulator']),
        state: z.union([batchState, z.literal('not_run')]), batches: count,
      }).strict()),
      gateway: z.object({ state: z.union([batchState, z.literal('no_file')]), files: count }).strict(),
      matched: count,
      unmatchedLines: z.array(z.object({
        source: z.enum(['terminal', '2c2p']), method: z.enum(['card', 'qr']), amountSatang: satang, tid: z.string().nullable(),
        match: z.string(), transactionType: z.string().nullable(), attemptId: UUID.nullable(), trace: trace.nullable(),
      }).strict()),
      unmatchedAttempts: z.array(z.object({
        method: z.enum(['card', 'qr']), amountSatang: satang, tid: z.string().nullable(),
        status: z.enum(['approved', 'awaiting_settlement']), attemptId: UUID.nullable(), trace: trace.nullable(),
      }).strict()),
    }).strict()),
  }).strict()),
}).strict();

const outstanding = z.object({ projectionSatang: satang, ledgerSatang: satang }).strict();
const walletDay = z.union([
  z.object({
    businessDate: DATE, written: z.literal(true), grantedSatang: satang, spentSatang: satang, refundedSatang: satang,
    expiredSatang: satang, reactivatedSatang: satang, outstandingSatang: satang,
  }).strict(),
  z.object({ businessDate: DATE, written: z.literal(false), reason: z.enum(['day_not_ended', 'not_yet_written']) }).strict(),
]);

export const MoneyWalletsSchema = z.object({
  scope, basis: z.literal('fact-wallet-liability-daily'), outstanding,
  branches: z.array(z.object({ branchId: UUID, name: z.string(), outstanding, days: z.array(walletDay) }).strict()),
}).strict();

export const MoneyCostsSchema = z.object({
  scope,
  booths: z.object({
    prizeCostSatang: satang, prizeCostIncomplete: z.boolean(), vouchersIssued: count, vouchersRedeemed: count,
    lastRolledUpAt: z.string().nullable(),
    rows: z.array(z.object({
      name: z.string(), branchId: UUID, branchName: z.string(), prizeCostSatang: satang, prizeCostIncomplete: z.boolean(),
      vouchersIssued: count, vouchersRedeemed: count,
    }).strict()),
  }).strict(),
  benefits: z.object({
    totalReliefSatang: satang, appliedSatang: satang, compedSatang: satang, freeItemsSatang: satang, creditSatang: satang,
    discountSatang: satang, applications: count, lastRolledUpAt: z.string().nullable(),
    byRole: z.array(z.object({ role: z.string(), appliedSatang: satang, totalReliefSatang: satang, applications: count }).strict()),
  }).strict(),
}).strict();

export const MoneyIntegritySchema = z.object({
  scope, pendingMinutes: z.number().int().positive(), generatedAt: z.string(),
  checks: z.array(z.object({
    key: z.enum(['receipt_gaps', 'sales_without_payment', 'payments_without_sale', 'stuck_attempts', 'refunds_exceed_sale', 'wallet_ledger_mismatch']),
    label: z.string(),
    window: z.enum(['series_history', 'business_dates', 'now']),
    truncated: z.boolean(),
    rows: z.array(z.object({
      branchId: UUID, stationId: UUID.nullable(), stationName: z.string().nullable(), title: z.string(), detail: z.string(),
      businessDate: DATE.nullable(), amountSatang: satang.nullable(), saleId: UUID.nullable(), attemptId: UUID.nullable(),
      actionId: z.string().nullable(), receiptNumber: z.string().nullable(), walletId: UUID.nullable(), trace,
    }).strict()),
  }).strict()),
}).strict();

type Query = z.infer<typeof MoneyQuerySchema>;

const COMMON =
  'Read only: the section runs in a read-only snapshot, and the read is recorded in the audit log (section and filters, ' +
  'never figures) before it is answered. Parks: the named ones, or every live park by default, held on console:money:read; ' +
  `requested own parks outside that reach are listed as omitted; foreign or unknown ids are 404; none readable is 403. ` +
  'from..to are business dates, at most 31 days. Satang integers throughout. Row identifiers and support-trace links ' +
  'appear only at parks where the caller also holds console:money:investigate.';

/** One audited read: the caller's operator and fresh grants, a read-only snapshot, then its audit row. */
async function serveMoneyRead<T extends { scope: MoneyScope }>(
  app: App,
  req: FastifyRequest,
  reply: FastifyReply,
  params: Query,
  section: MoneySection,
  read: (tx: Tx, query: MoneyQuery) => Promise<T>,
): Promise<T> {
  const auth = req.requireAuth();
  const effective = await req.effectivePermissions();
  reply.header('cache-control', 'private, no-store');
  const query: MoneyQuery = {
    operatorId: auth.operatorId, effective, branchIds: analyticsSummaryBranchIds(params.branches),
    from: params.from, to: params.to,
  };
  const ctx = { ...opCtx(req), requestId: req.id, actorAccountId: auth.accountId, operatorId: auth.operatorId };
  return auditedMoneyRead(app.db, ctx, section, { branchIds: query.branchIds ?? [], from: query.from, to: query.to },
    (tx) => read(tx, query));
}

const described = (summary: string) => `${summary} ${COMMON}`;

export async function consoleMoneyRoutes(app: App): Promise<void> {
  app.get('/console/money/sales', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Sales per park, business date and revenue category, from the stored daily summary with its provisional and freshness marks.'),
      querystring: MoneyQuerySchema, response: { 200: MoneySalesSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'sales', moneySalesOf));

  app.get('/console/money/refunds', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Refunds (on their original sale’s business date) and voids, with the approving manager, the reason and the original sale.'),
      querystring: MoneyQuerySchema, response: { 200: MoneyRefundsSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'refunds', moneyRefundsOf));

  app.get('/console/money/discounts', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Comps, manual discounts and promotions with the revenue given up, from the stored report facts.'),
      querystring: MoneyQuerySchema, response: { 200: MoneyDiscountsSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'discounts', moneyDiscountsOf));

  app.get('/console/money/cash', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Each park’s End of Day per business date as the POS reads it: float, paid-outs, safe drops and every line against the ฿1 tolerance. A day End of Day cannot read is not available, never zero.'),
      querystring: MoneyQuerySchema, response: { 200: MoneyCashSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'cash', moneyCashOf));

  app.get('/console/money/settlement', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Settlement per terminal TID and the imported 2C2P file per business date, with unmatched lines and unmatched taken money. The 2C2P file is imported in its documented fixture format only.'),
      querystring: MoneyQuerySchema, response: { 200: MoneySettlementSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'settlement', moneySettlementOf));

  app.get('/console/money/wallets', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Wallet liability per park and business date as the liability job wrote it, and the live balances beside their ledger.'),
      querystring: MoneyQuerySchema, response: { 200: MoneyWalletsSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'wallets', moneyWalletsOf));

  app.get('/console/money/costs', {
    config: { dynamicPermission: true },
    schema: {
      description: described('Booth prize voucher cost and staff benefit relief, from their stored report facts.'),
      querystring: MoneyQuerySchema, response: { 200: MoneyCostsSchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'costs', moneyCostsOf));

  app.get('/console/money/integrity', {
    config: { dynamicPermission: true },
    schema: {
      description: described(
        'The money integrity panel: receipt-number gaps per station and series (whole series history), sales with no settled ' +
        'payment, payments with no sale (after party and booking payments), attempts stuck past PAYMENT_PENDING_MIN (now), ' +
        'refunds exceeding their sale, and wallet balances that disagree with their ledger (now). Each row carries its ' +
        'identifiers and a support-trace link. Needs console:money:read and console:money:investigate at each park; none ' +
        'held is 403. Recorded in the audit log as console.money.investigate.',
      ),
      querystring: MoneyQuerySchema, response: { 200: MoneyIntegritySchema },
    },
  }, async (req, reply) => serveMoneyRead(app, req, reply, req.query, 'integrity',
    (tx, query) => moneyIntegrityOf(tx, { ...query, pendingMinutes: app.env.PAYMENT_PENDING_MIN })));
}
