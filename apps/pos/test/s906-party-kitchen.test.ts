import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyKitchenPlan, PartyPlan } from '@oto/shared';
import { api } from '@/api/client';
import { toOtoEvent, withPartyKitchen } from '@/api/events';
import { readPartyPlanOnPlatform } from '@/api/parties';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { usePartyPlanRead } from '@/hooks/usePartyPlanRead';
import {
  PARTY_PLAN_REFRESH_MS,
  partyBarLineLabel,
  partyCakeLabel,
  partyCakeOf,
  partyMenuLineLabel,
} from '@/lib/partyKitchen';
import type { PartyBooking } from '@/types';
import { renderHook, type RenderedHook } from './support/hooks';

/**
 * SCRUM-906 — THE WHOLE KITCHEN PLAN ON THE TILL'S PARTY PAGES (the owner's
 * decisions of 12 November): every line of the BEO's kitchen plan with the
 * slip's marks ("not on the till menu" for a line the till does not sell),
 * the cake as the BEO's cake choice says it, the bar's lines with its service
 * time, a party with a kitchen plan and no package shown all the same, and the
 * plan read again on focus and every minute while the page is open.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0906';
const TILL = '0190a0a0-0000-7000-8000-00000000c001';
const T = '2026-11-18';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const harness = await import('./support/hooks');
  const hooks = {
    useState: harness.useState,
    useRef: harness.useRef,
    useMemo: harness.useMemo,
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
  };
  return { ...real, ...hooks, default: { ...real, ...hooks } };
});
vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } };
});
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', viaLane: (onPlatform: () => unknown) => onPlatform() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som (Reception)' }, locked: false, can: () => true }),
}));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ station: { stationId: TILL, name: 'Till 1' } }) }));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => ({ branch: { id: 'hkt-central', name: 'HKT Central' } }) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: (key: string) => key }) }));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['dark', () => undefined] }));

const getMock = vi.mocked(api.get);

// --- The platform's answers ------------------------------------------------------

/** A party with a kitchen plan and no package (decision 8): typed lines, a cake, the bar. */
const KITCHEN: PartyKitchenPlan = {
  eventId: PARTY,
  partyDate: T,
  startTime: '13:00',
  endTime: '16:00',
  counts: { kidsExpected: 10, adultsExpected: 4 },
  setMenu: [
    { productCode: null, name: 'Fried rice', qty: 3, choiceGroup: 'Fried rice', chosenOption: 'Veggie', note: null, origin: 'set_menu', onTillMenu: false },
    { productCode: 'CF-11', name: 'French fries', qty: 2, choiceGroup: null, chosenOption: null, note: null, origin: 'set_menu', onTillMenu: true },
    { productCode: null, name: 'Hot dish', qty: 2, choiceGroup: 'Hot dish', chosenOption: null, note: null, origin: 'set_menu', onTillMenu: false },
    { productCode: null, name: 'Mango sticky rice', qty: 2, choiceGroup: null, chosenOption: null, note: 'no nuts', origin: 'extra', onTillMenu: false, unitPriceSatang: 12_000 },
    { productCode: 'CF-24', name: 'Pizza', qty: null, choiceGroup: 'Pizza', chosenOption: 'Margherita', note: null, origin: 'set_menu', onTillMenu: true, audience: 'kids' },
  ],
  barItems: [
    { productCode: 'CF-66-4', name: 'Cranberry mors', qty: 2, note: null, origin: 'set_menu', onTillMenu: true },
    { productCode: null, name: 'Juice pitcher', qty: 1, note: 'orange', origin: 'extra', onTillMenu: false },
  ],
  kitchen: { kidsFoodTime: '14:00', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '11:00', barServiceTime: '14:30' },
  cake: { type: 'our', qty: 2, time: '15:30', note: 'chocolate, "Mali 6"' },
};

function viewOf(): EventView {
  return {
    id: PARTY,
    branchId: HKT_CENTRAL,
    type: 'party',
    appEventType: 'birthday',
    status: 'upcoming',
    appStatus: 'upcoming',
    archived: false,
    title: "Mali's 6th",
    startDate: T,
    endDate: T,
    cancelledDays: [],
    startTime: '13:00',
    endTime: '16:00',
    location: 'Party room 1',
    expectedKids: 10,
    expectedAdults: 4,
    entryPrice: null,
    party: {
      childName: 'Mali',
      kidTurningAge: 6,
      bookingName: null,
      parentName: 'Nok',
      parentPhone: '+66812345678',
      activities: null,
      decoration: null,
      totalValueSatang: 0,
      depositSatang: 0,
      depositDate: null,
      walkUpCharges: [],
      charges: [],
      payments: [],
      lastEdited: null,
      editSync: null,
      settlement: null,
    },
    attendeeCount: 0,
    attendees: [],
    roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
  };
}
const partyOf = () => toOtoEvent(viewOf(), 'hkt-central') as unknown as PartyBooking;

let reads = 0;
/** GET /parties/:id answers the kitchen plan of a party with no package; `kitchen` is what it answers now. */
function serve(kitchen: PartyKitchenPlan | null, plan: PartyPlan | null = null) {
  reads = 0;
  getMock.mockReset();
  getMock.mockImplementation((async (path: string) => {
    if (path.startsWith(`/parties/${PARTY}`)) {
      reads += 1;
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(), plan, planStatus: plan ? 'ready' : 'no_package', kitchenPlan: kitchen, slips: null };
    }
    return { member: null };
  }) as unknown as typeof api.get);
}

beforeEach(() => serve(KITCHEN));
afterEach(() => vi.useRealTimers());

// --- Reading the screen --------------------------------------------------------------

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'type' in n && 'props' in n;
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isEl(node)) return;
  yield node;
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value) || isEl(value)) yield* walk(value);
  }
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isEl(node)) return ` ${textOf(node.props.children)} `;
  return '';
};
const flat = (tree: unknown) => {
  const rows = [...walk(tree)]
    .filter((el) => typeof el.props.label === 'string' && el.props.value !== undefined)
    .map((el) => `${el.props.label as string} ${textOf(el.props.value)}`);
  return [textOf(tree), ...rows].join(' ').replace(/\s+/g, ' ');
};
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function deskPage(party: PartyBooking): RenderedHook<Record<string, unknown>, unknown> {
  const props: Record<string, unknown> = { party, surface: 'fnb', onBack: () => undefined, onChanged: () => undefined };
  return renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props);
}
function phonePage(party: PartyBooking): RenderedHook<Record<string, unknown>, unknown> {
  const props: Record<string, unknown> = { party, onBack: () => undefined, onTakePayment: () => undefined, onAddFnb: () => undefined };
  return renderHook((p: Record<string, unknown>) => MobilePartyDetail(p as never), props);
}

// =============================================================================

describe('the words: every line with the slip\'s marks, the bar, the cake', () => {
  it('a line names its dish, its choice and its marks; one the till does not sell says so; an open choice is not marked', () => {
    expect(KITCHEN.setMenu.map(partyMenuLineLabel)).toEqual([
      'Fried rice · Veggie · not on the till menu',
      'French fries',
      'Hot dish',
      // SCRUM-967 — the line's note shows, as the bar's does (it was left off before).
      'Mango sticky rice · no nuts · not on the till menu',
      'Pizza · Margherita · kids only',
    ]);
    expect(partyMenuLineLabel({ ...KITCHEN.setMenu[1]!, adultsNote: '' })).toBe('French fries · adults: no note');
    // A plan from a platform before SCRUM-906 marks nothing it does not know.
    expect(partyMenuLineLabel({ productCode: null, name: 'Fruit skewers', qty: 2, choiceGroup: null, chosenOption: null, note: null })).toBe('Fruit skewers');
    expect(KITCHEN.barItems.map(partyBarLineLabel)).toEqual(['Cranberry mors', 'Juice pitcher · orange · not on the till menu']);
    // SCRUM-967 — a food line's note is on the card, after the chosen dish, before the slip's marks; a blank one is not.
    expect(partyMenuLineLabel({ ...KITCHEN.setMenu[0]!, note: 'no sauce' })).toBe('Fried rice · Veggie · no sauce · not on the till menu');
    expect(partyMenuLineLabel({ ...KITCHEN.setMenu[4]!, note: 'no sauce' })).toBe('Pizza · Margherita · no sauce · kids only');
    expect(partyMenuLineLabel({ ...KITCHEN.setMenu[1]!, note: '  ' })).toBe('French fries');
  });

  it('the cake as the BEO says it, in the page\'s own words; no cake is none', () => {
    expect(partyCakeOf(KITCHEN)).toEqual({ type: 'our', qty: 2, time: '15:30', note: 'chocolate, "Mali 6"' });
    expect(partyCakeLabel(partyCakeOf(KITCHEN))).toBe('Our cake ×2');
    expect(partyCakeLabel(partyCakeOf({ cake: { type: 'own', qty: 1, time: null, note: null } }))).toBe('Customer brings their own');
    expect(partyCakeOf({ cake: null })).toEqual({ type: 'none' });
    expect(partyCakeOf({})).toEqual({ type: 'none' });
  });

  it('withPartyKitchen lays the plan over the party in the prototype\'s shape; no plan leaves it as it was', () => {
    const party = partyOf();
    expect(party.kitchen).toEqual({ needed: false, kidsMenu: [], adultsMenu: [], foodItems: [], cake: { type: 'none' } });
    expect(withPartyKitchen(party, null)).toBe(party);
    const shown = withPartyKitchen(party, KITCHEN);
    expect(shown.kitchen).toEqual({
      needed: true,
      kidsMenu: [],
      adultsMenu: [],
      setMenu: true,
      foodItems: [
        { id: 'line-1', name: 'Fried rice · Veggie · not on the till menu', qty: 3 },
        { id: 'line-2', name: 'French fries', qty: 2 },
        { id: 'line-3', name: 'Hot dish', qty: 2 },
        { id: 'line-4', name: 'Mango sticky rice · no nuts · not on the till menu', qty: 2 },
        { id: 'line-5', name: 'Pizza · Margherita · kids only', qty: 0 },
      ],
      cake: { type: 'our', qty: 2, time: '15:30', note: 'chocolate, "Mali 6"' },
      serviceTime: '14:00',
    });
    expect(shown.bar).toEqual({
      serviceTime: '14:30',
      items: [
        { id: 'bar-1', name: 'Cranberry mors', qty: 2 },
        { id: 'bar-2', name: 'Juice pitcher · orange · not on the till menu', qty: 1 },
      ],
    });
  });

  it('the plan read carries the kitchen plan when the platform answers one', async () => {
    const read = await readPartyPlanOnPlatform({ id: PARTY, branchId: 'hkt-central' });
    expect(read).toEqual({ plan: null, status: 'no_package', kitchenPlan: KITCHEN });
  });
});

describe('the desk party page: a kitchen plan with no package is shown, the cake in its row', () => {
  it('shows every line with its marks, the cake, the bar and its time; never "No kitchen service"', async () => {
    const page = deskPage(partyOf());
    await settle();
    const text = flat(page.result.current);
    for (const words of [
      "Kids' food 14:00",
      'Slips print 11:00',
      'Fried rice · Veggie · not on the till menu ×3',
      'French fries ×2',
      'Mango sticky rice · no nuts · not on the till menu ×2',
      'Pizza · Margherita · kids only',
      'Our cake ×2 · 15:30',
      'chocolate, "Mali 6"',
      'Bar service 14:30',
      'Juice pitcher · orange · not on the till menu ×1',
    ]) {
      expect(text).toContain(words);
    }
    expect(text).not.toContain('No kitchen service for this party');
    // No package: no package row, and the party is not offered for settling.
    expect(text).not.toContain('Package ');
    expect(text).not.toContain('Settle party');
  });

  it('a BEO that says no cake shows no cake row', async () => {
    serve({ ...KITCHEN, cake: null });
    const page = deskPage(partyOf());
    await settle();
    const text = flat(page.result.current);
    expect(text).toContain('French fries ×2');
    expect(text).not.toContain('Our cake');
    expect(text).not.toContain('No cake');
  });
});

describe('the phone party page reads the plan too', () => {
  it('its kitchen section lists the plan\'s lines, the cake and the bar in its own rows', async () => {
    const page = phonePage(partyOf());
    await settle();
    const text = flat(page.result.current);
    for (const words of [
      'Food service 14:00',
      'Menu type Set menu',
      'Fried rice · Veggie · not on the till menu ×3',
      'Mango sticky rice · no nuts · not on the till menu ×2',
      'Our cake ×2 · 15:30',
      'Bar service 14:30',
      'Juice pitcher · orange · not on the till menu ×1',
    ]) {
      expect(text).toContain(words);
    }
    // A choice split over several dishes has no count of its own: no "×0".
    expect(text).not.toContain('×0');
    expect(text).not.toContain('No kitchen service for this party');
  });
});

describe('the plan is read again on focus and every minute while the page is open', () => {
  type Listener = () => void;
  function stubWindow() {
    const listeners = new Map<string, Set<Listener>>();
    const target = {
      addEventListener: (type: string, fn: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
      fire: (type: string) => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn();
      },
      count: (type: string) => listeners.get(type)?.size ?? 0,
    };
    vi.stubGlobal('window', target);
    return target;
  }

  it('reads on opening, on focus, and at the minute; a change in the BEO reaches the page', async () => {
    const win = stubWindow();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hook = renderHook((p: { party: Pick<PartyBooking, 'id' | 'branchId'> }) => usePartyPlanRead(p.party), {
      party: { id: PARTY, branchId: 'hkt-central' },
    });
    await settle();
    expect(reads).toBe(1);
    expect(hook.result.current?.kitchenPlan?.setMenu[0]?.chosenOption).toBe('Veggie');

    // Staff change the rice in the BEO; the till comes back to the front.
    serve({ ...KITCHEN, setMenu: [{ ...KITCHEN.setMenu[0]!, chosenOption: 'Chicken' }, ...KITCHEN.setMenu.slice(1)] });
    win.fire('focus');
    await settle();
    expect(reads).toBe(1);
    expect(hook.result.current?.kitchenPlan?.setMenu[0]?.chosenOption).toBe('Chicken');

    // A minute on, read again.
    serve({ ...KITCHEN, cake: null });
    vi.advanceTimersByTime(PARTY_PLAN_REFRESH_MS);
    await settle();
    expect(reads).toBe(1);
    expect(hook.result.current?.kitchenPlan?.cake).toBeNull();

    // A read that comes back with nothing keeps what was read.
    getMock.mockResolvedValue({ member: null } as never);
    vi.advanceTimersByTime(PARTY_PLAN_REFRESH_MS);
    await settle();
    expect(hook.result.current?.kitchenPlan?.cake).toBeNull();
    expect(hook.result.current?.kitchenPlan?.setMenu).toHaveLength(5);

    hook.unmount();
    expect(win.count('focus')).toBe(0);
  });

  it('held still while a settlement or an edit is open', async () => {
    const win = stubWindow();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hook = renderHook(
      (p: { party: Pick<PartyBooking, 'id' | 'branchId'>; paused: boolean }) => usePartyPlanRead(p.party, { paused: p.paused }),
      { party: { id: PARTY, branchId: 'hkt-central' }, paused: true },
    );
    await settle();
    expect(reads).toBe(1);
    win.fire('focus');
    vi.advanceTimersByTime(PARTY_PLAN_REFRESH_MS);
    await settle();
    expect(reads).toBe(1);
    hook.rerender({ party: { id: PARTY, branchId: 'hkt-central' }, paused: false });
    win.fire('focus');
    await settle();
    expect(reads).toBe(2);
  });
});

describe('SCRUM-953 (3) — nothing is said of the kitchen while the plan is being read', () => {
  it('desk and phone: no "No kitchen service" before the read answers; said once it answers with none', async () => {
    getMock.mockReset();
    getMock.mockImplementation((() => new Promise(() => undefined)) as unknown as typeof api.get);
    const reading = [deskPage(partyOf()), phonePage(partyOf())];
    await settle();
    for (const page of reading) expect(flat(page.result.current)).not.toContain('No kitchen service for this party');
    serve(null);
    const read = [deskPage(partyOf()), phonePage(partyOf())];
    await settle();
    for (const page of read) expect(flat(page.result.current)).toContain('No kitchen service for this party');
  });
});
