import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHECKIN_INTENTS, BRIDGE_WALLET_INTENTS, type BandStayView, type BridgeWalletBalance } from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { answeredByBox, bridgeApi } from '@/api/bridge';
import { currentLane, setLaneStation } from '@/lib/lane';
import { quoteErrorOf, type QuoteError } from '@/lib/cartQuote';
import { loadScannedTab } from '@/components/fnb/ScanWristband';
import { QuoteRefusalNote } from '@/components/fnb/QuoteRefusalNote';
import { FnbCart } from '@/components/fnb/FnbCart';
import type { FnbOrderLine, MenuItem } from '@/types';

/**
 * SCRUM-503 — three walkthrough findings on the counter's own screens:
 *
 *   4  the Console's Go offline switch covers the band scan: the platform
 *      refuses it (`503 STATION_FORCED_OFFLINE`) and the till reads the band on
 *      its box, as it does in a real outage;
 *   5  a refusal the counter's BOX gave names the counter's box, not the
 *      platform — the refusal's own words after it are unchanged;
 *   6  a prepaid meal's name on the order panel is drawn in the panel's own
 *      ink, as the lines beside it are, not pale violet on a pale tint.
 */

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.restoreAllMocks();
});
afterEach(() => {
  setLaneStation(null);
  vi.unstubAllGlobals();
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

// --- 4 ---------------------------------------------------------------------------------

describe('4 — the Go offline switch covers the band scan', () => {
  const KEY = 'T1-7KMQ4X';
  const stay: BandStayView = {
    checkinId: '01a0f899-49d8-70f6-81d8-52e8e5c21400',
    branchId: 'b',
    childName: 'Mint',
    allergiesMedical: 'Peanuts',
    foodRestrictions: null,
    mayOrderFood: true,
    foodProvision: {
      mode: 'prepaid_items',
      paidSatang: 8_000,
      creditSatang: null,
      items: [{ menuItemId: 'hotdog', menuItemName: 'Hot dog', unitSatang: 8_000, qty: 1, redeemedQty: 0 }],
    },
  };
  const wallet: BridgeWalletBalance = {
    walletId: '01a0f899-49d8-70f6-81d8-52e8e5c213ff', balanceSatang: 10_000, capLeftSatang: 30_000, capSatang: 30_000,
    spendableSatang: 10_000, snapshotAt: '2026-10-07T03:00:00.000Z', source: 'snapshot',
  };

  it('the platform’s forced-offline answer moves the scan to the box, which reads the stay and the credit', async () => {
    setLaneStation('station-1');
    const get = vi.spyOn(api, 'get').mockRejectedValue(
      new ApiError(503, 'STATION_FORCED_OFFLINE', 'This station is forced offline for testing.'),
    );
    const intent = vi.spyOn(bridgeApi, 'intent')
      .mockResolvedValueOnce({ document: {} as never, result: { stay, cacheAppliedAt: '2026-10-07T03:00:00.000Z' } })
      .mockResolvedValueOnce({ document: {} as never, result: { wallet } });
    const found = await loadScannedTab(KEY);
    expect(get).toHaveBeenCalledTimes(1);
    expect(intent).toHaveBeenCalledWith('station-1', BRIDGE_CHECKIN_INTENTS.bandFood, { key: KEY });
    expect(intent).toHaveBeenCalledWith('station-1', BRIDGE_WALLET_INTENTS.lookup, { key: KEY });
    expect(currentLane()).toBe('box');
    expect(found.error).toBeNull();
    expect(found.wristband).toMatchObject({ stayId: stay.checkinId, holderName: 'Mint', allergiesMedical: 'Peanuts', creditBalanceTHB: 100 });
  });

  it('once on the box, the next scan asks the box and not the platform', async () => {
    setLaneStation('station-1');
    vi.spyOn(api, 'get').mockRejectedValueOnce(new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced'));
    vi.spyOn(bridgeApi, 'intent').mockResolvedValue({ document: {} as never, result: { stay: null, cacheAppliedAt: null, wallet } });
    await loadScannedTab(KEY);
    const get = vi.spyOn(api, 'get');
    await loadScannedTab(KEY);
    expect(get).not.toHaveBeenCalled();
  });
});

// --- 5 ---------------------------------------------------------------------------------

describe('5 — a refusal names who gave it', () => {
  const USED_UP = "Mint's prepaid Hot dog has already been served.";

  it('a refusal that came back from the counter’s box is marked as the box’s; the platform’s is not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'PREPAID_USED_UP', message: USED_UP } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })));
    const refused = await bridgeApi.intent('station-1', 'cart.quote', {}).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ApiError);
    expect(answeredByBox(refused)).toBe(true);
    expect(quoteErrorOf(refused, 'x')).toEqual({ kind: 'refusal', status: 409, code: 'PREPAID_USED_UP', message: USED_UP, answeredBy: 'box' });

    const platform = new ApiError(409, 'PREPAID_USED_UP', USED_UP);
    expect(answeredByBox(platform)).toBe(false);
    expect(quoteErrorOf(platform, 'x')).toEqual({ kind: 'refusal', status: 409, code: 'PREPAID_USED_UP', message: USED_UP });
  });

  it('the note leads with the counter’s box when the box refused, and keeps the refusal’s own words', () => {
    const fromBox: QuoteError = { kind: 'refusal', status: 409, code: 'PREPAID_USED_UP', message: USED_UP, answeredBy: 'box' };
    const out = html(React.createElement(QuoteRefusalNote, { error: fromBox, blocking: true }));
    expect(out).toContain('This counter’s box refused this order:</span> ' + USED_UP);
    expect(out).not.toContain('The platform refused');
    expect(out).toContain('Fix this to charge — the sale would be refused for the same reason.');
  });

  it('a refusal the platform gave still says the platform', () => {
    const fromPlatform: QuoteError = { kind: 'refusal', status: 409, code: 'PREPAID_USED_UP', message: USED_UP };
    const out = html(React.createElement(QuoteRefusalNote, { error: fromPlatform }));
    expect(out).toContain('The platform refused this order:</span> ' + USED_UP);
    expect(out).not.toContain('counter’s box');
  });
});

// --- 6 ---------------------------------------------------------------------------------

describe('6 — a prepaid meal’s name on the order panel is legible', () => {
  const item = (id: string, name: string): MenuItem => ({ id, name, price: 80, category: 'food' }) as unknown as MenuItem;
  const lines: FnbOrderLine[] = [
    { id: 'l-1', menuItem: item('juice', 'Juice'), qty: 1, selectedModifiers: [], lineTotal: 50 },
    { id: 'l-2', menuItem: item('hotdog', 'Hot dog'), qty: 1, selectedModifiers: [], lineTotal: 0, isPrepaid: true, prepaidStayId: 's' },
  ];
  const noop = () => undefined;
  const panel = () =>
    html(React.createElement(FnbCart, {
      wristband: null, lines, total: 50, manualDiscounts: [], manualAmounts: {},
      taxBreakdown: { netSubtotal: 50, discountTotal: 0, serviceChargeTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, categories: [], grandTotal: 50 },
      onChangeQty: noop, onEditLine: noop, onClear: noop, onCheckout: noop, onSwitchTab: noop,
      onAddManualDiscount: noop, onRemoveManualDiscount: noop,
    }));

  it('the prepaid name takes the panel’s own ink, with the prototype’s violet kept for a dark surface', () => {
    const out = panel();
    const prepaid = /<span class="([^"]*)">Hot dog<\/span>/.exec(out)?.[1]?.split(' ') ?? [];
    expect(prepaid).toEqual(expect.arrayContaining(['truncate', 'text-foreground', 'dark:text-violet-100']));
    expect(prepaid).not.toContain('text-violet-100');
    // Its sibling line's name: the same ink, by inheritance.
    expect(out).toMatch(/<span class="truncate">Juice<\/span>/);
    // The prepaid look itself is unchanged: the tinted row, the gift, the badge and the ฿0.
    expect(out).toContain('bg-violet-500/10 border-violet-500/40');
    expect(out).toContain('Already paid at check-in');
    expect(out).toMatch(/Prepaid\s*<\/span>/);
  });
});
