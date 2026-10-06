import { describe, expect, it } from 'vitest';
import {
  formatInPacks,
  parsePackQuantity,
  STOCK_CASCADE_TYPE_ORDER,
  stockShortMessage,
  stockSizeName,
  stockStatus,
} from '../src/stock';

/**
 * S2-14b round 1 — the stock rules every surface shares (plan §2.1, §5).
 * Packs are entry and display only; a quantity that is not a whole number of
 * eaches is refused, never rounded (the prototype's `parseUnitCombo` rounded).
 */

const DOZEN = [{ label: 'Dozen', eaches: 12 }];
const CASE = [{ label: 'Case', eaches: 24 }];

describe('parsePackQuantity — whole eaches only', () => {
  it.each([
    ['24', DOZEN, 24],
    ['2 dozen', DOZEN, 24],
    ['2 dozens', DOZEN, 24],
    ['1 dozen + 3', DOZEN, 15],
    ['1 case + 3', CASE, 27],
    ['1.5 dozen', DOZEN, 18],
    ['0.5 case', CASE, 12],
    ['', DOZEN, 0],
  ])('"%s" is %s eaches', (raw, packs, eaches) => {
    expect(parsePackQuantity(raw, packs)).toEqual({ ok: true, eaches });
  });

  it.each([
    ['1.3 dozen', DOZEN],
    ['2.5', DOZEN],
    ['0.1 case', CASE],
  ])('refuses "%s", which is not a whole number of items', (raw, packs) => {
    const parsed = parsePackQuantity(raw, packs);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('whole');
  });

  it.each([
    ['0.5 + 0.5', DOZEN, 'whole'],
    ['1 dozen + 0.5', DOZEN, 'whole'],
    ['0.1 case + 0.1 case + 0.3 case', CASE, 'whole'],
    ['-3', DOZEN, 'below nothing'],
    ['-1 dozen', DOZEN, 'below nothing'],
    ['2 dozen + -5', DOZEN, 'below nothing'],
  ])('refuses "%s": every part is whole eaches on its own, and never below nothing', (raw, packs, why) => {
    const parsed = parsePackQuantity(raw, packs);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(why);
  });

  it('refuses something that is not a quantity at all', () => {
    expect(parsePackQuantity('lots', DOZEN)).toEqual({ ok: false, reason: '"lots" is not a quantity' });
  });

  it('formats eaches back into packs, largest first', () => {
    expect(formatInPacks(27, CASE)).toBe('1 Case + 3');
    expect(formatInPacks(48, CASE)).toBe('2 Cases');
    expect(formatInPacks(5, [])).toBe('5');
  });
});

describe('the counter’s words and the cascade', () => {
  it('names a size and a shortage the way the counter says it', () => {
    expect(stockShortMessage(stockSizeName('Grip Socks', 'S'), 3)).toBe('Only 3 Grip Socks S left');
    expect(stockShortMessage(stockSizeName('Mascot Keyring', null), 0)).toBe('Mascot Keyring is out of stock');
  });

  it('out, low and ok are the prototype’s variantStatus', () => {
    expect(stockStatus(0, 5)).toBe('out');
    expect(stockStatus(5, 5)).toBe('low');
    expect(stockStatus(6, 5)).toBe('ok');
    expect(stockStatus(1, null)).toBe('ok');
  });

  it('takes from back of house before bulk (the transfer-source order)', () => {
    expect(STOCK_CASCADE_TYPE_ORDER).toEqual(['back_of_house', 'bulk', 'rotation']);
  });
});
