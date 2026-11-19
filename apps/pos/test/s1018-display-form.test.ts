import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentPromptSchema, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { ChannelSelector, PhoneInput } from '@/components/shared/PhoneInput';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import { takeConsentAction } from '@/lib/consentForm';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => vi.stubGlobal('React', React));

/**
 * SCRUM-1018 — THE PAIRED DISPLAY'S FORM FOR A RETURNING FAMILY (the owner's
 * answers of 19 November).
 *
 * - The number is shown filled in, with no tick (replacing SCRUM-863's
 *   tick); the family may still choose the app; only staff change the
 *   number, on the till, and the till takes no number back from the family.
 * - The parent's name comes from the profile: shown, not asked.
 * - A returning family whose children are all saved is asked only the
 *   agreement ticks: one step, the children listed above them.
 * - A form without these fields (an older till or station) is as it was.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const PHONE = '+66898020001'; // ZZ TEST number, used only by this fixture.

const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
  slots: [
    { id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', saved: true },
    { id: 'zz-ben', name: 'ZZ TEST Ben', ageYears: 3, requirement: 'nanny', saved: true },
  ],
  guardianName: 'ZZ TEST Ploy', guardianPhone: PHONE, contactChannel: 'whatsapp', consentRequired: true,
  consentAcknowledged: false, confirmations: [{ id: 'confirm-15min', text: 'ZZ TEST within 15 minutes', required: true, acknowledged: false }],
  staffReady: true, canContinue: false, completed: false, familyStep: 'children',
  phoneFixed: true, guardianFixed: true, agreementsOnly: true, ...extra,
});

function open(initial: ConsentPrompt) {
  const sent: ConsentAction[] = [];
  const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); } }), initial);
  const all = () => elements(view.result.current);
  const byTest = (id: string) => all().filter((node) => node.props['data-testid'] === id || node.props.testId === id);
  return { view, sent, all, byTest, text: () => words(view.result.current) };
}

describe('the form a returning family is shown', () => {
  it('the new fields are part of the form and travel through the station', () => {
    expect(ConsentPromptSchema.safeParse(promptOf()).success).toBe(true);
    const parsed = ConsentPromptSchema.parse(promptOf());
    expect(parsed).toMatchObject({ phoneFixed: true, guardianFixed: true, agreementsOnly: true });
  });

  it('is the agreements alone: no steps, the children listed, no child’s name or age to type', () => {
    const form = open(promptOf());
    expect(form.byTest('consent-steps')).toHaveLength(0);
    expect(form.byTest('consent-child-shown')).toHaveLength(2);
    expect(form.text()).toContain('ZZ TEST Mai');
    expect(form.text()).toContain('ZZ TEST Ben');
    expect(form.byTest('consent-child-name')).toHaveLength(0);
    expect(form.byTest('consent-allergies')).toHaveLength(0);
    // The agreement ticks are there, and Done; no way back to a step it does not have.
    expect(form.byTest('public-consent-ack')).toHaveLength(1);
    expect(form.text()).toContain('ZZ TEST within 15 minutes');
    expect(form.text()).toContain('common.done');
    expect(form.text()).not.toContain('common.back');
    form.view.unmount();
  });

  it('shows the number filled in with no tick, the app still to choose', () => {
    const form = open(promptOf());
    expect(form.all().some((node) => node.type === PhoneInput)).toBe(false);
    expect(form.byTest('consent-kept-phone')).toHaveLength(1);
    expect(form.byTest('public-consent-contact-confirm')).toHaveLength(0);
    expect(form.text()).not.toContain('superviseConsent.confirmContact');
    const pills = form.all().find((node) => node.type === ChannelSelector)!;
    expect(pills.props.channel).toBe('whatsapp');
    (pills.props.onChange as (c: string) => void)('telegram');
    form.view.rerender(promptOf());
    expect(form.all().find((node) => node.type === ChannelSelector)!.props.channel).toBe('telegram');
    form.view.unmount();
  });

  it('shows the parent’s name from the profile, not a box to type it in', () => {
    const form = open(promptOf());
    expect(form.byTest('consent-kept-guardian')).toHaveLength(1);
    expect(form.byTest('consent-guardian')).toHaveLength(0);
    expect(form.text()).toContain('ZZ TEST Ploy');
    form.view.unmount();
  });

  it('asks the photo only of a child the till still asks it of', () => {
    const form = open(promptOf({ slots: [
      { id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', saved: true, photo: 'needed' },
      { id: 'zz-ben', name: 'ZZ TEST Ben', ageYears: 3, requirement: 'nanny', saved: true },
    ] }));
    expect(form.byTest('consent-child-shown')).toHaveLength(2);
    form.view.unmount();
  });

  it('a first visit keeps the three steps, the name to type, and the number shown', () => {
    const form = open(promptOf({ guardianFixed: undefined, agreementsOnly: undefined, guardianName: '' }));
    expect(form.byTest('consent-steps')).toHaveLength(1);
    expect(form.byTest('consent-child-name')).toHaveLength(2);
    form.view.unmount();
  });

  it('a form from an older till (none of the fields) is the form as it was', () => {
    const form = open(promptOf({ phoneFixed: undefined, guardianFixed: undefined, agreementsOnly: undefined }));
    expect(form.byTest('consent-steps')).toHaveLength(1);
    expect(form.byTest('consent-kept-phone')).toHaveLength(0);
    form.view.unmount();
  });

  it('with no number yet the family gives it once, as before', () => {
    const form = open(promptOf({ guardianPhone: '', agreementsOnly: undefined }));
    expect(form.byTest('consent-kept-phone')).toHaveLength(0);
    form.view.unmount();
  });
});

describe('what the till takes from the family’s steps', () => {
  const fence = { requestId: 'zz-test-request', visitorId: 'zz-test-visitor' };
  const step = (extra: Partial<Extract<ConsentAction, { action: 'fill' }>> = {}): ConsentAction => ({
    ...fence, action: 'fill', slots: [], guardianName: 'ZZ TEST typed', guardianPhone: '+66891112222', contactChannel: 'line',
    consentAcknowledged: true, acknowledgedConfirmationIds: [], ...extra,
  });
  const till = (extra: Record<string, unknown> = {}) => ({
    slots: [], guardianPhone: PHONE, signature: 'form-1', contactChannel: 'whatsapp' as const,
    updateSlot: vi.fn(), setGuardianName: vi.fn(), setGuardianPhone: vi.fn(), setContactChannel: vi.fn(),
    setConsentAcknowledged: vi.fn(), setAcknowledgedConfirmationIds: vi.fn(), setCompletedSignature: vi.fn(),
    askedForHelp: vi.fn(), answered: vi.fn(), ...extra,
  });

  it('the shown number and the profile’s name are the till’s: a step does not change them; the app it chose does', () => {
    const t = till({ phoneFixed: true, nameFixed: true });
    takeConsentAction(step(), t);
    expect(t.setGuardianPhone).not.toHaveBeenCalled();
    expect(t.setGuardianName).not.toHaveBeenCalled();
    expect(t.setContactChannel).toHaveBeenCalledWith('line');
    expect(t.setConsentAcknowledged).toHaveBeenCalledWith(true);
    takeConsentAction({ ...fence, action: 'acknowledge', guardianName: 'ZZ TEST typed', consentAcknowledged: true, acknowledgedConfirmationIds: [] }, t);
    expect(t.setGuardianName).not.toHaveBeenCalled();
  });

  it('a form that asks them takes both, as before', () => {
    const t = till();
    takeConsentAction(step(), t);
    expect(t.setGuardianPhone).toHaveBeenCalledWith('+66891112222');
    expect(t.setGuardianName).toHaveBeenCalledWith('ZZ TEST typed');
  });
});
