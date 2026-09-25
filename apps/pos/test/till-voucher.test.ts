import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boothCodeCheckCharacter,
  isLegacyBoothCode,
  mintBoothCode,
  verifyBoothCode,
} from '@oto/shared';
import { apiSale, cartQuote, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError, NetworkError } from '@/api/client';
import { salesApi, type ApiSale, type CartQuote } from '@/api/sales';
import { vouchersApi, type VoucherView } from '@/api/vouchers';
import type { QuoteError } from '@/lib/cartQuote';
import { setBranchTimezone } from '@/lib/pricingMode';
import {
  formatVoucherStamp,
  isMenuItemVoucher,
  looksLikeVoucherCode,
  ORDER_CHANGED_AFTER_PAY,
  useTillVoucher,
  VOIDED_TO_USE_VOUCHER,
  VOUCHER_AT_THE_RESTAURANT,
  VOUCHER_ONLINE_ONLY,
  voucherUnpricedReason,
} from '@/lib/tillVoucher';

/**
 * A LUCKY WHEEL VOUCHER ON THE TILL'S CART — `lib/tillVoucher.ts` (S2-10b,
 * SCRUM-207), and the closing audit's till findings C1 and M12.
 *
 * The hook runs on the harness in place of React (support/hooks.ts). The two
 * modules that talk to the platform are replaced by their calls alone —
 * `vouchersApi` (lookup, hold, release) and `salesApi` (get, void) — so every
 * answer here is one the test gave. The rest is the till's own code.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/vouchers', () => ({
  vouchersApi: { lookup: vi.fn(), hold: vi.fn(), release: vi.fn() },
}));
vi.mock('@/api/sales', () => ({
  salesApi: { get: vi.fn(), voidSale: vi.fn() },
}));

const lookup = vi.mocked(vouchersApi.lookup);
const hold = vi.mocked(vouchersApi.hold);
const release = vi.mocked(vouchersApi.release);
const getSale = vi.mocked(salesApi.get);
const voidSale = vi.mocked(salesApi.voidSale);

/** A deterministic source for `mintBoothCode`; a booth passes `randomInt`. */
function counter(start: number) {
  let next = start;
  return (max: number) => (next++ * 7) % max;
}

const CODE = mintBoothCode('B1', counter(1));
const OTHER_CODE = mintBoothCode('B1', counter(40));

function voucher(overrides: Partial<VoucherView> = {}): VoucherView {
  return {
    id: 'voucher-1',
    code: CODE,
    source: 'booth',
    state: 'available',
    prize: { nameEn: '150 THB Voucher', nameTh: null },
    definitionCode: 'spin-voucher-150',
    kind: 'amount_off',
    effect: { type: 'amount_off', appliesTo: 'tickets', valueSatang: 15_000 },
    summary: '฿150 off the tickets',
    issuedAt: '2026-09-24T03:00:00.000Z',
    issuedBooth: { stationId: 'booth-1', name: 'Booth 1', codePrefix: 'B1' },
    issuedBranch: { id: 'branch-1', name: 'HKT Central' },
    expiresAt: null,
    legacyFormat: false,
    hold: null,
    redeemableOffline: false,
    issuedBy: null,
    ...overrides,
  };
}

/** The sale a voucher was left on: rung up at this till, unpaid, ฿540. */
const sale = (overrides: Partial<ApiSale> = {}): ApiSale => apiSale({ id: 'sale-left-unpaid', ...overrides });

/** The platform's refusal for a voucher on an unpaid sale rung up at this till. */
function heldOnUnpaidSale(saleId = 'sale-left-unpaid', details: Record<string, unknown> = {}) {
  return new ApiError(409, 'HELD_ELSEWHERE', 'In use on an unpaid sale at Reception Till 1 — pay or void that sale first', {
    stationId: 'station-1',
    stationName: 'Reception Till 1',
    rungUp: true,
    saleId,
    ...details,
  });
}

/** The hold as the platform answers it: held for the sale id it was asked for. */
function holdsAsAsked(view: VoucherView = voucher()) {
  hold.mockImplementation(async (saleId: string) => ({
    voucher: { ...view, state: 'held_here' },
    saleId,
    alreadyHeld: false,
  }));
}

let offline = false;
function mountTill(options: Omit<Parameters<typeof useTillVoucher>[0], 'isOffline'> = {}) {
  return renderHook(() => useTillVoucher({ isOffline: () => offline, ...options }));
}

beforeEach(() => {
  vi.resetAllMocks();
  offline = false;
  lookup.mockImplementation(async (code: string) => ({ voucher: voucher({ code }) }));
  holdsAsAsked();
  release.mockImplementation(async (saleId: string, voucherId: string) => ({
    released: true,
    voucherId,
    saleId,
  }));
  voidSale.mockImplementation(async (saleId: string, reason: string) => ({
    replay: false,
    sale: sale({ id: saleId, status: 'voided' }),
    void: { voidedAt: '2026-09-25T04:20:00.000Z', voidedByAccountId: 'account-1', reason },
    releasedVoucherIds: ['voucher-1'],
  }));
});

describe('a voucher on this cart', () => {
  it('asks what the code is, then holds it for this cart under the sale id the till minted', async () => {
    const { result } = mountTill();
    const typed = ` ${CODE.slice(0, 4).toLowerCase()}-${CODE.slice(4)}\n`;

    await expect(result.current.redeem(typed)).resolves.toBe(true);

    expect(lookup).toHaveBeenCalledWith(CODE);
    expect(hold).toHaveBeenCalledTimes(1);
    const [saleId, code] = hold.mock.calls[0]!;
    expect(saleId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // a UUIDv7, minted here
    expect(code).toBe(CODE);
    expect(lookup.mock.invocationCallOrder[0]!).toBeLessThan(hold.mock.invocationCallOrder[0]!);
    expect(result.current.held).toEqual({
      view: expect.objectContaining({ id: 'voucher-1', state: 'held_here' }),
      code: CODE,
      saleId,
    });
    expect(result.current.current()).toEqual(result.current.held);
    expect(result.current.busy).toBe(false);
    expect(result.current.refusal).toBeNull();
  });

  it('sends a second voucher for the same sale id, so the platform answers "only one" in its own words', async () => {
    const { result } = mountTill();
    await result.current.redeem(CODE);
    const first = result.current.held!;

    hold.mockRejectedValueOnce(new ApiError(409, 'VOUCHER_LIMIT', 'Only one voucher can be used on a sale'));
    await expect(result.current.redeem(OTHER_CODE)).resolves.toBe(false);

    expect(hold.mock.calls[1]).toEqual([first.saleId, OTHER_CODE]);
    expect(result.current.refusal).toEqual({
      code: 'VOUCHER_LIMIT',
      message: 'Only one voucher can be used on a sale',
      voucherCode: OTHER_CODE,
    });
    expect(result.current.held).toEqual(first);
  });

  it('keeps the cart its sale id when the voucher comes off, and mints a new one for a new cart', async () => {
    const { result } = mountTill();
    await result.current.redeem(CODE);
    const { saleId } = result.current.held!;

    await expect(result.current.release()).resolves.toBe(true);
    expect(release).toHaveBeenCalledWith(saleId, 'voucher-1');
    expect(result.current.held).toBeNull();
    await result.current.redeem(CODE);
    expect(result.current.held!.saleId).toBe(saleId);

    result.current.reset();
    await result.current.redeem(CODE);
    expect(result.current.held!.saleId).not.toBe(saleId);
  });

  it('says the till’s own no and asks nothing', async () => {
    const { result } = mountTill();
    await expect(result.current.redeem(CODE, 'This sale has already been rung up')).resolves.toBe(false);
    expect(result.current.refusal).toEqual({
      code: 'TILL_REFUSED',
      message: 'This sale has already been rung up',
      voucherCode: CODE,
    });

    offline = true;
    await expect(result.current.redeem(CODE)).resolves.toBe(false);
    expect(result.current.refusal).toEqual({
      code: 'VOUCHER_OFFLINE',
      message: VOUCHER_ONLINE_ONLY,
      voucherCode: CODE,
    });

    // Back online, an empty code is still not asked about.
    offline = false;
    await expect(result.current.redeem('  - ')).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it('asks one thing at a time: a scan while the first is out is ignored', async () => {
    let answer!: (value: { voucher: VoucherView }) => void;
    lookup.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountTill();

    const first = result.current.redeem(CODE);
    expect(result.current.busy).toBe(true);
    await expect(result.current.redeem(OTHER_CODE)).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);

    answer({ voucher: voucher() });
    await expect(first).resolves.toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it.each([
    [
      'a refusal of ours, in its own words',
      new ApiError(409, 'ALREADY_REDEEMED', 'Already redeemed on 24 Sep 2026 15:02 at Reception Till 1'),
      { code: 'ALREADY_REDEEMED', message: 'Already redeemed on 24 Sep 2026 15:02 at Reception Till 1' },
    ],
    [
      'an unknown code, which is a 404 of ours and not a missing route',
      new ApiError(404, 'VOUCHER_NOT_FOUND', 'Invalid code'),
      { code: 'VOUCHER_NOT_FOUND', message: 'Invalid code' },
    ],
    [
      'no answer at all',
      new NetworkError(new TypeError('Failed to fetch')),
      { code: 'VOUCHER_OFFLINE', message: VOUCHER_ONLINE_ONLY },
    ],
    [
      'a deployment without the route',
      new ApiError(404, 'UNKNOWN', 'Not Found'),
      { code: 'NOT_ON_THIS_DEPLOYMENT', message: 'This deployment cannot redeem vouchers yet' },
    ],
  ])('shows %s', async (_label, error, expected) => {
    lookup.mockRejectedValueOnce(error);
    const { result } = mountTill();
    await expect(result.current.redeem(CODE)).resolves.toBe(false);
    expect(result.current.refusal).toEqual({ ...expected, voucherCode: CODE });
    expect(hold).not.toHaveBeenCalled();
    expect(result.current.held).toBeNull();
  });

  it('sends a menu item to the restaurant till at the ticket till, holding nothing', async () => {
    const pizza = voucher({
      effect: {
        type: 'free_item',
        product: { id: 'p-pizza', name: 'Kids Pizza', kind: 'menu', priceSatang: 19_000, weekendPriceSatang: 19_000 },
      },
    });
    lookup.mockResolvedValueOnce({ voucher: pizza });
    const { result } = mountTill({
      refuseHere: (view) => (isMenuItemVoucher(view) ? VOUCHER_AT_THE_RESTAURANT : null),
    });

    await expect(result.current.redeem(CODE)).resolves.toBe(false);
    expect(result.current.refusal).toEqual({
      code: 'VOUCHER_WRONG_TILL',
      message: VOUCHER_AT_THE_RESTAURANT,
      voucherCode: CODE,
    });
    expect(hold).not.toHaveBeenCalled();
  });
});

describe('the offer to void an unpaid sale the voucher was left on (audit C1)', () => {
  it('shows that sale — its till, time and amount, read from the platform — and voids nothing by itself', async () => {
    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    getSale.mockResolvedValueOnce({ sale: sale() });
    const { result } = mountTill({ ownsSale: () => false });

    await expect(result.current.redeem(CODE)).resolves.toBe(false);

    expect(getSale).toHaveBeenCalledWith('sale-left-unpaid');
    expect(result.current.refusal).toEqual({
      code: 'HELD_ELSEWHERE',
      message: 'In use on an unpaid sale at Reception Till 1 — pay or void that sale first',
      voucherCode: CODE,
      rungUp: {
        saleId: 'sale-left-unpaid',
        stationName: 'Reception Till 1',
        occurredAt: '2026-09-25T04:10:00.000Z',
        grossSatang: 54_000,
      },
    });
    expect(voidSale).not.toHaveBeenCalled();
    expect(result.current.held).toBeNull();
  });

  it('makes no offer for a sale that is no longer tendering: it was paid or voided since', async () => {
    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    getSale.mockResolvedValueOnce({ sale: sale({ status: 'finalised' }) });
    const { result } = mountTill();
    await result.current.redeem(CODE);
    expect(result.current.refusal?.code).toBe('HELD_ELSEWHERE');
    expect(result.current.refusal?.rungUp).toBeUndefined();
  });

  it('stands the offer on the sale id alone when the sale cannot be read', async () => {
    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    getSale.mockRejectedValueOnce(new NetworkError());
    const { result } = mountTill();
    await result.current.redeem(CODE);
    expect(result.current.refusal?.rungUp).toEqual({
      saleId: 'sale-left-unpaid',
      stationName: 'Reception Till 1',
      occurredAt: null,
      grossSatang: null,
    });
  });

  it("makes no offer for a sale this screen rang up: that screen's Cancel voids it", async () => {
    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    const { result } = mountTill({ ownsSale: (saleId) => saleId === 'sale-left-unpaid' });
    await result.current.redeem(CODE);
    expect(result.current.refusal?.code).toBe('HELD_ELSEWHERE');
    expect(result.current.refusal?.rungUp).toBeUndefined();
    expect(getSale).not.toHaveBeenCalled();
  });

  it.each([
    ['a voucher held on a cart not rung up', heldOnUnpaidSale('sale-1', { rungUp: false })],
    ['a rung-up sale the platform did not name', heldOnUnpaidSale('sale-1', { saleId: null })],
    [
      'another refusal that happens to carry a sale id',
      new ApiError(409, 'ALREADY_REDEEMED', 'Already redeemed', { rungUp: true, saleId: 'sale-1' }),
    ],
  ])('makes no offer for %s', async (_label, error) => {
    hold.mockRejectedValueOnce(error);
    const { result } = mountTill();
    await result.current.redeem(CODE);
    expect(result.current.refusal?.rungUp).toBeUndefined();
    expect(getSale).not.toHaveBeenCalled();
  });

  it('on the staff choice voids that sale with its reason, then holds the voucher for this cart', async () => {
    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    getSale.mockResolvedValueOnce({ sale: sale() });
    const { result } = mountTill();
    await result.current.redeem(CODE);

    await expect(result.current.voidRungUp()).resolves.toBe(true);

    expect(voidSale).toHaveBeenCalledWith('sale-left-unpaid', VOIDED_TO_USE_VOUCHER);
    expect(voidSale.mock.invocationCallOrder[0]!).toBeLessThan(hold.mock.invocationCallOrder[1]!);
    expect(lookup).toHaveBeenCalledTimes(2); // looked up again, as a scan would
    expect(result.current.refusal).toBeNull();
    expect(result.current.held?.code).toBe(CODE);
  });

  it('shows a void the platform refuses in its own words, and does nothing else', async () => {
    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    getSale.mockResolvedValueOnce({ sale: sale() });
    const { result } = mountTill();
    await result.current.redeem(CODE);

    voidSale.mockRejectedValueOnce(new ApiError(409, 'SALE_TENDER_IN_PROGRESS', 'A payment is being taken for this sale'));
    await expect(result.current.voidRungUp()).resolves.toBe(false);

    expect(result.current.refusal).toEqual({
      code: 'SALE_TENDER_IN_PROGRESS',
      message: 'A payment is being taken for this sale',
      voucherCode: CODE,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBeNull();
  });

  it('voids nothing offline, and nothing when no offer is on screen', async () => {
    const { result } = mountTill();
    await expect(result.current.voidRungUp()).resolves.toBe(false);

    hold.mockRejectedValueOnce(heldOnUnpaidSale());
    getSale.mockResolvedValueOnce({ sale: sale() });
    await result.current.redeem(CODE);
    offline = true;
    await expect(result.current.voidRungUp()).resolves.toBe(false);
    expect(result.current.refusal).toEqual({
      code: 'VOUCHER_OFFLINE',
      message: VOUCHER_ONLINE_ONLY,
      voucherCode: CODE,
    });
    expect(voidSale).not.toHaveBeenCalled();
  });
});

describe('the voucher follows a corrected order after Pay (moveTo, audit M12)', () => {
  it('voids a sale THIS screen rang up with its reason, then holds the voucher for the new sale id', async () => {
    const { result } = mountTill({ ownsSale: (saleId) => saleId === rungUpHere });
    await result.current.redeem(CODE);
    const rungUpHere = result.current.held!.saleId;

    hold.mockRejectedValueOnce(heldOnUnpaidSale(rungUpHere));
    await expect(result.current.moveTo('sale-corrected')).resolves.toBe(true);

    expect(voidSale).toHaveBeenCalledWith(rungUpHere, ORDER_CHANGED_AFTER_PAY);
    expect(hold.mock.calls.slice(1)).toEqual([
      ['sale-corrected', CODE],
      ['sale-corrected', CODE],
    ]);
    expect(result.current.held?.saleId).toBe('sale-corrected');
  });

  it("never voids another screen's sale without asking: the refusal shows it with the offer", async () => {
    const { result } = mountTill({ ownsSale: () => false });
    await result.current.redeem(CODE);
    const before = result.current.held!;

    hold.mockRejectedValueOnce(heldOnUnpaidSale('sale-on-the-other-screen'));
    getSale.mockResolvedValueOnce({ sale: sale({ id: 'sale-on-the-other-screen' }) });
    await expect(result.current.moveTo('sale-corrected')).resolves.toBe(false);

    expect(voidSale).not.toHaveBeenCalled();
    expect(result.current.refusal?.rungUp?.saleId).toBe('sale-on-the-other-screen');
    expect(result.current.held).toEqual(before);
  });

  it('without a way to tell its own sales, voids none', async () => {
    const { result } = mountTill();
    await result.current.redeem(CODE);
    const rungUpHere = result.current.held!.saleId;
    hold.mockRejectedValueOnce(heldOnUnpaidSale(rungUpHere));
    getSale.mockResolvedValueOnce({ sale: sale({ id: rungUpHere }) });
    await expect(result.current.moveTo('sale-corrected')).resolves.toBe(false);
    expect(voidSale).not.toHaveBeenCalled();
  });

  it('asks nothing to move to the id it is already held for, or with nothing held', async () => {
    const { result } = mountTill();
    await expect(result.current.moveTo('sale-x')).resolves.toBe(true);
    await result.current.redeem(CODE);
    await expect(result.current.moveTo(result.current.held!.saleId)).resolves.toBe(true);
    expect(hold).toHaveBeenCalledTimes(1);
  });
});

describe('an answer never lands on a cart that has moved on', () => {
  it('lets a hold go again when it is answered after the till moved on, and the new cart stays empty', async () => {
    let answer!: (value: Awaited<ReturnType<typeof vouchersApi.hold>>) => void;
    hold.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountTill();

    const redeemed = result.current.redeem(CODE);
    await settle();
    expect(hold).toHaveBeenCalledTimes(1);
    result.current.reset();
    expect(result.current.busy).toBe(false);

    answer({ voucher: voucher({ state: 'held_here' }), saleId: 'sale-of-the-last-cart', alreadyHeld: false });
    await expect(redeemed).resolves.toBe(false);
    expect(release).toHaveBeenCalledWith('sale-of-the-last-cart', 'voucher-1');
    expect(result.current.held).toBeNull();
    expect(result.current.refusal).toBeNull();
  });

  it('holds nothing for a lookup answered after the till moved on', async () => {
    let answer!: (value: { voucher: VoucherView }) => void;
    lookup.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = mountTill();
    const redeemed = result.current.redeem(CODE);
    result.current.reset();
    answer({ voucher: voucher() });
    await expect(redeemed).resolves.toBe(false);
    expect(hold).not.toHaveBeenCalled();
    expect(result.current.held).toBeNull();
  });

  it('does not show a refusal answered after the till moved on', async () => {
    let refuse!: (error: unknown) => void;
    lookup.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    const { result } = mountTill();
    const redeemed = result.current.redeem(CODE);
    result.current.reset();
    refuse(new ApiError(409, 'ALREADY_REDEEMED', 'Already redeemed'));
    await expect(redeemed).resolves.toBe(false);
    expect(result.current.refusal).toBeNull();
  });
});

describe('taking the voucher off', () => {
  it('releases it from a cart not rung up', async () => {
    const { result } = mountTill();
    await expect(result.current.release()).resolves.toBe(true); // nothing on: nothing to ask
    expect(release).not.toHaveBeenCalled();

    await result.current.redeem(CODE);
    const { saleId } = result.current.held!;
    await expect(result.current.release()).resolves.toBe(true);
    expect(release).toHaveBeenCalledWith(saleId, 'voucher-1');
    expect(result.current.held).toBeNull();
  });

  it('keeps it on when the platform refuses, and says why', async () => {
    const { result } = mountTill();
    await result.current.redeem(CODE);
    const held = result.current.held;
    release.mockRejectedValueOnce(new ApiError(409, 'SALE_ALREADY_RUNG_UP', 'This sale has already been rung up'));
    await expect(result.current.release()).resolves.toBe(false);
    expect(result.current.held).toEqual(held);
    expect(result.current.refusal).toEqual({
      code: 'SALE_ALREADY_RUNG_UP',
      message: 'This sale has already been rung up',
      voucherCode: CODE,
    });
  });
});

describe('looksLikeVoucherCode — what the till claims as a booth code', () => {
  /** A current code made of digits alone: a valid check, and a retail barcode's shape. */
  function allDigitCode(): string {
    for (let n = 0; n < 100_000; n += 1) {
      const body = `12${String(n).padStart(8, '2').replace(/[01]/g, '9')}`;
      const check = boothCodeCheckCharacter(body);
      if (check !== null && /[0-9]/.test(check)) return `${body}${check}`;
    }
    throw new Error('no all-digit code found');
  }

  it('claims a current code, however it was typed', () => {
    expect(looksLikeVoucherCode(CODE)).toBe(true);
    expect(looksLikeVoucherCode(` ${CODE.slice(0, 3)}-${CODE.slice(3).toLowerCase()} `)).toBe(true);
  });

  it('claims the ten-character shape printed before the check character', () => {
    const legacy = CODE.slice(0, 10);
    expect(isLegacyBoothCode(legacy)).toBe(true);
    expect(looksLikeVoucherCode(legacy)).toBe(true);
  });

  it('does not claim a current-length code with a wrong check character', () => {
    const last = CODE.at(-1)!;
    const wrong = `${CODE.slice(0, 10)}${last === 'X' ? 'Y' : 'X'}`;
    expect(verifyBoothCode(wrong).ok).toBe(false);
    expect(looksLikeVoucherCode(wrong)).toBe(false);
  });

  it('never claims digits alone — a retail barcode, or a band — even with a valid check', () => {
    const digits = allDigitCode();
    expect(verifyBoothCode(digits).ok).toBe(true);
    expect(looksLikeVoucherCode(digits)).toBe(false);
    expect(looksLikeVoucherCode(digits.slice(0, 10))).toBe(false);
    expect(looksLikeVoucherCode('8851234567890')).toBe(false);
  });
});

describe('isMenuItemVoucher', () => {
  const freeItem = (kind: 'menu' | 'merch' | 'addon') =>
    voucher({
      effect: {
        type: 'free_item',
        product: { id: 'p-1', name: 'Item', kind, priceSatang: 10_000, weekendPriceSatang: 10_000 },
      },
    });

  it("is true only for a free item off the kitchen's or the bar's menu", () => {
    expect(isMenuItemVoucher(freeItem('menu'))).toBe(true);
    expect(isMenuItemVoucher(freeItem('merch'))).toBe(false);
    expect(isMenuItemVoucher(freeItem('addon'))).toBe(false);
    expect(isMenuItemVoucher(voucher())).toBe(false);
    expect(isMenuItemVoucher(voucher({ effect: { type: 'hand_over' } }))).toBe(false);
  });
});

describe('voucherUnpricedReason — why the voucher card has no figure from the platform', () => {
  const quote = (overrides: Partial<CartQuote> = {}): CartQuote =>
    cartQuote(690, { source: 'till', ...overrides });
  const refusal: QuoteError = {
    kind: 'refusal',
    status: 409,
    code: 'VOUCHER_NOT_HELD',
    message: 'Scan the voucher at this till first — it is not held for this sale',
  };

  it('says nothing while the platform priced it or is being asked', () => {
    expect(voucherUnpricedReason({ quote: quote({ source: 'platform' }), pending: false, error: null, offline: true })).toBeNull();
    expect(voucherUnpricedReason({ quote: quote(), pending: true, error: refusal, offline: true })).toBeNull();
  });

  it("gives the platform's own words when it answered", () => {
    expect(voucherUnpricedReason({ quote: quote(), pending: false, error: refusal, offline: true })).toBe(refusal.message);
  });

  it('speaks for itself only when nothing answered', () => {
    expect(voucherUnpricedReason({ quote: quote({ unanswered: true }), pending: false, error: null, offline: false })).toBe(
      VOUCHER_ONLINE_ONLY,
    );
    expect(voucherUnpricedReason({ quote: quote(), pending: false, error: null, offline: true })).toBe(VOUCHER_ONLINE_ONLY);
    expect(
      voucherUnpricedReason({
        quote: quote({ reason: 'No station or branch on this device yet.' }),
        pending: false,
        error: null,
        offline: false,
      }),
    ).toBe('No station or branch on this device yet.');
    expect(voucherUnpricedReason({ quote: quote(), pending: false, error: null, offline: false })).toBeNull();
  });
});

describe('formatVoucherStamp — a date on the branch clock', () => {
  afterEach(() => setBranchTimezone(null));

  it('prints the day and, when asked, the time as the platform prints them', () => {
    expect(formatVoucherStamp('2026-10-08T08:02:00.000Z')).toBe('8 Oct 2026');
    expect(formatVoucherStamp('2026-10-08T08:02:00.000Z', { time: true })).toBe('8 Oct 2026 15:02');
  });

  it("reads the branch's calendar, not the device's", () => {
    // 18:30 UTC is already the next morning in Phuket.
    expect(formatVoucherStamp('2026-10-08T18:30:00.000Z', { time: true })).toBe('9 Oct 2026 01:30');
    setBranchTimezone('Europe/London');
    expect(formatVoucherStamp('2026-10-08T18:30:00.000Z', { time: true })).toBe('8 Oct 2026 19:30');
  });

  it('hands back what it cannot read', () => {
    expect(formatVoucherStamp('not a date')).toBe('not a date');
  });
});
