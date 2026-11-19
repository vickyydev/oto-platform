import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { PublicConsentCapture, mergeConsentDraft } from '@/components/till/PublicConsentCapture';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { consentSlotPatches } from '@/lib/consentForm';
import { asksOrderWithIncluded, ordersWithIncluded, showsOrderWithIncluded } from '@/lib/dropOffFoodCredit';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupervisionPolicy, TicketType } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')), useId: () => 'zz-1054' }));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) => vars ? `${key}:${Object.values(vars).join(',')}` : key }),
  tFor: () => (key: string, vars?: Record<string, string | number>) => vars ? `${key}:${Object.values(vars).join(',')}` : key,
}));
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-1054 — THE PARENT'S TICK: "MAY ORDER FOOD WITH THE INCLUDED CREDIT"
 * (the owner's answer of 19 November 2026, R3). A dropped-off or nanny child
 * on a ticket with food credit whose parent chose no extra food was "no
 * food" at the counter; the form now asks the parent one tick.
 *
 * - Shown on the customer display, on the till's own customer half and on
 *   the phone till's form, only while the ticket includes credit and no extra
 *   food is chosen; staff's copy shows it, ticked by the family.
 * - The family's tick comes back to the till with the step, and the till
 *   sends it on the registration; with extra food chosen, nothing changes.
 * - Not on the counter box's lane, whose registration does not know it.
 *
 * Demo data only: every name and number below is a ZZ TEST fixture.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const EAT_PLAY = {
  id: 'zz-eat-play', name: 'ZZ TEST Eat & Play', hours: 3,
  prices: { tourist: { weekday: 1300, weekend: 1300 } },
  creditRule: { appliesTo: 'both', basis: 'full_price' },
  gateAccess: true,
} as unknown as TicketType;

const slot = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id: 'zz-mint', sourceLineId: 'zz-line', ticketType: EAT_PLAY, name: 'ZZ TEST Mint', age: '6', waived: false,
  allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, ...extra,
});
const credited = (amount: number) => slot({ foodProvision: { mode: 'prepaid_credit', creditAmountTHB: amount, paidTHB: amount }, mayOrderFood: amount > 0 });
const items = slot({ foodProvision: { mode: 'prepaid_items', paidTHB: 180, items: [] }, mayOrderFood: true });

describe('SCRUM-1054 (1): when the form asks the tick, and what the registration says', () => {
  it('asked for a child whose ticket includes credit, wherever the family chooses the extra; never over prepaid items', () => {
    expect(asksOrderWithIncluded(slot(), 1300)).toBe(true);
    expect(asksOrderWithIncluded(credited(300), 1300)).toBe(true);
    expect(asksOrderWithIncluded(items, 1300)).toBe(false);
    expect(asksOrderWithIncluded(slot(), 0)).toBe(false);
  });

  it('shown only while no extra food is chosen', () => {
    expect(showsOrderWithIncluded(slot(), 1300)).toBe(true);
    expect(showsOrderWithIncluded(slot({ foodProvision: { mode: 'none', paidTHB: 0 } }), 1300)).toBe(true);
    expect(showsOrderWithIncluded(credited(0), 1300)).toBe(true);
    expect(showsOrderWithIncluded(credited(300), 1300)).toBe(false);
    expect(showsOrderWithIncluded(items, 1300)).toBe(false);
    expect(showsOrderWithIncluded(slot(), 0)).toBe(false);
  });

  it('the registration says it only when ticked and shown: extra food chosen changes nothing', () => {
    expect(ordersWithIncluded(slot({ orderWithIncludedCredit: true }), 1300)).toBe(true);
    expect(ordersWithIncluded(slot({ orderWithIncludedCredit: false }), 1300)).toBe(false);
    expect(ordersWithIncluded(slot(), 1300)).toBe(false);
    expect(ordersWithIncluded({ ...credited(300), orderWithIncludedCredit: true }, 1300)).toBe(false);
    expect(ordersWithIncluded(slot({ orderWithIncludedCredit: true }), 0)).toBe(false);
  });
});

type PromptSlot = ConsentPrompt['slots'][number];
const mint = (extra: Partial<PromptSlot> = {}): PromptSlot => ({ id: 'zz-mint', name: 'ZZ TEST Mint', ageYears: 6,
  requirement: 'drop_off', includedCreditTHB: 1300, extraCreditTHB: 0, orderWithIncludedCredit: false, ...extra });
const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ConsentPromptSchema.parse({
  kind: 'consent', requestId: 'zz-1054-request', visitorId: 'zz-1054-visitor', slots: [mint()],
  guardianName: 'ZZ TEST Ploy', guardianPhone: '+66898054001', contactChannel: 'whatsapp', consentRequired: true,
  consentAcknowledged: false, confirmations: [], staffReady: true, canContinue: false, completed: false,
  familyStep: 'care', phoneFixed: true, ...extra,
});

function open(initial: ConsentPrompt, mirror = false) {
  const sent: ConsentAction[] = [];
  const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); },
    ...(mirror ? { mirror: { step: 'care' } } : {}) } as Parameters<typeof PublicConsentCapture>[0]), initial);
  const byTest = (id: string) => elements(view.result.current).filter((node) => node.props['data-testid'] === id);
  return { view, sent, byTest, text: () => words(view.result.current) };
}
const fills = (sent: ConsentAction[]) => sent.filter((action): action is Extract<ConsentAction, { action: 'fill' }> => action.action === 'fill');

describe('SCRUM-1054 (2): the customer display', () => {
  it('shows the tick under the extra credit while none is chosen, in the form’s words', () => {
    const form = open(promptOf());
    const tick = form.byTest('public-consent-order-with-included');
    expect(tick).toHaveLength(1);
    expect(tick[0]!.props.checked).toBe(false);
    expect(form.text()).toContain('superviseConsent.orderWithIncluded:ZZ TEST Mint');
    form.view.unmount();
  });

  it('not shown with extra credit chosen, nor on a form that does not ask it (an older till or station)', () => {
    const extra = open(promptOf({ slots: [mint({ extraCreditTHB: 300 })] }));
    expect(extra.byTest('public-consent-order-with-included')).toHaveLength(0);
    extra.view.unmount();
    const older = open(promptOf({ slots: [mint({ orderWithIncludedCredit: undefined })] }));
    expect(older.byTest('public-consent-order-with-included')).toHaveLength(0);
    older.view.unmount();
  });

  it('the parent’s tick goes to the till at once, and the till takes it', async () => {
    const form = open(promptOf());
    (form.byTest('public-consent-order-with-included')[0]!.props.onCheckedChange as (value: boolean) => void)(true);
    form.view.rerender(promptOf());
    await vi.advanceTimersByTimeAsync(50);
    const sent = fills(form.sent).at(-1)!;
    expect(sent.slots[0]).toMatchObject({ id: 'zz-mint', orderWithIncludedCredit: true, extraCreditTHB: 0 });
    expect(ConsentActionSchema.safeParse(sent).success).toBe(true);
    expect(consentActionAllowed(promptOf(), sent)).toBe(true);
    expect(consentSlotPatches([slot()], sent.slots)[0]!.patch).toMatchObject({ orderWithIncludedCredit: true });
    form.view.unmount();
  });

  it('a step from a form that does not ask it carries none', async () => {
    const older = promptOf({ slots: [mint({ orderWithIncludedCredit: undefined })] });
    const form = open(older);
    (elements(form.view.result.current).find((node) => node.props['data-testid'] === 'consent-extra-credit-more')!.props.onClick as () => void)();
    form.view.rerender(older);
    await vi.advanceTimersByTimeAsync(50);
    expect(fills(form.sent).at(-1)!.slots[0]).not.toHaveProperty('orderWithIncludedCredit');
    form.view.unmount();
  });

  it('staff’s copy beside the gate shows the family’s tick as the till holds it', () => {
    const form = open(promptOf({ slots: [mint({ orderWithIncludedCredit: true })] }), true);
    expect(form.byTest('public-consent-order-with-included')[0]!.props.checked).toBe(true);
    form.view.unmount();
  });

  it('several displays: a tick the till took from another display is shown; the family’s own unsent tick stays', () => {
    const base = { slots: { 'zz-mint': { name: 'ZZ TEST Mint', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '',
      extraCreditTHB: 0, orderWithIncludedCredit: false } }, guardianName: '', guardianPhone: '', consentAcknowledged: false, confirmations: [] };
    const ticked = { ...base, slots: { 'zz-mint': { ...base.slots['zz-mint'], orderWithIncludedCredit: true } } };
    expect(mergeConsentDraft(base, base, ticked).slots['zz-mint']!.orderWithIncludedCredit).toBe(true);
    expect(mergeConsentDraft(ticked, base, base).slots['zz-mint']!.orderWithIncludedCredit).toBe(true);
  });
});

const policy: SupervisionPolicy = {
  bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'drop_off' }],
  siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, order: 0 }],
};

describe('SCRUM-1054 (3): the till’s own form (its customer half, staff’s copy, the phone till)', () => {
  const form = (current: SupervisedSlot, extra: Record<string, unknown> = {}, updates: [string, Partial<SupervisedSlot>][] = []) =>
    renderHook((now: SupervisedSlot) => ConsentCapture({
      slots: [now], parentName: 'ZZ TEST Ploy', consentAck: false, policy, parentPhone: '+66898054001', parentContactMethod: 'whatsapp',
      onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined, onParentNameChange: () => undefined,
      onConsentAckChange: () => undefined, onUpdateChild: (id: string, patch: Partial<SupervisedSlot>) => { updates.push([id, patch]); },
      acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined, photoAtTillFor: ['zz-mint'],
      includedCreditTHB: () => 1300, ...extra,
    } as never), current);
  const tickOf = (view: ReturnType<typeof form>) =>
    elements(view.result.current).find((node) => node.props['data-testid'] === 'consent-order-with-included');
  const pickerOf = (view: ReturnType<typeof form>) =>
    elements(view.result.current).find((node) => typeof node.props.onChange === 'function' && 'noneNote' in node.props);

  it('asks the tick under the food choice while no extra food is chosen; the no-food line gives way to it', () => {
    const updates: [string, Partial<SupervisedSlot>][] = [];
    const view = form(slot(), {}, updates);
    expect(tickOf(view)!.props.checked).toBe(false);
    expect(words(view.result.current)).toContain('superviseConsent.orderWithIncluded:ZZ TEST Mint');
    expect(pickerOf(view)!.props.noneNote).toBe(false);
    (tickOf(view)!.props.onCheckedChange as (value: boolean) => void)(true);
    expect(updates).toEqual([['zz-mint', { orderWithIncludedCredit: true }]]);
    view.unmount();
  });

  it('with extra food chosen, or no credit on the ticket: no tick, and the form as before', () => {
    const extra = form(credited(300));
    expect(tickOf(extra)).toBeUndefined();
    extra.unmount();
    const noCredit = form(slot(), { includedCreditTHB: () => 0 });
    expect(tickOf(noCredit)).toBeUndefined();
    expect(pickerOf(noCredit)!.props.noneNote).toBe(true);
    noCredit.unmount();
  });

  it('staff’s copy shows the family’s tick and cannot give it', () => {
    const view = form(slot({ orderWithIncludedCredit: true }), { staffScreen: true, ticksReadOnly: true });
    expect(tickOf(view)!.props).toMatchObject({ checked: true, disabled: true });
    expect(words(view.result.current)).toContain('ticked by the family');
    view.unmount();
  });
});

describe('SCRUM-1054 (4): the tills wire it, the box lane leaves it off, and the words exist in every language', () => {
  const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', 'src', file), 'utf8');
  it('both tills send the tick on the registration; the counter publishes it on the display’s form', () => {
    expect(read('pages/Till.tsx')).toContain('...(ordersWithIncluded(slot, slotIncludedCreditTHB(slot)) ? { orderWithIncludedCredit: true } : {}),');
    expect(read('pages/Till.tsx')).toContain('...(asksOrderWithIncluded(slot, included) ? { orderWithIncludedCredit: slot.orderWithIncludedCredit === true } : {})');
    expect(read('components/mobile/MobileTill.tsx')).toContain('...(ordersWithIncluded(slot, formIncludedCreditTHB(slot)) ? { orderWithIncludedCredit: true } : {}),');
  });

  it('the counter box’s registration is sent the children without it: the child is "no food" there, as before', async () => {
    vi.useRealTimers();
    const STATION = '018f0000-0000-7000-8000-0000000105a1';
    const REG = '018f0000-0000-7000-8000-00000010a054';
    const STAY = '018f0000-0000-7000-8000-00000010c054';
    const intents: { type: string; payload: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/box/v1/station/${STATION}/intents`) {
        intents.push(JSON.parse(String(init?.body)) as { type: string; payload: Record<string, unknown> });
        return { ok: true, status: 200, json: async () => ({ document: {}, result: { registration: { id: REG, children: [] } } }) } as Response;
      }
      return { ok: false, status: 503, json: async () => ({ error: { code: 'STATION_FORCED_OFFLINE', message: 'ZZ TEST offline' } }) } as Response;
    }));
    const { checkinApi } = await import('@/api/checkin');
    const { setLaneStation } = await import('@/lib/lane');
    setLaneStation(null);
    setLaneStation(STATION);
    try {
      await checkinApi.createRegistration({
        id: REG, branchId: '018f0000-0000-7000-8000-0000000000b2', stationId: STATION, guardianName: 'ZZ TEST Ploy',
        guardianPhone: '0812345678', contactChannel: 'whatsapp', consentAcknowledged: true, acknowledgedConfirmationIds: [],
        children: [{ checkinId: STAY, name: 'ZZ TEST Mint', ageYears: 6, service: 'drop_off', orderWithIncludedCredit: true }],
      });
      expect(intents[0]).toMatchObject({ type: 'checkin.create', payload: { children: [{ checkinId: STAY, name: 'ZZ TEST Mint' }] } });
      expect((intents[0]!.payload.children as Record<string, unknown>[])[0]).not.toHaveProperty('orderWithIncludedCredit');
    } finally {
      setLaneStation(null);
    }
  });

  it('the new words have every language the form has', () => {
    const entry = DICTIONARY['superviseConsent.orderWithIncluded']!;
    expect(Object.keys(entry).sort()).toEqual(Object.keys(DICTIONARY['superviseConsent.foodIncluded']!).sort());
    for (const text of Object.values(entry)) {
      expect(text.trim()).not.toBe('');
      expect(text).toContain('{{name}}');
    }
    expect(entry.en).toBe('{{name}} may order food with the included credit');
  });
});
