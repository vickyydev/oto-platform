import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import { tFor } from '@/i18n/LanguageContext';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', async (original) => {
  const actual = await original<typeof import('@/i18n/LanguageContext')>();
  return { ...actual, useLanguage: () => ({ lang: 'en', t: actual.tFor('en') }) };
});
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

/**
 * SCRUM-857 / SCRUM-875 — THE FAMILY'S DONE ON THEIR OWN SCREEN.
 *
 * The owner's ruling of 8 November: no staff confirmation once the family
 * has filled everything in and every check passes. On the paired display and
 * on the till's own customer half, Done waits for every check and a short
 * line says what is still missing; once pressed, the finished form says it is
 * being saved (the till moves on by itself) rather than asking the family to
 * wait for the team; and a Done the till could not save opens the form again,
 * saying so. The till's side (the same gate as the staff's Continue, for this
 * sale and form only) is in s857-family-done-gate.test.ts and the till smoke;
 * the till's own customer half is in s857-family-done-half.test.ts.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const PHONE = '+66898020001'; // ZZ TEST numbers, used only by this fixture.

const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
  slots: [{ id: 'zz-test-child', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
  guardianName: 'ZZ TEST guardian', guardianPhone: PHONE, contactChannel: 'whatsapp', contactConfirmed: true, consentRequired: true,
  consentAcknowledged: true, confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, acknowledged: true }],
  staffReady: true, canContinue: true, completed: false, ...extra,
});

describe('the paired display', () => {
  const en = tFor('en');

  function open(initial: ConsentPrompt) {
    const sent: ConsentAction[] = [];
    const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); } }), initial);
    const all = () => elements(view.result.current);
    const button = (label: string) => all().find(node => words(node.props.children) === label && typeof node.props.onClick === 'function');
    const byTest = (id: string) => all().find(node => node.props['data-testid'] === id);
    return {
      view, sent, button, byTest,
      toAgreements: () => { (button(en('common.continue'))!.props.onClick as () => void)(); (button(en('common.continue'))!.props.onClick as () => void)(); },
      missing: () => words(byTest('consent-missing')?.props.children),
      text: () => words(view.result.current),
    };
  }

  it('a finished form offers Done and says nothing is missing', () => {
    const form = open(promptOf());
    form.toAgreements();
    expect(form.button(en('common.done'))!.props.disabled).toBe(false);
    expect(form.byTest('consent-missing')).toBeUndefined();
    form.view.unmount();
  });

  it('the number not confirmed: Done waits and the line names the channel', () => {
    const form = open(promptOf({ contactConfirmed: false, contactChannel: 'telegram' }));
    form.toAgreements();
    expect(form.button(en('common.done'))!.props.disabled).toBe(true);
    expect(form.missing()).toBe('Still needed before Done: confirming your Telegram number');
    form.view.unmount();
  });

  it('no photo yet: Done waits and the line says a photo of each child is still needed', () => {
    const form = open(promptOf({ staffReady: false, canContinue: false }));
    form.toAgreements();
    expect(form.button(en('common.done'))!.props.disabled).toBe(true);
    expect(form.missing()).toBe('Still needed before Done: a photo of each child with you');
    form.view.unmount();
  });

  it('the consent and a confirmation not ticked yet, and no name: the line names each, in the form’s order', () => {
    const form = open(promptOf({ guardianName: '', consentAcknowledged: false, canContinue: false,
      confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, acknowledged: false }] }));
    form.toAgreements();
    expect(form.missing()).toBe('Still needed before Done: your name · your consent · each confirmation');
    form.view.unmount();
  });

  it('a child with no age yet: the line names the children’s details', () => {
    const form = open(promptOf({ slots: [{ id: 'zz-test-child', name: 'ZZ TEST child', ageYears: null, requirement: 'none' }],
      consentRequired: false, canContinue: false, contactConfirmed: undefined }));
    // The children step keeps Continue until an age is chosen; the line belongs to the agreements step.
    expect(form.byTest('consent-missing')).toBeUndefined();
    expect(form.text()).toContain(en('superviseConsent.nameAndAgeFirst'));
    form.view.unmount();
  });

  it('once Done is pressed and the till is saving, the form says so instead of asking the family to wait', () => {
    const finishing = promptOf({ completed: true, finishing: true });
    expect(ConsentPromptSchema.safeParse(finishing).success).toBe(true);
    const form = open(finishing);
    expect(words(form.byTest('consent-finished')?.props.children)).toBe(en('superviseConsent.finishing'));
    expect(form.button(en('common.done'))).toBeUndefined();
    form.view.unmount();
  });

  it('a finished form from a till that does not move on by itself still asks the family to wait for the team', () => {
    const form = open(promptOf({ completed: true }));
    expect(words(form.byTest('consent-finished')?.props.children)).toBe(en('superviseConsent.waitForTeam'));
    form.view.unmount();
  });

  it('a Done that could not be saved opens the form again, says so, and Done can be pressed again', () => {
    const form = open(promptOf({ notSaved: true }));
    expect(words(form.byTest('consent-not-saved')?.props.children)).toBe(en('superviseConsent.notSaved'));
    form.toAgreements();
    expect(form.button(en('common.done'))!.props.disabled).toBe(false);
    (form.button(en('common.done'))!.props.onClick as () => void)();
    expect(form.sent.at(-1)).toEqual({ requestId: 'zz-test-request', visitorId: 'zz-test-visitor', action: 'done' });
    form.view.unmount();
  });
});

describe('the wire: a form being saved, and one whose Done was not saved', () => {
  it('only a finished form can be saving, and a form whose Done was not saved is open again', () => {
    expect(ConsentPromptSchema.safeParse(promptOf({ finishing: true })).success).toBe(false);
    expect(ConsentPromptSchema.safeParse(promptOf({ completed: true, notSaved: true })).success).toBe(false);
    expect(ConsentPromptSchema.safeParse(promptOf({ notSaved: true })).success).toBe(true);
  });

  it('a second Done on a form already being saved is refused (a double tap writes one registration)', () => {
    const finishing = ConsentPromptSchema.parse(promptOf({ completed: true, finishing: true }));
    expect(consentActionAllowed(finishing, { requestId: 'zz-test-request', visitorId: 'zz-test-visitor', action: 'done' })).toBe(false);
  });

  it('a Done pressed on an earlier revision of the form, or for another family, is refused', () => {
    const now = ConsentPromptSchema.parse(promptOf({ requestId: 'zz-test-request-2' }));
    expect(consentActionAllowed(now, { requestId: 'zz-test-request', visitorId: 'zz-test-visitor', action: 'done' })).toBe(false);
    expect(consentActionAllowed(now, { requestId: 'zz-test-request-2', visitorId: 'zz-other-visitor', action: 'done' })).toBe(false);
    expect(consentActionAllowed(now, { requestId: 'zz-test-request-2', visitorId: 'zz-test-visitor', action: 'done' })).toBe(true);
  });

  it('a form from an older till, with neither field, reads as it always did', () => {
    const older = promptOf();
    expect(ConsentPromptSchema.parse(older)).not.toHaveProperty('finishing');
    expect(ConsentPromptSchema.parse(older)).not.toHaveProperty('notSaved');
  });
});
