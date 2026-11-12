import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTY_INCLUDED_COMPONENT, PARTY_PACKAGE_COMPONENT } from '@oto/shared';
import { apiSale, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { salesApi } from '@/api/sales';
import type { ApiSaleDetail, ApiSaleLine } from '@/api/history';
import type { TicketType } from '@/types';
import { partyPageHref, partySettlementOf, useLeftBehindSales } from '@/lib/leftBehindSale';
import { isPartySettlementDetail, rebuildResumedSale, resumedPayLabel } from '@/lib/resumeSale';
import { rememberSaleOnScreen } from '@/lib/saleOnScreen';

/**
 * SCRUM-889 — AN OPEN PARTY SETTLEMENT IS NEVER REOPENED AS A TICKET ORDER.
 *
 * Found in SCRUM-876's staging proof: Settle party rang a ZZ TEST party up at
 * the till (฿16,900, the ฿1,000 deposit on it), the settlement was left at its
 * balance, and the Tickets tab then resumed it as an ordinary ticket order —
 * a Play ticket card with editable steppers, Amount Due ฿15,900 on the left
 * and a Pay button reading ฿16,900.
 *
 *   - `lib/leftBehindSale.ts` recognises the settlement on the platform's list
 *     row (`partySettlement`) and offers it as "Party settlement open — Resume
 *     on the party page": never resumable here, never the automatic resume.
 *   - `lib/resumeSale.ts` refuses to rebuild a settlement as a ticket cart,
 *     whichever road reaches it (its `party_package` / `party_included` rows).
 *   - a resumed sale's Pay press names the payment stage's balance, the same
 *     figure as Amount Due, never the order's gross.
 *   - the party page's settle flow already shows the balance everywhere; that
 *     is pinned here so it stays so.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, salesApi: { ...actual.salesApi, get: vi.fn(), voidSale: vi.fn(), list: vi.fn() } };
});

const listSales = vi.mocked(salesApi.list);
const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

const soldBy = (accountId: string) => ({ accountId, name: 'Som' });
const party = { eventId: 'party-event-1', settlementId: 'settlement-1' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = () =>
  renderHook(() =>
    useLeftBehindSales({
      branchId: 'branch-1', stationId: 'station-1', stationName: 'Reception Till 1',
      accountId: 'account-1', enabled: true, ownsSale: () => false,
    }),
  );

describe('the left-behind list tells a party settlement from a ticket sale', () => {
  it('offers this account’s own open settlement as the party page’s, never to resume here', async () => {
    listSales.mockResolvedValue({
      sales: [apiSale({ id: 'settlement-sale', stationId: 'station-1', soldBy: soldBy('account-1'), partySettlement: party })],
    });
    const view = mount();
    await settle();
    expect(view.result.current.sales).toEqual([
      expect.objectContaining({ saleId: 'settlement-sale', resumable: false, partySettlement: { eventId: 'party-event-1' } }),
    ]);
    // The Tickets tab never goes straight to it.
    expect(view.result.current.resumeId).toBeNull();
  });

  it('is not opened on even when this tab remembers it on screen', async () => {
    rememberSaleOnScreen('station-1', 'settlement-sale');
    listSales.mockResolvedValue({
      sales: [apiSale({ id: 'settlement-sale', stationId: 'station-1', soldBy: soldBy('account-1'), partySettlement: party })],
    });
    const view = mount();
    await settle();
    expect(view.result.current.resumeId).toBeNull();
  });

  it('an ordinary ticket sale beside it still resumes, and carries no party', async () => {
    listSales.mockResolvedValue({
      sales: [
        apiSale({ id: 'settlement-sale', stationId: 'station-1', soldBy: soldBy('account-1'), partySettlement: party }),
        apiSale({ id: 'ticket-sale', stationId: 'station-1', soldBy: soldBy('account-1') }),
        apiSale({ id: 'null-marker', stationId: 'station-1', soldBy: soldBy('account-2'), partySettlement: null }),
      ],
    });
    const view = mount();
    await settle();
    expect(view.result.current.sales.map((s) => [s.saleId, s.resumable, 'partySettlement' in s])).toEqual([
      ['settlement-sale', false, true],
      ['ticket-sale', true, false],
      ['null-marker', false, false],
    ]);
    // The only resumable one is the ticket sale: the till goes straight back to it.
    expect(view.result.current.resumeId).toBe('ticket-sale');
  });

  it('reads the party off the row, and the card’s way there opens that party', () => {
    expect(partySettlementOf(apiSale({ partySettlement: party }))).toEqual({ eventId: 'party-event-1' });
    expect(partySettlementOf(apiSale())).toBeNull();
    expect(partySettlementOf(apiSale({ partySettlement: null }))).toBeNull();
    expect(partyPageHref({ partySettlement: { eventId: 'party-event-1' } })).toBe('/parties?party=party-event-1');
    expect(partyPageHref({})).toBe('/parties');
  });
});

// --- The rebuild refuses a settlement; F&B and tickets as before ------------------

const row = (over: Partial<ApiSaleLine> & Pick<ApiSaleLine, 'kind' | 'cartLineId' | 'quantity' | 'unitSatang' | 'grossSatang'>): ApiSaleLine => ({
  id: `row-${over.kind}-${over.cartLineId}-${over.componentKey ?? ''}`, lineNo: 1, componentKey: null, ticketPackageId: null, label: over.kind,
  revenueCategory: 'tickets', taxableCategory: 'tickets', baseSatang: over.grossSatang, discountSatang: 0,
  netSatang: over.grossSatang, serviceChargeSatang: 0, taxSatang: 0, taxMode: 'inclusive', taxRateBp: 700, taxName: 'VAT',
  customerTier: 'tourist', kidCount: 0, adultCount: 0, freeAdultCount: 0, stayHours: null, stayDurationLabel: null,
  ...over,
});

function detail(lines: ApiSaleLine[]): ApiSaleDetail {
  return {
    sale: {
      id: 'sale-1', branchId: 'branch-1', stationId: 'station-1', memberId: null, visitId: null,
      businessDate: '2026-11-12', occurredAt: '2026-11-12T04:14:00.000Z', status: 'tendering',
      pricingMode: 'weekday', pricingModeReason: 'Weekday pricing', customerTier: 'tourist', engineVersion: 'engine-1',
      receiptNumber: null, receiptSeries: null, receiptSeq: null, finalisedAt: null, note: null,
      totals: {
        subtotalSatang: 1_690_000, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0,
        netSatang: 1_579_439, serviceChargeSatang: 0, taxInclusiveSatang: 110_561, taxExclusiveSatang: 0,
        grossSatang: 1_690_000, unappliedDiscountSatang: 0, refundedSatang: 0,
      },
    },
    taxBreakdown: null,
    lines,
    discounts: [],
    attempts: [],
  };
}

const threeHours: TicketType = {
  id: 'pkg-3h', name: '3 Hours Play', durationLabel: '3 Hours', hours: 3,
  prices: { tourist: { weekday: 0, weekend: 0 } },
  adultRules: { tourist: { kind: 'free_adults', freeAdults: 2, overflow: 'set_price', price: { weekday: 0, weekend: 0 } } },
};
const catalogue = { ticketTypes: [threeHours], addOns: [], discountByCode: () => null };

/** What Settle party writes: the guests at ฿0, the package fee, an included item. */
const settlementLines = [
  row({ kind: 'kids', cartLineId: 'guests', quantity: 2, unitSatang: 0, grossSatang: 0, kidCount: 2, ticketPackageId: 'pkg-3h' }),
  row({ kind: 'adults_free', cartLineId: 'guests', quantity: 2, unitSatang: 0, grossSatang: 0, freeAdultCount: 2, ticketPackageId: 'pkg-3h' }),
  row({ kind: 'addon', cartLineId: 'package', quantity: 1, unitSatang: 1_690_000, grossSatang: 1_690_000,
    componentKey: PARTY_PACKAGE_COMPONENT, label: 'Birthday package, Central Floresta' }),
  row({ kind: 'addon', cartLineId: 'package', quantity: 6, unitSatang: 0, grossSatang: 0,
    componentKey: PARTY_INCLUDED_COMPONENT, label: 'Kids’ table reserved for 3 hours' }),
];

describe('a settlement is never rebuilt as a ticket cart', () => {
  it('is recognised by its package fee or an included item, and refused', () => {
    expect(isPartySettlementDetail(detail(settlementLines))).toBe(true);
    expect(rebuildResumedSale(detail(settlementLines), catalogue)).toBeNull();
    // Only an included item on it is still a settlement.
    const includedOnly = detail([settlementLines[0]!, settlementLines[3]!]);
    expect(isPartySettlementDetail(includedOnly)).toBe(true);
    expect(rebuildResumedSale(includedOnly, catalogue)).toBeNull();
  });

  it('an ordinary ticket sale is rebuilt as before, and an F&B order is still refused', () => {
    const ticket = detail([settlementLines[0]!, settlementLines[1]!]);
    expect(isPartySettlementDetail(ticket)).toBe(false);
    expect(rebuildResumedSale(ticket, catalogue)?.lines).toHaveLength(1);
    const food = detail([row({ kind: 'fnb_item', cartLineId: 'f-1', quantity: 1, unitSatang: 12_000, grossSatang: 12_000 })]);
    expect(isPartySettlementDetail(food)).toBe(false);
    expect(rebuildResumedSale(food, catalogue)).toBeNull();
  });
});

describe('the Pay press names the balance', () => {
  it('on a resumed sale: the payment stage’s outstanding, never the gross', () => {
    // The proof's figures: ฿16,900 gross with the ฿1,000 deposit on it.
    expect(resumedPayLabel(1_590_000)).toBe('Pay ฿15900');
    // SCRUM-933 — an amount with satang shows its two places on the staff till.
    expect(resumedPayLabel(1_250)).toBe('Pay ฿12.50');
  });

  it('the counter till wires it, and refuses a settlement on its resume path in the party page’s words', () => {
    const till = src('pages/Till.tsx');
    // SCRUM-902 — the same balance once a part is paid at the payment step.
    expect(till).toContain('{...(payNamesBalance({ resumed: Boolean(resumed), step, paidOnScreenSatang: paidOnScreen }) ? { payLabel: resumedPayLabel(paymentStage.state.outstandingSatang) } : {})}');
    expect(till).toMatch(/if \(isPartySettlementDetail\(detail\)\) \{\s*leftBehind\.dismiss\(saleId\);\s*toast\(\{ title: 'That sale is a party settlement', description: 'Resume it on the party page\.'/);
    // The guard comes before the cart is rebuilt and before the writer adopts the sale.
    expect(till.indexOf('if (isPartySettlementDetail(detail))')).toBeLessThan(till.indexOf('const rebuilt = rebuildResumedSale(detail'));
    expect(till).toContain('onOpenParty={() => navigate(partyPageHref(left))}');
  });

  it('the party page’s settle flow takes and shows the balance, the platform’s figure, everywhere', () => {
    const modal = src('components/parties/PartySettleModal.tsx');
    expect(modal).toContain('totalSatang: quote?.balanceSatang ?? 0,');
    expect(modal).toContain('const balance = stage.state.outstandingSatang / 100;');
    expect(modal).toMatch(/<StepPayment\s+total=\{balance\}/);
    expect(modal).toContain('<CustomerPaymentPane amount={balance}');
    expect(modal).toContain("`Confirm · ${money(quote.balanceSatang)} to pay`");
    // The party page's own Resume settlement names the balance too.
    expect(src('components/parties/PartyDetail.tsx')).toContain('`Resume settlement ฿${satangText(settlement.outstandingSatang)}`');
  });

  it('the party page opens on the party the till’s card names', () => {
    expect(src('pages/Events.tsx')).toContain("useState<string | null>(() => new URLSearchParams(search).get('party'))");
  });
});
