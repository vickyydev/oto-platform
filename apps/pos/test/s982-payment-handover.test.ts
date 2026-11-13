import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { api } from '@/api/client';
import { paymentsApi, type PaymentStartResult } from '@/api/payments';
import * as methods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import { paymentOrderIdentity } from '@/lib/paymentScope';
import { renderHook } from './support/hooks';
import { apiSale } from './support/fixtures';

vi.mock('react', () => import('./support/hooks'));
const unmounts: (() => void)[] = [];
const catalogue = [{ id: 'qr', kind: 'qr' as const, label: 'QR', enabled: true, sortOrder: 0 },
  { id: 'cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 1 }];
const attempt = (status: PaymentAttemptView['status']): PaymentAttemptView => ({
  id: 'qr-982', saleId: 'sale-1', method: 'qr', provider: 'simulator', status, amountSatang: 54000,
  tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null, last4: null,
  invoiceNo: null, tranRef: null, actionId: 'zz982', offline: false, paidAt: status === 'approved' ? new Date().toISOString() : null,
  createdAt: new Date().toISOString(),
});
function mount(resumeSaleId: string | undefined = 'sale-1') {
  const sale = apiSale({ status: 'finalised' });
  const options: PaymentStageOptions = { scope: 'order-1', isCurrentScope: x => x === 'order-1', totalSatang: 54000,
    resumeSaleId, prepareSale: vi.fn().mockResolvedValue({ ok: true, written: true, sale: apiSale(), saleId: 'sale-1', replay: true }),
    finaliseSale: vi.fn().mockResolvedValue({ ok: true, written: true, sale, saleId: sale.id, replay: false, finalised: true, outstandingSatang: 0 }),
    onComplete: vi.fn(),
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options };
}
beforeEach(() => {
  vi.spyOn(methods, 'findPaymentMethod').mockImplementation(id => catalogue.find(m => m.id === id));
  vi.spyOn(methods, 'getEnabledPaymentMethods').mockReturnValue(catalogue);
  vi.spyOn(paymentsApi, 'start');
});
afterEach(() => { while (unmounts.length) unmounts.pop()!(); vi.restoreAllMocks(); });

describe('SCRUM-982 recorded money owns every continued payment screen', () => {
  it.each(['paid', 'finalised'] as const)('HIGH: %s QR completes as QR without a Cash press or second tender', async status => {
    vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale({ status }), attempts: [attempt('approved')] });
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ attempt: attempt('approved'), outstandingSatang: 0, route: 'gateway',
      qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null, responseText: null, deviceLabel: null });
    const t = mount();
    expect(t.result.current.canSubmit).toBe(false);
    t.result.current.selectMethod('cash'); await t.result.current.submit();
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe('complete'));
    expect(paymentsApi.start).not.toHaveBeenCalled();
    expect(t.options.onComplete).toHaveBeenCalledTimes(1);
    expect(t.result.current.state.settlements).toMatchObject([{ method: 'qr', kind: 'qr', amountSatang: 54000 }]);
    expect(t.options.finaliseSale).toHaveBeenCalledTimes(status === 'paid' ? 1 : 0);
  });

  it.each(['sent_to_terminal', 'cancelled'] as const)('HIGH: %s is read before any new tender', async status => {
    let answer!: (value: unknown) => void;
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ attempt: attempt(status), outstandingSatang: 54000, route: 'gateway',
      qrPayload: status === 'cancelled' ? null : 'ZZ TEST QR', qrImageUrl: null, expiresAt: null, expiryTimerMs: null, responseText: null, deviceLabel: null });
    const t = mount();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(t.result.current.locked).toBe(true);
    t.result.current.selectMethod('cash'); await t.result.current.submit();
    expect(paymentsApi.start).not.toHaveBeenCalled();
    answer({ sale: apiSale(), attempts: [attempt(status)] });
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe(status === 'cancelled' ? 'ready' : 'pending'));
    expect(t.result.current.canCancel).toBe(status !== 'cancelled');
    expect(t.options.prepareSale).not.toHaveBeenCalled();
  });

  it('HIGH: an id arriving while a tender is in flight is reconciled after its answer', async () => {
    let started!: (value: PaymentStartResult) => void;
    vi.mocked(paymentsApi.start).mockImplementation(() => new Promise(resolve => { started = resolve; }));
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale(), attempts: [attempt('sent_to_terminal')] });
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ attempt: attempt('sent_to_terminal'), outstandingSatang: 54000, route: 'gateway',
      qrPayload: 'ZZ TEST QR', qrImageUrl: null, expiresAt: null, expiryTimerMs: null, responseText: null, deviceLabel: null });
    const t = mount('');
    // Undefined must be explicit here: the initial screen has not rung up its sale yet.
    t.rerender({ ...t.options, resumeSaleId: undefined });
    t.result.current.selectMethod('qr');
    const sent = t.result.current.submit();
    await vi.waitFor(() => expect(started).toBeTypeOf('function'));
    t.rerender({ ...t.options, resumeSaleId: 'sale-1' });
    started({ route: 'gateway', attempt: attempt('sent_to_terminal'), outstandingSatang: 54000, replayed: false,
      qrPayload: 'ZZ TEST QR', qrImageUrl: null, expiresAt: null, expiryTimerMs: null });
    await sent;
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe('pending'));
    expect(paymentsApi.start).toHaveBeenCalledTimes(1);
    expect(t.result.current.canCancel).toBe(true);
  });

  it('HIGH: a QR paid while a sale with no earlier attempt is locked is recovered before Cash', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale(), attempts: [] });
    vi.spyOn(paymentsApi, 'read').mockResolvedValue({ attempt: attempt('approved'), outstandingSatang: 0, route: 'gateway',
      qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null, responseText: null, deviceLabel: null });
    const t = mount();
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe('ready'));
    t.rerender({ ...t.options, paused: true });
    get.mockResolvedValue({ sale: apiSale({ status: 'finalised' }), attempts: [attempt('approved')] });
    t.rerender({ ...t.options, paused: false });
    t.result.current.selectMethod('cash'); await t.result.current.submit();
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe('complete'));
    expect(t.result.current.state.settlements).toMatchObject([{ method: 'qr', kind: 'qr', amountSatang: 54000 }]);
    expect(paymentsApi.start).not.toHaveBeenCalled();
    expect(t.options.finaliseSale).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('HIGH: a nonzero finalised sale without verified taken money cannot complete with fallback Cash', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale({ status: 'finalised' }), attempts: [] });
    const t = mount();
    await vi.waitFor(() => expect(t.result.current.state.error).toBe('The recorded payments could not be confirmed.'));
    expect(t.result.current.state.phase).toBe('blocked');
    expect(t.options.onComplete).not.toHaveBeenCalled();
    expect(paymentsApi.start).not.toHaveBeenCalled();
  });

  it('an unsent manual form survives unlock only after confirming no new payment exists', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale(), attempts: [] });
    vi.mocked(paymentsApi.start).mockResolvedValue({ route: 'manual', attempt: null, outstandingSatang: 54000, replayed: false,
      qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null });
    const t = mount();
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe('ready'));
    t.result.current.selectMethod('qr'); await t.result.current.submit();
    expect(t.result.current.state.phase).toBe('manual');
    t.rerender({ ...t.options, paused: true });
    t.rerender({ ...t.options, paused: false });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(t.result.current.state.phase).toBe('manual'));
    expect(t.result.current.state.method).toBe('qr');
    expect(paymentsApi.start).toHaveBeenCalledTimes(1);
  });

  it('the order scope keeps the customer/band but excludes the person at the till', () => {
    const a = { accountId: 'a', accountName: 'A', stationId: 's', memberId: 'family', bandHolder: 'child' };
    expect(paymentOrderIdentity(a)).toEqual(paymentOrderIdentity({ ...a, accountId: 'b', accountName: 'B' }));
    expect(paymentOrderIdentity(a)).not.toEqual(paymentOrderIdentity({ ...a, bandHolder: 'other-child' }));
  });
});
