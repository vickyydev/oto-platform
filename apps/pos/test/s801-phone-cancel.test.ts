import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';
import { useSaleWriter } from '@/lib/saleWriter';
import { CANCELLED_AT_THE_TILL } from '@/lib/tillVoucher';
import { resumableHere } from '@/lib/leftBehindSale';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';

vi.mock('react', () => import('./support/hooks'));

const source = readFileSync(new URL('../src/components/mobile/MobileTill.tsx', import.meta.url), 'utf8');
// Execute the actual mobile callback with its closure supplied. The complete
// component and its buttons are driven against the real API by phone-payment.spec.ts.
const callback = source.slice(source.indexOf('  const handleCancel = async'), source.indexOf('  // Back-nav behaviour'));
const unmounts: Array<() => void> = [];
afterEach(() => { unmounts.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });

function mount() {
  const hook = renderHook(() => useSaleWriter());
  unmounts.push(hook.unmount);
  const sale = apiSale({ status: 'tendering' });
  hook.result.current.adopt(sale);
  const resetSale = vi.fn(() => hook.result.current.reset());
  const context = {
    saleWriter: hook.result.current, CANCELLED_AT_THE_TILL,
    cancellingRef: { current: false }, completionRetry: null,
    paymentStage: { canBack: true, state: { settlements: [] } },
    saleEpochRef: { current: 1 }, setCancelling: vi.fn(), setCancelRefusal: vi.fn(), resetSale,
    preparePaymentSale: vi.fn(), paymentScope: 'test', completeSale: vi.fn(),
  };
  const cancel = new Function(...Object.keys(context), `${callback}\nreturn handleCancel;`)(...Object.values(context)) as () => Promise<void>;
  return { hook, sale, context, cancel };
}

describe('SCRUM-801 — the phone Cancel uses the counter sale writer', () => {
  it('voids the unpaid sale through the route before resetting; it is not resumable', async () => {
    const { sale, context, cancel } = mount();
    const voided = { ...sale, status: 'voided' as const };
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      expect(context.resetSale).not.toHaveBeenCalled();
      return { sale: voided, replay: false, releasedVoucherIds: [], void: {} };
    });
    await cancel();
    expect(post).toHaveBeenCalledWith(`/sales/${sale.id}/void`, { reason: CANCELLED_AT_THE_TILL }, expect.any(Object));
    expect(context.resetSale).toHaveBeenCalledTimes(1);
    expect(resumableHere(voided, { stationId: sale.stationId!, accountId: sale.soldBy?.accountId ?? null })).toBe(false);
  });

  it('keeps the order and the platform refusal when money has already been taken', async () => {
    const { context, cancel } = mount();
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'SALE_HAS_PAYMENTS', 'Money has been taken for this sale'));
    await cancel();
    expect(context.resetSale).not.toHaveBeenCalled();
    expect(context.setCancelRefusal).toHaveBeenLastCalledWith('Money has been taken for this sale');
    expect(context.cancellingRef.current).toBe(false);
  });

  it('joins no second cancellation while the first void is unanswered', async () => {
    const { sale, context, cancel } = mount();
    let answer!: (value: unknown) => void;
    const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const first = cancel();
    await cancel();
    expect(post).toHaveBeenCalledTimes(1);
    expect(context.resetSale).not.toHaveBeenCalled();
    answer({ sale: { ...sale, status: 'voided' }, replay: false, releasedVoucherIds: [], void: {} });
    await first;
    expect(context.resetSale).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending tender untouched', async () => {
    const { context, cancel } = mount();
    context.paymentStage.canBack = false;
    const post = vi.spyOn(api, 'post');
    await cancel();
    expect(post).not.toHaveBeenCalled();
    expect(context.resetSale).not.toHaveBeenCalled();
  });
});
