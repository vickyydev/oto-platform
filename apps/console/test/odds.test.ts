import { describe, expect, it, test } from 'vitest';
import {
  TOTAL_BP,
  chanceBpOf,
  expectedCostPerSpinSatang,
  expectedCostSatang,
  formatBp,
  formatGap,
  hundredthsToText,
  parseBahtToSatang,
  parseHundredths,
  parsePercentToBp,
  prizeCostSatang,
  uncostedActive,
  weightVerdict,
  type Weighted,
} from '@/components/booth/odds';

/**
 * THE WHEEL'S ARITHMETIC — `src/components/booth/odds.ts` (SCRUM-256).
 *
 * Two numbers the Booths page keeps apart: the WEIGHT a manager typed, in
 * basis points, which must add to exactly 10,000 over the active prizes before
 * a version is published; and the CHANCE a child really has, which is that
 * weight renormalised over the prizes that are on the wheel. Every verdict is
 * integer basis points and integer satang; floats only paint text.
 *
 * And the typing: "23.5" is read digit by digit into 2350, so what is stored
 * is what was typed — the float route (`Number('0.07') * 100`) is the one that
 * leaves a list a basis point out with nobody's number to blame.
 */

const prize = (weightBp: number, costSatang = 0, active = true): Weighted => ({
  weightBp,
  costSatang,
  active,
});

describe('weightVerdict — does the list add up', () => {
  it('is balanced at exactly 10,000 over the active prizes, and only there', () => {
    expect(TOTAL_BP).toBe(10_000);
    expect(weightVerdict([prize(5000), prize(2500), prize(2500)])).toEqual({
      totalBp: 10_000,
      differenceBp: 0,
      balanced: true,
      activeCount: 3,
      inactiveCount: 0,
    });
  });

  it('is one basis point either side of balanced, signed and exact', () => {
    const over = weightVerdict([prize(5001), prize(5000)]);
    expect(over.balanced).toBe(false);
    expect(over.differenceBp).toBe(1);
    const short = weightVerdict([prize(4999), prize(5000)]);
    expect(short.balanced).toBe(false);
    expect(short.differenceBp).toBe(-1);
  });

  it('does not count a switched-off prize, whatever its weight says', () => {
    const v = weightVerdict([prize(6000), prize(4000), prize(2500, 0, false)]);
    expect(v.totalBp).toBe(10_000);
    expect(v.balanced).toBe(true);
    expect(v.activeCount).toBe(2);
    expect(v.inactiveCount).toBe(1);
  });

  it('switching a prize off unbalances the typed list by exactly its weight', () => {
    expect(weightVerdict([prize(250), prize(1450), prize(8300)]).balanced).toBe(true);
    expect(weightVerdict([prize(250, 0, false), prize(1450), prize(8300)]).differenceBp).toBe(-250);
  });

  it('an empty wheel, or one with every prize off, totals zero and is not balanced', () => {
    expect(weightVerdict([])).toMatchObject({ totalBp: 0, differenceBp: -10_000, balanced: false });
    expect(weightVerdict([prize(10_000, 0, false)])).toMatchObject({
      totalBp: 0,
      balanced: false,
      activeCount: 0,
      inactiveCount: 1,
    });
  });
});

describe('chanceBpOf — the chance a child really has', () => {
  it('gives back exactly the typed weights on a balanced list', () => {
    const list = [prize(250), prize(1450), prize(3333), prize(4967)];
    const v = weightVerdict(list);
    expect(list.map((p) => chanceBpOf(p, v))).toEqual([250, 1450, 3333, 4967]);
  });

  it('renormalises over what is on the wheel: switching one off raises every other chance', () => {
    // The file's own example: the 2.5 % grand prize off, and the 14.5 %
    // voucher goes up without anybody typing a number.
    const list = [prize(250, 0, false), prize(1450), prize(8300)];
    const v = weightVerdict(list);
    expect(chanceBpOf(list[0]!, v)).toBe(0);
    expect(chanceBpOf(list[1]!, v)).toBe(1487); // 1450 × 10000 / 9750 = 1487.18
    expect(chanceBpOf(list[2]!, v)).toBe(8513); // 8300 × 10000 / 9750 = 8512.82
    expect(formatBp(chanceBpOf(list[1]!, v))).toBe('14.87%');
  });

  it('switching four cheap prizes off leaves the expensive one on every spin', () => {
    const cheap = () => prize(2375, 0, false);
    const list = [prize(500), cheap(), cheap(), cheap(), cheap()];
    expect(chanceBpOf(list[0]!, weightVerdict(list))).toBe(10_000);
  });

  it('rounds each chance to the nearest basis point, so the chances can add to 9,999', () => {
    const list = [prize(1), prize(1), prize(1)];
    const chances = list.map((p) => chanceBpOf(p, weightVerdict(list)));
    expect(chances).toEqual([3333, 3333, 3333]);
    expect(chances.reduce((a, b) => a + b, 0)).toBe(9_999);
  });

  it('…or to 10,001 — a rounding artefact in the text, not a wheel that does not add up', () => {
    const list = [prize(1), prize(1), prize(4)];
    const chances = list.map((p) => chanceBpOf(p, weightVerdict(list)));
    expect(chances).toEqual([1667, 1667, 6667]);
    expect(chances.reduce((a, b) => a + b, 0)).toBe(10_001);
  });

  it('rounds a half basis point up', () => {
    // 1 × 10000 / 20000 = 0.5 exactly.
    const list = [prize(1), prize(19_999)];
    expect(chanceBpOf(list[0]!, weightVerdict(list))).toBe(1);
  });

  it('is zero for a prize that is off, one weighted zero, and a wheel with nothing to draw from', () => {
    const list = [prize(10_000), prize(0)];
    const v = weightVerdict(list);
    expect(chanceBpOf(list[1]!, v)).toBe(0);
    expect(chanceBpOf(prize(5000, 0, false), v)).toBe(0);
    // No division by zero when every weight is zero or every prize is off.
    const zero = [prize(0), prize(0)];
    expect(chanceBpOf(zero[0]!, weightVerdict(zero))).toBe(0);
    const allOff = [prize(5000, 0, false)];
    expect(chanceBpOf(allOff[0]!, weightVerdict(allOff))).toBe(0);
  });
});

describe('what the wheel costs the park, in satang', () => {
  it('per spin is the weighted cost, divided once', () => {
    // Half the spins win ฿200 and half win nothing: ฿100 a spin.
    expect(expectedCostPerSpinSatang([prize(5000, 20_000), prize(5000, 0)])).toBe(10_000);
  });

  it('per spin follows the renormalised chances, not the typed weights', () => {
    // Typed 50/50 with the free prize switched off: every spin wins the ฿200.
    expect(expectedCostPerSpinSatang([prize(5000, 20_000), prize(5000, 0, false)])).toBe(20_000);
  });

  it('a single satang at one basis point is nothing per spin and a satang over 5,000 spins', () => {
    const list = [prize(1, 1), prize(9_999, 0)];
    expect(expectedCostPerSpinSatang(list)).toBe(0);
    expect(expectedCostSatang(list, 100)).toBe(0);
    // 5,000 × 1 / 10,000 = 0.5, rounded up.
    expect(expectedCostSatang(list, 5_000)).toBe(1);
    expect(expectedCostSatang(list, 10_000)).toBe(1);
  });

  it('over many spins is multiplied before it is divided, not the rounded per-spin figure times the spins', () => {
    // A third of a satang a spin: rounded per spin that is 0, and 0 × 300 = 0.
    const list = [prize(1, 10_000), prize(29_999, 0)];
    expect(expectedCostPerSpinSatang(list)).toBe(0);
    expect(expectedCostSatang(list, 300)).toBe(100);
  });

  it('is zero for no spins, negative spins, or a wheel with nothing on it', () => {
    const list = [prize(10_000, 5_000)];
    expect(expectedCostSatang(list, 0)).toBe(0);
    expect(expectedCostSatang(list, -10)).toBe(0);
    expect(expectedCostPerSpinSatang([prize(10_000, 5_000, false)])).toBe(0);
    expect(expectedCostSatang([], 100)).toBe(0);
  });

  it('one prize’s share is chance × cost over the same spins, and zero when it is off', () => {
    const list = [prize(1450, 20_000), prize(8550, 1_000)];
    const v = weightVerdict(list);
    // 14.5 % of 100 spins at ฿200 = ฿2,900.
    expect(prizeCostSatang(list[0]!, v, 100)).toBe(290_000);
    expect(prizeCostSatang(list[1]!, v, 100)).toBe(85_500);
    expect(prizeCostSatang(list[0]!, v, 100) + prizeCostSatang(list[1]!, v, 100)).toBe(
      expectedCostSatang(list, 100),
    );
    expect(prizeCostSatang(prize(1450, 20_000, false), v, 100)).toBe(0);
    expect(prizeCostSatang(list[0]!, v, 0)).toBe(0);
  });

  it('counts the active prizes nobody has costed, so the screen can say the figures understate', () => {
    expect(uncostedActive([prize(5000, 0), prize(3000, 100), prize(2000, 0, false)])).toBe(1);
    expect(uncostedActive([prize(10_000, 1)])).toBe(0);
  });
});

describe('text for people', () => {
  it('writes basis points as a percentage with at most two places and no trailing zeroes', () => {
    expect(formatBp(2350)).toBe('23.5%');
    expect(formatBp(250)).toBe('2.5%');
    expect(formatBp(1000)).toBe('10%');
    expect(formatBp(10_000)).toBe('100%');
    expect(formatBp(0)).toBe('0%');
    expect(formatBp(1)).toBe('0.01%');
    expect(formatBp(7)).toBe('0.07%');
    expect(formatBp(3333)).toBe('33.33%');
    expect(formatBp(9_999)).toBe('99.99%');
  });

  it('says the gap in basis points first, as over or short, and nothing when balanced', () => {
    expect(formatGap(0)).toBe('');
    expect(formatGap(50)).toBe('50 basis points over (0.5%)');
    expect(formatGap(-50)).toBe('50 basis points short (0.5%)');
    expect(formatGap(1)).toBe('1 basis point over (0.01%)');
    expect(formatGap(-1)).toBe('1 basis point short (0.01%)');
    expect(formatGap(-10_000)).toBe('10000 basis points short (100%)');
  });
});

describe('typing: a decimal read digit by digit', () => {
  it('reads plain decimals of up to two places as exact hundredths', () => {
    expect(parseHundredths('23.5')).toBe(2350);
    expect(parseHundredths('23.50')).toBe(2350);
    expect(parseHundredths('23.05')).toBe(2305);
    expect(parseHundredths('150')).toBe(15_000);
    expect(parseHundredths('  150.5  ')).toBe(15_050);
    expect(parseHundredths('007')).toBe(700);
  });

  it('reads 0 as zero and a single satang as one', () => {
    expect(parseHundredths('0')).toBe(0);
    expect(parseHundredths('0.00')).toBe(0);
    expect(parseHundredths('0.01')).toBe(1);
    expect(parseHundredths('0.1')).toBe(10);
  });

  it('reads 0.07 as exactly 7, where the float route does not', () => {
    expect(Number('0.07') * 100).not.toBe(7);
    expect(parseHundredths('0.07')).toBe(7);
    // A list typed to add to 100 adds to exactly 10,000.
    const typed = ['0.07', '33.31', '33.31', '33.31'].map((t) => parsePercentToBp(t));
    expect(typed).toEqual([7, 3331, 3331, 3331]);
    expect(weightVerdict(typed.map((w) => prize(w ?? 0))).balanced).toBe(true);
  });

  it('refuses a thousands separator rather than misreading it', () => {
    // "1,000" must not become one baht, nor a thousand with the comma guessed at.
    expect(parseHundredths('1,000')).toBeNull();
    expect(parseHundredths('1,000.50')).toBeNull();
    expect(parseBahtToSatang('1,000')).toBeNull();
    // Nor is a comma taken for a decimal point.
    expect(parseHundredths('23,5')).toBeNull();
    // The display form is not typing either: formatTHB's "฿1,000" is refused.
    expect(parseBahtToSatang('฿1,000')).toBeNull();
    expect(parseBahtToSatang('1000')).toBe(100_000);
  });

  it('refuses a negative, a sign, and anything that is not a plain decimal', () => {
    const refused = [
      '-5',
      '-0.01',
      '+5',
      '−5', // a typographic minus sign
      '5.',
      '.5',
      '1.234',
      '1e3',
      'Infinity',
      'NaN',
      'abc',
      '5 5',
      '๕', // the Thai digit five
    ];
    for (const text of refused) expect(parseHundredths(text), text).toBeNull();
  });

  it('treats an empty field as not set, never as an invented zero', () => {
    expect(parseHundredths('')).toBeNull();
    expect(parseHundredths('   ')).toBeNull();
  });

  it('takes up to seven whole digits and refuses an eighth', () => {
    expect(parseHundredths('9999999.99')).toBe(999_999_999);
    expect(parseHundredths('10000000')).toBeNull();
  });

  it('takes a percentage from 0 to 100 and refuses anything past a whole', () => {
    expect(parsePercentToBp('100')).toBe(10_000);
    expect(parsePercentToBp('100.00')).toBe(10_000);
    expect(parsePercentToBp('100.01')).toBeNull();
    expect(parsePercentToBp('0')).toBe(0);
    expect(parsePercentToBp('0.01')).toBe(1);
    expect(parsePercentToBp('-1')).toBeNull();
  });
});

describe('hundredthsToText — a stored value put back in a field', () => {
  it('writes the value as a person would type it', () => {
    expect(hundredthsToText(2350)).toBe('23.5');
    expect(hundredthsToText(2305)).toBe('23.05');
    expect(hundredthsToText(1000)).toBe('10');
    expect(hundredthsToText(0)).toBe('0');
    expect(hundredthsToText(1)).toBe('0.01');
    expect(hundredthsToText(10)).toBe('0.1');
    expect(hundredthsToText(99)).toBe('0.99');
    // No grouping: what goes back in the field is what the parser takes.
    expect(hundredthsToText(100_000)).toBe('1000');
    expect(hundredthsToText(150_050)).toBe('1500.5');
  });

  it('round-trips every value from 0 to ฿1,000 exactly, satang by satang', () => {
    for (let v = 0; v <= 100_000; v++) {
      const text = hundredthsToText(v);
      if (parseHundredths(text) !== v)
        throw new Error(`${v} → "${text}" → ${parseHundredths(text)}`);
    }
  });

  it('round-trips the large values up to the parser’s ceiling', () => {
    for (const v of [100_001, 123_456, 1_000_000, 12_345_678, 99_999_999, 999_999_999]) {
      expect(parseHundredths(hundredthsToText(v))).toBe(v);
    }
  });

  it('round-trips every weight a prize can have', () => {
    for (let bp = 0; bp <= TOTAL_BP; bp++) {
      const text = hundredthsToText(bp);
      if (parsePercentToBp(text) !== bp) throw new Error(`${bp} → "${text}"`);
    }
  });

  it('keeps the sign on a negative of a baht or more', () => {
    expect(hundredthsToText(-150)).toBe('-1.5');
    expect(hundredthsToText(-10_000)).toBe('-100');
  });

  // DEFECT (SCRUM-256): a negative value above -100 loses its sign.
  // `Math.trunc(-5 / 100)` is -0, `String(-0)` is "0", and the fraction is
  // taken with `Math.abs` — so -5 is written "0.05" and -1 "0.01", the text of
  // +5 and +1. The function keeps the sign for -150 ("-1.5"), so it means to
  // handle negatives. Not reachable from a stored value today: the api and the
  // database refuse a negative weight, cost or voucher value
  // (`booth_prize_cost_check`, the `min(0)` on each field), so it is recorded
  // here rather than fixed with this ticket.
  test.todo('writes -5 as "-0.05" and -1 as "-0.01", not as the text of +5 and +1');
});
