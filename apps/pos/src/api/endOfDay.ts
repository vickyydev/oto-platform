// The End of Day — S2-15a round 1 (plan docs/progress/plans/cash/PLAN.md,
// revised 2 Oct: ONE combined cash count for the whole branch per day).
//
// WHAT CHANGED FROM THE PROTOTYPE, AND WHAT DID NOT. The screens are the
// prototype's (`components/eod/*`, `MobileEndOfDayTab`) with their look and
// words; only where the figures come from moved: `mockApi.getEndOfDay`,
// `getFloatCarryover`, `closeEndOfDay` and `getEdcTerminals` are now the
// platform's `GET /branches/:id/end-of-day` and `POST …/end-of-day/close`.
// The record is kept in SATANG, as the platform sends it, and edited with the
// SAME `recomputeEndOfDay` the platform runs at close (`@oto/shared`), so the
// figures on the screen are the figures the platform will lock. The screen's
// components still read baht (`EndOfDay` in `@/types`): `screenEndOfDay` is
// the one place the two meet.
import type {
  CashMovementAnswer,
  CashMovementBody,
  CashMovementsAnswer,
  EndOfDayCloseBody,
  EndOfDayRecord,
  EndOfDayReprintBody,
  StrandedResolveAnswer,
  StrandedResolveBody,
} from '@oto/shared';
import { recomputeEndOfDay } from '@oto/shared';
import type { EdcTerminal, EndOfDay } from '@/types';
import { api, idemKey } from './client';

export type ApiEndOfDay = EndOfDayRecord;

const branchPath = (branchApiId: string) => `/branches/${encodeURIComponent(branchApiId)}`;

/** One business day of the branch: the saved record once closed, a fresh one while open. */
export function getEndOfDay(branchApiId: string, date: string): Promise<ApiEndOfDay> {
  return api.get<ApiEndOfDay>(`${branchPath(branchApiId)}/end-of-day?date=${encodeURIComponent(date)}`);
}

/**
 * Close Day. One key per press, so a retry after a lost answer replays the
 * close it made; the body carries only what staff entered.
 */
export function closeEndOfDay(branchApiId: string, body: EndOfDayCloseBody, idempotencyKey: string = idemKey()): Promise<ApiEndOfDay> {
  return api.post<ApiEndOfDay>(`${branchPath(branchApiId)}/end-of-day/close`, body, { idempotencyKey });
}

/**
 * S2-15a round 2 — clear one row still counted inside at close. One key per
 * press; `body.actionId` is the press, so a retry records once.
 */
export function resolveStrandedRow(
  branchApiId: string,
  body: StrandedResolveBody,
  idempotencyKey: string = idemKey(),
): Promise<StrandedResolveAnswer> {
  return api.post<StrandedResolveAnswer>(`${branchPath(branchApiId)}/end-of-day/stranded/resolve`, body, { idempotencyKey });
}

/** S2-15a round 2 — print the closed day's receipt again, at this counter. */
export function reprintEndOfDayReceipt(
  branchApiId: string,
  body: EndOfDayReprintBody,
  idempotencyKey: string = idemKey(),
): Promise<ApiEndOfDay> {
  return api.post<ApiEndOfDay>(`${branchPath(branchApiId)}/end-of-day/reprint`, body, { idempotencyKey });
}

/** Today's paid-outs and safe drops, and who can be named as the second person. */
export function listCashMovements(branchApiId: string, date?: string): Promise<CashMovementsAnswer> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return api.get<CashMovementsAnswer>(`${branchPath(branchApiId)}/cash-movements${q}`);
}

/** Record a paid-out or a safe drop; `body.actionId` is one per press of Record. */
export function recordCashMovement(branchApiId: string, body: CashMovementBody, idempotencyKey: string = idemKey()): Promise<CashMovementAnswer> {
  return api.post<CashMovementAnswer>(`${branchPath(branchApiId)}/cash-movements`, body, { idempotencyKey });
}

// --- The record, as the prototype's components read it ------------------------------

const thb = (satang: number): number => satang / 100;
const thbOrNull = (satang: number | null): number | null => (satang === null ? null : satang / 100);
const satangOf = (baht: number | null): number | null => (baht === null ? null : Math.round(baht * 100));

/** The platform's record in the prototype's `EndOfDay` shape (baht), for the components. */
export function screenEndOfDay(rec: ApiEndOfDay): EndOfDay {
  return {
    id: rec.id,
    branchId: rec.branchId,
    date: rec.date,
    lines: rec.lines.map((l) => ({
      channel: l.channel,
      expectedTHB: thb(l.expectedSatang),
      actualTHB: thbOrNull(l.actualSatang),
      differenceTHB: thb(l.differenceSatang),
    })),
    cashCount: {
      countedTHB: thbOrNull(rec.cashCount.countedSatang),
      floatTHB: thbOrNull(rec.cashCount.floatSatang),
      cashIncomeTHB: thbOrNull(rec.cashCount.cashIncomeSatang),
    },
    floatLeftTHB: thbOrNull(rec.floatLeftSatang),
    vouchers: { ...rec.vouchers },
    totalExpectedTHB: thb(rec.totalExpectedSatang),
    totalActualTHB: thb(rec.totalActualSatang),
    totalDifferenceTHB: thb(rec.totalDifferenceSatang),
    status: rec.status,
    ...(rec.closedBy ? { closedBy: rec.closedBy.name ?? 'Unknown', closedById: rec.closedBy.accountId } : {}),
    ...(rec.closedAt ? { closedAt: rec.closedAt } : {}),
    ...(rec.notes !== null ? { notes: rec.notes } : {}),
  };
}

/** The branch's card terminals, as `channelLabel` resolves a `card:<tid>` line. */
export function edcTerminalsOf(rec: ApiEndOfDay): EdcTerminal[] {
  return rec.terminals.map((t) => ({ id: t.tid, tid: t.tid, label: t.label }));
}

/** Where the start-of-day float came from, in the prototype's words. */
export function floatSourceLabelOf(rec: Pick<ApiEndOfDay, 'floatFromDate'>): string {
  return rec.floatFromDate ? `carried from ${rec.floatFromDate} close` : 'standard opening float (no prior close)';
}

// --- Staff's entries, kept in satang and recomputed as the platform will -----------

/** A channel's actual, typed in baht (the cash line's comes from the count). */
export function withActual(rec: ApiEndOfDay, channel: string, baht: number | null): ApiEndOfDay {
  return recomputeEndOfDay({
    ...rec,
    lines: rec.lines.map((l) => (l.channel === channel && channel !== 'cash' ? { ...l, actualSatang: satangOf(baht) } : l)),
  });
}

/** The counted cash, typed in baht. */
export function withCounted(rec: ApiEndOfDay, baht: number | null): ApiEndOfDay {
  return recomputeEndOfDay({ ...rec, cashCount: { ...rec.cashCount, countedSatang: satangOf(baht) } });
}

/** The float left in the drawer for tomorrow, typed in baht. */
export function withFloatLeft(rec: ApiEndOfDay, baht: number | null): ApiEndOfDay {
  return { ...rec, floatLeftSatang: satangOf(baht) };
}

export function withVouchers(rec: ApiEndOfDay, patch: Partial<{ handedOut: number | null; redeemed: number | null }>): ApiEndOfDay {
  return { ...rec, vouchers: { ...rec.vouchers, ...patch } };
}

export function withNotes(rec: ApiEndOfDay, notes: string): ApiEndOfDay {
  return { ...rec, notes };
}

/**
 * What Close Day sends: only what staff entered, the counter it is closed at
 * (the receipt prints there) and a manager's override reason when one is given.
 */
export function closeBodyOf(
  rec: ApiEndOfDay,
  extra: { stationId?: string | null; overrideReason?: string | null } = {},
): EndOfDayCloseBody {
  const reason = extra.overrideReason?.trim();
  return {
    ...(extra.stationId ? { stationId: extra.stationId } : {}),
    ...(reason ? { override: { reason } } : {}),
    date: rec.date,
    actuals: rec.lines
      .filter((l) => l.channel !== 'cash')
      .map((l) => ({ channel: l.channel, actualSatang: l.actualSatang })),
    countedSatang: rec.cashCount.countedSatang,
    floatLeftSatang: rec.floatLeftSatang,
    vouchers: { ...rec.vouchers },
    notes: rec.notes,
  };
}
