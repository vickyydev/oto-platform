import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyChargeView, PartyWriteAnswer } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { toast } from '@/hooks/use-toast';
import { getDefaultTier, getTicketTypes } from '@/mockApi';
import { branchTradingDate, setBranchRateMode } from '@/lib/pricingMode';
import { computeLineBreakdown } from '@/lib/pricing';
import { Dialog } from '@/components/ui/dialog';
import { MenuGrid } from '@/components/fnb/MenuGrid';
import { FnbCart } from '@/components/fnb/FnbCart';
import { ModifierSheet } from '@/components/fnb/ModifierSheet';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
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
import { MobileFnbCartSheet } from '@/components/mobile/order-station/MobileFnbCartSheet';
import type { CartLine, FnbOrderLine, ManualDiscount, MenuItem, PartyBooking } from '@/types';
import { renderHook, type RenderedHook } from './support/hooks';

/**
 * S2-20 E4 — FOCUSED RE-REVIEW of the third fix round: THE IN-FLIGHT WINDOW of
 * a party charge (SCRUM-217; events-kiosk PLAN, the E4 row of §9, Q3's
 * default; the payment's collect step is the model).
 *
 * The third round holds the order from the press (`usePartyChargeHold`). These
 * tests fire every change and every way out a screen offers — a tap, a line
 * edit, a line removed, a clear, a discount added, applied and removed, Back,
 * close, and the press itself again — at four moments between the press and
 * its answer:
 *
 *   M1  at the press, before anything has resolved;
 *   M2  while the request waits at the platform;
 *   M3  with the platform's answer on its way back;
 *   M4  as the till's host takes the answer, before the screen has it;
 *
 * for each answer the platform can give — (a) a confirm, (b) a definite
 * refusal, (c) an answer lost after the charge was written, (d) a 503 with
 * nothing written, (e) IDEMPOTENCY_IN_FLIGHT while the first request still
 * runs — on the iPad's F&B and ticket modals and the phone's F&B screen. Each
 * ends with exactly one charge, to the satang, of the order sent; the held
 * order releasing only on a definite answer; nothing dropped unsaid; and a
 * screen that can always be left once the answer is definite (never held with
 * nothing to send).
 *
 * The last describe pins what the window does NOT hold: the ticket modal
 * builds the lines it sends again at every press, at the rate mode of that
 * moment, so a held ticket order whose rate mode moves is another press under
 * other ids — the first tickets charged twice. Fixed at landing: the hold
 * keeps what it sent and re-sends it verbatim.
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
/** The day the host reads; reading it again is where the phone's host takes an answer (M4). */
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

// --- The platform behind the till ------------------------------------------------

const BASE = 1_200_000;
const DEPOSIT = 300_000;

const server = {
  charges: [] as PartyChargeView[],
  keys: new Map<string, { hash: string; answer?: PartyWriteAnswer; error?: ApiError }>(),
  loseNextAnswer: false,
  refuseNext: null as ApiError | null,
  revision: 0,
  /** Keys whose first request the platform is still running (IDEMPOTENCY_IN_FLIGHT to a second). */
  running: new Set<string>(),
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

type Post = (path: string, body: unknown, opts?: { idempotencyKey?: string }) => Promise<PartyWriteAnswer>;

/** `POST /parties/:id/charges` behind the idempotency plugin (a 5xx releases the key). */
const platformCharge: Post = async (path, body, opts) => {
  expect(path).toBe(`/parties/${PARTY}/charges`);
  const b = body as { chargeId: string; kind: 'fnb' | 'ticket'; items: PartyChargeView['items']; totalSatang: number };
  const hash = `POST\n${path}\n${JSON.stringify(b)}`;
  const key = opts?.idempotencyKey;
  if (key && server.running.has(key)) {
    throw new ApiError(409, 'IDEMPOTENCY_IN_FLIGHT', 'The original request is still processing, retry the same key shortly');
  }
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
};

/** What the platform does with the request in the window. */
type Outcome = 'confirm' | 'refusal' | 'lost' | '503' | 'in-flight';
const behaviourOf = (outcome: Outcome): Post => {
  switch (outcome) {
    case 'confirm':
    case 'in-flight': // the second press of an in-flight key meets `running`
      return platformCharge;
    case 'refusal':
      return (p, b, o) => {
        server.refuseNext = new ApiError(409, 'EVENT_ARCHIVED', 'This party has been archived in the OTO App');
        return platformCharge(p, b, o);
      };
    case 'lost':
      return (p, b, o) => {
        server.loseNextAnswer = true;
        return platformCharge(p, b, o);
      };
    case '503':
      return async () => {
        throw new ApiError(503, 'UNAVAILABLE', 'The platform could not finish this request');
      };
  }
};

/**
 * The next request parks twice: at the platform's door (M2), and again with
 * its answer decided and on its way back (M3).
 */
function parkNext(behaviour: Post) {
  let openDoor!: () => void;
  let sendBack!: () => void;
  const door = new Promise<void>((r) => (openDoor = r));
  const back = new Promise<void>((r) => (sendBack = r));
  postMock.mockImplementationOnce((async (path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    await door;
    let answer: PartyWriteAnswer | undefined;
    let error: unknown;
    try {
      answer = await behaviour(path, body, opts);
    } catch (err) {
      error = err;
    }
    await back;
    if (error !== undefined) throw error;
    return answer!;
  }) as unknown as typeof api.post);
  return { openDoor, sendBack };
}

/** A first press the till times out on while the platform keeps running it. */
function timeOutStillRunning(): { finish: () => Promise<void> } {
  let finish: () => Promise<void> = async () => undefined;
  postMock.mockImplementationOnce((async (path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    const key = opts!.idempotencyKey!;
    server.running.add(key);
    finish = async () => {
      server.running.delete(key);
      await platformCharge(path, body, opts);
    };
    throw new NetworkError('timed out');
  }) as unknown as typeof api.post);
  return { finish: () => finish() };
}

/** One-shot: fired the first time the host acts on an answer (a toast, a re-read, onChanged). */
const hostHook = { fn: null as null | (() => void) };
const fireHostHook = () => {
  const fn = hostHook.fn;
  hostHook.fn = null;
  fn?.();
};

beforeEach(() => {
  server.charges = [];
  server.keys = new Map();
  server.loseNextAnswer = false;
  server.refuseNext = null;
  server.revision = 0;
  server.running = new Set();
  lane.value = 'platform';
  hostHook.fn = null;
  postMock.mockReset();
  postMock.mockImplementation(platformCharge as unknown as typeof api.post);
  getMock.mockReset();
  getMock.mockResolvedValue({ member: null });
  toastMock.mockReset();
  toastMock.mockImplementation((() => {
    fireHostHook();
    return { id: 't', dismiss: () => undefined, update: () => undefined };
  }) as never);
  day.revision = -1;
  day.current = () => {
    if (hostHook.fn) fireHostHook();
    if (day.revision !== server.revision) {
      day.revision = server.revision;
      day.cached = [toOtoEvent(viewOf(), 'hkt-central')];
    }
    return day.cached;
  };
  // A weekday the platform answered for: the rate mode is the test's, not the calendar's.
  setBranchRateMode({ date: branchTradingDate(), mode: 'weekday', reason: 'Weekday pricing' });
});
afterEach(() => {
  setBranchRateMode(null);
});

// --- Pressing what is on the screen ------------------------------------------------

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
function buttonIn(tree: unknown, words: string): (() => unknown) | null {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    const text = textOf(el.props.children).replace(/\s+/g, ' ').trim();
    if (text === words || text.startsWith(words)) return el.props.onClick as () => unknown;
  }
  return null;
}
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
type Fn = (...args: unknown[]) => unknown;
const call = (el: El | null, prop: string, ...args: unknown[]) => {
  expect(el, `an element carrying ${prop}`).not.toBeNull();
  const fn = el!.props[prop];
  expect(typeof fn, prop).toBe('function');
  return (fn as Fn)(...args);
};

type Rendered = RenderedHook<Record<string, unknown>, unknown>;

const PAD_THAI: MenuItem = { id: 'mi-pad-thai', name: 'Pad Thai', category: 'food', price: { weekday: 180, weekend: 180 } };
const COKE: MenuItem = { id: 'mi-coke', name: 'Coke', category: 'drinks', price: { weekday: 50, weekend: 50 } };
const WATER: MenuItem = { id: 'mi-water', name: 'Water', category: 'drinks', price: { weekday: 30, weekend: 30 } };

const discount = (id: string, amountTHB: number): ManualDiscount => ({
  id,
  scope: 'order',
  type: 'fixed',
  value: amountTHB,
  reason: 'Manager goodwill',
  amountTHB,
  appliedBy: 'Som (Reception)',
  appliedById: 'acc-som',
  appliedAt: `${T}T06:00:00.000Z`,
});

/** What each request sent: the charge id, its key and the order's total. */
const sent = () =>
  postMock.mock.calls.map((c) => ({
    body: c[1] as { chargeId: string; actionId: string; totalSatang: number; items: unknown[] },
    key: (c[2] as { idempotencyKey: string }).idempotencyKey,
  }));
const toastTitles = () => toastMock.mock.calls.map((c) => (c[0] as { title?: string }).title);
const heldToasts = () => toastTitles().filter((t) => t === 'Order held').length;

/** One screen under attack, whichever it is. */
interface Surface {
  name: string;
  /** Build the order staff charge: two items (or a ticket line) and an order discount. */
  build(): Promise<void>;
  /** The order as the screen holds it, comparable. */
  snapshot(): string;
  /** The total the screen shows, in baht. */
  shownTotal(): number;
  /** Every press that would change or leave the order. */
  attempts(): Array<[string, () => void]>;
  /** The charge press, fired and not awaited. */
  press(): void;
  /** The charge press can be pressed (the ticket modal greys it while sending). */
  canPress(): boolean;
  heldNote(): boolean;
  /** The screen is gone: the modal closed, the phone back on the party. */
  gone(): boolean;
  /** Come back to the party's F&B or tickets. */
  reopen(): Promise<void>;
  /** A change staff make to an order that is theirs: refused never, the order moves. */
  change(): void;
  /** Leave by the ordinary way out (close, Cancel, Back). */
  leave(): void;
  /** F&B: the modifier sheet's save, as it stands (three of the line it was opened on). */
  sheetSave?: () => void;
}

/** The party page as the host holds it; `onChanged` reads the day again (and is M4 on the iPad). */
function partyPage() {
  const props = (): Record<string, unknown> => ({
    party: partyNow(),
    surface: 'till',
    onBack: () => undefined,
    onChanged: () => {
      fireHostHook();
      host.rerender(props());
    },
  });
  const host: Rendered = renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props());
  return host;
}

function ipadFnb(): Surface {
  const host = partyPage();
  let modal: Rendered | null = null;
  const sync = () => {
    const el = elementOf(host.result.current, PartyFnbModal)!;
    if (!modal) modal = renderHook((p: Record<string, unknown>) => PartyFnbModal(p as never), el.props);
    else modal.rerender(el.props);
    return modal.result.current;
  };
  const cart = () => elementOf(sync(), FnbCart)!;
  const lines = () => cart().props.lines as FnbOrderLine[];
  const open = () => {
    const button = buttonIn(host.result.current, 'Add F&B to party');
    expect(button, 'Add F&B to party').not.toBeNull();
    button!();
    sync();
  };
  open();
  return {
    name: 'iPad F&B',
    async build() {
      call(elementOf(sync(), MenuGrid), 'onAdd', PAD_THAI);
      call(elementOf(sync(), MenuGrid), 'onAdd', COKE);
      call(elementOf(sync(), ManualDiscountModal), 'onApply', discount('md-goodwill', 10));
      sync();
    },
    snapshot: () =>
      JSON.stringify({
        lines: lines().map((l) => [l.menuItem.id, l.qty, l.lineTotal, l.note ?? '', l.selectedModifiers]),
        discounts: (cart().props.manualDiscounts as ManualDiscount[]).map((d) => d.id),
        total: cart().props.total,
      }),
    shownTotal: () => cart().props.total as number,
    attempts: () => [
      ['tap a drink', () => call(elementOf(sync(), MenuGrid), 'onAdd', WATER)],
      ['tap an item already on it', () => call(elementOf(sync(), MenuGrid), 'onAdd', PAD_THAI)],
      ['open a line to edit it', () => call(cart(), 'onEditLine', lines()[0])],
      ['one more of a line', () => call(cart(), 'onChangeQty', lines()[0]!.id, lines()[0]!.qty + 1)],
      ['remove a line', () => call(cart(), 'onChangeQty', lines()[0]!.id, 0)],
      ['remove the other line', () => call(cart(), 'onChangeQty', lines()[1]!.id, 0)],
      ['clear', () => call(cart(), 'onClear')],
      ['open the discount', () => call(cart(), 'onAddManualDiscount')],
      ['apply a discount', () => call(elementOf(sync(), ManualDiscountModal), 'onApply', discount('md-late', 20))],
      ['remove the discount', () => call(cart(), 'onRemoveManualDiscount', 'md-goodwill')],
      ['back to the tab', () => call(cart(), 'onSwitchTab')],
      ['close (Escape, the cross)', () => call(elementOf(sync(), Dialog), 'onOpenChange', false)],
    ],
    press: () => void call(cart(), 'onCheckout'),
    canPress: () => lines().length > 0,
    heldNote: () => elementOf(sync(), PartyChargeHeldNote) !== null,
    gone: () => elementOf(host.result.current, PartyFnbModal)!.props.open !== true,
    async reopen() {
      open();
    },
    change: () => call(elementOf(sync(), MenuGrid), 'onAdd', WATER),
    leave: () => call(elementOf(sync(), Dialog), 'onOpenChange', false),
    sheetSave: () => {
      const sheet = elementOf(sync(), ModifierSheet)!;
      expect(sheet.props.open, 'the sheet is up').toBe(true);
      call(sheet, 'onSave', [], 3, 'no peanuts');
    },
  };
}

/** THE PHONE: Parties → a party → Add F&B → MobilePartyFnb, mounted and unmounted as React would. */
function phoneFnb(): Surface {
  const host: Rendered = renderHook(() => MobileParties() as never, {});
  const tree = () => host.result.current;
  (elementOf(tree(), MobileEventsList)!.props.onSelectEvent as (id: string, date: string) => void)(PARTY, T);
  let screen: Rendered | null = null;
  const sync = () => {
    const el = elementOf(tree(), MobilePartyFnb);
    if (!el) {
      screen?.unmount();
      screen = null;
      return null;
    }
    if (!screen) screen = renderHook((p: Record<string, unknown>) => MobilePartyFnb(p as never), el.props);
    else screen.rerender(el.props);
    return screen.result.current;
  };
  const open = () => {
    (elementOf(tree(), MobilePartyDetail)!.props.onAddFnb as () => void)();
    sync();
  };
  open();
  const sheet = () => elementOf(sync(), MobileFnbCartSheet)!;
  const lines = () => sheet().props.lines as FnbOrderLine[];
  const backArrow = () => [...walk(sync())].find((el) => el.props['aria-label'] === 'Back') ?? null;
  return {
    name: 'phone F&B',
    async build() {
      call(elementOf(sync(), MenuGrid), 'onAdd', PAD_THAI);
      call(elementOf(sync(), MenuGrid), 'onAdd', COKE);
      call(elementOf(sync(), ManualDiscountModal), 'onApply', discount('md-goodwill', 10));
      sync();
    },
    snapshot: () =>
      JSON.stringify({
        lines: lines().map((l) => [l.menuItem.id, l.qty, l.lineTotal, l.note ?? '', l.selectedModifiers]),
        discounts: (sheet().props.manualDiscounts as ManualDiscount[]).map((d) => d.id),
        quantities: elementOf(sync(), MenuGrid)!.props.quantities,
      }),
    shownTotal: () => {
      const discounts = sheet().props.manualDiscounts as ManualDiscount[];
      const amounts = sheet().props.manualAmounts as Record<string, number>;
      // The phone's sheet shows lines and discounts; the total it sends is what the screen computes.
      return lines().reduce((s, l) => s + l.lineTotal, 0) - discounts.reduce((s, d) => s + (amounts[d.id] ?? 0), 0);
    },
    attempts: () => [
      ['tap a drink', () => call(elementOf(sync(), MenuGrid), 'onAdd', WATER)],
      ['tap an item already on it', () => call(elementOf(sync(), MenuGrid), 'onAdd', PAD_THAI)],
      ['open a line to edit it', () => call(sheet(), 'onEditLine', lines()[0])],
      ['one more of a line', () => call(sheet(), 'onChangeQty', lines()[0]!.id, lines()[0]!.qty + 1)],
      ['remove a line', () => call(sheet(), 'onChangeQty', lines()[0]!.id, 0)],
      ['remove the other line', () => call(sheet(), 'onChangeQty', lines()[1]!.id, 0)],
      ['clear', () => call(sheet(), 'onClear')],
      ['open the discount', () => call(sheet(), 'onAddManualDiscount')],
      ['apply a discount', () => call(elementOf(sync(), ManualDiscountModal), 'onApply', discount('md-late', 20))],
      ['remove the discount', () => call(sheet(), 'onRemoveManualDiscount', 'md-goodwill')],
      ['the back arrow', () => call(backArrow(), 'onClick')],
      ["the cart sheet's way back", () => call(sheet(), 'onSwitchTab')],
    ],
    press: () => void call(sheet(), 'onCheckout'),
    canPress: () => lines().length > 0,
    heldNote: () => elementOf(sync(), PartyChargeHeldNote) !== null,
    gone: () => sync() === null,
    async reopen() {
      open();
    },
    change: () => call(elementOf(sync(), MenuGrid), 'onAdd', WATER),
    leave: () => {
      call(backArrow(), 'onClick');
      sync();
    },
    sheetSave: () => {
      const sheet = elementOf(sync(), ModifierSheet)!;
      expect(sheet.props.open, 'the sheet is up').toBe(true);
      call(sheet, 'onSave', [], 3, 'no peanuts');
    },
  };
}

/** THE IPAD: Events → a party → "Add tickets" → PartyTicketModal. */
function ipadTickets(): Surface {
  const host = partyPage();
  let modal: Rendered | null = null;
  const sync = () => {
    const el = elementOf(host.result.current, PartyTicketModal)!;
    if (!modal) modal = renderHook((p: Record<string, unknown>) => PartyTicketModal(p as never), el.props);
    else modal.rerender(el.props);
    return modal.result.current;
  };
  const summary = () => elementOf(sync(), OrderSummary)!;
  const lines = () => summary().props.lines as CartLine[];
  const open = () => {
    const button = buttonIn(host.result.current, 'Add tickets');
    expect(button, 'Add tickets').not.toBeNull();
    button!();
    sync();
  };
  open();
  return {
    name: 'iPad tickets',
    async build() {
      await settle(); // the parent's member lookup answers
      call(elementOf(sync(), StepCustomerType), 'onPickTier', getDefaultTier().id);
      call(elementOf(sync(), StepAddTicket), 'onSelectTicket', getTicketTypes()[0]);
      call(summary(), 'onUpdateLine', lines()[0]!.id, { kids: 2 });
      call(elementOf(sync(), ManualDiscountModal), 'onApply', discount('md-goodwill', 10));
      sync();
    },
    snapshot: () =>
      JSON.stringify({
        lines: lines().map((l) => [l.id, l.ticketType.id, l.tier, l.kids, l.adults, l.socks, l.addOns, l.lineTotal]),
        discounts: (summary().props.manualDiscounts as ManualDiscount[]).map((d) => d.id),
        label: summary().props.payLabel,
      }),
    shownTotal: () => Number(/฿([\d.]+)/.exec(String(summary().props.payLabel))![1]),
    attempts: () => [
      ['add a ticket', () => call(elementOf(sync(), StepAddTicket), 'onSelectTicket', getTicketTypes()[0])],
      ['an adult more (summary)', () => call(summary(), 'onUpdateLine', lines()[0]!.id, { adults: lines()[0]!.adults + 1 })],
      ['a kid more (ticket step)', () => call(elementOf(sync(), StepAddTicket), 'onUpdateLine', lines()[0]!.id, { kids: lines()[0]!.kids + 1 })],
      ['remove the line', () => call(summary(), 'onRemoveLine', lines()[0]!.id)],
      ['open the discount', () => call(summary(), 'onAddManualDiscount')],
      ['apply a discount', () => call(elementOf(sync(), ManualDiscountModal), 'onApply', discount('md-late', 20))],
      ['remove the discount', () => call(summary(), 'onRemoveManualDiscount', 'md-goodwill')],
      ['Cancel', () => call(summary(), 'onCancel')],
      ['close (Escape, the cross)', () => call(elementOf(sync(), Dialog), 'onOpenChange', false)],
    ],
    press: () => void call(summary(), 'onPay'),
    canPress: () => summary().props.canPay === true,
    heldNote: () => {
      const note = summary().props.priceNote;
      return isEl(note) && note.type === PartyChargeHeldNote;
    },
    gone: () => elementOf(host.result.current, PartyTicketModal)!.props.open !== true,
    async reopen() {
      open();
      await settle();
      call(elementOf(sync(), StepCustomerType), 'onPickTier', getDefaultTier().id);
    },
    change: () => call(elementOf(sync(), StepAddTicket), 'onSelectTicket', getTicketTypes()[0]),
    leave: () => call(summary(), 'onCancel'),
  };
}

const SURFACES: Array<[string, () => Surface]> = [
  ['iPad F&B', ipadFnb],
  ['phone F&B', phoneFnb],
  ['iPad tickets', ipadTickets],
];

/**
 * Fire every change and way out, and the press again: each change refused out
 * loud (one "Order held" apiece, nothing else said), the press again sending
 * nothing, and the order on screen still the order sent.
 */
function attackHeld(s: Surface, asSent: string, when: string, sending = true) {
  const unrefused: string[] = [];
  for (const [label, attempt] of s.attempts()) {
    const before = heldToasts();
    const toastsBefore = toastMock.mock.calls.length;
    attempt();
    if (heldToasts() !== before + 1 || toastMock.mock.calls.length !== toastsBefore + 1) unrefused.push(label);
  }
  if (sending) {
    // On its way: the press again sends nothing (after a lost answer it is the retry, pressed by the caller).
    const posts = postMock.mock.calls.length;
    s.press();
    expect(postMock.mock.calls.length, `${when}: a second press sends nothing`).toBe(posts);
  }
  expect(unrefused, `${when}: each of these must be refused with one "Order held"`).toEqual([]);
  expect(s.gone(), `${when}: the screen is not left`).toBe(false);
  expect(s.snapshot(), `${when}: the order is the order sent`).toBe(asSent);
}

/** Once the answer is definite: the screen can be left, and comes back empty and open. */
async function neverStuck(s: Surface) {
  if (!s.gone()) s.leave();
  expect(s.gone(), 'a definite answer: the screen can be left').toBe(true);
  await s.reopen();
  const before = heldToasts();
  s.change();
  expect(heldToasts(), 'reopened: nothing held').toBe(before);
  expect(s.heldNote()).toBe(false);
}

type Moment = 'M1 at the press' | 'M2 at the platform' | 'M3 the answer on its way back' | 'M4 as the host takes it';
const MOMENTS: Moment[] = ['M1 at the press', 'M2 at the platform', 'M3 the answer on its way back', 'M4 as the host takes it'];

/**
 * One press, parked, attacked at `moment`, and let go. `asSent` is the order
 * on screen at the press. Returns once the answer has landed.
 */
async function pressAndAttack(s: Surface, outcome: Outcome, moment: Moment, asSent: string) {
  const { openDoor, sendBack } = parkNext(behaviourOf(outcome));
  s.press();
  if (moment === 'M1 at the press') attackHeld(s, asSent, moment);
  await settle();
  if (moment === 'M2 at the platform') attackHeld(s, asSent, moment);
  if (s.name === 'iPad tickets') expect(s.canPress(), 'sending: the ticket press is greyed').toBe(false);
  expect(s.heldNote(), 'sending: no "press charge again" note yet').toBe(false);
  if (moment === 'M4 as the host takes it') hostHook.fn = () => attackHeld(s, asSent, moment);
  openDoor();
  await settle();
  if (moment === 'M3 the answer on its way back') attackHeld(s, asSent, moment);
  sendBack();
  await settle();
  if (moment === 'M4 as the host takes it') expect(hostHook.fn, 'the host took the answer').toBeNull();
}

// =============================================================================
// The matrix: three screens × five answers × four moments
// =============================================================================

describe.each(SURFACES)('%s — the in-flight window, attacked', (_name, make) => {
  describe.each(MOMENTS)('%s', (moment) => {
    it('(a) a confirm: one charge of the order sent, to the satang; the screen closes; nothing tapped meanwhile dropped unsaid', async () => {
      const s = make();
      await s.build();
      const asSent = s.snapshot();
      const shown = s.shownTotal();
      await pressAndAttack(s, 'confirm', moment, asSent);
      expect(server.charges).toHaveLength(1);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]!.body.totalSatang).toBe(Math.round(shown * 100));
      expect(chargedSatang()).toBe(Math.round(shown * 100));
      expect(s.gone()).toBe(true);
      expect(toastTitles().filter((t) => t !== 'Order held')).toEqual([]);
      await neverStuck(s);
      expect(server.charges).toHaveLength(1);
    });

    it('(b) a definite refusal: nothing charged; the order given back as it was sent; changed, it is a charge of its own', async () => {
      const s = make();
      await s.build();
      const asSent = s.snapshot();
      await pressAndAttack(s, 'refusal', moment, asSent);
      expect(server.charges).toHaveLength(0);
      expect(toastTitles().filter((t) => t !== 'Order held')).toEqual(['Not charged to the party']);
      expect(s.gone()).toBe(false);
      expect(s.heldNote()).toBe(false);
      expect(s.snapshot()).toBe(asSent);
      expect(s.canPress()).toBe(true);
      // Staff's again: a change goes through, unrefused.
      const before = heldToasts();
      s.change();
      expect(heldToasts()).toBe(before);
      expect(s.snapshot()).not.toBe(asSent);
      const shown = s.shownTotal();
      s.press();
      await settle();
      expect(sent()).toHaveLength(2);
      expect(sent()[1]!.body.chargeId).not.toBe(sent()[0]!.body.chargeId);
      expect(sent()[1]!.key).not.toBe(sent()[0]!.key);
      expect(server.charges).toHaveLength(1);
      expect(chargedSatang()).toBe(Math.round(shown * 100));
      expect(s.gone()).toBe(true);
      await neverStuck(s);
    });

    it('(c) an answer lost after the charge was written: held as sent; the press again is the same request; one charge', async () => {
      const s = make();
      await s.build();
      const asSent = s.snapshot();
      const shown = s.shownTotal();
      await pressAndAttack(s, 'lost', moment, asSent);
      expect(server.charges).toHaveLength(1);
      expect(toastTitles().filter((t) => t !== 'Order held')).toEqual(['Charge not confirmed']);
      expect(s.heldNote()).toBe(true);
      expect(s.canPress(), 'held: the press is always there to confirm it').toBe(true);
      attackHeld(s, asSent, 'unanswered', false);
      s.press();
      await settle();
      expect(sent()).toHaveLength(2);
      expect(sent()[1]!.body).toEqual(sent()[0]!.body);
      expect(sent()[1]!.key).toBe(sent()[0]!.key);
      expect(server.charges).toHaveLength(1);
      expect(chargedSatang()).toBe(Math.round(shown * 100));
      expect(s.gone()).toBe(true);
      expect(toastTitles()).not.toContain('Not charged to the party');
      await neverStuck(s);
    });

    it('(d) a 503 with nothing written: held as sent; the press again is the same request; one charge', async () => {
      const s = make();
      await s.build();
      const asSent = s.snapshot();
      const shown = s.shownTotal();
      await pressAndAttack(s, '503', moment, asSent);
      expect(server.charges).toHaveLength(0);
      expect(toastTitles().filter((t) => t !== 'Order held')).toEqual(['Charge not confirmed']);
      expect(s.heldNote()).toBe(true);
      expect(s.canPress()).toBe(true);
      attackHeld(s, asSent, 'unanswered', false);
      s.press();
      await settle();
      expect(sent()[1]!.body).toEqual(sent()[0]!.body);
      expect(sent()[1]!.key).toBe(sent()[0]!.key);
      expect(server.charges).toHaveLength(1);
      expect(chargedSatang()).toBe(Math.round(shown * 100));
      expect(s.gone()).toBe(true);
      await neverStuck(s);
    });

    it('(e) IDEMPOTENCY_IN_FLIGHT, the first still running: held as sent through both; the stored answer; one charge', async () => {
      const s = make();
      await s.build();
      const asSent = s.snapshot();
      const shown = s.shownTotal();
      const first = timeOutStillRunning();
      s.press(); // timed out at the till; the platform is still on it
      await settle();
      expect(s.heldNote()).toBe(true);
      await pressAndAttack(s, 'in-flight', moment, asSent); // the same request meets the first still running
      expect(server.charges).toHaveLength(0);
      expect(toastTitles().filter((t) => t !== 'Order held')).toEqual(['Charge not confirmed', 'Charge not confirmed']);
      expect(s.heldNote()).toBe(true);
      expect(s.snapshot()).toBe(asSent);
      await first.finish(); // the platform finishes the first and keeps its answer
      expect(server.charges).toHaveLength(1);
      s.press();
      await settle();
      expect(sent()).toHaveLength(3);
      expect(sent()[1]!.body).toEqual(sent()[0]!.body);
      expect(sent()[2]!.body).toEqual(sent()[0]!.body);
      expect(new Set(sent().map((x) => x.key)).size).toBe(1);
      expect(server.charges).toHaveLength(1);
      expect(chargedSatang()).toBe(Math.round(shown * 100));
      expect(s.gone()).toBe(true);
      await neverStuck(s);
    });
  });
});

// =============================================================================
// Opened before the press, used in the window: the modifier sheet and the discount modal
// =============================================================================

describe('a sheet or modal opened before the press, used while the charge is on its way and after its answer was lost', () => {
  async function openThenPress(s: Surface, opens: string[], saves: Array<[string, () => void]>) {
    await s.build();
    for (const label of opens) s.attempts().find(([l]) => l === label)![1]();
    expect(heldToasts()).toBe(0); // the order is open: nothing refused yet
    const asSent = s.snapshot();
    const shown = s.shownTotal();
    const { openDoor, sendBack } = parkNext(behaviourOf('lost'));
    s.press();
    await settle();
    const fire = (when: string) => {
      for (const [label, save] of saves) {
        const before = heldToasts();
        save();
        expect(heldToasts(), `${when}: ${label} refused out loud`).toBe(before + 1);
        expect(s.snapshot(), `${when}: ${label} changed nothing`).toBe(asSent);
      }
    };
    fire('on its way');
    openDoor();
    sendBack();
    await settle();
    expect(s.heldNote()).toBe(true);
    fire('unanswered');
    s.press();
    await settle();
    expect(sent()[1]!.body).toEqual(sent()[0]!.body);
    expect(server.charges).toHaveLength(1);
    expect(chargedSatang()).toBe(Math.round(shown * 100));
    expect(s.gone()).toBe(true);
  }

  it.each([
    ['iPad F&B', ipadFnb],
    ['phone F&B', phoneFnb],
  ] as Array<[string, () => Surface]>)(
    '%s: a line edit saved from the sheet opened before the press, and a discount applied from its modal, are refused; one charge of the order sent',
    async (_name, make) => {
      const s = make();
      await openThenPress(s, ['open a line to edit it', 'open the discount'], [
        ['the sheet saved', () => s.sheetSave!()],
        ['the discount applied', () => s.attempts().find(([l]) => l === 'apply a discount')![1]()],
      ]);
    },
  );

  it('iPad tickets: a discount applied from its modal opened before the press is refused; one charge of the order sent', async () => {
    const s = ipadTickets();
    await openThenPress(s, ['open the discount'], [
      ['the discount applied', () => s.attempts().find(([l]) => l === 'apply a discount')![1]()],
    ]);
  });
});

// =============================================================================
// A press that sends nothing keeps the order held, on every screen
// =============================================================================

describe('held, then no connection: nothing is sent and the order stays held — on the phone and the ticket modal too', () => {
  it.each([
    ['phone F&B', phoneFnb],
    ['iPad tickets', ipadTickets],
  ] as Array<[string, () => Surface]>)('%s', async (_name, make) => {
    const s = make();
    await s.build();
    const asSent = s.snapshot();
    server.loseNextAnswer = true;
    s.press();
    await settle();
    expect(server.charges).toHaveLength(1);
    lane.value = 'box';
    s.press();
    await settle();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toContain('No connection');
    expect(s.heldNote()).toBe(true);
    attackHeld(s, asSent, 'offline', false);
    lane.value = 'platform';
    s.press();
    await settle();
    expect(sent()[1]!.body).toEqual(sent()[0]!.body);
    expect(server.charges).toHaveLength(1);
    expect(s.gone()).toBe(true);
  });
});

// =============================================================================
// FINDING — the ticket modal builds what it sends again at every press, at that moment's rate mode
// =============================================================================

/**
 * `PartyTicketModal.handleCharge` builds the charge's items at each press:
 * `computeLineBreakdown(l)`, whose mode defaults to `todayRateMode()` — the
 * header chip's platform answer (polled every 60 s, trusted for ten minutes),
 * else the device's own trading day. The total is a memo of the lines and so
 * stays as it was. The held order is therefore not the order sent once the
 * rate mode moves under it (the platform's answer changing — a holiday added
 * for today, the 05:00 roll — or a long outage handing the price back to a
 * device clock that disagrees): the press "Charge not confirmed" asks for is
 * another press (`partyChargePress` differs), so the host mints new ids and
 * the first tickets, already on the tab, are charged a second time. And a
 * press that sends nothing (no connection) answers `held: false` for a press
 * that no longer matches, so the order is released on no answer at all.
 *
 * Measured here: two kids and an adult on "1 Hour Play", ฿10 off — ฿1,720
 * sent (Kids 2 × ฿690, Adults 1 × ฿350). The answer lost, the platform then
 * answers weekend: the press again sends Adults at ฿500 under a new key, and
 * the tab carries ฿1,720 twice — the second body's items (฿1,880) not even
 * summing to its total.
 *
 * The payment's collect step, the model, freezes what it sends (amount,
 * tender and the balance shown) when staff leave the bill. F&B is not exposed
 * to the rate mode (each line keeps its own total); its item names are read
 * from the live modifier library at each press, which does not reload under
 * an open screen today.
 */
describe('a held ticket order is the order of its first press, whatever the rate mode does', () => {
  /** The ticket on the order prices differently on a weekend: else these pins prove nothing. */
  function weekendDiffers(s: Surface) {
    const line = (JSON.parse(s.snapshot()) as { lines: unknown[][] }).lines[0]!;
    const ticket = getTicketTypes().find((t) => t.id === line[1])!;
    const asLine = {
      ticketType: ticket,
      tier: line[2],
      kids: line[3],
      adults: line[4],
      socks: line[5],
      addOns: line[6],
    } as unknown as CartLine;
    expect(JSON.stringify(computeLineBreakdown(asLine, 'weekend'))).not.toBe(
      JSON.stringify(computeLineBreakdown(asLine, 'weekday')),
    );
  }

  it('the answer lost, the platform then answers weekend for today; the press again is the same request — the tickets are on the tab once', async () => {
    const s = ipadTickets();
    await s.build();
    weekendDiffers(s);
    const shown = s.shownTotal();
    server.loseNextAnswer = true;
    s.press();
    await settle();
    expect(server.charges).toHaveLength(1);
    expect(s.heldNote()).toBe(true);
    // The header chip's next poll: the platform now prices today as a weekend.
    setBranchRateMode({ date: branchTradingDate(), mode: 'weekend', reason: 'Weekend pricing — Songkran' });
    s.press(); // the press "Charge not confirmed" asks for
    await settle();
    if (!s.gone()) {
      s.press();
      await settle();
    }
    expect(server.charges).toHaveLength(1);
    expect(sent()[1]!.body).toEqual(sent()[0]!.body);
    expect(chargedSatang()).toBe(Math.round(shown * 100));
  });

  it('the answer lost, the rate mode moves, no connection: the press sends nothing and the order stays held', async () => {
    const s = ipadTickets();
    await s.build();
    weekendDiffers(s);
    const asSent = s.snapshot();
    server.loseNextAnswer = true;
    s.press();
    await settle();
    setBranchRateMode({ date: branchTradingDate(), mode: 'weekend', reason: 'Weekend pricing — Songkran' });
    lane.value = 'box';
    s.press();
    await settle();
    expect(postMock).toHaveBeenCalledTimes(1);
    // Nothing answered: still held as it was sent.
    expect(s.heldNote()).toBe(true);
    attackHeld(s, asSent, 'offline after the mode moved', false);
  });
});
