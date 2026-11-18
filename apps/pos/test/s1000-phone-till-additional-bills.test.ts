import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MobilePartyPayment } from '@/components/mobile/parties/MobilePartyPayment';
import { PartyBalanceModal } from '@/components/parties/PartyBalanceModal';
import { computePartyOutstanding, computePartyTotal, partyExtraChargeGroups } from '@/lib/party';
import { additionalBillChoices, additionalBillName, additionalBillParty } from '@/lib/partyAdditionalBills';
import type { PartyBooking } from '@/types';
import { renderHook } from './support/hooks';
import { billOne, billTwo, settledParty as settled } from './support/party-additional-bills';

/**
 * SCRUM-1000 — THE PHONE TILL'S ADDITIONAL BILLS, AS THE COUNTER TILL HAS THEM.
 *
 * Found on staging (18 November, proof-2026-11-18/SCRUM-990): on the phone till
 * "Older unassigned tab" stayed selectable while an additional bill was open
 * (the counter greys it out); chosen and paid in cash, the customer was shown
 * "Outstanding due now 7.049999999999997" and the platform then refused the
 * payment ("Choose the additional bill to pay"); and every bill was named
 * "Additional bill 48073b00" — the start of its reference, which is the
 * party's own and so the same for each bill of one party.
 *
 *   - both tills draw "Bill to collect" from one list (`additionalBillChoices`):
 *     the same options, the same disabled ones, the same words;
 *   - a bill is named by its number ("Additional bill 2"), from
 *     `additionalBillName`;
 *   - the party's sums are taken in satang (`lib/party.ts`), so ฿32.08 less
 *     ฿25.03 is ฿7.05 — the source of the float, not only its label (the label
 *     is `s1000-customer-bill-money.test.ts`).
 */

Object.assign(globalThis, { React });
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  const hooks = await import('./support/hooks');
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useEffect: hooks.useEffect, useCallback: hooks.useCallback };
});
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
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
const options = (tree: React.ReactNode) =>
  nodes(tree).filter((node) => node.type === 'option').map((node) => ({ value: node.props.value, disabled: node.props.disabled, label: node.props.children }));
const desk = (value: PartyBooking) => ({ open: true, onOpenChange: vi.fn(), party: value, operatorName: 'ZZ TEST staff', onConfirm: vi.fn() });
const phone = (value: PartyBooking) => ({ party: value, operatorName: 'ZZ TEST staff', onConfirm: vi.fn(), onBack: vi.fn() });

describe('SCRUM-1000 — one "Bill to collect" list on both tills', () => {
  it('the older tab cannot be chosen while a bill is open; a paid bill is listed, by number, and cannot be chosen', () => {
    expect(additionalBillChoices([billOne, billTwo])).toEqual([
      { value: '', label: 'Older unassigned tab balance', disabled: true },
      { value: billOne.id, label: 'Additional bill 1 - paid - THB 0 outstanding', disabled: true },
      { value: billTwo.id, label: 'Additional bill 2 - open - THB 7.05 outstanding', disabled: false },
    ]);
    // Every bill paid: the older tab is the one choice left, as on the counter.
    expect(additionalBillChoices([billOne]).map((choice) => choice.disabled)).toEqual([false, true]);
  });

  it('the phone till offers exactly the counter till’s choices — values, disabled state and words', () => {
    const counter = renderHook((value: ReturnType<typeof desk>) => PartyBalanceModal(value), desk(settled));
    const mobile = renderHook((value: ReturnType<typeof phone>) => MobilePartyPayment(value), phone(settled));
    const choices = options(counter.result.current);
    expect(choices).toEqual(options(mobile.result.current));
    expect(choices).toEqual(additionalBillChoices(settled.additionalBills).map((c) => ({ value: c.value, disabled: c.disabled, label: c.label })));
    // The older tab is greyed out on the phone too, where it was selectable.
    expect(options(mobile.result.current)[0]).toMatchObject({ value: '', disabled: true });
    // Both open on the open bill.
    for (const view of [counter, mobile]) {
      expect(nodes(view.result.current).find((node) => node.props.id === 'additional-party-bill')!.props.value).toBe(billTwo.id);
    }
    counter.unmount();
    mobile.unmount();
  });

  it('two bills of one party never read alike: named by number, not by the party’s reference', () => {
    expect(billOne.id.slice(0, 8)).toBe(billTwo.id.slice(0, 8));
    expect(additionalBillName(settled.additionalBills, billOne.id)).toBe('Additional bill 1');
    expect(additionalBillName(settled.additionalBills, billTwo.id)).toBe('Additional bill 2');
    expect(additionalBillName(settled.additionalBills, 'not-a-bill')).toBeNull();
    expect(additionalBillName(settled.additionalBills, undefined)).toBeNull();
    expect(additionalBillParty(settled, billTwo.id).packageName).toBe('Additional bill 2');
    for (const choice of additionalBillChoices(settled.additionalBills)) expect(choice.label).not.toContain(billOne.id.slice(0, 8));
  });
});

describe('SCRUM-1000 — amounts are money: summed in satang at the source', () => {
  it('a tab of ฿32.08 less ฿25.03 paid owes exactly ฿7.05, never 7.049999999999997', () => {
    const tab = { ...settled, basePrice: 0, deposit: 0, lineItems: [] } as PartyBooking;
    expect(32.08 - 25.03).not.toBe(7.05); // the float the customer was shown
    expect(computePartyTotal(tab)).toBe(32.08);
    expect(computePartyOutstanding(tab)).toBe(7.05);
    expect(computePartyOutstanding(additionalBillParty(settled, billTwo.id))).toBe(7.05);
    expect(computePartyTotal(additionalBillParty(settled, billOne.id))).toBe(25.03);
  });

  it('kind groups and their adjustments are exact to the satang too', () => {
    const odd = { ...settled, partyExtraCharges: [
      { id: 'x', kind: 'fnb', items: [{ name: 'a', qty: 1, lineTotal: 0.1 }, { name: 'b', qty: 1, lineTotal: 0.2 }], total: 0.3, chargedBy: '', chargedById: '', chargedAt: '' },
    ] } as unknown as PartyBooking;
    const [group] = partyExtraChargeGroups(odd);
    expect(group).toMatchObject({ itemsTotal: 0.3, total: 0.3, adjustment: 0 });
  });
});
