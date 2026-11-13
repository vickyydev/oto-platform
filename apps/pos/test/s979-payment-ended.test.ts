import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { api } from '@/api/client';
import { paymentsApi, type PaymentAttemptRead, type PaymentStartResult } from '@/api/payments';
import * as paymentMethods from '@/lib/payments';
import { PAYMENT_NOT_STARTED_SENTENCES } from '@/lib/paymentEnded';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * SCRUM-979 (points 1, 11, 12, 13) — THE PAYMENT STAGE AFTER A TENDER THAT
 * ENDED WITHOUT MONEY, on the stage every station shares (the ticket till,
 * F&B, Shop, the phone tills).
 *
 * The proof (docs/qa/proof-2026-11-13/SCRUM-972, pictures 02b, H3a, H3b): a
 * card payment the counter's box refused before the terminal was asked ended
 * "declined" with the platform's reason in `responseText`, and the till said
 * "Payment declined. Choose a payment method."; the display went on saying
 * "Paying by Card"; after a reload in that second nothing said it had ended.
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
const unmounts: (() => void)[] = [];
const NOT_READY = 'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.';
const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
  { id: 'promptpay', kind: 'qr' as const, label: 'PromptPay', enabled: true, sortOrder: 2 },
];

function attempt(over: Partial<PaymentAttemptView> = {}): PaymentAttemptView {
  return {
    id: 'card-attempt-1', saleId: 'sale-1', method: 'card', provider: 'digio', status: 'sent_to_terminal',
    amountSatang: 54_000, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: null, tranRef: null, actionId: 'press:card', offline: false,
    paidAt: null, createdAt: '2026-11-13T05:00:00.000Z', ...over,
  };
}
const started = (route: PaymentStartResult['route'] = 'card_terminal'): PaymentStartResult => ({
  route, attempt: attempt(), replayed: false, outstandingSatang: 54_000,
  qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null,
});
const readBack = (over: Partial<PaymentAttemptView>, responseText: string | null, route: PaymentAttemptRead['route'] = 'card_terminal'): PaymentAttemptRead => ({
  route, attempt: attempt(over), qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null,
  deviceLabel: 'ZZ TEST terminal', responseText, outstandingSatang: 54_000,
});
const outcome = (sale = apiSale()): SaleWriteOutcome => ({ ok: true, written: true, saleId: sale.id, sale, replay: false });

function mount(extra: Partial<PaymentStageOptions> = {}) {
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id || m.kind === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
  const onTenderEnded = vi.fn<NonNullable<PaymentStageOptions['onTenderEnded']>>();
  const onTenderCancelled = vi.fn<NonNullable<PaymentStageOptions['onTenderCancelled']>>();
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang: 54_000,
    prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome()),
    finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>().mockResolvedValue(outcome()),
    onComplete: vi.fn(), onTenderEnded, onTenderCancelled, ...extra,
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, onTenderEnded, onTenderCancelled };
}

/** Choose Card and press Start: the attempt is out, waiting for the terminal. */
async function pressCard(test: ReturnType<typeof mount>) {
  start.mockResolvedValueOnce(started());
  test.result.current.selectMethod('park-card');
  await test.result.current.submit();
  expect(test.result.current.state.phase, String(test.result.current.state.error)).toBe('pending');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.clearAllMocks();
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a card payment the terminal was never asked for (point 3)', () => {
  it('shows the platform’s reason in the place of "Payment declined", and the card reads not started', async () => {
    const test = mount();
    await pressCard(test);
    read.mockResolvedValue(readBack({ status: 'declined' }, NOT_READY));
    await vi.advanceTimersByTimeAsync(1_600);
    const state = test.result.current.state;
    expect(state.error).toBe(NOT_READY);
    expect(state.notStarted).toBe(true);
    expect(state.attempt?.status).toBe('declined');
    expect(state.phase).toBe('ready');
    expect(state.method).toBeNull();
    expect(test.result.current.locked).toBe(false);
  });

  it('every one of the platform’s sentences is read as not started', async () => {
    for (const sentence of PAYMENT_NOT_STARTED_SENTENCES) {
      const test = mount();
      await pressCard(test);
      read.mockResolvedValue(readBack({ status: 'declined' }, sentence));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(test.result.current.state.error).toBe(sentence);
      expect(test.result.current.state.notStarted).toBe(true);
      test.unmount();
    }
  });

  it('a real decline keeps today’s words exactly, whatever the terminal said', async () => {
    for (const words of [null, 'Bank error (code 05)', 'DECLINED']) {
      const test = mount();
      await pressCard(test);
      read.mockResolvedValue(readBack({ status: 'declined', terminalRef: 'POS0001' }, words));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(test.result.current.state.error).toBe('Payment declined. Choose a payment method.');
      expect(test.result.current.state.notStarted).toBe(false);
      test.unmount();
    }
  });

  it('choosing a method again clears the mark with the attempt', async () => {
    const test = mount();
    await pressCard(test);
    read.mockResolvedValue(readBack({ status: 'declined' }, NOT_READY));
    await vi.advanceTimersByTimeAsync(1_600);
    test.result.current.selectMethod('park-cash');
    expect(test.result.current.state).toMatchObject({ attempt: null, error: null, notStarted: false, method: 'park-cash' });
  });
});

describe('the station’s own copy of the method goes when a tender ends without money (point 4)', () => {
  it('declined, not started or real: the stage tells the station, once', async () => {
    const test = mount();
    await pressCard(test);
    read.mockResolvedValue(readBack({ status: 'declined' }, NOT_READY));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(test.onTenderEnded).toHaveBeenCalledTimes(1);
    expect(test.onTenderEnded).toHaveBeenCalledWith('sale-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.onTenderEnded).toHaveBeenCalledTimes(1);
  });

  it('a QR the gateway closed (cancelled) and a card not on the terminal end it too; a payment taken does not', async () => {
    for (const status of ['cancelled', 'not_found'] as const) {
      const test = mount();
      await pressCard(test);
      read.mockResolvedValue(readBack({ status }, null));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(test.onTenderEnded, status).toHaveBeenCalledTimes(1);
      expect(test.result.current.state.error).toBe(`Payment ${status.replaceAll('_', ' ')}. Choose a payment method.`);
      test.unmount();
    }
    const paid = mount();
    await pressCard(paid);
    read.mockResolvedValue({ ...readBack({ status: 'approved', paidAt: '2026-11-13T05:01:00.000Z' }, null), outstandingSatang: 0 });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(paid.onTenderEnded).not.toHaveBeenCalled();
  });

  it('still waiting for the terminal is not an end', async () => {
    const test = mount();
    await pressCard(test);
    read.mockResolvedValue(readBack({ status: 'sent_to_terminal' }, null));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(test.onTenderEnded).not.toHaveBeenCalled();
    expect(test.result.current.state.phase).toBe('pending');
  });
});

describe('a sale resumed after a reload whose last tender ended without money (point 5)', () => {
  const resume = async (last: PaymentAttemptView, responseText: string | null) => {
    vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale({ id: 'sale-1' }), attempts: [last] });
    read.mockResolvedValue({ ...readBack(last, responseText), attempt: last });
    const test = mount({ resumeSaleId: 'sale-1' });
    await vi.advanceTimersByTimeAsync(0);
    return test;
  };

  it('says the platform’s reason when the card was never sent', async () => {
    const test = await resume(attempt({ status: 'declined' }), NOT_READY);
    expect(test.result.current.state).toMatchObject({ phase: 'ready', error: NOT_READY, notStarted: true, method: null });
    expect(test.result.current.state.attempt?.id).toBe('card-attempt-1');
    expect(test.result.current.locked).toBe(false);
  });

  it('says today’s "Payment declined…" for a real decline, and "Payment cancelled…" for a cancelled QR', async () => {
    const real = await resume(attempt({ status: 'declined' }), 'Bank error (code 05)');
    expect(real.result.current.state).toMatchObject({ error: 'Payment declined. Choose a payment method.', notStarted: false });
    real.unmount();
    const qr = await resume(attempt({ status: 'cancelled', method: 'qr', provider: '2c2p' }), null);
    expect(qr.result.current.state.error).toBe('Payment cancelled. Choose a payment method.');
  });

  it('says nothing when the last tender took money, as before', async () => {
    const test = await resume(attempt({ status: 'approved', paidAt: '2026-11-13T05:01:00.000Z', amountSatang: 50_000 }), null);
    expect(test.result.current.state.error).toBeNull();
    expect(test.result.current.state.notStarted).toBeUndefined();
  });
});
