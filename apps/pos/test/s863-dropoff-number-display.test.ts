import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { PublicConsentCapture, mergeConsentDraft } from '@/components/till/PublicConsentCapture';
import { consentFormPhone } from '@/lib/consentForm';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string) => key }) }));
beforeEach(() => vi.stubGlobal('React', React));

/**
 * SCRUM-863 — THE PAIRED DISPLAY'S DROP-OFF AND NANNY FORM ASKS FOR THE
 * NUMBER AND THE CHANNEL, AND SENDS BOTH TO THE TILL.
 *
 * The owner's ruling of 12 November: these forms ask the family to confirm or
 * change the WhatsApp, LINE or Telegram number, as the prototype's form does;
 * asking once (SCRUM-762) is the ordinary sale's rule only. On a separate
 * customer display the form starts from the number and channel the till sends,
 * and each step (`fill`) carries both back.
 *
 * A till that sends the channel is one that takes both back. A form published
 * without it — an older till, or a station that does not know the field —
 * stays as it was, so a number changed there could never leave the family's
 * screen waiting on a till that would not keep it.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const START = '+66898020001'; // ZZ TEST numbers, used only by this fixture.
const OTHER_TYPED = '+660891112222';
const OTHER_STORED = '+66891112222';

const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
  slots: [{ id: 'zz-test-child', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
  guardianName: 'ZZ TEST guardian', guardianPhone: START, contactChannel: 'whatsapp', consentRequired: true,
  consentAcknowledged: false, confirmations: [], staffReady: false, canContinue: false, completed: false, ...extra,
});

function open(initial: ConsentPrompt) {
  const sent: ConsentAction[] = [];
  const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); } }), initial);
  const all = () => elements(view.result.current);
  const button = (label: string) => all().find(node => words(node.props.children) === label && typeof node.props.onClick === 'function');
  const press = (label: string) => (button(label)!.props.onClick as () => void)();
  const field = () => all().find(node => node.type === PhoneInput) as Element | undefined;
  return {
    view, sent, all, button, press, field,
    /** Children, then care, to the agreements step where the parent's block is. */
    toAgreements: () => { press('common.continue'); press('common.continue'); },
    typeName: (name: string) => (all().find(node => node.props.id === 'public-consent-guardian')!.props.onChange as (v: string) => void)(name),
    typePhone: (phone: string) => (field()!.props.onChange as (v: string) => void)(phone),
    choose: (channel: string) => (field()!.props.onChannelChange as (v: string) => void)(channel),
  };
}

describe('the parent’s block on the paired display', () => {
  it.each(['drop_off', 'nanny'] as const)('%s: asks for the number with the channel choice, starting from the ones the till sent', (requirement) => {
    const prompt = promptOf({ slots: [{ id: 'zz-test-child', name: 'ZZ TEST child', ageYears: 6, requirement }], contactChannel: 'telegram' });
    expect(ConsentPromptSchema.safeParse(prompt).success).toBe(true);
    const form = open(prompt);
    form.toAgreements();
    const field = form.field()!;
    expect(field.props).toMatchObject({ value: START, channel: 'telegram', label: '', translate: true });
    expect(typeof field.props.onChannelChange).toBe('function');
    expect(words(form.view.result.current)).toContain('superviseConsent.phoneNumber');
    // The fixed number and its line are not on this form.
    expect(form.all().some(node => node.props['data-testid'] === 'consent-kept-phone')).toBe(false);
    expect(words(form.view.result.current)).not.toContain('till.input.phoneKept');
    // Looking is not changing: nothing was sent, and the form reads as saved.
    expect(form.sent).toHaveLength(0);
    expect(form.button('common.done')).toBeDefined();
    form.view.unmount();
  });

  it('a number and channel the family changes go to the till with the step, in the number’s stored form', () => {
    const prompt = promptOf();
    const form = open(prompt);
    form.toAgreements();
    form.typePhone(OTHER_TYPED);
    form.choose('telegram');
    // SCRUM-943 (c), the owner on 12 November: the number is drawn one way on
    // the display and the till's copy, so a complete one shows as it is kept.
    expect(form.field()!.props).toMatchObject({ value: OTHER_STORED, channel: 'telegram' });
    // Unsaved, so the step is sent before the form can be finished.
    expect(form.button('common.done')).toBeUndefined();
    form.press('common.continue');
    expect(form.sent).toHaveLength(1);
    expect(form.sent[0]).toMatchObject({ action: 'fill', guardianPhone: OTHER_STORED, contactChannel: 'telegram', guardianName: 'ZZ TEST guardian' });
    const parsed = ConsentActionSchema.safeParse(form.sent[0]);
    expect(parsed.success).toBe(true);
    expect(consentActionAllowed(prompt, parsed.data!)).toBe(true);

    // The till's copy comes back with what it kept: the family's change is not
    // lost, and the form can now be finished (the field draws it as kept, SCRUM-943 c).
    form.view.rerender(promptOf({ requestId: 'zz-test-request-2', guardianPhone: OTHER_STORED, contactChannel: 'telegram' }));
    expect(form.field()!.props).toMatchObject({ value: OTHER_STORED, channel: 'telegram' });
    expect(form.button('common.done')).toBeDefined();
    expect(form.sent).toHaveLength(1);

    // The till has it now, so a correction staff make afterwards shows on the
    // family's screen instead of being typed over by the form.
    form.view.rerender(promptOf({ requestId: 'zz-test-request-3', guardianPhone: START, contactChannel: 'line' }));
    expect(form.field()!.props).toMatchObject({ value: START, channel: 'line' });
    expect(form.button('common.done')).toBeDefined();
    expect(form.sent).toHaveLength(1);
    form.view.unmount();
  });

  it('a republish that still holds the old number does not take the family’s change away', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.typePhone(OTHER_TYPED);
    form.choose('line');
    // Staff typed the guardian's name on the till meanwhile: a new copy, old number.
    form.view.rerender(promptOf({ requestId: 'zz-test-request-2', guardianName: 'ZZ TEST guardian Ploy' }));
    // The family's number, drawn as it is kept (SCRUM-943 c).
    expect(form.field()!.props).toMatchObject({ value: OTHER_STORED, channel: 'line' });
    expect(form.all().find(node => node.props.id === 'public-consent-guardian')!.props.value).toBe('ZZ TEST guardian Ploy');
    form.press('common.continue');
    expect(form.sent.at(-1)).toMatchObject({ requestId: 'zz-test-request-2', guardianPhone: OTHER_STORED, contactChannel: 'line', guardianName: 'ZZ TEST guardian Ploy' });
    form.view.unmount();
  });

  it('a number staff correct on the till reaches a field the family has not touched', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.view.rerender(promptOf({ requestId: 'zz-test-request-2', guardianPhone: OTHER_STORED, contactChannel: 'line' }));
    expect(form.field()!.props).toMatchObject({ value: OTHER_STORED, channel: 'line' });
    expect(form.sent).toHaveLength(0);
    form.view.unmount();
  });

  it('every step carries the number and the channel, changed or not', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.typeName('ZZ TEST guardian Dao');
    form.press('common.continue');
    expect(form.sent[0]).toMatchObject({ action: 'fill', guardianName: 'ZZ TEST guardian Dao', guardianPhone: START, contactChannel: 'whatsapp' });
    form.view.unmount();
  });

  it('a number the family clears goes as empty, so the till’s copy matches the form', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.typePhone('');
    form.press('common.continue');
    expect(form.sent[0]).toMatchObject({ action: 'fill', guardianPhone: '', contactChannel: 'whatsapp' });
    expect(ConsentActionSchema.safeParse(form.sent[0]).success).toBe(true);
    form.view.unmount();
  });
});

describe('a form from a till that does not take the number back', () => {
  it('with a number: stays as it was, the number fixed, and its steps carry neither field', () => {
    const prompt = promptOf({ contactChannel: undefined });
    const form = open(prompt);
    form.toAgreements();
    expect(form.field()).toBeUndefined();
    expect(form.all().some(node => node.props['data-testid'] === 'consent-kept-phone')).toBe(true);
    form.typeName('ZZ TEST guardian Dao');
    form.press('common.continue');
    expect(form.sent).toHaveLength(1);
    expect('guardianPhone' in form.sent[0]!).toBe(false);
    expect('contactChannel' in form.sent[0]!).toBe(false);
    form.view.unmount();
  });

  it('with none: asks for the number as before, with no channel to send', () => {
    const form = open(promptOf({ contactChannel: undefined, guardianPhone: '' }));
    form.toAgreements();
    expect(form.field()!.props.channel).toBeUndefined();
    expect(form.field()!.props.onChannelChange).toBeUndefined();
    form.typePhone(OTHER_TYPED);
    form.press('common.continue');
    expect(form.sent[0]).toMatchObject({ action: 'fill', guardianPhone: OTHER_TYPED });
    expect('contactChannel' in form.sent[0]!).toBe(false);
    form.view.unmount();
  });
});

describe('an ordinary group on the paired display, no child in care', () => {
  it('is not asked the number again: it stays fixed as given on the first screen, and its steps carry neither field (SCRUM-762)', () => {
    const prompt = promptOf({ slots: [{ id: 'zz-test-child', name: 'ZZ TEST child', ageYears: 6, requirement: 'none' }], consentRequired: false });
    expect(ConsentPromptSchema.safeParse(prompt).success).toBe(true);
    const form = open(prompt);
    const guardian = () => form.all().find(node => node.props.id === 'public-consent-guardian');
    for (let step = 0; step < 3 && !guardian(); step += 1) form.press('common.continue');
    expect(guardian()).toBeDefined();
    expect(form.field()).toBeUndefined();
    expect(form.all().some(node => node.props['data-testid'] === 'consent-kept-phone')).toBe(true);
    expect(words(form.view.result.current)).toContain('till.input.phoneKept');
    form.typeName('ZZ TEST guardian Mali');
    const before = form.sent.length;
    form.press('common.continue');
    const step = form.sent[before]!;
    expect(step).toMatchObject({ action: 'fill', guardianName: 'ZZ TEST guardian Mali' });
    expect('guardianPhone' in step).toBe(false);
    expect('contactChannel' in step).toBe(false);
    expect(ConsentActionSchema.safeParse(step).success).toBe(true);
    form.view.unmount();
  });
});

describe('the number as the form sends it and the till keeps it', () => {
  it('is the stored form of a number that reads as one, and what was typed otherwise', () => {
    expect(consentFormPhone(OTHER_TYPED)).toBe(OTHER_STORED);
    expect(consentFormPhone(' 0891112222 ')).toBe(OTHER_STORED);
    expect(consentFormPhone(OTHER_STORED)).toBe(OTHER_STORED);
    expect(consentFormPhone('+6689')).toBe('+6689');
    expect(consentFormPhone('')).toBe('');
  });

  it('the till’s copy lays over the channel like any other field', () => {
    const child = { name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' };
    const base = { slots: { a: child }, guardianName: '', guardianPhone: START, contactChannel: 'whatsapp' as const,
      consentAcknowledged: false, confirmations: [] as string[] };
    const fromTill = { ...base, guardianPhone: OTHER_STORED, contactChannel: 'line' as const };
    // Untouched here: the till's values. Changed here: the family's.
    expect(mergeConsentDraft(base, base, fromTill)).toMatchObject({ guardianPhone: OTHER_STORED, contactChannel: 'line' });
    // SCRUM-857 — the family's screen now sends as they type, so a field the
    // till changed to something else since (staff on the till) is the till's:
    // the station took that change first, and the family's unsent choice of
    // Telegram gives way to staff's LINE rather than being sent over it.
    expect(mergeConsentDraft({ ...base, guardianPhone: OTHER_TYPED, contactChannel: 'telegram' }, base, fromTill))
      .toMatchObject({ guardianPhone: OTHER_TYPED, contactChannel: 'line' });
    // The same number typed with its leading zero is not a change: the till's copy wins.
    expect(mergeConsentDraft({ ...base, guardianPhone: '+660898020001' }, base, fromTill).guardianPhone).toBe(OTHER_STORED);
  });
});
