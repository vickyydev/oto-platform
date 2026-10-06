import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  account,
  box,
  branch,
  cashMovement,
  device,
  endOfDay,
  occupancyResolution,
  paymentAttempt,
  refund,
  role,
  roleAssignment,
  rolePermission,
  sale,
  station,
} from '@oto/db';
import {
  DEFAULT_FLOAT,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  applyEndOfDayEntries,
  businessDate,
  countsAsTillTakings,
  newId,
  parseDayStart,
  recomputeEndOfDay,
  wallClockMinutesInTz,
  type CashMovementBody,
  type CashMovementView,
  type CashPerson,
  type EndOfDayCloseBody,
  type EndOfDayRecord,
  type EndOfDayReprintBody,
  type EodLine,
  type EodOverride,
  type EodProvisionalBox,
  type EodReceipt,
  type EodStrandedRow,
  type EodTerminal,
  type Permission,
  type RefundAllocationEntry,
  type StrandedResolveAnswer,
  type StrandedResolveBody,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { holdsGrantAt } from './access-control';
import { strandedOf } from './occupancy';
import { hasPermission, type EffectivePermission } from './permissions';
import { accountNames } from './refund-slices';
import { allocateReceipt } from './sale';
import { endOfDayReceiptJobs, queueEndOfDayReceipt } from './sale-printing';
import { boxBacklogOf } from './station-session';
import { boxOutboxState } from './sync';
import type { Exec, Tx } from './tx';
import { creditRedeemedOn } from './wallet';

/**
 * S2-15a round 1 — THE END OF DAY, on the platform's records.
 *
 * The behaviour is the prototype's Today > End of Day, ported as it is
 * (`imports/oto-pos/artifacts/oto-till/src/mockApi.ts:2183-2361`,
 * `lib/endOfDay.ts`), under the owner's ruling on SCRUM-488: ONE combined
 * cash count for the whole branch per business day (plan
 * docs/progress/plans/cash/PLAN.md, revised 2 Oct, §2).
 *
 *   getEndOfDay    a CLOSED day is read back exactly as saved; an open one is
 *                  worked out fresh from the records every time it is read
 *                  (`getEndOfDay`), the float carried from the latest earlier
 *                  close or the standard ฿6,000 (`getFloatCarryover`);
 *   closeEndOfDay  any account holding `pos:cash:day_close` at the branch
 *                  closes, whatever the verdict and with or without notes; the
 *                  expected side and the totals are worked out again here and
 *                  never taken from the caller; a second close is refused
 *                  (`closeEndOfDay` returning null);
 *   recordMovement a paid-out (approved by somebody else holding
 *                  `pos:cash:approve`) or a safe drop (witnessed by somebody
 *                  else at the branch) — SCRUM-215, where the prototype has
 *                  nothing — each taken off the expected cash.
 *
 * Fixed where the prototype's figures came from the wrong place (plan §3):
 * only THIS branch's records; the branch's BUSINESS date, which every attempt
 * carries, never a UTC slice; each card attempt's real TID, and card money
 * with no TID on a line of its own rather than dropped; money that is not the
 * till's — the booking site's (no station), the platform-written credit and
 * paid-online tenders — kept off the till lines by `countsAsTillTakings`.
 *
 * Round 2 (SCRUM-215, plan §4), where the prototype has nothing:
 *
 *   provisional    while any box of the branch holds facts it has not
 *                  delivered, or its clock is out and unmeasured, the open day
 *                  lists it and Close Day is refused with its name;
 *   stranded       who is still counted inside is listed at close; each row is
 *                  cleared by a manual resolution (`gate.manual_resolution`),
 *                  and while any is left only a holder of `pos:cash:approve`
 *                  closes, with a reason (`end_of_day.override`), kept on the
 *                  closed day;
 *   receipt        printed at close on the closing counter's printer, numbered
 *                  on its own `end_of_day` series; reprinted from the closed day.
 *                  Closed with no counter that can print, the day still closes
 *                  and the receipt waits: the first print from a counter numbers
 *                  it on that counter's series.
 */

/** The prototype's sentinel for card money with no terminal (`pickTerminalTid`). */
export const NO_TERMINAL_TID = 'NO-TERMINAL';

/** The prototype's channel for an attempt's kind of money (`getEndOfDay`, by method KIND). */
export function channelOfAttempt(a: { method: string; methodCode: string | null; tid: string | null }): string {
  if (a.method === 'cash') return 'cash';
  if (a.method === 'qr') return 'promptpay';
  if (a.method === 'card') return `card:${a.tid?.trim() || NO_TERMINAL_TID}`;
  return `method:${a.methodCode ?? a.method}`;
}

export interface TillAttempt {
  id: string;
  method: string;
  methodCode: string | null;
  stationId: string | null;
  tid: string | null;
  amountSatang: number;
}

export interface ExpectedInputs {
  /** The branch-day's attempts that took money and pass `countsAsTillTakings`. */
  attempts: readonly TillAttempt[];
  /**
   * Every refund slice of a sale whose business date is this day, with the
   * attempt it went back through (null for a cash remainder with none). Wallet
   * slices are on the credit line already and are skipped here.
   */
  refundSlices: readonly { slice: RefundAllocationEntry; attempt: TillAttempt | null; tillMoney: boolean }[];
  terminals: readonly EodTerminal[];
  /** Wallet credit redeemed less credit restored (`GET /wallets/credit-day`). */
  creditSatang: number;
  /** Paid-outs and safe drops of the day, each taken off the expected cash. */
  movementsSatang: number;
}

/**
 * Which line a refund slice reduces: the tender it went back through. Cash
 * handed back from a drawer — a cash slice, or a reversal the terminal or the
 * gateway refused and staff paid in cash — is the cash line; a void or a
 * gateway refund is the line of the attempt it reversed. Null: nothing
 * reaches the till lines (credit put back on a wallet is the credit line's;
 * a refused reversal with no cash fallback moved no money; money that was
 * never the till's is not taken off its lines).
 */
export function channelOfRefundSlice(
  slice: Pick<RefundAllocationEntry, 'route' | 'status' | 'fallback' | 'method' | 'methodCode'>,
  attempt: TillAttempt | null,
  tillMoney: boolean,
): string | null {
  if (slice.route === 'wallet') return null;
  if (slice.status === 'failed') return slice.fallback === 'cash' ? 'cash' : null;
  if (slice.route === 'cash') return 'cash';
  if (attempt) return tillMoney ? channelOfAttempt(attempt) : null;
  return channelOfAttempt({ method: slice.method, methodCode: slice.methodCode, tid: null });
}

/**
 * THE EXPECTED SIDE, in the prototype's order: cash; PromptPay / QR; a card
 * line per terminal of the branch (zero lines kept), then any other TID that
 * took money and the card money with no TID; a `method:<token>` line per other
 * kind of tender that took money; e-wallet, bank transfer and party prepayments
 * at zero (none of them is on the platform yet); credit. Pure.
 */
export function expectedLinesOf(input: ExpectedInputs): EodLine[] {
  const sums = new Map<string, number>();
  const add = (channel: string, satang: number) => sums.set(channel, (sums.get(channel) ?? 0) + satang);
  const tookMoney = new Set<string>();
  for (const a of input.attempts) {
    const channel = channelOfAttempt(a);
    add(channel, a.amountSatang);
    tookMoney.add(channel);
  }
  for (const { slice, attempt, tillMoney } of input.refundSlices) {
    const channel = channelOfRefundSlice(slice, attempt, tillMoney);
    if (channel) add(channel, -slice.amountSatang);
  }
  add('cash', -input.movementsSatang);

  const line = (channel: string, expectedSatang: number): EodLine => ({
    channel,
    expectedSatang,
    actualSatang: null,
    differenceSatang: 0,
  });
  const terminalChannels = input.terminals.map((t) => `card:${t.tid}`);
  const known = new Set(terminalChannels);
  const otherCards = [...tookMoney]
    .filter((c) => c.startsWith('card:') && !known.has(c) && c !== `card:${NO_TERMINAL_TID}`)
    .sort();
  if (tookMoney.has(`card:${NO_TERMINAL_TID}`)) otherCards.push(`card:${NO_TERMINAL_TID}`);
  const methods = [...tookMoney].filter((c) => c.startsWith('method:')).sort();

  return [
    line('cash', sums.get('cash') ?? 0),
    line('promptpay', sums.get('promptpay') ?? 0),
    ...[...terminalChannels, ...otherCards].map((c) => line(c, sums.get(c) ?? 0)),
    ...methods.map((c) => line(c, sums.get(c) ?? 0)),
    line('ewallet', 0),
    line('bank_transfer', 0),
    // Parties are not on the platform yet: the prototype's own channel, at zero.
    line('party_prepay', 0),
    line('credit', input.creditSatang),
  ];
}

// --- Reading -------------------------------------------------------------------

interface BranchClock {
  id: string;
  operatorId: string;
  timezone: string;
  dayStartMinutes: number;
}

/** The branch, inside the caller's operator — 404 for anybody else's. */
export async function branchClockFor(db: Exec, operatorId: string, branchId: string): Promise<BranchClock> {
  const [row] = await db
    .select({ id: branch.id, operatorId: branch.operatorId, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return { id: row.id, operatorId: row.operatorId, timezone: row.timezone, dayStartMinutes: parseDayStart(row.dayStart) };
}

/** The branch's current business day. */
export function currentBusinessDate(clock: BranchClock, now: Date = new Date()): string {
  return businessDate(now, clock.timezone, clock.dayStartMinutes);
}

/** The branch's card terminals, as each `card:<tid>` line is labelled. */
async function terminalsOf(db: Exec, branchId: string): Promise<EodTerminal[]> {
  const rows = await db
    .select({ tid: device.terminalId, label: device.label })
    .from(device)
    .where(and(eq(device.branchId, branchId), eq(device.kind, 'terminal'), isNull(device.archivedAt), isNotNull(device.terminalId)))
    .orderBy(asc(device.label), asc(device.createdAt));
  const seen = new Set<string>();
  const out: EodTerminal[] = [];
  for (const r of rows) {
    const tid = r.tid?.trim();
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    out.push({ tid, label: r.label });
  }
  return out;
}

/**
 * The start-of-day float (`getFloatCarryover`): the float left at the latest
 * EARLIER close of this branch, or the standard float when there is none.
 */
export async function floatCarryover(db: Exec, branchId: string, date: string): Promise<{ amountSatang: number; fromDate: string | null }> {
  const [prior] = await db
    .select({ date: endOfDay.businessDate, floatLeft: endOfDay.floatLeftSatang })
    .from(endOfDay)
    .where(and(eq(endOfDay.branchId, branchId), lt(endOfDay.businessDate, date), isNotNull(endOfDay.floatLeftSatang)))
    .orderBy(desc(endOfDay.businessDate))
    .limit(1);
  return prior ? { amountSatang: prior.floatLeft as number, fromDate: prior.date } : { amountSatang: DEFAULT_FLOAT, fromDate: null };
}

async function movementsOf(db: Exec, branchId: string, date: string): Promise<CashMovementView[]> {
  const rows = await db
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.branchId, branchId), eq(cashMovement.businessDate, date)))
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id));
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => [r.actorAccountId, r.approverAccountId, r.witnessAccountId].filter((id): id is string => !!id)),
  );
  return rows.map((r) => movementViewOf(r, nameOf));
}

function movementViewOf(r: typeof cashMovement.$inferSelect, nameOf: (id: string) => string | null): CashMovementView {
  const person = (id: string | null) => (id ? { accountId: id, name: nameOf(id) } : null);
  return {
    id: r.id,
    kind: r.kind,
    amountSatang: r.amountSatang,
    reason: r.reason,
    businessDate: r.businessDate,
    actor: { accountId: r.actorAccountId, name: nameOf(r.actorAccountId) },
    approver: person(r.approverAccountId),
    witness: person(r.witnessAccountId),
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * The money of one branch-day, read from the platform's records: the attempts
 * dated this business day that took money at a counter, and the refund slices
 * of the sales dated this business day — a refund comes off its ORIGINAL
 * sale's day, whenever it was made (the prototype's rule; plan §5 says what
 * that costs).
 */
async function expectedInputsOf(db: Exec, operatorId: string, branchId: string, date: string, movements: readonly CashMovementView[]): Promise<ExpectedInputs> {
  const taken = await db
    .select({
      id: paymentAttempt.id,
      method: paymentAttempt.method,
      methodCode: paymentAttempt.methodCode,
      stationId: paymentAttempt.stationId,
      tid: paymentAttempt.tid,
      amountSatang: paymentAttempt.amountSatang,
    })
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.operatorId, operatorId),
        eq(paymentAttempt.branchId, branchId),
        eq(paymentAttempt.businessDate, date),
        inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES]),
      ),
    );
  const attempts = taken.filter((a) => countsAsTillTakings(a));

  const refunds = await db
    .select({ allocation: refund.tenderAllocation })
    .from(refund)
    .innerJoin(sale, eq(sale.id, refund.saleId))
    .where(and(eq(refund.operatorId, operatorId), eq(sale.branchId, branchId), eq(sale.businessDate, date)));
  const slices = refunds.flatMap((r) => r.allocation ?? []);
  const attemptIds = [...new Set(slices.map((s) => s.attemptId).filter((id): id is string => !!id))];
  const reversed = attemptIds.length
    ? await db
        .select({
          id: paymentAttempt.id,
          method: paymentAttempt.method,
          methodCode: paymentAttempt.methodCode,
          stationId: paymentAttempt.stationId,
          tid: paymentAttempt.tid,
          amountSatang: paymentAttempt.amountSatang,
        })
        .from(paymentAttempt)
        .where(inArray(paymentAttempt.id, attemptIds))
    : [];
  const byId = new Map(reversed.map((a) => [a.id, a]));

  const credit = await creditRedeemedOn(db, operatorId, branchId, date);
  return {
    attempts,
    refundSlices: slices.map((slice) => {
      const attempt = slice.attemptId ? (byId.get(slice.attemptId) ?? null) : null;
      return { slice, attempt, tillMoney: attempt ? countsAsTillTakings(attempt) : true };
    }),
    terminals: await terminalsOf(db, branchId),
    creditSatang: credit.netSatang,
    movementsSatang: movements.reduce((sum, m) => sum + m.amountSatang, 0),
  };
}

/** A fresh OPEN record for a branch-day, built as the prototype's `getEndOfDay` builds it. */
async function openRecordOf(db: Exec, clock: BranchClock, date: string): Promise<EndOfDayRecord> {
  const movements = await movementsOf(db, clock.id, date);
  const inputs = await expectedInputsOf(db, clock.operatorId, clock.id, date, movements);
  const carry = await floatCarryover(db, clock.id, date);
  return recomputeEndOfDay<EndOfDayRecord>({
    id: `eod-${clock.id}-${date}`,
    branchId: clock.id,
    date,
    status: 'open',
    lines: expectedLinesOf(inputs),
    cashCount: { countedSatang: null, floatSatang: carry.amountSatang, cashIncomeSatang: null },
    floatFromDate: carry.fromDate,
    floatLeftSatang: DEFAULT_FLOAT,
    vouchers: { handedOut: null, redeemed: null },
    totalExpectedSatang: 0,
    totalActualSatang: 0,
    totalDifferenceSatang: 0,
    notes: null,
    closedBy: null,
    closedAt: null,
    terminals: [...inputs.terminals],
    cashMovements: movements,
  });
}

/**
 * What a day closed away from a printing counter says: the close stands, the
 * receipt waits, and a reprint from a counter numbers and prints it.
 */
export const RECEIPT_PENDING = 'Receipt not printed — reprint it from a counter';

/** The closed day's receipt: its number, its counter and every print of it. */
async function receiptOf(db: Exec, row: typeof endOfDay.$inferSelect): Promise<EodReceipt> {
  const [counter] = row.receiptStationId
    ? await db.select({ name: station.name, boxId: station.boxId }).from(station).where(eq(station.id, row.receiptStationId)).limit(1)
    : [];
  const jobs = await endOfDayReceiptJobs(db, row.id);
  const last = jobs[jobs.length - 1];
  const note = !row.receiptNumber
    ? RECEIPT_PENDING
    : !last
      ? counter && !counter.boxId
        ? `End of Day receipt not printed — ${counter.name} is not attached to a box`
        : 'The End of Day receipt could not be queued — reprint it from the closed day'
      : last.status === 'skipped' || last.status === 'failed'
        ? `End of Day receipt not printed — ${last.errorMessage ?? 'the printer did not take it'}`
        : null;
  return {
    number: row.receiptNumber,
    stationId: row.receiptStationId,
    stationName: counter?.name ?? null,
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      reprint: j.reprintReason !== null || j.reprintOf !== null,
      deviceLabel: j.deviceLabel,
      errorMessage: j.errorMessage,
      queuedAt: j.queuedAt,
    })),
    note,
  };
}

/** A CLOSED day, exactly as it was saved. */
async function closedRecordOf(db: Exec, row: typeof endOfDay.$inferSelect): Promise<EndOfDayRecord> {
  const nameOf = await accountNames(db, [row.closedByAccountId, row.overrideByAccountId].filter((id): id is string => !!id));
  const override: EodOverride | null =
    row.overrideByAccountId && row.overrideReason
      ? {
          by: { accountId: row.overrideByAccountId, name: nameOf(row.overrideByAccountId) },
          reason: row.overrideReason,
          at: row.closedAt.toISOString(),
          stranded: row.overrideStranded ?? [],
        }
      : null;
  return {
    id: row.id,
    branchId: row.branchId,
    date: row.businessDate,
    status: 'closed',
    lines: row.lines,
    cashCount: {
      countedSatang: row.countedSatang,
      floatSatang: row.floatSatang,
      cashIncomeSatang: row.countedSatang === null ? null : row.countedSatang - row.floatSatang,
    },
    floatFromDate: row.floatFromDate,
    floatLeftSatang: row.floatLeftSatang,
    vouchers: { handedOut: row.vouchersHandedOut, redeemed: row.vouchersRedeemed },
    totalExpectedSatang: row.totalExpectedSatang,
    totalActualSatang: row.totalActualSatang,
    totalDifferenceSatang: row.totalDifferenceSatang,
    notes: row.notes,
    closedBy: { accountId: row.closedByAccountId, name: nameOf(row.closedByAccountId) },
    closedAt: row.closedAt.toISOString(),
    terminals: await terminalsOf(db, row.branchId),
    cashMovements: await movementsOf(db, row.branchId, row.businessDate),
    override,
    receipt: await receiptOf(db, row),
  };
}

async function closedRow(db: Exec, branchId: string, date: string) {
  const [row] = await db
    .select()
    .from(endOfDay)
    .where(and(eq(endOfDay.branchId, branchId), eq(endOfDay.businessDate, date)))
    .limit(1);
  return row ?? null;
}

/**
 * One branch-day: the saved record when closed, a fresh open one otherwise,
 * with what keeps it provisional and who is still counted inside.
 */
export async function getEndOfDay(
  db: Exec,
  operatorId: string,
  branchId: string,
  date: string,
  now: Date = new Date(),
): Promise<EndOfDayRecord> {
  const clock = await branchClockFor(db, operatorId, branchId);
  const saved = await closedRow(db, branchId, date);
  if (saved) return closedRecordOf(db, saved);
  const open = await openRecordOf(db, clock, date);
  return {
    ...open,
    provisional: await provisionalBoxesOf(db, clock, now),
    stranded: (await strandedOf(db, { operatorId, branchId, date, now })).rows,
  };
}

// --- Round 2: the provisional close --------------------------------------------

/**
 * The tolerance the sync path holds a box's clock to (`CLOCK_TOLERANCE_MS` in
 * services/sync.ts and services/ops.ts): past it, what the box stamps is not
 * trusted to date anything.
 */
const CLOCK_TOLERANCE_MS = 60_000;

function hhmmAt(at: Date, timezone: string): string {
  const minutes = wallClockMinutesInTz(at, timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Every box of the branch that keeps the day provisional: one that holds
 * facts it has not delivered (its outbox, or a Pi's heartbeat depth), or one
 * whose last report has its clock out of tolerance and not measured by the
 * box, so what it stamps may land on the wrong day. Archived and never
 * registered boxes are not listed. A disabled box still blocks if it holds
 * undelivered records; disabling it cannot make those records disappear.
 */
export async function provisionalBoxesOf(db: Exec, clock: BranchClock, now: Date = new Date()): Promise<EodProvisionalBox[]> {
  const boxes = await db
    .select({ id: box.id, name: box.name, role: box.role, status: box.status, lastStatus: box.lastStatus })
    .from(box)
    .where(and(eq(box.branchId, clock.id), isNull(box.archivedAt), isNotNull(box.registeredAt)))
    .orderBy(asc(box.name), asc(box.id));
  const out: EodProvisionalBox[] = [];
  for (const b of boxes) {
    const backlog = boxBacklogOf(b.role, await boxOutboxState(db, b.id), b.lastStatus);
    if (backlog.depth > 0) {
      const since = backlog.since && backlog.since.getTime() <= now.getTime() ? backlog.since : null;
      out.push({
        boxId: b.id,
        name: b.name,
        reason: 'outbox',
        waiting: backlog.depth,
        since: since?.toISOString() ?? null,
        message: `${b.name} has ${backlog.depth} record${backlog.depth === 1 ? '' : 's'} it has not sent yet${since ? `, waiting since ${hhmmAt(since, clock.timezone)}` : ''}.`,
      });
    }
    const status = b.lastStatus && typeof b.lastStatus === 'object' ? (b.lastStatus as Record<string, unknown>) : null;
    const offset = typeof status?.clockOffsetMs === 'number' ? status.clockOffsetMs : null;
    if (b.status !== 'disabled' && offset !== null && Math.abs(offset) > CLOCK_TOLERANCE_MS && status?.clockMeasuredBy !== 'box') {
      const readAt = typeof status?.clockMeasuredAt === 'string' ? status.clockMeasuredAt : typeof status?.receivedAt === 'string' ? status.receivedAt : null;
      const minutes = Math.max(1, Math.round(Math.abs(offset) / 60_000));
      out.push({
        boxId: b.id,
        name: b.name,
        reason: 'clock',
        waiting: null,
        since: readAt,
        message: `${b.name}'s clock is ${minutes} minute${minutes === 1 ? '' : 's'} ${offset > 0 ? 'ahead' : 'behind'} and it has not corrected it, so what it recorded may be on the wrong day.`,
      });
    }
  }
  return out;
}

const dayProvisional = (boxes: readonly EodProvisionalBox[]) =>
  new AppError(
    409,
    'DAY_PROVISIONAL',
    `The day is still provisional — ${boxes.map((b) => b.message).join(' ')} Close Day once every box has caught up.`,
  );

// --- Round 2: stranded occupancy -----------------------------------------------

const strandedRefusal = (rows: readonly EodStrandedRow[]) =>
  new AppError(
    409,
    'STRANDED_OCCUPANCY',
    `${rows.length} ${rows.length === 1 ? 'is' : 'are'} still counted inside the park — resolve each one, or a manager closes the day with a reason.`,
  );

/**
 * Clear one row still counted inside: left without scanning, band lost, or a
 * gate fault, recorded with who did it. From `resolved_at` on the row is off
 * the count; the gate's journal and the check-in are untouched. Refused once
 * the day is closed, and for a row that is no longer counted inside.
 */
export async function resolveStranded(
  tx: Tx,
  actor: CashActor,
  branchId: string,
  input: StrandedResolveBody,
  now: Date = new Date(),
): Promise<StrandedResolveAnswer> {
  const clock = await branchClockFor(tx, actor.operatorId, branchId);
  if (input.date > currentBusinessDate(clock, now)) throw errors.badRequest('That day has not started yet.');
  const actionId = input.actionId ?? newId();
  const listNow = async () => (await strandedOf(tx, { operatorId: actor.operatorId, branchId, date: input.date, now })).rows;

  // The press is the key: a retry of the same press answers what it recorded.
  const [already] = await tx
    .select()
    .from(occupancyResolution)
    .where(and(eq(occupancyResolution.operatorId, actor.operatorId), eq(occupancyResolution.actionId, actionId)))
    .limit(1);
  if (already) {
    const subject = already.kind === 'band' ? already.bandId : already.checkinId;
    const note = input.note?.trim() || null;
    if (
      already.branchId !== branchId || already.businessDate !== input.date || already.kind !== input.kind ||
      subject !== input.subjectId || already.reason !== input.reason || already.note !== note
    ) {
      throw errors.conflict('ACTION_ID_REUSED', 'That press was already used for a different resolution.');
    }
    return { resolutionId: already.id, replayed: true, stranded: await listNow() };
  }

  await lockDay(tx, branchId, input.date);
  if (await closedRow(tx, branchId, input.date)) throw dayClosed();
  const { rows, at } = await strandedOf(tx, { operatorId: actor.operatorId, branchId, date: input.date, now });
  const target = rows.find((r) => r.kind === input.kind && r.subjectId === input.subjectId);
  if (!target) {
    throw errors.conflict(
      'NOT_STRANDED',
      input.kind === 'band' ? 'That band is no longer counted inside.' : 'That child is no longer counted as checked in.',
    );
  }
  const note = input.note?.trim() ? input.note.trim() : null;
  const resolutionId = newId();
  await tx.insert(occupancyResolution).values({
    id: resolutionId,
    operatorId: actor.operatorId,
    branchId,
    businessDate: input.date,
    kind: input.kind,
    bandId: input.kind === 'band' ? input.subjectId : null,
    checkinId: input.kind === 'checkin' ? input.subjectId : null,
    reason: input.reason,
    note,
    resolvedByAccountId: actor.accountId,
    resolvedAt: at,
    actionId,
    createdAt: now,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: 'gate.manual_resolution',
    entityType: 'occupancy_resolution',
    entityId: resolutionId,
    actionId,
    requestId: actor.requestId,
    before: { businessDate: input.date, stranded: target },
    after: {
      businessDate: input.date,
      kind: input.kind,
      subjectId: input.subjectId,
      reason: input.reason,
      note,
      resolvedAt: at.toISOString(),
    },
  });
  return { resolutionId, replayed: false, stranded: await listNow() };
}

// --- Round 2: the closing counter and the receipt -------------------------------

/** A counter of this branch, inside the caller's operator; null when none is named. */
async function counterAt(db: Exec, operatorId: string, branchId: string, stationId: string | null, strict: boolean) {
  if (!stationId) return null;
  const [row] = await db
    .select()
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.operatorId, operatorId), isNull(station.archivedAt)))
    .limit(1);
  if (!row || row.branchId !== branchId) {
    if (strict) throw new AppError(404, 'STATION_NOT_FOUND', 'No such counter at this branch.');
    return null;
  }
  return row;
}

/**
 * The counter a close prints on: the one this session took, when it belongs to
 * this branch and can print (a receipt series and a box). A named counter of
 * another branch is refused; otherwise having no counter that can print is
 * not a refusal. Any holder of pos:cash:day_close may close (PLAN.md §2, "Who
 * closes"): the day closes and its receipt waits for a reprint from a counter.
 */
async function closingCounter(tx: Tx, actor: CashActor, branchId: string, requestedId: string | null) {
  const requested = requestedId ? await counterAt(tx, actor.operatorId, branchId, requestedId, true) : null;
  const taken = await counterAt(tx, actor.operatorId, branchId, actor.stationId ?? null, false);
  // Print on the counter this session took, never an arbitrary branch counter.
  const counter = requested ? (requested.id === taken?.id ? taken : null) : taken;
  return counter?.codePrefix && counter.boxId ? { ...counter, codePrefix: counter.codePrefix } : null;
}

/** A reprint prints on the counter this session took, and refuses one that cannot print. */
async function printingCounter(tx: Tx, actor: CashActor, branchId: string, requestedId: string | null) {
  if (requestedId) {
    const requested = await counterAt(tx, actor.operatorId, branchId, requestedId, true);
    if (requested?.id !== actor.stationId) {
      throw new AppError(403, 'STATION_NOT_PICKED', 'Take this counter before printing its End of Day receipt.');
    }
  }
  if (!actor.stationId) {
    throw errors.conflict('NO_COUNTER', 'Take a counter before reprinting End of Day.');
  }
  const counter = await counterAt(tx, actor.operatorId, branchId, actor.stationId, true);
  if (!counter?.codePrefix) {
    throw errors.conflict('NO_RECEIPT_SERIES', 'This counter has no receipt series for End of Day.');
  }
  if (!counter.boxId) {
    throw errors.conflict('STATION_HAS_NO_BOX', `${counter.name} is not attached to a box, so nothing on it can print.`);
  }
  return { ...counter, codePrefix: counter.codePrefix };
}

/**
 * Print the closed day's receipt again at the session's counter. A copy names
 * the original job and carries the figures exactly as
 * they were locked. A day closed without a receipt is numbered here, once, on
 * this counter's series, and this print is its first (not a copy).
 */
export async function reprintEndOfDayReceipt(
  tx: Tx,
  actor: CashActor,
  branchId: string,
  input: EndOfDayReprintBody,
  now: Date = new Date(),
): Promise<EndOfDayRecord> {
  await branchClockFor(tx, actor.operatorId, branchId);
  // One print of a day at a time: two first prints of a waiting receipt take one number.
  await lockDay(tx, branchId, input.date);
  let row = await closedRow(tx, branchId, input.date);
  if (!row) {
    throw errors.conflict('DAY_NOT_CLOSED', 'This day is not closed yet — its End of Day receipt prints when it closes.');
  }
  const counter = await printingCounter(tx, actor, branchId, input.stationId ?? null);
  const first = !row.receiptNumber;
  if (first) row = await numberWaitingReceipt(tx, actor, row, counter, now);
  const reason = first ? null : input.reason?.trim() || 'Reprint from the closed day';
  const actionId = newId();
  const printed = await queueEndOfDayReceipt(tx, {
    operatorId: actor.operatorId,
    branchId,
    endOfDayId: row.id,
    stationRow: counter,
    actorAccountId: actor.accountId,
    actionId,
    requestId: actor.requestId,
    now,
    reprintReason: reason,
  });
  if (!printed.job) throw errors.conflict('RECEIPT_NOT_QUEUED', printed.note ?? 'The End of Day receipt could not be queued.');
  if (first) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId,
      action: 'end_of_day.receipt',
      entityType: 'end_of_day',
      entityId: row.id,
      actionId,
      requestId: actor.requestId,
      before: { businessDate: row.businessDate, receiptNumber: null, receiptStationId: null },
      after: {
        businessDate: row.businessDate,
        receiptNumber: row.receiptNumber,
        receiptStationId: row.receiptStationId,
        receiptPrintJobId: printed.job.id,
        status: printed.job.status,
      },
    });
    return closedRecordOf(tx, row);
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: 'print_job.reprint',
    entityType: 'print_job',
    entityId: printed.job.id,
    actionId,
    requestId: actor.requestId,
    after: {
      reprintOf: printed.job.reprintOf,
      reason,
      kind: printed.job.kind,
      endOfDayId: row.id,
      businessDate: row.businessDate,
      subjectType: 'end_of_day',
      subjectId: row.id,
      status: printed.job.status,
    },
  });
  return closedRecordOf(tx, row);
}

/**
 * Number a closed day's waiting receipt on this counter's End of Day series:
 * the one write the closed day takes after its close (migration 0061).
 */
async function numberWaitingReceipt(
  tx: Tx,
  actor: CashActor,
  row: typeof endOfDay.$inferSelect,
  counter: { id: string; codePrefix: string },
  now: Date,
): Promise<typeof endOfDay.$inferSelect> {
  const receipt = await allocateReceipt(
    tx,
    { operatorId: actor.operatorId, branchId: row.branchId, stationId: counter.id, series: `${counter.codePrefix}-EOD` },
    'end_of_day',
  );
  const [numbered] = await tx
    .update(endOfDay)
    .set({ receiptNumber: receipt.number, receiptStationId: counter.id, updatedAt: now })
    .where(and(eq(endOfDay.id, row.id), isNull(endOfDay.receiptNumber)))
    .returning();
  if (!numbered) throw errors.conflict('RECEIPT_ALREADY_NUMBERED', 'This End of Day receipt was just numbered — reload the day.');
  return numbered;
}

// --- Writing -------------------------------------------------------------------

export interface CashActor {
  accountId: string;
  operatorId: string;
  requestId?: string;
  /** The counter the session is at, when it is at one. */
  stationId?: string | null;
  /** Holds `pos:cash:approve` at the branch: may close over rows still counted inside. */
  canApprove?: boolean;
}

/**
 * One branch-day at a time: a close and a paid-out or safe drop on the same
 * day are serialised, so a movement can never land beside a close that did not
 * count it.
 */
async function lockDay(tx: Tx, branchId: string, date: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`end_of_day:${branchId}:${date}`}))`);
}

export const dayClosed = () =>
  errors.conflict('DAY_CLOSED', 'This day is already closed.');

/**
 * Close Day (`closeEndOfDay`): rebuild the expected side here, put staff's
 * entries on it, recompute, stamp who and when, store it, audit it — one
 * transaction. Allowed with lines off or pending and with no notes. Refused
 * while the day is provisional, and while anybody is still counted inside
 * unless a holder of `pos:cash:approve` closes with a reason. The receipt is
 * numbered on the closing counter's series and queued on its printer; with no
 * counter that can print, the day still closes and the receipt waits
 * (`RECEIPT_PENDING`) for a reprint from a counter.
 */
export async function closeEndOfDay(
  tx: Tx,
  actor: CashActor,
  branchId: string,
  input: EndOfDayCloseBody,
  now: Date = new Date(),
): Promise<EndOfDayRecord> {
  const clock = await branchClockFor(tx, actor.operatorId, branchId);
  if (input.date > currentBusinessDate(clock, now)) {
    throw errors.badRequest('That day has not started yet.');
  }
  await lockDay(tx, branchId, input.date);
  if (await closedRow(tx, branchId, input.date)) throw dayClosed();

  const provisional = await provisionalBoxesOf(tx, clock, now);
  if (provisional.length > 0) throw dayProvisional(provisional);
  const { rows: stranded } = await strandedOf(tx, { operatorId: actor.operatorId, branchId, date: input.date, now });
  const overrideReason = stranded.length > 0 ? (input.override?.reason?.trim() ?? '') : '';
  if (stranded.length > 0) {
    if (!overrideReason) throw strandedRefusal(stranded);
    if (!actor.canApprove) {
      throw new AppError(
        403,
        'OVERRIDE_NOT_ALLOWED',
        'Only a manager can close the day with people still counted inside — resolve each one, or ask a manager.',
      );
    }
  }
  const counter = await closingCounter(tx, actor, branchId, input.stationId ?? null);
  const receipt = counter
    ? await allocateReceipt(
        tx,
        { operatorId: actor.operatorId, branchId, stationId: counter.id, series: `${counter.codePrefix}-EOD` },
        'end_of_day',
      )
    : null;

  const open = await openRecordOf(tx, clock, input.date);
  const filled = applyEndOfDayEntries(open, {
    actuals: input.actuals,
    countedSatang: input.countedSatang,
    floatLeftSatang: input.floatLeftSatang,
    vouchers: input.vouchers,
  });
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  const id = newId();
  const inserted = await tx
    .insert(endOfDay)
    .values({
      id,
      operatorId: actor.operatorId,
      branchId,
      businessDate: input.date,
      lines: filled.lines,
      countedSatang: filled.cashCount.countedSatang,
      floatSatang: filled.cashCount.floatSatang ?? DEFAULT_FLOAT,
      floatFromDate: filled.floatFromDate,
      floatLeftSatang: filled.floatLeftSatang,
      vouchersHandedOut: filled.vouchers.handedOut,
      vouchersRedeemed: filled.vouchers.redeemed,
      notes,
      totalExpectedSatang: filled.totalExpectedSatang,
      totalActualSatang: filled.totalActualSatang,
      totalDifferenceSatang: filled.totalDifferenceSatang,
      closedByAccountId: actor.accountId,
      closedAt: now,
      overrideByAccountId: overrideReason ? actor.accountId : null,
      overrideReason: overrideReason || null,
      overrideStranded: overrideReason ? stranded : null,
      receiptNumber: receipt?.number ?? null,
      receiptStationId: receipt && counter ? counter.id : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [endOfDay.branchId, endOfDay.businessDate] })
    .returning();
  const row = inserted[0];
  if (!row) throw dayClosed();

  if (overrideReason) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId,
      action: 'end_of_day.override',
      entityType: 'end_of_day',
      entityId: id,
      requestId: actor.requestId,
      before: { businessDate: input.date, stranded },
      after: { businessDate: input.date, reason: overrideReason, strandedCount: stranded.length },
    });
  }
  const printed = counter
    ? await queueEndOfDayReceipt(tx, {
        operatorId: actor.operatorId,
        branchId,
        endOfDayId: id,
        stationRow: counter,
        actorAccountId: actor.accountId,
        actionId: newId(),
        requestId: actor.requestId,
        now,
      })
    : null;

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: 'end_of_day.close',
    entityType: 'end_of_day',
    entityId: id,
    requestId: actor.requestId,
    before: null,
    after: {
      businessDate: input.date,
      lines: filled.lines,
      countedSatang: filled.cashCount.countedSatang,
      floatSatang: filled.cashCount.floatSatang,
      floatFromDate: filled.floatFromDate,
      floatLeftSatang: filled.floatLeftSatang,
      vouchers: filled.vouchers,
      totalExpectedSatang: filled.totalExpectedSatang,
      totalActualSatang: filled.totalActualSatang,
      totalDifferenceSatang: filled.totalDifferenceSatang,
      notes,
      cashMovementIds: filled.cashMovements.map((m) => m.id),
      receiptNumber: receipt?.number ?? null,
      receiptStationId: row.receiptStationId,
      receiptPrintJobId: printed?.job?.id ?? null,
      overridden: !!overrideReason,
    },
  });
  return closedRecordOf(tx, row);
}

/** Every grant of these accounts, as `resolveEffectivePermissions` reads them. */
async function grantsOf(db: Exec, accountIds: readonly string[]): Promise<Map<string, EffectivePermission[]>> {
  const out = new Map<string, EffectivePermission[]>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({
      accountId: roleAssignment.accountId,
      permission: rolePermission.permission,
      scopeType: roleAssignment.scopeType,
      scopeId: roleAssignment.scopeId,
      roleName: role.name,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(roleAssignment.roleId, role.id))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(inArray(roleAssignment.accountId, [...accountIds]));
  for (const r of rows) {
    const list = out.get(r.accountId) ?? [];
    list.push({ permission: r.permission as Permission, scopeType: r.scopeType, scopeId: r.scopeId, roleName: r.roleName });
    out.set(r.accountId, list);
  }
  return out;
}

/**
 * The people at the branch who can be named as the second person: every
 * active account of the operator that holds anything at the branch, and
 * whether it can approve a paid-out there.
 */
export async function cashPeopleOf(db: Exec, operatorId: string, branchId: string): Promise<CashPerson[]> {
  const accounts = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.status, 'active')));
  const grants = await grantsOf(db, accounts.map((a) => a.id));
  const nameOf = await accountNames(db, accounts.map((a) => a.id));
  return accounts
    .filter((a) => holdsGrantAt(grants.get(a.id) ?? [], operatorId, branchId))
    .map((a) => ({
      accountId: a.id,
      name: nameOf(a.id),
      canApprove: hasPermission(grants.get(a.id) ?? [], 'pos:cash:approve', { operatorId, branchId }),
    }))
    .sort((x, y) => (x.name ?? '').localeCompare(y.name ?? ''));
}

/** The day's paid-outs and safe drops, and who can be named on the next one. */
export async function listCashMovements(db: Exec, operatorId: string, branchId: string, date: string | undefined, now: Date = new Date()) {
  const clock = await branchClockFor(db, operatorId, branchId);
  const day = date ?? currentBusinessDate(clock, now);
  return {
    businessDate: day,
    movements: await movementsOf(db, branchId, day),
    people: await cashPeopleOf(db, operatorId, branchId),
  };
}

/** The second person, when it is somebody active of the caller's own operator. */
async function secondPerson(db: Exec, operatorId: string, accountId: string) {
  const [row] = await db
    .select({ id: account.id, status: account.status })
    .from(account)
    .where(and(eq(account.id, accountId), eq(account.operatorId, operatorId)))
    .limit(1);
  return row && row.status === 'active' ? row : null;
}

/**
 * Record a paid-out or a safe drop against the branch's current business day.
 * A paid-out needs somebody else holding `pos:cash:approve` at the branch; a
 * safe drop needs somebody else who works at the branch. Refused once the day
 * is closed: its count is locked, and cash it did not expect to leave would be
 * on no day at all.
 */
export async function recordMovement(
  tx: Tx,
  actor: CashActor,
  branchId: string,
  input: CashMovementBody,
  now: Date = new Date(),
): Promise<{ movement: CashMovementView; replayed: boolean }> {
  const clock = await branchClockFor(tx, actor.operatorId, branchId);
  const day = currentBusinessDate(clock, now);
  const actionId = input.actionId ?? newId();

  // The press is the key: a retry of the same press answers what it recorded.
  const [already] = await tx
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.operatorId, actor.operatorId), eq(cashMovement.actionId, actionId)))
    .limit(1);
  if (already) {
    if (already.branchId !== branchId || already.kind !== input.kind || already.amountSatang !== input.amountSatang) {
      throw errors.conflict('ACTION_ID_REUSED', 'That press already recorded a different cash movement.');
    }
    const nameOf = await accountNames(
      tx,
      [already.actorAccountId, already.approverAccountId, already.witnessAccountId].filter((id): id is string => !!id),
    );
    return { movement: movementViewOf(already, nameOf), replayed: true };
  }

  const reason = input.reason.trim();
  if (!reason) throw errors.badRequest('Say what the cash was for.');
  let approverAccountId: string | null = null;
  let witnessAccountId: string | null = null;
  if (input.kind === 'paid_out') {
    if (input.witnessAccountId) throw errors.badRequest('A paid-out is approved, not witnessed — choose who approved it.');
    if (!input.approverAccountId) throw new AppError(400, 'APPROVER_REQUIRED', 'A paid-out needs a manager to approve it.');
    if (input.approverAccountId === actor.accountId) {
      throw new AppError(403, 'SELF_APPROVAL', 'You cannot approve your own paid-out — ask another manager.');
    }
    const person = await secondPerson(tx, actor.operatorId, input.approverAccountId);
    const grants = person ? ((await grantsOf(tx, [person.id])).get(person.id) ?? []) : [];
    if (!person || !hasPermission(grants, 'pos:cash:approve', { operatorId: actor.operatorId, branchId })) {
      throw new AppError(403, 'APPROVER_NOT_ALLOWED', 'That person cannot approve a paid-out at this branch.');
    }
    approverAccountId = person.id;
  } else {
    if (input.approverAccountId) throw errors.badRequest('A safe drop is witnessed, not approved — choose who witnessed it.');
    if (!input.witnessAccountId) throw new AppError(400, 'WITNESS_REQUIRED', 'A safe drop needs a witness.');
    if (input.witnessAccountId === actor.accountId) {
      throw new AppError(403, 'SELF_WITNESS', 'You cannot witness your own safe drop — ask someone else.');
    }
    const person = await secondPerson(tx, actor.operatorId, input.witnessAccountId);
    const grants = person ? ((await grantsOf(tx, [person.id])).get(person.id) ?? []) : [];
    if (!person || !holdsGrantAt(grants, actor.operatorId, branchId)) {
      throw new AppError(403, 'WITNESS_NOT_ALLOWED', 'That person does not work at this branch.');
    }
    witnessAccountId = person.id;
  }

  await lockDay(tx, branchId, day);
  if (await closedRow(tx, branchId, day)) throw dayClosed();

  const id = newId();
  const [row] = await tx
    .insert(cashMovement)
    .values({
      id,
      operatorId: actor.operatorId,
      branchId,
      businessDate: day,
      kind: input.kind,
      amountSatang: input.amountSatang,
      reason,
      actorAccountId: actor.accountId,
      approverAccountId,
      witnessAccountId,
      actionId,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('the cash movement was not written');

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: `cash_movement.${input.kind}`,
    entityType: 'cash_movement',
    entityId: id,
    actionId,
    requestId: actor.requestId,
    before: null,
    after: {
      businessDate: day,
      kind: input.kind,
      amountSatang: input.amountSatang,
      reason,
      approverAccountId,
      witnessAccountId,
    },
  });
  const nameOf = await accountNames(tx, [actor.accountId, approverAccountId, witnessAccountId].filter((x): x is string => !!x));
  return { movement: movementViewOf(row, nameOf), replayed: false };
}
