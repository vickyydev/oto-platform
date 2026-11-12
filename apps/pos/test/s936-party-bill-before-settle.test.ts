import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyPlan, PartySettleQuote, PartySettlementView } from '@oto/shared';
import { api } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartySettleModal } from '@/components/parties/PartySettleModal';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { StepPayment } from '@/components/till/StepPayment';
import { partyBillShown, partyListFigure } from '@/lib/partySettlementBill';
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

  it('a party not settled whose tab carries no package names no figure', () => {
    expect(partyListFigure(partyOf(null))).toBeNull();
    expect(partyListFigure(partyOf({ ...OPEN, state: 'voided' }))).toBeNull();
  });

  it('a party with its bill on the tab, and a settled one with nothing left, read as before', () => {
    expect(partyListFigure(partyOf(null, 1_690_000))).toEqual({ kind: 'owed', amount: 15_900 });
    const settled = { ...OPEN, state: 'settled' as const, receiptNumber: 'T1-000123', paidSatang: 1_690_000, outstandingSatang: 0 };
    expect(partyListFigure(partyOf(settled))).toEqual({ kind: 'paid' });
  });

  it('both lists read it', () => {
    for (const file of ['pages/Events.tsx', 'components/mobile/parties/MobileEventsList.tsx']) {
      const text = src(file);
      expect(text).toContain('partyListFigure(ev as unknown as PartyBooking)');
      expect(text).not.toContain('computePartyOutstanding(ev');
    }
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

  it('when the platform will not price it, the page reads as before', async () => {
    postMock.mockImplementation((async () => {
      throw new Error('offline');
    }) as unknown as typeof api.post);
    const page = partyPage(partyOf(null));
    await settle();
    expect(buttonIn(page.result.current, 'Fully paid') === null).toBe(false);
  });
});

describe('SCRUM-936 — the phone’s party page before Settle party', () => {
  it('reads the package as owed and sends staff to a counter till to settle it', () => {
    const tree = MobilePartyDetail({ party: partyOf(null), planned: QUOTE, onBack: () => undefined, onTakePayment: vi.fn(), onAddFnb: () => undefined });
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

  it('an open settlement still reads as SCRUM-916 left it', () => {
    const tree = MobilePartyDetail({ party: partyOf(OPEN), planned: null, onBack: () => undefined, onTakePayment: vi.fn(), onAddFnb: () => undefined });
    expect(buttonIn(tree, 'Settlement open · ฿15800') === null).toBe(false);
    expect(flat(tree)).toContain("Take it with Resume settlement on a counter till's party page.");
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
