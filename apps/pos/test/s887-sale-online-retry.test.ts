import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { apiSale } from './support/fixtures';
import { setBridgeOrigin, setBridgeStaffName } from '@/api/bridge';
import { NetworkError } from '@/api/client';
import type { SaleCartPayload, SaleTenderPayload } from '@/api/sales';
import {
  GATE_RETRYING,
  GATE_SALE_BOX_NOT_SYNCED,
  GATE_SALE_RETRYING,
  gateOnlineHold,
  gateSaleFailure,
  type GateOnlineHold,
  type GateRetryWords,
} from '@/lib/gateOnline';
import { currentLane, platformLaneHeld, setHeldRetryDelays, setLaneStation, viaLane } from '@/lib/lane';
import { useSaleWriter, type SaleWriteInput, type SaleWriteState } from '@/lib/saleWriter';

/**
 * SCRUM-887 — THE SAME DROP ONE SCREEN LATER: THE FAMILY'S SALE.
 *
 * The drop-off gate writes a walk-in's guardian and children online. Seconds
 * later the family's sale is rung up. A dropped link at Pay or at the cash
 * press used to move the sale to the counter's box, which has not pulled the
 * guardian yet (its copy refreshes once a minute) and refuses the cart with
 * "Member not found": the family stood at the desk again. The gate's hold is
 * now carried to that sale (`carryToSale`), so the drop is tried again online
 * under the sale's own ids; the hold ends when the sale is written, the cart
 * is cleared, or the held retries run out.
 *
 * These drive the real sale writer (`lib/saleWriter.ts`) with `fetch` replaced
 * by a fake platform and a fake box that refuses a member it has not pulled,
 * as `station-bridge.ts` does (pricing and finalise both answer 404).
 */
vi.mock('react', () => import('./support/hooks'));

const STATION = '018f0000-0000-7000-8000-0000000887c1';
const GUARDIAN = '018f0000-0000-7000-8000-0000000887c2';
const intentsUrl = `/api/box/v1/station/${STATION}/intents`;

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

function cart(): SaleCartPayload {
  return {
    branchId: 'branch-1',
    stationId: STATION,
    channel: 'till',
    tier: 'tourist',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    socks: { addOnId: 'a-socks', unitSatang: 5_000, label: 'Regular Socks' },
    memberId: GUARDIAN,
    lines: [
      {
        id: '018f0000-0000-7000-8000-0000000887d1',
        packageId: '018f0000-0000-7000-8000-0000000887d2',
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

const cash: SaleTenderPayload = { method: 'cash', kind: 'cash', amountSatang: 54_000, tenderedSatang: 60_000, changeSatang: 6_000 };
const card: SaleTenderPayload = { method: 'card', kind: 'card', amountSatang: 54_000 };

/** The platform's sales routes and the counter's box, as the till reaches them. */
class World {
  sales = new Map<string, { id: string; status: 'tendering' | 'finalised' }>();
  platform: { method: string; path: string; body: Record<string, unknown> }[] = [];
  box: { type: string; payload: Record<string, unknown> }[] = [];
  /** Drop the link on the listed calls (1-based) to a path, before it reaches the platform. */
  drops: { path: RegExp; at: number[]; seen?: number }[] = [];

  fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url === intentsUrl) {
      const payload = (body.payload ?? {}) as Record<string, unknown>;
      this.box.push({ type: String(body.type), payload });
      // The box has not pulled the guardian the gate wrote seconds ago.
      return reply({ error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
    }
    const path = url.replace(/^\/api/, '');
    const drop = this.drops.find((d) => {
      if (!d.path.test(`${method} ${path}`)) return false;
      d.seen = (d.seen ?? 0) + 1;
      return d.at.includes(d.seen);
    });
    if (drop) throw new TypeError('Failed to fetch');
    this.platform.push({ method, path, body });
    if (method === 'POST' && path === '/sales') {
      const id = String(body.id);
      const replay = this.sales.has(id);
      if (!replay) this.sales.set(id, { id, status: 'tendering' });
      return reply({ sale: apiSale({ id, stationId: STATION, status: 'tendering' }), replay });
    }
    const fin = /^\/sales\/([^/]+)\/finalise$/.exec(path);
    if (method === 'POST' && fin) {
      const sale = this.sales.get(decodeURIComponent(fin[1]!))!;
      const replay = sale.status === 'finalised';
      sale.status = 'finalised';
      return reply({
        sale: apiSale({ id: sale.id, stationId: STATION, status: 'finalised', receiptNumber: 'T1-000887' }),
        replay,
        finalised: true,
        outstandingSatang: 0,
      });
    }
    return reply({ error: { code: 'ROUTE_NOT_FOUND', message: `no ${method} ${path}` } }, 404);
  });
}

let world: World;
let said: GateRetryWords[];

beforeEach(() => {
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  setBridgeOrigin(null);
  setLaneStation(null);
  setLaneStation(STATION);
  setBridgeStaffName('Nok');
  setHeldRetryDelays([0, 0, 0]);
  world = new World();
  said = [];
  vi.stubGlobal('fetch', world.fetch);
});

afterEach(() => {
  setHeldRetryDelays(null);
  setBridgeOrigin(null);
  setLaneStation(null);
  setBridgeStaffName(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * A drop-off gate press that wrote the guardian online and reached payment,
 * in `resolveSupervisionGate`'s order (`pages/Till.tsx`).
 */
function gateFinishedOnline(): GateOnlineHold {
  const hold = gateOnlineHold((words) => said.push(words));
  hold.beginPress();
  hold.noteWrite(); // the guardian, answered on the platform
  hold.carryToSale(); // setSupervisionResolved(true)
  hold.endPress(); // handleSupervisionContinue's finally
  return hold;
}

/** What the box was asked to sell (a receipt the till saw is only a notice to it). */
const boxSales = () => world.box.filter((c) => c.type !== 'receipt.observed');
const salePosts = () => world.platform.filter((c) => c.path === '/sales');
const finalisePosts = () => world.platform.filter((c) => c.path.endsWith('/finalise'));

describe('SCRUM-887: the family\'s sale after a gate that wrote online', () => {
  it('the gate carries its hold to the sale', () => {
    const hold = gateFinishedOnline();
    expect(hold.startedOnline).toBe(true);
    expect(platformLaneHeld()).toBe(true);
    hold.endSale();
    expect(platformLaneHeld()).toBe(false);
  });

  it('Pay dropped once: the sale is retried online under the same id, the box is never asked, one sale is written', async () => {
    const hold = gateFinishedOnline();
    world.drops.push({ path: /^POST \/sales$/, at: [1] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(rung).toMatchObject({ ok: true, written: true });
      expect(boxSales()).toEqual([]);
      expect(currentLane()).toBe('platform');
      expect(world.sales.size).toBe(1);
      expect(salePosts().map((c) => c.body.id)).toEqual([rung.saleId]);
      expect(said).toEqual([GATE_SALE_RETRYING]);
      expect(result.current.state).toMatchObject({ kind: 'committed' });

      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true });
      expect(result.current.state).toMatchObject({ kind: 'written' });
      expect(finalisePosts()).toHaveLength(1);
      expect(boxSales()).toEqual([]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('the cash press dropped once: closed online with the same press, never on the box, money recorded once', async () => {
    const hold = gateFinishedOnline();
    world.drops.push({ path: /^POST \/sales\/[^/]+\/finalise$/, at: [1] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true, replay: false });
      expect(boxSales()).toEqual([]);
      expect(currentLane()).toBe('platform');
      expect(finalisePosts()).toHaveLength(1);
      expect(finalisePosts()[0]!.path).toBe(`/sales/${encodeURIComponent(rung.saleId)}/finalise`);
      expect([...world.sales.values()]).toEqual([{ id: rung.saleId, status: 'finalised' }]);
      expect(said).toEqual([GATE_SALE_RETRYING]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('a card press is not retried by the hold: one call, never the box, the panel\'s own retry as before', async () => {
    const hold = gateFinishedOnline();
    world.drops.push({ path: /^POST \/sales\/[^/]+\/finalise$/, at: [1] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      await result.current.commit(order());
      const paid = await result.current.finalise(card, 'card-press');
      expect(paid).toMatchObject({ ok: false, retryable: true });
      expect(boxSales()).toEqual([]);
      expect(world.sales.size).toBe(1);
      expect([...world.sales.values()][0]!.status).toBe('tendering');
      expect(said).toEqual([]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('the link stays down past the backoff: the hold ends, the sale follows the lane rule, and the box\'s refusal reads as "not received yet, Try again"', async () => {
    const hold = gateFinishedOnline();
    world.drops.push({ path: /^POST \/sales$/, at: [1, 2, 3, 4] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(rung).toMatchObject({ ok: false });
      expect(platformLaneHeld()).toBe(false);
      expect(currentLane()).toBe('box');
      // The box was asked once, for the price, and refused before any tender.
      expect(boxSales()).toHaveLength(1);
      expect(boxSales()[0]).toMatchObject({ type: 'cart.quote', payload: { memberId: GUARDIAN } });
      expect(world.sales.size).toBe(0);
      const state = result.current.state as Extract<SaleWriteState, { kind: 'failed' }>;
      expect(state).toMatchObject({ kind: 'failed', answeredBy: 'box', code: 'NOT_FOUND', message: 'Member not found', retryable: false });
      const shown = gateSaleFailure(state, hold.startedOnline);
      expect(shown).toMatchObject({ kind: 'failed', message: GATE_SALE_BOX_NOT_SYNCED, retryable: true, cause: 'connection' });
      expect(shown.message).not.toMatch(/Member not found/);
      expect(shown.message).toMatch(/Try again/);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('the hold ends with the written sale, and the next sale\'s dropped link goes to the box as before', async () => {
    const hold = gateFinishedOnline();
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      await result.current.commit(order());
      await result.current.finalise(cash, 'cash-press');
      expect(result.current.state).toMatchObject({ kind: 'written' });
      hold.endSale(); // Till's effect on a written sale
      expect(platformLaneHeld()).toBe(false);
    } finally {
      unmount();
    }
    world.drops.push({ path: /^POST \/sales$/, at: [1] });
    const next = renderHook(() => useSaleWriter());
    try {
      await next.result.current.commit(order());
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote']);
      expect(currentLane()).toBe('box');
    } finally {
      next.unmount();
    }
  });
});

describe('SCRUM-887: the general rule is unchanged', () => {
  it('a gate press that did not reach payment releases its hold: a dropped Pay goes to the box', async () => {
    const hold = gateOnlineHold((words) => said.push(words));
    hold.beginPress();
    hold.noteWrite();
    hold.endPress(); // the registration failed: no carryToSale
    expect(platformLaneHeld()).toBe(false);
    world.drops.push({ path: /^POST \/sales$/, at: [1] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      await result.current.commit(order());
      expect(salePosts()).toHaveLength(0);
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote']);
      expect(currentLane()).toBe('box');
    } finally {
      unmount();
      hold.reset();
    }
  });

  it('a gate that did not start online carries nothing, and keeps the box\'s own words', () => {
    const hold = gateOnlineHold((words) => said.push(words));
    hold.beginPress();
    hold.carryToSale();
    hold.endPress();
    expect(hold.startedOnline).toBe(false);
    expect(platformLaneHeld()).toBe(false);
    const state: SaleWriteState = {
      kind: 'failed', saleId: 's', stage: 'commit', cause: 'refused', message: 'Member not found',
      code: 'NOT_FOUND', retryable: false, answeredBy: 'box',
    };
    expect(gateSaleFailure(state, false)).toBe(state);
  });

  it('every other failure stands as it came', () => {
    const platformNotFound: SaleWriteState = {
      kind: 'failed', saleId: 's', stage: 'commit', cause: 'refused', message: 'Member not found', code: 'NOT_FOUND', retryable: false,
    };
    expect(gateSaleFailure(platformNotFound, true)).toBe(platformNotFound);
    const stock: SaleWriteState = {
      kind: 'failed', saleId: 's', stage: 'commit', cause: 'refused', message: 'Out of stock', code: 'STOCK_INSUFFICIENT', retryable: false, answeredBy: 'box',
    };
    expect(gateSaleFailure(stock, true)).toBe(stock);
    const idle: SaleWriteState = { kind: 'idle' };
    expect(gateSaleFailure(idle, true)).toBe(idle);
  });

  it('a reset (a new sale, the till closing) releases a carried hold', () => {
    const hold = gateFinishedOnline();
    expect(platformLaneHeld()).toBe(true);
    hold.reset();
    expect(platformLaneHeld()).toBe(false);
    expect(hold.startedOnline).toBe(false);
  });

  it('the gate\'s own press still says the registration words', async () => {
    const hold = gateOnlineHold((words) => said.push(words));
    hold.beginPress();
    hold.noteWrite();
    let calls = 0;
    await viaLane(async () => {
      calls += 1;
      if (calls === 1) throw new NetworkError();
      return 'ok';
    }, async () => 'box');
    expect(calls).toBe(2);
    expect(said).toEqual([GATE_RETRYING]);
    hold.endPress();
    hold.reset();
  });
});

describe('SCRUM-887: the till carries its gate to the sale', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/pages/Till.tsx', import.meta.url)), 'utf8');
  const writer = readFileSync(fileURLToPath(new URL('../src/lib/saleWriter.ts', import.meta.url)), 'utf8');

  it('carries the hold when the gate reaches payment, and ends it with the sale', () => {
    const gate = src.slice(src.indexOf('const resolveSupervisionGate'), src.indexOf('const handleDoneAdding'));
    expect(gate).toMatch(/setSupervisionResolved\(true\);\s*gateOnline\.carryToSale\(\);/);
    expect(src).toMatch(/saleWriter\.state\.kind === 'written' \|\| saleWriter\.state\.kind === 'unwritten'\) gateOnline\.endSale\(\);/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => gateOnline\.reset\(\), \[gateOnline\]\);/);
    const reset = src.slice(src.indexOf('const resetSale = () => {'), src.indexOf('const resetSale = () => {') + 400);
    expect(reset).toMatch(/gateOnline\.reset\(\);/);
    expect(src).toMatch(/state=\{gateSaleFailure\(saleWriter\.state, gateOnline\.startedOnline\)\}/);
  });

  it('Pay and the cash press go through the hold; the trigger branches are unchanged', () => {
    expect(writer).toMatch(/await onPlatformWhileHeld\(\(\) => commitSale\(\{/);
    expect(writer).toMatch(/result = await \(cashOrNothing \? onPlatformWhileHeld\(press\) : press\(\)\);/);
    expect(writer).toMatch(/if \(station && !triedBox && isBoxLaneTrigger\(err\)\) \{/);
    expect(writer).toMatch(/if \(onTheBox && station && cashOrNothing && isBoxLaneTrigger\(err\)\) \{/);
  });

  it('the words differ for the gate and the sale', () => {
    expect(GATE_SALE_RETRYING.description).not.toBe(GATE_RETRYING.description);
    expect(GATE_SALE_RETRYING.description).toMatch(/charged twice/);
  });
});
