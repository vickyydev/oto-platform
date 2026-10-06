import { and, asc, eq } from 'drizzle-orm';
import { device, paymentAttempt, refund, sale, saleLine, station } from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  WALLET_TENDER_CODE,
  WALLET_TENDER_METHOD,
  allocateRefund,
  businessDate,
  parseDayStart,
  isoDateInTz,
  newId,
  refundScopeOf,
  refundStatusOf,
  refundableSatang,
  resolveRefundAmount,
  restockLineIds,
  type RefundAllocationEntry,
  type RefundLineEntry,
  type RefundMode,
  type RefundableTender,
} from '@oto/shared';
import { roleForTender, type TerminalTender } from '@oto/box-agent';
import type { QrPayment } from '@oto/payments-2c2p';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { revokeSaleBands } from './bands';
import { queueTerminalCommand } from './payments/terminal';
import { accountNames, refundViewOf, settleRefundSlice, type RefundView } from './refund-slices';
import { allocateReceipt, saleViewOf, type SaleView } from './sale';
import { restoreForRefund, walletTenderOf } from './wallet';
import { restockForRefund } from './stock';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * S2-11 — REFUND A FINALISED SALE, online, with a manager's approval.
 *
 * THE RULES ARE THE PROTOTYPE'S (`mockApi.ts:recordRefund`,
 * `components/history/RefundModal.tsx`):
 *
 *   - three modes — the whole sale, by item, or a custom amount — and a reason
 *     every time;
 *   - "never refund more than is left": whatever is asked is CLAMPED to what
 *     the sale has not yet refunded, and the answer says when it was;
 *   - the sale walks `paid → partially_refunded → refunded` on the running
 *     total (`statusForRefunds`). The ledger's own status stays `finalised`
 *     until the last satang goes back and then becomes `refunded` — the
 *     `pos.sale` comment's rule, so no other reader of a finalised sale has to
 *     learn a new word;
 *   - which lines go back to stock (`restockLineIds`) — and, since S2-14b,
 *     they go back: a refund movement per line, to the place each unit was
 *     taken from (`restockForRefund`).
 *
 * WHAT THE PLAN ADDS, and each is recorded on the ticket:
 *
 *   - APPROVAL: `pos:refund:approve`, a manager's. Reception without it is
 *     refused `REFUND_APPROVAL_REQUIRED` by the route; the approver is the
 *     account that pressed it, and the row keeps asker and approver apart;
 *   - its OWN NUMBER from the station's `refund` series (`allocateReceipt`);
 *   - the money goes back WALLET → SAME TENDER → CASH (`allocateRefund`), and
 *     each tender back through what its adapter can actually do: a whole card
 *     tender is VOIDED on the terminal it was taken on — the terminal decides
 *     whether its window is still open, by its own clock, and a refusal falls
 *     back to cash; a gateway QR goes back through `QrPayment.refund`, after
 *     this transaction commits; cash is handed back at once;
 *   - ONLINE ONLY. The route is `stationTrading`, so a station forced offline
 *     is refused before anything is claimed; the till itself only queues a
 *     "refund requested" note while it is offline.
 */

type SaleRow = typeof sale.$inferSelect;
type AttemptRow = typeof paymentAttempt.$inferSelect;

export interface RefundActor {
  accountId: string;
  operatorId: string;
  /** The station the refund is made at — its refund series numbers it. */
  stationId: string | null;
  requestId?: string;
  /** `pos:refund:create` at the sale's branch — checked once the sale is loaded. */
  assertBranchAllowed: (branchId: string) => Promise<void>;
  /** `pos:refund:approve` at the sale's branch; throws `REFUND_APPROVAL_REQUIRED`. */
  assertCanApprove: (branchId: string) => Promise<void>;
}

export interface RefundSaleInput {
  mode: RefundMode;
  /** `items`: the sale lines, by id, as the detail lists them. */
  lineIds?: string[];
  /** `custom`: satang. */
  amountSatang?: number;
  reason: string;
  note?: string | null;
  actionId?: string | null;
}

export interface RefundSaleResult {
  /** True when this press had already been recorded and nothing was written. */
  replay: boolean;
  refund: RefundView;
  sale: SaleView;
  refundStatus: 'none' | 'partially_refunded' | 'refunded';
  refundableSatang: number;
  /** What was asked for, before the clamp; `clamped` says whether it was cut down. */
  requestedSatang: number;
  clamped: boolean;
}

/**
 * How a tender that took money can be reversed.
 *
 * S2-14a round 2 — STORED VALUE IS TOLD APART BY METHOD AND CODE. Only the
 * platform-written tender (method `wallet`, code `wallet_credit`, no device)
 * is the wallet channel. The terminal's Alipay / WeChat "wallet" is `qr` money
 * on a device with `payload.tender = 'wallet'`: it goes back through the
 * terminal (or cash), never onto a stored-value wallet.
 */
export function classify(row: Pick<AttemptRow, 'method' | 'methodCode' | 'deviceId' | 'invoiceNo' | 'provider'>): RefundableTender['channel'] {
  if (row.method === WALLET_TENDER_METHOD && row.methodCode === WALLET_TENDER_CODE && !row.deviceId) return 'wallet';
  if (row.method === WALLET_TENDER_METHOD) return 'manual';
  if (row.method === 'cash') return 'cash';
  if (row.deviceId) return 'terminal';
  if (row.invoiceNo && (row.provider === '2c2p' || row.provider === 'simulator')) return 'gateway';
  return 'manual';
}

function terminalTenderOf(row: AttemptRow): TerminalTender {
  const tender = ((row.payload ?? {}) as { tender?: string }).tender;
  if (tender === 'card' || tender === 'qr' || tender === 'wallet') return tender;
  return row.method === 'qr' ? 'qr' : 'card';
}

/** Which kind of sale this is, for the restock rule: the shop, the food counter, or tickets. */
function saleKindOf(row: SaleRow, lines: readonly (typeof saleLine.$inferSelect)[]): 'ticket' | 'fnb' | 'merch' {
  if (row.salesChannel === 'shop' || lines.every((l) => l.kind === 'merch_item')) return 'merch';
  if (row.salesChannel === 'fnb' || lines.every((l) => l.kind === 'fnb_item')) return 'fnb';
  return 'ticket';
}

/** Lines that hold stock at all; admission and fees never go back on a shelf. */
const STOCKED_KINDS = new Set(['socks', 'addon', 'merch_item', 'fnb_item']);

async function viewOfRefund(db: Exec, row: typeof refund.$inferSelect): Promise<RefundView> {
  return refundViewOf(row, await accountNames(db, [row.approvedByAccountId, row.createdByAccountId]));
}

async function answerFor(
  db: Exec,
  saleRow: SaleRow,
  refundRow: typeof refund.$inferSelect,
  extra: { replay: boolean; requestedSatang: number; clamped: boolean },
): Promise<RefundSaleResult> {
  return {
    replay: extra.replay,
    refund: await viewOfRefund(db, refundRow),
    sale: await saleViewOf(db, saleRow),
    refundStatus: refundStatusOf(saleRow.grossSatang, saleRow.refundedSatang),
    refundableSatang: refundableSatang(saleRow.grossSatang, saleRow.refundedSatang),
    requestedSatang: extra.requestedSatang,
    clamped: extra.clamped,
  };
}

/**
 * Write one refund, whole: the number, the row, the running total on the sale,
 * the terminal voids it needs queued, and the audit row — one transaction.
 */
export async function refundSale(
  tx: Tx,
  actor: RefundActor,
  saleId: string,
  input: RefundSaleInput,
  now: Date = new Date(),
): Promise<RefundSaleResult> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed(row.branchId);
  await actor.assertCanApprove(row.branchId);

  // Pressing Refund twice: the press is the key, as a tender's is.
  if (input.actionId) {
    const [already] = await tx
      .select()
      .from(refund)
      .where(and(eq(refund.operatorId, row.operatorId), eq(refund.actionId, input.actionId)))
      .limit(1);
    if (already) {
      if (already.saleId !== saleId) {
        throw errors.conflict('ACTION_ID_REUSED', 'That action id already recorded a refund of another sale', {
          saleId: already.saleId,
        });
      }
      return answerFor(tx, row, already, {
        replay: true,
        requestedSatang: already.amountSatang,
        clamped: false,
      });
    }
  }

  if (row.status === 'voided') {
    throw errors.conflict('SALE_VOIDED', 'This sale was voided — there is nothing to refund');
  }
  if (row.status === 'refunded') {
    throw errors.conflict('SALE_FULLY_REFUNDED', 'This sale is already fully refunded');
  }
  if (row.status !== 'finalised') {
    throw errors.conflict(
      'SALE_NOT_FINALISED',
      'This sale is not closed — a sale that took no money is voided, not refunded',
    );
  }
  const reason = input.reason.trim();
  if (!reason) throw errors.badRequest('A refund needs a reason');
  const remaining = refundableSatang(row.grossSatang, row.refundedSatang);
  if (remaining <= 0) throw errors.conflict('NOTHING_TO_REFUND', 'Nothing is left to refund on this sale');

  const lines = await tx
    .select()
    .from(saleLine)
    .where(eq(saleLine.saleId, saleId))
    .orderBy(asc(saleLine.lineNo));
  const earlier = await tx.select().from(refund).where(eq(refund.saleId, saleId));
  const earlierLines = new Set(earlier.flatMap((r) => (r.lines ?? []).map((l) => l.saleLineId)));
  const restocked = new Set(
    earlier.flatMap((r) => (r.lines ?? []).filter((l) => l.restock).map((l) => l.saleLineId)),
  );

  let picked: (typeof saleLine.$inferSelect)[] = [];
  if (input.mode === 'items') {
    const ids = [...new Set(input.lineIds ?? [])];
    if (ids.length === 0) throw errors.badRequest('Pick at least one line to refund');
    const byId = new Map(lines.map((l) => [l.id, l]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) throw errors.badRequest('Those lines are not on this sale', { lineIds: unknown });
    const again = ids.filter((id) => earlierLines.has(id));
    if (again.length) {
      throw errors.conflict('REFUND_LINE_ALREADY_REFUNDED', 'An earlier refund already covered those lines', {
        lineIds: again,
      });
    }
    picked = ids.map((id) => byId.get(id)!);
  }
  const amount = resolveRefundAmount({
    mode: input.mode,
    remainingSatang: remaining,
    itemsSatang: picked.reduce((sum, l) => sum + l.grossSatang, 0),
    customSatang: input.amountSatang,
  });
  if (amount.amountSatang <= 0) throw errors.badRequest('A refund has to give something back');

  // --- The lines it covers, and what goes back to stock ---------------------
  const covered =
    input.mode === 'whole' ? lines.filter((l) => l.quantity > 0 && !earlierLines.has(l.id)) : picked;
  // The design's scope: full when this refund takes everything still left, in
  // any mode. Earlier refunds were full-scope only if they emptied the sale,
  // which the status checks above already refuse to refund again.
  const scope = refundScopeOf(amount.amountSatang, remaining);
  const restock = new Set(
    restockLineIds({
      saleKind: saleKindOf(row, lines),
      mode: input.mode,
      scope,
      coveredLineIds: covered.map((l) => l.id),
      allLineIds: lines.filter((l) => l.quantity > 0).map((l) => l.id),
      alreadyRestocked: restocked,
      earlierFullScope: row.refundedSatang >= row.grossSatang,
    }),
  );
  const coveredIds = new Set(covered.map((l) => l.id));
  const lineEntries: RefundLineEntry[] = covered.map((l) => ({
    saleLineId: l.id,
    label: l.label,
    quantity: l.quantity,
    grossSatang: l.grossSatang,
    restock: restock.has(l.id) && STOCKED_KINDS.has(l.kind),
  }));
  // A full-scope refund also returns stocked lines whose money it does not
  // carry — a custom amount, or a line an earlier partial refund covered. Each
  // is named on this refund as returned to stock only, so `restocked` above
  // finds it and no later read counts its money twice.
  for (const l of lines) {
    if (coveredIds.has(l.id) || !restock.has(l.id) || !STOCKED_KINDS.has(l.kind)) continue;
    lineEntries.push({
      saleLineId: l.id,
      label: l.label,
      quantity: l.quantity,
      grossSatang: 0,
      restock: true,
      restockOnly: true,
    });
  }

  // --- Where the money goes back ---------------------------------------------
  const attempts = (
    await tx.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))
  ).filter((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status));
  const sentBack = new Map<string, number>();
  for (const earlierRefund of earlier) {
    for (const entry of earlierRefund.tenderAllocation ?? []) {
      if (entry.attemptId) sentBack.set(entry.attemptId, (sentBack.get(entry.attemptId) ?? 0) + entry.amountSatang);
    }
  }
  const tenders: RefundableTender[] = [];
  for (const a of attempts) {
    const channel = classify(a);
    let refundedSatang = sentBack.get(a.id) ?? 0;
    if (channel === 'wallet') {
      // S2-14a — the ledger's word on what this credit tender can still take
      // back: credit actually used, less what earlier refunds restored.
      const spent = await walletTenderOf(tx, row.operatorId, a.id);
      refundedSatang = spent ? Math.max(refundedSatang, a.amountSatang - (spent.usedSatang - spent.restoredSatang)) : a.amountSatang;
    }
    tenders.push({
      attemptId: a.id,
      method: a.method,
      methodCode: a.methodCode,
      provider: a.provider,
      channel,
      terminalTender: a.deviceId ? terminalTenderOf(a) : null,
      amountSatang: a.amountSatang,
      refundedSatang,
      paidAt: (a.paidAt ?? a.createdAt).toISOString(),
    });
  }
  const allocation = allocateRefund(amount.amountSatang, tenders);

  // --- The number, from the station's refund series --------------------------
  const refundStationId = actor.stationId ?? row.stationId;
  const [st] = await tx.select().from(station).where(eq(station.id, refundStationId)).limit(1);
  const numberingStation = st && st.branchId === row.branchId && st.codePrefix ? st : null;
  const series = numberingStation ?? (await tx.select().from(station).where(eq(station.id, row.stationId)).limit(1))[0];
  if (!series?.codePrefix) {
    throw errors.badRequest('This station has no code prefix, so it cannot number a refund — set one on the station');
  }
  const number = await allocateReceipt(
    tx,
    { operatorId: row.operatorId, branchId: row.branchId, stationId: series.id, series: `${series.codePrefix}-R` },
    'refund',
  );

  const refundId = newId();
  // A terminal void is queued now, in this transaction, so it cannot exist
  // without the refund it serves; its answer finds the slice by action id.
  const byAttempt = new Map(attempts.map((a) => [a.id, a]));
  const slices: RefundAllocationEntry[] = [];
  for (const entry of allocation) {
    if (entry.route !== 'terminal_void' || !entry.attemptId) {
      slices.push(entry);
      continue;
    }
    const attempt = byAttempt.get(entry.attemptId)!;
    const queued = await queueRefundVoid(tx, { attempt, refundId, amountSatang: entry.amountSatang, actor });
    slices.push(
      queued
        ? { ...entry, actionId: queued, detail: 'Void sent to the terminal' }
        : {
            ...entry,
            route: 'cash',
            status: 'done',
            detail: 'The terminal cannot be reached for a void — handed back in cash',
          },
    );
  }

  const [written] = await tx
    .insert(refund)
    .values({
      id: refundId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      saleId,
      stationId: series.id,
      number: number.number,
      amountSatang: amount.amountSatang,
      mode: input.mode,
      reason,
      note: input.note?.trim() || null,
      approvedByAccountId: actor.accountId,
      createdByAccountId: actor.accountId,
      lines: lineEntries,
      tenderAllocation: slices,
      actionId: input.actionId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!written) throw new Error('the refund was not written');

  /**
   * S2-14a round 2 — THE WALLET SLICES SETTLE NOW, in this transaction (plan
   * §2.4): each credits back to the SAME wallet its tender spent, capped at
   * what that tender used less what was already restored, keyed by this
   * refund and the attempt so a replay restores once. Whatever the cap holds
   * back is handed over in cash, as its own slice. After the row exists,
   * because the wallet's entry names it.
   */
  let finalRow = written;
  if (slices.some((s) => s.route === 'wallet' && s.status === 'pending')) {
    const settled: RefundAllocationEntry[] = [];
    let cashTopUp = 0;
    for (const slice of slices) {
      if (slice.route !== 'wallet' || slice.status !== 'pending' || !slice.attemptId) {
        settled.push(slice);
        continue;
      }
      const restored = await restoreForRefund(
        tx,
        { accountId: actor.accountId, operatorId: actor.operatorId, requestId: actor.requestId ?? null },
        {
          refundId,
          saleId,
          attemptId: slice.attemptId,
          amountSatang: slice.amountSatang,
          branchId: row.branchId,
          stationId: actor.stationId,
          now,
        },
      );
      const back = restored?.restoredSatang ?? 0;
      if (back > 0) {
        settled.push({
          ...slice,
          amountSatang: back,
          status: 'done',
          detail: 'Put back on the wallet it was spent from',
          settledAt: now.toISOString(),
        });
      }
      cashTopUp += slice.amountSatang - back;
    }
    if (cashTopUp > 0) {
      settled.push({
        attemptId: null,
        method: 'cash',
        methodCode: null,
        provider: null,
        route: 'cash',
        amountSatang: cashTopUp,
        status: 'done',
        detail: 'More than the wallet tender can take back — handed back in cash',
      });
    }
    const [updated] = await tx
      .update(refund)
      .set({ tenderAllocation: settled, updatedAt: now })
      .where(eq(refund.id, refundId))
      .returning();
    if (updated) finalRow = updated;
    slices.splice(0, slices.length, ...settled);
  }

  /**
   * S2-14b — THE STOCK GOES BACK, in this transaction: each line the restock
   * decision returns, to the place its units left from (the sale's own
   * movements, read back). Keyed by the sale line, so whichever refund carries
   * a line, it is put back once. A line sold before the ledger existed took
   * nothing off a shelf and puts nothing back (OD-S5).
   */
  const restockedMovements = await restockForRefund(tx, {
    operatorId: row.operatorId,
    branchId: row.branchId,
    saleId,
    refundId,
    saleLineIds: lineEntries.filter((l) => l.restock).map((l) => l.saleLineId),
    // The trading day the refund falls on, on the sale's own frozen calendar.
    businessDate: businessDate(now, row.timezone, parseDayStart(row.businessDayStart)),
    stationId: series.id,
    actorAccountId: actor.accountId,
    requestId: actor.requestId ?? null,
    now,
  });

  const refundedSatang = row.refundedSatang + amount.amountSatang;
  const full = refundedSatang >= row.grossSatang;
  const [after] = await tx
    .update(sale)
    .set({
      refundedSatang,
      ...(full ? { status: 'refunded' as const, refundedAt: now } : {}),
    })
    .where(eq(sale.id, saleId))
    .returning();
  if (!after) throw new Error('the sale was not updated');

  // A refund that empties the sale kills its bands: the admission it paid for
  // is gone, so the bands go with it in the same transaction. A partial refund
  // leaves them — some of the party is still inside. The gate does not exist
  // yet, so this is bookkeeping today and the gate's refusal tomorrow.
  const revokedBandIds = full
    ? await revokeSaleBands(tx, saleId, {
        refundId,
        reason,
        stationId: actor.stationId,
        accountId: actor.accountId,
      })
    : [];

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: 'sale.refund',
    entityType: 'sale',
    entityId: saleId,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    before: {
      status: row.status,
      refundedSatang: row.refundedSatang,
      refundStatus: refundStatusOf(row.grossSatang, row.refundedSatang),
    },
    after: {
      status: after.status,
      refundedSatang,
      refundStatus: refundStatusOf(after.grossSatang, refundedSatang),
      refundId,
      number: number.number,
      amountSatang: amount.amountSatang,
      requestedSatang: amount.requestedSatang,
      mode: input.mode,
      reason,
      approvedByAccountId: actor.accountId,
      slices: slices.map((s) => ({ attemptId: s.attemptId, route: s.route, amountSatang: s.amountSatang, status: s.status })),
      revokedBandIds,
      restocked: restockedMovements.map((m) => ({
        stockItemId: m.stockItemId,
        stockLocationId: m.stockLocationId,
        quantity: m.quantity,
      })),
    },
  });

  return answerFor(tx, after, finalRow, {
    replay: false,
    requestedSatang: amount.requestedSatang,
    clamped: amount.clamped,
  });
}

/**
 * Queue the terminal void a card slice needs: `payload.void` on the attempt,
 * so the box's answer is read as a VOID (`phaseOf` in `payments/terminal.ts`)
 * and routed back to this refund, and the command itself. Keyed on what each
 * vendor voids by — the transaction reference, and a GHL card's approval code
 * beside it — exactly as the partial-approval rescue is (`refuseAndVoid`).
 *
 * Null when the void cannot be sent: no transaction reference was ever
 * recorded, or the terminal is not on a box. The slice is then cash.
 */
async function queueRefundVoid(
  tx: Tx,
  input: { attempt: AttemptRow; refundId: string; amountSatang: number; actor: RefundActor },
): Promise<string | null> {
  const { attempt } = input;
  const tranRef = attempt.tranRef ?? attempt.invoiceNo ?? attempt.terminalRef;
  if (!tranRef || !attempt.deviceId) return null;
  const [deviceRow] = await tx.select().from(device).where(eq(device.id, attempt.deviceId)).limit(1);
  if (!deviceRow?.boxId) return null;
  const payload = (attempt.payload ?? {}) as Record<string, unknown> & { wallet?: string | null };
  const tender = terminalTenderOf(attempt);
  const actionId = newId();
  await tx
    .update(paymentAttempt)
    .set({
      payload: {
        ...payload,
        void: {
          actionId,
          queuedAt: new Date().toISOString(),
          amountSatang: input.amountSatang,
          reason: 'refund',
          refundId: input.refundId,
        },
      } as never,
    })
    .where(eq(paymentAttempt.id, attempt.id));
  await queueTerminalCommand(tx, {
    boxId: deviceRow.boxId,
    branchId: attempt.branchId,
    operatorId: attempt.operatorId,
    actorAccountId: input.actor.accountId,
    actionId,
    requestId: input.actor.requestId,
    payload: {
      mode: 'void',
      attemptId: attempt.id,
      deviceId: deviceRow.id,
      stationId: attempt.stationId,
      role: roleForTender(tender),
      amountSatang: input.amountSatang,
      tender,
      ...(payload.wallet ? { wallet: payload.wallet } : {}),
      tranRef,
      ...(attempt.approvalCode ? { approvalCode: attempt.approvalCode } : {}),
    },
  });
  return actionId;
}

/**
 * THE GATEWAY'S HALF, after the refund has committed: each pending gateway
 * slice goes to `QrPayment.refund`, and its answer is stamped on the slice.
 *
 * After, not inside: this is a call to somebody else's server, and holding the
 * sale's row lock across it would stop the counter while 2C2P thinks. The cost
 * is stated rather than hidden — a crash between the commit and this call
 * leaves the slice `pending`, visible on the History detail, for a person to
 * finish; nothing is paid twice, because the slice is only ever sent from here.
 *
 * `V` first on a payment taken the same trading day (a void, before the
 * acquirer's cut-off) and `R` otherwise; an answer that the other one was
 * needed (`4121`) is tried the other way once. Never throws: a failure is the
 * slice's `failed`, and staff hand the money back in cash.
 */
export async function settleGatewayRefunds(
  db: Parameters<typeof withTx>[0],
  ctx: OpContext,
  refundId: string,
  qr: QrPayment,
): Promise<void> {
  const [row] = await db.select().from(refund).where(eq(refund.id, refundId)).limit(1);
  if (!row) return;
  const pending = (row.tenderAllocation ?? []).filter(
    (entry) => entry.route === 'gateway_refund' && entry.status === 'pending' && entry.attemptId,
  );
  for (const slice of pending) {
    const [attempt] = await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, slice.attemptId!)).limit(1);
    const invoiceNo = attempt?.invoiceNo;
    let update: Partial<RefundAllocationEntry>;
    if (!attempt || !invoiceNo) {
      update = { status: 'failed', fallback: 'cash', detail: 'No gateway invoice to refund — hand it back in cash' };
    } else {
      const [saleRow] = await db.select().from(sale).where(eq(sale.id, row.saleId)).limit(1);
      const sameDay = saleRow
        ? sameDayAs(attempt.paidAt ?? attempt.createdAt, new Date(), saleRow.timezone)
        : false;
      const first: 'V' | 'R' = sameDay ? 'V' : 'R';
      const second: 'V' | 'R' = first === 'V' ? 'R' : 'V';
      let processType = first;
      let answer = await callRefund(qr, invoiceNo, slice.amountSatang, first);
      if (answer.state === 'failed' && answer.respCode === '4121') {
        processType = second;
        answer = await callRefund(qr, invoiceNo, slice.amountSatang, second);
      }
      const ok = answer.respCode === '00' && answer.state !== 'failed';
      update = ok
        ? {
            status: 'done',
            processType,
            providerRef: answer.providerRefundRef,
            respCode: answer.respCode,
            detail: processType === 'V' ? 'Voided at the gateway' : 'Refunded at the gateway',
            settledAt: new Date().toISOString(),
          }
        : {
            status: 'failed',
            fallback: 'cash',
            processType,
            respCode: answer.respCode,
            detail: `The gateway refused (${answer.respDesc ?? answer.respCode}) — hand it back in cash`,
            settledAt: new Date().toISOString(),
          };
    }
    await withTx(db, { ...ctx, idempotency: undefined }, 'refund.gateway', (tx) =>
      settleRefundSlice(tx, {
        refundId,
        match: (entry) => entry.route === 'gateway_refund' && entry.attemptId === slice.attemptId,
        update,
        actorAccountId: ctx.actorAccountId ?? null,
        requestId: ctx.requestId,
        action: update.status === 'done' ? 'refund.gateway_refunded' : 'refund.gateway_refused',
      }),
    );
  }
}

/**
 * Whether the payment was taken on the calendar day, in the branch's zone,
 * that the refund is being made — inside the acquirer's same-day cut-off, so a
 * void (`V`) rather than a refund (`R`). The gateway has the last word: a `4121`
 * answer sends the other one.
 */
function sameDayAs(paidAt: Date, at: Date, timezone: string): boolean {
  return isoDateInTz(paidAt, timezone) === isoDateInTz(at, timezone);
}

async function callRefund(
  qr: QrPayment,
  invoiceNo: string,
  amountSatang: number,
  processType: 'V' | 'R',
): Promise<{ state: string; respCode: string; respDesc: string | null; providerRefundRef: string | null }> {
  try {
    return await qr.refund({ invoiceNo, amountSatang, processType });
  } catch (err) {
    return {
      state: 'failed',
      respCode: 'ERROR',
      respDesc: err instanceof AppError ? err.message : 'The gateway could not be reached',
      providerRefundRef: null,
    };
  }
}
