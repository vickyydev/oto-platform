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

  // DEFECT (low): an exponent past the float range parses to Infinity and is
  // answered `ok` — Math.abs(Infinity - Infinity) is NaN, which the whole-each
  // check (`> 1e-9`) lets through. No round-1 writer takes it (applyMovements
  // refuses a non-integer quantity), but round 2's receive and count screens do.
  it.fails('refuses "1e400", which is not a number of things', () => {
    expect(parsePackQuantity('1e400', DOZEN).ok).toBe(false);
  });
});
