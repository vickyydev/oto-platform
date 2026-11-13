import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRecordedPaymentScope } from '@/lib/recordedPaymentScope';
import { paymentOrderIdentity } from '@/lib/paymentScope';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';

vi.mock('react', () => import('./support/hooks'));
const unmounts: (() => void)[] = [];
function mount() {
  const h = renderHook(() => useRecordedPaymentScope(), undefined);
  unmounts.push(h.unmount);
  return h;
}
const answer = (id = 'sale-1'): SaleWriteOutcome => ({ ok: true, written: true, saleId: id,
  sale: apiSale({ id }), replay: false });
const scope = (accountId: string, adults = 1, discount = 250) => JSON.stringify([
  1, paymentOrderIdentity({ accountId, accountName: accountId, stationId: 'station-1' }),
  [{ kids: 1, adults }], [{ amount: discount, reason: 'ZZ TEST manual discount' }],
]);
afterEach(() => { while (unmounts.length) unmounts.pop()!(); });

describe('SCRUM-982: only the recorded order may reuse or recover its charge', () => {
  it('an unchanged discounted order keeps its sale when the operator changes', async () => {
    const h = mount(), write = vi.fn().mockResolvedValue(answer());
    await h.result.current.record(scope('A'), write);
    expect(scope('A')).toBe(scope('B'));
    expect(h.result.current.replay(apiSale(), scope('B'))).toMatchObject({ ok: true, written: true, saleId: 'sale-1', replay: true });
    expect(h.result.current.resumeSaleId(apiSale(), scope('B'))).toBe('sale-1');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(['quantity', 'discount'] as const)('HIGH: an edited %s cannot replay or recover the old charge', async change => {
    const h = mount();
    await h.result.current.record(scope('A'), async () => answer());
    const corrected = change === 'quantity' ? scope('B', 2) : scope('B', 1, 500);
    expect(h.result.current.replay(apiSale(), corrected)).toBeNull();
    expect(h.result.current.resumeSaleId(apiSale(), corrected)).toBeUndefined();
    await h.result.current.record(corrected, async () => answer('sale-2'));
    expect(h.result.current.resumeSaleId(apiSale({ id: 'sale-2' }), corrected)).toBe('sale-2');
    expect(h.result.current.resumeSaleId(apiSale(), corrected)).toBeUndefined();
  });

  it('HIGH: a late paused write retains its captured scope rather than the next cart', async () => {
    const h = mount();
    let resolve!: (value: SaleWriteOutcome) => void;
    const pending = h.result.current.record(scope('A'), () => new Promise(done => { resolve = done; }));
    h.rerender(undefined);
    resolve(answer()); await pending;
    expect(h.result.current.resumeSaleId(apiSale(), scope('B', 2))).toBeUndefined();
    expect(h.result.current.resumeSaleId(apiSale(), scope('B'))).toBe('sale-1');
  });
});
