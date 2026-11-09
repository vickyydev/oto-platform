import { describe, expect, it } from 'vitest';
import {
  EXTRA_HOUR_OPTIONS,
  EXTRA_HOUR_PER_CHILD_SATANG,
  extraHourAmountSatang,
  extraHourChildBandIds,
  extraHourChildren,
  extraHourFactors,
  isExtraHourLine,
  extraHourLineLabel,
  extraHourSum,
  type ExtraHourLine,
} from '../src/index';

/**
 * SCRUM-797 — the owner's extra hour: 1, 2 or 3 hours added to a 1 or 2-hour
 * child ticket at ฿300 per child per hour, the children read off the order.
 */

/** One ticket cart line as the ledger writes it: its counts and hours on every row. */
function ticket(cartLineId: string, kids: number, adults: number, stayHours: number | null): ExtraHourLine[] {
  const rows: ExtraHourLine[] = [];
  if (kids > 0) rows.push({ id: `${cartLineId}-kids`, cartLineId, ticket: true, kidCount: kids, stayHours });
  if (adults > 0) rows.push({ id: `${cartLineId}-adults`, cartLineId, ticket: true, kidCount: kids, stayHours });
  return rows;
}

describe('the options and the sum', () => {
  it('offers 1, 2 or 3 hours, one child’s price each, and nothing shorter', () => {
    expect(EXTRA_HOUR_PER_CHILD_SATANG).toBe(30_000);
    expect(EXTRA_HOUR_OPTIONS.map((o) => [o.id, o.hours, o.minutes, o.unitSatang])).toEqual([
      ['ext-60', 1, 60, 30_000],
      ['ext-120', 2, 120, 60_000],
      ['ext-180', 3, 180, 90_000],
    ]);
  });

  it('is hours × children × ฿300', () => {
    expect(extraHourAmountSatang(1, 1)).toBe(30_000);
    expect(extraHourAmountSatang(1, 2)).toBe(60_000);
    expect(extraHourAmountSatang(2, 3)).toBe(180_000);
    expect(extraHourAmountSatang(3, 3)).toBe(270_000);
  });

  it('says the sum the way the owner wrote it', () => {
    expect(extraHourSum(3, 2)).toBe('3 children x 2 hours x ฿300 = ฿1,800');
    expect(extraHourSum(1, 1)).toBe('1 child x 1 hour x ฿300 = ฿300');
    expect(extraHourFactors(2, 3)).toBe('2 children x 3 hours x ฿300');
    expect(extraHourLineLabel(2)).toBe('Extra hour x 2');
  });
});

describe('the children it is charged for', () => {
  it('counts each ticket cart line once, from the order', () => {
    expect(extraHourChildren(ticket('a', 3, 1, 1))).toEqual({ ok: true, children: 3 });
    expect(extraHourChildren([...ticket('a', 1, 0, 1), ...ticket('b', 2, 2, 2)])).toEqual({ ok: true, children: 3 });
  });

  it('leaves out the children on a longer ticket, and lines that are not tickets', () => {
    const socks: ExtraHourLine = { id: 'socks', cartLineId: 'a', ticket: false, kidCount: 0, stayHours: null };
    expect(extraHourChildren([...ticket('a', 2, 1, 1), ...ticket('b', 1, 0, 8), socks])).toEqual({ ok: true, children: 2 });
  });

  it('refuses a Full Day pass and an order with no child, in words', () => {
    expect(extraHourChildren(ticket('a', 2, 1, 8))).toMatchObject({ ok: false, code: 'EXTENSION_TICKET_NOT_ELIGIBLE' });
    expect(extraHourChildren(ticket('a', 1, 0, null))).toMatchObject({ ok: false, code: 'EXTENSION_TICKET_NOT_ELIGIBLE' });
    expect(extraHourChildren(ticket('a', 0, 2, 2))).toMatchObject({ ok: false, code: 'EXTENSION_NO_CHILDREN' });
    expect(extraHourChildren([])).toMatchObject({ ok: false, code: 'EXTENSION_NO_CHILDREN' });
    const refused = extraHourChildren(ticket('a', 2, 0, 8));
    expect(refused.ok ? '' : refused.message).toContain('1 or 2-hour child ticket');
  });
});

describe('the bracelets that always carry it', () => {
  it('a 1 or 2-hour ticket line takes an extra hour; a longer one, an unrecorded one or a non-ticket does not', () => {
    expect(isExtraHourLine({ ticket: true, stayHours: 1 })).toBe(true);
    expect(isExtraHourLine({ ticket: true, stayHours: 2 })).toBe(true);
    expect(isExtraHourLine({ ticket: true, stayHours: 8 })).toBe(false);
    expect(isExtraHourLine({ ticket: true, stayHours: null })).toBe(false);
    expect(isExtraHourLine({ ticket: false, stayHours: 1 })).toBe(false);
  });

  it('every child’s band on a 1 or 2-hour ticket, never an adult’s or a Full Day child’s', () => {
    const lines = [...ticket('a', 2, 1, 1), ...ticket('b', 1, 0, 8)];
    const bands = [
      { id: 'k1', kind: 'kid', saleLineId: 'a-kids' },
      { id: 'k2', kind: 'kid', saleLineId: 'a-kids' },
      { id: 'a1', kind: 'adult', saleLineId: 'a-adults' },
      { id: 'k3', kind: 'kid', saleLineId: 'b-kids' },
      { id: 'event', kind: 'kid', saleLineId: null },
    ];
    expect(extraHourChildBandIds(lines, bands)).toEqual(['k1', 'k2']);
    expect(extraHourChildBandIds(ticket('a', 2, 0, 8), bands)).toEqual([]);
  });
});
