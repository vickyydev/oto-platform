import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { api } from '@/api/client';
import { paymentsApi } from '@/api/payments';
import type { ApiSale } from '@/api/sales';
import * as methods from '@/lib/payments';
import { useRecordedPaymentScope } from '@/lib/recordedPaymentScope';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import { usePaymentStage } from '@/lib/usePaymentStage';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';

vi.mock('react', () => import('./support/hooks'));
const unmounts: (() => void)[] = [];
const catalogue = [
  { id: 'cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'qr', kind: 'qr' as const, label: 'QR', enabled: true, sortOrder: 1 },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function mount() {
  let committed: ApiSale | null = null;
  const write = deferred<SaleWriteOutcome>();
  const read = deferred<{ sale: ApiSale; attempts: PaymentAttemptView[] }>();
  const get = vi.spyOn(api, 'get').mockImplementation(() => read.promise);
  const finaliseSale = vi.fn();
  const hook = renderHook((scope: string) => {
    const recorded = useRecordedPaymentScope();
    const stage = usePaymentStage({ scope, isCurrentScope: candidate => candidate === scope, active: true,
      totalSatang: 54000, resumeSaleId: recorded.resumeSaleId(committed, scope),
      prepareSale: vi.fn(), finaliseSale, onComplete: vi.fn() });
    return { recorded, stage };
  }, 'order-1' as string);
  unmounts.push(hook.unmount);
  // OrderStation starts this write on entering Payment, before staff choose a tender.
  const recording = hook.result.current.recorded.record('order-1', async () => {
    const outcome = await write.promise;
    if (outcome.ok && outcome.written) committed = outcome.sale;
    return outcome;
  });
  const revealSale = async () => {
    const sale = apiSale();
    write.resolve({ ok: true, written: true, saleId: sale.id, sale, replay: false });
    await recording;
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(hook.result.current.stage.locked).toBe(true);
  };
  const finishRead = async (sale = apiSale(), attempts: PaymentAttemptView[] = []) => {
    read.resolve({ sale, attempts });
    await vi.waitFor(() => expect(hook.result.current.stage.state.phase).not.toBe('blocked'));
  };
  return { ...hook, revealSale, finishRead, finaliseSale };
}
const attempt = (status: 'approved' | 'sent_to_terminal'): PaymentAttemptView => ({
  id: 'recorded-payment', saleId: 'sale-1', method: 'qr', provider: 'simulator', status,
  amountSatang: status === 'approved' ? 3000 : 54000, tenderedSatang: null, changeSatang: null,
  terminalRef: null, tid: null, approvalCode: null, last4: null, invoiceNo: null, tranRef: null,
  actionId: 'zz-test-choice-recovery', offline: false, paidAt: null, createdAt: '2026-11-16T12:00:00Z',
});
beforeEach(() => {
  vi.spyOn(methods, 'findPaymentMethod').mockImplementation(id => catalogue.find(method => method.id === id));
  vi.spyOn(methods, 'getEnabledPaymentMethods').mockReturnValue(catalogue);
  vi.spyOn(paymentsApi, 'start');
});
afterEach(() => { while (unmounts.length) unmounts.pop()!(); vi.restoreAllMocks(); });

describe('SCRUM-986: a late charge write cannot erase an untouched payment form', () => {
  it('HIGH: Cash chosen before the charge id arrives survives a verified no-attempt read', async () => {
    const t = mount();
    t.result.current.stage.selectMethod('cash');
    expect(t.result.current.stage.state.method).toBe('cash');
    await t.revealSale();
    t.result.current.stage.selectMethod('qr');
    await t.result.current.stage.submit();
    expect(paymentsApi.start).not.toHaveBeenCalled();
    expect(t.finaliseSale).not.toHaveBeenCalled();
    await t.finishRead();
    expect(t.result.current.stage.state).toMatchObject({ method: 'cash', kind: 'cash', partial: false,
      outstandingSatang: 54000, amountSatang: 54000, tenderedSatang: 54000 });
    expect(t.result.current.stage.canSubmit).toBe(true);
  });

  it('HIGH: a partial amount and cash already entered survive the same no-attempt reconciliation', async () => {
    const t = mount();
    t.result.current.stage.selectMethod('cash');
    t.result.current.stage.setPartial?.(true);
    t.result.current.stage.setAmountSatang(3000);
    t.result.current.stage.setTenderedSatang(5000);
    await t.revealSale();
    await t.finishRead();
    expect(t.result.current.stage.state).toMatchObject({ method: 'cash', kind: 'cash', partial: true,
      outstandingSatang: 54000, amountSatang: 3000, tenderedSatang: 5000 });
  });

  it.each(['approved', 'sent_to_terminal'] as const)('HIGH: a recorded %s payment overrides the earlier Cash choice', async status => {
    const recorded = attempt(status);
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ attempt: recorded,
      outstandingSatang: status === 'approved' ? 51000 : 54000, route: 'gateway',
      qrPayload: status === 'approved' ? null : 'ZZ TEST QR', qrImageUrl: null, expiresAt: null,
      expiryTimerMs: null, responseText: null, deviceLabel: null });
    const t = mount();
    t.result.current.stage.selectMethod('cash');
    t.result.current.stage.setPartial?.(true);
    t.result.current.stage.setAmountSatang(3000);
    await t.revealSale();
    await t.finishRead(apiSale(), [recorded]);
    expect(t.result.current.stage.state.method).toBe(status === 'approved' ? null : 'qr');
    expect(t.result.current.stage.state.outstandingSatang).toBe(status === 'approved' ? 51000 : 54000);
    expect(t.result.current.stage.locked).toBe(status !== 'approved');
    expect(paymentsApi.start).not.toHaveBeenCalled();
    expect(t.finaliseSale).not.toHaveBeenCalled();
  });

  it('HIGH: a changed server total cannot retain the earlier partial amount', async () => {
    const t = mount();
    t.result.current.stage.selectMethod('cash');
    t.result.current.stage.setPartial?.(true);
    t.result.current.stage.setAmountSatang(3000);
    await t.revealSale();
    const sale = apiSale();
    await t.finishRead({ ...sale, totals: { ...sale.totals, grossSatang: 60000 } });
    expect(t.result.current.stage.state).toMatchObject({ method: null, partial: false,
      outstandingSatang: 60000, amountSatang: 60000, tenderedSatang: 60000 });
  });

  it('HIGH: a method disabled while the charge is being checked cannot be restored', async () => {
    const t = mount();
    t.result.current.stage.selectMethod('cash');
    await t.revealSale();
    vi.mocked(methods.findPaymentMethod).mockImplementation(id => id === 'cash'
      ? { ...catalogue[0]!, enabled: false } : catalogue.find(method => method.id === id));
    await t.finishRead();
    expect(t.result.current.stage.state.method).toBeNull();
    expect(t.result.current.stage.canSubmit).toBe(false);
  });

  it('HIGH: a late read for the old order cannot restore its Cash choice on the next order', async () => {
    const t = mount();
    t.result.current.stage.selectMethod('cash');
    await t.revealSale();
    t.rerender('order-2');
    await t.finishRead();
    expect(t.result.current.stage.state).toMatchObject({ saleId: null, method: null, partial: false,
      outstandingSatang: 54000, amountSatang: 54000 });
    expect(t.result.current.stage.canSubmit).toBe(false);
  });
});
