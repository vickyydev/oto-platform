import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError, NetworkError } from '@/api/client';
import { paymentsApi, type PaymentAttemptRead, type PaymentCancelResult, type PaymentStartResult } from '@/api/payments';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * WALKING AWAY FROM A PENDING QR, through the payment stage every station
 * shares (the ticket till, the F&B and shop stations, the phone tills).
 *
 * A PromptPay QR on the display used to lock the stage until the gateway's own
 * expiry: no Back, no other method, no void. The stage now offers one way out
 * — `cancel()`, which goes to the platform — and only the platform's answer
 * moves it: back to "choose a payment method" with the sale still rung up and
 * unpaid, or the refusal in the platform's words with the attempt read back.
 * A tender on the card terminal is never offered it.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/payments')>();
  return {
    ...actual,
    paymentsApi: { start: vi.fn(), read: vi.fn(), inquire: vi.fn(), confirm: vi.fn(), manual: vi.fn(), cancel: vi.fn() },
  };
});

const start = vi.mocked(paymentsApi.start);
const read = vi.mocked(paymentsApi.read);
const cancel = vi.mocked(paymentsApi.cancel);
const unmounts: (() => void)[] = [];

const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
  { id: 'promptpay', kind: 'qr' as const, label: 'PromptPay', enabled: true, sortOrder: 2 },
];

const QR_PAYLOAD = '00020101021230370016A000000677010111011300660000000005802TH53037645406540.006304ABCD';

function attempt(over: Partial<PaymentAttemptView> = {}): PaymentAttemptView {
  return {
    id: 'qr-attempt-1', saleId: 'sale-1', method: 'qr', provider: 'simulator', status: 'sent_to_terminal',
    amountSatang: 54_000, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: 'OTOT01260925000001', tranRef: 'SIMABC', actionId: 'press:qr', offline: false,
    paidAt: null, createdAt: '2026-10-01T05:00:00.000Z', ...over,
  };
}

function shown(route: PaymentStartResult['route'] = 'gateway', over: Partial<PaymentAttemptView> = {}): PaymentStartResult {
  return {
    route, attempt: attempt(over), replayed: false, outstandingSatang: 54_000,
    qrPayload: route === 'gateway' ? QR_PAYLOAD : null, qrImageUrl: null,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), expiryTimerMs: 20 * 60_000,
  };
}

function cancelled(): PaymentCancelResult {
  return { attempt: attempt({ status: 'cancelled' }), replayed: false, outstandingSatang: 54_000 };
}

function readBack(over: Partial<PaymentAttemptView>, outstandingSatang: number): PaymentAttemptRead {
  return {
    route: 'gateway', attempt: attempt(over), qrPayload: QR_PAYLOAD, qrImageUrl: null,
    expiresAt: null, expiryTimerMs: null, deviceLabel: null, responseText: null, outstandingSatang,
  };
}

const outcome = (sale = apiSale(), extra: Partial<Extract<SaleWriteOutcome, { written: true }>> = {}): SaleWriteOutcome => ({
  ok: true, written: true, saleId: sale.id, sale, replay: false, ...extra,
});

function mount(totalSatang = 54_000) {
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
  const prepareSale = vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome());
  const finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
    .mockResolvedValue(outcome(apiSale({ status: 'finalised' }), { finalised: true, outstandingSatang: 0 }));
  const onComplete = vi.fn<PaymentStageOptions['onComplete']>();
  const onTenderCancelled = vi.fn<NonNullable<PaymentStageOptions['onTenderCancelled']>>();
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang, prepareSale, finaliseSale, onComplete, onTenderCancelled,
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options, prepareSale, finaliseSale, onComplete, onTenderCancelled };
}

/** Choose PromptPay and press "Show payment QR": the gateway's code is on the display. */
async function showQr(test: ReturnType<typeof mount>, route: PaymentStartResult['route'] = 'gateway') {
  start.mockResolvedValueOnce(shown(route));
  test.result.current.selectMethod('promptpay');
  await test.result.current.submit();
  expect(start).toHaveBeenCalledTimes(1);
  expect(test.result.current.state.phase).toBe('pending');
  expect(test.result.current.state.attempt?.id).toBe('qr-attempt-1');
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

describe('cancelling a pending gateway QR from the till', () => {
  it('a pending QR offers Cancel and not Back; the display shows the code', async () => {
    const test = mount();
    expect(test.result.current.canCancel).toBe(false);
    await showQr(test);
    expect(test.result.current.locked).toBe(true);
    expect(test.result.current.canBack).toBe(false);
    expect(test.result.current.canSubmit).toBe(false);
    expect(test.result.current.canCancel).toBe(true);
    expect(test.result.current.display).toMatchObject({ status: 'pending', qrPayload: QR_PAYLOAD, amountSatang: 54_000 });
  });

  it('the platform cancels it: back at "choose a payment method", the sale still rung up and unpaid, the display off the QR', async () => {
    const test = mount();
    await showQr(test);
    cancel.mockResolvedValueOnce(cancelled());

    const done = await test.result.current.cancel();
    expect(done).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]![0]).toBe('qr-attempt-1');
    expect(test.result.current.state).toMatchObject({
      phase: 'ready', method: null, kind: null, attempt: null, route: null, error: null, cancelRefusal: null,
      saleId: 'sale-1', outstandingSatang: 54_000, amountSatang: 54_000, tenderedSatang: 54_000, settlements: [],
    });
    expect(test.result.current.state.qr).toEqual({ qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null });
    // The customer display is back at the amount: nothing to scan, nothing pending.
    expect(test.result.current.display).toMatchObject({ status: 'idle', qrPayload: null, qrImageUrl: null, expiresAt: null, saleId: 'sale-1' });
    // Unlocked: Back leaves the step, a method can be chosen, and the station was told.
    expect(test.result.current.locked).toBe(false);
    expect(test.result.current.canBack).toBe(true);
    expect(test.result.current.canCancel).toBe(false);
    expect(test.onTenderCancelled).toHaveBeenCalledWith('sale-1');
    expect(test.onComplete).not.toHaveBeenCalled();
    expect(test.finaliseSale).not.toHaveBeenCalled();

    // The next tender starts from the same rung-up sale, not a new press of the QR.
    test.result.current.selectMethod('park-cash');
    expect(test.result.current.state).toMatchObject({ method: 'park-cash', kind: 'cash', phase: 'ready' });
    expect(test.result.current.canSubmit).toBe(true);
  });

  it('a second cancel is not sent: the stage has no QR to cancel', async () => {
    const test = mount();
    await showQr(test);
    cancel.mockResolvedValueOnce(cancelled());
    await test.result.current.cancel();
    expect(await test.result.current.cancel()).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('the platform refuses: its words stay on the card and the attempt is read back as it stands', async () => {
    const test = mount();
    await showQr(test);
    const words = 'This QR has been paid — the money is on the sale, so it is refunded rather than cancelled';
    cancel.mockRejectedValueOnce(new ApiError(409, 'ATTEMPT_ALREADY_PAID', words));
    read.mockResolvedValueOnce(readBack({ status: 'approved', paidAt: '2026-10-01T05:01:00.000Z' }, 0));

    const done = await test.result.current.cancel();
    expect(done).toBe(false);
    expect(read).toHaveBeenCalledWith('qr-attempt-1');
    // The guest paid as staff pressed Cancel: the money is counted and the sale closes as it would have.
    expect(test.result.current.state.cancelRefusal).toBe(words);
    expect(test.result.current.state.settlements).toEqual([
      expect.objectContaining({ attemptId: 'qr-attempt-1', method: 'promptpay', amountSatang: 54_000 }),
    ]);
    expect(test.finaliseSale).toHaveBeenCalledTimes(1);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onTenderCancelled).not.toHaveBeenCalled();
  });

  it('a refusal for a QR that now waits for a person blocks the stage, with the words kept', async () => {
    const test = mount();
    await showQr(test);
    const words = 'The gateway has reported a payment against this QR that a person has to look at — it cannot be cancelled';
    cancel.mockRejectedValueOnce(new ApiError(409, 'ATTEMPT_NEEDS_A_PERSON', words));
    read.mockResolvedValueOnce(readBack({ status: 'awaiting_staff_confirmation' }, 54_000));

    expect(await test.result.current.cancel()).toBe(false);
    expect(test.result.current.state.phase).toBe('blocked');
    expect(test.result.current.state.cancelRefusal).toBe(words);
    expect(test.result.current.state.attempt?.status).toBe('awaiting_staff_confirmation');
    expect(test.result.current.canCancel).toBe(false);
    expect(test.result.current.canBack).toBe(false);
    // Choosing another method is what clears the refusal — not a poll.
    expect(test.result.current.locked).toBe(true);
  });

  it('no answer from the platform leaves the QR pending and offers the safe retry', async () => {
    const test = mount();
    await showQr(test);
    cancel.mockRejectedValueOnce(new NetworkError());

    expect(await test.result.current.cancel()).toBe(false);
    expect(test.result.current.state.phase).toBe('blocked');
    expect(test.result.current.state.retryable).toBe(true);
    expect(test.result.current.state.attempt?.id).toBe('qr-attempt-1');
    expect(test.onTenderCancelled).not.toHaveBeenCalled();
    // The retry is the same cancel, under the same press.
    cancel.mockResolvedValueOnce(cancelled());
    await test.result.current.retry();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel.mock.calls[1]![1]).toBe(cancel.mock.calls[0]![1]);
    expect(test.result.current.state).toMatchObject({ phase: 'ready', attempt: null, method: null });
  });

  it('a tender on the card terminal is never offered the cancel', async () => {
    const test = mount();
    await showQr(test, 'card_terminal');
    expect(test.result.current.state.route).toBe('card_terminal');
    expect(test.result.current.canCancel).toBe(false);
    expect(await test.result.current.cancel()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(test.result.current.state.phase).toBe('pending');
  });

  it('a locked till offers no cancel until it is unlocked', async () => {
    const test = mount();
    await showQr(test);
    test.rerender({ ...test.options, paused: true });
    expect(test.result.current.canCancel).toBe(false);
    expect(await test.result.current.cancel()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });
});
