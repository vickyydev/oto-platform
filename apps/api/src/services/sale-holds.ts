import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  branch,
  member,
  paymentAttempt,
  sale,
  saleHold,
  station,
  type Db,
} from '@oto/db';
import {
  HELD_SALE_NOT_COLLECTED,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PAYMENT_ATTEMPT_TERMINAL_STATUSES,
  heldSaleKindOf,
  holdOutlivedItsDay,
  isPaymentReversalPending,
  newId,
  type EodOpenSale,
  type EodOpenSales,
  type HeldSale,
  type HeldSalesAnswer,
  type SaleHoldAnswer,
  type SaleHoldBody,
  type SaleResumeAnswer,
} from '@oto/shared';
import type { Env } from '../env';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { raiseAlert, resolveAlert } from './ops';
import { accountNames } from './refund-slices';
import { voidSale, type ActorContext } from './sale';
import { releaseOpenHold } from './sale-hold-release';
import { withTx, type Exec, type Tx } from './tx';

/**
 * SCRUM-774 — HOLD A SALE, AND SAVE ONE AS PARTLY PAID.
 *
 * At the till's payment step the sale is already on the ledger, `tendering`,
 * with whatever money was taken on it. Holding it parks that sale — nothing
 * is copied and nothing is issued — in the branch's Held sales list under the
 * customer's name or band, with an optional note. Any till at the branch may
 * take it back (`resumeHeldSale`), which moves the sale to that till so its
 * receipt and bands print where the balance is taken, and the payment then
 * goes through the same finalise as every sale: bands, receipt, check-in and
 * wallet credit are issued only on the call that brings the balance to zero.
 *
 * `held` is a sale with no money on it; `part_paid` is one parked after a part
 * payment. The till's button says which it meant, and the platform checks it
 * against the money rather than taking its word: a mismatch is refused with
 * the reason, so a sale with money on it is never parked as if it had none.
 *
 * WHAT IS REFUSED, each with its reason in words: a sale already closed or
 * voided; a sale already held; a payment still in progress (it may yet take
 * the money); a sale that owes nothing. The midnight rule
 * (`runHeldSalesMidnight`) and the End of Day's view (`openSalesOfDay`) are
 * at the end of this file.
 */

export interface HoldActor extends ActorContext {
  /** The till this session took, for a resume: where the balance is taken. */
  stationId: string | null;
}

interface SaleMoney {
  paidSatang: number;
  inFlight: boolean;
}

/** What has been taken on each sale, and whether a tender is still in progress. */
async function moneyOf(db: Exec, saleIds: readonly string[]): Promise<Map<string, SaleMoney>> {
  const out = new Map<string, SaleMoney>();
  if (saleIds.length === 0) return out;
  const rows = await db
    .select({
      saleId: paymentAttempt.saleId,
      status: paymentAttempt.status,
      amountSatang: paymentAttempt.amountSatang,
      payload: paymentAttempt.payload,
    })
    .from(paymentAttempt)
    .where(inArray(paymentAttempt.saleId, [...saleIds]));
  for (const row of rows) {
    if (!row.saleId) continue;
    const money = out.get(row.saleId) ?? { paidSatang: 0, inFlight: false };
    if (PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(row.status)) money.paidSatang += row.amountSatang;
    if (!PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(row.status) || isPaymentReversalPending(row.payload)) {
      money.inFlight = true;
    }
    out.set(row.saleId, money);
  }
  return out;
}

const NO_MONEY: SaleMoney = { paidSatang: 0, inFlight: false };

/** The rows of the Held sales list, with the money read live and the names resolved. */
async function heldViews(
  db: Exec,
  holds: readonly (typeof saleHold.$inferSelect)[],
): Promise<HeldSale[]> {
  if (holds.length === 0) return [];
  const saleIds = holds.map((h) => h.saleId);
  const sales = await db
    .select({ id: sale.id, grossSatang: sale.grossSatang, businessDate: sale.businessDate })
    .from(sale)
    .where(inArray(sale.id, saleIds));
  const saleOf = new Map(sales.map((s) => [s.id, s]));
  const stations = await db
    .select({ id: station.id, name: station.name })
    .from(station)
    .where(inArray(station.id, [...new Set(holds.map((h) => h.heldStationId))]));
  const stationName = new Map(stations.map((s) => [s.id, s.name]));
  const money = await moneyOf(db, saleIds);
  const nameOf = await accountNames(db, holds.map((h) => h.heldByAccountId));
  return holds.map((h) => {
    const row = saleOf.get(h.saleId);
    const gross = row?.grossSatang ?? h.paidSatang + h.balanceSatang;
    const paid = (money.get(h.saleId) ?? NO_MONEY).paidSatang;
    return {
      holdId: h.id,
      saleId: h.saleId,
      branchId: h.branchId,
      kind: heldSaleKindOf(paid),
      label: h.label,
      note: h.note,
      grossSatang: gross,
      paidSatang: paid,
      balanceSatang: Math.max(0, gross - paid),
      businessDate: row?.businessDate ?? '',
      heldAt: h.heldAt.toISOString(),
      heldBy: { accountId: h.heldByAccountId, name: nameOf(h.heldByAccountId) },
      heldStation: { id: h.heldStationId, name: stationName.get(h.heldStationId) ?? null },
      flaggedAt: h.flaggedAt?.toISOString() ?? null,
    };
  });
}

const fmt = (satang: number): string => `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Park a sale at the payment step: `Hold sale` (kind `held`, nothing paid) or
 * `Save as partly paid` (kind `part_paid`, after a part payment). Replayed by
 * the press's action id: the same press answers the hold it made.
 */
export async function holdSale(
  tx: Tx,
  actor: HoldActor,
  saleId: string,
  input: SaleHoldBody,
  now: Date = new Date(),
): Promise<SaleHoldAnswer> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  // The sale names the branch; the URL does not — checked on the row, as the void does.
  await actor.assertBranchAllowed?.(row.branchId);

  if (input.actionId) {
    const [already] = await tx
      .select()
      .from(saleHold)
      .where(and(eq(saleHold.operatorId, actor.operatorId), eq(saleHold.actionId, input.actionId)))
      .limit(1);
    if (already) {
      if (already.saleId !== saleId) {
        throw errors.conflict('ACTION_ID_REUSED', 'That press already held a different sale.');
      }
      const [view] = await heldViews(tx, [already]);
      return { replay: true, hold: view! };
    }
  }

  if (row.status === 'voided') {
    throw errors.conflict('SALE_VOIDED', 'This sale was voided — there is nothing to hold.');
  }
  if (row.status === 'finalised' || row.status === 'refunded') {
    throw errors.conflict('SALE_FINALISED', 'This sale is already paid — there is nothing to hold.');
  }
  const [open] = await tx
    .select()
    .from(saleHold)
    .where(and(eq(saleHold.saleId, saleId), isNull(saleHold.releasedAt)))
    .limit(1);
  if (open) {
    throw errors.conflict(
      'SALE_ALREADY_HELD',
      `This sale is already in Held sales under ${open.label}.`,
      { holdId: open.id },
    );
  }
  const money = (await moneyOf(tx, [saleId])).get(saleId) ?? NO_MONEY;
  if (row.status === 'paid' || money.inFlight) {
    throw errors.conflict(
      'PAYMENT_IN_FLIGHT',
      'A payment on this sale is still in progress — finish or cancel it before holding the sale.',
    );
  }
  const balance = row.grossSatang - money.paidSatang;
  if (balance <= 0) {
    throw errors.conflict(
      'SALE_OWES_NOTHING',
      'This sale owes nothing — complete it instead of holding it.',
    );
  }
  const kind = heldSaleKindOf(money.paidSatang);
  if (input.kind === 'held' && kind === 'part_paid') {
    throw errors.conflict(
      'SALE_PART_PAID',
      `${fmt(money.paidSatang)} has already been paid on this sale — save it as partly paid instead.`,
      { paidSatang: money.paidSatang },
    );
  }
  if (input.kind === 'part_paid' && kind === 'held') {
    throw errors.conflict(
      'NOTHING_PAID',
      'Nothing has been paid on this sale yet — take a part payment first, or hold the sale.',
    );
  }

  const label = input.label.trim();
  const note = input.note?.trim() ? input.note.trim() : null;
  const [hold] = await tx
    .insert(saleHold)
    .values({
      id: newId(),
      operatorId: row.operatorId,
      branchId: row.branchId,
      saleId,
      kind,
      label,
      note,
      paidSatang: money.paidSatang,
      balanceSatang: balance,
      heldByAccountId: actor.accountId,
      heldStationId: row.stationId,
      heldAt: now,
      actionId: input.actionId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!hold) throw new Error('the sale was not held');
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: 'sale.hold',
    entityType: 'sale',
    entityId: saleId,
    requestId: actor.requestId ?? null,
    actionId: input.actionId ?? null,
    before: { status: row.status, held: false },
    after: {
      held: true,
      holdId: hold.id,
      kind,
      label,
      note,
      paidSatang: money.paidSatang,
      balanceSatang: balance,
      stationId: row.stationId,
    },
  });
  const [view] = await heldViews(tx, [hold]);
  return { replay: false, hold: view! };
}

/** Why a sale that is not in the list cannot be resumed, in the till's words. */
async function notHeldRefusal(tx: Tx, row: typeof sale.$inferSelect): Promise<AppError> {
  if (row.status === 'voided') {
    return errors.conflict(
      'SALE_VOIDED',
      `This held sale was voided${row.voidReason ? ` — ${row.voidReason}` : ''}. It is no longer in Held sales.`,
    );
  }
  if (row.status === 'finalised' || row.status === 'refunded') {
    return errors.conflict('SALE_FINALISED', 'This held sale has been paid — find it in History.');
  }
  const [last] = await tx
    .select()
    .from(saleHold)
    .where(eq(saleHold.saleId, row.id))
    .orderBy(desc(saleHold.releasedAt))
    .limit(1);
  if (last?.releasedReason === 'resumed') {
    const [at] = last.resumedStationId
      ? await tx.select({ name: station.name }).from(station).where(eq(station.id, last.resumedStationId)).limit(1)
      : [];
    const nameOf = await accountNames(tx, last.releasedByAccountId ? [last.releasedByAccountId] : []);
    const who = last.releasedByAccountId ? nameOf(last.releasedByAccountId) : null;
    return errors.conflict(
      'SALE_HOLD_RESUMED',
      `This sale was already taken back${at ? ` to ${at.name}` : ''}${who ? ` by ${who}` : ''} — it is no longer in Held sales.`,
    );
  }
  return errors.conflict('SALE_NOT_HELD', 'This sale is not in Held sales.');
}

/**
 * Take a held sale back to the till this session took: the hold ends
 * (`resumed`), the sale moves to this till — its receipt and bands print here
 * and the money taken now goes in this drawer — and the till asks for the
 * balance only. A retry of the same press answers the same.
 */
export async function resumeHeldSale(
  tx: Tx,
  actor: HoldActor,
  saleId: string,
  input: { actionId?: string | undefined },
  now: Date = new Date(),
): Promise<SaleResumeAnswer> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed?.(row.branchId);

  const answerOf = async (
    hold: typeof saleHold.$inferSelect,
    stationId: string,
    replay: boolean,
  ): Promise<SaleResumeAnswer> => {
    const paid = ((await moneyOf(tx, [saleId])).get(saleId) ?? NO_MONEY).paidSatang;
    return {
      replay,
      saleId,
      stationId,
      kind: heldSaleKindOf(paid),
      label: hold.label,
      note: hold.note,
      grossSatang: row.grossSatang,
      paidSatang: paid,
      balanceSatang: Math.max(0, row.grossSatang - paid),
    };
  };

  if (input.actionId) {
    const [already] = await tx
      .select()
      .from(saleHold)
      .where(and(eq(saleHold.saleId, saleId), eq(saleHold.resumeActionId, input.actionId)))
      .limit(1);
    if (already) return answerOf(already, already.resumedStationId ?? row.stationId, true);
  }

  if (!actor.stationId) {
    throw errors.conflict(
      'NO_STATION',
      'Take a till before resuming a held sale — its receipt and bands print at the till that takes the balance.',
    );
  }
  const [till] = await tx
    .select({ id: station.id, branchId: station.branchId, operatorId: station.operatorId, name: station.name })
    .from(station)
    .where(and(eq(station.id, actor.stationId), isNull(station.archivedAt)))
    .limit(1);
  if (!till || till.operatorId !== row.operatorId || till.branchId !== row.branchId) {
    throw errors.conflict(
      'STATION_ELSEWHERE',
      'This held sale belongs to another branch — resume it from a till at that branch.',
    );
  }

  const [open] = await tx
    .select()
    .from(saleHold)
    .where(and(eq(saleHold.saleId, saleId), isNull(saleHold.releasedAt)))
    .limit(1);
  if (!open || row.status !== 'tendering') throw await notHeldRefusal(tx, row);

  if (row.stationId !== till.id) {
    try {
      await tx.update(sale).set({ stationId: till.id }).where(eq(sale.id, saleId));
    } catch (err) {
      // `sale_action_unique` is per till: the press that rang this sale up is
      // already a sale at this till — a collision nobody can fix here.
      throw new AppError(
        409,
        'RESUME_COLLISION',
        `This sale cannot move to ${till.name} — resume it at ${row.stationId === open.heldStationId ? 'the till it was held at' : 'another till'}.`,
        { cause: String(err) },
      );
    }
  }
  const ended = await releaseOpenHold(tx, saleId, 'resumed', actor, now, {
    resumedStationId: till.id,
    resumeActionId: input.actionId ?? null,
  });
  if (!ended) throw await notHeldRefusal(tx, row);
  return answerOf(ended, till.id, false);
}

/** The branch's Held sales list, oldest first: what every till at the branch shows. */
export async function listHeldSales(db: Exec, operatorId: string, branchId: string): Promise<HeldSalesAnswer> {
  const rows = await db
    .select({ hold: saleHold })
    .from(saleHold)
    .innerJoin(sale, eq(sale.id, saleHold.saleId))
    .where(
      and(
        eq(saleHold.operatorId, operatorId),
        eq(saleHold.branchId, branchId),
        isNull(saleHold.releasedAt),
        eq(sale.status, 'tendering'),
      ),
    )
    .orderBy(asc(saleHold.heldAt))
    .limit(200);
  const sales = await heldViews(db, rows.map((r) => r.hold));
  return {
    branchId,
    sales,
    counts: {
      held: sales.filter((s) => s.kind === 'held').length,
      partPaid: sales.filter((s) => s.kind === 'part_paid').length,
    },
  };
}

// --- The End of Day ---------------------------------------------------------

/**
 * The day's open sales, as the End of Day shows them and refuses on: every
 * sale of the branch-day still `tendering` that is held (no money) or has
 * money on it (part-paid, held or still on a till's screen). A sale rung up
 * and left with no money and no hold is neither — it is an unpaid cart the
 * till's own left-behind card deals with — and does not appear.
 */
export async function openSalesOfDay(
  db: Exec,
  operatorId: string,
  branchId: string,
  date: string,
): Promise<EodOpenSales> {
  const rows = await db
    .select({
      id: sale.id,
      grossSatang: sale.grossSatang,
      stationName: station.name,
      memberName: member.name,
      memberNickname: member.nickname,
    })
    .from(sale)
    .leftJoin(station, eq(station.id, sale.stationId))
    .leftJoin(member, eq(member.id, sale.memberId))
    .where(
      and(
        eq(sale.operatorId, operatorId),
        eq(sale.branchId, branchId),
        eq(sale.businessDate, date),
        eq(sale.status, 'tendering'),
      ),
    )
    .orderBy(asc(sale.occurredAt))
    .limit(500);
  const ids = rows.map((r) => r.id);
  const money = await moneyOf(db, ids);
  const holds = ids.length
    ? await db
        .select()
        .from(saleHold)
        .where(and(inArray(saleHold.saleId, ids), isNull(saleHold.releasedAt)))
    : [];
  const holdOf = new Map(holds.map((h) => [h.saleId, h]));
  const out: EodOpenSale[] = [];
  for (const r of rows) {
    const paid = (money.get(r.id) ?? NO_MONEY).paidSatang;
    const hold = holdOf.get(r.id);
    if (!hold && paid <= 0) continue;
    out.push({
      saleId: r.id,
      kind: heldSaleKindOf(paid),
      label: hold?.label ?? r.memberNickname ?? r.memberName ?? 'Walk-in',
      held: !!hold,
      stationName: r.stationName,
      grossSatang: r.grossSatang,
      paidSatang: paid,
      balanceSatang: Math.max(0, r.grossSatang - paid),
      flaggedAt: hold?.flaggedAt?.toISOString() ?? null,
    });
  }
  return {
    held: out.filter((r) => r.kind === 'held').length,
    partPaid: out.filter((r) => r.kind === 'part_paid').length,
    rows: out,
  };
}

// --- The midnight rule ------------------------------------------------------

/** Named once: the runner, the tests and the Health page. */
export const HELD_SALES_MIDNIGHT_JOB = 'job:sales.held_midnight';

export interface HeldMidnightSummary extends Record<string, unknown> {
  checked: number;
  voided: number;
  flagged: number;
  skipped: number;
  alertsOpened: number;
  alertsCleared: number;
}

const partPaidAlertKey = (branchId: string): string => `sales.part_paid:${branchId}`;

/**
 * `job:sales.held_midnight` — A HELD SALE NOBODY CAME BACK FOR.
 *
 * Every open hold whose calendar day has ended in its branch's timezone
 * (midnight, `holdOutlivedItsDay` — NOT the 05:00 business-day boundary):
 *
 *   - a held sale with no money is voided with the reason "not collected", by
 *     the platform (no account), through the same void a till uses — its
 *     voucher, benefit and document check are given back — and its hold ends
 *     `not_collected`; both are audited;
 *   - a part-paid sale is NEVER voided: money was taken and only a refund
 *     gives it back. It is flagged once (`flagged_at`, an audit row) and its
 *     branch's alert names how many wait for the manager; the End of Day
 *     refuses to close over it until it is resolved.
 *
 * A branch whose flagged sales are all resolved closes its own alert. Each
 * sale is its own transaction, so one refusal never holds up the rest.
 */
export async function runHeldSalesMidnight(
  db: Db,
  env: Pick<Env, 'ALERT_FLAP_WINDOW_S'>,
  now: Date = new Date(),
  log?: FastifyBaseLogger,
): Promise<HeldMidnightSummary> {
  const open = await db
    .select({ hold: saleHold, timezone: branch.timezone })
    .from(saleHold)
    .innerJoin(sale, eq(sale.id, saleHold.saleId))
    .innerJoin(branch, eq(branch.id, saleHold.branchId))
    .where(and(isNull(saleHold.releasedAt), eq(sale.status, 'tendering')))
    .orderBy(asc(saleHold.heldAt))
    .limit(1000);
  const summary: HeldMidnightSummary = {
    checked: open.length,
    voided: 0,
    flagged: 0,
    skipped: 0,
    alertsOpened: 0,
    alertsCleared: 0,
  };
  const due = open.filter((r) => holdOutlivedItsDay(r.hold.heldAt, now, r.timezone));
  const money = await moneyOf(db, due.map((r) => r.hold.saleId));
  for (const { hold } of due) {
    const paid = (money.get(hold.saleId) ?? NO_MONEY).paidSatang;
    const ctx = { actorAccountId: null, operatorId: hold.operatorId, branchId: hold.branchId, ...(log ? { log } : {}) };
    const system = { accountId: null, operatorId: hold.operatorId, requestId: null };
    if (paid > 0) {
      if (hold.flaggedAt) continue;
      await withTx(db, ctx, 'sale.hold.flag', async (tx) => {
        const [flagged] = await tx
          .update(saleHold)
          .set({ flaggedAt: now, updatedAt: now })
          .where(and(eq(saleHold.id, hold.id), isNull(saleHold.releasedAt), isNull(saleHold.flaggedAt)))
          .returning({ id: saleHold.id });
        if (!flagged) return;
        await audit.record(tx, {
          actorAccountId: null,
          operatorId: hold.operatorId,
          branchId: hold.branchId,
          action: 'sale.hold.flag',
          entityType: 'sale',
          entityId: hold.saleId,
          origin: 'job',
          before: { holdId: hold.id, flagged: false },
          after: { holdId: hold.id, flagged: true, label: hold.label, paidSatang: paid, reason: 'part_paid_at_midnight' },
        });
        summary.flagged += 1;
      });
      continue;
    }
    try {
      await withTx(db, ctx, 'sale.hold.not_collected', async (tx) => {
        // The hold ends first, `not_collected`, so the void below finds it
        // already out of the list and does not end it a second time.
        const ended = await releaseOpenHold(tx, hold.saleId, 'not_collected', system, now);
        if (!ended) return;
        await voidSale(
          tx,
          { accountId: null, operatorId: hold.operatorId, branchId: hold.branchId },
          hold.saleId,
          { reason: HELD_SALE_NOT_COLLECTED },
          now,
        );
        summary.voided += 1;
      });
    } catch (err) {
      // Money arrived since it was read, or a tender started: it is left for
      // the next tick, which reads it again as part-paid or in flight.
      summary.skipped += 1;
      log?.warn({ err, saleId: hold.saleId }, 'held sale not voided at midnight');
    }
  }

  // The manager's alert, one per branch: open while a flagged part-paid sale
  // waits, closed by itself when none does.
  const flaggedRows = await db
    .select({ branchId: saleHold.branchId, operatorId: saleHold.operatorId, saleId: saleHold.saleId, label: saleHold.label })
    .from(saleHold)
    .innerJoin(sale, eq(sale.id, saleHold.saleId))
    .where(and(isNull(saleHold.releasedAt), isNotNull(saleHold.flaggedAt), eq(sale.status, 'tendering')));
  const byBranch = new Map<string, { operatorId: string; labels: string[]; saleIds: string[] }>();
  for (const r of flaggedRows) {
    const bucket = byBranch.get(r.branchId) ?? { operatorId: r.operatorId, labels: [], saleIds: [] };
    bucket.labels.push(r.label);
    bucket.saleIds.push(r.saleId);
    byBranch.set(r.branchId, bucket);
  }
  for (const [branchId, bucket] of byBranch) {
    const n = bucket.saleIds.length;
    const raised = await raiseAlert(
      db,
      {
        key: partPaidAlertKey(branchId),
        category: 'sales.part_paid',
        severity: 'warning',
        subject: 'Partly paid sales waiting for the manager',
        summary:
          `${n} partly paid sale${n === 1 ? ' was' : 's were'} still in Held sales at midnight: ` +
          `${bucket.labels.slice(0, 5).join(', ')}${n > 5 ? ` and ${n - 5} more` : ''}. ` +
          'Take the balance or refund what was paid; End of Day cannot close until then.',
        detail: { saleIds: bucket.saleIds.slice(0, 20) },
        operatorId: bucket.operatorId,
        branchId,
      },
      { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
    );
    if (raised.outcome === 'opened') summary.alertsOpened += 1;
  }
  const everFlagged = await db
    .selectDistinct({ branchId: saleHold.branchId })
    .from(saleHold)
    .where(isNotNull(saleHold.flaggedAt));
  for (const { branchId } of everFlagged) {
    if (byBranch.has(branchId)) continue;
    if (await resolveAlert(db, partPaidAlertKey(branchId), 'resolved')) summary.alertsCleared += 1;
  }
  return summary;
}
