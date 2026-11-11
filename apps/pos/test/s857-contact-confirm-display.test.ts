import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { PublicConsentCapture, mergeConsentDraft } from '@/components/till/PublicConsentCapture';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => vi.stubGlobal('React', React));

/**
 * SCRUM-857 — THE PAIRED DISPLAY'S FORM ASKS THE FAMILY TO CONFIRM THE NUMBER.
 *
 * The owner's ruling of 8 November: the family must explicitly confirm that
 * the number on the drop-off and nanny form is the one for the chosen
 * channel. On a separate customer display the tick-box line sits under the
 * number, names the channel, is cleared when the number or the channel
 * changes, travels to the till with every step, and Done waits for it. A
 * form whose till does not ask (no `contactConfirmed` in the prompt: an
 * older till, or a station between that dropped the field) shows no line
 * and sends nothing new, so an older station's strict reading of a step is
 * never tripped.
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
  guardianName: 'ZZ TEST guardian', guardianPhone: START, contactChannel: 'whatsapp', contactConfirmed: false, consentRequired: true,
  consentAcknowledged: true, confirmations: [], staffReady: true, canContinue: true, completed: false, ...extra,
});

function open(initial: ConsentPrompt) {
  const sent: ConsentAction[] = [];
  const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); } }), initial);
  const all = () => elements(view.result.current);
  const button = (label: string) => all().find(node => words(node.props.children) === label && typeof node.props.onClick === 'function');
  const press = (label: string) => (button(label)!.props.onClick as () => void)();
  const field = () => all().find(node => node.type === PhoneInput) as Element | undefined;
  const tick = () => all().find(node => node.props['data-testid'] === 'public-consent-contact-confirm') as Element | undefined;
  return {
    view, sent, all, button, press, field, tick,
    toAgreements: () => { press('common.continue'); press('common.continue'); },
    typePhone: (phone: string) => (field()!.props.onChange as (v: string) => void)(phone),
    choose: (channel: string) => (field()!.props.onChannelChange as (v: string) => void)(channel),
    confirm: (value = true) => (tick()!.props.onCheckedChange as (v: boolean) => void)(value),
    text: () => words(view.result.current),
  };
}

describe('the tick-box line on the paired display', () => {
  it.each([['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['line', 'LINE']] as const)('names the chosen channel: %s', (contactChannel, name) => {
    const prompt = promptOf({ contactChannel });
    expect(ConsentPromptSchema.safeParse(prompt).success).toBe(true);
    const form = open(prompt);
    form.toAgreements();
    expect(form.tick()).toBeDefined();
    expect(form.tick()!.props.checked).toBe(false);
    expect(form.tick()!.props.disabled).toBe(false);
    expect(form.text()).toContain(`superviseConsent.confirmContact:${name}`);
    form.view.unmount();
  });

  it('follows the channel the family switches to, and switching clears the tick', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.confirm();
    expect(form.tick()!.props.checked).toBe(true);
    form.choose('telegram');
    expect(form.text()).toContain('superviseConsent.confirmContact:Telegram');
    expect(form.tick()!.props.checked).toBe(false);
    form.view.unmount();
  });

  it('a changed number clears the tick too', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.confirm();
    form.typePhone(OTHER_TYPED);
    expect(form.tick()!.props.checked).toBe(false);
    form.view.unmount();
  });

  it('cannot be ticked without a number, or for one that cannot take messages, and says which', () => {
    const empty = open(promptOf({ guardianPhone: '' }));
    empty.toAgreements();
    expect(empty.tick()!.props.disabled).toBe(true);
    expect(empty.all().some(node => node.props['data-testid'] === 'consent-contact-needed')).toBe(true);
    expect(empty.text()).toContain('superviseConsent.phoneNeeded');
    empty.view.unmount();
    const wrong = open(promptOf());
    wrong.toAgreements();
    wrong.typePhone('+6621234567');
    expect(wrong.tick()!.props.disabled).toBe(true);
    expect(wrong.all().some(node => node.props['data-testid'] === 'consent-contact-invalid')).toBe(true);
    expect(wrong.text()).toContain('superviseConsent.phoneInvalid');
    wrong.view.unmount();
  });
});

describe('the tick goes to the till, and Done waits for it', () => {
  it('the step carries the tick with the number and channel, and the form can be finished once the till has it', () => {
    const prompt = promptOf();
    const form = open(prompt);
    form.toAgreements();
    // Ready on the till, but unconfirmed: no Done yet.
    expect(form.button('common.done')).toBeDefined();
    expect(form.button('common.done')!.props.disabled).toBe(true);
    form.confirm();
    // Unsaved, so the step is sent before the form can be finished.
    expect(form.button('common.done')).toBeUndefined();
    form.press('common.continue');
    expect(form.sent).toHaveLength(1);
    expect(form.sent[0]).toMatchObject({ action: 'fill', guardianPhone: START, contactChannel: 'whatsapp', contactConfirmed: true });
    const parsed = ConsentActionSchema.safeParse(form.sent[0]);
    expect(parsed.success).toBe(true);
    expect(consentActionAllowed(prompt, parsed.data!)).toBe(true);
    // The till's copy comes back confirmed: Done is open.
    form.view.rerender(promptOf({ requestId: 'zz-test-request-2', contactConfirmed: true }));
    expect(form.tick()!.props.checked).toBe(true);
    expect(form.button('common.done')).toBeDefined();
    expect(form.button('common.done')!.props.disabled).toBe(false);
    form.press('common.done');
    expect(form.sent.at(-1)).toMatchObject({ action: 'done' });
    form.view.unmount();
  });

  it('a step without the tick says so; a number that cannot take messages is sent unconfirmed', () => {
    const form = open(promptOf());
    form.toAgreements();
    // Nothing changed yet: the form reads as saved and offers Done, not Continue.
    expect(form.sent).toHaveLength(0);
    expect(form.button('common.continue')).toBeUndefined();
    form.typePhone(OTHER_TYPED);
    form.press('common.continue');
    expect(form.sent.at(-1)).toMatchObject({ guardianPhone: OTHER_STORED, contactConfirmed: false });
    form.typePhone('+6621234567');
    form.confirm(); // the box is disabled on screen; even a stray tick is not sent as confirmed
    form.press('common.continue');
    expect(form.sent.at(-1)).toMatchObject({ guardianPhone: '+6621234567', contactConfirmed: false });
    form.view.unmount();
  });

  it('the till’s copy lays the tick over a field the family has not touched', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.view.rerender(promptOf({ requestId: 'zz-test-request-2', contactConfirmed: true }));
    expect(form.tick()!.props.checked).toBe(true);
    // Staff corrected the number on the till: the tick comes back cleared with it.
    form.view.rerender(promptOf({ requestId: 'zz-test-request-3', guardianPhone: OTHER_STORED, contactConfirmed: false }));
    expect(form.field()!.props.value).toBe(OTHER_STORED);
    expect(form.tick()!.props.checked).toBe(false);
    expect(form.button('common.done')!.props.disabled).toBe(true);
    form.view.unmount();
  });

  it('a tick the family is giving is not taken away by a republish that still says unconfirmed', () => {
    const form = open(promptOf());
    form.toAgreements();
    form.confirm();
    form.view.rerender(promptOf({ requestId: 'zz-test-request-2', guardianName: 'ZZ TEST guardian Ploy' }));
    expect(form.tick()!.props.checked).toBe(true);
    form.press('common.continue');
    expect(form.sent.at(-1)).toMatchObject({ requestId: 'zz-test-request-2', guardianName: 'ZZ TEST guardian Ploy', contactConfirmed: true });
    form.view.unmount();
  });
});

describe('a form from a till that does not ask', () => {
  it('shows no line, sends no tick, and finishes as it always did', () => {
    const prompt = promptOf({ contactConfirmed: undefined });
    const form = open(prompt);
    form.toAgreements();
    expect(form.tick()).toBeUndefined();
    expect(form.text()).not.toContain('superviseConsent.confirmContact');
    expect(form.text()).not.toContain('superviseConsent.phoneNeeded');
    expect(form.button('common.done')!.props.disabled).toBe(false);
    form.typePhone(OTHER_TYPED);
    form.press('common.continue');
    expect(form.sent).toHaveLength(1);
    expect('contactConfirmed' in form.sent[0]!).toBe(false);
    expect(form.sent[0]).toMatchObject({ guardianPhone: OTHER_STORED, contactChannel: 'whatsapp' });
    form.view.unmount();
  });

  it('nor on a form with no channel at all (a till from before SCRUM-863)', () => {
    const form = open(promptOf({ contactChannel: undefined, contactConfirmed: undefined }));
    form.toAgreements();
    expect(form.tick()).toBeUndefined();
    form.view.unmount();
  });
});

describe('the till’s copy and the family’s draft', () => {
  const child = { name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' };
  const base = { slots: { a: child }, guardianName: '', guardianPhone: START, contactChannel: 'whatsapp' as const, contactConfirmed: false,
    consentAcknowledged: false, confirmations: [] as string[] };

  it('the tick merges like any other field: the till’s where untouched, the family’s where they changed it', () => {
    expect(mergeConsentDraft(base, base, { ...base, contactConfirmed: true }).contactConfirmed).toBe(true);
    expect(mergeConsentDraft({ ...base, contactConfirmed: true }, base, base).contactConfirmed).toBe(true);
    expect(mergeConsentDraft({ ...base, contactConfirmed: true }, { ...base, contactConfirmed: true }, base).contactConfirmed).toBe(false);
  });

  it('a copy without the tick leaves none on the draft', () => {
    const { contactConfirmed: _tick, ...older } = base;
    expect('contactConfirmed' in mergeConsentDraft(older, older, older)).toBe(false);
  });
});
