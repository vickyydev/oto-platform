import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyPlan, PartySettleQuote, PartySettlementView } from '@oto/shared';
import { api } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartyBalanceModal } from '@/components/parties/PartyBalanceModal';
import { PartySettleModal } from '@/components/parties/PartySettleModal';
import { PartyEditForm } from '@/components/parties/PartyEditForm';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { StepPayment } from '@/components/till/StepPayment';
import {
  NO_PLANNED_QUOTE,
  partyBillShown,
  partyListFigure,
  settlesOnTab,
  type PlannedQuote,
} from '@/lib/partySettlementBill';
import { PartyRowFigure } from '@/pages/Events';
import { MobilePartyRowFigure } from '@/components/mobile/parties/MobileEventsList';
import type { PartyBooking } from '@/types';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderHook } from './support/hooks';

/**
 * SCRUM-936 and SCRUM-935 — A PARTY NEVER READS PAID WHILE MONEY IS OWED, AND
 * THE PARTY PAGE SHOWS THE NEW BALANCE AS SOON AS THE SETTLE WINDOW CLOSES.
 *
 * Seen on staging (SCRUM-909's proof, 05a): a party the OTO App planned at
 * ฿16,900 with a ฿1,000 deposit read "Birthday package ฿0, Total ฿0, Deposit
 * paid −฿1000, Outstanding ฿0" and a disabled "Fully paid" before Settle party
 * was pressed — the OTO App's bill total is 0 and the package is the plan's.
 * The prototype's party page shows the package as owed (`basePrice` in its
 * bill), so the page now shows the platform's own quote of Settle party, and
 * Take balance opens Settle party. The parties list read "Paid" for a party
 * with a settlement open: it now reads the page's bill. And closing the settle
 * window after a part payment reads the party again.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0936';
const TILL = '0190a0a0-0000-7000-8000-00000000c001';
const T = '2026-11-12';

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
const postMock = vi.mocked(api.post);
const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

const PLAN: PartyPlan = {
  eventId: PARTY,
  partyDate: T,
  startTime: '15:00',
  endTime: '18:00',
  package: {
    templateId: 'floresta',
    name: 'Birthday package, Central Floresta',
    hours: 3,
    kidsIncluded: 2,
    adultsIncluded: 2,
    socksIncluded: -1,
    priceWeekdaySatang: 1_690_000,
    priceWeekendSatang: 1_890_000,
    extraChildWeekdaySatang: 130_000,
    extraChildWeekendSatang: 150_000,
    extraAdultWeekdaySatang: 35_000,
    extraAdultWeekendSatang: 50_000,
    includedLines: [],
  },
  counts: { kidsExpected: 2, adultsExpected: 2 },
  addOns: [],
  entertainment: [],
  setMenu: [],
  barItems: [],
  kitchen: null,
  settlement: { depositSatang: 100_000, posSaleId: null },
};

/** The platform's preview of Settle party on the plan's counts: ฿16,900, ฿1,000 deposit, ฿15,900 to take. */
const QUOTE: PartySettleQuote = {
  partyDate: T,
  rateMode: 'weekday',
  packageName: 'Birthday package, Central Floresta',
  lines: [],
  packageSatang: 1_690_000,
  extraChildren: 0,
  extraChildrenSatang: 0,
  extraAdults: 0,
  extraAdultsSatang: 0,
  freeSocks: 2,
  paidSocks: 0,
  socksSatang: 0,
  addOnsSatang: 0,
  entertainmentSatang: 0,
  totalSatang: 1_690_000,
  creditSatang: 0,
  depositSatang: 100_000,
  balanceSatang: 1_590_000,
  walkUps: 0,
  walkUpsSatang: 0,
};

/** A settlement rung up with ฿100 of the balance taken in cash: ฿15,800 left. */
const OPEN: PartySettlementView = {
  id: 'settlement-1',
  saleId: 'sale-1',
  state: 'open',
  receiptNumber: null,
  grossSatang: 1_690_000,
  paidSatang: 110_000,
  outstandingSatang: 1_580_000,
  depositSatang: 100_000,
  kids: 2,
  adults: 2,
  createdAt: `${T}T07:00:00.000Z`,
  settledAt: null,
  writeBack: null,
};

/** The proof's party: the OTO App's bill total is 0, the deposit ฿1,000 is paid. */
function viewOf(settlement: PartySettlementView | null, totalValueSatang = 0): EventView {
  return {
    id: PARTY,
    branchId: HKT_CENTRAL,
    type: 'party',
    appEventType: 'birthday',
    status: 'upcoming',
    appStatus: 'upcoming',
    archived: false,
    title: 'ZZ TEST SCRUM-936 party',
    startDate: T,
    endDate: T,
    cancelledDays: [],
    startTime: '15:00',
    endTime: '18:00',
    location: 'Party room 1',
    expectedKids: 2,
    expectedAdults: 2,
    entryPrice: null,
    party: {
      childName: 'Pim',
      kidTurningAge: 7,
      bookingName: null,
      parentName: 'Nok',
      parentPhone: '+66812345678',
      activities: null,
      decoration: null,
      totalValueSatang,
      depositSatang: 100_000,
      depositDate: T,
      walkUpCharges: [],
      charges: [],
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

const partyOf = (settlement: PartySettlementView | null, totalValueSatang = 0) =>
  toOtoEvent(viewOf(settlement, totalValueSatang), 'hkt-central') as unknown as PartyBooking;

const priced = (quote: PartySettleQuote = QUOTE): PlannedQuote => ({ state: 'priced', quote });

/** A ฿2,500 F&B charge on the tab, beside the package Settle party prices. */
const withTabCharge = (party: PartyBooking): PartyBooking => ({
  ...party,
  partyExtraCharges: [
    {
      id: 'fnb-2500',
      kind: 'fnb',
      items: [{ name: 'Pizza', qty: 1, lineTotal: 2_500 }],
      total: 2_500,
      chargedBy: 'Som',
      chargedById: 'acc-som',
      chargedAt: `${T}T08:00:00.000Z`,
    },
  ],
});

let saleRead: Promise<unknown> | null = null;

function serve() {
  getMock.mockReset();
  getMock.mockImplementation((async (url: string) => {
    if (url.startsWith(`/parties/${PARTY}`)) {
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan: PLAN, planStatus: 'ready' };
    }
    if (url === '/sales/sale-1') {
      if (saleRead) return saleRead;
      return { sale: { id: 'sale-1', status: 'tendering', totals: { grossSatang: 1_690_000 } }, attempts: [] };
    }
    return { member: null };
  }) as unknown as typeof api.get);
  postMock.mockReset();
  postMock.mockImplementation((async (url: string) => {
    if (url === `/parties/${PARTY}/settle/preview`) return { quote: QUOTE };
    return undefined;
  }) as unknown as typeof api.post);
}

/** The platform holds no plan for the party (no package in the OTO App). */
function noPlan() {
  getMock.mockImplementation((async (url: string) => {
    if (url.startsWith(`/parties/${PARTY}`)) {
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan: null, planStatus: 'no_package' };
    }
    return { member: null };
  }) as unknown as typeof api.get);
}

beforeEach(() => {
  saleRead = null;
  serve();
});

// --- Reading the screen (the s916 harness) -----------------------------------------

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
function buttonIn(tree: unknown, words: string): El | null {
  for (const el of walk(tree)) {
    if (!('onClick' in el.props) && !('disabled' in el.props)) continue;
    const text = textOf(el.props.children).replace(/\s+/g, ' ').trim();
    if (text === words) return el;
  }
  return null;
}
const elementOf = (tree: unknown, type: unknown): El | null => {
  for (const el of walk(tree)) if (el.type === type) return el;
  return null;
};
async function settle() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
const partyPage = (party: PartyBooking) =>
  renderHook((p: Record<string, unknown>) => PartyDetail(p as never), {
    party,
    surface: 'till',
    onBack: () => undefined,
    onChanged: () => undefined,
  } as Record<string, unknown>);

// The phone's page reads its plan with a hook (SCRUM-906) and prices the party
// from that read, so it renders as the desk's does.
const phonePage = (party: PartyBooking) =>
  renderHook((p: Record<string, unknown>) => MobilePartyDetail(p as never), {
    party,
    stationId: TILL,
    onBack: () => undefined,
    onTakePayment: vi.fn(),
    onAddFnb: () => undefined,
  } as Record<string, unknown>);

/** The plan reads and Settle party previews a page asked for this party. */
const planReads = () => getMock.mock.calls.filter((c) => String(c[0]).startsWith(`/parties/${PARTY}`)).length;
const previews = () => postMock.mock.calls.filter((c) => c[0] === `/parties/${PARTY}/settle/preview`).length;

// =============================================================================

describe('SCRUM-936 — the bill before a settlement is the package the plan owes', () => {
  it('the platform’s quote: the package, the deposit, the balance Settle party takes', () => {
    expect(partyBillShown(partyOf(null), QUOTE)).toEqual({ total: 16_900, deposit: 1_000, paid: 0, outstanding: 15_900, settlementOwed: 15_900 });
  });

  it('a cancelled or refunded settlement is the same as none: the package is owed again', () => {
    expect(partyBillShown(partyOf({ ...OPEN, state: 'voided' }), QUOTE)).toEqual({
      total: 16_900, deposit: 1_000, paid: 0, outstanding: 15_900, settlementOwed: 15_900,
    });
    expect(partyBillShown(partyOf({ ...OPEN, state: 'refunded' }), QUOTE).outstanding).toBe(15_900);
  });

  it('a settlement open or settled is read as before, whatever quote is given', () => {
    expect(partyBillShown(partyOf(OPEN), QUOTE)).toEqual(partyBillShown(partyOf(OPEN)));
    const settled = { ...OPEN, state: 'settled' as const, receiptNumber: 'T1-000123', paidSatang: 1_690_000, outstandingSatang: 0 };
    expect(partyBillShown(partyOf(settled), QUOTE)).toEqual(partyBillShown(partyOf(settled)));
  });

  it('with no quote the tab’s bill reads exactly as before', () => {
    expect(partyBillShown(partyOf(null))).toEqual({ total: 0, deposit: 1_000, paid: 0, outstanding: 0, settlementOwed: 0 });
    expect(partyBillShown(partyOf(null, 1_690_000))).toEqual({ total: 16_900, deposit: 1_000, paid: 0, outstanding: 15_900, settlementOwed: 0 });
  });
});

describe('SCRUM-936 — the parties list reads the page’s bill, never Paid while it is owed', () => {
  it('a settlement open with ฿15,800 to take reads Outstanding ฿15,800, not Paid', () => {
    expect(partyListFigure(partyOf(OPEN))).toEqual({ kind: 'owed', amount: 15_800 });
  });

  it('a party not settled reads the package the platform prices, as its page does', () => {
    expect(partyListFigure(partyOf(null), priced())).toEqual({ kind: 'owed', amount: 15_900 });
    expect(partyListFigure(partyOf({ ...OPEN, state: 'voided' }), priced())).toEqual({ kind: 'owed', amount: 15_900 });
    // A ฿2,500 charge on the tab: the list and the page both say ฿18,400, never the charge alone.
    const charged = withTabCharge(partyOf(null));
    expect(partyListFigure(charged, priced())).toEqual({ kind: 'owed', amount: 18_400 });
    expect(partyBillShown(charged, QUOTE).outstanding).toBe(18_400);
  });

  it('no figure while the price is being read, nor for a package owed that could not be priced', () => {
    expect(partyListFigure(partyOf(null), { state: 'reading' })).toBeNull();
    expect(partyListFigure(partyOf(null, 1_690_000), { state: 'reading' })).toBeNull();
    expect(partyListFigure(partyOf(null), { state: 'refused', message: 'offline' })).toBeNull();
  });

  it('a party the platform holds no plan for reads as before: Paid with nothing owed, its tab when it has one', () => {
    expect(partyListFigure(partyOf(null))).toEqual({ kind: 'paid' });
    expect(partyListFigure(partyOf(null), NO_PLANNED_QUOTE)).toEqual({ kind: 'paid' });
    expect(partyListFigure(partyOf(null, 1_690_000), { state: 'refused', message: 'offline' })).toEqual({ kind: 'owed', amount: 15_900 });
  });

  it('a party with its bill on the tab, and a settled one with nothing left, read as before', () => {
    expect(partyListFigure(partyOf(null, 1_690_000))).toEqual({ kind: 'owed', amount: 15_900 });
    const settled = { ...OPEN, state: 'settled' as const, receiptNumber: 'T1-000123', paidSatang: 1_690_000, outstandingSatang: 0 };
    expect(partyListFigure(partyOf(settled))).toEqual({ kind: 'paid' });
  });

  it('both lists price each row as its page does', () => {
    for (const [file, row] of [
      ['pages/Events.tsx', '<PartyRowFigure party={ev as unknown as PartyBooking} />'],
      ['components/mobile/parties/MobileEventsList.tsx', '<MobilePartyRowFigure party={ev as unknown as PartyBooking} />'],
    ] as const) {
      const text = src(file);
      expect(text).toContain(row);
      expect(text).toContain('partyListFigure(party, usePartyPlannedQuote(party, station?.stationId ?? null))');
      expect(text).not.toContain('computePartyOutstanding(ev');
    }
  });

  it('the counter’s row: no figure while the price is read, then the page’s Outstanding', async () => {
    const row = renderHook((p: { party: PartyBooking }) => PartyRowFigure(p), { party: withTabCharge(partyOf(null)) });
    expect(row.result.current === null).toBe(true);
    await settle();
    const text = textOf(row.result.current).replace(/\s+/g, ' ');
    expect(text).toContain('Outstanding');
    expect(text).toContain('฿18400');
    expect(text.includes('Paid')).toBe(false);
  });

  it('the phone’s row: no figure while the price is read, then the page’s Due', async () => {
    const row = renderHook((p: { party: PartyBooking }) => MobilePartyRowFigure(p), { party: partyOf(null) });
    expect(row.result.current === null).toBe(true);
    await settle();
    const text = textOf(row.result.current).replace(/\s+/g, ' ');
    expect(text).toContain('Due');
    expect(text).toContain('฿15900');
  });

  it('a row for a party the platform holds no plan for still reads Paid with nothing owed', async () => {
    noPlan();
    const row = renderHook((p: { party: PartyBooking }) => PartyRowFigure(p), { party: partyOf(null) });
    await settle();
    expect(textOf(row.result.current).trim()).toBe('Paid');
  });
});

describe('SCRUM-936 — the counter’s party page before Settle party', () => {
  it('reads the package as owed and Take balance names it, instead of Fully paid', async () => {
    const page = partyPage(partyOf(null));
    await settle();
    const text = flat(page.result.current);
    expect(text).toContain('Birthday package, Central Floresta ฿16900');
    expect(text).toContain('Total ฿16900');
    expect(text).toContain('Deposit paid −฿1000');
    expect(text).toContain('Outstanding ฿15900');
    expect(text.includes('Fully paid')).toBe(false);
    const take = buttonIn(page.result.current, 'Take balance ฿15900');
    expect(take === null).toBe(false);
    expect(take!.props.disabled).toBe(false);
    // The preview is asked on the plan's counts, as Settle party opens on them.
    const preview = postMock.mock.calls.find((c) => c[0] === `/parties/${PARTY}/settle/preview`);
    expect(preview?.[1]).toMatchObject({ branchId: HKT_CENTRAL, kids: 2, adults: 2 });
  });

  it('Take balance opens Settle party: the package is taken through the settlement', async () => {
    const page = partyPage(partyOf(null));
    await settle();
    (buttonIn(page.result.current, 'Take balance ฿15900')!.props.onClick as () => void)();
    await settle();
    expect(elementOf(page.result.current, PartySettleModal)?.props).toMatchObject({ open: true, resumeSaleId: null });
  });

  it('after a settlement is cancelled, the package is owed again', async () => {
    const page = partyPage(partyOf({ ...OPEN, state: 'voided' }));
    await settle();
    const text = flat(page.result.current);
    expect(text).toContain('Outstanding ฿15900');
    expect(buttonIn(page.result.current, 'Take balance ฿15900') === null).toBe(false);
  });

  /** The bill while its price is not in: dashes, and Take balance off — never Fully paid. */
  function expectDashes(tree: unknown, packageLabel: string) {
    const text = flat(tree);
    expect(text).toContain(`${packageLabel} —`);
    expect(text).toContain('Total —');
    expect(text).toContain('Outstanding —');
    expect(text).toContain('Deposit paid −฿1000');
    expect(text.includes('Fully paid')).toBe(false);
    expect(text.includes('Total ฿0')).toBe(false);
    expect(text.includes('Outstanding ฿0')).toBe(false);
    const take = buttonIn(tree, 'Take balance —');
    expect(take === null).toBe(false);
    expect(take!.props.disabled).toBe(true);
    return text;
  }

  it('while the platform prices it, the bill shows a dash and takes nothing', async () => {
    postMock.mockImplementation((() => new Promise(() => undefined)) as unknown as typeof api.post);
    const page = partyPage(partyOf(null));
    await settle();
    const text = expectDashes(page.result.current, 'Birthday package, Central Floresta');
    expect(text.includes('could not be read')).toBe(false);
  });

  it('while the plan is being read, the same', async () => {
    getMock.mockImplementation((() => new Promise(() => undefined)) as unknown as typeof api.get);
    const page = partyPage(partyOf(null));
    await settle();
    expectDashes(page.result.current, 'Base package');
  });

  it('when the platform will not price it, the dash stays and its sentence says why', async () => {
    postMock.mockImplementation((async () => {
      throw new Error('offline');
    }) as unknown as typeof api.post);
    const page = partyPage(partyOf(null));
    await settle();
    const text = expectDashes(page.result.current, 'Birthday package, Central Floresta');
    expect(text).toContain('What this party owes could not be read from the platform — offline');
  });

  it('when the plan cannot be read at all, the dash stays and says so', async () => {
    getMock.mockImplementation((async () => {
      throw new Error('offline');
    }) as unknown as typeof api.get);
    const page = partyPage(partyOf(null));
    await settle();
    const text = expectDashes(page.result.current, 'Base package');
    expect(text).toContain('What this party owes could not be read from the platform. Open the party again to read it.');
  });

  it('reads the plan once: its kitchen sections and its bill share the read', async () => {
    const page = partyPage(partyOf(null));
    await settle();
    expect(flat(page.result.current)).toContain('Outstanding ฿15900');
    expect(planReads()).toBe(1);
    expect(previews()).toBe(1);
  });

  it('a party the platform holds no plan for reads as before', async () => {
    noPlan();
    const page = partyPage(partyOf(null));
    await settle();
    expect(buttonIn(page.result.current, 'Fully paid') === null).toBe(false);
    expect(flat(page.result.current)).toContain('Outstanding ฿0');
  });
});

describe('SCRUM-936 — the phone’s party page before Settle party', () => {
  it('reads the package as owed and sends staff to a counter till to settle it', async () => {
    const page = phonePage(partyOf(null));
    await settle();
    const tree = page.result.current;
    const text = flat(tree);
    expect(text).toContain('Due ฿15900');
    expect(text).toContain('Total ฿16900');
    expect(text).toContain('Outstanding ฿15900');
    expect(text.includes('Fully paid')).toBe(false);
    const button = buttonIn(tree, 'Not settled · ฿15900');
    expect(button === null).toBe(false);
    expect(button!.props.disabled).toBe(true);
    expect(text).toContain("Take it with Settle party on a counter till's party page.");
  });

  it('while the price is being read: a dash, never Fully paid, and nothing taken', async () => {
    postMock.mockImplementation((() => new Promise(() => undefined)) as unknown as typeof api.post);
    const page = phonePage(partyOf(null));
    await settle();
    const tree = page.result.current;
    const text = flat(tree);
    expect(text).toContain('Due —');
    expect(text).toContain('Total —');
    expect(text).toContain('Outstanding —');
    expect(text.includes('Fully paid')).toBe(false);
    const button = buttonIn(tree, 'Take payment · —');
    expect(button === null).toBe(false);
    expect(button!.props.disabled).toBe(true);
  });

  it('when the platform will not price it, the dash stays and its sentence says why', async () => {
    const message = 'What this party owes could not be read from the platform — offline';
    postMock.mockImplementation((async () => {
      throw new Error('offline');
    }) as unknown as typeof api.post);
    const page = phonePage(partyOf(null));
    await settle();
    const tree = page.result.current;
    const text = flat(tree);
    expect(text).toContain(message);
    expect(text).toContain('Outstanding —');
    expect(text.includes('Fully paid')).toBe(false);
  });

  it('an open settlement still reads as SCRUM-916 left it', async () => {
    const page = phonePage(partyOf(OPEN));
    await settle();
    const tree = page.result.current;
    expect(buttonIn(tree, 'Settlement open · ฿15800') === null).toBe(false);
    expect(flat(tree)).toContain("Take it with Resume settlement on a counter till's party page.");
  });

  it('reads the plan once: its kitchen rows and its bill share the read, and the host reads none', async () => {
    const page = phonePage(partyOf(null));
    await settle();
    expect(flat(page.result.current)).toContain('Outstanding ฿15900');
    expect(planReads()).toBe(1);
    expect(previews()).toBe(1);
    // The phone's party list host hands the page its till and reads no plan of its own.
    const host = src('components/mobile/parties/MobileParties.tsx');
    expect(host).toContain('stationId={station?.stationId ?? null}');
    expect(host.includes('usePartyPlannedQuote')).toBe(false);
    expect(host.includes('readPartyPlanOnPlatform')).toBe(false);
  });
});

describe('SCRUM-936 — a party the platform settles on its tab reads the tab, as before', () => {
  /** One walk-up guest the board put on the tab: the preview prices it, the settle refuses it. */
  const WALK_UP_QUOTE: PartySettleQuote = { ...QUOTE, walkUps: 1, walkUpsSatang: 45_000 };
  const walkUp = {
    id: 'walk-up-1',
    kind: 'ticket' as const,
    items: [{ name: 'Walk-up guest — Ploy', qty: 1, lineTotal: 450 }],
    total: 450,
    chargedBy: 'Som',
    chargedById: 'acc-som',
    chargedAt: `${T}T08:00:00.000Z`,
  };
  const withWalkUp = (totalValueSatang: number) => ({ ...partyOf(null, totalValueSatang), partyExtraCharges: [walkUp] });
  /** ฿5,000 of the package taken on the tab, which carries no charge of its own. */
  const paidOnTab = (totalValueSatang: number) => ({
    ...partyOf(null, totalValueSatang),
    partyPayments: [{ id: 'pay-1', amount: 5_000, method: 'cash', takenBy: 'Som', takenById: 'acc-som', takenAt: `${T}T08:00:00.000Z` }],
  });
  const takenOnTab = (quote: PartySettleQuote) => {
    postMock.mockImplementation((async (url: string) => {
      if (url === `/parties/${PARTY}/settle/preview`) return { quote };
      return undefined;
    }) as unknown as typeof api.post);
  };

  it('walk-ups on the tab: the quote is set aside, and nothing is owed to Settle party', () => {
    expect(settlesOnTab(withWalkUp(1_690_000), WALK_UP_QUOTE)).toBe(true);
    expect(partyBillShown(withWalkUp(1_690_000), WALK_UP_QUOTE)).toEqual(partyBillShown(withWalkUp(1_690_000)));
    expect(partyBillShown(withWalkUp(1_690_000), WALK_UP_QUOTE)).toEqual({
      total: 17_350, deposit: 1_000, paid: 0, outstanding: 16_350, settlementOwed: 0,
    });
    expect(partyBillShown(withWalkUp(0), WALK_UP_QUOTE).settlementOwed).toBe(0);
  });

  it('money for the package already taken on the tab: the quote is set aside too', () => {
    expect(settlesOnTab(paidOnTab(1_690_000), QUOTE)).toBe(true);
    expect(partyBillShown(paidOnTab(1_690_000), QUOTE)).toEqual({
      total: 16_900, deposit: 1_000, paid: 5_000, outstanding: 10_900, settlementOwed: 0,
    });
    // A tab paid no further than its own charges is still settled as one sale.
    const chargedAndPaid = { ...paidOnTab(0), partyExtraCharges: [{ ...walkUp, id: 'fnb-1', kind: 'fnb' as const, total: 5_000 }] };
    expect(settlesOnTab(chargedAndPaid, QUOTE)).toBe(false);
    expect(partyBillShown(chargedAndPaid, QUOTE).settlementOwed).toBe(15_900);
  });

  it('the counter’s Take balance opens the tab’s balance screen, not Settle party (walk-ups)', async () => {
    takenOnTab(WALK_UP_QUOTE);
    const page = partyPage(withWalkUp(1_690_000));
    await settle();
    const take = buttonIn(page.result.current, 'Take balance ฿16350');
    expect(take === null).toBe(false);
    (take!.props.onClick as () => void)();
    await settle();
    expect(elementOf(page.result.current, PartyBalanceModal)?.props.open).toBe(true);
    expect(elementOf(page.result.current, PartySettleModal)?.props.open).toBe(false);
  });

  it('the counter’s Take balance opens the tab’s balance screen, not Settle party (paid on the tab)', async () => {
    const page = partyPage(paidOnTab(1_690_000));
    await settle();
    const take = buttonIn(page.result.current, 'Take balance ฿10900');
    expect(take === null).toBe(false);
    (take!.props.onClick as () => void)();
    await settle();
    expect(elementOf(page.result.current, PartyBalanceModal)?.props.open).toBe(true);
    expect(elementOf(page.result.current, PartySettleModal)?.props.open).toBe(false);
  });

  it('the phone never sends staff to Settle party for them', async () => {
    for (const [party, quote] of [
      [withWalkUp(1_690_000), WALK_UP_QUOTE],
      [withWalkUp(0), WALK_UP_QUOTE],
      [paidOnTab(1_690_000), QUOTE],
    ] as const) {
      takenOnTab(quote);
      const page = phonePage(party);
      await settle();
      const text = flat(page.result.current);
      expect(text.includes('Settle party')).toBe(false);
      expect(text.includes('Not settled')).toBe(false);
    }
    takenOnTab(WALK_UP_QUOTE);
    const page = phonePage(withWalkUp(1_690_000));
    await settle();
    expect(buttonIn(page.result.current, 'Take payment · ฿16350') === null).toBe(false);
  });
});

describe('SCRUM-935 — closing the settle window reads the party again', () => {
  function modal(resumeSaleId: string | null) {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      party: partyOf(resumeSaleId ? OPEN : null),
      plan: PLAN,
      stationId: TILL,
      resumeSaleId,
      onSettled: vi.fn(),
    };
    return { props, host: renderHook((p: typeof props) => PartySettleModal(p), props) };
  }
  const closeButton = (tree: unknown) => [...walk(tree)].find((el) => el.props['aria-label'] === 'Close') ?? null;

  it('closed with X after a part was taken: the window closes and the page reads the party', async () => {
    const { host, props } = modal('sale-1');
    await settle();
    (closeButton(host.result.current)!.props.onClick as () => void)();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onSettled).toHaveBeenCalledTimes(1);
  });

  it('closed from the form, before anything was rung up: nothing is read', async () => {
    const { host, props } = modal(null);
    await settle();
    (closeButton(host.result.current)!.props.onClick as () => void)();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onSettled).not.toHaveBeenCalled();
  });
});

describe('SCRUM-902 — Resume settlement never shows ฿0 before the balance is read', () => {
  it('while the sale is being read the stage says so, and the guest’s pane shows a dash', async () => {
    saleRead = new Promise(() => undefined);
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      party: partyOf(OPEN),
      plan: PLAN,
      stationId: TILL,
      resumeSaleId: 'sale-1',
      onSettled: vi.fn(),
    };
    const host = renderHook((p: typeof props) => PartySettleModal(p), props);
    await settle();
    const stage = elementOf(host.result.current, StepPayment)!.props.paymentStage as { recovering?: boolean; state: { outstandingSatang: number } };
    expect(stage.recovering).toBe(true);
    expect(stage.state.outstandingSatang).toBe(0);
    const pane = [...walk(host.result.current)].find((el) => 'unread' in el.props);
    expect(pane?.props.unread).toBe(true);
  });

  it('once read, the balance', async () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      party: partyOf(OPEN),
      plan: PLAN,
      stationId: TILL,
      resumeSaleId: 'sale-1',
      onSettled: vi.fn(),
    };
    const host = renderHook((p: typeof props) => PartySettleModal(p), props);
    await settle();
    const stage = elementOf(host.result.current, StepPayment)!.props.paymentStage as { recovering?: boolean; state: { outstandingSatang: number } };
    expect(stage.recovering).toBe(false);
    expect(stage.state.outstandingSatang).toBe(1_690_000);
  });
});

describe('SCRUM-967 — the bill and Take balance follow a manager’s kitchen edit at once', () => {
  const putMock = vi.mocked(api.put);
  /** The BEO's kitchen plan after the manager added two Calamari as an EXTRA on the till (฿355). */
  const EDITED: PartyPlan = {
    ...PLAN,
    setMenu: [...PLAN.setMenu, { lineId: 'zz967-calamari', productCode: 'CF-14', name: 'ZZ TEST calamari', qty: 2, choiceGroup: null,
      chosenOption: null, note: null, origin: 'extra', onTillMenu: true }],
  };
  /** The platform's price of Settle party on that plan: the extra charged beside the package. */
  const REPRICED: PartySettleQuote = { ...QUOTE, addOnsSatang: 35_500, totalSatang: 1_725_500, balanceSatang: 1_625_500 };

  it('a kitchen Save prices the party again without a reload: Take balance waits while it is read, then names the new balance', async () => {
    let plan = PLAN;
    getMock.mockImplementation((async (url: string) => {
      if (url.startsWith(`/parties/${PARTY}/kitchen-plan/choices`)) return { status: 'ok', message: null, groups: [] };
      if (url.startsWith(`/parties/${PARTY}`)) return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan, planStatus: 'ready' };
      return { member: null };
    }) as unknown as typeof api.get);
    // The platform prices each plan as it stands; the second read is held so the wait can be seen.
    let release: (() => void) | null = null;
    postMock.mockImplementation((async (url: string) => {
      if (url !== `/parties/${PARTY}/settle/preview`) return undefined;
      if (plan === PLAN) return { quote: QUOTE };
      await new Promise<void>((resolve) => { release = resolve; });
      return { quote: REPRICED };
    }) as unknown as typeof api.post);
    putMock.mockReset();
    putMock.mockImplementation((async () => {
      plan = EDITED;
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan: EDITED, planStatus: 'ready', kitchenEdit: { id: 'zz-edit', replayed: false } };
    }) as unknown as typeof api.put);

    const page = partyPage(partyOf(null));
    await settle();
    expect(flat(page.result.current)).toContain('Outstanding ฿15900');
    expect(buttonIn(page.result.current, 'Take balance ฿15900')!.props.disabled).toBe(false);

    // The manager's kitchen edit, saved on the same page (no reload, no remount).
    (buttonIn(page.result.current, 'Edit party')!.props.onClick as () => void)();
    await settle();
    const form = elementOf(page.result.current, PartyEditForm)!;
    await (form.props.onSave as (p: unknown, c: unknown) => Promise<void>)({ ...partyOf(null) }, [{ op: 'set', lineId: 'zz967-fries', qty: 3 }]);
    await settle();
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(elementOf(page.result.current, PartyEditForm)).toBeNull();

    // The plan is read again and priced again: while that price is on its way, nothing is taken.
    expect(release === null).toBe(false);
    const waiting = buttonIn(page.result.current, 'Take balance —');
    expect(waiting === null).toBe(false);
    expect(waiting!.props.disabled).toBe(true);
    expect(buttonIn(page.result.current, 'Take balance ฿15900')).toBeNull();

    // The new price: the bill and the button say it, on the page as it stands.
    release!();
    await settle();
    const text = flat(page.result.current);
    expect(text).toContain('Outstanding ฿16255');
    expect(text.includes('Outstanding ฿15900')).toBe(false);
    const take = buttonIn(page.result.current, 'Take balance ฿16255');
    expect(take === null).toBe(false);
    expect(take!.props.disabled).toBe(false);
    // And Take balance opens Settle party, which takes the platform's own fresh figure.
    (take!.props.onClick as () => void)();
    await settle();
    expect(elementOf(page.result.current, PartySettleModal)?.props).toMatchObject({ open: true, plan: EDITED });
  });

  it('while the plan is read again after a kitchen Save, Take balance waits: the old figure is never on a button', async () => {
    let plan = PLAN;
    let saved = false;
    // The read of the plan after the Save is held, so the moment before it answers can be seen.
    const heldReads: (() => void)[] = [];
    getMock.mockImplementation((async (url: string) => {
      if (url.startsWith(`/parties/${PARTY}/kitchen-plan/choices`)) return { status: 'ok', message: null, groups: [] };
      if (url.startsWith(`/parties/${PARTY}`)) {
        if (saved) await new Promise<void>((resolve) => { heldReads.push(resolve); });
        return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan, planStatus: 'ready' };
      }
      return { member: null };
    }) as unknown as typeof api.get);
    // The platform prices Settle party from the BEO it reads itself, so it already has the new figure.
    postMock.mockImplementation((async (url: string) => (url === `/parties/${PARTY}/settle/preview`
      ? { quote: plan === PLAN ? QUOTE : REPRICED } : undefined)) as unknown as typeof api.post);
    putMock.mockReset();
    putMock.mockImplementation((async () => {
      plan = EDITED;
      saved = true;
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan: EDITED, planStatus: 'ready', kitchenEdit: { id: 'zz-edit', replayed: false } };
    }) as unknown as typeof api.put);

    const page = partyPage(partyOf(null));
    await settle();
    expect(buttonIn(page.result.current, 'Take balance ฿15900')!.props.disabled).toBe(false);

    (buttonIn(page.result.current, 'Edit party')!.props.onClick as () => void)();
    await settle();
    const form = elementOf(page.result.current, PartyEditForm)!;
    await (form.props.onSave as (p: unknown, c: unknown) => Promise<void>)({ ...partyOf(null) }, [{ op: 'set', lineId: 'zz967-fries', qty: 3 }]);
    await settle();
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(elementOf(page.result.current, PartyEditForm)).toBeNull();

    // The plan read is on its way: the page knows its figure is behind the BEO, so nothing names it.
    expect(heldReads.length > 0).toBe(true);
    expect(buttonIn(page.result.current, 'Take balance ฿15900') === null).toBe(true);
    const waiting = buttonIn(page.result.current, 'Take balance —');
    expect(waiting === null).toBe(false);
    expect(waiting!.props.disabled).toBe(true);
    expect(flat(page.result.current).includes('Outstanding ฿15900')).toBe(false);

    // The read answers: the plan is priced again, and the button names what Settle party will take.
    for (const release of heldReads.splice(0)) release();
    await settle();
    expect(flat(page.result.current)).toContain('Outstanding ฿16255');
    const take = buttonIn(page.result.current, 'Take balance ฿16255');
    expect(take === null).toBe(false);
    expect(take!.props.disabled).toBe(false);
  });

  it('a plan changed in the OTO App is priced again at the page’s next read of it', async () => {
    let plan = PLAN;
    getMock.mockImplementation((async (url: string) => {
      if (url.startsWith(`/parties/${PARTY}`)) return { branchId: HKT_CENTRAL, date: T, event: viewOf(null), plan, planStatus: 'ready' };
      return { member: null };
    }) as unknown as typeof api.get);
    postMock.mockImplementation((async (url: string) => (url === `/parties/${PARTY}/settle/preview`
      ? { quote: plan === PLAN ? QUOTE : REPRICED } : undefined)) as unknown as typeof api.post);
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    try {
      const page = partyPage(partyOf(null));
      await settle();
      expect(buttonIn(page.result.current, 'Take balance ฿15900') === null).toBe(false);
      plan = EDITED;
      win.dispatchEvent(new Event('focus'));
      await settle();
      expect(flat(page.result.current)).toContain('Outstanding ฿16255');
      expect(buttonIn(page.result.current, 'Take balance ฿16255') === null).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
