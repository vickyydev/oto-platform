import { z } from 'zod';
import type { Satang } from './money';

/**
 * S2-15a round 1 — THE END OF DAY, the prototype's rules in satang.
 *
 * Ported from `imports/oto-pos/artifacts/oto-till/src/lib/endOfDay.ts`
 * (RECON_TOLERANCE_THB, DEFAULT_FLOAT_THB, lineFlag, reconVerdict,
 * recomputeEndOfDay) and the record `mockApi.ts:getEndOfDay` builds
 * (2239-2341). The plan is docs/progress/plans/cash/PLAN.md (revised 2 Oct):
 * ONE combined cash count for the whole branch per business day, the float
 * carried from the previous close, every channel reconciled against the
 * branch's own records, close allowed whatever the verdict, a closed day read
 * back exactly as saved.
 *
 * The same pure functions run on the till (live, as staff type) and on the
 * platform (at close, never trusting the caller's maths), so the two cannot
 * disagree by a satang.
 */

/**
 * A line is "matched" when its actual is within this band of expected: ฿1, the
 * prototype's `RECON_TOLERANCE_THB = 1` — rounding and odd-satang noise, never
 * a real discrepancy. Satang.
 */
export const RECON_TOLERANCE: Satang = 100;

/**
 * The branch's standard opening float, ฿6,000 (`DEFAULT_FLOAT_THB = 6000`):
 * the start-of-day float when there is no earlier close to carry one from,
 * and the "float left for tomorrow" a fresh day offers. Satang.
 */
export const DEFAULT_FLOAT: Satang = 600_000;

export type ReconFlag = 'pending' | 'ok' | 'off';

/**
 * A business day, `YYYY-MM-DD`, and a day the calendar has: `2026-02-30` is
 * refused here (round-tripped through a UTC date) rather than reaching
 * Postgres and coming back as a server error.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD')
  .refine(isCalendarDate, 'That date is not on the calendar.');

// --- The record ----------------------------------------------------------------

/**
 * One reconciled channel. `channel` is the prototype's stable key:
 * `cash` | `promptpay` | `card:<tid>` | `method:<token>` | `ewallet` |
 * `bank_transfer` | `party_prepay` | `credit`. `differenceSatang` is actual −
 * expected, 0 while the actual is not entered.
 */
export const EodLineSchema = z.object({
  channel: z.string().min(1).max(80),
  expectedSatang: z.number().int(),
  actualSatang: z.number().int().nullable(),
  differenceSatang: z.number().int(),
});
export type EodLine = z.infer<typeof EodLineSchema>;

/** Cash income = counted − float; the cash line's actual is that figure. */
export const EodCashCountSchema = z.object({
  countedSatang: z.number().int().nullable(),
  floatSatang: z.number().int().nullable(),
  cashIncomeSatang: z.number().int().nullable(),
});
export type EodCashCount = z.infer<typeof EodCashCountSchema>;

/** A branch card terminal, as its `card:<tid>` line is labelled. */
export const EodTerminalSchema = z.object({ tid: z.string(), label: z.string() });
export type EodTerminal = z.infer<typeof EodTerminalSchema>;

const PersonSchema = z.object({ accountId: z.string().uuid(), name: z.string().nullable() });

export const CASH_MOVEMENT_KINDS = ['paid_out', 'safe_drop'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/**
 * Cash taken out of the branch's drawers during the day (SCRUM-215; the
 * prototype has none): a paid-out, approved by somebody else, or a safe drop,
 * witnessed by somebody else. Both reduce the cash the one count expects.
 */
export const CashMovementViewSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(CASH_MOVEMENT_KINDS),
  amountSatang: z.number().int().positive(),
  reason: z.string(),
  businessDate: DATE,
  actor: PersonSchema,
  approver: PersonSchema.nullable(),
  witness: PersonSchema.nullable(),
  createdAt: z.string(),
});
export type CashMovementView = z.infer<typeof CashMovementViewSchema>;

/**
 * A whole day's reconciliation for one branch. OPEN is worked out fresh from
 * the records every time it is read; CLOSED is the row written at close, read
 * back exactly as it was saved.
 */
export const EndOfDayRecordSchema = z.object({
  /** `eod-<branch>-<date>` while open (the prototype's), the stored row's id once closed. */
  id: z.string(),
  branchId: z.string().uuid(),
  /** The branch's business date the figures cover. */
  date: DATE,
  status: z.enum(['open', 'closed']),
  lines: z.array(EodLineSchema),
  cashCount: EodCashCountSchema,
  /** The close the start-of-day float was carried from; null = the standard float. */
  floatFromDate: DATE.nullable(),
  /** Cash left in the drawer at close; tomorrow's float. */
  floatLeftSatang: z.number().int().nullable(),
  vouchers: z.object({ handedOut: z.number().int().nullable(), redeemed: z.number().int().nullable() }),
  totalExpectedSatang: z.number().int(),
  totalActualSatang: z.number().int(),
  totalDifferenceSatang: z.number().int(),
  notes: z.string().nullable(),
  closedBy: PersonSchema.nullable(),
  closedAt: z.string().nullable(),
  /** The branch's card terminals, to label each `card:<tid>` line. */
  terminals: z.array(EodTerminalSchema),
  /** The day's paid-outs and safe drops, already taken off the expected cash. */
  cashMovements: z.array(CashMovementViewSchema),
});
export type EndOfDayRecord = z.infer<typeof EndOfDayRecordSchema>;

// --- The prototype's pure helpers, in satang ------------------------------------

/** Per-line state: not yet counted, matched (green) or off (red). */
export function lineFlag(line: Pick<EodLine, 'actualSatang' | 'differenceSatang'>): ReconFlag {
  if (line.actualSatang === null) return 'pending';
  return Math.abs(line.differenceSatang) <= RECON_TOLERANCE ? 'ok' : 'off';
}

/**
 * Whole-day verdict: off if anything is off, pending while counts are
 * outstanding, ok only when every channel has been counted and matched.
 */
export function reconVerdict(eod: { lines: readonly Pick<EodLine, 'actualSatang' | 'differenceSatang'>[] }): ReconFlag {
  const flags = eod.lines.map(lineFlag);
  if (flags.some((f) => f === 'off')) return 'off';
  if (flags.some((f) => f === 'pending')) return 'pending';
  return 'ok';
}

/** What `recomputeEndOfDay` reads and writes; the rest of a record passes through. */
export interface EodComputable {
  lines: EodLine[];
  cashCount: EodCashCount;
  totalExpectedSatang: number;
  totalActualSatang: number;
  totalDifferenceSatang: number;
}

/**
 * Recompute the derived numbers from the raw inputs, so the record is always
 * internally consistent — live on the screen AND when the day is locked:
 *   - cash income = counted − float (null until both are known);
 *   - the cash line's actual IS that income (never typed);
 *   - each line's difference = actual − expected (0 while not entered);
 *   - the three totals.
 * Pure: returns a new record and never mutates its input.
 */
export function recomputeEndOfDay<T extends EodComputable>(eod: T): T {
  const { countedSatang, floatSatang } = eod.cashCount;
  const cashIncomeSatang = countedSatang !== null && floatSatang !== null ? countedSatang - floatSatang : null;
  const lines = eod.lines.map((l) => {
    const actualSatang = l.channel === 'cash' ? cashIncomeSatang : l.actualSatang;
    return { ...l, actualSatang, differenceSatang: actualSatang === null ? 0 : actualSatang - l.expectedSatang };
  });
  return {
    ...eod,
    cashCount: { ...eod.cashCount, cashIncomeSatang },
    lines,
    totalExpectedSatang: lines.reduce((a, l) => a + l.expectedSatang, 0),
    totalActualSatang: lines.reduce((a, l) => a + (l.actualSatang ?? 0), 0),
    totalDifferenceSatang: lines.reduce((a, l) => a + l.differenceSatang, 0),
  };
}

/**
 * Put staff's entries on a record: the actual for each non-cash channel (the
 * cash line's comes from the count), the count, the float left and the
 * voucher counts. A channel the record does not have is ignored. Then
 * recompute — the one way the till and the platform both fill a day in.
 */
export function applyEndOfDayEntries<T extends EodComputable & { floatLeftSatang: number | null; vouchers: { handedOut: number | null; redeemed: number | null } }>(
  eod: T,
  entries: {
    actuals: readonly { channel: string; actualSatang: number | null }[];
    countedSatang: number | null;
    floatLeftSatang: number | null;
    vouchers: { handedOut: number | null; redeemed: number | null };
  },
): T {
  const actual = new Map(entries.actuals.map((a) => [a.channel, a.actualSatang]));
  return recomputeEndOfDay({
    ...eod,
    lines: eod.lines.map((l) => (l.channel !== 'cash' && actual.has(l.channel) ? { ...l, actualSatang: actual.get(l.channel) ?? null } : l)),
    cashCount: { ...eod.cashCount, countedSatang: entries.countedSatang },
    floatLeftSatang: entries.floatLeftSatang,
    vouchers: { handedOut: entries.vouchers.handedOut, redeemed: entries.vouchers.redeemed },
  });
}

// --- The wire --------------------------------------------------------------------

export const EndOfDayQuerySchema = z.object({ date: DATE });

const Count = z.number().int().min(0).nullable();

/**
 * Close Day. Only what staff entered travels: the actual per channel, the
 * count, the float left, the voucher counts and the notes. The expected side
 * and the totals are worked out again on the platform; anything else in the
 * body is dropped.
 */
export const EndOfDayCloseBodySchema = z.object({
  date: DATE,
  actuals: z
    .array(z.object({ channel: z.string().min(1).max(80), actualSatang: z.number().int().min(0).nullable() }))
    .max(200)
    .default([]),
  countedSatang: Count,
  floatLeftSatang: Count,
  vouchers: z.object({ handedOut: Count, redeemed: Count }).default({ handedOut: null, redeemed: null }),
  notes: z.string().max(4000).nullable().optional(),
});
export type EndOfDayCloseBody = z.infer<typeof EndOfDayCloseBodySchema>;

export const CashMovementsQuerySchema = z.object({ date: DATE.optional() });

/**
 * A paid-out or a safe drop. The person signed in records it; a paid-out
 * names who approved it, a safe drop who witnessed it — never the same person.
 */
export const CashMovementBodySchema = z.object({
  kind: z.enum(CASH_MOVEMENT_KINDS),
  amountSatang: z.number().int().min(1).max(1_000_000_000),
  reason: z.string().trim().min(1, 'Say what the cash was for').max(500),
  approverAccountId: z.string().uuid().nullable().optional(),
  witnessAccountId: z.string().uuid().nullable().optional(),
  /** One per press of Record; a retry of the same press records once. */
  actionId: z.string().min(1).max(200).optional(),
});
export type CashMovementBody = z.infer<typeof CashMovementBodySchema>;

/** Somebody at the branch who can be named as the second person. */
export const CashPersonSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().nullable(),
  /** Holds `pos:cash:approve` at the branch, so can approve a paid-out. */
  canApprove: z.boolean(),
});
export type CashPerson = z.infer<typeof CashPersonSchema>;

export const CashMovementsAnswerSchema = z.object({
  businessDate: DATE,
  movements: z.array(CashMovementViewSchema),
  people: z.array(CashPersonSchema),
});
export type CashMovementsAnswer = z.infer<typeof CashMovementsAnswerSchema>;

export const CashMovementAnswerSchema = z.object({
  movement: CashMovementViewSchema,
  replayed: z.boolean(),
});
export type CashMovementAnswer = z.infer<typeof CashMovementAnswerSchema>;
