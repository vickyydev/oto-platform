import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyChargeView, PartyWriteAnswer } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { toast } from '@/hooks/use-toast';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartyFnbModal } from '@/components/parties/PartyFnbModal';
import { PartyTicketModal } from '@/components/parties/PartyTicketModal';
import { MobileParties } from '@/components/mobile/parties/MobileParties';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { MobilePartyFnb } from '@/components/mobile/parties/MobilePartyFnb';
import { MobileEventsList } from '@/components/mobile/parties/MobileEventsList';
import type { MenuItem, PartyBooking } from '@/types';
import { renderHook, type RenderedHook } from './support/hooks';

/**
 * S2-20 E4 — RE-CHECK REVIEW, the till's CHARGE presses (SCRUM-217; events-kiosk
 * PLAN, the E4 row of §9, Q3's default: a charge is a ledger entry and the
 * guest pays it at "Take balance").
 *
 * The fix round made a payment's ids belong to its press, so a retry is the
 * same request and another press is another payment. The charge path kept the
 * old rule: one set of ids per kind, kept after a reply that never came
 * (`idsFor('fnb')`, press `''`) and reused for whatever the order holds at the
 * next press. And the order stays open and editable after that failure
 * (PartyFnbModal / MobilePartyFnb keep the cart when `onCharge` is false).
 *
 * So: an F&B order is charged and its answer lost ("Not charged to the
 * party"); staff add an item and press again — the same charge id and
 * Idempotency-Key with another body, refused 409 IDEMPOTENCY_MISMATCH ("Not
 * charged to the party" again, although the first one WAS charged); the ids
 * are dropped as for a definite no; the next press charges the whole order
 * under new ids. The tab carries the first items twice and the guest is asked
 * for them at "Take balance". There is no way to take a charge off from the
 * till (the prototype has none either).
 *
 * Pinned with `it.fails` on both screens: the assertion is the right story,
 * the pin passes while the defect stands and flips when it is fixed.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0e41';
const TILL = '0190a0a0-0000-7000-8000-00000000c001';
const T = '2026-11-04';

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
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform' }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som (Reception)' } }),
}));
vi.mock('@/station/StationContext', () => ({
  useStation: () => ({ station: { stationId: TILL, name: 'Till 1' } }),
}));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => ({ branch: { id: 'hkt-central', name: 'HKT Central' } }) }));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: (key: string) => key }),
}));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['dark', () => undefined] }));
const day = vi.hoisted(() => ({ revision: -1, cached: [] as unknown[], current: () => [] as unknown[] }));
vi.mock('@/api/events', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/events')>();
  return {
    ...original,
    useEventsForDate: () => ({ events: day.current(), loaded: true, error: null }),
  };
});

const postMock = vi.mocked(api.post);
const toastMock = vi.mocked(toast);

// --- The platform behind the till: the charge route behind the idempotency store

const BASE = 1_200_000;
const DEPOSIT = 300_000;

const server = {
  charges: [] as PartyChargeView[],
  /** Keyed as the api keys it: the account's key; the hash is method + url + body. */
  keys: new Map<string, { hash: string; answer?: PartyWriteAnswer; error?: ApiError }>(),
  loseNextAnswer: false,
  revision: 0,
};

const chargedSatang = () => server.charges.reduce((s, c) => s + c.totalSatang, 0);

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
    expectedKids: 15,
    expectedAdults: 12,
    entryPrice: null,
    party: {
      childName: 'Mali',
      kidTurningAge: 6,
      bookingName: null,
      parentName: 'Nok',
      parentPhone: '+66812345678',
      activities: null,
      decoration: 'Ocean',
      totalValueSatang: BASE,
      depositSatang: DEPOSIT,
      depositDate: T,
      walkUpCharges: [],
      charges: server.charges.map((c) => ({ ...c })),
      payments: [],
      lastEdited: null,
      editSync: null,
      bill: {
        baseSatang: BASE,
        chargesSatang: chargedSatang(),
        totalSatang: BASE + chargedSatang(),
        depositSatang: DEPOSIT,
        paidSatang: 0,
        outstandingSatang: BASE + chargedSatang() - DEPOSIT,
      },
    },
    attendeeCount: 0,
    attendees: [],
    roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
  };
}

const partyNow = () => toOtoEvent(viewOf(), 'hkt-central') as unknown as PartyBooking;

/** `POST /parties/:id/charges` as the api answers it (chargeParty), behind the idempotency plugin. */
async function platformCharge(path: string, body: unknown, opts?: { idempotencyKey?: string }): Promise<PartyWriteAnswer> {
  expect(path).toBe(`/parties/${PARTY}/charges`);
  const b = body as { chargeId: string; kind: 'fnb' | 'ticket'; items: PartyChargeView['items']; totalSatang: number };
  const hash = `POST\n${path}\n${JSON.stringify(b)}`;
  const key = opts?.idempotencyKey;
  const prior = key ? server.keys.get(key) : undefined;
  if (prior) {
    if (prior.hash !== hash) {
      throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request');
    }
    if (prior.error) throw prior.error;
    return prior.answer!;
  }
  const existing = server.charges.find((c) => c.id === b.chargeId);
  if (existing) return { replayed: true, party: viewOf(), charge: existing };
  server.charges.push({
    id: b.chargeId,
    kind: b.kind,
    items: b.items,
    totalSatang: Math.max(0, b.totalSatang),
    chargedBy: 'Som (Reception)',
    chargedById: 'acc-som',
    chargedAt: `${T}T06:00:00.000Z`,
  });
  server.revision += 1;
  const answer: PartyWriteAnswer = { replayed: false, party: viewOf(), charge: server.charges[server.charges.length - 1] };
  if (key) server.keys.set(key, { hash, answer });
  if (server.loseNextAnswer) {
    server.loseNextAnswer = false;
    throw new NetworkError('lost');
  }
  return answer;
}

beforeEach(() => {
  server.charges = [];
  server.keys = new Map();
  server.loseNextAnswer = false;
  server.revision = 0;
  postMock.mockReset();
  postMock.mockImplementation(platformCharge as unknown as typeof api.post);
  toastMock.mockReset();
  day.revision = -1;
  day.current = () => {
    if (day.revision !== server.revision) {
      day.revision = server.revision;
      day.cached = [toOtoEvent(viewOf(), 'hkt-central')];
    }
    return day.cached;
  };
});

// --- Pressing what is on the screen --------------------------------------------

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
const elementOf = (tree: unknown, type: unknown): El | null => {
  for (const el of walk(tree)) if (el.type === type) return el;
  return null;
};
/** The first element in the tree carrying this callback prop. */
const propIn = (tree: unknown, prop: string): ((...args: unknown[]) => unknown) | null => {
  for (const el of walk(tree)) if (typeof el.props[prop] === 'function') return el.props[prop] as (...args: unknown[]) => unknown;
  return null;
};
function buttonIn(tree: unknown, words: string | RegExp): (() => unknown) | null {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    const text = textOf(el.props.children).replace(/\s+/g, ' ').trim();
    if (typeof words === 'string' ? text === words || text.startsWith(words) : words.test(text)) {
      return el.props.onClick as () => unknown;
    }
  }
  return null;
}
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Rendered = RenderedHook<Record<string, unknown>, unknown>;

/** Two plain menu items, no modifier sheet in the way: what staff tap. */
function twoPlainItems(): [MenuItem, MenuItem] {
  return [
    { id: 'mi-pad-thai', name: 'Pad Thai', category: 'food', price: { weekday: 180, weekend: 180 } },
    { id: 'mi-coke', name: 'Coke', category: 'drinks', price: { weekday: 50, weekend: 50 } },
  ];
}

/** What each press sent: the charge id, its key and the order's total. */
const sent = () =>
  postMock.mock.calls.map((c) => ({
    ...(c[1] as { chargeId: string; totalSatang: number }),
    key: (c[2] as { idempotencyKey: string }).idempotencyKey,
  }));

/** THE IPAD: Events → a party → "Add F&B to party" → PartyFnbModal, as the page holds it. */
function ipadFnb() {
  const props = (): Record<string, unknown> => ({
    party: partyNow(),
    surface: 'till',
    onBack: () => undefined,
    onChanged: () => host.rerender(props()),
  });
  const host: Rendered = renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props());
  let modal: Rendered | null = null;
  const sync = () => {
    const el = elementOf(host.result.current, PartyFnbModal);
    if (!el) throw new Error('no F&B modal on the party screen');
    if (!modal) modal = renderHook((p: Record<string, unknown>) => PartyFnbModal(p as never), el.props);
    else modal.rerender(el.props);
    return modal;
  };
  const open = buttonIn(host.result.current, 'Add F&B to party');
  expect(open, 'Add F&B to party').not.toBeNull();
  open!();
  sync();
  return {
    isOpen: () => elementOf(host.result.current, PartyFnbModal)!.props.open === true,
    tap(item: MenuItem) {
      const grid = elementOf(sync().result.current, MenuGrid);
      (grid!.props.onAdd as (i: MenuItem) => void)(item);
      sync();
    },
    async charge() {
      (propIn(sync().result.current, 'onCheckout') as () => void)();
      await settle();
      sync();
    },
  };
}

/** THE PHONE: Parties → a party → Add F&B → MobilePartyFnb. */
function phoneFnb() {
  const host: Rendered = renderHook(() => MobileParties() as never, {});
  const tree = () => host.result.current;
  (elementOf(tree(), MobileEventsList)!.props.onSelectEvent as (id: string, date: string) => void)(PARTY, T);
  (elementOf(tree(), MobilePartyDetail)!.props.onAddFnb as () => void)();
  let screen: Rendered | null = null;
  const sync = () => {
    const el = elementOf(tree(), MobilePartyFnb);
    if (!el) return screen;
    if (!screen) screen = renderHook((p: Record<string, unknown>) => MobilePartyFnb(p as never), el.props);
    else screen.rerender(el.props);
    return screen;
  };
  sync();
  return {
    stillOnFnb: () => elementOf(tree(), MobilePartyFnb) !== null,
    tap(item: MenuItem) {
      const grid = elementOf(sync()!.result.current, MenuGrid);
      (grid!.props.onAdd as (i: MenuItem) => void)(item);
      sync();
    },
    async charge() {
      (propIn(sync()!.result.current, 'onCheckout') as () => void)();
      await settle();
      sync();
    },
  };
}

const toastTitles = () => toastMock.mock.calls.map((c) => (c[0] as { title?: string }).title);

// =============================================================================
// The plain path and the plain retry — right today
// =============================================================================

describe('a party F&B charge, pressed as staff press it', () => {
  it('iPad: one order, one charge on the tab, the modal closes', async () => {
    const [a] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    await screen.charge();
    expect(server.charges).toHaveLength(1);
    expect(chargedSatang()).toBe(sent()[0]!.totalSatang);
    expect(chargedSatang()).toBeGreaterThan(0);
    expect(screen.isOpen()).toBe(false);
  });

  it('iPad: an answer lost, then the SAME order pressed again — the stored answer, one charge', async () => {
    const [a] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge();
    expect(screen.isOpen()).toBe(true); // "Not charged to the party": the order stays open
    await screen.charge();
    expect(server.charges).toHaveLength(1);
    const [first, second] = postMock.mock.calls;
    expect(second![1]).toEqual(first![1]);
    expect(screen.isOpen()).toBe(false);
  });
});

// =============================================================================
// FINDING — an answer lost, then the order changed: the first items charged twice
// =============================================================================

describe('FINDING: a charge whose answer was lost, then the open order changed — the tab must not carry the first items twice', () => {
  /**
   * Pad Thai is charged; the answer is lost; the toast says "Not charged to
   * the party" and the order stays open. The guest also wants a drink: staff
   * tap it and press again. That is refused 409 IDEMPOTENCY_MISMATCH (the same
   * charge id with another body) — "Not charged to the party" again, though
   * the first charge stands — and the ids are dropped. The third press charges
   * Pad Thai + drink under new ids. The tab: Pad Thai twice.
   */
  it.fails('iPad: each item the guest ordered is on the tab once', async () => {
    const [a, b] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge(); // recorded, answer lost
    expect(server.charges).toHaveLength(1);
    screen.tap(b); // the order is still open and editable
    await screen.charge(); // refused: IDEMPOTENCY_MISMATCH
    if (screen.isOpen()) await screen.charge(); // staff press again
    const ordered = sent()[sent().length - 1]!.totalSatang; // the whole order, Pad Thai + drink
    // One story: the tab carries what was ordered — never more.
    expect(chargedSatang()).toBeLessThanOrEqual(ordered);
  });

  // Asserts the defect itself, press by press: the fix round rewrites it, as it
  // rewrote the payment's "what the defect is made of".
  it('iPad: what the defect is made of, press by press (passes while it stands)', async () => {
    const [a, b] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge();
    screen.tap(b);
    await screen.charge();
    await screen.charge();
    const bodies = sent();
    // Press 2 reused press 1's charge id and key with another order in the body.
    expect(bodies[1]!.chargeId).toBe(bodies[0]!.chargeId);
    expect(bodies[1]!.key).toBe(bodies[0]!.key);
    expect(bodies[1]!.totalSatang).toBeGreaterThan(bodies[0]!.totalSatang);
    // ... was told "Not charged to the party" both times, though the first was charged ...
    expect(toastTitles().filter((t) => t === 'Not charged to the party')).toHaveLength(2);
    // ... and press 3 charged the whole order again under new ids.
    expect(bodies[2]!.chargeId).not.toBe(bodies[0]!.chargeId);
    expect(server.charges.map((c) => c.totalSatang)).toEqual([bodies[0]!.totalSatang, bodies[2]!.totalSatang]);
    expect(server.charges.map((c) => c.items.map((i) => i.name))).toEqual([['Pad Thai'], ['Pad Thai', 'Coke']]);
    // The tab: Pad Thai twice — the guest is asked for it again at "Take balance".
    expect(chargedSatang()).toBe(bodies[0]!.totalSatang + bodies[2]!.totalSatang);
    expect(chargedSatang()).toBeGreaterThan(bodies[2]!.totalSatang);
    expect(screen.isOpen()).toBe(false);
  });

  it.fails('phone: each item the guest ordered is on the tab once', async () => {
    const [a, b] = twoPlainItems();
    const screen = phoneFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge();
    expect(server.charges).toHaveLength(1);
    expect(screen.stillOnFnb()).toBe(true);
    screen.tap(b);
    await screen.charge();
    if (screen.stillOnFnb()) await screen.charge();
    expect(chargedSatang()).toBeLessThanOrEqual(sent()[sent().length - 1]!.totalSatang);
  });

  /**
   * Extra tickets take the same path (`handleChargeExtra('ticket')`, the same
   * `idsFor(kind)`), and PartyTicketModal keeps its lines open on `false` as
   * the F&B modal does. Driven here through the handler the modal is given,
   * called as the modal calls it: its current lines, again after a failure.
   */
  it.fails('iPad, extra tickets: a lost answer, then a line added — each ticket on the tab once', async () => {
    const props = (): Record<string, unknown> => ({
      party: partyNow(),
      surface: 'till',
      onBack: () => undefined,
      onChanged: () => host.rerender(props()),
    });
    const host: Rendered = renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props());
    const onCharge = () =>
      elementOf(host.result.current, PartyTicketModal)!.props.onCharge as (
        items: { name: string; qty: number; lineTotal: number }[],
        total: number,
      ) => Promise<boolean>;
    const kid = { name: 'Day pass · Kid', qty: 1, lineTotal: 450 };
    const adult = { name: 'Day pass · Adult', qty: 1, lineTotal: 150 };
    server.loseNextAnswer = true;
    expect(await onCharge()([kid], 450)).toBe(false); // charged; its answer lost — the modal stays open
    expect(server.charges).toHaveLength(1);
    if ((await onCharge()([kid, adult], 600)) === false) await onCharge()([kid, adult], 600);
    expect(chargedSatang()).toBeLessThanOrEqual(60_000);
  });
});
