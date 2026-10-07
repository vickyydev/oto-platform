import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyPaymentView, PartyWriteAnswer } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { toast } from '@/hooks/use-toast';
import { PartyBalanceModal } from '@/components/parties/PartyBalanceModal';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import { MobileParties } from '@/components/mobile/parties/MobileParties';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { MobilePartyPayment } from '@/components/mobile/parties/MobilePartyPayment';
import { MobileEventsList } from '@/components/mobile/parties/MobileEventsList';
import type { PartyBooking } from '@/types';
import { renderHook, type RenderedHook } from './support/hooks';

/**
 * S2-20 E4 — REVIEW, the till's presses (SCRUM-217; events-kiosk PLAN, the E4
 * row of §9, §4 "two tills taking the last of a balance", H11, Q3's default).
 *
 * The screens are driven as staff drive them — the iPad's PartyDetail and its
 * balance modal, the phone's MobileParties and its payment screen — press by
 * press, on the till's own hook harness (no DOM: `test/support/hooks.ts` in
 * place of React's hooks, every other part of React kept). Behind them is a
 * platform that answers as the api does: the balance check
 * (`expectedOutstandingSatang`, 409 PARTY_BALANCE_CHANGED), the cap at the
 * balance (`Math.min(Math.floor(amount), outstanding)`), the idempotency store
 * (same key + same body = the stored answer; same key + another body = 409
 * IDEMPOTENCY_MISMATCH; a 4xx is stored too), and an answer that can be lost
 * on its way back after the payment was recorded.
 *
 * One story to the satang: what staff collected, what the settlement screen
 * thanks the guest for, and what the platform recorded are the same money.
 *
 * FINDING (pinned with `it.fails` by the review, flipped by the fix round):
 * the till froze the amount it collects when staff leave the review step, but
 * sent as `expectedOutstandingSatang` the balance of the party as it was shown
 * at the moment of the press — and after a refusal or a lost answer the party
 * is read again under the open collect step (`settled` → `onChanged`/`bump`).
 * So the press after a refusal, or the retry after a lost answer, carried the
 * NEW balance with the OLD amount: the balance guard passed, the cap recorded
 * less than was collected, and the retry of a recorded payment was no longer
 * the same request under its key, so it was refused and then taken a second
 * time.
 *
 * THE FIX: the balance shown is frozen with the amount and passed through
 * `onConfirm`, so every retry under the same ids is the same request and a
 * moved balance is always refused; a definite refusal takes staff back to the
 * bill as it now reads; and the thank-you shows the money the platform
 * recorded (`answer.payment.amountSatang`).
 */

// The till's JSX compiles to `React.createElement` here, as in the other screen tests.
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
// The phone's day list, read from the platform behind it: the server below.
const day = vi.hoisted(() => ({ events: [] as unknown[], revision: -1, cached: [] as unknown[], current: () => [] as unknown[] }));
vi.mock('@/api/events', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/events')>();
  return {
    ...original,
    useEventsForDate: () => ({ events: day.current(), loaded: true, error: null }),
  };
});

const postMock = vi.mocked(api.post);
const toastMock = vi.mocked(toast);
const toastTitles = () => toastMock.mock.calls.map((c) => (c[0] as { title?: string }).title);

// --- The platform behind the till ----------------------------------------------

interface Recorded {
  id: string;
  amountSatang: number;
  /** What the till asked to take, before the cap. */
  askedSatang: number;
  /** Which till took it: this one, or another at the counter. */
  by: 'this-till' | 'other-till';
}

const BASE = 1_200_000;
const DEPOSIT = 300_000;

const server = {
  payments: [] as Recorded[],
  keys: new Map<string, { body: string; status: number; answer?: PartyWriteAnswer; error?: ApiError }>(),
  /** The next accepted payment is recorded, and its answer lost on the way back. */
  loseNextAnswer: false,
  /** The next request never reaches the platform at all. */
  dropNextRequest: false,
  revision: 0,
  /** An F&B charge on the tab, in satang (the fix round: a balance with satang). */
  chargeSatang: 0,
};

const owed = () =>
  Math.max(0, BASE + server.chargeSatang - DEPOSIT - server.payments.reduce((s, p) => s + p.amountSatang, 0));

function viewOf(): EventView {
  const payments: PartyPaymentView[] = server.payments.map((p, i) => ({
    id: p.id,
    amountSatang: p.amountSatang,
    method: 'card',
    kind: 'card',
    takenBy: p.by === 'this-till' ? 'Som (Reception)' : 'Nok',
    takenById: 'acc',
    takenAt: `${T}T0${Math.min(9, i + 5)}:00:00.000Z`,
    businessDate: T,
    attemptId: `att-${i}`,
  }));
  const paid = server.payments.reduce((s, p) => s + p.amountSatang, 0);
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
      charges: server.chargeSatang
        ? [
            {
              id: 'c-fnb',
              kind: 'fnb',
              items: [{ name: 'Pad Thai', qty: 1, lineTotalSatang: server.chargeSatang }],
              totalSatang: server.chargeSatang,
              chargedBy: 'Som (Reception)',
              chargedById: 'acc',
              chargedAt: `${T}T04:00:00.000Z`,
            },
          ]
        : [],
      payments,
      lastEdited: null,
      editSync: null,
      bill: {
        baseSatang: BASE,
        chargesSatang: server.chargeSatang,
        totalSatang: BASE + server.chargeSatang,
        depositSatang: DEPOSIT,
        paidSatang: paid,
        outstandingSatang: owed(),
      },
    },
    attendeeCount: 0,
    attendees: [],
    roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
  };
}

const partyNow = () => toOtoEvent(viewOf(), 'hkt-central') as unknown as PartyBooking;

/** `POST /parties/:id/payments` as the api answers it, behind the idempotency store. */
async function platformPay(path: string, body: unknown, opts?: { idempotencyKey?: string }): Promise<PartyWriteAnswer> {
  expect(path).toBe(`/parties/${PARTY}/payments`);
  if (server.dropNextRequest) {
    server.dropNextRequest = false;
    throw new NetworkError('dropped');
  }
  const b = body as { paymentId: string; amountSatang: number; expectedOutstandingSatang?: number };
  const json = JSON.stringify(b);
  const key = opts?.idempotencyKey;
  const prior = key ? server.keys.get(key) : undefined;
  if (prior) {
    if (prior.body !== json) {
      throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request');
    }
    if (prior.error) throw prior.error;
    return { ...prior.answer!, replayed: false };
  }
  const refuse = (error: ApiError): never => {
    if (key) server.keys.set(key, { body: json, status: error.status, error });
    throw error;
  };
  const outstanding = owed();
  if (b.expectedOutstandingSatang !== undefined && b.expectedOutstandingSatang !== outstanding) {
    refuse(new ApiError(409, 'PARTY_BALANCE_CHANGED', `The balance changed to ฿${outstanding / 100} since it was shown — nothing was taken.`));
  }
  const amount = Math.min(b.amountSatang - (b.amountSatang % 100), outstanding);
  if (amount <= 0) refuse(new ApiError(409, 'PARTY_NOTHING_OWED', 'This party is fully paid — nothing was taken'));
  server.payments.push({ id: b.paymentId, amountSatang: amount, askedSatang: b.amountSatang, by: 'this-till' });
  server.revision += 1;
  const answer: PartyWriteAnswer = {
    replayed: false,
    party: viewOf(),
    payment: viewOf().party!.payments!.find((p) => p.id === b.paymentId)!,
  };
  if (key) server.keys.set(key, { body: json, status: 200, answer });
  if (server.loseNextAnswer) {
    server.loseNextAnswer = false;
    throw new NetworkError('lost');
  }
  return answer;
}

/** Another till at the counter takes money against the same party. */
function otherTillTakes(satang: number) {
  server.payments.push({ id: `other-${server.payments.length}`, amountSatang: satang, askedSatang: satang, by: 'other-till' });
  server.revision += 1;
}

const thisTill = () => server.payments.filter((p) => p.by === 'this-till');

beforeEach(() => {
  server.payments = [];
  server.keys = new Map();
  server.loseNextAnswer = false;
  server.dropNextRequest = false;
  server.revision = 0;
  server.chargeSatang = 0;
  postMock.mockReset();
  postMock.mockImplementation(platformPay as unknown as typeof api.post);
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

/** The words on screen: each element's text set apart, as a browser lays out blocks and spans. */
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

/** The button staff would press: an element with an onClick whose words match. */
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

/** Let the platform answer and the screens settle. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Rendered = RenderedHook<Record<string, unknown>, unknown>;

/**
 * THE IPAD: Events → a party → "Take balance" → the balance modal, as the host
 * page holds it (`pages/Events.tsx`): `onChanged` reads the day again.
 */
function ipad() {
  const props = (): Record<string, unknown> => ({
    party: partyNow(),
    surface: 'till',
    onBack: () => undefined,
    onChanged: () => host.rerender(props()),
  });
  const host: Rendered = renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props());
  let modal: Rendered | null = null;
  /** The modal re-rendered with what the page now gives it, as React would. */
  const sync = () => {
    const el = elementOf(host.result.current, PartyBalanceModal);
    if (!el) throw new Error('no balance modal on the party screen');
    if (!modal) modal = renderHook((p: Record<string, unknown>) => PartyBalanceModal(p as never), el.props);
    else modal.rerender(el.props);
    return modal;
  };
  return {
    open() {
      const take = buttonIn(host.result.current, /^Take balance ฿/);
      expect(take, 'Take balance').not.toBeNull();
      take!();
      sync();
    },
    press(words: string | RegExp) {
      const m = sync();
      const fn = buttonIn(m.result.current, words);
      if (!fn) return false;
      fn();
      sync();
      return true;
    },
    type(value: string) {
      const m = sync();
      for (const el of walk(m.result.current)) {
        if (typeof el.props.onChange === 'function' && el.props.placeholder) {
          (el.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
          sync();
          return;
        }
      }
      throw new Error('no amount field');
    },
    async received() {
      const pressed = this.press('Payment received');
      await settle();
      sync();
      return pressed;
    },
    words: () => textOf(sync().result.current).replace(/\s+/g, ' '),
    /** The balance modal as it is on screen now. */
    tree: () => sync().result.current,
  };
}

/** THE PHONE: Parties → a party → Take payment → its payment screen. */
function phone() {
  const host: Rendered = renderHook(() => MobileParties() as never, {});
  const tree = () => host.result.current;
  const list = elementOf(tree(), MobileEventsList);
  (list!.props.onSelectEvent as (id: string, date: string) => void)(PARTY, T);
  const detail = elementOf(tree(), MobilePartyDetail);
  (detail!.props.onTakePayment as () => void)();
  let pay: Rendered | null = null;
  const sync = () => {
    const el = elementOf(tree(), MobilePartyPayment);
    if (!el) return pay;
    if (!pay) pay = renderHook((p: Record<string, unknown>) => MobilePartyPayment(p as never), el.props);
    else pay.rerender(el.props);
    return pay;
  };
  sync();
  return {
    press(words: string | RegExp) {
      const p = sync()!;
      const fn = buttonIn(p.result.current, words);
      if (!fn) return false;
      fn();
      sync();
      return true;
    },
    handBack() {
      const p = sync()!;
      for (const el of walk(p.result.current)) {
        if (typeof el.props.onDone === 'function') {
          (el.props.onDone as () => void)();
          sync();
          return;
        }
      }
      throw new Error('no hand-to-customer step');
    },
    type(value: string) {
      const p = sync()!;
      for (const el of walk(p.result.current)) {
        if (typeof el.props.onChange === 'function' && el.props.placeholder) {
          (el.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
          sync();
          return;
        }
      }
      throw new Error('no amount field');
    },
    async received() {
      const pressed = this.press('Payment received');
      await settle();
      sync();
      return pressed;
    },
    words: () => textOf(sync()!.result.current).replace(/\s+/g, ' '),
  };
}

// =============================================================================
// The plain path: one story
// =============================================================================

describe('the plain path — what is collected is what is recorded and what the guest is thanked for', () => {
  it('iPad: full balance by card, one press, one payment of ฿9,000, "Collected now ฿9000"', async () => {
    const screen = ipad();
    screen.open();
    expect(screen.press('Card')).toBe(true);
    expect(screen.press('Take ฿9000 by Card')).toBe(true);
    expect(await screen.received()).toBe(true);
    expect(thisTill()).toEqual([expect.objectContaining({ amountSatang: 900_000, askedSatang: 900_000 })]);
    expect(screen.words()).toContain('Payment recorded');
    expect(screen.words()).toContain('Collected now ฿9000');
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('iPad: an answer lost before the platform heard it — the retry is the same request under the same key, one payment', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Partial amount');
    screen.type('5000');
    screen.press('Cash');
    expect(screen.press('Take ฿5000 by Cash')).toBe(true);
    server.dropNextRequest = true;
    await screen.received();
    expect(screen.words()).toContain('Payment received'); // still on the collect step
    await screen.received();
    expect(thisTill().map((p) => p.amountSatang)).toEqual([500_000]);
    const [first, second] = postMock.mock.calls;
    expect(second![1]).toEqual(first![1]);
    expect(second![2]).toEqual(first![2]);
    expect(screen.words()).toContain('Collected now ฿5000');
  });

  it('phone: full balance by card, one press, one payment of ฿9,000, "Collected ฿9000"', async () => {
    const screen = phone();
    expect(screen.press('Card')).toBe(true);
    expect(screen.press('Show bill · ฿9000 by Card')).toBe(true);
    screen.handBack();
    expect(await screen.received()).toBe(true);
    expect(thisTill()).toEqual([expect.objectContaining({ amountSatang: 900_000, askedSatang: 900_000 })]);
    expect(screen.words()).toContain('Payment recorded');
    expect(screen.words()).toContain('Collected ฿9000');
  });
});

// =============================================================================
// Two tills, and an answer lost on the way back (FINDING — flipped by the fix round)
// =============================================================================

describe('two tills on one party, and a lost answer — the till must not record other money than it collected', () => {
  /**
   * Till A shows ฿9,000 owed and collects ฿9,000 by card. Meanwhile till B
   * takes ฿5,000. A's press is refused (PARTY_BALANCE_CHANGED, nothing taken —
   * right), the party is read again under the still-open collect step, and A
   * presses "Payment received" again: the till now sends the NEW balance
   * (฿4,000) with the OLD amount (฿9,000), the guard passes, the cap records
   * ฿4,000, and the screen thanks the guest for ฿9,000.
   */
  it('iPad: after a refusal the next press records nothing, or exactly what was collected', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Card');
    expect(screen.press('Take ฿9000 by Card')).toBe(true);
    otherTillTakes(500_000);
    await screen.received(); // refused: the balance moved
    expect(thisTill()).toEqual([]);
    for (let i = 0; i < 2 && screen.words().includes('Payment received'); i += 1) await screen.received();
    // One story: whatever this till recorded is what it collected (฿9,000), or nothing.
    expect(thisTill().every((p) => p.amountSatang === p.askedSatang)).toBe(true);
    expect([0, 900_000]).toContain(thisTill().reduce((s, p) => s + p.amountSatang, 0));
  });

  /**
   * ฿5,000 collected in cash; the payment is recorded but its answer is lost.
   * The party is read again (฿4,000 now owed) and staff press again: the same
   * payment id and key, but a body with the new balance — refused as
   * IDEMPOTENCY_MISMATCH ("Payment not recorded", though it was), the ids are
   * dropped, and the next press records ฿4,000 more. ฿9,000 on the platform
   * for ฿5,000 in the drawer.
   */
  it('iPad: a recorded payment whose answer was lost is answered again on the retry, never taken twice', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Partial amount');
    screen.type('5000');
    screen.press('Cash');
    expect(screen.press('Take ฿5000 by Cash')).toBe(true);
    server.loseNextAnswer = true;
    await screen.received(); // recorded, answer lost
    for (let i = 0; i < 2 && screen.words().includes('Payment received'); i += 1) await screen.received();
    expect(thisTill().reduce((s, p) => s + p.amountSatang, 0)).toBe(500_000);
  });

  it('phone: after a refusal the next press records nothing, or exactly what was collected', async () => {
    const screen = phone();
    screen.press('Card');
    expect(screen.press('Show bill · ฿9000 by Card')).toBe(true);
    screen.handBack();
    otherTillTakes(500_000);
    await screen.received();
    expect(thisTill()).toEqual([]);
    for (let i = 0; i < 2 && screen.words().includes('Payment received'); i += 1) await screen.received();
    expect(thisTill().every((p) => p.amountSatang === p.askedSatang)).toBe(true);
    expect([0, 900_000]).toContain(thisTill().reduce((s, p) => s + p.amountSatang, 0));
  });

  it('phone: a recorded payment whose answer was lost is answered again on the retry, never taken twice', async () => {
    const screen = phone();
    screen.press('Partial amount');
    screen.type('5000');
    screen.press('Cash');
    expect(screen.press('Show bill · ฿5000 by Cash')).toBe(true);
    screen.handBack();
    server.loseNextAnswer = true;
    await screen.received();
    for (let i = 0; i < 2 && screen.words().includes('Payment received'); i += 1) await screen.received();
    expect(thisTill().reduce((s, p) => s + p.amountSatang, 0)).toBe(500_000);
  });

  // The review's pin of the defect's make-up ("the press after a refusal sends
  // the old amount with the new balance") is turned round by the fix round:
  // what the fix is made of, press by press.
  it('what the fix is made of: the refused press is not sent again; back on the bill as it now reads, the next collect is its own request', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Card');
    screen.press('Take ฿9000 by Card');
    otherTillTakes(500_000);
    await screen.received(); // refused: the balance moved
    // Back on the bill, as it now reads — no "Payment received" to press again.
    expect(screen.words()).toContain('Take balance payment');
    expect(screen.words()).toContain('Outstanding ฿4000');
    expect(await screen.received()).toBe(false);
    expect(screen.press('Take ฿4000 by Card')).toBe(true);
    expect(await screen.received()).toBe(true);
    const bodies = postMock.mock.calls.map((c) => c[1] as { paymentId: string; amountSatang: number; expectedOutstandingSatang: number });
    expect(bodies.map((b) => [b.amountSatang, b.expectedOutstandingSatang])).toEqual([
      [900_000, 900_000],
      [400_000, 400_000],
    ]);
    // A new collect is a new payment, under ids of its own.
    expect(bodies[1]!.paymentId).not.toBe(bodies[0]!.paymentId);
    expect(thisTill().map((p) => p.amountSatang)).toEqual([400_000]);
    expect(screen.words()).toContain('Collected now ฿4000 ');
  });
});

// =============================================================================
// The fix round's own presses: one collect, one request; the thanks are the
// money recorded
// =============================================================================

describe('the fix — one collect is one request under one set of ids, and the thanks are what was recorded', () => {
  it('iPad: the retry after a lost answer is byte-identical — body and key — and is answered with the recorded payment', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Card');
    screen.press('Take ฿9000 by Card');
    server.loseNextAnswer = true;
    await screen.received(); // recorded; its answer lost; the party read again (฿0 owed)
    expect(screen.words()).toContain('Payment received'); // still collecting
    await screen.received();
    const [first, second] = postMock.mock.calls;
    expect(second![1]).toEqual(first![1]);
    expect(second![2]).toEqual(first![2]);
    expect(thisTill().map((p) => p.amountSatang)).toEqual([900_000]);
    expect(screen.words()).toContain('Payment recorded');
    expect(screen.words()).toContain('Collected now ฿9000 ');
  });

  it('iPad: a request that never arrived, then Back and another amount — one payment, of the new amount, no key reused', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Partial amount');
    screen.type('5000');
    screen.press('Cash');
    screen.press('Take ฿5000 by Cash');
    server.dropNextRequest = true;
    await screen.received();
    expect(screen.press('Back')).toBe(true);
    screen.type('3000');
    expect(screen.press('Take ฿3000 by Cash')).toBe(true);
    expect(await screen.received()).toBe(true);
    const [first, second] = postMock.mock.calls;
    expect((second![2] as { idempotencyKey: string }).idempotencyKey).not.toBe((first![2] as { idempotencyKey: string }).idempotencyKey);
    expect(thisTill().map((p) => p.amountSatang)).toEqual([300_000]);
    expect(screen.words()).toContain('Collected now ฿3000 ');
  });

  it('iPad: a balance with satang is taken in whole baht — "Collected now" and the guest’s thank-you show the money recorded, not the money asked', async () => {
    server.chargeSatang = 50; // ฿0.50 on the tab: ฿9,000.50 owed
    const screen = ipad();
    screen.open();
    expect(screen.press('Card')).toBe(true);
    expect(screen.press('Take ฿9000.5 by Card')).toBe(true);
    expect(await screen.received()).toBe(true);
    expect(thisTill()).toEqual([expect.objectContaining({ askedSatang: 900_050, amountSatang: 900_000 })]);
    expect(screen.words()).toContain('Collected now ฿9000 ');
    expect(screen.words()).not.toContain('฿9000.5');
    const display = elementOf(screen.tree(), PartySettlementCustomerScreen);
    expect(display!.props).toMatchObject({ stage: 'thankyou', amount: 9000 });
  });

  it('phone: the retry after a lost answer is byte-identical, and "Collected" is the payment recorded', async () => {
    server.chargeSatang = 50;
    const screen = phone();
    screen.press('Card');
    expect(screen.press('Show bill · ฿9000.5 by Card')).toBe(true);
    screen.handBack();
    server.loseNextAnswer = true;
    await screen.received();
    expect(screen.words()).toContain('Payment received');
    await screen.received();
    const [first, second] = postMock.mock.calls;
    expect(second![1]).toEqual(first![1]);
    expect(second![2]).toEqual(first![2]);
    expect(thisTill().map((p) => p.amountSatang)).toEqual([900_000]);
    expect(screen.words()).toContain('Payment recorded');
    expect(screen.words()).toContain('Collected ฿9000 ');
  });

  it('phone: a refusal is back on the bill as it now reads; the next collect is its own request for what is now owed', async () => {
    const screen = phone();
    screen.press('Card');
    screen.press('Show bill · ฿9000 by Card');
    screen.handBack();
    otherTillTakes(500_000);
    await screen.received();
    expect(screen.words()).toContain('Take payment');
    expect(screen.words()).toContain('Outstanding ฿4000');
    expect(screen.press('Show bill · ฿4000 by Card')).toBe(true);
    screen.handBack();
    expect(await screen.received()).toBe(true);
    const bodies = postMock.mock.calls.map((c) => c[1] as { paymentId: string; amountSatang: number; expectedOutstandingSatang: number });
    expect(bodies.map((b) => [b.amountSatang, b.expectedOutstandingSatang])).toEqual([
      [900_000, 900_000],
      [400_000, 400_000],
    ]);
    expect(bodies[1]!.paymentId).not.toBe(bodies[0]!.paymentId);
    expect(thisTill().map((p) => p.amountSatang)).toEqual([400_000]);
    expect(screen.words()).toContain('Collected ฿4000 ');
  });
});

// =============================================================================
// The second fix round's words: a reply that never came is never "not recorded"
// =============================================================================

describe('a reply that never came says the truth — not confirmed, press again — and a definite no keeps its words', () => {
  it('iPad: recorded, its answer lost — "Payment not confirmed", never "Payment not recorded"; the press again confirms it', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Card');
    screen.press('Take ฿9000 by Card');
    server.loseNextAnswer = true;
    await screen.received();
    expect(toastTitles()).toEqual(['Payment not confirmed']);
    const [shown] = toastMock.mock.calls[0]!;
    expect((shown as { description: string }).description).toMatch(/may already be recorded.*Payment received again/);
    await screen.received();
    expect(toastTitles()).not.toContain('Payment not recorded');
    expect(thisTill().map((p) => p.amountSatang)).toEqual([900_000]);
    expect(screen.words()).toContain('Payment recorded');
  });

  it('iPad: a request that never arrived reads the same — the till cannot tell it from a lost answer', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Card');
    screen.press('Take ฿9000 by Card');
    server.dropNextRequest = true;
    await screen.received();
    expect(toastTitles()).toEqual(['Payment not confirmed']);
    expect(screen.words()).toContain('Payment received'); // still on the collect step
  });

  it('iPad: a definite no keeps "Payment not recorded" — nothing was taken', async () => {
    const screen = ipad();
    screen.open();
    screen.press('Card');
    screen.press('Take ฿9000 by Card');
    otherTillTakes(500_000);
    await screen.received();
    expect(toastTitles()).toEqual(['Payment not recorded']);
  });

  it('phone: recorded, its answer lost — "Payment not confirmed", never "Payment not recorded"; the press again confirms it', async () => {
    const screen = phone();
    screen.press('Card');
    screen.press('Show bill · ฿9000 by Card');
    screen.handBack();
    server.loseNextAnswer = true;
    await screen.received();
    expect(toastTitles()).toEqual(['Payment not confirmed']);
    await screen.received();
    expect(toastTitles()).not.toContain('Payment not recorded');
    expect(thisTill().map((p) => p.amountSatang)).toEqual([900_000]);
    expect(screen.words()).toContain('Payment recorded');
  });

  it('phone: a definite refusal is "Payment not recorded"', async () => {
    const screen = phone();
    screen.press('Card');
    screen.press('Show bill · ฿9000 by Card');
    screen.handBack();
    otherTillTakes(500_000);
    await screen.received();
    expect(toastTitles()).toEqual(['Payment not recorded']);
  });
});

// =============================================================================
// RE-REVIEW of the second fix round: every other reply that is not an answer
// =============================================================================

/**
 * A platform fault (5xx: the idempotency store gives the key back, so the
 * same request runs again) and the platform still running the first request
 * (409 IDEMPOTENCY_IN_FLIGHT) are not answers either: neither may read
 * "Payment not recorded", and the same press must come to one payment.
 */
function faultThenRun(kind: 'fault' | 'in-flight') {
  const running = new Set<string>();
  let finish: () => Promise<void> = async () => undefined;
  postMock.mockImplementation((async (path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    const key = opts?.idempotencyKey;
    if (key && running.has(key)) {
      throw new ApiError(409, 'IDEMPOTENCY_IN_FLIGHT', 'The original request is still processing, retry the same key shortly');
    }
    return platformPay(path, body, opts);
  }) as unknown as typeof api.post);
  postMock.mockImplementationOnce((async (path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    if (kind === 'fault') throw new ApiError(503, 'UNAVAILABLE', 'The platform could not finish this request');
    const key = opts!.idempotencyKey!;
    running.add(key);
    finish = async () => {
      running.delete(key);
      await platformPay(path, body, opts);
    };
    throw new NetworkError('timed out');
  }) as unknown as typeof api.post);
  return { finish: () => finish() };
}

describe('RE-REVIEW: a platform fault and a request still running are "Payment not confirmed" on both screens, and one press is one payment', () => {
  for (const kind of ['fault', 'in-flight'] as const) {
    it(`iPad, ${kind}: "Payment not confirmed", still on collect; the same press again is one payment of ฿9,000`, async () => {
      const run = faultThenRun(kind);
      const screen = ipad();
      screen.open();
      screen.press('Card');
      screen.press('Take ฿9000 by Card');
      await screen.received();
      expect(toastTitles()).toEqual(['Payment not confirmed']);
      expect(screen.words()).toContain('Payment received');
      if (kind === 'in-flight') {
        await screen.received(); // the platform is still on the first
        expect(toastTitles()).toEqual(['Payment not confirmed', 'Payment not confirmed']);
        await run.finish();
      }
      await screen.received();
      expect(toastTitles()).not.toContain('Payment not recorded');
      expect(thisTill().map((p) => p.amountSatang)).toEqual([900_000]);
      const keys = new Set(postMock.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey));
      expect(keys.size).toBe(1);
      expect(screen.words()).toContain('Payment recorded');
    });

    it(`phone, ${kind}: "Payment not confirmed", still on collect; the same press again is one payment of ฿9,000`, async () => {
      const run = faultThenRun(kind);
      const screen = phone();
      screen.press('Card');
      screen.press('Show bill · ฿9000 by Card');
      screen.handBack();
      await screen.received();
      expect(toastTitles()).toEqual(['Payment not confirmed']);
      expect(screen.words()).toContain('Payment received');
      if (kind === 'in-flight') {
        await screen.received();
        expect(toastTitles()).toEqual(['Payment not confirmed', 'Payment not confirmed']);
        await run.finish();
      }
      await screen.received();
      expect(toastTitles()).not.toContain('Payment not recorded');
      expect(thisTill().map((p) => p.amountSatang)).toEqual([900_000]);
      const keys = new Set(postMock.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey));
      expect(keys.size).toBe(1);
      expect(screen.words()).toContain('Payment recorded');
    });
  }
});
