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
import {
  currentLane,
  noteLaneFailure,
  platformLaneHeld,
  setHeldRetryDelays,
  setLaneStation,
  viaLane,
} from '@/lib/lane';
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
  sales = new Map<string, { id: string; status: 'tendering' | 'finalised' | 'voided' }>();
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
    const voided = /^\/sales\/([^/]+)\/void$/.exec(path);
    if (method === 'POST' && voided) {
      const sale = this.sales.get(decodeURIComponent(voided[1]!))!;
      sale.status = 'voided';
      return reply({ sale: apiSale({ id: sale.id, stationId: STATION, status: 'voided' }) });
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

/**
 * The staging proof's point 2 in the gate's own calls: the first Continue
 * wrote the guardian and the children online, then the registration ran out
 * of held retries and the press ended short of payment ("press Continue
 * again"). While the link stayed down the till's other calls — the display's
 * presence check — moved the lane to the box. The link came back, Continue was
 * pressed again, the registration finished online and the press reached
 * payment. The lane still says box: only the box's next status read moves it.
 */
function gateRecoveredAfterLongOutage(): GateOnlineHold {
  const hold = gateOnlineHold((words) => said.push(words));
  hold.beginPress();
  hold.noteWrite(); // the guardian and the children, answered on the platform
  hold.endPress(); // the registration's held retries ran out
  expect(platformLaneHeld()).toBe(false);
  noteLaneFailure(new NetworkError()); // another call met the dropped link
  expect(currentLane()).toBe('box');
  hold.beginPress(); // the link is back: Continue again
  hold.noteWrite(); // the same registration, answered on the platform
  hold.carryToSale();
  hold.endPress();
  expect(platformLaneHeld()).toBe(true);
  expect(currentLane()).toBe('box');
  return hold;
}

/** The order with one more child: a different cart, so a different sale. */
const corrected = (): SaleWriteInput => {
  const base = cart();
  return {
    cart: { ...base, lines: [{ ...base.lines[0]!, kids: 2, lineTotalSatang: 108_000 }], expectedTotalSatang: 108_000 },
    finalise: false,
  };
};

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

describe('SCRUM-887: the link stayed down past the retries and the lane moved to the box', () => {
  it('Continue again after the outage: Pay and the cash press go online under the same ids while the lane still says box, and the box is never asked', async () => {
    const hold = gateRecoveredAfterLongOutage();
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(rung).toMatchObject({ ok: true, written: true });
      expect(salePosts().map((c) => c.body.id)).toEqual([rung.saleId]);
      expect(result.current.state).toMatchObject({ kind: 'committed', saleId: rung.saleId });
      expect(boxSales()).toEqual([]);

      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true, saleId: rung.saleId });
      expect(finalisePosts().map((c) => c.path)).toEqual([`/sales/${encodeURIComponent(rung.saleId)}/finalise`]);
      expect([...world.sales.values()]).toEqual([{ id: rung.saleId, status: 'finalised' }]);
      expect(result.current.state).toMatchObject({ kind: 'written', saleId: rung.saleId });
      expect(boxSales()).toEqual([]);
      expect(said).toEqual([]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('a dropped link at Pay on the box lane is retried online under the same id: one sale, the box never asked', async () => {
    const hold = gateRecoveredAfterLongOutage();
    world.drops.push({ path: /^POST \/sales$/, at: [1] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(rung).toMatchObject({ ok: true, written: true });
      expect(world.drops[0]!.seen).toBe(2);
      expect(salePosts().map((c) => c.body.id)).toEqual([rung.saleId]);
      expect(world.sales.size).toBe(1);
      expect(said).toEqual([GATE_SALE_RETRYING]);
      expect(boxSales()).toEqual([]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('the lane moves to the box between Pay and the cash press: the cash press is still closed online, retried there once', async () => {
    const hold = gateFinishedOnline();
    world.drops.push({ path: /^POST \/sales\/[^/]+\/finalise$/, at: [1] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(currentLane()).toBe('platform');
      noteLaneFailure(new NetworkError()); // the display's presence check met a dropped link
      expect(currentLane()).toBe('box');
      const paid = await result.current.finalise(cash, 'cash-press');
      expect(paid).toMatchObject({ ok: true, written: true, finalised: true, saleId: rung.saleId });
      expect(finalisePosts()).toHaveLength(1);
      expect([...world.sales.values()]).toEqual([{ id: rung.saleId, status: 'finalised' }]);
      expect(said).toEqual([GATE_SALE_RETRYING]);
      expect(boxSales()).toEqual([]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('the link is still down at Pay: the held retries run out, the hold ends, and the lane rule applies — the box, under the same sale', async () => {
    const hold = gateRecoveredAfterLongOutage();
    world.drops.push({ path: /^POST \/sales$/, at: [1, 2, 3, 4, 5] });
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const rung = await result.current.commit(order());
      expect(rung).toMatchObject({ ok: false });
      expect(world.drops[0]!.seen).toBe(4); // the press and its three held retries
      expect(platformLaneHeld()).toBe(false);
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote']);
      expect(gateSaleFailure(result.current.state, hold.startedOnline)).toMatchObject({
        kind: 'failed', saleId: rung.saleId, message: GATE_SALE_BOX_NOT_SYNCED, retryable: true,
      });
      // Try again: no hold now, the lane says box — the box again, under the same sale.
      const again = await result.current.commit(order());
      expect(again).toMatchObject({ ok: false, saleId: rung.saleId });
      expect(world.drops[0]!.seen).toBe(4);
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote', 'cart.quote']);
      expect(world.sales.size).toBe(0);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('a corrected order while held on the box lane: the sale rung up first is voided, then the corrected one is written online (SCRUM-865)', async () => {
    const hold = gateRecoveredAfterLongOutage();
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      const first = await result.current.commit(order());
      expect(first).toMatchObject({ ok: true, written: true });
      const second = await result.current.commit(corrected());
      expect(second).toMatchObject({ ok: true, written: true });
      expect(second.saleId).not.toBe(first.saleId);
      expect(world.platform.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
        '/sales',
        `/sales/${encodeURIComponent(first.saleId)}/void`,
        '/sales',
      ]);
      expect(world.sales.get(first.saleId)?.status).toBe('voided');
      expect(world.sales.get(second.saleId)?.status).toBe('tendering');
      expect(boxSales()).toEqual([]);
    } finally {
      unmount();
      hold.endSale();
    }
  });

  it('no carried hold and the lane on the box: Pay goes to the box as today, and the platform is never asked', async () => {
    noteLaneFailure(new NetworkError());
    expect(currentLane()).toBe('box');
    expect(platformLaneHeld()).toBe(false);
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      await result.current.commit(order());
      expect(salePosts()).toEqual([]);
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote']);
    } finally {
      unmount();
    }
  });

  it('a till offline from the start: the box answered the gate, so no hold is taken and the sale goes to the box as today', async () => {
    noteLaneFailure(new NetworkError());
    const hold = gateOnlineHold((words) => said.push(words));
    hold.beginPress();
    hold.noteWrite(); // answered by the box
    hold.carryToSale();
    hold.endPress();
    expect(hold.startedOnline).toBe(false);
    expect(platformLaneHeld()).toBe(false);
    const { result, unmount } = renderHook(() => useSaleWriter());
    try {
      await result.current.commit(order());
      expect(salePosts()).toEqual([]);
      expect(boxSales().map((c) => c.type)).toEqual(['cart.quote']);
    } finally {
      unmount();
      hold.reset();
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

  it('the box lane is skipped only while a hold is carried, and before the SCRUM-865 void and the commit', () => {
    const atBox = writer.indexOf("if (station && currentLane() === 'box' && !platformLaneHeld()) return await onBox(station);");
    const voids = writer.indexOf('const letGo = voidSuperseded(superseded);');
    const commits = writer.indexOf('await onPlatformWhileHeld(() => commitSale({');
    expect(atBox).toBeGreaterThan(0);
    expect(voids).toBeGreaterThan(atBox);
    expect(commits).toBeGreaterThan(voids);
    expect(writer).toMatch(/onTheBox\.lane === 'box' \|\| \(cashOrNothing && station && currentLane\(\) === 'box' && !platformLaneHeld\(\)\)/);
  });

  it('the words differ for the gate and the sale', () => {
    expect(GATE_SALE_RETRYING.description).not.toBe(GATE_RETRYING.description);
    expect(GATE_SALE_RETRYING.description).toMatch(/charged twice/);
  });
});
