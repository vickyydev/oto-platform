import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeSaleAnswer, HeldSale } from '@oto/shared';
import { renderHook } from './support/hooks';
import { apiSale, settle } from './support/fixtures';
import { setBridgeOrigin, setBridgeStaffName } from '@/api/bridge';
import { closedOnBox, laneSale } from '@/api/boxSales';
import { ApiError, NetworkError } from '@/api/client';
import { heldSalesApi } from '@/api/heldSales';
import type { SaleCartPayload, SaleTenderPayload } from '@/api/sales';
import { gateOnlineHold, type GateOnlineHold } from '@/lib/gateOnline';
import { BOX_LANE_NO_HOLD, BOX_SALE_NOT_HELD, holdButtonReasons, useHeldSales } from '@/lib/heldSales';
import {
  currentLane,
  holdPlatformLane,
  noteLaneFailure,
  platformLaneHeld,
  refreshLane,
  saleLane,
  setHeldRetryDelays,
  setLaneStation,
  useSaleLane,
  viaLane,
} from '@/lib/lane';
import { useSaleWriter, type SaleWriteInput } from '@/lib/saleWriter';

/**
 * SCRUM-897 — AFTER AN ONLINE DROP-OFF SALE, WHAT THE TILL DOES FOLLOWS WHERE
 * THE SALE IS, NOT THE LANE.
 *
 * SCRUM-887 made the family's sale stay online after a long internet drop: the
 * drop-off gate wrote the family on the platform, the outage moved the lane to
 * the box through the till's other calls, and the link came back while the
 * box's own status still kept the lane there. Pay, the cash press and the door
 * choice now go online while the gate's hold is carried (`platformLaneHeld`).
 * In that window the lane still says box, and four things read it:
 *
 *   1. the promo code's use was counted on this till, as if the box had taken
 *      the sale — the platform had already counted it when it closed the sale;
 *   2. credit spent on such a sale would go through the box — it cannot: no
 *      screen that spends credit ever carries the gate's hold (evidence below,
 *      nothing changed);
 *   3. the payment step's Hold sale said the till was working through its
 *      counter box, under a sale written online;
 *   4. the Held sales list kept "could not be read" from the outage until its
 *      next 20-second timer, though the platform was answering the till again.
 *
 * The sale writer, the lane arbiter and the box lane run for real here, with
 * `fetch` replaced by a fake platform and a fake counter box.
 */
const subscribed = vi.hoisted(() => ({ stores: [] as Array<(listener: () => void) => () => void> }));
vi.mock('react', async () => ({
  ...(await import('./support/hooks')),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => {
    subscribed.stores.push(subscribe);
    return snapshot();
  },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/api/heldSales', () => ({ heldSalesApi: { list: vi.fn(), hold: vi.fn(), resume: vi.fn() } }));

const STATION = '018f0000-0000-7000-8000-0000000897c1';
const GUARDIAN = '018f0000-0000-7000-8000-0000000897c2';
const BRANCH = '018f0000-0000-7000-8000-0000000897b1';
const intentsUrl = `/api/box/v1/station/${STATION}/intents`;

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

function cart(): SaleCartPayload {
  return {
    branchId: BRANCH,
    stationId: STATION,
    channel: 'till',
    tier: 'tourist',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' },
    memberId: GUARDIAN,
    lines: [
      {
        id: '018f0000-0000-7000-8000-0000000897d1',
        packageId: '018f0000-0000-7000-8000-0000000897d2',
        packageName: '1 Hour Play',
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotalSatang: 54_000,
      },
    ],
    // The code the family used, as the till's copy carries it to either lane.
    promos: [{ code: 'ZZTEST897', label: 'ZZ TEST 10%', type: 'percent', value: 10 }],
    promoCodes: ['ZZTEST897'],
    manualDiscounts: [],
    expectedTotalSatang: 54_000,
  } as SaleCartPayload;
}

const order = (): SaleWriteInput => ({ cart: cart(), finalise: false });
const cash: SaleTenderPayload = { method: 'cash', kind: 'cash', amountSatang: 54_000, tenderedSatang: 60_000, changeSatang: 6_000 };

function boxAnswer(saleId: string): BridgeSaleAnswer {
  return {
    sale: {
      ...apiSale({ id: saleId, stationId: STATION }),
      status: 'finalised',
      receiptNumber: 'T1-000897',
      receiptSeries: 'T1',
      receiptSeq: 897,
      boxId: 'box-1',
      origin: 'box',
    },
    finalised: true,
    outstandingSatang: 0,
    attempt: null,
    replay: false,
    printing: { jobs: [], notes: [] },
    drawer: 'opened',
    outboxDepth: 1,
  } as unknown as BridgeSaleAnswer;
}

/** The platform's sales routes and the counter's box, as the till reaches them. */
class World {
  sales = new Map<string, 'tendering' | 'finalised'>();
  platform: { method: string; path: string }[] = [];
  box: { type: string; payload: Record<string, unknown> }[] = [];
  /** The box has pulled the family: it prices and closes their sale (an ordinary box-lane sale). */
  boxHasFamily = false;
  /** Every platform call reaches nothing (the link is down for the till). */
  linkDown = false;
  /** Drop the link on the cash press only (a sale rung up online, the link gone at the cash press). */
  dropFinalise = false;

  fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url === intentsUrl) {
      const payload = (body.payload ?? {}) as Record<string, unknown>;
      this.box.push({ type: String(body.type), payload });
      if (body.type === 'receipt.observed') return reply({ document: {}, result: {} });
      if (!this.boxHasFamily) return reply({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
      if (body.type === 'cart.quote') {
        return reply({ document: {}, result: { quote: { ...apiSale(), pricingMode: 'weekday', tier: 'tourist', appliedPromos: [] } } });
      }
      return reply({ document: {}, result: boxAnswer(String(payload.saleId)) });
    }
    const p = url.replace(/^\/api/, '');
    if (this.linkDown) throw new TypeError('Failed to fetch');
    if (this.dropFinalise && /\/finalise$/.test(p)) throw new TypeError('Failed to fetch');
    this.platform.push({ method, path: p });
    if (method === 'POST' && p === '/sales') {
      const id = String(body.id);
      if (!this.sales.has(id)) this.sales.set(id, 'tendering');
      return reply({ sale: apiSale({ id, stationId: STATION, status: 'tendering' }), replay: false });
    }
    const fin = /^\/sales\/([^/]+)\/finalise$/.exec(p);
    if (method === 'POST' && fin) {
      const id = decodeURIComponent(fin[1]!);
      this.sales.set(id, 'finalised');
      return reply({
        sale: apiSale({ id, stationId: STATION, status: 'finalised', receiptNumber: 'T1-000898' }),
        replay: false,
        finalised: true,
        outstandingSatang: 0,
      });
    }
    return reply({ error: { code: 'ROUTE_NOT_FOUND', message: `no ${method} ${p}` } }, 404);
  });
}

let world: World;

beforeEach(() => {
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  setBridgeOrigin(null);
  setLaneStation(null);
  setLaneStation(STATION);
  setBridgeStaffName('Nok');
  setHeldRetryDelays([0, 0, 0]);
  world = new World();
  vi.stubGlobal('fetch', world.fetch);
});

afterEach(() => {
  setHeldRetryDelays(null);
  setBridgeOrigin(null);
  setLaneStation(null);
  setBridgeStaffName(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/**
 * The staging proof's point 2 in the gate's own calls (as s887's helper of the
 * same name): the first Continue wrote the family online and ran out of held
 * retries, another call moved the lane to the box, the link came back and
 * Continue again finished the registration online and reached payment. The
 * lane still says box; the gate's hold is carried to the family's sale.
 */
function gateRecoveredAfterLongOutage(): GateOnlineHold {
  const hold = gateOnlineHold(() => undefined);
  hold.beginPress();
  hold.noteWrite();
  hold.endPress();
  noteLaneFailure(new NetworkError());
  hold.beginPress();
  hold.noteWrite();
  hold.carryToSale();
  hold.endPress();
  expect(platformLaneHeld()).toBe(true);
  expect(currentLane()).toBe('box');
  return hold;
}

/** What the box was asked to price or sell (a receipt it was told of is only a notice). */
const boxSales = () => world.box.filter((c) => c.type !== 'receipt.observed');

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

describe('SCRUM-897 (1) — a promo code\'s use is counted on this till only for a sale the counter box closed', () => {
  it('after the long outage the family\'s sale is rung up and closed online while the lane says box: the box did not close it', async () => {
    const hold = gateRecoveredAfterLongOutage();
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true, saleId: rung.saleId });
      expect(world.sales.get(rung.saleId)).toBe('finalised');
      expect(boxSales()).toEqual([]);
      // The lane still says box — the rule the till counted by — yet the
      // platform closed this sale and counted its code on its ledger.
      expect(currentLane()).toBe('box');
      expect(closedOnBox(rung.saleId)).toBe(false);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('an ordinary box-lane sale — the link really down, rung up and closed on the box — is counted on this till, as before', async () => {
    world.linkDown = true;
    world.boxHasFamily = true;
    noteLaneFailure(new NetworkError());
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(laneSale(rung.saleId)?.lane).toBe('box');
      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote', 'sale.finalise']);
      // The box filed the code as applied; the platform counts it when the box hands the sale over.
      expect(boxSales()[0]!.payload).toMatchObject({ promoCodes: ['ZZTEST897'] });
      expect(world.platform).toEqual([]);
      expect(closedOnBox(rung.saleId)).toBe(true);
    } finally {
      unmount();
    }
  });

  it('a sale rung up online whose cash press met a dropped link was closed on the box, and is counted here as before', async () => {
    world.boxHasFamily = true;
    world.dropFinalise = true;
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(laneSale(rung.saleId)?.lane).toBe('platform');
      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
      expect(boxSales().map((c) => c.type)).toEqual(['sale.finalise']);
      expect(closedOnBox(rung.saleId)).toBe(true);
    } finally {
      unmount();
    }
  });

  it('an ordinary online sale is closed by the platform and not counted here, as before', async () => {
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      await result.current.finalise(cash, 'cash-press');
      expect(currentLane()).toBe('platform');
      expect(closedOnBox(rung.saleId)).toBe(false);
    } finally {
      unmount();
    }
  });

  it('both ticket tills decide the local count by where the sale was closed, never by the lane', () => {
    for (const file of ['pages/Till.tsx', 'components/mobile/MobileTill.tsx']) {
      const page = src(file);
      const at = page.indexOf('incrementPromoUsage(d.code');
      expect(at, file).toBeGreaterThan(-1);
      expect(page.match(/incrementPromoUsage\(d\.code/g), file).toHaveLength(1);
      const guard = page.lastIndexOf('if (closedOnBox(saleId)) {', at);
      expect(guard, file).toBeGreaterThan(-1);
      expect(page.slice(guard, at)).not.toMatch(/\r?\n {4}\}/);
      expect(page, file).not.toContain('currentLane()');
    }
  });
});

describe('SCRUM-897 (3) — Hold sale says what is true of the sale on screen', () => {
  const reasonsFor = (saleId: string, boxLane: boolean) =>
    holdButtonReasons({
      saleId,
      online: true,
      boxLane,
      boxSale: laneSale(saleId)?.lane === 'box',
      paymentInProgress: false,
      paidSatang: 0,
      outstandingSatang: 54_000,
      canHold: true,
    });

  it('after the long outage the family\'s sale is online: the sale\'s lane is the platform though the lane says box, and no counter-box note', async () => {
    const hold = gateRecoveredAfterLongOutage();
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(rung).toMatchObject({ ok: true, written: true });
      expect(currentLane()).toBe('box');
      expect(saleLane()).toBe('platform');
      expect(reasonsFor(rung.saleId, saleLane() === 'box')).toEqual({
        hold: null,
        partPaid: 'Take a part payment first — nothing has been paid on this sale yet.',
      });
      // What the lane alone said under Hold sale for this online sale.
      expect(reasonsFor(rung.saleId, currentLane() === 'box').hold).toBe(BOX_LANE_NO_HOLD);
    } finally {
      unmount();
      hold.endSale();
    }
    // The hold released with the written sale: the lane's own rule again.
    expect(saleLane()).toBe('box');
  });

  it('the link really down and no hold: the note stays, and a sale rung up on the box says so, as before', async () => {
    world.linkDown = true;
    world.boxHasFamily = true;
    noteLaneFailure(new NetworkError());
    expect(saleLane()).toBe('box');
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(reasonsFor(rung.saleId, saleLane() === 'box').hold).toBe(BOX_SALE_NOT_HELD);
      expect(reasonsFor('018f0000-0000-7000-8000-0000000897ff', saleLane() === 'box').hold).toBe(BOX_LANE_NO_HOLD);
    } finally {
      unmount();
    }
  });

  it('a hold taken or released is heard by a screen that reads the sale\'s lane', () => {
    noteLaneFailure(new NetworkError());
    const view = renderHook(() => useSaleLane());
    try {
      expect(view.result.current).toBe('box');
      const listener = vi.fn();
      const unsubscribe = subscribed.stores.at(-1)!(listener);
      const release = holdPlatformLane();
      expect(listener).toHaveBeenCalled();
      view.rerender(undefined);
      expect(view.result.current).toBe('platform');
      listener.mockClear();
      release();
      expect(listener).toHaveBeenCalled();
      view.rerender(undefined);
      expect(view.result.current).toBe('box');
      unsubscribe();
    } finally {
      view.unmount();
    }
  });

  it('the counter\'s till reads the sale\'s lane for Hold sale and the Held sales list; the phone till, with no gate, the lane', () => {
    const till = src('pages/Till.tsx');
    expect(till).toContain('const lane = useSaleLane();');
    expect(till).not.toContain('useLane()');
    expect(till.match(/boxLane: lane === 'box',/g)).toHaveLength(2);
    const phone = src('components/mobile/MobileTill.tsx');
    expect(phone).toContain('const lane = useLane();');
    expect(phone).not.toContain('gateOnlineHold');
  });
});

describe('SCRUM-897 (4) — the Held sales list is read again from the platform the moment it answers', () => {
  const list = vi.mocked(heldSalesApi.list);
  const sale: HeldSale = {
    holdId: '018f0000-0000-7000-8000-0000000897e1',
    saleId: '018f0000-0000-7000-8000-0000000897e2',
    branchId: BRANCH,
    kind: 'held',
    label: 'ZZ TEST Khun 897',
    note: null,
    grossSatang: 54_000,
    paidSatang: 0,
    balanceSatang: 54_000,
    businessDate: '2026-11-12',
    heldAt: '2026-11-12T05:00:00.000Z',
    heldBy: { accountId: '018f0000-0000-7000-8000-0000000897a1', name: 'Som' },
    heldStation: { id: STATION, name: 'Reception Till 1' },
    flaggedAt: null,
  };
  const listed = { branchId: BRANCH, sales: [sale], counts: { held: 1, partPaid: 0 } };

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    list.mockReset();
  });

  const mount = () => renderHook(() => useHeldSales({ branchId: BRANCH, enabled: true }));

  it('a read that met no connection is read again as soon as a held call is answered online while the lane still says box', async () => {
    noteLaneFailure(new NetworkError());
    list.mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(listed);
    const view = mount();
    const release = holdPlatformLane();
    try {
      await settle();
      expect(view.result.current.error).toBe('No answer from the platform. This screen has no connection.');
      expect(list).toHaveBeenCalledTimes(1);
      // Continue again after the outage: the gate's write is held on the platform and answered there.
      await expect(viaLane(async () => 'registered online', async () => 'box')).resolves.toBe('registered online');
      expect(currentLane()).toBe('box');
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      expect(view.result.current.error).toBeNull();
      expect(view.result.current.sales).toEqual([sale]);
    } finally {
      view.unmount();
      release();
    }
  });

  it('the sale written online under the hold reads it again too', async () => {
    const hold = gateRecoveredAfterLongOutage();
    list.mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(listed);
    const view = mount();
    const writer = renderHook(() => useSaleWriter());
    try {
      await settle();
      expect(view.result.current.error).not.toBeNull();
      await writer.result.current.commit(order());
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      expect(view.result.current.error).toBeNull();
    } finally {
      writer.unmount();
      view.unmount();
      hold.endSale();
    }
  });

  it('the lane moving back to the platform reads it again', async () => {
    noteLaneFailure(new NetworkError());
    list.mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(listed);
    const view = mount();
    try {
      await settle();
      expect(view.result.current.error).not.toBeNull();
      vi.stubGlobal('fetch', vi.fn(async (url: string) =>
        reply(url === '/api/me' ? { sessionLocked: false } : { link: { up: true, offline: false, lane: 'platform' } })));
      expect(await refreshLane()).toBe('platform');
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      expect(view.result.current.error).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('a call answered on the platform lane reads it again too', async () => {
    list.mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(listed);
    const view = mount();
    try {
      await settle();
      await viaLane(async () => 'online', async () => 'box');
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      expect(view.result.current.error).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('a call the box answers is no sign the platform is back: the list waits for its timer', async () => {
    noteLaneFailure(new NetworkError());
    list.mockRejectedValueOnce(new NetworkError());
    const view = mount();
    try {
      await settle();
      await expect(viaLane(async () => 'online', async () => 'box')).resolves.toBe('box');
      await settle();
      expect(list).toHaveBeenCalledTimes(1);
      expect(view.result.current.error).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('a list the platform refused is not asked again at every answer — only its timer reads it', async () => {
    list.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'You cannot read held sales here'));
    const view = mount();
    try {
      await settle();
      expect(view.result.current.error).toBe('You cannot read held sales here');
      await viaLane(async () => 'online', async () => 'box');
      await viaLane(async () => 'online', async () => 'box');
      await settle();
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it('a list that was read is not read again at every answer, and a screen that has gone hears nothing', async () => {
    list.mockResolvedValue(listed);
    const view = mount();
    await settle();
    await viaLane(async () => 'online', async () => 'box');
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    view.unmount();
    list.mockRejectedValueOnce(new NetworkError());
    const gone = mount();
    await settle();
    gone.unmount();
    await viaLane(async () => 'online', async () => 'box');
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
