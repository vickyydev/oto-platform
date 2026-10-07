import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyChargeView, PartyWriteAnswer } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { toast } from '@/hooks/use-toast';
import { getDefaultTier, getTicketTypes } from '@/mockApi';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { OrderSummary } from '@/components/till/OrderSummary';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { PartyChargeHeldNote } from '@/components/parties/PartyChargeHeldNote';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartyFnbModal } from '@/components/parties/PartyFnbModal';
import { PartyTicketModal } from '@/components/parties/PartyTicketModal';
import { MobileParties } from '@/components/mobile/parties/MobileParties';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { MobilePartyFnb } from '@/components/mobile/parties/MobilePartyFnb';
import { MobileEventsList } from '@/components/mobile/parties/MobileEventsList';
import type { CartLine, MenuItem, PartyBooking } from '@/types';
import { renderHook, type RenderedHook } from './support/hooks';

/**
 * S2-20 E4 — RE-CHECK REVIEW, the till's CHARGE presses (SCRUM-217; events-kiosk
 * PLAN, the E4 row of §9, Q3's default: a charge is a ledger entry and the
 * guest pays it at "Take balance").
 *
 * The review found the charge path on the old rule: one set of ids per kind,
 * kept after a reply that never came and reused for whatever the order held at
 * the next press, with the order still open to change. An F&B order charged,
 * its answer lost ("Not charged to the party"), a drink added and pressed
 * again: the same charge id and Idempotency-Key with another body, refused 409
 * IDEMPOTENCY_MISMATCH, read as not charged, and the whole order charged again
 * under new ids — Pad Thai twice on the tab. Extra tickets likewise.
 *
 * The second fix round takes the payment's rule for an order: after a reply
 * that never came the screen HOLDS the order exactly as it was sent — nothing
 * added, changed, cleared or left — and its only press sends that order again,
 * the same request under the same ids, until a definite answer comes; a
 * definite no gives the order back to change. And a reply that never came is
 * "Charge not confirmed", never "Not charged to the party": it may have landed.
 * The review's three `it.fails` pins now pass as they stand; its make-up test
 * is turned round into what the fix is made of.
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
/** The till's lane: the platform, or the box with no connection to it. */
const lane = vi.hoisted(() => ({ value: 'platform' as 'platform' | 'box' }));
vi.mock('@/lib/lane', () => ({
  currentLane: () => lane.value,
  viaLane: (onPlatform: () => unknown) => onPlatform(),
}));
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

const getMock = vi.mocked(api.get);
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
  /** The next request refused with a definite no, nothing written (e.g. the party archived meanwhile). */
  refuseNext: null as ApiError | null,
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
  if (server.refuseNext) {
    const refusal = server.refuseNext;
    server.refuseNext = null;
    if (key) server.keys.set(key, { hash, error: refusal });
    throw refusal;
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
  server.refuseNext = null;
  server.revision = 0;
  lane.value = 'platform';
  postMock.mockReset();
  postMock.mockImplementation(platformCharge as unknown as typeof api.post);
  // The ticket builder looks the party's parent up: not a member.
  getMock.mockReset();
  getMock.mockResolvedValue({ member: null });
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
    ...(c[1] as { chargeId: string; actionId: string; totalSatang: number }),
    key: (c[2] as { idempotencyKey: string }).idempotencyKey,
  }));

/** The party page as the host holds it: `onChanged` reads the day again. */
function partyPage() {
  const props = (): Record<string, unknown> => ({
    party: partyNow(),
    surface: 'till',
    onBack: () => undefined,
    onChanged: () => host.rerender(props()),
  });
  const host: Rendered = renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props());
  return host;
}

/** THE IPAD: Events → a party → "Add F&B to party" → PartyFnbModal, as the page holds it. */
function ipadFnb() {
  const host = partyPage();
  let modal: Rendered | null = null;
  const sync = () => {
    const el = elementOf(host.result.current, PartyFnbModal);
    if (!el) throw new Error('no F&B modal on the party screen');
    if (!modal) modal = renderHook((p: Record<string, unknown>) => PartyFnbModal(p as never), el.props);
    else modal.rerender(el.props);
    return modal;
  };
  const screen = {
    open() {
      const open = buttonIn(host.result.current, 'Add F&B to party');
      expect(open, 'Add F&B to party').not.toBeNull();
      open!();
      sync();
    },
    isOpen: () => elementOf(host.result.current, PartyFnbModal)!.props.open === true,
    /** What the order on screen holds, by name. */
    order: () => ((elementOf(sync().result.current, MenuGrid)!.props.quantities ?? {}) as Record<string, number>),
    heldNoteShown: () => elementOf(sync().result.current, PartyChargeHeldNote) !== null,
    tap(item: MenuItem) {
      const grid = elementOf(sync().result.current, MenuGrid);
      (grid!.props.onAdd as (i: MenuItem) => void)(item);
      sync();
    },
    /** Every way the modal could be changed or left while it holds an order. */
    tryToLeaveOrChange() {
      const tree = sync().result.current;
      (propIn(tree, 'onClear') as () => void)();
      (propIn(tree, 'onChangeQty') as (id: string, qty: number) => void)('pline-any', 0);
      (propIn(tree, 'onSwitchTab') as () => void)();
      sync();
    },
    async charge() {
      (propIn(sync().result.current, 'onCheckout') as () => void)();
      await settle();
      sync();
    },
  };
  screen.open();
  return screen;
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
    heldNoteShown: () => elementOf(sync()!.result.current, PartyChargeHeldNote) !== null,
    tap(item: MenuItem) {
      const grid = elementOf(sync()!.result.current, MenuGrid);
      (grid!.props.onAdd as (i: MenuItem) => void)(item);
      sync();
    },
    /** The header's back arrow, and the cart sheet's way back to the party. */
    back() {
      const tree = sync()!.result.current;
      const arrow = [...walk(tree)].find((el) => el.props['aria-label'] === 'Back');
      expect(arrow, 'the back arrow').toBeDefined();
      (arrow!.props.onClick as () => void)();
      (propIn(tree, 'onSwitchTab') as () => void)();
      sync();
    },
    async charge() {
      (propIn(sync()!.result.current, 'onCheckout') as () => void)();
      await settle();
      sync();
    },
  };
}

/** THE IPAD: Events → a party → "Add tickets" → PartyTicketModal, as the page holds it. */
function ipadTickets() {
  const host = partyPage();
  let modal: Rendered | null = null;
  const sync = () => {
    const el = elementOf(host.result.current, PartyTicketModal);
    if (!el) throw new Error('no ticket modal on the party screen');
    if (!modal) modal = renderHook((p: Record<string, unknown>) => PartyTicketModal(p as never), el.props);
    else modal.rerender(el.props);
    return modal;
  };
  const open = buttonIn(host.result.current, 'Add tickets');
  expect(open, 'Add tickets').not.toBeNull();
  open!();
  sync();
  const summary = () => elementOf(sync().result.current, OrderSummary)!;
  return {
    isOpen: () => elementOf(host.result.current, PartyTicketModal)!.props.open === true,
    /** The tier step, then a day pass: one line, one kid and one adult, as the till starts a line. */
    async startOrder() {
      await settle(); // the parent's member lookup answers
      const tiers = elementOf(sync().result.current, StepCustomerType)!;
      (tiers.props.onPickTier as (t: string) => void)(getDefaultTier().id);
      sync();
      const grid = elementOf(sync().result.current, StepAddTicket)!;
      (grid.props.onSelectTicket as (t: unknown) => void)(getTicketTypes()[0]);
      sync();
    },
    lines: () => summary().props.lines as CartLine[],
    addAnAdult() {
      const line = (summary().props.lines as CartLine[])[0]!;
      (summary().props.onUpdateLine as (id: string, u: Partial<CartLine>) => void)(line.id, { adults: line.adults + 1 });
      sync();
    },
    heldNoteShown: () => isEl(summary().props.priceNote) && (summary().props.priceNote as El).type === PartyChargeHeldNote,
    async charge() {
      (summary().props.onPay as () => void)();
      await settle();
      sync();
    },
  };
}

const toastTitles = () => toastMock.mock.calls.map((c) => (c[0] as { title?: string }).title);

// =============================================================================
// The plain path and the plain retry
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
    expect(screen.isOpen()).toBe(true); // "Charge not confirmed": the order is held, open
    await screen.charge();
    expect(server.charges).toHaveLength(1);
    const [first, second] = postMock.mock.calls;
    expect(second![1]).toEqual(first![1]);
    expect(screen.isOpen()).toBe(false);
  });
});

// =============================================================================
// FINDING (fixed) — an answer lost, then the order changed: the first items charged twice
// =============================================================================

describe('FINDING: a charge whose answer was lost, then the open order changed — the tab must not carry the first items twice', () => {
  /**
   * Pad Thai is charged; the answer is lost. The guest also wants a drink and
   * staff tap it: the order is held as it was sent, so the drink is not added,
   * and the next press sends the Pad Thai order again — the same request,
   * answered with the charge that was made. The drink is an order of its own.
   */
  it('iPad: each item the guest ordered is on the tab once', async () => {
    const [a, b] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge(); // recorded, answer lost
    expect(server.charges).toHaveLength(1);
    screen.tap(b); // the order is held: nothing is added
    await screen.charge(); // the same order again: the stored answer
    if (screen.isOpen()) await screen.charge(); // staff press again
    const ordered = sent()[sent().length - 1]!.totalSatang; // the whole order, Pad Thai + drink
    // One story: the tab carries what was ordered — never more.
    expect(chargedSatang()).toBeLessThanOrEqual(ordered);
  });

  // The review's pin of the defect's make-up, turned round: what the fix is
  // made of, press by press.
  it('iPad: what the fix is made of, press by press', async () => {
    const [a, b] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge(); // charged; its answer lost
    // Not confirmed — never "not charged": it may be on the tab, and it is.
    expect(toastTitles()).toEqual(['Charge not confirmed']);
    expect(screen.heldNoteShown()).toBe(true);
    // Held exactly as it was sent: the drink is not added, the order is not
    // cleared or changed, and the modal is not left.
    screen.tap(b);
    screen.tryToLeaveOrChange();
    expect(screen.order()).toEqual({ 'mi-pad-thai': 1 });
    expect(screen.isOpen()).toBe(true);
    expect(toastTitles().filter((t) => t === 'Order held').length).toBeGreaterThanOrEqual(4);
    expect(postMock).toHaveBeenCalledTimes(1);

    await screen.charge();
    const bodies = sent();
    expect(bodies).toHaveLength(2);
    // Press 2 is press 1 again: the same body, charge id, action id and key ...
    expect(postMock.mock.calls[1]![1]).toEqual(postMock.mock.calls[0]![1]);
    expect(postMock.mock.calls[1]![2]).toEqual(postMock.mock.calls[0]![2]);
    // ... answered with the charge that was made: one charge, and the modal closes.
    expect(server.charges.map((c) => c.items.map((i) => i.name))).toEqual([['Pad Thai']]);
    expect(screen.isOpen()).toBe(false);
    expect(toastTitles()).not.toContain('Not charged to the party');

    // The drink is its own order, under ids of its own.
    screen.open();
    expect(screen.order()).toEqual({});
    screen.tap(b);
    await screen.charge();
    expect(sent()[2]!.chargeId).not.toBe(bodies[0]!.chargeId);
    expect(sent()[2]!.key).not.toBe(bodies[0]!.key);
    expect(server.charges.map((c) => c.items.map((i) => i.name))).toEqual([['Pad Thai'], ['Coke']]);
    expect(chargedSatang()).toBe(bodies[0]!.totalSatang + sent()[2]!.totalSatang);
    expect(screen.isOpen()).toBe(false);
  });

  it('phone: each item the guest ordered is on the tab once', async () => {
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
   * Extra tickets take the same path (`handleChargeExtra('ticket')`), driven
   * here through the ticket modal as staff drive it: the tier, a day pass, the
   * charge; its answer lost; an adult added to the line; the charge again.
   */
  it('iPad, extra tickets: a lost answer, then a line added — each ticket on the tab once', async () => {
    const screen = ipadTickets();
    await screen.startOrder();
    expect(screen.lines()).toHaveLength(1);
    server.loseNextAnswer = true;
    await screen.charge(); // charged; its answer lost — the modal stays open, the order held
    expect(server.charges).toHaveLength(1);
    expect(screen.isOpen()).toBe(true);
    expect(screen.heldNoteShown()).toBe(true);
    const asSent = screen.lines()[0]!;
    screen.addAnAdult(); // held: not added
    expect(screen.lines()[0]!.adults).toBe(asSent.adults);
    await screen.charge();
    if (screen.isOpen()) await screen.charge();
    expect(server.charges).toHaveLength(1);
    expect(postMock.mock.calls[1]![1]).toEqual(postMock.mock.calls[0]![1]);
    expect(chargedSatang()).toBe(sent()[0]!.totalSatang);
    expect(screen.isOpen()).toBe(false);
    expect(toastTitles()).toContain('Charge not confirmed');
    expect(toastTitles()).not.toContain('Not charged to the party');
  });
});

// =============================================================================
// The hold, the other way round: a definite no, and a press that sends nothing
// =============================================================================

describe('the held order — a definite no gives it back; a press that sends nothing keeps it held', () => {
  it('iPad: a definite refusal says "Not charged to the party" and the order is staff’s again — changed, it is a charge of its own', async () => {
    const [a, b] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.refuseNext = new ApiError(409, 'EVENT_ARCHIVED', 'This party has been archived in the OTO App');
    await screen.charge();
    expect(server.charges).toHaveLength(0);
    expect(toastTitles()).toEqual(['Not charged to the party']);
    expect(screen.heldNoteShown()).toBe(false);
    expect(screen.isOpen()).toBe(true);
    // Open to change: the drink goes on, and the press is a new charge under new ids.
    screen.tap(b);
    expect(screen.order()).toEqual({ 'mi-pad-thai': 1, 'mi-coke': 1 });
    await screen.charge();
    expect(sent()[1]!.chargeId).not.toBe(sent()[0]!.chargeId);
    expect(server.charges.map((c) => c.items.map((i) => i.name))).toEqual([['Pad Thai', 'Coke']]);
    expect(screen.isOpen()).toBe(false);
  });

  it('iPad: held, then no connection — nothing is sent and the order stays held; back online, the same request', async () => {
    const [a, b] = twoPlainItems();
    const screen = ipadFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge();
    lane.value = 'box';
    await screen.charge();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toContain('No connection');
    expect(screen.heldNoteShown()).toBe(true);
    screen.tap(b);
    expect(screen.order()).toEqual({ 'mi-pad-thai': 1 });
    lane.value = 'platform';
    await screen.charge();
    expect(postMock.mock.calls[1]![1]).toEqual(postMock.mock.calls[0]![1]);
    expect(server.charges).toHaveLength(1);
    expect(screen.isOpen()).toBe(false);
  });

  it('phone: held after a lost answer — no going back, the note says why, and Checkout sends the same request', async () => {
    const [a, b] = twoPlainItems();
    const screen = phoneFnb();
    screen.tap(a);
    server.loseNextAnswer = true;
    await screen.charge();
    expect(toastTitles()).toEqual(['Charge not confirmed']);
    expect(screen.heldNoteShown()).toBe(true);
    screen.back();
    screen.tap(b);
    expect(screen.stillOnFnb()).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    await screen.charge();
    expect(postMock.mock.calls[1]![1]).toEqual(postMock.mock.calls[0]![1]);
    expect(postMock.mock.calls[1]![2]).toEqual(postMock.mock.calls[0]![2]);
    expect(server.charges.map((c) => c.items.map((i) => i.name))).toEqual([['Pad Thai']]);
    expect(screen.stillOnFnb()).toBe(false);
    expect(toastTitles()).not.toContain('Not charged to the party');
  });
});
