import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import { paymentsApi, type PaymentAttemptRead, type PaymentStartResult } from '@/api/payments';
import { salesApi } from '@/api/sales';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * SCRUM-878 — A PAYMENT WAITING ON THE CUSTOMER DISPLAY WHEN THE STAFF SESSION
 * ENDS.
 *
 * The till's payment stage is paused while the till is locked (`paused:
 * locked`), and a session that ends now leaves the till locked over the same
 * screen rather than unmounting it (`auth/OperatorContext.tsx`). So the stage
 * keeps the QR's attempt through the end, and at the next sign-in on that till
 * the unlock's own recovery reads the attempt's true state from the platform
 * and shows it. Proved here with the payment simulator's states: paid while
 * nobody was signed in (closed once, never charged again), declined or
 * cancelled (back to choosing a method, nothing taken), still waiting (it keeps
 * waiting), and an answer nobody knows (held for a person, nothing new taken).
 * The platform refusing the new read because the session is gone again is a
 * retryable hold, never a fresh charge.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/payments')>();
  return {
    ...actual,
    paymentsApi: { start: vi.fn(), read: vi.fn(), inquire: vi.fn(), confirm: vi.fn(), manual: vi.fn(), cancel: vi.fn() },
  };
});
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, salesApi: { ...actual.salesApi, get: vi.fn() } };
});

const start = vi.mocked(paymentsApi.start);
const read = vi.mocked(paymentsApi.read);
const getSale = vi.mocked(salesApi.get);
const unmounts: (() => void)[] = [];

const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
  { id: 'promptpay', kind: 'qr' as const, label: 'PromptPay', enabled: true, sortOrder: 2 },
];
const QR_PAYLOAD = '00020101021230370016A000000677010111011300660000000005802TH53037645406540.006304ABCD';

function attempt(over: Partial<PaymentAttemptView> = {}): PaymentAttemptView {
  return {
    id: 'qr-attempt-878', saleId: 'sale-1', method: 'qr', provider: 'simulator', status: 'sent_to_terminal',
    amountSatang: 54_000, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: 'OTOT01261112000878', tranRef: 'SIM878', actionId: 'press:qr', offline: false,
    paidAt: null, createdAt: '2026-11-12T13:25:00.000Z', ...over,
  };
}

function shown(): PaymentStartResult {
  return {
    route: 'gateway', attempt: attempt(), replayed: false, outstandingSatang: 54_000,
    qrPayload: QR_PAYLOAD, qrImageUrl: null,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), expiryTimerMs: 20 * 60_000,
  };
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

function mount() {
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
  const prepareSale = vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome());
  const finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
    .mockResolvedValue(outcome(apiSale({ status: 'finalised' }), { finalised: true, outstandingSatang: 0 }));
  const onComplete = vi.fn<PaymentStageOptions['onComplete']>();
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang: 54_000, prepareSale, finaliseSale, onComplete,
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options, prepareSale, finaliseSale, onComplete };
}

/** The QR on the customer display, then the session ends: the till locks over it (`paused`). */
async function qrWaitingWhenTheSessionEnds(test: ReturnType<typeof mount>) {
  start.mockResolvedValueOnce(shown());
  test.result.current.selectMethod('promptpay');
  await test.result.current.submit();
  expect(test.result.current.state.phase).toBe('pending');
  expect(test.result.current.display).toMatchObject({ status: 'pending', qrPayload: QR_PAYLOAD });
  // The minute's heartbeat is refused: the session has ended, the till locks over the sale.
  test.rerender({ ...test.options, paused: true });
  expect(test.result.current.state.attempt?.id).toBe('qr-attempt-878');
  expect(test.result.current.canSubmit).toBe(false);
  expect(test.result.current.canCancel).toBe(false);
}

/** The next sign-in on this till: the stage carries on and reads the attempt again. */
async function signedInAgain(test: ReturnType<typeof mount>) {
  test.rerender({ ...test.options, paused: false });
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await vi.waitFor(() => expect(test.result.current.state.phase).not.toBe('busy'));
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SCRUM-878 — a QR waiting on the display when the session ends', () => {
  it('paid while nobody was signed in: read back as paid, the sale closed once, nothing charged again', async () => {
    const test = mount();
    await qrWaitingWhenTheSessionEnds(test);
    getSale.mockResolvedValue({ sale: apiSale() });
    read.mockResolvedValue(readBack({ status: 'approved', paidAt: '2026-11-12T13:31:00.000Z' }, 0));

    await signedInAgain(test);
    await vi.waitFor(() => expect(test.result.current.state.phase).toBe('complete'));
    expect(getSale).toHaveBeenCalledWith('sale-1');
    expect(read.mock.calls.every(([id]) => id === 'qr-attempt-878')).toBe(true);
    // One QR, never a second one; the close carries no new tender.
    expect(start).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale.mock.calls[0]![0]).toBeUndefined();
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.result.current.state.settlements).toHaveLength(1);
    expect(test.result.current.state.settlements[0]).toMatchObject({ attemptId: 'qr-attempt-878', amountSatang: 54_000 });
    expect(test.result.current.display.status).toBe('paid');
  });

  it.each(['declined', 'cancelled'] as const)('%s on the simulator: back to choosing a method, the sale still owed, nothing taken', async (status) => {
    const test = mount();
    await qrWaitingWhenTheSessionEnds(test);
    getSale.mockResolvedValue({ sale: apiSale() });
    read.mockResolvedValue(readBack({ status }, 54_000));

    await signedInAgain(test);
    await vi.waitFor(() => expect(test.result.current.state.phase).toBe('ready'));
    expect(test.result.current.state.error).toBe(`Payment ${status}. Choose a payment method.`);
    expect(test.result.current.state.outstandingSatang).toBe(54_000);
    expect(test.result.current.state.settlements).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(test.onComplete).not.toHaveBeenCalled();
  });

  it('still waiting on the simulator: the QR stays up and the till keeps asking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const test = mount();
    await qrWaitingWhenTheSessionEnds(test);
    getSale.mockResolvedValue({ sale: apiSale() });
    read.mockResolvedValue(readBack({ status: 'sent_to_terminal' }, 54_000));

    test.rerender({ ...test.options, paused: false });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.result.current.state.phase).toBe('pending');
    expect(test.result.current.display).toMatchObject({ status: 'pending', qrPayload: QR_PAYLOAD });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(test.onComplete).not.toHaveBeenCalled();
  });

  it('an answer nobody knows: held for a person, nothing new taken', async () => {
    const test = mount();
    await qrWaitingWhenTheSessionEnds(test);
    getSale.mockResolvedValue({ sale: apiSale() });
    read.mockResolvedValue(readBack({ status: 'unknown' }, 54_000));

    await signedInAgain(test);
    await vi.waitFor(() => expect(test.result.current.state.phase).toBe('blocked'));
    expect(test.result.current.state.attempt?.status).toBe('unknown');
    expect(test.result.current.canSubmit).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale).not.toHaveBeenCalled();
  });

  describe('a different person signs in and is offered the rung-up sale (continue only), then continues it', () => {
    it('approved on the simulator in the gap: nothing is read until Continue, then it is closed once and nothing charged again', async () => {
      const test = mount();
      await qrWaitingWhenTheSessionEnds(test);
      // Signed in and shown the offer: the till stays locked over the sale, so
      // the stage stays paused, keeps the attempt and reads nothing yet.
      getSale.mockResolvedValue({ sale: apiSale() });
      read.mockResolvedValue(readBack({ status: 'approved', paidAt: '2026-11-12T13:31:00.000Z' }, 0));
      test.rerender({ ...test.options, paused: true });
      expect(read).not.toHaveBeenCalled();
      expect(getSale).not.toHaveBeenCalled();
      expect(test.result.current.state.attempt?.id).toBe('qr-attempt-878');

      // Continue this sale.
      await signedInAgain(test);
      await vi.waitFor(() => expect(test.result.current.state.phase).toBe('complete'));
      expect(start).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale.mock.calls[0]![0]).toBeUndefined();
      expect(test.onComplete).toHaveBeenCalledTimes(1);
      expect(test.result.current.state.settlements).toHaveLength(1);
      expect(test.result.current.display.status).toBe('paid');
    });

    it('still pending on the simulator: the QR stays up, nothing new is started, and Cancel is offered only once it is read back', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const test = mount();
      await qrWaitingWhenTheSessionEnds(test);
      getSale.mockResolvedValue({ sale: apiSale() });
      read.mockResolvedValue(readBack({ status: 'sent_to_terminal' }, 54_000));
      // While the offer is up: no Cancel, no new payment.
      expect(test.result.current.canCancel).toBe(false);
      expect(test.result.current.canSubmit).toBe(false);

      // Continue this sale.
      test.rerender({ ...test.options, paused: false });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(test.result.current.state.phase).toBe('pending');
      expect(test.result.current.display).toMatchObject({ status: 'pending', qrPayload: QR_PAYLOAD });
      // The till's own Cancel now cancels the waiting QR, after the read.
      expect(test.result.current.canCancel).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(test.onComplete).not.toHaveBeenCalled();
    });
  });

  describe('a CARD attempt waiting on the terminal when the session ends', () => {
    const CARD: Partial<PaymentAttemptView> = {
      id: 'card-attempt-878', method: 'card', tranRef: null, invoiceNo: 'OTOT01261112000879', actionId: 'press:card',
    };
    function cardSent(): PaymentStartResult {
      return { route: 'card_terminal', attempt: attempt({ ...CARD }), replayed: false, outstandingSatang: 54_000,
        qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null };
    }
    const cardReadBack = (over: Partial<PaymentAttemptView>, outstandingSatang: number): PaymentAttemptRead => ({
      ...readBack({ ...CARD, ...over }, outstandingSatang), route: 'card_terminal', qrPayload: null,
    });

    /** The card machine is asked for the money, then the session ends: the till locks over it. */
    async function cardWaitingWhenTheSessionEnds(test: ReturnType<typeof mount>) {
      start.mockResolvedValueOnce(cardSent());
      test.result.current.selectMethod('park-card');
      await test.result.current.submit();
      expect(test.result.current.state.route).toBe('card_terminal');
      expect(test.result.current.state.attempt?.id).toBe('card-attempt-878');
      test.rerender({ ...test.options, paused: true });
      expect(test.result.current.state.attempt?.id).toBe('card-attempt-878');
      expect(test.result.current.canSubmit).toBe(false);
      expect(test.result.current.canCancel).toBe(false);
    }

    it('approved on the terminal while nobody was signed in: read back as paid, the sale closed once, the card never asked again', async () => {
      const test = mount();
      await cardWaitingWhenTheSessionEnds(test);
      getSale.mockResolvedValue({ sale: apiSale() });
      read.mockResolvedValue(cardReadBack({ status: 'approved', paidAt: '2026-11-12T13:31:00.000Z', approvalCode: 'ZZ0878', last4: '0878' }, 0));

      await signedInAgain(test);
      await vi.waitFor(() => expect(test.result.current.state.phase).toBe('complete'));
      expect(read.mock.calls.every(([id]) => id === 'card-attempt-878')).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale.mock.calls[0]![0]).toBeUndefined();
      expect(test.onComplete).toHaveBeenCalledTimes(1);
      expect(test.result.current.state.settlements).toHaveLength(1);
      expect(test.result.current.state.settlements[0]).toMatchObject({ attemptId: 'card-attempt-878', amountSatang: 54_000 });
    });

    it('declined on the terminal: back to choosing a method, the sale still owed, nothing taken', async () => {
      const test = mount();
      await cardWaitingWhenTheSessionEnds(test);
      getSale.mockResolvedValue({ sale: apiSale() });
      read.mockResolvedValue(cardReadBack({ status: 'declined' }, 54_000));

      await signedInAgain(test);
      await vi.waitFor(() => expect(test.result.current.state.phase).toBe('ready'));
      expect(test.result.current.state.error).toBe('Payment declined. Choose a payment method.');
      expect(test.result.current.state.outstandingSatang).toBe(54_000);
      expect(test.result.current.state.settlements).toEqual([]);
      expect(start).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale).not.toHaveBeenCalled();
    });

    it('a different person continues it with the terminal still waiting: nothing read before Continue, nothing new started after', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const test = mount();
      await cardWaitingWhenTheSessionEnds(test);
      getSale.mockResolvedValue({ sale: apiSale() });
      read.mockResolvedValue(cardReadBack({ status: 'sent_to_terminal' }, 54_000));
      // The offer is up: the till stays locked over the sale, so nothing is read and nothing offered.
      expect(read).not.toHaveBeenCalled();
      expect(test.result.current.canCancel).toBe(false);
      expect(test.result.current.canSubmit).toBe(false);

      // Continue this sale.
      test.rerender({ ...test.options, paused: false });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(test.result.current.state.attempt?.id).toBe('card-attempt-878');
      expect(test.result.current.state.attempt?.status).toBe('sent_to_terminal');
      expect(test.result.current.canSubmit).toBe(false);
      await vi.advanceTimersByTimeAsync(1_600);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(test.onComplete).not.toHaveBeenCalled();
    });
  });

  it('the read refused again (no session yet): a hold to retry, never a fresh charge', async () => {
    const test = mount();
    await qrWaitingWhenTheSessionEnds(test);
    getSale.mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'Not signed in'));

    test.rerender({ ...test.options, paused: false });
    await vi.waitFor(() => expect(getSale).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(test.result.current.state.phase).not.toBe('busy'));
    expect(['blocked', 'failed']).toContain(test.result.current.state.phase);
    expect(test.result.current.state.attempt?.id).toBe('qr-attempt-878');
    expect(test.result.current.canSubmit).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
