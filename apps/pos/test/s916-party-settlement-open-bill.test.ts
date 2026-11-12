import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyPlan, PartySettlementView, PaymentAttemptView } from '@oto/shared';
import { api } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartySettleModal } from '@/components/parties/PartySettleModal';
import { MobilePartyDetail } from '@/components/mobile/parties/MobilePartyDetail';
import { StepPayment } from '@/components/till/StepPayment';
import { partyBillShown } from '@/lib/partySettlementBill';
import type { PartyBooking } from '@/types';
import { renderHook } from './support/hooks';

/**
 * SCRUM-916 — THE PARTY PAGE WHILE A SETTLEMENT IS OPEN, AND BACK ON ITS
 * PAYMENT SCREEN.
 *
 * Seen on staging (SCRUM-889's proof, pictures 01c, 01f, 01b2): a settlement
 * open with nothing taken, and the party page's main button read "Fully paid"
 * (off) while the bill read Total ฿0, Deposit paid ฿0 and a green Outstanding
 * ฿0 beside "Resume settlement ฿15900". Since SCRUM-804 the tab's bill zeroes
 * the package and the deposit while a settlement holds them, and the page read
 * only that. Now, while a settlement is open, the page shows its own figures —
 * its total, its deposit, its balance, as the platform answered them — beside
 * what the tab holds, and Take balance takes the settlement's balance on its
 * payment screen. The phone's party page reads the same.
 *
 * And Back on the settle payment screen was off from the start: the party's
 * deposit, recorded on the settlement sale before it opened, counted as a
 * tender taken there. Back now works until a tender is really taken on that
 * screen, then stays off, as for any other sale.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0916';
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
    includedLines: [],
  },
  counts: { kidsExpected: 10, adultsExpected: 4 },
  addOns: [],
  entertainment: [],
  setMenu: [],
  barItems: [],
  kitchen: null,
  settlement: { depositSatang: 300_000, posSaleId: 'sale-1' },
};

/** A settlement rung up with the party's ฿3,000 deposit on it and ฿13,900 still to take. */
const OPEN: PartySettlementView = {
  id: 'settlement-1',
  saleId: 'sale-1',
  state: 'open',
  receiptNumber: null,
  grossSatang: 1_690_000,
  paidSatang: 300_000,
  outstandingSatang: 1_390_000,
  depositSatang: 300_000,
  kids: 10,
  adults: 4,
  createdAt: `${T}T07:00:00.000Z`,
  settledAt: null,
  writeBack: null,
};

/** ฿180 of food the counter put on the party's tab meanwhile. */
const TAB_CHARGE = {
  id: 'charge-1',
  kind: 'fnb' as const,
  items: [{ name: 'Pad Thai', qty: 1, lineTotalSatang: 18_000 }],
  totalSatang: 18_000,
  chargedBy: 'Som',
  chargedById: 'acc-som',
  chargedAt: `${T}T06:00:00.000Z`,
};

function viewOf(settlement: PartySettlementView | null, charges: (typeof TAB_CHARGE)[] = []): EventView {
  return {
    id: PARTY,
    branchId: HKT_CENTRAL,
    type: 'party',
    appEventType: 'birthday',
    status: 'upcoming',
    appStatus: 'upcoming',
    archived: false,
    title: 'ZZ TEST party',
    startDate: T,
    endDate: T,
    cancelledDays: [],
    startTime: '15:00',
    endTime: '18:00',
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
      charges,
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

const partyOf = (settlement: PartySettlementView | null, charges: (typeof TAB_CHARGE)[] = []) =>
  toOtoEvent(viewOf(settlement, charges), 'hkt-central') as unknown as PartyBooking;

function attempt(over: Partial<PaymentAttemptView>): PaymentAttemptView {
  return {
    id: 'attempt',
    saleId: 'sale-1',
    method: 'cash',
    provider: 'manual',
    status: 'approved',
    amountSatang: 0,
    tenderedSatang: null,
    changeSatang: null,
    terminalRef: null,
    tid: null,
    approvalCode: null,
    last4: null,
    invoiceNo: null,
    tranRef: null,
    actionId: null,
    offline: false,
    paidAt: `${T}T07:00:00.000Z`,
    createdAt: `${T}T07:00:00.000Z`,
    ...over,
  };
}
/** The deposit as the platform records it on the settlement sale (SCRUM-876). */
const DEPOSIT = attempt({ id: 'attempt-deposit', method: 'other', amountSatang: 300_000, partyDeposit: true });
/** ฿1,000 of the balance taken in cash on the settle screen. */
const CASH_PART = attempt({ id: 'attempt-cash', amountSatang: 100_000, tenderedSatang: 100_000, changeSatang: 0, paidAt: `${T}T07:10:00.000Z`, createdAt: `${T}T07:10:00.000Z` });

/** GET /parties/:id answers the plan; the settlement sale answers with the attempts on it. */
function serve(attempts: PaymentAttemptView[]) {
  getMock.mockReset();
  getMock.mockImplementation((async (path: string) => {
    if (path.startsWith(`/parties/${PARTY}`)) {
      return { branchId: HKT_CENTRAL, date: T, event: viewOf(OPEN), plan: PLAN, planStatus: 'ready' };
    }
    if (path === '/sales/sale-1') {
      return { sale: { id: 'sale-1', status: 'tendering', totals: { grossSatang: 1_690_000 } }, attempts };
    }
    if (path.startsWith('/payments/attempts/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      const taken = attempts.filter((a) => !a.partyDeposit).reduce((sum, a) => sum + a.amountSatang, 0);
      return {
        qrPayload: null,
        qrImageUrl: null,
        expiresAt: null,
        expiryTimerMs: null,
        attempt: attempts.find((a) => a.id === id),
        deviceLabel: null,
        responseText: null,
        outstandingSatang: 1_390_000 - taken,
      };
    }
    return { member: null };
  }) as unknown as typeof api.get);
}

beforeEach(() => serve([DEPOSIT]));

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
/** What the screen says: its text, and each info row as "label value". */
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
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const partyPage = (party: PartyBooking) =>
  renderHook((p: Record<string, unknown>) => PartyDetail(p as never), {
    party,
    surface: 'till',
    onBack: () => undefined,
    onChanged: () => undefined,
  } as Record<string, unknown>);

// The phone's page reads the party's kitchen plan with a hook (SCRUM-906), so it renders as the desk's does.
const phonePage = (party: PartyBooking) =>
  renderHook((p: Record<string, unknown>) => MobilePartyDetail(p as never), {
    party,
    onBack: () => undefined,
    onTakePayment: vi.fn(),
    onAddFnb: () => undefined,
  } as Record<string, unknown>).result.current;

// =============================================================================

describe('SCRUM-916 — the bill the party page shows', () => {
  it('while a settlement is open: its own total, deposit and balance, never summed again from parts', () => {
    expect(partyBillShown(partyOf(OPEN))).toEqual({ total: 16_900, deposit: 3_000, paid: 0, outstanding: 13_900, settlementOwed: 13_900 });
  });

  it('a charge on the tab meanwhile stands beside the settlement, which Take balance takes first', () => {
    expect(partyBillShown(partyOf(OPEN, [TAB_CHARGE]))).toEqual({ total: 17_080, deposit: 3_000, paid: 0, outstanding: 14_080, settlementOwed: 13_900 });
  });

  it('money taken on the settle screen shows as taken, the balance the settlement answered', () => {
    const part = { ...OPEN, paidSatang: 400_000, outstandingSatang: 1_290_000 };
    expect(partyBillShown(partyOf(part))).toEqual({ total: 16_900, deposit: 3_000, paid: 1_000, outstanding: 12_900, settlementOwed: 12_900 });
  });

  it('no settlement, or one settled: the tab\'s bill exactly as before', () => {
    expect(partyBillShown(partyOf(null))).toEqual({ total: 16_900, deposit: 3_000, paid: 0, outstanding: 13_900, settlementOwed: 0 });
    const settled = { ...OPEN, state: 'settled' as const, receiptNumber: 'T1-000123', paidSatang: 1_690_000, outstandingSatang: 0 };
    expect(partyBillShown(partyOf(settled, [TAB_CHARGE]))).toEqual({ total: 180, deposit: 0, paid: 0, outstanding: 180, settlementOwed: 0 });
  });
});

describe('SCRUM-916 — the counter\'s party page while a settlement is open', () => {
  it('reads the real total, deposit and balance, and Take balance names the balance instead of Fully paid', async () => {
    const page = partyPage(partyOf(OPEN));
    await settle();
    const text = flat(page.result.current);
    expect(text).toContain('Settlement open ฿13900 to take');
    expect(text).toContain('Total ฿16900');
    expect(text).toContain('Deposit paid −฿3000');
    expect(text).toContain('Outstanding ฿13900');
    expect(text).not.toContain('Fully paid');
    const take = buttonIn(page.result.current, 'Take balance ฿13900');
    expect(take).not.toBeNull();
    expect(take!.props.disabled).toBe(false);
  });

  it('Take balance resumes the settlement on its payment screen, where its balance is taken', async () => {
    const page = partyPage(partyOf(OPEN));
    await settle();
    expect(elementOf(page.result.current, PartySettleModal)?.props).toMatchObject({ open: false, resumeSaleId: 'sale-1' });
    (buttonIn(page.result.current, 'Take balance ฿13900')!.props.onClick as () => void)();
    await settle();
    expect(elementOf(page.result.current, PartySettleModal)?.props).toMatchObject({ open: true, resumeSaleId: 'sale-1' });
  });

  it('a settled party with nothing left on its tab still says Fully paid', async () => {
    const settled = { ...OPEN, state: 'settled' as const, receiptNumber: 'T1-000123', paidSatang: 1_690_000, outstandingSatang: 0 };
    const page = partyPage(partyOf(settled));
    await settle();
    const done = buttonIn(page.result.current, 'Fully paid');
    expect(done).not.toBeNull();
    expect(done!.props.disabled).toBe(true);
  });
});

describe('SCRUM-916 — the phone\'s party page reads the same', () => {
  it('names the open settlement and its balance, and never says Fully paid while it is owed', () => {
    const tree = phonePage(partyOf(OPEN));
    const text = flat(tree);
    expect(text).toContain('Due ฿13900');
    expect(text).toContain('Settlement open ฿13900 to take');
    expect(text).toContain('Total ฿16900');
    expect(text).toContain('Deposit paid −฿3000');
    expect(text).toContain('Outstanding ฿13900');
    expect(text).not.toContain('Fully paid');
    // The phone takes the tab's money only; the settlement's is taken on a counter till.
    const button = buttonIn(tree, 'Settlement open · ฿13900');
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(true);
    expect(text).toContain("Take it with Resume settlement on a counter till's party page.");
  });

  it('a charge on the tab is still taken on the phone, beside the open settlement', () => {
    const tree = phonePage(partyOf(OPEN, [TAB_CHARGE]));
    const text = flat(tree);
    expect(text).toContain('Due ฿14080');
    const button = buttonIn(tree, 'Take payment · ฿180');
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBe(false);
  });
});

describe('SCRUM-916 — Back on the settle payment screen', () => {
  function resumed() {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      party: partyOf(OPEN),
      plan: PLAN,
      stationId: TILL,
      resumeSaleId: 'sale-1',
      onSettled: vi.fn(),
    };
    return { props, host: renderHook((p: typeof props) => PartySettleModal(p), props) };
  }
  const payment = (tree: unknown) => elementOf(tree, StepPayment)!.props.paymentStage as { canBack: boolean; state: { settlements: unknown[] } };

  it('works while only the deposit, recorded before, is on the settlement: Back leaves for the party page', async () => {
    const { host, props } = resumed();
    await settle();
    const stage = payment(host.result.current);
    expect(stage.state.settlements).toHaveLength(1);
    expect(stage.canBack).toBe(true);
    (elementOf(host.result.current, StepPayment)!.props.onBack as () => void)();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays off once a tender was really taken on that screen, as for any other sale', async () => {
    serve([DEPOSIT, CASH_PART]);
    const { host } = resumed();
    await settle();
    const stage = payment(host.result.current);
    expect(stage.state.settlements).toHaveLength(2);
    expect(stage.canBack).toBe(false);
  });
});
