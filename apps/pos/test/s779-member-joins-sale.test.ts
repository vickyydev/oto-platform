import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { NetworkError } from '@/api/client';
import {
  commitSale,
  salesApi,
  type CommitSaleArgs,
  type SaleCartPayload,
  type SaleCommitResult,
} from '@/api/sales';
import { useSaleWriter, type SaleWriteInput } from '@/lib/saleWriter';

/**
 * SCRUM-779 — ONE SALE WHEN A WALK-IN WITH A TIER CLAIM BECOMES A MEMBER.
 *
 * Seen on staging on 5 November: the payment screen rang the sale up as a
 * walk-in priced by the Thai-rate claim, the customer display's details became
 * a member a second later, and Confirm rang the order up AGAIN under the
 * member, leaving the first sale unpaid.
 *
 * The writer now keeps the sale that is open as THE sale for the order: a cart
 * that differs from it only in who it belongs to is sent exactly as it was
 * rung up, and the member is added to that sale on the platform.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return {
    ...actual,
    commitSale: vi.fn(),
    salesApi: { ...actual.salesApi, get: vi.fn(), voidSale: vi.fn(), attachMember: vi.fn() },
  };
});

const commit = vi.mocked(commitSale);
const attach = vi.mocked(salesApi.attachMember);
const sent = (): CommitSaleArgs[] => commit.mock.calls.map(([args]) => args);

/** The walk-in's cart, priced by the Thai-rate claim; `memberId` once the profile exists. */
function cart(kids: number, who: { memberId?: string | null; customerNickname?: string | null } = {}): SaleCartPayload {
  return {
    branchId: 'branch-1',
    stationId: 'station-1',
    channel: 'till',
    tier: 'thai',
    tierClaimActionId: 'claim-action-1',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' },
    lines: [{
      id: 'line-1', packageId: 'package-1h', packageName: '1 Hour Play', tier: 'thai',
      kids, adults: 1, socks: 0, addOns: [], lineTotalSatang: 59_000 * kids,
    }],
    promos: [],
    manualDiscounts: [],
    memberId: who.memberId ?? null,
    customerPhone: '0812077900',
    customerNickname: who.customerNickname ?? null,
    expectedTotalSatang: 59_000 * kids,
  };
}
const order = (kids: number, who?: Parameters<typeof cart>[1]): SaleWriteInput => ({ cart: cart(kids, who), finalise: false });
const MEMBER = 'member-nok';

const attachAnswer = (saleId: string) => ({
  replay: false, saleId, memberId: MEMBER, status: 'tendering', customerTier: 'thai', tierClaimId: 'claim-1',
});

beforeEach(() => {
  vi.resetAllMocks();
  commit.mockImplementation(async (args) => ({ sale: apiSale({ id: args.saleId, customerTier: 'thai' }), replay: false }));
  attach.mockImplementation(async (saleId: string) => attachAnswer(saleId));
});
afterEach(() => vi.restoreAllMocks());

describe('the member joins the sale already rung up', () => {
  it('Confirm after the member arrives closes the SAME sale: one commit, and the member added to it', async () => {
    const { result } = renderHook(() => useSaleWriter());
    const rungUp = await result.current.commit(order(1));
    expect(rungUp).toMatchObject({ ok: true, written: true });
    const saleId = sent()[0]!.saleId;

    const joined = await result.current.attachMember(MEMBER);
    expect(joined).toEqual({ attached: true, saleId });
    expect(attach).toHaveBeenCalledExactlyOnceWith(saleId, MEMBER);

    // The till's cart now names the member (and the nickname the profile holds).
    const confirm = await result.current.commit(order(1, { memberId: MEMBER, customerNickname: 'Nok' }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(confirm).toMatchObject({ ok: true, written: true, replay: true, saleId });
    expect(result.current.committed).toMatchObject({ id: saleId, memberId: MEMBER });
  });

  it('a member who arrives while the commit is still on the wire waits for it, then joins it', async () => {
    let answer!: (result: SaleCommitResult) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useSaleWriter());
    const rungUp = result.current.commit(order(1));
    const joined = result.current.attachMember(MEMBER);
    const confirm = result.current.commit(order(1, { memberId: MEMBER }));
    expect(attach).not.toHaveBeenCalled();

    const saleId = sent()[0]!.saleId;
    answer({ sale: apiSale({ id: saleId }), replay: false });
    await rungUp;
    expect(await joined).toEqual({ attached: true, saleId });
    expect(await confirm).toMatchObject({ ok: true, written: true, saleId });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('a commit that got no answer is retried as the walk-in sale it was, and then takes the member', async () => {
    commit.mockRejectedValueOnce(new NetworkError(new TypeError('Failed to fetch')));
    const { result } = renderHook(() => useSaleWriter());
    const lost = await result.current.commit(order(1));
    expect(lost.ok).toBe(false);
    // Nothing the till knows of is open yet, so there is nothing to add the member to now.
    expect(await result.current.attachMember(MEMBER)).toEqual({ attached: false, reason: 'nothing-rung-up' });

    const retry = await result.current.commit(order(1, { memberId: MEMBER }));
    const [first, second] = sent();
    // The same sale, the same press: if the first one landed, the platform answers it.
    expect(second).toEqual(first);
    expect(second!.cart.memberId).toBeNull();
    expect(retry).toMatchObject({ ok: true, written: true, saleId: first!.saleId });
    expect(attach).toHaveBeenCalledExactlyOnceWith(first!.saleId, MEMBER);
  });

  it('a member who arrives after the sale’s ids were decided but before they went out still joins that one sale', async () => {
    // The payment screen decides the walk-in sale's ids first (a voucher moves
    // onto them), and only then sends the commit; the deferred member save can
    // land in between.
    const { result } = renderHook(() => useSaleWriter());
    const decided = result.current.prepare(order(1));
    expect(await result.current.attachMember(MEMBER)).toEqual({ attached: false, reason: 'nothing-rung-up' });
    expect(commit).not.toHaveBeenCalled();

    const rungUp = await result.current.commit(order(1));
    expect(rungUp).toMatchObject({ ok: true, written: true, saleId: decided });
    // Confirm, with the cart now naming the member: the same sale, closed — never a second.
    const confirm = await result.current.commit(order(1, { memberId: MEMBER, customerNickname: 'Nok' }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sent()[0]!.cart.memberId).toBeNull();
    expect(confirm).toMatchObject({ ok: true, written: true, replay: true, saleId: decided });
    expect(attach).toHaveBeenCalledExactlyOnceWith(decided, MEMBER);
    expect(result.current.committed).toMatchObject({ id: decided, memberId: MEMBER });
  });

  it('a member never joins a sale rung up for an order since changed', async () => {
    const { result } = renderHook(() => useSaleWriter());
    await result.current.commit(order(1));
    // The order changes and the payment screen decides new ids; the member arrives before they go out.
    const decided = result.current.prepare(order(2));
    expect(await result.current.attachMember(MEMBER)).toEqual({ attached: false, reason: 'nothing-rung-up' });
    expect(attach).not.toHaveBeenCalled();
    await result.current.commit(order(2));
    await result.current.commit(order(2, { memberId: MEMBER }));
    expect(sent().map((args) => args.saleId)).toEqual([expect.any(String), decided]);
    expect(attach).toHaveBeenCalledExactlyOnceWith(decided, MEMBER);
  });

  it('when the platform cannot add the member, the open sale is still the one sale', async () => {
    attach.mockRejectedValueOnce(new NetworkError(new TypeError('Failed to fetch')));
    const { result } = renderHook(() => useSaleWriter());
    await result.current.commit(order(1));
    const joined = await result.current.attachMember(MEMBER);
    expect(joined).toMatchObject({ attached: false, reason: 'refused' });
    const confirm = await result.current.commit(order(1, { memberId: MEMBER }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(confirm).toMatchObject({ ok: true, replay: true, saleId: sent()[0]!.saleId });
  });

  it('a changed ORDER is still a different sale, and it carries the member', async () => {
    const { result } = renderHook(() => useSaleWriter());
    await result.current.commit(order(1));
    await result.current.attachMember(MEMBER);
    await result.current.commit(order(2, { memberId: MEMBER }));
    const [walkIn, corrected] = sent();
    expect(corrected!.saleId).not.toBe(walkIn!.saleId);
    expect(corrected!.cart.memberId).toBe(MEMBER);
  });

  it('with nothing rung up the member simply rides with the cart', async () => {
    const { result } = renderHook(() => useSaleWriter());
    expect(await result.current.attachMember(MEMBER)).toEqual({ attached: false, reason: 'nothing-rung-up' });
    await result.current.commit(order(1, { memberId: MEMBER }));
    expect(sent()[0]!.cart.memberId).toBe(MEMBER);
    expect(attach).not.toHaveBeenCalled();
  });

  it('a new sale forgets the member who joined the last one', async () => {
    const { result } = renderHook(() => useSaleWriter());
    await result.current.commit(order(1));
    await result.current.attachMember(MEMBER);
    result.current.reset();
    await result.current.commit(order(1, { memberId: MEMBER }));
    expect(commit).toHaveBeenCalledTimes(2);
    expect(sent()[1]!.cart.memberId).toBe(MEMBER);
  });
});

describe('both tills hand the saved member to the open sale', () => {
  const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', file), 'utf8');
  it.each(['pages/Till.tsx', 'components/mobile/MobileTill.tsx'])('%s', (file) => {
    const source = read(file);
    expect(source).toMatch(/saveDeferredVerification\([\s\S]*?setMember\(saved\);[\s\S]*?saleWriter\.attachMember\(saved\.id\)/);
  });
});
