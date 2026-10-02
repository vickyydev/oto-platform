import { z } from 'zod';

/**
 * S2-15a — cash sessions, the parts the till and the api agree on. Plan:
 * docs/progress/plans/cash/PLAN.md §2.2, §4 (OD-CS1..CS6).
 *
 * Ported from the prototype (`imports/oto-pos/artifacts/oto-till/src/`):
 *   `lib/endOfDay.ts`  DEFAULT_FLOAT_THB 6000, RECON_TOLERANCE_THB 1, the flag
 *                      ("balanced" within the tolerance, "over / short"
 *                      outside it, "awaiting count" before one);
 *   `mockApi.ts:getFloatCarryover`  the float carried from the last close, or
 *                      the standard float, and the label that says which.
 *
 * Corrected, per the plan: per drawer rather than "whole branch" (OD-CS1);
 * satang, never baht floats; the trading day from the branch's day start,
 * never the UTC slice; and an out-of-tolerance close needs a note.
 */

/** The prototype's ฿6,000 standard float, in satang — the branch setting's default. */
export const CASH_DEFAULT_FLOAT_SATANG = 600_000;
/** The prototype's ฿1 tolerance, in satang — the branch setting's default (OD-CS3). */
export const CASH_DEFAULT_TOLERANCE_SATANG = 100;

export const CASH_MOVEMENT_KINDS = ['float', 'paid_out', 'safe_drop', 'top_up', 'refund_out'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/** What a person records from the till's Cash action. `float` and `refund_out` are written by the platform. */
export const CASH_MANUAL_MOVEMENT_KINDS = ['paid_out', 'safe_drop', 'top_up'] as const;
export type CashManualMovementKind = (typeof CASH_MANUAL_MOVEMENT_KINDS)[number];

/** The words the till shows for each movement. */
export const CASH_MOVEMENT_LABELS: Record<CashMovementKind, string> = {
  float: 'Opening float',
  paid_out: 'Paid-out',
  safe_drop: 'Safe drop',
  top_up: 'Top-up',
  refund_out: 'Cash refund',
};

/** The most one entry may name: ฿10,000,000. Anything above it is a typo, refused. */
export const CASH_MAX_SATANG = 1_000_000_000;

/** The pieces of a drawer's expected cash, each in satang and each non-negative. */
export interface CashExpectedParts {
  floatSatang: number;
  cashInSatang: number;
  refundOutSatang: number;
  paidOutSatang: number;
  safeDropSatang: number;
  topUpSatang: number;
}

/**
 * EXPECTED CASH: the float, plus cash taken at this drawer, minus cash handed
 * back, paid out and dropped to the safe, plus what was topped up.
 */
export function expectedCashOf(parts: CashExpectedParts): number {
  return (
    parts.floatSatang +
    parts.cashInSatang -
    parts.refundOutSatang -
    parts.paidOutSatang -
    parts.safeDropSatang +
    parts.topUpSatang
  );
}

export type CashFlag = 'pending' | 'ok' | 'off';

/** "balanced" within the tolerance, "over / short" outside it, "awaiting count" before a count. */
export function cashFlagOf(varianceSatang: number | null, toleranceSatang: number): CashFlag {
  if (varianceSatang === null) return 'pending';
  return Math.abs(varianceSatang) <= toleranceSatang ? 'ok' : 'off';
}

/** The float's provenance, in the prototype's words. */
export function floatSourceLabel(fromDate: string | null): string {
  return fromDate ? `carried from ${fromDate} close` : 'standard opening float (no prior close)';
}

// --- Request bodies --------------------------------------------------------------

const Satang = z.number().int().min(0).max(CASH_MAX_SATANG);
const ActionId = z.string().trim().min(1).max(200);

/**
 * The second person at the drawer: an approver for a paid-out, a witness for a
 * safe drop. They sign with their own phone and password, on the till, so the
 * name on the movement is a person who was there rather than a name typed in.
 */
export const CashSecondPersonSchema = z.object({
  phone: z.string().trim().min(3).max(40),
  password: z.string().min(1).max(200),
});
export type CashSecondPerson = z.infer<typeof CashSecondPersonSchema>;

export const CashSessionOpenBodySchema = z.object({
  /** The session's id, when the till mints it (client-generatable ids, CLAUDE.md §3). */
  id: z.string().uuid().optional(),
  actionId: ActionId.optional(),
});
export type CashSessionOpenBody = z.infer<typeof CashSessionOpenBodySchema>;

export const CashMovementBodySchema = z
  .object({
    kind: z.enum(CASH_MANUAL_MOVEMENT_KINDS),
    amountSatang: Satang.refine((v) => v > 0, 'Enter an amount above ฿0'),
    reason: z.string().trim().min(1, 'Say what the cash is for').max(500),
    approver: CashSecondPersonSchema.optional(),
    witness: CashSecondPersonSchema.optional(),
    actionId: ActionId.optional(),
  })
  .refine((b) => b.kind !== 'paid_out' || b.approver !== undefined, {
    message: 'A paid-out needs a manager to approve it',
    path: ['approver'],
  })
  .refine((b) => b.kind !== 'safe_drop' || b.witness !== undefined, {
    message: 'A safe drop needs a witness',
    path: ['witness'],
  });
export type CashMovementBody = z.infer<typeof CashMovementBodySchema>;

export const CashSessionCloseBodySchema = z.object({
  countedSatang: Satang,
  /** What stays in the drawer for the next session. Defaults to the branch's standard float, capped at the count. */
  floatLeftSatang: Satang.optional(),
  note: z.string().trim().max(2000).optional(),
  actionId: ActionId.optional(),
});
export type CashSessionCloseBody = z.infer<typeof CashSessionCloseBodySchema>;

// --- Answers ---------------------------------------------------------------------

const Person = z.object({ accountId: z.string(), name: z.string().nullable() });

export const CashMovementViewSchema = z.object({
  id: z.string(),
  kind: z.enum(CASH_MOVEMENT_KINDS),
  amountSatang: z.number().int(),
  reason: z.string().nullable(),
  actor: Person,
  approver: Person.nullable(),
  witness: Person.nullable(),
  refundId: z.string().nullable(),
  businessDate: z.string(),
  createdAt: z.string(),
});
export type CashMovementView = z.infer<typeof CashMovementViewSchema>;

export const CashExpectedViewSchema = z.object({
  floatSatang: z.number().int(),
  cashInSatang: z.number().int(),
  refundOutSatang: z.number().int(),
  paidOutSatang: z.number().int(),
  safeDropSatang: z.number().int(),
  topUpSatang: z.number().int(),
  expectedSatang: z.number().int(),
});
export type CashExpectedView = z.infer<typeof CashExpectedViewSchema>;

export const CashSessionViewSchema = z.object({
  id: z.string(),
  branchId: z.string(),
  stationId: z.string(),
  stationName: z.string().nullable(),
  businessDate: z.string(),
  status: z.enum(['open', 'closed']),
  openedAt: z.string(),
  openedBy: Person,
  openingFloatSatang: z.number().int(),
  /** The close the float was carried from; null for the branch's standard float. */
  floatSource: z.object({ sessionId: z.string(), businessDate: z.string() }).nullable(),
  floatSourceLabel: z.string(),
  /** Live while open; at close, the figures the close froze. */
  expected: CashExpectedViewSchema,
  toleranceSatang: z.number().int(),
  closedAt: z.string().nullable(),
  closedBy: Person.nullable(),
  countedSatang: z.number().int().nullable(),
  varianceSatang: z.number().int().nullable(),
  floatLeftSatang: z.number().int().nullable(),
  notes: z.string().nullable(),
  signedOffAt: z.string().nullable(),
  signedOffBy: Person.nullable(),
  movements: z.array(CashMovementViewSchema),
});
export type CashSessionView = z.infer<typeof CashSessionViewSchema>;

export const CashDrawerViewSchema = z.object({
  station: z.object({ id: z.string(), name: z.string(), branchId: z.string(), hasDrawer: z.boolean() }),
  /** The open session, or null when the drawer is closed. */
  session: CashSessionViewSchema.nullable(),
  /** The drawer's latest closed session — what the next float carries from. */
  lastClosed: CashSessionViewSchema.nullable(),
  /** What a session opened now would start with, and where that figure comes from. */
  carryOver: z.object({
    floatSatang: z.number().int(),
    fromSessionId: z.string().nullable(),
    fromDate: z.string().nullable(),
    label: z.string(),
  }),
  settings: z.object({ defaultFloatSatang: z.number().int(), toleranceSatang: z.number().int() }),
});
export type CashDrawerView = z.infer<typeof CashDrawerViewSchema>;

export const CashMovementResultSchema = z.object({
  replayed: z.boolean(),
  movement: CashMovementViewSchema,
  session: CashSessionViewSchema,
});
export type CashMovementResult = z.infer<typeof CashMovementResultSchema>;
