import { describe, expect, it } from 'vitest';
import { expiredCreditHeld, type CreditLot } from '../src/services/wallet';

/**
 * S2-14a round 3 fix — THE EXPIRY RULE, pure (gate G1): each credit on a
 * wallet expires by its OWN date, and a spend is taken from the credit that
 * dies first. `expiredCreditHeld` is the one function the counter's clock
 * check, the day-end job and the view all read, so this pins its arithmetic
 * without a database.
 */

const at = (iso: string) => new Date(iso);
const D1_END = at('2026-09-29T17:00:00.000Z');
const D2_END = at('2026-09-30T17:00:00.000Z');
const NOON_D2 = at('2026-09-30T05:00:00.000Z');

const grant = (amountSatang: number, expiresAt: Date | null): CreditLot => ({ kind: 'grant', amountSatang, expiresAt });
const spend = (amountSatang: number): CreditLot => ({ kind: 'spend', amountSatang: -amountSatang, expiresAt: null });
const refund = (amountSatang: number): CreditLot => ({ kind: 'refund', amountSatang, expiresAt: null });
const expire = (amountSatang: number): CreditLot => ({ kind: 'expire', amountSatang: -amountSatang, expiresAt: null });
const reactivate = (amountSatang: number, expiresAt: Date | null): CreditLot => ({ kind: 'reactivate', amountSatang, expiresAt });

describe('expiredCreditHeld — each credit by its own date', () => {
  it("a reload today does not revive yesterday's same-day credit: ฿200 of ฿300 has lapsed at noon", () => {
    expect(expiredCreditHeld([grant(20_000, D1_END), grant(10_000, D2_END)], NOON_D2, 30_000)).toBe(20_000);
  });

  it('nothing before the date, all of it at the date', () => {
    expect(expiredCreditHeld([grant(20_000, D1_END)], at('2026-09-29T16:59:59.999Z'), 20_000)).toBe(0);
    expect(expiredCreditHeld([grant(20_000, D1_END)], D1_END, 20_000)).toBe(20_000);
  });

  it('a spend is taken from the credit that dies first', () => {
    // ฿200 (dies D1) + ฿100 (dies D2), ฿150 spent: the ฿200 lot is down to ฿50, the ฿100 lot untouched.
    expect(expiredCreditHeld([grant(20_000, D1_END), grant(10_000, D2_END), spend(15_000)], NOON_D2, 15_000)).toBe(5_000);
    // ฿250 spent: the first lot is gone and ฿50 of the live one — nothing has lapsed.
    expect(expiredCreditHeld([grant(20_000, D1_END), grant(10_000, D2_END), spend(25_000)], NOON_D2, 5_000)).toBe(0);
  });

  it('never: credit with no date is live for ever, so nothing lapses', () => {
    expect(expiredCreditHeld([grant(7_000, null)], at('2030-01-01T00:00:00.000Z'), 7_000)).toBe(0);
    expect(expiredCreditHeld([grant(7_000, null), grant(5_000, D1_END)], NOON_D2, 12_000)).toBe(5_000);
  });

  it('an expiry already taken is not taken twice; credit brought back lives by its new date', () => {
    const ledger = [grant(20_000, D1_END), expire(20_000), reactivate(20_000, D2_END)];
    expect(expiredCreditHeld(ledger, NOON_D2, 20_000)).toBe(0);
    expect(expiredCreditHeld(ledger, D2_END, 20_000)).toBe(20_000);
  });

  it('a refund put back after everything on the wallet has died is itself dead (it goes at the next day end)', () => {
    expect(expiredCreditHeld([grant(9_000, D1_END), spend(9_000), refund(9_000)], NOON_D2, 9_000)).toBe(9_000);
  });

  it('never more than the wallet holds now, never below zero', () => {
    expect(expiredCreditHeld([grant(20_000, D1_END)], NOON_D2, 5_000)).toBe(5_000);
    expect(expiredCreditHeld([grant(20_000, D1_END), grant(10_000, D2_END), spend(25_000)], NOON_D2, 5_000)).toBe(0);
    expect(expiredCreditHeld([], NOON_D2, 0)).toBe(0);
  });
});
