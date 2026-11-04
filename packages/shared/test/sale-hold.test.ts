import { describe, expect, it } from 'vitest';
import {
  SaleHoldBodySchema,
  businessDate,
  heldSaleKindOf,
  holdOutlivedItsDay,
  partPaidCloseRefusal,
  type EodOpenSale,
} from '../src';

/**
 * SCRUM-774 — the two pure rules a held sale lives by: the MIDNIGHT day end
 * (not the park's 05:00 business-day boundary, which nothing else here moves
 * to), and the End of Day's refusal in words.
 */
const TZ = 'Asia/Bangkok';
const at = (local: string): Date => new Date(`${local}+07:00`);

describe('holdOutlivedItsDay — midnight in the branch, not 05:00', () => {
  it('a sale held in the evening is still in its day at 23:59:59', () => {
    expect(holdOutlivedItsDay(at('2026-11-04T20:15:00'), at('2026-11-04T23:59:59'), TZ)).toBe(false);
  });

  it('it has outlived its day at 00:00 the next morning', () => {
    expect(holdOutlivedItsDay(at('2026-11-04T20:15:00'), at('2026-11-05T00:00:00'), TZ)).toBe(true);
  });

  it('midnight is not the business-day boundary: at 00:30 the business day has not changed, the hold has', () => {
    const held = at('2026-11-04T20:15:00');
    const now = at('2026-11-05T00:30:00');
    expect(businessDate(now, TZ, 5 * 60)).toBe(businessDate(held, TZ, 5 * 60));
    expect(holdOutlivedItsDay(held, now, TZ)).toBe(true);
  });

  it('a sale held after midnight waits until the next midnight', () => {
    expect(holdOutlivedItsDay(at('2026-11-05T00:20:00'), at('2026-11-05T04:59:00'), TZ)).toBe(false);
    expect(holdOutlivedItsDay(at('2026-11-05T00:20:00'), at('2026-11-06T00:00:00'), TZ)).toBe(true);
  });

  it('reads the calendar of the branch, not of UTC', () => {
    // 23:30 in Bangkok is 16:30 UTC the same day; 00:10 is 17:10 UTC — still the same UTC day.
    expect(holdOutlivedItsDay(at('2026-11-04T23:30:00'), at('2026-11-05T00:10:00'), TZ)).toBe(true);
  });
});

describe('heldSaleKindOf', () => {
  it('is part-paid exactly when money was taken', () => {
    expect(heldSaleKindOf(0)).toBe('held');
    expect(heldSaleKindOf(1)).toBe('part_paid');
  });
});

describe('SaleHoldBodySchema', () => {
  it('needs a name or band and trims it', () => {
    expect(SaleHoldBodySchema.safeParse({ kind: 'held', label: '  ' }).success).toBe(false);
    expect(SaleHoldBodySchema.parse({ kind: 'held', label: ' Khun Anna ' }).label).toBe('Khun Anna');
    expect(SaleHoldBodySchema.safeParse({ kind: 'held', label: 'x'.repeat(81) }).success).toBe(false);
  });
});

const row = (over: Partial<EodOpenSale>): EodOpenSale => ({
  saleId: '00000000-0000-4000-8000-000000000001',
  kind: 'part_paid',
  label: 'Khun Anna',
  held: true,
  stationName: 'Reception Till 1',
  grossSatang: 55_000,
  paidSatang: 20_000,
  balanceSatang: 35_000,
  flaggedAt: null,
  ...over,
});

describe('partPaidCloseRefusal — the End of Day says why it cannot close', () => {
  it('says nothing when only held sales with no money are open', () => {
    expect(partPaidCloseRefusal([row({ kind: 'held', paidSatang: 0, balanceSatang: 55_000 })])).toBeNull();
    expect(partPaidCloseRefusal([])).toBeNull();
  });

  it('names one part-paid sale with what was paid and the balance', () => {
    expect(partPaidCloseRefusal([row({})])).toBe(
      'End of Day cannot close: 1 sale is partly paid — Khun Anna (in Held sales), ฿200 paid, balance ฿350. ' +
        'Take the balance or refund what was paid, from Held sales on a till, then close the day.',
    );
  });

  it('says where a part-paid sale still on a till is, and how to move it to Held sales', () => {
    const message = partPaidCloseRefusal([row({ held: false, label: 'Walk-in', stationName: 'Counter 2' })]);
    expect(message).toContain('Walk-in (open on Counter 2)');
    expect(message).toContain('save it as partly paid');
  });

  it('names three and counts the rest', () => {
    const many = [1, 2, 3, 4, 5].map((n) => row({ label: `Guest ${n}` }));
    const message = partPaidCloseRefusal(many)!;
    expect(message).toMatch(/^End of Day cannot close: 5 sales are partly paid — Guest 1 /);
    expect(message).toContain('; and 2 more.');
    expect(message).not.toContain('Guest 4');
  });
});
