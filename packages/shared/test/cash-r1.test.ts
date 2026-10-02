import { describe, expect, it } from 'vitest';
import {
  CASH_DEFAULT_FLOAT_SATANG,
  CASH_DEFAULT_TOLERANCE_SATANG,
  CashMovementBodySchema,
  CashSessionCloseBodySchema,
  cashFlagOf,
  expectedCashOf,
  floatSourceLabel,
} from '../src';

/** S2-15a round 1 — the drawer's pure rules (plan docs/progress/plans/cash/PLAN.md §2.2). */
describe('cash — the drawer rules', () => {
  it('keeps the prototype defaults, in satang: ฿6,000 float, ฿1 tolerance', () => {
    expect(CASH_DEFAULT_FLOAT_SATANG).toBe(600_000);
    expect(CASH_DEFAULT_TOLERANCE_SATANG).toBe(100);
  });

  it('expected = float + cash in − refund out − paid-out − safe drop + top-up', () => {
    expect(
      expectedCashOf({
        floatSatang: 600_000,
        cashInSatang: 150_000,
        refundOutSatang: 20_000,
        paidOutSatang: 5_000,
        safeDropSatang: 100_000,
        topUpSatang: 10_000,
      }),
    ).toBe(635_000);
  });

  it('flags a count: awaiting before, balanced within the tolerance, over / short outside it', () => {
    expect(cashFlagOf(null, 100)).toBe('pending');
    expect(cashFlagOf(100, 100)).toBe('ok');
    expect(cashFlagOf(-100, 100)).toBe('ok');
    expect(cashFlagOf(101, 100)).toBe('off');
    expect(cashFlagOf(-101, 100)).toBe('off');
  });

  it('labels the float the way the prototype did', () => {
    expect(floatSourceLabel('2026-10-01')).toBe('carried from 2026-10-01 close');
    expect(floatSourceLabel(null)).toBe('standard opening float (no prior close)');
  });

  it('a paid-out needs an approver and a safe drop a witness, in the counter’s words', () => {
    const paidOut = CashMovementBodySchema.safeParse({ kind: 'paid_out', amountSatang: 5_000, reason: 'Ice' });
    expect(paidOut.success).toBe(false);
    expect(paidOut.error?.issues[0]?.message).toBe('A paid-out needs a manager to approve it');
    const drop = CashMovementBodySchema.safeParse({ kind: 'safe_drop', amountSatang: 5_000, reason: 'Midday' });
    expect(drop.error?.issues[0]?.message).toBe('A safe drop needs a witness');
    expect(CashMovementBodySchema.safeParse({ kind: 'top_up', amountSatang: 5_000, reason: 'Change' }).success).toBe(true);
    expect(CashMovementBodySchema.safeParse({ kind: 'top_up', amountSatang: 0, reason: 'Change' }).success).toBe(false);
    expect(CashMovementBodySchema.safeParse({ kind: 'float', amountSatang: 5_000, reason: 'x' }).success).toBe(false);
  });

  it('a count is whole satang and never negative', () => {
    expect(CashSessionCloseBodySchema.safeParse({ countedSatang: 600_050 }).success).toBe(true);
    expect(CashSessionCloseBodySchema.safeParse({ countedSatang: -1 }).success).toBe(false);
    expect(CashSessionCloseBodySchema.safeParse({ countedSatang: 1.5 }).success).toBe(false);
  });
});
