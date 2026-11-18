import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MobilePartyPayment } from '@/components/mobile/parties/MobilePartyPayment';
import { AdditionalBillSummary } from '@/components/parties/AdditionalBillSummary';
import { PartyBalanceModal } from '@/components/parties/PartyBalanceModal';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import type { PartyBooking } from '@/types';
import { renderHook } from './support/hooks';
import { billTwo, settledParty as settled } from './support/party-additional-bills';

/**
 * SCRUM-1001 (the till's half) — ON BOTH TILLS, THE PAYMENT STEP AND THE
 * CUSTOMER'S VIEW HOLD THE CHOSEN ADDITIONAL BILL ONLY.
 *
 * Before: the counter's payment step read "Package total ฿0 · Added on the day
 * · Extra F&B · Deposit paid −฿0", the phone's "Package total ฿0 · Extra F&B
 * charges · Deposit paid −฿0", and each customer view put the bill's name
 * where the package goes, at ฿0, over "Less deposit paid −฿0". Now both
 * payment steps draw one summary (`AdditionalBillSummary`: the bill's name,
 * its lines, Total, what was paid on it, Outstanding), and both customer views
 * get the bill under its name (`billName`) — what that screen shows is
 * `s1001-additional-bill-payer-view.test.ts`. A party with no additional
 * bills keeps the tab's summary as before.
 */

Object.assign(globalThis, { React });
const seam = vi.hoisted(() => ({ options: {} as { additionalBillId?: string; amount?: number } }));
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  const hooks = await import('./support/hooks');
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useEffect: hooks.useEffect, useCallback: hooks.useCallback };
});
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
// The counter's split view shows its customer half, as on a counter with the display beside it.
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['light', () => undefined] }));
vi.mock('@/lib/tenderDisplay', () => ({ useTenderPresentation: () => undefined }));
vi.mock('@/lib/usePartyTender', () => ({ usePartyTender: (options: typeof seam.options) => { seam.options = options; return { locked: false, display: null }; }, partyTenderShown: (_: unknown, amount: number, method: string) => ({ amount, method }) }));
vi.mock('@/lib/payments', () => ({ getEnabledPaymentMethods: () => [{ id: 'cash', kind: 'cash', label: 'Cash' }], paymentMethodLabel: () => 'Cash', paymentMethodKind: () => 'cash', paymentMethodIcon: () => () => null }));

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(value: React.ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...nodes(value.props.children as React.ReactNode)];
}
const elementOf = (tree: React.ReactNode, type: unknown) => nodes(tree).find((node) => node.type === type);
const tabSummary = (tree: React.ReactNode) => nodes(tree).some((node) => node.props.children === 'Package total');
const desk = (value: PartyBooking) => ({ open: true, onOpenChange: vi.fn(), party: value, operatorName: 'ZZ TEST staff', onConfirm: vi.fn() });
const phone = (value: PartyBooking) => ({ party: value, operatorName: 'ZZ TEST staff', onConfirm: vi.fn(), onBack: vi.fn() });

describe('SCRUM-1001 — the payment step and the customer’s view hold the chosen bill only, on both tills', () => {
  it('the counter till: its summary is the bill’s own, and its customer half is that bill under its name', () => {
    const view = renderHook((value: ReturnType<typeof desk>) => PartyBalanceModal(value), desk(settled));
    expect(elementOf(view.result.current, AdditionalBillSummary)!.props).toMatchObject({ bill: billTwo, name: 'Additional bill 2' });
    // The tab's summary (Package total, Deposit paid) is not drawn beside it.
    expect(tabSummary(view.result.current)).toBe(false);
    const customer = elementOf(view.result.current, PartySettlementCustomerScreen)!;
    expect(customer.props.billName).toBe('Additional bill 2');
    const shown = customer.props.party as PartyBooking;
    expect(shown).toMatchObject({ basePrice: 0, deposit: 0, availableDeposit: 0, lineItems: [] });
    expect(shown.partyExtraCharges.map((c) => c.id)).toEqual(['charge-b']);
    expect(shown.partyPayments).toEqual([]);
    view.unmount();
  });

  it('the phone till: the same summary, and the bill it hands the customer is that bill under its name', () => {
    const view = renderHook((value: ReturnType<typeof phone>) => MobilePartyPayment(value), phone(settled));
    expect(elementOf(view.result.current, AdditionalBillSummary)!.props).toMatchObject({ bill: billTwo, name: 'Additional bill 2' });
    expect(tabSummary(view.result.current)).toBe(false);
    (nodes(view.result.current).find((node) => node.props.className === 'h-14 flex-col gap-1')!.props.onClick as () => void)();
    const show = nodes(view.result.current).find((node) => Array.isArray(node.props.children) && node.props.children.some((child) => typeof child === 'string' && child.startsWith('Show bill')))!;
    (show.props.onClick as () => void)();
    const customer = elementOf(view.result.current, PartySettlementCustomerScreen)!;
    expect(customer.props.billName).toBe('Additional bill 2');
    expect((customer.props.party as PartyBooking).partyExtraCharges.map((c) => c.id)).toEqual(['charge-b']);
    expect(customer.props.amount).toBe(7.05);
    expect(seam.options).toMatchObject({ additionalBillId: billTwo.id, amount: 7.05 });
    view.unmount();
  });

  it('a party with no additional bills keeps the tab’s summary and its customer view as before', () => {
    const legacy = { ...settled, additionalBills: [], settlement: undefined } as unknown as PartyBooking;
    const counter = renderHook((value: ReturnType<typeof desk>) => PartyBalanceModal(value), desk(legacy));
    expect(elementOf(counter.result.current, AdditionalBillSummary)).toBeUndefined();
    expect(tabSummary(counter.result.current)).toBe(true);
    expect(elementOf(counter.result.current, PartySettlementCustomerScreen)!.props.billName).toBeUndefined();
    counter.unmount();
    const mobile = renderHook((value: ReturnType<typeof phone>) => MobilePartyPayment(value), phone(legacy));
    expect(elementOf(mobile.result.current, AdditionalBillSummary)).toBeUndefined();
    expect(tabSummary(mobile.result.current)).toBe(true);
    mobile.unmount();
  });
});
