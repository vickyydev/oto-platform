import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintBoothCode } from '@oto/shared';
import { apiSale, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import { salesApi } from '@/api/sales';
import { vouchersApi, type VoucherView } from '@/api/vouchers';
import { useLeftBehindSales, VOIDED_LEFT_BEHIND } from '@/lib/leftBehindSale';
import { useTillVoucher, VOIDED_TO_USE_VOUCHER } from '@/lib/tillVoucher';

/**
 * SCRUM-854 — A LEFT-UNPAID SALE VOIDED FROM THE VOUCHER REFUSAL TAKES ITS OWN
 * LEFT-UNPAID NOTICE WITH IT.
 *
 * A sale rung up with a voucher and left unpaid at the till is on screen twice
 * for the next person there: in the till's left-unpaid notice (SCRUM-407,
 * `lib/leftBehindSale.ts`), and — once the family's slip is scanned again —
 * inside the voucher's refusal, with "Void that unpaid sale and use the voucher
 * here" (C1, `voidRungUp` in `lib/tillVoucher.ts`). That press voided the sale
 * and held the voucher, and the notice for the same, now voided, sale stayed
 * with its own "Void that unpaid sale" button: the two lists did not know of
 * each other.
 *
 * Both hooks run here on the harness, wired as `pages/Till.tsx` wires them,
 * over the platform's calls alone — the SCRUM-407 tests' way (till-voucher).
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/vouchers', () => ({
  vouchersApi: { lookup: vi.fn(), hold: vi.fn(), release: vi.fn() },
}));
vi.mock('@/api/sales', () => ({
  salesApi: { get: vi.fn(), voidSale: vi.fn(), list: vi.fn() },
}));

const lookup = vi.mocked(vouchersApi.lookup);
const hold = vi.mocked(vouchersApi.hold);
const getSale = vi.mocked(salesApi.get);
const voidSale = vi.mocked(salesApi.voidSale);
const listSales = vi.mocked(salesApi.list);

const CODE = mintBoothCode('B1', ((next) => (max: number) => (next++ * 7) % max)(1));
const LEFT = 'zz-test-sale-left-with-voucher';
const OTHER = 'zz-test-sale-left-without';

const voucher = (code: string): VoucherView => ({
  id: 'zz-test-voucher',
  code,
  source: 'booth',
  state: 'available',
  prize: { nameEn: 'ZZ TEST 150 THB Voucher', nameTh: null },
  definitionCode: 'zz-test-150-off',
  kind: 'amount_off',
  effect: { type: 'amount_off', appliesTo: 'tickets', target: { kind: 'tickets' }, label: 'the ticket order', valueSatang: 15_000 },
  summary: '฿150 off the tickets',
  issuedAt: '2026-09-24T03:00:00.000Z',
  issuedBooth: { stationId: 'booth-1', name: 'Booth 1', codePrefix: 'B1' },
  issuedBranch: { id: 'branch-1', name: 'HKT Central' },
  expiresAt: null,
  legacyFormat: false,
  hold: null,
  redeemableOffline: false,
  staffLabel: null,
  issuedBy: null,
});

/** The platform's refusal for a voucher on an unpaid sale rung up at this till. */
const heldOnUnpaidSale = (saleId: string) =>
  new ApiError(409, 'HELD_ELSEWHERE', 'In use on an unpaid sale at Reception Till 1 — pay or void that sale first', {
    stationId: 'station-1', stationName: 'Reception Till 1', rungUp: true, saleId,
  });

beforeEach(() => {
  vi.resetAllMocks();
  lookup.mockImplementation(async (code: string) => ({ voucher: voucher(code) }));
  hold.mockImplementation(async (saleId: string, code: string) => ({
    voucher: { ...voucher(code), state: 'held_here' }, saleId, alreadyHeld: false,
  }));
  voidSale.mockImplementation(async (saleId: string, reason: string) => ({
    replay: false,
    sale: apiSale({ id: saleId, status: 'voided' }),
    void: { voidedAt: '2026-09-25T04:20:00.000Z', voidedByAccountId: 'zz-test-account', reason },
    releasedVoucherIds: ['zz-test-voucher'],
  }));
  // Two sales left unpaid at this till by whoever stood here before.
  listSales.mockResolvedValue({ sales: [
    apiSale({ id: LEFT, stationId: 'station-1', status: 'tendering' }),
    apiSale({ id: OTHER, stationId: 'station-1', status: 'tendering' }),
  ] });
  getSale.mockImplementation(async (id: string) => ({ sale: apiSale({ id, stationId: 'station-1', status: 'tendering' }) }));
});

/**
 * The till opened by the next person: the left-unpaid notices up, and the
 * family's slip scanned and refused with the offer for `heldOn`. `press` is
 * the offer's button exactly as `pages/Till.tsx` wires it.
 */
async function tillWithTheSlipRefused(heldOn = LEFT) {
  hold.mockRejectedValueOnce(heldOnUnpaidSale(heldOn));
  const { result } = renderHook(() => {
    const voucherOnCart = useTillVoucher({ isOffline: () => false, ownsSale: () => false });
    const leftBehind = useLeftBehindSales({ branchId: 'branch-1', stationId: 'station-1', stationName: 'Reception Till 1',
      accountId: 'zz-test-next-account', enabled: true, ownsSale: () => false });
    return { voucher: voucherOnCart, leftBehind, press: () => voucherOnCart.voidRungUp(leftBehind.dismiss) };
  });
  await settle();
  await result.current.voucher.redeem(CODE);
  await settle();
  return result;
}
const notices = (result: { current: { leftBehind: { sales: { saleId: string }[] } } }) =>
  result.current.leftBehind.sales.map((s) => s.saleId);

describe('SCRUM-854: voided from the voucher refusal, the sale’s left-unpaid notice goes too', () => {
  it('before the press the same sale is on screen twice: in its notice and in the refusal', async () => {
    const till = await tillWithTheSlipRefused();
    expect(notices(till)).toEqual([LEFT, OTHER]);
    expect(till.current.voucher.refusal?.rungUp?.saleId).toBe(LEFT);
    expect(voidSale).not.toHaveBeenCalled();
  });

  it('the press voids the sale, holds the voucher, and takes down that sale’s notice — and only that one', async () => {
    const till = await tillWithTheSlipRefused();
    await expect(till.current.press()).resolves.toBe(true);
    await settle();
    expect(voidSale).toHaveBeenCalledTimes(1);
    expect(voidSale).toHaveBeenCalledWith(LEFT, VOIDED_TO_USE_VOUCHER);
    expect(till.current.voucher.held?.code).toBe(CODE);
    expect(till.current.voucher.refusal).toBeNull();
    // The other sale left at this till is still offered, with its own void.
    expect(notices(till)).toEqual([OTHER]);
    expect(till.current.leftBehind.refusal).toBeNull();
    await till.current.leftBehind.voidSale(OTHER);
    await settle();
    expect(voidSale).toHaveBeenLastCalledWith(OTHER, VOIDED_LEFT_BEHIND);
    expect(notices(till)).toEqual([]);
  });

  it('a void the platform refuses keeps the notice: the sale is still unpaid', async () => {
    const till = await tillWithTheSlipRefused();
    voidSale.mockRejectedValueOnce(new ApiError(409, 'SALE_TENDER_IN_PROGRESS', 'A payment is being taken for this sale'));
    await expect(till.current.press()).resolves.toBe(false);
    await settle();
    expect(till.current.voucher.refusal?.message).toBe('A payment is being taken for this sale');
    expect(till.current.voucher.held).toBeNull();
    expect(notices(till)).toEqual([LEFT, OTHER]);
  });

  it('the sale voided and the slip then refused again: the notice still goes, for the sale is void', async () => {
    const till = await tillWithTheSlipRefused();
    hold.mockRejectedValueOnce(new ApiError(409, 'VOUCHER_EXPIRED', 'This voucher has expired'));
    await expect(till.current.press()).resolves.toBe(false);
    await settle();
    expect(voidSale).toHaveBeenCalledWith(LEFT, VOIDED_TO_USE_VOUCHER);
    expect(till.current.voucher.refusal?.message).toBe('This voucher has expired');
    expect(notices(till)).toEqual([OTHER]);
  });

  it('the notice is taken down by the sale’s id: a voucher left on a sale with no notice changes none', async () => {
    const till = await tillWithTheSlipRefused('zz-test-sale-not-listed');
    await expect(till.current.press()).resolves.toBe(true);
    await settle();
    expect(voidSale).toHaveBeenCalledWith('zz-test-sale-not-listed', VOIDED_TO_USE_VOUCHER);
    expect(notices(till)).toEqual([LEFT, OTHER]);
  });

  it('the hook tells the sale it voided, once, and nothing when nothing was voided', async () => {
    const voided = vi.fn();
    const none = renderHook(() => useTillVoucher({ isOffline: () => false }));
    await expect(none.result.current.voidRungUp(voided)).resolves.toBe(false);
    expect(voided).not.toHaveBeenCalled();

    const till = await tillWithTheSlipRefused();
    await expect(till.current.voucher.voidRungUp(voided)).resolves.toBe(true);
    expect(voided.mock.calls).toEqual([[LEFT]]);
    // Without a listener it voids and holds as it always did (the F&B counter keeps no such notice).
    hold.mockRejectedValueOnce(heldOnUnpaidSale(OTHER));
    const plain = renderHook(() => useTillVoucher({ isOffline: () => false }));
    await plain.result.current.redeem(CODE);
    await expect(plain.result.current.voidRungUp()).resolves.toBe(true);
    expect(voidSale).toHaveBeenLastCalledWith(OTHER, VOIDED_TO_USE_VOUCHER);
  });

  it('the counter till wires the press to its notices; the notice’s own buttons are as they were', () => {
    const till = readFileSync(new URL('../src/pages/Till.tsx', import.meta.url), 'utf8');
    expect(till).toContain('{ onVoidRungUp: () => void voucher.voidRungUp(leftBehind.dismiss) }');
    expect(till).toContain('onDismiss={() => leftBehind.dismiss(left.saleId)}');
    expect(till).toContain('{ onVoid: () => void leftBehind.voidSale(left.saleId) }');
    // The restaurant till redeems vouchers and lists no left-unpaid sales.
    const station = readFileSync(new URL('../src/pages/OrderStation.tsx', import.meta.url), 'utf8');
    expect(station).toContain('{ onVoidRungUp: () => void voucher.voidRungUp() }');
    expect(station).not.toContain('useLeftBehindSales');
  });
});
