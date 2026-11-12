import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyPlan, PartySettleQuote, PartySettlementView } from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { readPartyPlanOnPlatform } from '@/api/parties';
import { computePartyOutstanding } from '@/lib/party';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartySettleModal } from '@/components/parties/PartySettleModal';
import { StepPayment } from '@/components/till/StepPayment';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import type { PartyBooking } from '@/types';
import { renderHook, type RenderedHook } from './support/hooks';

/**
 * SCRUM-804 — "SETTLE PARTY" ON THE TILL (birthday plan §4): the party page
 * reads the plan the OTO App published, offers Settle party in place of Add
 * tickets for a party with a package, and the Settle form shows the platform's
 * figures — never its own arithmetic — then rings the party up as one sale and
 * moves to the ordinary payment stage for the balance.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0804';
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
// SCRUM-876 — what the signed-in account may do; a test turns the void off.
const permissions = vi.hoisted(() => ({ void: true }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({
    operator: { id: 'acc-som', name: 'Som (Reception)' },
    locked: false,
    can: (permission: string) => permission !== 'pos:sale:void' || permissions.void,
  }),
}));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ station: { stationId: TILL, name: 'Till 1' } }) }));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => ({ branch: { id: 'hkt-central', name: 'HKT Central' } }) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: (key: string) => key }) }));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['dark', () => undefined] }));

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

// --- The platform's answers ----------------------------------------------------

const PLAN: PartyPlan = {
  eventId: PARTY,
  partyDate: T,
  startTime: '13:00',
  endTime: '16:00',
  package: {
    templateId: 'floresta-weekday',
    name: 'Floresta Birthday',
    hours: 3,
    kidsIncluded: 10,
    adultsIncluded: 4,
    socksIncluded: -1,
    priceWeekdaySatang: 1_690_000,
    priceWeekendSatang: 2_090_000,
    extraChildWeekdaySatang: 130_000,
    extraChildWeekendSatang: 150_000,
    extraAdultWeekdaySatang: 35_000,
    extraAdultWeekendSatang: 50_000,
    includedLines: [{ label: 'Birthday set menu' }, { label: 'Ice-cream cake with candles' }],
  },
  counts: { kidsExpected: 10, adultsExpected: 4 },
  addOns: [
    { id: 'table', templateId: 'table', name: 'Reserved table for adults', qty: 1, unitPriceSatang: 500_000, fnbCreditSatang: 500_000, printsVoucher: true },
    { id: 'balloons', templateId: 'balloons', name: 'Classic balloon decoration', qty: 1, unitPriceSatang: 400_000, fnbCreditSatang: 0, printsVoucher: false },
  ],
  entertainment: [
    {
      id: 'zombie',
      templateId: 'zombie',
      name: 'Zombie game',
      category: 'games',
      durationMinutes: 30,
      ageRange: '6+',
      maxKids: 10,
      priceSatang: 400_000,
      extraChildren: 0,
      extraChildPriceSatang: 40_000,
    },
  ],
  setMenu: [{ productCode: 'CF-24', name: 'Margherita', qty: 1, choiceGroup: 'pizza', chosenOption: 'margherita', note: null }],
  barItems: [{ productCode: 'CF-66-1', name: 'Kids juice', qty: 2 }],
  kitchen: { kidsFoodTime: '14:00', adultsFoodTime: '14:30', readyOffsetMinutes: 20, slipsTime: '11:00' },
  settlement: { depositSatang: 300_000, posSaleId: null },
};

/** The platform's quote for a form: priced there, read here. */
function quoteFor(form: { kids: number; adults: number; socksGiven: number; addOnIds: string[]; entertainmentIds: string[] }): PartySettleQuote {
  const extraChildren = Math.max(0, form.kids - 10);
  const extraAdults = Math.max(0, form.adults - 4);
  const addOns = PLAN.addOns.filter((a) => form.addOnIds.includes(a.id)).reduce((s, a) => s + a.unitPriceSatang, 0);
  const shows = PLAN.entertainment.filter((e) => form.entertainmentIds.includes(e.id)).reduce((s, e) => s + e.priceSatang, 0);
  const total = 1_690_000 + extraChildren * 130_000 + extraAdults * 35_000 + addOns + shows;
  return {
    partyDate: T,
    rateMode: 'weekday',
    packageName: 'Floresta Birthday',
    lines: [],
    packageSatang: 1_690_000,
    extraChildren,
    extraChildrenSatang: extraChildren * 130_000,
    extraAdults,
    extraAdultsSatang: extraAdults * 35_000,
    freeSocks: Math.min(form.socksGiven, form.kids),
    paidSocks: Math.max(0, form.socksGiven - form.kids),
    socksSatang: 0,
    addOnsSatang: addOns,
    entertainmentSatang: shows,
    totalSatang: total,
    creditSatang: form.addOnIds.includes('table') ? 500_000 : 0,
    depositSatang: 300_000,
    balanceSatang: total - 300_000,
    walkUps: 0,
    walkUpsSatang: 0,
  };
}

function viewOf(settlement: PartySettlementView | null = null): EventView {
  return {
    id: PARTY,
    branchId: HKT_CENTRAL,
    type: 'party',
    appEventType: 'birthday',
    status: 'upcoming',
    appStatus: 'upcoming',
    archived: false,
    title: "Pim's 7th",
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
      childName: 'Pim',
      kidTurningAge: 7,
      bookingName: null,
      parentName: 'Nok',
      parentPhone: '+66812345678',
      activities: null,
      decoration: null,
      totalValueSatang: 1_690_000,
      depositSatang: 300_000,
      depositDate: T,
      walkUpCharges: [],
      charges: [
        {
          id: 'charge-1',
          kind: 'fnb',
          items: [{ name: 'Pad Thai', qty: 1, lineTotalSatang: 18_000 }],
          totalSatang: 18_000,
          chargedBy: 'Som',
          chargedById: 'acc-som',
          chargedAt: `${T}T06:00:00.000Z`,
        },
      ],
      payments: [],
      lastEdited: null,
      editSync: null,
      settlement,
    },
    attendeeCount: 0,
    attendees: [],
    roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
  };
}

const SETTLED: PartySettlementView = {
  id: 'settlement-1',
  saleId: 'sale-1',
  state: 'settled',
  receiptNumber: 'T1-000123',
  grossSatang: 1_690_000,
  paidSatang: 1_690_000,
  outstandingSatang: 0,
  depositSatang: 300_000,
  kids: 10,
  adults: 4,
  createdAt: `${T}T07:00:00.000Z`,
  settledAt: `${T}T07:05:00.000Z`,
  writeBack: 'synced',
};

const partyOf = (settlement: PartySettlementView | null = null) =>
  toOtoEvent(viewOf(settlement), 'hkt-central') as unknown as PartyBooking;

/** GET /parties/:id answers the plan; any other read answers nothing in particular. */
function serve(plan: PartyPlan | null) {
  getMock.mockReset();
  getMock.mockImplementation((async (path: string) => {
    if (path.startsWith(`/parties/${PARTY}`)) {
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(), plan, planStatus: plan ? 'ready' : 'no_package' };
    }
    if (path.startsWith('/sales/')) {
      return { sale: { id: path.split('/')[2], status: 'tendering', totals: { grossSatang: 1_390_000 } }, attempts: [] };
    }
    return { member: null };
  }) as unknown as typeof api.get);
}

beforeEach(() => {
  serve(PLAN);
  postMock.mockReset();
  postMock.mockImplementation((async (path: string, body: unknown) => {
    const b = body as Parameters<typeof quoteFor>[0] & { settlementId?: string; saleId?: string };
    if (path === `/parties/${PARTY}/settle/preview`) return { quote: quoteFor(b) };
    if (path === `/parties/${PARTY}/settle`) {
      const quote = quoteFor(b);
      return {
        replayed: false,
        quote,
        settlement: { ...SETTLED, id: b.settlementId, saleId: b.saleId, state: 'open', receiptNumber: null, outstandingSatang: quote.balanceSatang },
        sale: { id: b.saleId, status: 'tendering', receiptNumber: null, grossSatang: quote.totalSatang, outstandingSatang: quote.balanceSatang },
        printingNotes: [],
      };
    }
    throw new Error(`unexpected POST ${path}`);
  }) as unknown as typeof api.post);
});

// --- Reading the screen ----------------------------------------------------------

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
/**
 * What the screen says. The harness renders the page's own markup, not its
 * small components, so an info row is read from its props (`label`, `value`).
 */
const flat = (tree: unknown) => {
  const rows = [...walk(tree)]
    .filter((el) => typeof el.props.label === 'string' && el.props.value !== undefined)
    .map((el) => `${el.props.label as string} ${textOf(el.props.value)}`);
  return [textOf(tree), ...rows].join(' ').replace(/\s+/g, ' ');
};
/** A child component by one of its props: the harness hands its callbacks over as they are. */
const withProp = (tree: unknown, prop: string, value: unknown): El | null => {
  for (const el of walk(tree)) if (el.props[prop] === value) return el;
  return null;
};
function buttonIn(tree: unknown, words: string | RegExp): El | null {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    const text = textOf(el.props.children).replace(/\s+/g, ' ').trim();
    if (typeof words === 'string' ? text === words || text.startsWith(words) : words.test(text)) return el;
  }
  return null;
}
const press = (el: El | null) => (el!.props.onClick as () => unknown)();
const elementOf = (tree: unknown, type: unknown): El | null => {
  for (const el of walk(tree)) if (el.type === type) return el;
  return null;
};
async function settle(ms = 0) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function partyPage(party: PartyBooking): RenderedHook<Record<string, unknown>, unknown> {
  const props: Record<string, unknown> = { party, surface: 'till', onBack: () => undefined, onChanged: () => undefined };
  return renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props);
}

// =============================================================================

describe('the party page reads the plan the OTO App published', () => {
  it('reads GET /parties/:id for the plan, and answers null when there is none to read', async () => {
    const read = await readPartyPlanOnPlatform({ id: PARTY, branchId: 'hkt-central' });
    expect(getMock).toHaveBeenCalledWith(`/parties/${PARTY}?branchId=${HKT_CENTRAL}`);
    expect(read).toEqual({ plan: PLAN, status: 'ready' });
    getMock.mockResolvedValueOnce({ member: null });
    expect(await readPartyPlanOnPlatform({ id: PARTY, branchId: 'hkt-central' })).toBeNull();
    expect(await readPartyPlanOnPlatform({ id: PARTY, branchId: 'not-linked' })).toBeNull();
  });

  it('a party with a package offers Settle party in place of Add tickets, and shows the plan read-only', async () => {
    const page = partyPage(partyOf());
    await settle();
    const tree = page.result.current;
    expect(buttonIn(tree, 'Settle party')).not.toBeNull();
    expect(buttonIn(tree, 'Add tickets')).toBeNull();
    // Add F&B on the day stays.
    expect(buttonIn(tree, 'Add F&B to party')).not.toBeNull();
    const text = flat(tree);
    for (const words of ['Package Floresta Birthday', 'Margherita · margherita ×1', "Kids' food 14:00", 'Ready 20 min before', 'Slips print 11:00', 'Kids juice ×2', 'Birthday set menu · Ice-cream cake with candles']) {
      expect(text).toContain(words);
    }
    expect(elementOf(tree, PartySettleModal)?.props).toMatchObject({ plan: PLAN, stationId: TILL, resumeSaleId: null });
  });

  it('a party with no package keeps Add tickets', async () => {
    serve(null);
    const page = partyPage(partyOf());
    await settle();
    expect(buttonIn(page.result.current, 'Add tickets')).not.toBeNull();
    expect(buttonIn(page.result.current, 'Settle party')).toBeNull();
    expect(elementOf(page.result.current, PartySettleModal)).toBeNull();
  });

  it('a settled party says so, and its tab is its own: the package and the deposit are the sale\'s', async () => {
    const party = partyOf(SETTLED);
    expect(party).toMatchObject({ basePrice: 0, deposit: 0, settlement: SETTLED });
    // The tab's own charge, and nothing of the package.
    expect(computePartyOutstanding(party)).toBe(180);
    const page = partyPage(party);
    await settle();
    const button = buttonIn(page.result.current, 'Settled, receipt T1-000123');
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(true);
    expect(flat(page.result.current)).toContain('Party settled Receipt T1-000123');
  });

  it('a settlement still waiting for its balance is resumed at the payment stage', async () => {
    const open: PartySettlementView = { ...SETTLED, state: 'open', receiptNumber: null, outstandingSatang: 1_390_000 };
    const page = partyPage(partyOf(open));
    await settle();
    expect(buttonIn(page.result.current, 'Resume settlement ฿13900')).not.toBeNull();
    expect(elementOf(page.result.current, PartySettleModal)?.props).toMatchObject({ resumeSaleId: 'sale-1' });
  });
});

describe('the Settle form: the actual counts, the plan\'s add-ons, the platform\'s figures', () => {
  function modal() {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      party: partyOf(),
      plan: PLAN,
      stationId: TILL,
      resumeSaleId: null,
      onSettled: vi.fn(),
    };
    return { props, host: renderHook((p: typeof props) => PartySettleModal(p), props) };
  }
  const previews = () => postMock.mock.calls.filter((c) => c[0] === `/parties/${PARTY}/settle/preview`).map((c) => c[1]);

  it('opens prefilled from the plan — 10 children, 4 adults, socks for all, every add-on and show — and shows the quote it is answered', async () => {
    const { host } = modal();
    await settle(300);
    expect(previews().at(-1)).toEqual({
      branchId: HKT_CENTRAL,
      stationId: TILL,
      kids: 10,
      adults: 4,
      socksGiven: 10,
      addOnIds: ['table', 'balloons'],
      entertainmentIds: ['zombie'],
    });
    const tree = host.result.current;
    const text = flat(tree);
    expect(text).toContain('Floresta Birthday');
    // The quote's own figures, not the till's: total 16,900 + 9,000 + 4,000, less the 3,000 deposit.
    expect(buttonIn(tree, 'Confirm · ฿26,900 to pay')).not.toBeNull();
  });

  it('more children re-prices on the platform, and the socks follow the children', async () => {
    const { host } = modal();
    await settle(300);
    (withProp(host.result.current, 'label', 'Children')!.props.onChange as (n: number) => void)(11);
    await settle(300);
    expect(previews().at(-1)).toMatchObject({ kids: 11, socksGiven: 11 });
    expect(buttonIn(host.result.current, 'Confirm · ฿28,200 to pay')).not.toBeNull();
  });

  it('an add-on left out is not sent', async () => {
    const { host } = modal();
    await settle(300);
    (withProp(host.result.current, 'title', 'Classic balloon decoration')!.props.onToggle as () => void)();
    await settle(300);
    expect(previews().at(-1)).toMatchObject({ addOnIds: ['table'] });
    expect(buttonIn(host.result.current, 'Confirm · ฿22,900 to pay')).not.toBeNull();
  });

  it('Confirm settles under ids kept for its retries, with the total shown, and moves to the payment stage', async () => {
    const { host, props } = modal();
    await settle(300);
    press(buttonIn(host.result.current, 'Confirm · ฿26,900 to pay'));
    await settle();
    const call = postMock.mock.calls.find((c) => c[0] === `/parties/${PARTY}/settle`)!;
    const body = call[1] as { settlementId: string; saleId: string; actionId: string; expectedTotalSatang: number; kids: number };
    expect(body).toMatchObject({ branchId: HKT_CENTRAL, stationId: TILL, kids: 10, adults: 4, socksGiven: 10, expectedTotalSatang: 2_990_000 });
    expect(call[2]).toMatchObject({ idempotencyKey: `party-settle:${body.settlementId}`, headers: { 'x-oto-action-id': body.actionId } });
    expect(props.onSettled).toHaveBeenCalled();
    const payment = elementOf(host.result.current, StepPayment);
    expect(payment).not.toBeNull();
    expect(payment!.props.paymentStage).toBeDefined();
  });

  it('walk-ups the board already put on the tab are named, and Confirm is off: the balance is taken on the tab', async () => {
    const answered = postMock.getMockImplementation()!;
    postMock.mockImplementation((async (path: string, body: unknown, opts?: unknown) => {
      if (path === `/parties/${PARTY}/settle/preview`) {
        return { quote: { ...quoteFor(body as Parameters<typeof quoteFor>[0]), walkUps: 2, walkUpsSatang: 90_000 } };
      }
      return (answered as (p: string, b: unknown, o?: unknown) => Promise<unknown>)(path, body, opts);
    }) as unknown as typeof api.post);
    const { host } = modal();
    await settle(300);
    const tree = host.result.current;
    expect(flat(tree)).toContain("2 walk-up guests are already on this party's tab (฿900), so it cannot be settled as one sale");
    const confirm = buttonIn(tree, 'Confirm · ฿26,900 to pay');
    expect(confirm).not.toBeNull();
    expect(confirm!.props.disabled).toBe(true);
    await press(confirm);
    await settle();
    expect(postMock.mock.calls.some((c) => c[0] === `/parties/${PARTY}/settle`)).toBe(false);
  });
});

// =============================================================================
// SCRUM-876 — Cancel settlement on the party page
// =============================================================================

/**
 * A settlement left at its balance step is an open sale with only the party's
 * deposit on it. The party page offers Cancel settlement beside Resume
 * settlement: a reason, then the ordinary void of an unpaid sale on the
 * platform — nothing is refunded, the deposit stays the party's — and the
 * party is read back so Settle party is offered again.
 */
describe('SCRUM-876 — a settlement left before its balance is cancelled from the party page', () => {
  const OPEN: PartySettlementView = { ...SETTLED, state: 'open', receiptNumber: null, outstandingSatang: 1_390_000 };
  const voidAnswer = (reason: string) => ({
    replay: false,
    sale: { id: 'sale-1', status: 'voided' },
    void: { voidedAt: `${T}T08:00:00.000Z`, voidedByAccountId: 'acc-som', reason },
    releasedVoucherIds: [],
  });
  /** The header's button, not the dialog's confirm (always in the element tree, `destructive`). */
  const cancelButton = (tree: unknown): El | null => {
    for (const el of walk(tree)) {
      if (typeof el.props.onClick !== 'function' || el.props.variant === 'destructive') continue;
      if (textOf(el.props.children).trim() === 'Cancel settlement') return el;
    }
    return null;
  };
  const confirmButton = (tree: unknown) => withProp(tree, 'variant', 'destructive');
  const reasonInput = (tree: unknown) => elementOf(tree, Input);
  const typeReason = (tree: unknown, value: string) =>
    (reasonInput(tree)!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  const voids = () => postMock.mock.calls.filter((c) => c[0] === '/sales/sale-1/void');

  beforeEach(() => {
    permissions.void = true;
    vi.mocked(toast).mockClear();
  });

  it('an open settlement offers Cancel settlement beside Resume settlement; a settled or unsettled party does not', async () => {
    const page = partyPage(partyOf(OPEN));
    await settle();
    const button = cancelButton(page.result.current);
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(false);
    expect(buttonIn(page.result.current, 'Resume settlement ฿13900')).not.toBeNull();
    expect(elementOf(page.result.current, Dialog)?.props.open).toBe(false);

    const settled = partyPage(partyOf(SETTLED));
    await settle();
    expect(cancelButton(settled.result.current)).toBeNull();
    const unsettled = partyPage(partyOf());
    await settle();
    expect(cancelButton(unsettled.result.current)).toBeNull();
  });

  it('asks for a reason, voids the settlement sale with it, reads the party back and tells the host', async () => {
    postMock.mockImplementation((async (path: string, body: unknown) => {
      if (path === '/sales/sale-1/void') return voidAnswer((body as { reason: string }).reason);
      throw new Error(`unexpected POST ${path}`);
    }) as unknown as typeof api.post);
    const onChanged = vi.fn();
    const page = renderHook(
      (p: Record<string, unknown>) => PartyDetail(p as never),
      { party: partyOf(OPEN), surface: 'till', onBack: () => undefined, onChanged } as Record<string, unknown>,
    );
    await settle();
    press(cancelButton(page.result.current));
    await settle();
    expect(elementOf(page.result.current, Dialog)?.props.open).toBe(true);
    // No reason, no void.
    expect(confirmButton(page.result.current)!.props.disabled).toBe(true);
    expect(flat(page.result.current)).toContain('Nothing is refunded — the deposit of ฿3000 stays with the party');
    typeReason(page.result.current, '  Parent will pay later  ');
    await settle();
    expect(confirmButton(page.result.current)!.props.disabled).toBe(false);
    press(confirmButton(page.result.current));
    await settle(5);

    expect(voids()).toHaveLength(1);
    expect(voids()[0]![1]).toEqual({ reason: 'Parent will pay later' });
    // The party is read back: released, the page offers Settle party again.
    expect(getMock.mock.calls.filter((c) => c[0] === `/parties/${PARTY}?branchId=${HKT_CENTRAL}`).length).toBeGreaterThanOrEqual(2);
    expect(elementOf(page.result.current, Dialog)?.props.open).toBe(false);
    expect(cancelButton(page.result.current)).toBeNull();
    expect(buttonIn(page.result.current, 'Settle party')).not.toBeNull();
    expect(onChanged).toHaveBeenCalled();
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Settlement cancelled', description: expect.stringContaining('Nothing was refunded. The deposit of ฿3000 stays with the party') }),
    );
  });

  it("a refusal keeps the dialog open with the platform's words, and the settlement in place", async () => {
    postMock.mockImplementation((async (path: string) => {
      if (path === '/sales/sale-1/void') {
        throw new ApiError(409, 'SALE_HAS_PAYMENT', 'Money has been taken on this sale — it is refunded, not voided');
      }
      throw new Error(`unexpected POST ${path}`);
    }) as unknown as typeof api.post);
    const page = partyPage(partyOf(OPEN));
    await settle();
    press(cancelButton(page.result.current));
    await settle();
    typeReason(page.result.current, 'Wrong counts');
    await settle();
    press(confirmButton(page.result.current));
    await settle(5);
    expect(voids()).toHaveLength(1);
    expect(elementOf(page.result.current, Dialog)?.props.open).toBe(true);
    expect(confirmButton(page.result.current)!.props.disabled).toBe(false);
    expect(buttonIn(page.result.current, 'Resume settlement ฿13900')).not.toBeNull();
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      // SCRUM-913 — money taken is refunded from History first: the party page names that way out.
      expect.objectContaining({
        title: 'Settlement not cancelled',
        description: "Money was already taken on this settlement, so it can't be cancelled here. Have a manager refund it from History first: the refund closes the settlement. Nothing was changed.",
        variant: 'destructive',
      }),
    );
  });

  it('without the till\'s void permission the button is in view and off', async () => {
    permissions.void = false;
    const page = partyPage(partyOf(OPEN));
    await settle();
    const button = cancelButton(page.result.current);
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(true);
    expect(button!.props.title).toContain('void permission');
  });
});
