import { z } from 'zod';
import { wallClockMinutesInTz } from './business-date';
import { isoDateInTz } from './dates';
import { formatTHB, type Satang } from './money';

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

// --- Round 2: provisional close, stranded occupancy, the receipt (SCRUM-215) -----

/**
 * Why a box keeps the day provisional: it still holds facts it has not
 * delivered (`outbox`), or its clock is out and it has not measured it, so
 * what it stamps may be on the wrong day (`clock`).
 */
export const EOD_PROVISIONAL_REASONS = ['outbox', 'clock'] as const;
export type EodProvisionalReason = (typeof EOD_PROVISIONAL_REASONS)[number];

export const EodProvisionalBoxSchema = z.object({
  boxId: z.string().uuid(),
  name: z.string(),
  reason: z.enum(EOD_PROVISIONAL_REASONS),
  /** How many facts are waiting on the box; null for a clock reason. */
  waiting: z.number().int().nullable(),
  /** Since when: the oldest waiting fact, or when the clock was last read. */
  since: z.string().nullable(),
  /** The sentence the counter reads. */
  message: z.string(),
});
export type EodProvisionalBox = z.infer<typeof EodProvisionalBoxSchema>;

/** Why staff cleared somebody still counted inside. */
export const STRANDED_RESOLUTION_REASONS = ['left_without_scanning', 'band_lost', 'gate_fault'] as const;
export type StrandedResolutionReason = (typeof STRANDED_RESOLUTION_REASONS)[number];

export const STRANDED_REASON_LABEL: Record<StrandedResolutionReason, string> = {
  left_without_scanning: 'Left without scanning',
  band_lost: 'Band lost',
  gate_fault: 'Gate fault',
};

export const STRANDED_KINDS = ['band', 'checkin'] as const;
export type StrandedKind = (typeof STRANDED_KINDS)[number];

/**
 * Somebody the branch still counts inside at close: an adult band whose last
 * passage today was an entry, or a child checked in and not checked out.
 */
export const EodStrandedRowSchema = z.object({
  kind: z.enum(STRANDED_KINDS),
  /** The band's id, or the check-in's. */
  subjectId: z.string().uuid(),
  bandCode: z.string().nullable(),
  childName: z.string().nullable(),
  /** Children of the same sale counted inside with this band. */
  childrenWithBand: z.number().int().min(0),
  lastGateEvent: z
    .object({ kind: z.string(), at: z.string(), stationName: z.string().nullable() })
    .nullable(),
  checkedInAt: z.string().nullable(),
  sale: z.object({ saleId: z.string().uuid(), receiptNumber: z.string().nullable() }).nullable(),
  guardian: z.object({ name: z.string().nullable(), phone: z.string().nullable() }).nullable(),
});
export type EodStrandedRow = z.infer<typeof EodStrandedRowSchema>;

/** A manager's close over rows still counted inside, as the closed day shows it. */
export const EodOverrideSchema = z.object({
  by: PersonSchema,
  reason: z.string(),
  at: z.string(),
  stranded: z.array(EodStrandedRowSchema),
});
export type EodOverride = z.infer<typeof EodOverrideSchema>;

export const EodReceiptJobSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  reprint: z.boolean(),
  deviceLabel: z.string().nullable(),
  errorMessage: z.string().nullable(),
  queuedAt: z.string(),
});

/** The End of Day receipt: its number on the closing counter's series, and its paper. */
export const EodReceiptSchema = z.object({
  number: z.string().nullable(),
  stationId: z.string().uuid().nullable(),
  stationName: z.string().nullable(),
  jobs: z.array(EodReceiptJobSchema),
  /** Why nothing printed, in the counter's words; null when a job was queued. */
  note: z.string().nullable(),
});
export type EodReceipt = z.infer<typeof EodReceiptSchema>;

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
  /** Open day only: the boxes that keep it provisional. Close is refused while any is listed. */
  provisional: z.array(EodProvisionalBoxSchema).optional(),
  /** Open day only: who is still counted inside. Close needs a manager's override while any is listed. */
  stranded: z.array(EodStrandedRowSchema).optional(),
  /** Closed day only: the manager's override, when the day closed over stranded rows. */
  override: EodOverrideSchema.nullable().optional(),
  /** Closed day only: the End of Day receipt. */
  receipt: EodReceiptSchema.nullable().optional(),
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
  /** The counter closing the day: the receipt prints on its printer and its series. */
  stationId: z.string().uuid().nullable().optional(),
  /** A manager's reason for closing while people are still counted inside (`pos:cash:approve`). */
  override: z
    .object({ reason: z.string().trim().min(1, 'Say why the day is closing with people still counted inside').max(500) })
    .nullable()
    .optional(),
});
export type EndOfDayCloseBody = z.infer<typeof EndOfDayCloseBodySchema>;

/** Clear one stranded row from the count: who is recorded from the session. */
export const StrandedResolveBodySchema = z.object({
  date: DATE,
  kind: z.enum(STRANDED_KINDS),
  subjectId: z.string().uuid(),
  reason: z.enum(STRANDED_RESOLUTION_REASONS),
  note: z.string().trim().max(500).nullable().optional(),
  /** One per press of Resolve; a retry of the same press records once. */
  actionId: z.string().min(1).max(200).optional(),
});
export type StrandedResolveBody = z.infer<typeof StrandedResolveBodySchema>;

export const StrandedResolveAnswerSchema = z.object({
  resolutionId: z.string().uuid(),
  replayed: z.boolean(),
  stranded: z.array(EodStrandedRowSchema),
});
export type StrandedResolveAnswer = z.infer<typeof StrandedResolveAnswerSchema>;

/** Print the closed day's receipt again, at the asking counter. */
export const EndOfDayReprintBodySchema = z.object({
  date: DATE,
  stationId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
});
export type EndOfDayReprintBody = z.infer<typeof EndOfDayReprintBodySchema>;

// --- The End of Day receipt, composed for the receipt printer -------------------

export interface EodReceiptInput {
  receiptNumber: string | null;
  branchName: string | null;
  date: string;
  closedAt: Date;
  timezone: string;
  closedByName: string | null;
  lines: readonly EodLine[];
  /** Label for each channel, in the till's words. */
  labelOf: (channel: string) => string;
  countedSatang: number | null;
  floatSatang: number | null;
  floatLeftSatang: number | null;
  totalExpectedSatang: number;
  totalActualSatang: number;
  totalDifferenceSatang: number;
  override: { reason: string; byName: string | null } | null;
  copy: boolean;
}

/** The receipt template's input (`ReceiptData` in `@oto/print`), as far as this receipt fills it. */
export interface EodReceiptDocument {
  kind: 'receipt';
  data: {
    title: string;
    taxInvoiceLines?: string[];
    receiptNumber?: string;
    dateTime?: string;
    lines: { qty: number; name: string; price?: string; note?: string }[];
    total: string;
    tenders?: { label: string; amount: string }[];
    orderNote?: string;
  };
}

function stampIn(instant: Date, timezone: string): string {
  const minutes = wallClockMinutesInTz(instant, timezone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${isoDateInTz(instant, timezone)} ${hh}:${mm}`;
}

const baht = formatTHB;

const signed = (satang: number): string => (satang > 0 ? `+${baht(satang)}` : satang < 0 ? `-${baht(-satang)}` : baht(0));

/**
 * The End of Day receipt on the receipt template: the day's lines (actual
 * against expected), the count, the float, the float left, the cash to bank,
 * who closed it and when. Label/value rows only, so every agent prints it.
 */
export function endOfDayReceiptDocument(input: EodReceiptInput): EodReceiptDocument {
  const rows: { label: string; amount: string }[] = [];
  for (const line of input.lines) {
    rows.push({ label: `${input.labelOf(line.channel)} · exp ${baht(line.expectedSatang)}`, amount: line.actualSatang === null ? '—' : baht(line.actualSatang) });
    if (line.actualSatang !== null && line.differenceSatang !== 0) {
      rows.push({ label: '  difference', amount: signed(line.differenceSatang) });
    }
  }
  rows.push({ label: 'Total expected', amount: baht(input.totalExpectedSatang) });
  rows.push({ label: 'Difference', amount: signed(input.totalDifferenceSatang) });
  const money = (v: number | null) => (v === null ? '—' : baht(v));
  rows.push({ label: 'Counted cash', amount: money(input.countedSatang) });
  rows.push({ label: 'Float (start)', amount: money(input.floatSatang) });
  rows.push({ label: 'Float left in drawer', amount: money(input.floatLeftSatang) });
  rows.push({
    label: 'Cash to bank tonight',
    amount: input.countedSatang !== null && input.floatLeftSatang !== null ? baht(input.countedSatang - input.floatLeftSatang) : '—',
  });
  const when = stampIn(input.closedAt, input.timezone);
  const notes = [`Closed by ${input.closedByName ?? 'Unknown'} · ${when}`];
  if (input.override) notes.push(`Closed over people still counted inside — ${input.override.reason} (${input.override.byName ?? 'manager'})`);
  if (input.copy) notes.push('COPY');
  return {
    kind: 'receipt',
    data: {
      title: 'End of Day',
      taxInvoiceLines: [input.branchName, `Business day ${input.date}`].filter((v): v is string => !!v),
      ...(input.receiptNumber ? { receiptNumber: input.receiptNumber } : {}),
      dateTime: when,
      lines: [],
      total: baht(input.totalActualSatang),
      tenders: rows,
      orderNote: notes.join('. '),
    },
  };
}

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
