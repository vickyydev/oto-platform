import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError, NetworkError } from '@/api/client';
import {
  commitSale,
  finaliseSale,
  NO_TENDER,
  salesApi,
  SalesLedgerUnavailable,
  type CommitSaleArgs,
  type SaleCartPayload,
  type SaleCommitResult,
} from '@/api/sales';
import { useSaleWriter, type SaleWriteInput } from '@/lib/saleWriter';
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
});
