import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSaleDetail, ApiSaleLine } from '@/api/history';
import { buildCartPayload, localQuote, type CartIdentity } from '@/api/sales';
import { rebuildResumedSale } from '@/lib/resumeSale';
import { EXTRA_CREDIT_NEEDS_INTERNET, finaliseOnBox, rungUpOnBox } from '@/api/boxSales';
import { OrderSummary } from '@/components/till/OrderSummary';
import { EXTRA_CREDIT_STEP_THB as FORM_STEP_THB } from '@/components/till/PublicConsentCapture';
import { DICTIONARY } from '@/i18n/dictionary';
import { platformId } from '@/lib/cartWire';
import {
  EXTRA_CREDIT_MAX_THB,
  EXTRA_CREDIT_STEP_THB,
  extraCreditAmount,
  followTickets,
  takesExtraCredit,
  withExtraCredit,
} from '@/lib/extraCredit';
import { ticketDisplayPresentation } from '@/lib/displaySession';
import { computeLineTotal } from '@/lib/pricing';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
beforeEach(() => { vi.stubGlobal('React', React); });
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * SCRUM-1048 — EXTRA FOOD CREDIT ON ANY CHILD TICKET, AS ITS OWN LINE ON THE
 * ORDER (the owner's answer of 19 November 2026). Staff add it on the till
 * for one child on an ordinary ticket line: which child, and how much, in the
 * drop-off form's 50 baht steps. It is its own line on the order, on the
 * customer display and on the wire (`creditFor`), it follows its ticket, and
 * it is never sold through the counter box, whose copy of a cart cannot say
 * which child it is for.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const byTestId = (tree: unknown, id: string) => elements(tree).find((el) => el.props['data-testid'] === id);

const oneHour = getTicketTypes().find((ticket) => ticket.id === 't-1h')!;

function ticketLine(id: string, kids = 2, adults = 1): CartLine {
  const priced = { ticketType: oneHour, tier: 'tourist', kids, adults, socks: 0, addOns: [] };
  return { id, ...priced, lineTotal: computeLineTotal(priced) };
}

let minted = 0;
const mint = () => `zz-credit-${++minted}`;

describe('SCRUM-1048 (1): the extra credit line', () => {
  it('is its own line after its ticket: nobody on it, the ticket’s own package, its total the amount', () => {
    const ticket = ticketLine('zz-ticket');
    const other = ticketLine('zz-other', 1);
    const lines = withExtraCredit([ticket, other], 'zz-ticket', 1, 300, mint);
    expect(lines.map((l) => l.id)).toEqual(['zz-ticket', 'zz-credit-1', 'zz-other']);
    expect(lines[1]).toMatchObject({
      ticketType: oneHour, tier: 'tourist', kids: 0, adults: 0, socks: 0, addOns: [], lineTotal: 300,
      extraCredit: { forLineId: 'zz-ticket', kidOrdinal: 1, amountTHB: 300 },
    });
    // A second child's goes after the first's, still before the next ticket.
    const two = withExtraCredit(lines, 'zz-ticket', 0, 100, mint);
    expect(two.map((l) => l.id)).toEqual(['zz-ticket', 'zz-credit-1', 'zz-credit-2', 'zz-other']);
  });

  it('one line per child: the same child again sets the amount, nought takes it off', () => {
    const lines = withExtraCredit([ticketLine('zz-ticket')], 'zz-ticket', 0, 300, mint);
    const set = withExtraCredit(lines, 'zz-ticket', 0, 500, mint);
    expect(set).toHaveLength(2);
    expect(set[1]).toMatchObject({ id: lines[1]!.id, lineTotal: 500, extraCredit: { amountTHB: 500 } });
    expect(withExtraCredit(set, 'zz-ticket', 0, 0, mint)).toHaveLength(1);
  });

  it('only on an ordinary ticket with that child on it, in the form’s steps and ceiling', () => {
    expect(EXTRA_CREDIT_STEP_THB).toBe(FORM_STEP_THB);
    expect(extraCreditAmount(320)).toBe(300);
    expect(extraCreditAmount(-50)).toBe(0);
    expect(extraCreditAmount(EXTRA_CREDIT_MAX_THB + 500)).toBe(EXTRA_CREDIT_MAX_THB);
    const adultsOnly = ticketLine('zz-adults', 0, 2);
    const dropOff = { ...ticketLine('zz-drop', 1, 0), dropOff: {} as CartLine['dropOff'] };
    const promo = { ...ticketLine('zz-promo', 0, 0), promoItem: { itemId: 'm', itemKind: 'menu' as const, name: 'Ice cream', priceTHB: 60 } };
    for (const line of [adultsOnly, dropOff, promo]) {
      expect(takesExtraCredit(line)).toBe(false);
      expect(withExtraCredit([line], line.id, 0, 300, mint)).toHaveLength(1);
    }
    expect(withExtraCredit([ticketLine('zz-ticket', 1)], 'zz-ticket', 1, 300, mint)).toHaveLength(1);
  });

  it('follows its ticket: gone with it, gone with its child, gone when the child is dropped off, restated with the rate', () => {
    const lines = withExtraCredit(withExtraCredit([ticketLine('zz-ticket')], 'zz-ticket', 0, 100, mint), 'zz-ticket', 1, 300, mint);
    expect(followTickets(lines)).toBe(lines);
    expect(followTickets(lines.filter((l) => l.id !== 'zz-ticket'))).toEqual([]);
    const fewer = lines.map((l) => (l.id === 'zz-ticket' ? { ...l, kids: 1 } : l));
    expect(followTickets(fewer).map((l) => l.extraCredit?.kidOrdinal ?? 'ticket')).toEqual(['ticket', 0]);
    const dropped = lines.map((l) => (l.id === 'zz-ticket' ? { ...l, dropOff: {} as CartLine['dropOff'] } : l));
    expect(followTickets(dropped)).toHaveLength(1);
    const expat = lines.map((l) => (l.id === 'zz-ticket' ? { ...l, tier: 'expat' } : l));
    expect(followTickets(expat).every((l) => l.tier === 'expat')).toBe(true);
    expect(followTickets(expat).filter((l) => l.extraCredit).map((l) => l.lineTotal)).toEqual([100, 300]);
  });
});

const identity: CartIdentity = { branchId: 'branch-1', stationId: 'station-1', tier: 'tourist', accountId: 'account-1', accountName: 'Reception' };

describe('SCRUM-1048 (2): on the wire and in the price', () => {
  it('goes to the platform as prepaid credit naming its child’s ticket line, priced at its amount', () => {
    const lines = withExtraCredit([ticketLine('zz-wire-ticket')], 'zz-wire-ticket', 1, 300, mint);
    const quote = localQuote(lines, [], []);
    const payload = buildCartPayload(lines, [], [], identity, quote.satang!);
    const [ticket, credit] = payload.lines;
    expect(credit).toMatchObject({
      id: platformId(lines[1]!.id), packageId: oneHour.id, kids: 0, adults: 0, socks: 0, addOns: [],
      foodProvision: { mode: 'prepaid_credit', paidSatang: 30_000 }, lineTotalSatang: 30_000,
      creditFor: { cartLineId: ticket!.id, kidOrdinal: 1 },
    });
    expect(ticket).not.toHaveProperty('creditFor');
    expect(quote.satang!.subtotal).toBe(lines[0]!.lineTotal * 100 + 30_000);
  });

  it('is never sold through the counter box: the box lane refuses it before the box is asked', async () => {
    const lines = withExtraCredit([ticketLine('zz-box-ticket')], 'zz-box-ticket', 0, 300, mint);
    const cart = buildCartPayload(lines, [], [], identity, localQuote(lines, [], []).satang!);
    const sale = { stationId: 'station-1', saleId: 'zz-sale', actionId: 'zz-action', occurredAt: new Date().toISOString(), cart, visitId: null, note: null };
    await expect(rungUpOnBox(sale)).rejects.toThrow(EXTRA_CREDIT_NEEDS_INTERNET);
    await expect(finaliseOnBox({ ...sale, lane: 'platform', answer: null }, undefined, 'zz-press')).rejects.toThrow(EXTRA_CREDIT_NEEDS_INTERNET);
    expect(EXTRA_CREDIT_NEEDS_INTERNET).toBe(
      'Extra food credit needs the internet — this counter is offline. Remove the food credit, or take the payment when the connection is back.',
    );
  });
});

function summaryProps(lines: CartLine[], onAddExtraCredit?: (id: string, kid: number, amount: number) => void) {
  return {
    tier: 'tourist', lines, discounts: [], manualDiscounts: [], onUpdateLine: () => {}, onRemoveLine: () => {},
    onRemoveDiscount: () => {}, onAddManualDiscount: () => {}, onRemoveManualDiscount: () => {}, onPay: () => {},
    onCancel: () => {}, canPay: true, ...(onAddExtraCredit ? { onAddExtraCredit } : {}),
  } as Parameters<typeof OrderSummary>[0];
}

describe('SCRUM-1048 (3): the order panel', () => {
  it('shows the line on the order as its own card: the child, the ticket and the amount', () => {
    const lines = withExtraCredit([ticketLine('zz-panel')], 'zz-panel', 1, 300, mint);
    const tree = renderHook(() => OrderSummary(summaryProps(lines))).result.current;
    const card = byTestId(tree, 'order-extra-credit')!;
    expect(words(card)).toBe(`Extra food creditKid 2 · ${oneHour.name}฿300`);
  });

  it('the card has the order’s own remove, on every lane: the credit comes off without its ticket', () => {
    // Pay on the box lane says "Remove the food credit": the card's own trash,
    // the corner button every order card has, takes off that line alone. It
    // does not depend on the "Add food credit" control, which the box lane hides.
    const lines = withExtraCredit([ticketLine('zz-remove')], 'zz-remove', 1, 300, mint);
    const credit = lines[1]!;
    for (const onAdd of [undefined, () => {}]) {
      const removed: string[] = [];
      const tree = renderHook(() => OrderSummary({ ...summaryProps(lines, onAdd), onRemoveLine: (id: string) => { removed.push(id); } })).result.current;
      const cardOf = elements(tree).find((el) => el.key === credit.id)!;
      expect(byTestId(cardOf, 'order-extra-credit')).toBeDefined();
      const trash = elements(cardOf).filter((el) => typeof el.props.onClick === 'function' && elements(el.props.children).some((c) => typeof c.type !== 'string' && /trash/i.test(String((c.type as { displayName?: string }).displayName ?? ''))));
      expect(trash).toHaveLength(1);
      (trash[0]!.props.onClick as () => void)();
      expect(removed).toEqual([credit.id]);
    }
    const till = readFileSync(path.join(import.meta.dirname, '..', 'src', 'components', 'till', 'OrderSummary.tsx'), 'utf8');
    expect(till).toContain('onClick={() => onRemoveLine(line.id)}');
  });

  it('offers "Add food credit" on a ticket with children only where the till passes the control', () => {
    const lines = [ticketLine('zz-offer'), ticketLine('zz-adults-only', 0, 2)];
    const adders = (tree: unknown) => elements(tree).filter((el) => typeof el.type === 'function' && el.type.name === 'ExtraCreditAdder');
    expect(adders(renderHook(() => OrderSummary(summaryProps(lines, () => {}))).result.current)).toHaveLength(1);
    expect(adders(renderHook(() => OrderSummary(summaryProps(lines))).result.current)).toHaveLength(0);
  });

  it('staff pick the child and the amount in 50 baht steps; the same child opens on what it has', () => {
    const added: [string, number, number][] = [];
    const lines = withExtraCredit([ticketLine('zz-pick')], 'zz-pick', 0, 100, mint);
    const tree = renderHook(() => OrderSummary(summaryProps(lines, (...args) => { added.push(args); }))).result.current;
    const adder = elements(tree).find((el) => typeof el.type === 'function' && el.type.name === 'ExtraCreditAdder')!;
    const view = renderHook((props: Record<string, unknown>) => (adder.type as (p: Record<string, unknown>) => unknown)(props), adder.props);
    const press = (id: string) => (byTestId(view.result.current, id)!.props.onClick as () => void)();
    press('extra-credit-open');
    // Kid 1 already has ฿100: the adder opens on it, as an update.
    expect(words(byTestId(view.result.current, 'extra-credit-amount'))).toBe('฿100');
    expect(words(byTestId(view.result.current, 'extra-credit-add'))).toBe('Update');
    press('extra-credit-kid-2');
    expect(words(byTestId(view.result.current, 'extra-credit-amount'))).toBe('฿0');
    expect(byTestId(view.result.current, 'extra-credit-add')!.props.disabled).toBe(true);
    for (let i = 0; i < 6; i += 1) press('extra-credit-more');
    press('extra-credit-less');
    expect(words(byTestId(view.result.current, 'extra-credit-amount'))).toBe('฿250');
    press('extra-credit-add');
    expect(added).toEqual([['zz-pick', 1, 250]]);
    expect(byTestId(view.result.current, 'extra-credit-adder')).toBeUndefined();
  });
});

describe('SCRUM-1048 (3b): a sale left unpaid and resumed', () => {
  const row = (over: Partial<ApiSaleLine> & Pick<ApiSaleLine, 'kind' | 'quantity' | 'unitSatang' | 'label' | 'cartLineId'>): ApiSaleLine => ({
    id: `row-${over.cartLineId}-${over.kind}`, lineNo: 1, componentKey: null, ticketPackageId: oneHour.id,
    revenueCategory: 'tickets', taxableCategory: 'tickets', baseSatang: over.unitSatang * over.quantity, discountSatang: 0,
    netSatang: over.unitSatang * over.quantity, serviceChargeSatang: 0, taxSatang: 0, taxMode: 'inclusive', taxRateBp: 700,
    taxName: 'VAT', grossSatang: over.unitSatang * over.quantity, customerTier: 'tourist', kidCount: 0, adultCount: 0,
    freeAdultCount: 0, stayHours: 1, stayDurationLabel: '1 hour', ...over,
  });

  it('comes back as its own extra credit line for the same child, not as a supervised child', () => {
    const ticketId = '0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01';
    const creditId = '0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02';
    const detail = {
      sale: { id: 'zz-resumed', branchId: 'branch-1', stationId: 'station-1', memberId: null, visitId: null, businessDate: '2026-11-19',
        occurredAt: '2026-11-19T03:10:00.000Z', status: 'tendering', pricingMode: 'weekday', pricingModeReason: 'Weekday pricing',
        customerTier: 'tourist', engineVersion: 'engine-1', receiptNumber: null, receiptSeries: null, receiptSeq: null, finalisedAt: null, note: null,
        totals: { subtotalSatang: 0, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0, netSatang: 0, serviceChargeSatang: 0,
          taxInclusiveSatang: 0, taxExclusiveSatang: 0, grossSatang: 0, unappliedDiscountSatang: 0, refundedSatang: 0 } },
      taxBreakdown: null,
      lines: [
        row({ cartLineId: ticketId, kind: 'kids', quantity: 2, unitSatang: 39_000, label: 'Kids' }),
        row({ cartLineId: ticketId, kind: 'adults_paid', quantity: 1, unitSatang: 0, label: 'Adults' }),
        row({ cartLineId: creditId, kind: 'food_provision', quantity: 1, unitSatang: 30_000, label: 'Prepaid food',
          taxableCategory: 'stored_value', revenueCategory: 'stored_value', creditFor: { cartLineId: ticketId, kidOrdinal: 1 } }),
      ],
      discounts: [], attempts: [],
    } as unknown as ApiSaleDetail;
    const rebuilt = rebuildResumedSale(detail, { ticketTypes: [oneHour], addOns: [], discountByCode: () => null })!;
    expect(rebuilt.supervised).toBe(false);
    const credit = rebuilt.lines.find((l) => l.id === creditId)!;
    expect(credit).toMatchObject({ kids: 0, adults: 0, lineTotal: 300, extraCredit: { forLineId: ticketId, kidOrdinal: 1, amountTHB: 300 } });
    expect(followTickets(rebuilt.lines)).toBe(rebuilt.lines);
  });
});

describe('SCRUM-1048 (4): the customer display', () => {
  const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', 'src', file), 'utf8');

  it('a separate display gets the line in the drop-off form’s words, every language, no rows', () => {
    const lines = withExtraCredit([ticketLine('zz-display')], 'zz-display', 0, 300, mint);
    const sale = { id: 'zz-sale', operatorId: '', operatorName: '', tier: 'tourist', lines, manualDiscounts: [],
      total: lines[0]!.lineTotal + 300, creditGrants: [], bracelets: { adults: 1, children: 2 } };
    const shown = ticketDisplayPresentation({ stage: 'tickets', sale, nickname: '', rateMode: 'weekday' } as never, 'zz-request') as unknown as {
      cart: { sale: { lines: { name: string; translations?: Record<string, string>; lineTotal: number; breakdown: { rows: unknown[] } }[] } };
    };
    const words = DICTIONARY['superviseConsent.extraFoodCredit']!;
    expect(shown.cart.sale.lines[1]).toMatchObject({
      name: words.en, translations: { th: words.th, zh: words.zh, ru: words.ru, fr: words.fr }, lineTotal: 300, breakdown: { rows: [] },
    });
  });

  it('the till’s own display half shows it as its own card in those words', () => {
    const display = read('components/till/CustomerDisplay.tsx');
    expect(display).toContain('data-testid="display-extra-credit"');
    expect(display).toContain("t('superviseConsent.extraFoodCredit')");
  });
});
