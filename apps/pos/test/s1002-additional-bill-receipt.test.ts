import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PartyAdditionalBill, PartyAdditionalBillReceipt } from '@oto/shared';
import { HandToCustomer } from '@/components/mobile/HandToCustomer';
import { MobilePartyPayment } from '@/components/mobile/parties/MobilePartyPayment';
import { AdditionalBillReceipt } from '@/components/parties/AdditionalBillReceipt';
import { PartyBalanceModal } from '@/components/parties/PartyBalanceModal';
import type { PartyBooking } from '@/types';
import { renderHook } from './support/hooks';
import { billOne, billTwo, settledParty as settled } from './support/party-additional-bills';

/**
 * SCRUM-1002 ruling 1 — AN ADDITIONAL BILL'S OWN RECEIPT, ON BOTH TILLS.
 *
 * The staging run of 18 November (proof-2026-11-18/SCRUM-990) ended both tills
 * on "Payment recorded" with no receipt for the bill. The platform now issues
 * one when the bill is paid in full and puts it on the bill (`receipt`: the
 * paper exactly as it printed). Where the tills say "Payment recorded" they now
 * show that receipt — its number, the bill's own lines, the VAT line, the total
 * and how it was paid — and nothing of the party's main bill. A part payment
 * leaves the bill open with no receipt, and the screen says only what it said.
 */

Object.assign(globalThis, { React });
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  const hooks = await import('./support/hooks');
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useEffect: hooks.useEffect, useCallback: hooks.useCallback };
});
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [false, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['light', () => undefined] }));
vi.mock('@/lib/tenderDisplay', () => ({ useTenderPresentation: () => undefined }));
vi.mock('@/lib/usePartyTender', () => ({ usePartyTender: () => ({ locked: false, display: null }), partyTenderShown: (_: unknown, amount: number, method: string) => ({ amount, method }) }));
vi.mock('@/lib/payments', () => ({ getEnabledPaymentMethods: () => [{ id: 'cash', kind: 'cash', label: 'Cash' }], paymentMethodLabel: () => 'Cash', paymentMethodKind: () => 'cash', paymentMethodIcon: () => () => null }));

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(value: React.ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...nodes(value.props.children as React.ReactNode)];
}
/** Every string the tree's own elements say (a component inside it is not rendered). */
function words(value: React.ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(words).join('');
  if (!React.isValidElement<Record<string, unknown>>(value)) return '';
  return words(value.props.children as React.ReactNode);
}
const elementOf = (tree: React.ReactNode, type: unknown) => nodes(tree).find((node) => node.type === type);
const pressNode = (tree: React.ReactNode, text: string) => {
  const node = nodes(tree).find((n) => typeof n.props.onClick === 'function' && words(n.props.children as React.ReactNode).includes(text));
  if (!node) throw new Error(`nothing to press says "${text}"`);
  (node.props.onClick as () => void)();
};

/** Bill 2 as the platform answers it once paid in full: its own receipt, as it printed. */
const receipt: PartyAdditionalBillReceipt = {
  saleId: 'receipt-sale', receiptNumber: 'T1-000091', saleStatus: 'finalised',
  document: {
    title: 'Receipt', receiptNumber: 'T1-000091', dateTime: '18/11/2026 17:05',
    lines: [{ qty: 1, name: 'ZZ TEST drink B', price: '฿7.05' }],
    subtotal: '฿7.05', vat: '฿0.46', total: '฿7.05',
    tenders: [{ label: 'Cash', amount: '฿7.05' }],
    taxRows: [{ label: 'VAT 7% (included)', amount: '฿0.46', kind: 'tax_included' }],
  },
};
const billTwoPaid: PartyAdditionalBill = {
  ...billTwo, state: 'paid', paidSatang: 705, outstandingSatang: 0, paidAt: '2026-11-18T12:15:00Z',
  payments: [{ additionalBillId: billTwo.id, id: 'pay-b', amountSatang: 705, method: 'cash', kind: 'cash', takenBy: null, takenById: null, takenAt: '2026-11-18T12:15:00Z' } as PartyAdditionalBill['payments'][number]],
  receipt,
};
const paidParty = { ...settled, additionalBills: [billOne, billTwoPaid] } as unknown as PartyBooking;
const partPaidParty = {
  ...settled,
  additionalBills: [billOne, { ...billTwo, paidSatang: 300, outstandingSatang: 405, receipt: null }],
} as unknown as PartyBooking;

const recorded = (amount: number) => vi.fn(async () => ({ recorded: true as const, amount }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SCRUM-1002 — an additional bill paid in full shows its own receipt where the tills say "Payment recorded"', () => {
  it('the receipt card: its number, the bill’s own lines, the VAT line, the total and how it was paid', () => {
    const said = words(AdditionalBillReceipt({ receipt, name: 'Additional bill 2' }));
    for (const part of ['Receipt T1-000091', 'Additional bill 2', '1 x ZZ TEST drink B', '฿7.05', 'VAT 7% (included)', '฿0.46', 'Total', 'Cash']) {
      expect(said).toContain(part);
    }
    // Nothing of the party's main bill.
    expect(said).not.toMatch(/T1-000089|Birthday Package|balloon|Deposit/);
  });

  it('the counter till: paid in full, "Payment recorded" with the bill’s receipt under it', async () => {
    const onConfirm = recorded(7.05);
    const view = renderHook((value: PartyBooking) => PartyBalanceModal({ open: true, onOpenChange: vi.fn(), party: value, operatorName: 'ZZ TEST staff', onConfirm }), settled);
    pressNode(view.result.current, 'Cash');
    pressNode(view.result.current, 'Take ฿7.05 by Cash');
    pressNode(view.result.current, 'Payment received');
    await settle();
    expect(onConfirm).toHaveBeenCalledWith(7.05, 'cash', 7.05, undefined, billTwo.id);
    // The till reads the party back from the platform's answer: bill 2 now paid, with its receipt.
    view.rerender(paidParty);
    const done = view.result.current;
    expect(words(done)).toContain('Payment recorded');
    expect(elementOf(done, AdditionalBillReceipt)!.props).toMatchObject({ receipt, name: 'Additional bill 2' });
    view.unmount();
  });

  it('the counter till: a part payment leaves the bill open and shows no receipt', async () => {
    const onConfirm = recorded(3);
    const view = renderHook((value: PartyBooking) => PartyBalanceModal({ open: true, onOpenChange: vi.fn(), party: value, operatorName: 'ZZ TEST staff', onConfirm }), settled);
    pressNode(view.result.current, 'Cash');
    pressNode(view.result.current, 'Take ฿7.05 by Cash');
    pressNode(view.result.current, 'Payment received');
    await settle();
    view.rerender(partPaidParty);
    expect(words(view.result.current)).toContain('Payment recorded');
    expect(elementOf(view.result.current, AdditionalBillReceipt)).toBeUndefined();
    view.unmount();
  });

  it('the phone till: paid in full, "Payment recorded" with the bill’s receipt under it', async () => {
    const onConfirm = recorded(7.05);
    const view = renderHook((value: PartyBooking) => MobilePartyPayment({ party: value, operatorName: 'ZZ TEST staff', onConfirm, onBack: vi.fn() }), settled);
    pressNode(view.result.current, 'Cash');
    pressNode(view.result.current, 'Show bill');
    // The customer has looked at the bill and hands the phone back.
    (elementOf(view.result.current, HandToCustomer)!.props.onDone as () => void)();
    pressNode(view.result.current, 'Payment received');
    await settle();
    expect(onConfirm).toHaveBeenCalledWith(7.05, 'cash', 7.05, undefined, billTwo.id);
    view.rerender(paidParty);
    expect(words(view.result.current)).toContain('Payment recorded');
    expect(elementOf(view.result.current, AdditionalBillReceipt)!.props).toMatchObject({ receipt, name: 'Additional bill 2' });
    view.unmount();
  });
});
