import { additionalBillParty } from '@/lib/partyAdditionalBills';
import { computePartyTotal } from '@/lib/party';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MobilePartyPayment } from '@/components/mobile/parties/MobilePartyPayment';
import { PartyBalanceModal } from '@/components/parties/PartyBalanceModal';
import type { PartyBooking } from '@/types';
import type { PartyAdditionalBill } from '@oto/shared';
import { renderHook } from './support/hooks';
Object.assign(globalThis, { React });
const seam = vi.hoisted(() => ({ options: {} as { additionalBillId?: string; amount?: number } }));
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  const hooks = await import('./support/hooks');
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useEffect: hooks.useEffect, useCallback: hooks.useCallback };
});
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [false, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['dark', () => undefined] }));
vi.mock('@/lib/tenderDisplay', () => ({ useTenderPresentation: () => undefined }));
vi.mock('@/lib/usePartyTender', () => ({ usePartyTender: (options: typeof seam.options) => { seam.options = options; return { locked: false, display: null }; }, partyTenderShown: (_: unknown, amount: number, method: string) => ({ amount, method }) }));
vi.mock('@/lib/payments', () => ({ getEnabledPaymentMethods: () => [{ id: 'cash', kind: 'cash', label: 'Cash' }], paymentMethodLabel: () => 'Cash', paymentMethodKind: () => 'cash', paymentMethodIcon: () => () => null }));
const bill = (id: string, owed: number): PartyAdditionalBill => ({ id, eventId: 'party', mainSettlementId: 'main', totalSatang: owed, paidSatang: 0, outstandingSatang: owed, state: owed > 0 ? 'open' : 'paid', charges: [], payments: [], createdAt: '2026-11-16T00:00:00Z', paidAt: null });
const party = (id: string, bills: PartyAdditionalBill[]) => ({ id, title: id, basePrice: 0, deposit: 0, lineItems: [], partyExtraCharges: [], partyPayments: [], additionalBills: bills }) as unknown as PartyBooking;
type Node = React.ReactElement<Record<string, unknown>>;
function nodes(value: React.ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...nodes(value.props.children as React.ReactNode)];
}
const selected = (tree: React.ReactNode) => nodes(tree).find((node) => node.props.id === 'additional-party-bill')!.props.value;
const partial = (tree: React.ReactNode) => nodes(tree).find((node) => node.props.children === 'Partial amount')!;
const props = (value: PartyBooking, open = true) => ({ open, onOpenChange: vi.fn(), party: value, operatorName: 'ZZ TEST staff', onConfirm: vi.fn() });

describe('SCRUM-990 additional-bill payment component review', () => {
  it('reopens on the new open bill and changes party without retaining a paid or foreign selection', () => {
    const one = party('party-one', [bill('bill-one', 100)]);
    const view = renderHook((value: ReturnType<typeof props>) => PartyBalanceModal(value), props(one));
    expect(selected(view.result.current)).toBe('bill-one');
    view.rerender(props(one, false));
    view.rerender(props(party('party-one', [bill('bill-one', 0), bill('bill-two', 200)])));
    expect(selected(view.result.current)).toBe('bill-two');
    view.rerender(props(party('party-two', [bill('different-party-bill', 300)])));
    expect(selected(view.result.current)).toBe('different-party-bill');
    view.unmount();
  });
  it('offers decimal partial amounts and freezes the final-satang bill while collection is open', () => {
    const one = party('party-one', [bill('bill-one', 1)]);
    const view = renderHook((value: ReturnType<typeof props>) => PartyBalanceModal(value), props(one));
    (partial(view.result.current).props.onClick as () => void)();
    const input = nodes(view.result.current).find((node) => node.props.type === 'number')!;
    expect(input.props).toMatchObject({ inputMode: 'decimal', min: 0.01, step: 0.01 });
    (input.props.onChange as (event: unknown) => void)({ target: { value: '0.01' } });
    const cash = nodes(view.result.current).find((node) => node.props.className === 'h-14 flex-col gap-1')!;
    (cash.props.onClick as () => void)();
    const take = nodes(view.result.current).find((node) => typeof node.props.children === 'string' && node.props.children.startsWith('Take '))!;
    expect(take.props.disabled).toBe(false);
    (take.props.onClick as () => void)();
    expect(seam.options).toMatchObject({ additionalBillId: 'bill-one', amount: 0.01 });
    view.rerender(props(party('party-one', [bill('bill-one', 0), bill('bill-two', 10000)])));
    expect(seam.options).toMatchObject({ additionalBillId: 'bill-one', amount: 0.01 });
    view.unmount();
  });
  it('projects only the selected bill on the customer display, leaving original package add-ons outside it', () => {
    const source = { ...party('party', [bill('bill-one', 1)]), basePrice: 500, lineItems: [{ id: 'old-main-addon', name: 'Original package extra', qty: 2, price: 100 }], partyExtraCharges: [{ id: 'new-charge', total: 0.01 }] } as unknown as PartyBooking;
    source.additionalBills![0]!.charges = [{ id: 'new-charge' } as PartyAdditionalBill['charges'][number]];
    const shown = additionalBillParty(source, 'bill-one');
    expect(shown.lineItems).toEqual([]);
    expect(shown.packageName).toBe('Additional bill bill-one');
    expect(computePartyTotal(shown)).toBe(0.01);
    expect(source.lineItems).toHaveLength(1);
  });
  it('keeps legacy unassigned-tab partial controls in whole baht', () => {
    const old = { ...party('legacy', []), basePrice: 100 };
    const view = renderHook((value: ReturnType<typeof props>) => PartyBalanceModal(value), props(old));
    (partial(view.result.current).props.onClick as () => void)();
    expect(nodes(view.result.current).find((node) => node.props.type === 'number')!.props).toMatchObject({ inputMode: 'numeric', min: 1, step: 1 });
    view.unmount();
  });
});


describe('SCRUM-990 mobile additional-bill compatibility', () => {
  it('selects an open bill and retains its final-satang target through cash retry and party refresh', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ recorded: false, retry: true });
    const make = (value: PartyBooking) => ({ party: value, operatorName: 'ZZ TEST staff', onConfirm, onBack: vi.fn() });
    const view = renderHook((value: ReturnType<typeof make>) => MobilePartyPayment(value), make(party('mobile', [bill('bill-one', 1), bill('bill-two', 200)])));
    expect(selected(view.result.current)).toBe('bill-one');
    const select = nodes(view.result.current).find((node) => node.props.id === 'additional-party-bill')!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: 'bill-two' } });
    expect(selected(view.result.current)).toBe('bill-two');
    (select.props.onChange as (event: unknown) => void)({ target: { value: 'bill-one' } });
    (partial(view.result.current).props.onClick as () => void)();
    const input = nodes(view.result.current).find((node) => node.props.type === 'number')!;
    expect(input.props).toMatchObject({ inputMode: 'decimal', min: 0.01, step: 0.01 });
    (input.props.onChange as (event: unknown) => void)({ target: { value: '0.01' } });
    (nodes(view.result.current).find((node) => node.props.className === 'h-14 flex-col gap-1')!.props.onClick as () => void)();
    const take = nodes(view.result.current).find((node) => Array.isArray(node.props.children) && node.props.children.some((child) => typeof child === 'string' && child.startsWith('Show bill')))!;
    (take.props.onClick as () => void)();
    expect(seam.options).toMatchObject({ additionalBillId: 'bill-one', amount: 0.01 });
    (nodes(view.result.current).find((node) => typeof node.props.onDone === 'function')!.props.onDone as () => void)();
    const received = () => nodes(view.result.current).find((node) => Array.isArray(node.props.children) && node.props.children.includes('Payment received'))!;
    await (received().props.onClick as () => Promise<void>)();
    await Promise.resolve();
    view.rerender(make(party('mobile', [bill('bill-one', 0), bill('bill-two', 200)])));
    expect(seam.options).toMatchObject({ additionalBillId: 'bill-one', amount: 0.01 });
    await (received().props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm.mock.calls.every((call) => call[0] === 0.01 && call[2] === 0.01 && call[4] === 'bill-one')).toBe(true);
    view.unmount();
  });
  it('keeps legacy mobile tab amounts in whole baht', () => {
    const view = renderHook(() => MobilePartyPayment({ party: { ...party('legacy', []), basePrice: 100 }, operatorName: 'staff', onConfirm: vi.fn(), onBack: vi.fn() }));
    (partial(view.result.current).props.onClick as () => void)();
    expect(nodes(view.result.current).find((node) => node.props.type === 'number')!.props).toMatchObject({ inputMode: 'numeric', min: 1, step: 1 });
    view.unmount();
  });
});
