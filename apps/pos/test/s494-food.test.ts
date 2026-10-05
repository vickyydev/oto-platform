import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BandStayView } from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { buildItemCartPayload, offLedgerOnly } from '@/api/sales';
import { bandFoodOf, wristbandOfScan, type ApiBandScan } from '@/api/wallet';
import { loadScannedTab } from '@/components/fnb/ScanWristband';
import { FoodSafetyBanner } from '@/components/fnb/FoodSafetyBanner';
import { bandHolderOf, withPrepaidServed } from '@/lib/bandFood';
import { engineItemLines, itemCart } from '@/lib/cartWire';
import type { FnbOrderLine, MenuItem, Wristband } from '@/types';

/**
 * SCRUM-494 (food) — the counter's side of the band's child: the scan carries
 * the stay's safety data and prepaid items onto the tab, a prepaid line goes to
 * the platform at ฿0 naming its stay, the order names its band holder, and the
 * till's copy of the band shows what the platform served.
 */

beforeEach(() => {
  vi.restoreAllMocks();
});

const STAY = '01a0fbf8-25d9-7800-be56-dee3f96587cb';
const HOTDOG = '01a0fbf8-25d9-7800-be56-000000000001';

const stay = (over: Partial<BandStayView> = {}): BandStayView => ({
  checkinId: STAY,
  branchId: 'b',
  childName: 'Kai',
  allergiesMedical: 'Peanuts; EpiPen in bag',
  foodRestrictions: 'No nuts',
  mayOrderFood: true,
  foodProvision: {
    mode: 'prepaid_items',
    paidSatang: 11_000,
    creditSatang: null,
    items: [{ menuItemId: HOTDOG, menuItemName: 'Hot Dog', unitSatang: 11_000, qty: 1, redeemedQty: 0 }],
  },
  ...over,
});

const hotdog: MenuItem = { id: HOTDOG, name: 'Hot Dog', category: 'food', price: { weekday: 110, weekend: 110 } } as MenuItem;

const prepaidLine = (over: Partial<FnbOrderLine> = {}): FnbOrderLine => ({
  id: 'line-1',
  menuItem: hotdog,
  qty: 1,
  selectedModifiers: [],
  lineTotal: 0,
  isPrepaid: true,
  prepaidStayId: STAY,
  ...over,
});

describe('s494 — the scan carries the child’s stay onto the tab', () => {
  it('a band with no wallet: a ฿0 tab with the allergy alert, the consent and the prepaid items', () => {
    const read: ApiBandScan = { wallet: null, ledger: [], stay: stay() };
    const tab = wristbandOfScan(read, ' T1-7KMQ4X ')!;
    expect(tab).toMatchObject({
      id: STAY,
      code: 'T1-7KMQ4X',
      creditBalanceTHB: 0,
      holderName: 'Kai',
      allergiesMedical: 'Peanuts; EpiPen in bag',
      foodRestrictions: 'No nuts',
      mayOrderFood: true,
      stayId: STAY,
      foodProvision: { mode: 'prepaid_items', paidTHB: 110, items: [{ menuItemId: HOTDOG, unitPriceTHB: 110, qty: 1, redeemedQty: 0 }] },
    });
    expect(wristbandOfScan({ wallet: null, ledger: [], stay: null }, 'x')).toBeNull();
  });

  it('a prepaid-credit child: the wallet’s credit beside the stay’s food', () => {
    const wallet = { id: 'w', status: 'active', balanceSatang: 15_000, expiresAt: null, lapsedSatang: 0, holderName: 'Mia', memberId: null,
      branchId: 'b', keys: [], createdAt: '' } as unknown as ApiBandScan['wallet'];
    const tab = wristbandOfScan({ wallet, ledger: [], stay: stay({ childName: 'Mia', foodProvision: { mode: 'prepaid_credit', paidSatang: 15_000, creditSatang: 15_000, items: [] } }) }, 'k')!;
    expect(tab).toMatchObject({ id: 'w', creditBalanceTHB: 150, holderName: 'Mia', foodProvision: { mode: 'prepaid_credit', creditAmountTHB: 150 } });
    expect(tab.foodProvision?.items).toBeUndefined();
  });

  it('a child whose parent authorised no food reads mayOrderFood false', () => {
    expect(bandFoodOf(stay({ mayOrderFood: false, foodProvision: null }))).toMatchObject({ mayOrderFood: false, stayId: STAY });
  });

  it('shows a food restriction even when the child has no allergy note', () => {
    const tab = wristbandOfScan({ wallet: null, ledger: [], stay: stay({ allergiesMedical: null, foodRestrictions: 'No shellfish' }) }, 'k')!;
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(createElement(FoodSafetyBanner, { wristband: tab, compact }));
      expect(html).toContain('Food restriction');
      expect(html).toContain('Restriction: No shellfish');
      expect(html).not.toContain('Allergy / medical alert');
    }
    const clear = wristbandOfScan({ wallet: null, ledger: [], stay: stay({ allergiesMedical: null, foodRestrictions: null }) }, 'k')!;
    expect(renderToStaticMarkup(createElement(FoodSafetyBanner, { wristband: clear }))).toBe('');
  });

  it('loadScannedTab asks the counter scan and opens the stay’s tab', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ wallet: null, ledger: [], stay: stay() });
    const found = await loadScannedTab('T1-7KMQ4X');
    expect(String(get.mock.calls[0]![0])).toContain('/wallets/scan?key=T1-7KMQ4X');
    expect(found.error).toBeNull();
    expect(found.wristband).toMatchObject({ stayId: STAY, allergiesMedical: 'Peanuts; EpiPen in bag' });
  });

  it('a demo band the platform does not know opens with no prepaid items to serve', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'WALLET_NOT_FOUND', 'No wallet'));
    const found = await loadScannedTab('1007');
    expect(found.wristband).toMatchObject({ code: '1007', foodProvision: { mode: 'prepaid_items', items: [] } });
    expect(found.wristband?.stayId).toBeUndefined();
  });
});

describe('s494 — the order the platform receives', () => {
  it('a prepaid line from a stay goes to the platform at ฿0, naming the stay, with no options', () => {
    const [wire] = itemCart([prepaidLine()]);
    expect(wire).toMatchObject({ productId: HOTDOG, quantity: 1, modifiers: [], lineTotalSatang: 0, prepaid: { checkinId: STAY } });
    expect(offLedgerOnly([prepaidLine()])).toBeNull();
    // Priced at ฿0 on this device too: it is no base for a code here.
    expect(engineItemLines([prepaidLine()])).toEqual([]);
  });

  it('a prepaid line with no platform stay stays off the ledger and says so', () => {
    const local = prepaidLine({ prepaidStayId: undefined });
    expect(itemCart([local])).toEqual([]);
    expect(offLedgerOnly([local])).toContain('scan the band again');
  });

  it('the cart names the band holder and the food-consent override', () => {
    const tab = { id: 'w', code: 'k', customerNickname: 'Kai', creditBalanceTHB: 0, gateAccess: false, stayId: STAY } as Wristband;
    expect(bandHolderOf(tab, null)).toEqual({ checkinId: STAY });
    expect(bandHolderOf(tab, { byId: 'a', byName: 'Som', at: '' })).toEqual({ checkinId: STAY, foodOverride: true });
    expect(bandHolderOf({ ...tab, stayId: undefined }, null)).toBeNull();
    const payload = buildItemCartPayload([prepaidLine()], [], {
      branchId: 'b', stationId: 's', tier: 'tourist', channel: 'fnb', accountId: 'a', accountName: 'Som',
      bandHolder: bandHolderOf(tab, { byId: 'a', byName: 'Som', at: '' }),
    }, 0);
    expect(payload.bandHolder).toEqual({ checkinId: STAY, foodOverride: true });
    expect(payload.items?.[0]?.prepaid).toEqual({ checkinId: STAY });
    expect(payload.expectedTotalSatang).toBe(0);
  });
});

describe('s494 — the till’s copy of the band after the platform served it', () => {
  it('raises the served count, never past what was paid, and only for this band’s stay', () => {
    const tab = wristbandOfScan({ wallet: null, ledger: [], stay: stay() }, 'k')!;
    const served = withPrepaidServed(tab, [prepaidLine(), prepaidLine({ id: 'line-2' })]);
    expect(served.foodProvision?.items?.[0]?.redeemedQty).toBe(1);
    const other = withPrepaidServed(tab, [prepaidLine({ prepaidStayId: 'another-stay' })]);
    expect(other.foodProvision?.items?.[0]?.redeemedQty).toBe(0);
  });
});
