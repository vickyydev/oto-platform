import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { priceCartLine } from '@oto/shared';
import type { ApiSaleDetail, ApiSaleLine } from '@/api/history';
import { DropOffLineConfig } from '@/components/till/DropOffLineConfig';
import { OrderSummary } from '@/components/till/OrderSummary';
import { engineCartLine, pricingContext } from '@/lib/cartWire';
import { computeLineBreakdown, computeLineTotal, lineExtrasCharge, lineFreeNotes, priceForTier } from '@/lib/pricing';
import { rebuildResumedSale } from '@/lib/resumeSale';
import type { AddOn, CartLine, SelectedAddOn, TicketType } from '@/types';

// The drop-off child's panel reads the park on screen; the till's own is HKT Central.
vi.mock('@/branch/BranchContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/branch/BranchContext')>()),
  useBranch: () => ({ branch: { id: 'hkt-central' } }),
}));
// Its add-on grid reads live stock, which a static render has no snapshot of; the summary is what is read here.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-768 — THE FREE ITEMS SET ON A TICKET IN ADMIN ARE APPLIED AT THE TILL.
 *
 * Admin → Tickets saves "Free items in the rate" — a free adult, child or
 * add-on for chosen tiers — and the till used to charge them anyway. The till
 * now counts them with the same shared reader the platform and the box price
 * with: the sale shows each free unit as its own ฿0 row, the order panel says
 * how many are free, and the line total the till sends is the platform's.
 */

// The panel is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const GRIP = '0190a0a0-0000-7000-8000-000000000768';

const ticket: TicketType = {
  id: '0190a0a0-0000-7000-8000-00000000c768',
  name: 'ZZ TEST Two hours',
  durationLabel: '2 hours',
  hours: 2,
  prices: {
    tourist: { weekday: 500, weekend: 600 },
    thai: { weekday: 300, weekend: 350 },
  },
  adultRules: { thai: { kind: 'set_price', price: { weekday: 100, weekend: 120 } } },
  freebies: [
    { id: 'fb-adult', kind: 'adult', quantity: 1, tiers: ['tourist'] },
    { id: 'fb-child', kind: 'child', quantity: 1, tiers: ['thai'] },
    { id: 'fb-grip', kind: 'addon', addOnId: GRIP, quantity: 1, tiers: ['tourist', 'thai'] },
  ],
};

const grip = (quantity: number): SelectedAddOn => ({ id: GRIP, name: 'Grip Socks', price: 90, quantity });

function cartLine(over: Partial<CartLine>, mode: 'weekday' | 'weekend' = 'weekday'): CartLine {
  const base = { ticketType: ticket, tier: 'tourist', kids: 0, adults: 0, socks: 0, addOns: [] as SelectedAddOn[], ...over };
  return { id: 'line-768', ...base, lineTotal: computeLineTotal(base, mode) } as CartLine;
}

describe('s768 — the sale line', () => {
  it('shows a free adult at ฿0 beside the adults charged, weekday and weekend', () => {
    const line = cartLine({ tier: 'tourist', kids: 2, adults: 3 });
    expect(computeLineTotal(line, 'weekday')).toBe(2 * 500 + 500);
    expect(computeLineTotal(line, 'weekend')).toBe(2 * 600 + 600);
    expect(computeLineBreakdown(line, 'weekday').map((r) => [r.label, r.quantity, r.unitPrice, r.subtotal])).toEqual([
      ['Kids', 2, 500, 1000],
      ['Adults', 1, 500, 500],
      ['Adults (free)', 2, 0, 0],
    ]);
  });

  it('shows a free child at ฿0 for the tier it was set for', () => {
    const line = cartLine({ tier: 'thai', kids: 3 });
    expect(computeLineTotal(line, 'weekend')).toBe(2 * 350);
    expect(computeLineBreakdown(line, 'weekend').map((r) => [r.key, r.label, r.quantity, r.subtotal])).toEqual([
      ['kids', 'Kids', 2, 700],
      ['kids-free', 'Kids (free)', 1, 0],
    ]);
    // Tourist was not given a free child.
    expect(computeLineTotal(cartLine({ tier: 'tourist', kids: 3 }), 'weekend')).toBe(3 * 600);
  });

  it('shows a free add-on at ฿0 under its own row, one row each on screen', () => {
    const line = cartLine({ tier: 'thai', kids: 1, addOns: [grip(2)] });
    expect(computeLineTotal(line, 'weekday')).toBe(300 + 90);
    expect(computeLineBreakdown(line, 'weekday').map((r) => [r.key, r.label, r.quantity, r.subtotal])).toEqual([
      ['kids', 'Kids', 1, 300],
      [GRIP, 'Grip Socks', 1, 90],
      [`${GRIP}:free`, 'Grip Socks (free)', 1, 0],
    ]);
  });

  it('charges a ticket with no free items exactly as before', () => {
    const plain = { ...ticket, freebies: undefined };
    const line = cartLine({ ticketType: plain, tier: 'tourist', kids: 2, adults: 3, addOns: [grip(2)] });
    expect(line.lineTotal).toBe(5 * 500 + 180);
    expect(computeLineBreakdown(line, 'weekday').map((r) => r.key)).toEqual(['kids', 'adults', GRIP]);
  });
});

describe('s768 — the figure the till sends is the platform engine’s', () => {
  it.each([
    ['tourist, free adult', { tier: 'tourist', kids: 2, adults: 3 }],
    ['thai, free child', { tier: 'thai', kids: 3, adults: 1 }],
    ['thai, free add-on', { tier: 'thai', kids: 1, addOns: [grip(3)] }],
  ] as const)('%s', (_name, over) => {
    for (const mode of ['weekday', 'weekend'] as const) {
      const line = cartLine(over as Partial<CartLine>, mode);
      expect(priceCartLine(engineCartLine(line), pricingContext(mode))).toBe(Math.round(line.lineTotal * 100));
    }
  });
});

describe('s768 — the order panel', () => {
  const noop = () => undefined;
  const panel = (line: CartLine) =>
    renderToStaticMarkup(
      createElement(OrderSummary, {
        tier: line.tier,
        lines: [line],
        discounts: [],
        manualDiscounts: [],
        onUpdateLine: noop,
        onRemoveLine: noop,
        onRemoveDiscount: noop,
        onAddManualDiscount: noop,
        onRemoveManualDiscount: noop,
        onPay: noop,
        onCancel: noop,
        canPay: true,
      }),
    );

  it('says how many kids, adults and add-ons are free, and charges the add-on less the free one', () => {
    const tourist = cartLine({ tier: 'tourist', kids: 1, adults: 2, addOns: [grip(2)] });
    expect(lineFreeNotes(tourist)).toEqual({ adults: '1 free', addOns: { [GRIP]: '1 free' } });
    const html = panel(tourist);
    expect(html).toContain('฿500 each · 1 free');
    expect(html).toContain('Grip Socks × 2 · 1 free');
    expect(html).toContain('฿90</span>');
    expect(html).toContain(`฿${tourist.lineTotal}`);

    const thai = cartLine({ tier: 'thai', kids: 2 });
    expect(lineFreeNotes(thai)).toEqual({ kids: '1 free', addOns: {} });
    expect(panel(thai)).toContain('฿300 each · 1 free');
  });

  it('says nothing is free on a ticket with no free items', () => {
    const line = cartLine({ ticketType: { ...ticket, freebies: [] }, tier: 'tourist', kids: 1, adults: 2 });
    expect(lineFreeNotes(line)).toEqual({ addOns: {} });
    expect(panel(line)).not.toContain('free');
  });
});

describe('s768 — a drop-off or nanny child’s own panel', () => {
  const noop = () => undefined;
  const nannyChild = (): CartLine => {
    const base = cartLine({ tier: 'thai', kids: 1, addOns: [grip(2)] });
    return {
      ...base,
      dropOff: {
        registrationId: 'reg-768',
        checkInId: 'stay-768',
        childName: 'ZZ TEST Mint',
        childAge: 6,
        service: 'nanny',
        hours: 2,
        lengthChosen: true,
        nannyId: 'nanny-768',
        nannyName: 'Pim',
        serviceFeeTHB: 0,
      },
    };
  };

  it('charges the add-on less its free unit, as the order panel does', () => {
    const line = nannyChild();
    expect(lineExtrasCharge(line, 50)).toEqual({
      socks: { amount: 0, free: 0 },
      addOns: [{ amount: 90, free: 1 }],
      total: 90,
    });
    const subtotal = priceForTier(ticket, 'thai') + 90;
    const config = renderToStaticMarkup(
      createElement(DropOffLineConfig, {
        line,
        tier: 'thai',
        cartNannyLoads: {},
        roster: [],
        onUpdate: noop,
        onUpdateExtras: noop,
        onAssignNannyToAll: noop,
        onBackToGrid: noop,
        onDone: noop,
      }),
    );
    expect(config).toContain(' · 1 free');
    expect(config).toContain('฿90</span>');
    expect(config).toContain(`฿${subtotal}</span>`);
    expect(config).not.toContain('฿180');

    const panel = renderToStaticMarkup(
      createElement(OrderSummary, {
        tier: 'thai',
        lines: [line],
        discounts: [],
        manualDiscounts: [],
        onUpdateLine: noop,
        onRemoveLine: noop,
        onRemoveDiscount: noop,
        onAddManualDiscount: noop,
        onRemoveManualDiscount: noop,
        onPay: noop,
        onCancel: noop,
        canPay: true,
      }),
    );
    expect(panel).toContain(`฿${subtotal}`);
  });
});

describe('s768 — a held sale resumed after a reload', () => {
  const ledgerRow = (
    over: Partial<ApiSaleLine> & Pick<ApiSaleLine, 'kind' | 'quantity' | 'unitSatang' | 'label'>,
  ): ApiSaleLine => ({
    id: `row-${over.kind}-${over.label}`,
    lineNo: 1,
    cartLineId: 'line-768',
    componentKey: null,
    ticketPackageId: ticket.id,
    revenueCategory: 'tickets',
    taxableCategory: 'tickets',
    baseSatang: over.unitSatang * over.quantity,
    discountSatang: 0,
    netSatang: over.unitSatang * over.quantity,
    serviceChargeSatang: 0,
    taxSatang: 0,
    taxMode: 'inclusive',
    taxRateBp: 700,
    taxName: 'VAT',
    grossSatang: over.unitSatang * over.quantity,
    customerTier: 'thai',
    kidCount: 0,
    adultCount: 0,
    freeAdultCount: 0,
    stayHours: 2,
    stayDurationLabel: '2 hours',
    ...over,
  });
  const resumed = (lines: ApiSaleLine[]): ApiSaleDetail => ({
    sale: {
      id: 'sale-768', branchId: 'branch-1', stationId: 'station-1', memberId: null, visitId: null,
      businessDate: '2026-11-05', occurredAt: '2026-11-05T03:10:00.000Z', status: 'tendering',
      pricingMode: 'weekday', pricingModeReason: 'Weekday pricing', customerTier: 'thai', engineVersion: 'engine-1',
      receiptNumber: null, receiptSeries: null, receiptSeq: null, finalisedAt: null, note: null,
      totals: {
        subtotalSatang: 0, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0,
        netSatang: 0, serviceChargeSatang: 0, taxInclusiveSatang: 0, taxExclusiveSatang: 0,
        grossSatang: 0, unappliedDiscountSatang: 0, refundedSatang: 0,
      },
    },
    taxBreakdown: null,
    lines,
    discounts: [],
    attempts: [],
  });
  const gripAddOn: AddOn = { id: GRIP, name: 'Grip Socks', price: { weekday: 90, weekend: 90 } };
  const catalogue = { ticketTypes: [ticket], addOns: [gripAddOn], discountByCode: () => null };
  const rows = (line: CartLine) => computeLineBreakdown(line, 'weekday').map((r) => [r.label, r.quantity, r.subtotal]);

  it('puts a free add-on’s two rows back as one add-on, and shows the same rows as the fresh sale', () => {
    const fresh = cartLine({ tier: 'thai', kids: 2, addOns: [grip(2)] });
    const detail = resumed([
      ledgerRow({ kind: 'kids', quantity: 1, unitSatang: 30_000, label: 'Kids' }),
      ledgerRow({ kind: 'kids', quantity: 1, unitSatang: 0, label: 'Kids (free)' }),
      ledgerRow({ kind: 'addon', quantity: 1, unitSatang: 9_000, label: 'Grip Socks', componentKey: GRIP }),
      ledgerRow({ kind: 'addon', quantity: 1, unitSatang: 0, label: 'Grip Socks (free)', componentKey: GRIP }),
    ]);
    const [line] = rebuildResumedSale(detail, catalogue)!.lines;
    expect(line!.addOns).toEqual([{ id: GRIP, name: 'Grip Socks', price: 90, quantity: 2 }]);
    expect(line!.kids).toBe(2);
    expect(rows(line!)).toEqual(rows(fresh));
    expect(computeLineTotal(line!, 'weekday')).toBe(fresh.lineTotal);
    expect(line!.lineTotal).toBe(fresh.lineTotal);
  });

  it('puts a sized free add-on’s sizes back in the order staff added them', () => {
    const sized: SelectedAddOn = {
      ...grip(3),
      variantBreakdown: [
        { variantId: 'v-s', variantLabel: 'S', quantity: 1 },
        { variantId: 'v-m', variantLabel: 'M', quantity: 2 },
      ],
    };
    const fresh = cartLine({ tier: 'thai', kids: 1, addOns: [sized] });
    const detail = resumed([
      ledgerRow({ kind: 'kids', quantity: 1, unitSatang: 30_000, label: 'Kids' }),
      ledgerRow({
        kind: 'addon', quantity: 2, unitSatang: 9_000, label: 'Grip Socks (2×M)', componentKey: GRIP,
        variantBreakdown: [{ variantId: 'v-m', variantLabel: 'M', quantity: 2 }],
      }),
      ledgerRow({
        kind: 'addon', quantity: 1, unitSatang: 0, label: 'Grip Socks (1×S) (free)', componentKey: GRIP,
        variantBreakdown: [{ variantId: 'v-s', variantLabel: 'S', quantity: 1 }],
      }),
    ]);
    const [line] = rebuildResumedSale(detail, catalogue)!.lines;
    expect(line!.addOns).toEqual([
      { id: GRIP, name: 'Grip Socks', price: 90, quantity: 3, variantBreakdown: sized.variantBreakdown },
    ]);
    expect(rows(line!)).toEqual(rows(fresh));
  });
});
