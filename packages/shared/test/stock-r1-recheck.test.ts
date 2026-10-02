import { describe, expect, it } from 'vitest';
import { parsePackQuantity } from '../src/stock';

/**
 * S2-14b round 1 — re-check gate reproductions for the pack parser (plan §5,
 * "Pack rounding: whole eaches only").
 */
const DOZEN = [{ label: 'Dozen', eaches: 12 }];

describe('re-check — parsePackQuantity answers whole eaches or refuses', () => {
  it('whatever it accepts is a whole, finite number of eaches', () => {
    for (const raw of ['24', '2 dozen', '1 dozen + 3', '1.5 dozen', '0']) {
      const parsed = parsePackQuantity(raw, DOZEN);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(Number.isSafeInteger(parsed.eaches)).toBe(true);
    }
  });

  // Was a DEFECT (low), fixed in round 2 (handover H1): an exponent past the
  // float range parsed to Infinity and was answered `ok` — Math.abs(Infinity -
  // Infinity) is NaN, which the whole-each check (`> 1e-9`) let through. Round
  // 2's receive and count screens take this parser's answer.
  it('refuses "1e400", which is not a number of things', () => {
    expect(parsePackQuantity('1e400', DOZEN).ok).toBe(false);
  });

  it('refuses "Infinity" and "1e400 dozen" the same way', () => {
    expect(parsePackQuantity('Infinity', DOZEN).ok).toBe(false);
    expect(parsePackQuantity('1e400 dozen', DOZEN).ok).toBe(false);
    expect(parsePackQuantity('2 + Infinity', DOZEN).ok).toBe(false);
  });

  it('refuses a finite figure no shelf holds', () => {
    expect(parsePackQuantity('1e20', DOZEN).ok).toBe(false);
    expect(parsePackQuantity('1000000', DOZEN)).toEqual({ ok: true, eaches: 1_000_000 });
  });
});
