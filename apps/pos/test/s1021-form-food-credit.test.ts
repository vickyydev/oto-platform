import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { EXTRA_CREDIT_STEP_THB, PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { consentSlotPatches } from '@/lib/consentForm';
import { extraCreditOfSlot, includedCreditTHB, slotFoodFromFamily } from '@/lib/dropOffFoodCredit';
import { DICTIONARY } from '@/i18n/dictionary';
import type { TicketType } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-1021 — THE FOOD CREDIT ON THE DROP-OFF AND NANNY FORM (the owner's
 * answers of 19 November 2026): a supervised child on Eat & Play has the
 * ticket's credit shown as "included, no extra charge"; the parent chooses
 * extra prepaid food credit on the customer display; staff see the choice on
 * the till as it is made, and it is its own row on the order.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

type PromptSlot = ConsentPrompt['slots'][number];
const mai = (extra: Partial<PromptSlot> = {}): PromptSlot => ({ id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6,
  requirement: 'drop_off', includedCreditTHB: 1300, extraCreditTHB: 0, ...extra });
const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ConsentPromptSchema.parse({
  kind: 'consent', requestId: 'zz-1021-request', visitorId: 'zz-1021-visitor', slots: [mai()],
  guardianName: 'ZZ TEST Ploy', guardianPhone: '+66898021001', contactChannel: 'whatsapp', consentRequired: true,
  consentAcknowledged: false, confirmations: [], staffReady: true, canContinue: false, completed: false,
  familyStep: 'care', phoneFixed: true, ...extra,
});

function open(initial: ConsentPrompt, mirror = false) {
  const sent: ConsentAction[] = [];
  const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); },
    ...(mirror ? { mirror: { step: 'care' } } : {}) } as Parameters<typeof PublicConsentCapture>[0]), initial);
  const all = () => elements(view.result.current);
  const byTest = (id: string) => all().filter((node) => node.props['data-testid'] === id || node.props.testId === id);
  return { view, sent, byTest, text: () => words(view.result.current) };
}
const fills = (sent: ConsentAction[]) => sent.filter((action): action is Extract<ConsentAction, { action: 'fill' }> => action.action === 'fill');

const EAT_PLAY = {
  id: 'zz-eat-play', name: 'ZZ TEST Eat & Play', hours: 3,
  prices: { tourist: { weekday: 1300, weekend: 1300 } },
  creditRule: { appliesTo: 'both', basis: 'full_price' },
  gateAccess: true,
} as unknown as TicketType;
const TWO_HOURS = { ...EAT_PLAY, id: 'zz-two-hours', creditRule: { appliesTo: 'adults', basis: 'full_price' } } as unknown as TicketType;

describe('SCRUM-1021 (1): the included credit, as the band will hold it', () => {
  it('Eat & Play: the kid ticket’s price; adults-only credit and a Golden Ticket child: nothing', () => {
    expect(includedCreditTHB(EAT_PLAY, 'tourist')).toBe(1300);
    expect(includedCreditTHB(TWO_HOURS, 'tourist')).toBe(0);
    expect(includedCreditTHB(EAT_PLAY, 'tourist', true)).toBe(0);
  });
});

describe('SCRUM-1021 (2): the display shows it, and the parent chooses the extra', () => {
  it('the care step shows "included, no extra charge" and the extra credit to choose', () => {
    const form = open(promptOf());
    expect(form.byTest('consent-food-included')).toHaveLength(1);
    expect(form.text()).toContain('superviseConsent.foodIncluded:1300');
    expect(form.text()).toContain('superviseConsent.extraFoodCredit');
    expect(words(form.byTest('consent-extra-credit')[0])).toBe('฿0');
    form.view.unmount();
  });

  it('a form without the fields (an older till or station) is the form as it was', () => {
    const form = open(promptOf({ slots: [mai({ includedCreditTHB: undefined, extraCreditTHB: undefined })] }));
    expect(form.byTest('consent-food-credit')).toHaveLength(0);
    form.view.unmount();
  });

  it('the parent’s + goes to the till at once, with the amount on the child', async () => {
    const form = open(promptOf());
    (form.byTest('consent-extra-credit-more')[0]!.props.onClick as () => void)();
    form.view.rerender(promptOf());
    await vi.advanceTimersByTimeAsync(50);
    const sent = fills(form.sent).at(-1)!;
    expect(sent.slots[0]).toMatchObject({ id: 'zz-mai', extraCreditTHB: EXTRA_CREDIT_STEP_THB });
    expect(ConsentActionSchema.safeParse(sent).success).toBe(true);
    expect(consentActionAllowed(promptOf(), sent)).toBe(true);
    form.view.unmount();
  });

  it('agreements-only (a returning family): the food credit sits on the child’s card', () => {
    const form = open(promptOf({ agreementsOnly: true, familyStep: 'agreements', guardianFixed: true }));
    expect(form.byTest('consent-child-shown')).toHaveLength(1);
    expect(words(form.byTest('consent-child-shown')[0])).toContain('superviseConsent.foodIncluded:1300');
    form.view.unmount();
  });

  it('staff’s copy beside the gate shows the family’s choice as the till holds it', () => {
    const form = open(promptOf({ slots: [mai({ extraCreditTHB: 300 })] }), true);
    expect(words(form.byTest('consent-extra-credit')[0])).toBe('฿300');
    form.view.unmount();
  });

  it('an extra credit is refused for a child whose form did not ask it', () => {
    const fill: ConsentAction = { action: 'fill', requestId: 'zz-1021-request', visitorId: 'zz-1021-visitor',
      slots: [{ id: 'zz-mai', name: 'ZZ TEST Mai', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '', extraCreditTHB: 200 }],
      guardianName: 'ZZ TEST Ploy', consentAcknowledged: false, acknowledgedConfirmationIds: [] };
    expect(consentActionAllowed(promptOf(), fill)).toBe(true);
    expect(consentActionAllowed(promptOf({ slots: [mai({ extraCreditTHB: undefined })] }), fill)).toBe(false);
  });
});

const slot = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id: 'zz-mai', sourceLineId: 'line', ticketType: EAT_PLAY, name: 'ZZ TEST Mai', age: '6', waived: false,
  allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, ...extra,
});
const filled = (extraCreditTHB?: number) => ({ id: 'zz-mai', name: 'ZZ TEST Mai', dateOfBirth: null, ageYears: 6,
  allergiesMedical: '', foodRestrictions: '', ...(extraCreditTHB === undefined ? {} : { extraCreditTHB }) });

describe('SCRUM-1021 (3): what the till takes from the parent’s choice', () => {
  it('an amount becomes the child’s prepaid credit; nought takes it back off; nothing sent changes nothing', () => {
    expect(consentSlotPatches([slot()], [filled(300)])[0]!.patch).toMatchObject({
      foodProvision: { mode: 'prepaid_credit', creditAmountTHB: 300, paidTHB: 300 }, mayOrderFood: true,
    });
    const credited = slot({ foodProvision: { mode: 'prepaid_credit', creditAmountTHB: 300, paidTHB: 300 }, mayOrderFood: true });
    expect(consentSlotPatches([credited], [filled(0)])[0]!.patch).toMatchObject({ foodProvision: { mode: 'none', paidTHB: 0 }, mayOrderFood: false });
    expect(consentSlotPatches([credited], [filled()])[0]!.patch).not.toHaveProperty('foodProvision');
    expect(consentSlotPatches([credited], [filled(300)])[0]!.patch).not.toHaveProperty('foodProvision');
  });

  it('prepaid items staff chose stand: the form does not ask, and a step never replaces them', () => {
    const items = slot({ foodProvision: { mode: 'prepaid_items', paidTHB: 180, items: [] } });
    expect(extraCreditOfSlot(items)).toBeNull();
    expect(slotFoodFromFamily(items, 500)).toBeNull();
    expect(extraCreditOfSlot(slot())).toBe(0);
    expect(extraCreditOfSlot(slot({ foodProvision: { mode: 'prepaid_credit', creditAmountTHB: 250, paidTHB: 250 } }))).toBe(250);
  });
});

describe('SCRUM-1021 (4): the till wires it, and the words exist in every language', () => {
  const read = (file: string) => readFileSync(path.join(import.meta.dirname, '..', 'src', file), 'utf8');
  it('the till publishes the food credit for a child in care and shows the included line on its own form', () => {
    const till = read('pages/Till.tsx');
    expect(till).toContain('...consentSlotFood(slot, outcome.needsConsent)');
    expect(till.match(/includedCreditTHB=\{slotIncludedCreditTHB\}/g)).toHaveLength(3);
    expect(read('components/till/OrderSummary.tsx')).toContain('data-testid="order-food-credit"');
  });

  it('every new key has every language', () => {
    for (const key of ['superviseConsent.foodIncluded', 'superviseConsent.extraFoodCredit']) {
      const entry = DICTIONARY[key]!;
      expect(Object.keys(entry).sort()).toEqual(['en', 'fr', 'ru', 'th', 'zh']);
      for (const text of Object.values(entry)) expect(text.trim()).not.toBe('');
    }
    expect(DICTIONARY['superviseConsent.foodIncluded']!.th).toContain('{{amount}}');
  });
});
