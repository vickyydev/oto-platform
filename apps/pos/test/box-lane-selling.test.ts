import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeSaleAnswer, BridgeSaleBand } from '@oto/shared';
import { renderHook } from './support/hooks';
import { apiSale } from './support/fixtures';
import { paymentsApi } from '@/api/payments';
import { setBridgeStaffName } from '@/api/bridge';
import { boxSaleIssue, laneSale } from '@/api/boxSales';
import type { SaleCartPayload, SaleTenderPayload } from '@/api/sales';
import { currentLane, setLaneStation } from '@/lib/lane';
import { useSaleWriter, type SaleWriteInput } from '@/lib/saleWriter';

/**
 * SELLING ON THE BOX LANE, THE TILL'S HALF — `lib/saleWriter.ts` and
 * `api/boxSales.ts` (offline plan §2.4, Round 4).
 *
 * The same input that commits to the platform commits through the box when the
 * lane arbiter says box; a sale stays on the lane it was rung up on; cash is the
 * one tender that moves lanes mid-sale, under the same ids; an electronic
 * tender never does. `fetch` is stubbed at the boundary, so every path asserted
 * is a path the till would call, platform (`/api/sales…`) and bridge
 * (`/api/box/v1/station/:id/intents`) alike.
 */
vi.mock('react', () => import('./support/hooks'));

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const intentsUrl = `/api/box/v1/station/${STATION}/intents`;

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
const forcedOffline = () =>
  reply(
    { error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } },
    503,
  );

function cart(): SaleCartPayload {
  return {
    branchId: 'branch-1',
    stationId: STATION,
    channel: 'till',
    tier: 'tourist',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' },
    lines: [
      {
        id: '018f0000-0000-7000-8000-0000000011e1',
        packageId: '018f0000-0000-7000-8000-00000000aa01',
        packageName: '2 Hours Play',
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotalSatang: 54_000,
      },
    ],
    promos: [],
    manualDiscounts: [],
    expectedTotalSatang: 54_000,
  };
}

const order = (): SaleWriteInput => ({ cart: cart(), finalise: false });

const cash: SaleTenderPayload = {
  method: 'cash',
  kind: 'cash',
  amountSatang: 54_000,
  tenderedSatang: 60_000,
  changeSatang: 6_000,
};

const boxQuote = { quote: { ...apiSale(), pricingMode: 'weekday', tier: 'tourist', lineTotals: {}, manualAmounts: {}, appliedPromos: [], taxBreakdown: {} } };

function boxAnswer(saleId: string, over: Partial<BridgeSaleAnswer> = {}): BridgeSaleAnswer {
  const sale = apiSale({ id: saleId, stationId: STATION });
  return {
    sale: {
      ...sale,
      status: 'finalised',
      receiptNumber: 'T1-000043',
      receiptSeries: 'T1',
      receiptSeq: 43,
      boxId: 'box-1',
      origin: 'box',
      pricingMode: 'weekday',
    },
    finalised: true,
    outstandingSatang: 0,
    attempt: null,
    replay: false,
    printing: { jobs: [{ id: 'job-1', kind: 'receipt', status: 'printed' }], notes: [] },
    drawer: 'opened',
    outboxDepth: 1,
    ...over,
  };
}

interface Seen {
  url: string;
  body: Record<string, unknown> | null;
}

/** The fetch stub: `routes` answers by URL and, for the bridge, by intent type. */
function stubFetch(routes: {
  platform?: (url: string, body: Record<string, unknown> | null) => Response | Promise<Response>;
  bridge?: (type: string, payload: Record<string, unknown>) => Response | Promise<Response>;
}) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    seen.push({ url, body });
    if (url === intentsUrl) {
      const intent = body as { type: string; payload: Record<string, unknown> };
      return routes.bridge ? routes.bridge(intent.type, intent.payload) : reply({}, 500);
    }
    return routes.platform ? routes.platform(url, body) : forcedOffline();
  });
  vi.stubGlobal('fetch', fetch);
  return seen;
}

const bridgeCalls = (seen: Seen[]) =>
  seen.filter((s) => s.url === intentsUrl).map((s) => s.body as { type: string; payload: Record<string, unknown> });

beforeEach(() => {
  setLaneStation(null);
  setLaneStation(STATION);
  setBridgeStaffName('Nok');
});

afterEach(() => {
  setLaneStation(null);
  setBridgeStaffName(null);
  vi.unstubAllGlobals();
});

describe('the box lane in the sale writer', () => {
  it('rings the sale up on the box when the platform refuses the station, and closes it there with cash', async () => {
    const seen = stubFetch({
      bridge: (type, payload) =>
        type === 'cart.quote'
          ? reply({ document: {}, result: boxQuote })
          : reply({ document: {}, result: boxAnswer(String(payload.saleId)) }),
    });
    const { result } = renderHook(() => useSaleWriter());
    const rung = await result.current.commit(order());
    expect(rung).toMatchObject({ ok: true, written: true });
    expect(currentLane()).toBe('box');
    expect(result.current.state).toMatchObject({ kind: 'committed' });

    const paid = await result.current.finalise(cash, 'cash-press');
    expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
    expect(paid.ok && paid.written && paid.sale.receiptNumber).toBe('T1-000043');
    expect(result.current.state).toMatchObject({ kind: 'written' });

    const calls = bridgeCalls(seen);
    expect(calls.map((c) => c.type)).toEqual(['cart.quote', 'sale.finalise']);
    const finalise = calls[1]!.payload;
    expect(finalise.saleId).toBe(rung.saleId);
    expect(finalise.staffName).toBe('Nok');
    expect(finalise.cart).toEqual(cart());
    expect(finalise.tender).toMatchObject({ actionId: 'cash-press', method: 'cash', kind: 'cash', amountSatang: 54_000 });
    // Only the one refused commit ever went to the platform.
    expect(seen.filter((s) => s.url.startsWith('/api/sales'))).toHaveLength(1);
  });

  it('a sale rung up online whose cash press meets a dropped link closes on the box, under the same ids', async () => {
    const seen = stubFetch({
      platform: (url, body) => {
        if (url === '/api/sales') return reply({ sale: apiSale({ id: String(body!.id), stationId: STATION }), replay: false });
        throw new TypeError('Failed to fetch');
      },
      bridge: (_type, payload) => reply({ document: {}, result: boxAnswer(String(payload.saleId)) }),
    });
    const { result } = renderHook(() => useSaleWriter());
    const rung = await result.current.commit(order());
    expect(laneSale(rung.saleId)?.lane).toBe('platform');
    const paid = await result.current.finalise(cash, 'cash-press');
    expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
    const [finalise] = bridgeCalls(seen).filter((c) => c.type === 'sale.finalise');
    const commitBody = seen.find((s) => s.url === '/api/sales')!.body!;
    expect(finalise!.payload.saleId).toBe(commitBody.id);
    expect(finalise!.payload.actionId).toBe(commitBody.actionId);
    expect(finalise!.payload.occurredAt).toBe(commitBody.occurredAt);
    expect(currentLane()).toBe('box');
  });

  it('shows the box-minted band codes on the confirmation for a platform-rung sale closed on the box (offline finding 3)', async () => {
    const lineId = cart().lines[0]!.id;
    const bandsFor = (): BridgeSaleBand[] => [
      { id: 'band-kid', kind: 'kid', status: 'active', shortCode: 'T1-7KMQ4X', cartLineId: lineId, saleLineId: 'line-1', childId: 'child-ploy', childName: 'Ploy' },
      { id: 'band-adult', kind: 'adult', status: 'active', shortCode: 'T1-9Z2PLM', cartLineId: lineId, saleLineId: 'line-1', childId: null, childName: null },
    ];
    const seen = stubFetch({
      platform: (url, body) => {
        // Rings up online, then the cash press meets a dropped link.
        if (url === '/api/sales') return reply({ sale: apiSale({ id: String(body!.id), stationId: STATION }), replay: false });
        throw new TypeError('Failed to fetch');
      },
      bridge: (_type, payload) =>
        reply({ document: {}, result: boxAnswer(String(payload.saleId), { bands: bandsFor() }) }),
    });
    const { result } = renderHook(() => useSaleWriter());
    const rung = await result.current.commit(order());
    // The sale was rung up on the platform lane, yet it closes on the box.
    expect(laneSale(rung.saleId)?.lane).toBe('platform');
    const paid = await result.current.finalise(cash, 'cash-press');
    expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
    expect(currentLane()).toBe('box');

    // The confirmation still reads the box's codes though the lane says platform.
    const issue = boxSaleIssue(rung.saleId);
    expect(issue).not.toBeNull();
    expect(issue!.receiptNumber).toBe('T1-000043');
    expect(issue!.bands).toEqual([
      { id: 'band-kid', kind: 'kid', status: 'active', shortCode: 'T1-7KMQ4X', saleLineId: 'line-1', childId: 'child-ploy', childName: 'Ploy', printedJobId: null, createdAt: '2026-09-25T04:10:00.000Z' },
      { id: 'band-adult', kind: 'adult', status: 'active', shortCode: 'T1-9Z2PLM', saleLineId: 'line-1', childId: null, childName: null, printedJobId: null, createdAt: '2026-09-25T04:10:00.000Z' },
    ]);
    // The bracelet rows the bands sit on, deduped by ledger line, for `bandsByCartLine`.
    expect(issue!.lines).toEqual([{ id: 'line-1', cartLineId: lineId }]);
    // Only the one refused commit ever reached the platform's sale endpoint.
    expect(seen.filter((s) => s.url === '/api/sales')).toHaveLength(1);
  });

  it('after an online sale the till tells its box the number the platform gave it (OD-4)', async () => {
    const seen = stubFetch({
      platform: (url, body) =>
        url === '/api/sales'
          ? reply({ sale: apiSale({ id: String(body!.id), stationId: STATION }), replay: false })
          : reply({ sale: apiSale({ status: 'finalised', receiptNumber: 'T1-000077', stationId: STATION }), replay: false, finalised: true }),
      bridge: () => reply({ document: {}, result: { observed: { prefix: 'T1', seq: 77 } } }),
    });
    const { result } = renderHook(() => useSaleWriter());
    await result.current.commit(order());
    await result.current.finalise(cash, 'cash-press');
    await vi.waitFor(() => expect(bridgeCalls(seen)).toHaveLength(1));
    expect(bridgeCalls(seen)[0]).toMatchObject({ type: 'receipt.observed', payload: { receiptNumber: 'T1-000077' } });
  });

  it('a card on a box-lane sale goes to the counter’s terminal through the box, and its answer closes the sale', async () => {
    let saleId = '';
    const seen = stubFetch({
      bridge: (type, payload) => {
        if (type === 'cart.quote') return reply({ document: {}, result: boxQuote });
        saleId = String(payload.saleId);
        return reply({
          document: {},
          result: boxAnswer(saleId, {
            attempt: {
              id: 'attempt-box', saleId, method: 'card', provider: 'ghl', status: 'approved',
              amountSatang: 54_000, tenderedSatang: null, changeSatang: null, terminalRef: 'r',
              tid: '65703235', approvalCode: '123456', last4: '4242', invoiceNo: null, tranRef: null,
              actionId: 'card-press', offline: true, paidAt: null, createdAt: '2026-09-25T04:10:00.000Z',
            },
            drawer: 'not_asked',
          }),
        });
      },
    });
    const { result } = renderHook(() => useSaleWriter());
    const rung = await result.current.commit(order());
    const started = await paymentsApi.start({
      saleId: rung.saleId, actionId: 'card-press', tender: 'card', method: 'card', kind: 'card', amountSatang: 54_000,
    });
    expect(started).toMatchObject({ route: 'card_terminal', outstandingSatang: 0 });
    expect(started.attempt?.status).toBe('approved');
    // The payment stage then closes the sale: answered from what the box said, no second request.
    const before = seen.length;
    const closed = await result.current.finalise(undefined, 'close');
    expect(closed).toMatchObject({ ok: true, written: true, finalised: true });
    expect(seen.length).toBe(before);
    // A read of the attempt goes back to the box that holds it.
    stubFetch({ bridge: () => reply({ document: {}, result: boxAnswer(saleId, { attempt: started.attempt }) }) });
    const read = await paymentsApi.read('attempt-box');
    expect(read.attempt.id).toBe('attempt-box');
  });

  it('an electronic tender on a sale rung up online is never moved to the box (plan §2.1)', async () => {
    const seen = stubFetch({
      platform: (url, body) => {
        if (url === '/api/sales') return reply({ sale: apiSale({ id: String(body!.id), stationId: STATION }), replay: false });
        return forcedOffline();
      },
    });
    const { result } = renderHook(() => useSaleWriter());
    const rung = await result.current.commit(order());
    await expect(
      paymentsApi.start({ saleId: rung.saleId, actionId: 'card', tender: 'card', method: 'card', kind: 'card' }),
    ).rejects.toMatchObject({ code: 'STATION_FORCED_OFFLINE' });
    expect(bridgeCalls(seen)).toEqual([]);
  });

  it('cancelling a sale rung up on the box lets the order go without asking anybody', async () => {
    const seen = stubFetch({ bridge: () => reply({ document: {}, result: boxQuote }) });
    const { result } = renderHook(() => useSaleWriter());
    const rung = await result.current.commit(order());
    const before = seen.length;
    expect(await result.current.cancel('Guest left')).toEqual({ ok: true, voided: true });
    expect(seen.length).toBe(before);
    expect(laneSale(rung.saleId)).toBeNull();
  });
});
