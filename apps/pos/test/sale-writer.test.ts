import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { api, ApiError, NetworkError } from '@/api/client';
import { paymentsApi } from '@/api/payments';
import type { PaymentAttemptView } from '@oto/shared';
import {
  commitSale,
  finaliseSale,
  NO_TENDER,
  salesApi,
  SalesLedgerUnavailable,
  type CommitSaleArgs,
  type SaleCartPayload,
  type SaleCommitResult,
  type SaleFinaliseResult,
  type SaleTenderPayload,
} from '@/api/sales';
import { useSaleWriter, type SaleWriteInput } from '@/lib/saleWriter';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import * as paymentMethods from '@/lib/payments';
import type { PaymentAttemptRead } from '@/api/payments';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import { CANCELLED_AT_THE_TILL } from '@/lib/tillVoucher';

/**
 * WRITING THE SALE — `lib/saleWriter.ts` (S2-09a, SCRUM-203; S2-10b).
 *
 *   1. Pressing Pay twice produces one sale.
 *   2. A corrected cart is a different sale.
 *   3. A failure is visible, and says which kind it is.
 *   4. An answer never lands on a till that has moved on.
 *
 * The hook runs on the harness in place of React (support/hooks.ts). The calls
 * that reach the platform — `commitSale`, `finaliseSale`, `salesApi.get` and
 * `salesApi.voidSale` — answer as each test says; everything else in
 * `api/sales.ts`, `SalesLedgerUnavailable` included, is the till's own.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return {
    ...actual,
    commitSale: vi.fn(),
    finaliseSale: vi.fn(),
    salesApi: { ...actual.salesApi, get: vi.fn(), voidSale: vi.fn() },
  };
});

const commit = vi.mocked(commitSale);
const finalise = vi.mocked(finaliseSale);
const getSale = vi.mocked(salesApi.get);
const voidSale = vi.mocked(salesApi.voidSale);
const paymentUnmounts: (() => void)[] = [];

/** A walk-in's cart of `kids` one-hour tickets, as the till sends it. */
function cart(kids: number): SaleCartPayload {
  return {
    branchId: 'branch-1',
    stationId: 'station-1',
    channel: 'till',
    tier: 'tourist',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' },
    lines: [
      {
        id: 'line-1',
        packageId: 'package-1h',
        packageName: '1 Hour Play',
        tier: 'tourist',
        kids,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotalSatang: 69_000 * kids,
      },
    ],
    promos: [],
    manualDiscounts: [],
    expectedTotalSatang: 69_000 * kids,
  };
}

function order(kids: number, extra: Partial<SaleWriteInput> = {}): SaleWriteInput {
  return { cart: cart(kids), finalise: false, ...extra };
}

/** What each commit was sent under, in order. */
const sent = (): CommitSaleArgs[] => commit.mock.calls.map(([args]) => args);

function mountWriter() {
  return renderHook(() => useSaleWriter());
}

const cashPart: SaleTenderPayload = {
  method: 'park-cash', kind: 'cash', amountSatang: 27_000,
  tenderedSatang: 27_000, changeSatang: 0,
};

function cashAttempt(saleId: string): PaymentAttemptView {
  return {
    id: 'attempt-first-part', saleId, method: 'cash', provider: 'manual', status: 'approved',
    amountSatang: 27_000, tenderedSatang: 27_000, changeSatang: 0,
    terminalRef: null, tid: null, approvalCode: null, last4: null,
    invoiceNo: null, tranRef: null, actionId: 'first-part', offline: false,
    paidAt: '2026-09-25T04:20:00.000Z', createdAt: '2026-09-25T04:20:00.000Z',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-25T04:00:00.000Z'));
  commit.mockImplementation(async (args) => ({ sale: apiSale({ id: args.saleId }), replay: false }));
  voidSale.mockImplementation(async (saleId: string, reason: string) => ({
    replay: false,
    sale: apiSale({ id: saleId, status: 'voided' }),
    void: { voidedAt: '2026-09-25T04:20:00.000Z', voidedByAccountId: 'account-1', reason },
    releasedVoucherIds: [],
  }));
});

afterEach(() => {
  paymentUnmounts.splice(0).forEach((unmount) => unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('pressing Pay twice produces one sale', () => {
  it('joins a press to the one still going out: one request, one answer', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();

    const first = result.current.commit(order(1));
    const second = result.current.commit(order(1));
    expect(commit).toHaveBeenCalledTimes(1);

    answer({ sale: apiSale({ id: sent()[0]!.saleId }), replay: false });
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ ok: true, written: true, saleId: sent()[0]!.saleId });
  });

  it('retries a press that got no answer under the same sale id, action id and clock reading', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(new NetworkError(new TypeError('Failed to fetch')));

    const failed = await result.current.commit(order(1));
    expect(failed).toEqual({
      ok: false,
      saleId: sent()[0]!.saleId,
      message: 'No answer from the platform. This screen has no connection.',
      retryable: true,
    });
    expect(result.current.state).toMatchObject({ kind: 'failed', stage: 'commit', cause: 'connection', retryable: true });

    vi.setSystemTime(new Date('2026-09-25T04:05:00.000Z')); // five minutes on, still the same sale
    await result.current.commit(order(1));
    const [one, two] = sent();
    expect(two).toEqual(one);
    expect(two!.occurredAt).toBe('2026-09-25T04:00:00.000Z');
  });

  it('does not ask twice when the sale is already on the platform: Confirm after Pay reads the answer in hand', async () => {
    const { result } = mountWriter();
    const paid = await result.current.commit(order(1));
    const again = await result.current.commit(order(1));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ ...paid, replay: true });
    expect(result.current.state).toMatchObject({ kind: 'committed', saleId: sent()[0]!.saleId });
    expect(result.current.committed?.id).toBe(sent()[0]!.saleId);
  });
});

describe('a corrected cart is a different sale', () => {
  it('gives a changed order new ids, and Cancel voids the sale it was rung up as before', async () => {
    const { result } = mountWriter();
    const first = await result.current.commit(order(1));
    const corrected = await result.current.commit(order(2));

    const [a, b] = sent();
    expect(b!.saleId).not.toBe(a!.saleId);
    expect(b!.actionId).not.toBe(a!.actionId);
    expect(result.current.ownsSale(first.saleId)).toBe(true);

    await expect(result.current.cancel(CANCELLED_AT_THE_TILL)).resolves.toEqual({ ok: true, voided: true });
    // The one left behind first; the one on screen last, so a refusal about it is what shows.
    expect(voidSale.mock.calls).toEqual([
      [first.saleId, CANCELLED_AT_THE_TILL],
      [corrected.saleId, CANCELLED_AT_THE_TILL],
    ]);
  });

  it('takes a new number for the same cart when its key was spent on another body, keeping the press', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Key reused with a different body'));

    const failed = await result.current.commit(order(1));
    expect(failed).toMatchObject({ ok: false, retryable: true });
    expect(result.current.state).toMatchObject({ kind: 'failed', cause: 'stale-key', code: 'IDEMPOTENCY_MISMATCH' });

    await result.current.commit(order(1));
    const [a, b] = sent();
    expect(b!.saleId).not.toBe(a!.saleId);
    expect(b!.actionId).toBe(a!.actionId); // the platform still refuses a second sale for one press
    expect(b!.occurredAt).toBe(a!.occurredAt);
  });

  it('takes a new number when the platform says the voucher is not held for this sale, which the key would replay', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(
      new ApiError(409, 'VOUCHER_NOT_HELD', 'Scan the voucher at this till first — it is not held for this sale'),
    );
    const failed = await result.current.commit(order(1));
    expect(failed).toMatchObject({ ok: false, retryable: false });

    const next = result.current.prepare(order(1));
    expect(next).not.toBe(sent()[0]!.saleId);
    await result.current.commit(order(1));
    expect(sent()[1]).toMatchObject({ saleId: next, actionId: sent()[0]!.actionId });
  });

  it('keeps the number while the platform is still working on the first attempt', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_IN_FLIGHT', 'Still working on it'));
    const failed = await result.current.commit(order(1));
    expect(failed).toMatchObject({ ok: false, retryable: true });
    expect(result.current.state).toMatchObject({ cause: 'in-flight' });
    await result.current.commit(order(1));
    expect(sent()[1]!.saleId).toBe(sent()[0]!.saleId);
  });
});

describe('a failure says which kind it is', () => {
  it.each([
    ['the platform judging the cart', new ApiError(422, 'SALE_LINE_PRICE_MISMATCH', 'The price moved'), 'refused', false],
    ['the platform faulting', new ApiError(500, 'INTERNAL', 'Something broke'), 'connection', true],
    ["a proxy's page", new ApiError(502, 'UNKNOWN', 'Bad Gateway'), 'connection', true],
    ['something unexpected', new Error('boom'), 'connection', true],
  ] as const)('%s', async (_label, error, cause, retryable) => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(error);
    const failed = await result.current.commit(order(1));
    expect(failed).toEqual({ ok: false, saleId: sent()[0]!.saleId, message: error.message, retryable });
    expect(result.current.state).toMatchObject({ kind: 'failed', stage: 'commit', cause, retryable });
  });

  it('adopts the sale a press already produced under a number the till gave up on', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(
      new ApiError(409, 'SALE_ACTION_REPLAY', 'This press already made a sale', { saleId: 'sale-of-this-press' }),
    );
    getSale.mockResolvedValueOnce({ sale: apiSale({ id: 'sale-of-this-press' }) });

    const outcome = await result.current.commit(order(1));
    expect(outcome).toEqual({
      ok: true,
      written: true,
      sale: expect.objectContaining({ id: 'sale-of-this-press' }),
      replay: true,
      saleId: 'sale-of-this-press',
    });
    expect(result.current.state).toMatchObject({ kind: 'committed', saleId: 'sale-of-this-press' });
    expect(result.current.ownsSale('sale-of-this-press')).toBe(true);
  });

  it('says the sale stands on this till alone when the deployment has no ledger', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(new SalesLedgerUnavailable());
    const outcome = await result.current.commit(order(1));
    expect(outcome).toEqual({
      ok: true,
      written: false,
      saleId: sent()[0]!.saleId,
      reason: 'This deployment has no sales ledger yet (SCRUM-203).',
    });
    expect(result.current.state).toMatchObject({ kind: 'unwritten' });
  });
});

describe('the sale id a voucher is held for (S2-10b)', () => {
  it('writes a new cart under the id its voucher is held for, and says so before Pay', async () => {
    const { result } = mountWriter();
    expect(result.current.prepare(order(1, { preferSaleId: 'sale-held-for-the-voucher' }))).toBe(
      'sale-held-for-the-voucher',
    );
    await result.current.commit(order(1, { preferSaleId: 'sale-held-for-the-voucher' }));
    expect(sent()[0]!.saleId).toBe('sale-held-for-the-voucher');
  });

  it('never reuses an id an attempt was already sent under: its key is spent', async () => {
    const { result } = mountWriter();
    commit.mockRejectedValueOnce(new ApiError(422, 'SALE_LINE_PRICE_MISMATCH', 'The price moved'));
    await result.current.commit(order(1, { preferSaleId: 'sale-held-for-the-voucher' }));

    const corrected = result.current.prepare(order(2, { preferSaleId: 'sale-held-for-the-voucher' }));
    expect(corrected).not.toBe('sale-held-for-the-voucher');
    await result.current.commit(order(2, { preferSaleId: 'sale-held-for-the-voucher' }));
    expect(sent()[1]!.saleId).toBe(corrected);
  });
});

describe("whether a sale is this screen's own (audit M12)", () => {
  it('owns the sales it sent, left behind or has on screen, and no other', async () => {
    const { result } = mountWriter();
    const first = await result.current.commit(order(1));
    const second = await result.current.commit(order(2));
    expect(result.current.ownsSale(first.saleId)).toBe(true);
    expect(result.current.ownsSale(second.saleId)).toBe(true);
    expect(result.current.ownsSale('sale-rung-up-on-another-screen')).toBe(false);

    result.current.reset();
    expect(result.current.ownsSale(first.saleId)).toBe(false);
  });
});

describe('closing the sale', () => {
  it("closes it under the press's action id, and never asks for a second receipt number", async () => {
    const { result } = mountWriter();
    const paid = await result.current.commit(order(1));
    finalise.mockResolvedValueOnce({ sale: apiSale({ id: paid.saleId, status: 'finalised' }), replay: false });

    await expect(result.current.finalise(NO_TENDER)).resolves.toMatchObject({ ok: true, written: true });
    expect(finalise).toHaveBeenCalledWith(paid.saleId, sent()[0]!.actionId, NO_TENDER);
    expect(result.current.state).toMatchObject({ kind: 'written', saleId: paid.saleId });

    await expect(result.current.finalise(NO_TENDER)).resolves.toMatchObject({ ok: true, replay: true });
    expect(finalise).toHaveBeenCalledTimes(1);
  });

  it('refuses to take money for a sale nothing recorded', async () => {
    const { result } = mountWriter();
    await expect(result.current.finalise(NO_TENDER)).resolves.toEqual({
      ok: false,
      saleId: '',
      message: 'There is no recorded sale to close — record it before taking the money.',
      retryable: false,
    });
    expect(finalise).not.toHaveBeenCalled();
  });

  it('keeps an accepted split part open until the distinct second tender closes it', async () => {
    const { result } = mountWriter();
    const recorded = await result.current.commit(order(1));
    const firstAttempt = cashAttempt(recorded.saleId);
    const partial = apiSale({ id: recorded.saleId });
    finalise.mockResolvedValueOnce({
      sale: partial, replay: false, finalised: false,
      outstandingSatang: 27_000, attempt: firstAttempt,
    });

    await expect(result.current.finalise(cashPart, 'first-part')).resolves.toMatchObject({
      ok: true, written: true, finalised: false, sale: partial,
      outstandingSatang: 27_000, attempt: firstAttempt,
    });
    expect(result.current.state).toEqual({ kind: 'committed', saleId: recorded.saleId, sale: partial });
    expect(result.current.committed?.receiptNumber).toBeUndefined();

    const closed = apiSale({ id: recorded.saleId, status: 'finalised', receiptNumber: 'PARK-1' });
    finalise.mockResolvedValueOnce({ sale: closed, replay: false, finalised: true, outstandingSatang: 0 });
    await expect(result.current.finalise(cashPart, 'second-part')).resolves.toMatchObject({
      ok: true, finalised: true, outstandingSatang: 0, sale: closed,
    });
    expect(finalise.mock.calls).toEqual([
      [recorded.saleId, 'first-part', cashPart],
      [recorded.saleId, 'second-part', cashPart],
    ]);
    expect(result.current.state).toMatchObject({ kind: 'written', sale: closed });
  });

  it('retries one deliberate tender with the same explicit identity and body', async () => {
    const { result } = mountWriter();
    const recorded = await result.current.commit(order(1));
    finalise.mockRejectedValueOnce(new NetworkError(new Error('No answer')));
    finalise.mockResolvedValueOnce({
      sale: apiSale({ id: recorded.saleId }), replay: true, finalised: false, outstandingSatang: 27_000,
    });

    await expect(result.current.finalise(cashPart, 'first-part')).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(result.current.finalise(cashPart, 'first-part')).resolves.toMatchObject({ ok: true, finalised: false });
    expect(finalise.mock.calls).toEqual([
      [recorded.saleId, 'first-part', cashPart],
      [recorded.saleId, 'first-part', cashPart],
    ]);
    expect(result.current.state).toMatchObject({ kind: 'committed' });
  });

  it('keeps the legacy action across retries and passes no new tender for close', async () => {
    const { result } = mountWriter();
    const recorded = await result.current.commit(order(1));
    finalise.mockRejectedValueOnce(new NetworkError(new Error('No answer')));
    finalise.mockResolvedValueOnce({ sale: apiSale({ id: recorded.saleId, status: 'finalised' }), replay: true });

    await result.current.finalise();
    await expect(result.current.finalise()).resolves.toMatchObject({ ok: true, finalised: true });
    expect(finalise.mock.calls).toEqual([
      [recorded.saleId, sent()[0]!.actionId, undefined],
      [recorded.saleId, sent()[0]!.actionId, undefined],
    ]);
  });

  it('derives an open response from the sale status when old metadata is absent', async () => {
    const { result } = mountWriter();
    const recorded = await result.current.commit(order(1));
    finalise.mockResolvedValueOnce({ sale: apiSale({ id: recorded.saleId }), replay: false });
    await expect(result.current.finalise(cashPart)).resolves.toMatchObject({ ok: true, finalised: false });
    expect(result.current.state).toMatchObject({ kind: 'committed' });
  });
});

describe("the till's Cancel", () => {
  it('waits for a Pay still being written, then voids the sale it wrote', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();

    const paying = result.current.commit(order(1));
    const cancelling = result.current.cancel(CANCELLED_AT_THE_TILL);
    await Promise.resolve();
    expect(voidSale).not.toHaveBeenCalled();

    answer({ sale: apiSale({ id: sent()[0]!.saleId }), replay: false });
    await paying;
    await expect(cancelling).resolves.toEqual({ ok: true, voided: true });
    expect(voidSale).toHaveBeenCalledWith(sent()[0]!.saleId, CANCELLED_AT_THE_TILL);
  });

  it('voids nothing when nothing was rung up', async () => {
    const { result } = mountWriter();
    await expect(result.current.cancel(CANCELLED_AT_THE_TILL)).resolves.toEqual({ ok: true, voided: false });
    expect(voidSale).not.toHaveBeenCalled();
  });

  it('does not void a finalised sale: a closed sale is refunded', async () => {
    const { result } = mountWriter();
    const paid = await result.current.commit(order(1));
    finalise.mockResolvedValueOnce({ sale: apiSale({ id: paid.saleId, status: 'finalised' }), replay: false });
    await result.current.finalise(NO_TENDER);

    await expect(result.current.cancel(CANCELLED_AT_THE_TILL)).resolves.toEqual({
      ok: false,
      code: 'SALE_FINALISED',
      message: 'This sale is finalised — a closed sale is refunded, not voided',
      closed: true,
    });
    expect(voidSale).not.toHaveBeenCalled();
  });

  it("reports a void the platform refuses in the platform's words", async () => {
    const { result } = mountWriter();
    await result.current.commit(order(1));
    voidSale.mockRejectedValueOnce(new ApiError(409, 'SALE_HAS_PAYMENTS', 'Money has been taken for this sale'));
    await expect(result.current.cancel(CANCELLED_AT_THE_TILL)).resolves.toEqual({
      ok: false,
      code: 'SALE_HAS_PAYMENTS',
      message: 'Money has been taken for this sale',
      closed: false,
    });
  });
});

describe('an answer never lands on a till that has moved on', () => {
  it('drops the answer to a Pay made before the till moved on, and the next cart is a new sale', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();

    const paying = result.current.commit(order(1));
    result.current.reset();
    answer({ sale: apiSale({ id: sent()[0]!.saleId }), replay: false });
    // The write still happened, and the caller that pressed Pay is told so …
    await expect(paying).resolves.toMatchObject({ ok: true, written: true });
    // … but none of it is drawn onto the till now.
    expect(result.current.state).toEqual({ kind: 'idle' });
    expect(result.current.committed).toBeNull();

    await result.current.commit(order(1));
    expect(sent()[1]!.saleId).not.toBe(sent()[0]!.saleId);
    // The sale rung up before the till moved on is not this cart's: its Cancel voids this one alone.
    expect(result.current.ownsSale(sent()[0]!.saleId)).toBe(false);
    await expect(result.current.cancel(CANCELLED_AT_THE_TILL)).resolves.toEqual({ ok: true, voided: true });
    expect(voidSale.mock.calls).toEqual([[sent()[1]!.saleId, CANCELLED_AT_THE_TILL]]);
  });

  it('shows no failure from a Pay made before the till moved on', async () => {
    let refuse!: (error: unknown) => void;
    commit.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    const { result } = mountWriter();
    const paying = result.current.commit(order(1));
    result.current.reset();
    refuse(new ApiError(422, 'SALE_LINE_PRICE_MISMATCH', 'The price moved'));
    await paying;
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('keeps the new cart when an earlier commit answers without a reset', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();
    const earlier = result.current.commit(order(1));
    const current = await result.current.commit(order(2));

    answer({ sale: apiSale({ id: sent()[0]!.saleId }), replay: false });
    await earlier;
    expect(result.current.state).toMatchObject({ kind: 'committed', saleId: current.saleId });
    expect(result.current.committed?.id).toBe(current.saleId);
  });

  it('does not lend an old pending cart the newly prepared cart id', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();
    const earlier = result.current.commit(order(1));
    const newCartId = result.current.prepare(order(2));
    const returnedCartId = result.current.prepare(order(1));
    expect(returnedCartId).not.toBe(newCartId);
    expect(returnedCartId).not.toBe(sent()[0]!.saleId);

    answer({ sale: apiSale({ id: sent()[0]!.saleId }), replay: false });
    await earlier;
    expect(result.current.committed).toBeNull();
  });

  it('drops a late finalise success after reset, while telling its original caller the outcome', async () => {
    let answer!: (result: SaleFinaliseResult) => void;
    finalise.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();
    const recorded = await result.current.commit(order(1));
    const closing = result.current.finalise(cashPart, 'first-part');
    result.current.reset();

    answer({ sale: apiSale({ id: recorded.saleId, status: 'finalised' }), replay: false, finalised: true });
    await expect(closing).resolves.toMatchObject({ ok: true, finalised: true });
    expect(result.current.state).toEqual({ kind: 'idle' });
    expect(result.current.committed).toBeNull();
  });

  it('drops finalise success and failure from a replaced cart without a reset', async () => {
    let answer!: (result: SaleFinaliseResult) => void;
    let refuse!: (error: unknown) => void;
    finalise.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    finalise.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    const { result } = mountWriter();
    const first = await result.current.commit(order(1));
    const closingFirst = result.current.finalise(cashPart, 'first-part');
    const second = await result.current.commit(order(2));
    const closingSecond = result.current.finalise(cashPart, 'second-part');
    const current = await result.current.commit(order(3));

    answer({ sale: apiSale({ id: first.saleId, status: 'finalised' }), replay: false, finalised: true });
    refuse(new ApiError(409, 'PAYMENT_IN_FLIGHT', 'A payment is still in progress'));
    await Promise.all([closingFirst, closingSecond]);
    expect(second.saleId).not.toBe(current.saleId);
    expect(result.current.state).toMatchObject({ kind: 'committed', saleId: current.saleId });
    expect(result.current.committed?.id).toBe(current.saleId);
  });

  it('does not adopt a replayed sale after the screen unmounts', async () => {
    let answer!: (result: { sale: ReturnType<typeof apiSale> }) => void;
    commit.mockRejectedValueOnce(new ApiError(409, 'SALE_ACTION_REPLAY', 'Already rung up', { saleId: 'previous-sale' }));
    getSale.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result, unmount } = mountWriter();
    const writing = result.current.commit(order(1));
    await Promise.resolve();
    expect(getSale).toHaveBeenCalledWith('previous-sale');
    unmount();

    answer({ sale: apiSale({ id: 'previous-sale' }) });
    await writing;
    expect(result.current.ownsSale('previous-sale')).toBe(false);
    expect(result.current.committed).toBeNull();
  });

  it('does not let an earlier Cancel void the next cart after reset', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountWriter();
    const writing = result.current.commit(order(1));
    const cancelling = result.current.cancel(CANCELLED_AT_THE_TILL);
    result.current.reset();
    const current = await result.current.commit(order(2));

    answer({ sale: apiSale({ id: sent()[0]!.saleId }), replay: false });
    await writing;
    await expect(cancelling).resolves.toEqual({ ok: true, voided: false });
    expect(voidSale).not.toHaveBeenCalled();
    expect(result.current.committed?.id).toBe(current.saleId);
  });
});

describe('payment request identities', () => {
  const qr = { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null };
  const attempt = (status: PaymentAttemptView['status'], extra: Partial<PaymentAttemptView> = {}): PaymentAttemptView => ({
    ...cashAttempt('sale-1'), id: 'electronic-attempt', method: 'card', provider: 'digio',
    amountSatang: 54_000, terminalRef: '990206', status, ...extra,
  });
  const read = (value: PaymentAttemptView, balance: number): PaymentAttemptRead => ({
    ...qr, attempt: value, deviceLabel: null, responseText: null, outstandingSatang: balance,
  });
  const outcome = (sale = apiSale(), extra: Partial<Extract<SaleWriteOutcome, { written: true }>> = {}): SaleWriteOutcome => ({
    ok: true, written: true, saleId: sale.id, sale, replay: false, ...extra,
  });
  function mountPayment(extra: Partial<PaymentStageOptions> = {}) {
    // The writer cases fake only Date. Reconfigure the clock so the online
    // controller's poll timers are driven by the same deterministic clock.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T04:00:00.000Z'));
    vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => {
      const kind = id === 'park-cash' ? 'cash' : id === 'park-card' ? 'card' : id === 'park-qr' ? 'qr' : null;
      return kind ? { id, kind, label: id, enabled: true, sortOrder: 0 } : undefined;
    });
    const prepareSale = vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome());
    const finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
      .mockResolvedValue(outcome(apiSale({ status: 'finalised' }), { finalised: true, outstandingSatang: 0 }));
    const onComplete = vi.fn<PaymentStageOptions['onComplete']>();
    const start = vi.spyOn(paymentsApi, 'start').mockResolvedValue({ ...qr, route: 'card_terminal',
      attempt: attempt('sent_to_terminal'), outstandingSatang: 54_000, replayed: false });
    const reading = vi.spyOn(paymentsApi, 'read').mockResolvedValue(read(attempt('sent_to_terminal'), 54_000));
    const inquire = vi.spyOn(paymentsApi, 'inquire').mockResolvedValue({ attempt: attempt('awaiting_staff_confirmation') });
    const confirm = vi.spyOn(paymentsApi, 'confirm').mockResolvedValue({ attempt: attempt('approved') });
    const manual = vi.spyOn(paymentsApi, 'manual').mockResolvedValue({ attempt: attempt('approved', { provider: 'manual' }), outstandingSatang: 0, replayed: false });
    const options: PaymentStageOptions = { scope: 'current', isCurrentScope: (scope) => scope === 'current',
      totalSatang: 54_000, prepareSale, finaliseSale, onComplete, ...extra };
    const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
    paymentUnmounts.push(hook.unmount);
    return { ...hook, options, prepareSale, finaliseSale, onComplete, start, reading, inquire, confirm, manual };
  }

  it('keeps a failed cash part body and gesture, then gives an equal next part a fresh gesture', async () => {
    const test = mountPayment();
    test.finaliseSale.mockResolvedValueOnce({ ok: false, saleId: 'sale-1', retryable: true, message: 'Connection interrupted' })
      .mockResolvedValueOnce(outcome(apiSale(), { finalised: false, outstandingSatang: 27_000, attempt: cashAttempt('sale-1') }));
    test.result.current.selectMethod('park-cash');
    test.result.current.setAmountSatang(27_000);
    test.result.current.setTenderedSatang(30_000);
    await test.result.current.submit();
    expect(test.result.current.locked).toBe(true);
    test.result.current.selectMethod('park-qr');
    test.result.current.setAmountSatang(1);
    await test.result.current.retry();
    expect(test.finaliseSale.mock.calls[0]).toEqual(test.finaliseSale.mock.calls[1]);
    expect(test.finaliseSale.mock.calls[0]![0]).toEqual({ method: 'park-cash', kind: 'cash', amountSatang: 27_000, tenderedSatang: 30_000, changeSatang: 3_000 });
    expect(test.result.current.state.outstandingSatang).toBe(27_000);
    expect(test.onComplete).not.toHaveBeenCalled();
    test.result.current.selectMethod('park-cash');
    await test.result.current.submit();
    expect(test.finaliseSale.mock.calls[2]![1]).not.toBe(test.finaliseSale.mock.calls[1]![1]);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps partial money open, then closes confirmed QR money with NO_TENDER exactly once', async () => {
    const test = mountPayment();
    test.finaliseSale.mockResolvedValueOnce(outcome(apiSale(), { finalised: false, outstandingSatang: 27_000, attempt: cashAttempt('sale-1') }));
    test.result.current.selectMethod('park-cash');
    test.result.current.setAmountSatang(27_000);
    await test.result.current.submit();
    expect(test.result.current.canBack).toBe(false);
    expect(test.onComplete).not.toHaveBeenCalled();
    test.start.mockResolvedValueOnce({ ...qr, route: 'gateway', attempt: attempt('created', { method: 'qr', provider: '2c2p', amountSatang: 27_000 }), outstandingSatang: 27_000, replayed: false });
    test.reading.mockResolvedValue(read(attempt('approved', { method: 'qr', provider: '2c2p', amountSatang: 27_000 }), 0));
    test.result.current.selectMethod('park-qr');
    await test.result.current.submit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.finaliseSale.mock.calls[1]![0]).toBeUndefined();
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onComplete.mock.calls[0]![1].map((part) => part.method)).toEqual(['park-cash', 'park-qr']);
    await test.result.current.retry();
    await test.result.current.submit();
    expect(test.finaliseSale).toHaveBeenCalledTimes(2);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
  });

  it('returns declines to selection and exposes only supported terminal recovery actions', async () => {
    const test = mountPayment();
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal', attempt: attempt('declined'), outstandingSatang: 54_000, replayed: false });
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    expect(test.result.current.state.method).toBeNull();
    expect(test.result.current.locked).toBe(false);
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(test.onComplete).not.toHaveBeenCalled();
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal', attempt: attempt('awaiting_staff_confirmation', { provider: 'ghl' }), outstandingSatang: 54_000, replayed: false });
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    expect(test.result.current.canConfirm).toBe(true);
    expect(test.result.current.canInquire).toBe(false);
    await test.result.current.inquire();
    expect(test.inquire).not.toHaveBeenCalled();
  });

  it('never offers terminal confirmation for a gateway anomaly or releases it at QR expiry', async () => {
    const test = mountPayment();
    const anomaly = attempt('awaiting_staff_confirmation', { provider: '2c2p', method: 'qr' });
    test.start.mockResolvedValueOnce({ ...qr, expiresAt: new Date(Date.now() - 1).toISOString(), route: 'gateway', attempt: anomaly, outstandingSatang: 54_000, replayed: false });
    test.reading.mockResolvedValue(read(anomaly, 54_000));
    test.result.current.selectMethod('park-qr');
    await test.result.current.submit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.result.current.locked).toBe(true);
    expect(test.result.current.canConfirm).toBe(false);
    expect(test.result.current.canInquire).toBe(false);
    await test.result.current.confirm(true, { note: 'Checked' });
    await test.result.current.inquire();
    expect(test.confirm).not.toHaveBeenCalled();
    expect(test.inquire).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'simulator' as const, method: 'card' as const, inquirySupported: false },
    { provider: 'simulator' as const, method: 'card' as const, inquirySupported: true },
    { provider: 'ghl' as const, method: 'qr' as const, inquirySupported: true },
  ])('uses explicit inquiry capability for $provider ($inquirySupported)', async ({ provider, method, inquirySupported }) => {
    const test = mountPayment();
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal',
      attempt: attempt('awaiting_staff_confirmation', { provider, method, inquirySupported }), outstandingSatang: 54_000, replayed: false });
    test.result.current.selectMethod(method === 'card' ? 'park-card' : 'park-qr');
    await test.result.current.submit();
    expect(test.result.current.canConfirm).toBe(true);
    expect(test.result.current.canInquire).toBe(inquirySupported);
    await test.result.current.inquire();
    expect(test.inquire).toHaveBeenCalledTimes(inquirySupported ? 1 : 0);
    expect(test.onComplete).not.toHaveBeenCalled();
  });

  it('refuses legacy terminal inquiry without a reference', async () => {
    const test = mountPayment();
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal',
      attempt: attempt('awaiting_staff_confirmation', { terminalRef: null }), outstandingSatang: 54_000, replayed: false });
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    expect(test.result.current.canConfirm).toBe(true);
    expect(test.result.current.canInquire).toBe(false);
    await test.result.current.inquire();
    expect(test.inquire).not.toHaveBeenCalled();
  });

  it.each(['park-card', 'park-cash'])('blocks another charge after a pending reservation refuses %s', async (method) => {
    const test = mountPayment();
    if (method === 'park-card') test.start.mockRejectedValueOnce(new ApiError(409, 'PAYMENT_IN_FLIGHT', 'Resolve the pending payment first.'));
    else test.finaliseSale.mockResolvedValueOnce({ ok: false, saleId: 'sale-1', retryable: false, code: 'PAYMENT_IN_FLIGHT', message: 'Resolve the pending payment first.' });
    test.result.current.selectMethod(method);
    await test.result.current.submit();
    expect(test.result.current.locked).toBe(true);
    expect(test.result.current.canBack).toBe(false);
    expect(test.result.current.canSubmit).toBe(false);
    test.result.current.selectMethod('park-qr');
    await test.result.current.submit();
    expect(test.result.current.state.method).toBe(method);
    expect(test.start.mock.calls.length + test.finaliseSale.mock.calls.length).toBe(1);
  });

  it('keeps a declined partial approval blocked and polling until its reversal is confirmed', async () => {
    const test = mountPayment();
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal',
      attempt: attempt('declined', { reversalPending: true }), outstandingSatang: 54_000, replayed: false });
    test.reading.mockResolvedValue(read(attempt('declined', { reversalPending: true }), 54_000));
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    expect(test.result.current.state.phase).toBe('blocked');
    expect(test.result.current.canBack).toBe(false);
    expect(test.result.current.canSubmit).toBe(false);
    test.result.current.selectMethod('park-cash');
    await test.result.current.submit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.reading).toHaveBeenCalled();
    expect(test.result.current.locked).toBe(true);
    expect(test.start).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(test.onComplete).not.toHaveBeenCalled();

    test.reading.mockResolvedValue(read(attempt('declined'), 54_000));
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.result.current.locked).toBe(true);
    expect(test.result.current.state.attempt?.reversalPending).toBe(true);
    expect(test.onComplete).not.toHaveBeenCalled();

    test.reading.mockResolvedValue(read(attempt('declined', { reversalPending: false }), 54_000));
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.result.current.locked).toBe(false);
    expect(test.result.current.state.phase).toBe('ready');
    test.result.current.selectMethod('park-cash');
    await test.result.current.submit();
    expect(test.start).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale).toHaveBeenCalledTimes(1);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
  });

  it('retries an uncertain start with the original token, amount, body and gesture', async () => {
    const test = mountPayment();
    test.start.mockRejectedValueOnce(new NetworkError(new Error('Connection lost')));
    test.result.current.selectMethod('park-qr');
    test.result.current.setAmountSatang(27_000);
    await test.result.current.submit();
    test.result.current.setAmountSatang(54_000);
    test.result.current.selectMethod('park-cash');
    await test.result.current.retry();
    expect(test.start.mock.calls[0]).toEqual(test.start.mock.calls[1]);
    expect(test.start.mock.calls[0]![0]).toMatchObject({ method: 'park-qr', amountSatang: 27_000 });
  });

  it('freezes the kind at the start gesture rather than the earlier selection or a later retry', async () => {
    const test = mountPayment();
    let kind: 'card' | 'qr' = 'card';
    vi.mocked(paymentMethods.findPaymentMethod).mockImplementation((id) => ({ id, kind, label: 'Park tender', enabled: true, sortOrder: 0 }));
    test.result.current.selectMethod('park-card');
    kind = 'qr';
    test.start.mockRejectedValueOnce(new NetworkError(new Error('Answer lost')))
      .mockResolvedValueOnce({ ...qr, route: 'gateway', attempt: attempt('approved', { method: 'qr', provider: '2c2p' }), outstandingSatang: 0, replayed: false });
    await test.result.current.submit();
    kind = 'card';
    await test.result.current.retry();
    expect(test.start.mock.calls[0]![0]).toMatchObject({ method: 'park-card', kind: 'qr', tender: 'qr' });
    expect(test.start.mock.calls[1]).toEqual(test.start.mock.calls[0]);
    expect(test.onComplete.mock.calls[0]![1][0]).toMatchObject({ method: 'park-card', kind: 'qr' });
  });

  it('drops a stale pending poll after a later staff confirmation has completed', async () => {
    const test = mountPayment();
    let answer!: (value: PaymentAttemptRead) => void;
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal', attempt: attempt('awaiting_staff_confirmation'), outstandingSatang: 54_000, replayed: false });
    test.reading.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
      .mockResolvedValue(read(attempt('approved'), 0));
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    await vi.advanceTimersByTimeAsync(1500);
    await test.result.current.confirm(true, { note: 'Checked the terminal slip' });
    expect(test.result.current.state.phase).toBe('complete');
    answer(read(attempt('sent_to_terminal'), 54_000));
    await Promise.resolve(); await Promise.resolve();
    expect(test.result.current.state.phase).toBe('complete');
    expect(test.result.current.state.outstandingSatang).toBe(0);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
  });

  it('retries only the read after a successful inquiry whose next read failed', async () => {
    const test = mountPayment();
    test.start.mockResolvedValueOnce({ ...qr, route: 'card_terminal', attempt: attempt('unknown'), outstandingSatang: 54_000, replayed: false });
    test.reading.mockRejectedValueOnce(new NetworkError(new Error('Read failed')))
      .mockResolvedValue(read(attempt('awaiting_staff_confirmation'), 54_000));
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    await test.result.current.inquire();
    await test.result.current.retry();
    expect(test.start).toHaveBeenCalledTimes(1);
    expect(test.inquire).toHaveBeenCalledTimes(1);
    expect(test.reading).toHaveBeenCalledTimes(2);
    expect(test.result.current.canConfirm).toBe(true);
  });

  it('does not apply a paid response to a replacement cart or run its completion', async () => {
    let scope = 'current';
    const onLeftBehind = vi.fn();
    const test = mountPayment({ isCurrentScope: (value) => value === scope, onLeftBehind });
    let answer!: (value: Awaited<ReturnType<typeof paymentsApi.start>>) => void;
    let startInvoked!: () => void;
    const invoked = new Promise<void>((resolve) => { startInvoked = resolve; });
    test.start.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; startInvoked(); }));
    test.result.current.selectMethod('park-card');
    const sending = test.result.current.submit();
    await invoked;
    scope = 'replacement';
    test.rerender({ ...test.options, scope });
    answer({ ...qr, route: 'card_terminal', attempt: attempt('approved'), outstandingSatang: 0, replayed: false });
    await sending;
    expect(test.result.current.state.saleId).toBeNull();
    expect(test.onComplete).not.toHaveBeenCalled();
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(onLeftBehind).toHaveBeenCalledWith('sale-1');
  });

  it('records manual approval and TID using the configured token before a zero-tender close', async () => {
    const test = mountPayment();
    test.start.mockResolvedValueOnce({ ...qr, route: 'manual', attempt: null, outstandingSatang: 54_000, replayed: false });
    test.result.current.selectMethod('park-card');
    await test.result.current.submit();
    await test.result.current.manual({ approvalCode: 'TOO-LONG-APPROVAL', tid: 'terminal-1' });
    expect(test.manual).not.toHaveBeenCalled();
    await test.result.current.manual({ approvalCode: 'APPROVED', tid: 'terminal-1' });
    expect(test.manual.mock.calls[0]![0]).toMatchObject({ method: 'park-card', amountSatang: 54_000, approvalCode: 'APPROVED', tid: 'terminal-1' });
    expect(test.finaliseSale.mock.calls[0]![0]).toBeUndefined();
    expect(test.onComplete).toHaveBeenCalledTimes(1);
  });

  it('closes a zero sale without creating an attempt and disables new collection while offline', async () => {
    const sale = apiSale();
    sale.totals.grossSatang = 0;
    const test = mountPayment({ totalSatang: 0, prepareSale: vi.fn().mockResolvedValue(outcome(sale)) });
    await test.result.current.submit();
    expect(test.start).not.toHaveBeenCalled();
    expect(test.finaliseSale.mock.calls[0]![0]).toBeUndefined();
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    test.unmount();
    vi.stubGlobal('navigator', { onLine: false });
    const offline = mountPayment();
    offline.result.current.selectMethod('park-card');
    await offline.result.current.submit();
    expect(offline.result.current.canSubmit).toBe(false);
    expect(offline.prepareSale).not.toHaveBeenCalled();
  });

  it('preserves the pending-reservation code through the writer outcome', async () => {
    const writer = mountWriter();
    await writer.result.current.commit(order(1));
    finalise.mockRejectedValueOnce(new ApiError(409, 'PAYMENT_IN_FLIGHT', 'Resolve the pending payment first.'));
    await expect(writer.result.current.finalise(cashPart)).resolves.toMatchObject({ ok: false, code: 'PAYMENT_IN_FLIGHT', retryable: false });
  });

  it('keeps payment context locked until both independent surfaces release it', async () => {
    const { setPaymentContextLocked, getPaymentContextLocked, subscribePaymentContextLocked } = await import('@/pwa/openSale');
    const changed = vi.fn();
    const unsubscribe = subscribePaymentContextLocked(changed);
    try {
      setPaymentContextLocked('test-ticket-payment', true);
      setPaymentContextLocked('test-food-payment', true);
      expect(getPaymentContextLocked()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      setPaymentContextLocked('test-ticket-payment', false);
      expect(getPaymentContextLocked()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      setPaymentContextLocked('test-food-payment', false);
      expect(getPaymentContextLocked()).toBe(false);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      setPaymentContextLocked('test-ticket-payment', false);
      setPaymentContextLocked('test-food-payment', false);
      unsubscribe();
    }
  });

  it('retries an equal split part under one key and gives its next deliberate part another key', async () => {
    const actual = await vi.importActual<typeof import('@/api/sales')>('@/api/sales');
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    await actual.finaliseSale('sale-1', 'first-part', cashPart);
    await actual.finaliseSale('sale-1', 'first-part', cashPart);
    await actual.finaliseSale('sale-1', 'second-part', cashPart);

    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    expect(post.mock.calls[0]![2]?.idempotencyKey).not.toBe(post.mock.calls[2]![2]?.idempotencyKey);
    expect(post.mock.calls[0]![1]).toMatchObject({ actionId: 'first-part', tender: cashPart });
    expect(post.mock.calls[2]![1]).toMatchObject({ actionId: 'second-part', tender: cashPart });
  });

  it('closes recorded payments with an explicit zero tender so it cannot collect an unpaid balance', async () => {
    const actual = await vi.importActual<typeof import('@/api/sales')>('@/api/sales');
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    await actual.finaliseSale('sale-1', 'close-recorded');
    expect(post).toHaveBeenCalledWith('/sales/sale-1/finalise',
      { ...NO_TENDER, actionId: 'close-recorded', tender: NO_TENDER },
      {
        idempotencyKey: actual.saleFinaliseIdempotencyKey('sale-1', NO_TENDER, 'close-recorded'),
        headers: { 'x-oto-action-id': 'close-recorded' },
      });
  });

  it('preserves the configured QR token, action header and key across start retries', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    const body = {
      saleId: 'sale-1', actionId: 'qr-start', tender: 'qr' as const,
      method: 'park-qr', kind: 'qr', amountSatang: 27_000, requestQrPayload: true,
    };
    await paymentsApi.start(body);
    await paymentsApi.start(body);
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    expect(post.mock.calls[0]).toEqual(['/payments/attempts', body, {
      idempotencyKey: 'payment:sale-1:start:qr-start', headers: { 'x-oto-action-id': 'qr-start' },
    }]);
  });

  it('separates inquire and confirm operations and deliberate confirmation gestures', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    await paymentsApi.inquire('attempt-1', 'first-gesture');
    await paymentsApi.inquire('attempt-1', 'first-gesture');
    await paymentsApi.confirm('attempt-1', { took: false }, 'first-gesture');
    await paymentsApi.confirm('attempt-1', { took: true, note: 'Verified on the terminal' }, 'next-gesture');
    const keys = post.mock.calls.map((call) => call[2]?.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set([keys[0], keys[2], keys[3]]).size).toBe(3);
    expect(post.mock.calls[2]).toEqual([
      '/payments/attempts/attempt-1/confirm', { took: false }, {
        idempotencyKey: 'payment:attempt-1:confirm:first-gesture',
        headers: { 'x-oto-action-id': 'first-gesture' },
      },
    ]);
  });
});
