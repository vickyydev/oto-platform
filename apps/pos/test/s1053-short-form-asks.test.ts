import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentPromptSchema, type ConsentPrompt } from '@oto/shared';
import { ConsentCapture, halfCareState } from '@/components/till/ConsentCapture';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupervisionPolicy } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')), useId: () => 'zz-1053' }));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) => vars ? `${key}:${Object.values(vars).join(',')}` : key }),
  tFor: () => (key: string) => key,
}));
beforeEach(() => vi.stubGlobal('React', React));

/**
 * SCRUM-1053 — A RETURNING FAMILY'S SHORT FORM ASKS ONLY WHAT THE FAMILY
 * STILL HAS TO DO (the owner's answers of 19 November: a returning family is
 * asked only the three agreement ticks; staff decide the last photo).
 *
 * - The heading no longer asks for names and ages that are saved: "Welcome
 *   back", and a line that says the details are saved and asks the ticks.
 * - The "Still needed before Done" line no longer names a photo while staff
 *   are deciding about the last one (`photoWithStaff` on the display; the
 *   photos staff compare on the till's own half).
 * - The till's own customer half (no display paired) asks the display's "no
 *   allergies or medical needs" tick before a saved child's note is emptied.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const PHONE = '+66898020001'; // ZZ TEST number, used only by this fixture.
const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
  slots: [{ id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', saved: true }],
  guardianName: 'ZZ TEST Ploy', guardianPhone: PHONE, contactChannel: 'whatsapp', consentRequired: true,
  consentAcknowledged: false, confirmations: [{ id: 'confirm-15min', text: 'ZZ TEST within 15 minutes', required: true, acknowledged: false }],
  staffReady: false, canContinue: false, completed: false, familyStep: 'agreements',
  phoneFixed: true, guardianFixed: true, agreementsOnly: true, ...extra,
});
const display = (prompt: ConsentPrompt) => {
  const view = renderHook(() => PublicConsentCapture({ prompt, busy: false, onAction: () => undefined }));
  const text = words(view.result.current);
  view.unmount();
  return text;
};

describe('the display’s short form for a returning family', () => {
  it('welcomes them back and asks the ticks, not the names and ages that are saved', () => {
    const one = display(promptOf());
    expect(one).toContain('superviseConsent.titleReturning');
    expect(one).toContain('superviseConsent.subtitleReturningOne');
    expect(one).not.toContain('superviseConsent.titleOne');
    expect(one).not.toContain('superviseConsent.subtitle ');
    expect(one).not.toMatch(/superviseConsent\.subtitle(?!Returning)/);
    const two = display(promptOf({ slots: [...promptOf().slots, { id: 'zz-tom', name: 'ZZ TEST Tom', ageYears: 10, requirement: 'none', saved: true }] }));
    expect(two).toContain('superviseConsent.subtitleReturningMany');
    // A first visit keeps its own heading.
    const first = display(promptOf({ agreementsOnly: undefined, guardianFixed: undefined, familyStep: 'children' }));
    expect(first).toContain('superviseConsent.titleOne');
    expect(first).toMatch(/superviseConsent\.subtitle(?!Returning)/);
  });

  it('names no photo while staff decide the last one; an older till’s form reads as before', () => {
    expect(ConsentPromptSchema.safeParse(promptOf({ photoWithStaff: true })).success).toBe(true);
    const deciding = display(promptOf({ photoWithStaff: true }));
    expect(deciding).toContain('superviseConsent.stillNeeded');
    expect(deciding).not.toContain('superviseConsent.missingPhoto');
    expect(display(promptOf())).toContain('superviseConsent.missingPhoto');
  });

  it('the new wording is in every language the form speaks', () => {
    for (const key of ['superviseConsent.titleReturning', 'superviseConsent.subtitleReturningOne', 'superviseConsent.subtitleReturningMany']) {
      const entry = DICTIONARY[key]!;
      expect(Object.keys(entry).sort(), key).toEqual(Object.keys(DICTIONARY['superviseConsent.titleOne']!).sort());
      for (const [lang, value] of Object.entries(entry)) expect(value.trim(), `${key} ${lang}`).not.toBe('');
    }
    expect(DICTIONARY['superviseConsent.titleReturning']!.en).toBe('Welcome back');
  });
});

const policy: SupervisionPolicy = {
  bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'drop_off' }],
  siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, order: 0 }],
};
const maiSlot = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id: 'zz-mai', sourceLineId: 'zz-line', ticketType: {} as SupervisedSlot['ticketType'], name: 'ZZ TEST Mai', age: '6', waived: false,
  optIn: true, allergiesMedical: 'ZZ TEST peanuts', foodRestrictions: '', mayOrderFood: false, savedChildId: 'zz-child-mai', ...extra,
});

describe('the till’s own customer half', () => {
  const half = (slot: SupervisedSlot, extra: Record<string, unknown> = {}, updates: [string, Partial<SupervisedSlot>][] = []) =>
    renderHook((current: SupervisedSlot) => ConsentCapture({
      slots: [current], parentName: 'ZZ TEST Ploy', consentAck: true, policy, parentPhone: PHONE, parentContactMethod: 'whatsapp',
      onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined, onParentNameChange: () => undefined,
      onConsentAckChange: () => undefined, onUpdateChild: (id: string, patch: Partial<SupervisedSlot>) => { updates.push([id, patch]); },
      acknowledgedConfirmationIds: ['zz-confirm'], onToggleConfirmation: () => undefined,
      parentPhoneFixed: true, parentNameFixed: true, agreementsOnly: true, onDone: () => undefined, doneReady: true,
      profileNoteOf: () => 'ZZ TEST peanuts', ...extra,
    } as never), slot);

  it('has the returning family’s heading, and names no photo staff compare on the till', () => {
    const view = half(maiSlot(), { photoAtTillFor: ['zz-mai'] });
    const text = words(view.result.current);
    expect(text).toContain('superviseConsent.titleReturning');
    expect(text).toContain('superviseConsent.subtitleReturningOne');
    expect(text).not.toContain('superviseConsent.missingPhoto');
    view.unmount();
    const asked = half(maiSlot(), { photoAtTillFor: [] });
    expect(words(asked.result.current)).toContain('superviseConsent.missingPhoto');
    asked.unmount();
  });

  it('asks the "no allergies" tick before a saved child’s note is emptied; until then the till keeps it and Done waits', () => {
    const updates: [string, Partial<SupervisedSlot>][] = [];
    const view = half(maiSlot(), { photoAtTillFor: ['zz-mai'] }, updates);
    const box = () => elements(view.result.current).find((node) => node.props.testId === 'consent-allergies')!;
    const done = () => elements(view.result.current).find((node) => words(node.props.children) === 'common.done' && typeof node.props.onClick === 'function')!;
    const tick = () => elements(view.result.current).find((node) => node.props['data-testid'] === 'consent-allergies-none');
    expect(box().props.value).toBe('ZZ TEST peanuts');
    expect(tick()).toBeUndefined();
    expect(done().props.disabled).toBe(false);

    (box().props.onChange as (value: string) => void)('');
    view.rerender(maiSlot());
    expect(updates).toEqual([]); // the note stays with the till
    expect(box().props.value).toBe('');
    expect(tick()!.props.checked).toBe(false);
    expect(done().props.disabled).toBe(true);
    expect(words(view.result.current)).toContain('superviseConsent.careClearedLine:ZZ TEST Mai');

    // Ticked: the note goes, marked as the family's word, as the display sends it.
    (tick()!.props.onCheckedChange as (value: boolean) => void)(true);
    expect(updates.at(-1)).toEqual(['zz-mai', { allergiesMedical: '', careNoneConfirmed: true, careSource: undefined }]);
    view.rerender(maiSlot({ allergiesMedical: '', careNoneConfirmed: true }));
    expect(tick()!.props.checked).toBe(true);
    expect(done().props.disabled).toBe(false);

    // Taken back: the profile's note returns, and Done waits again.
    (tick()!.props.onCheckedChange as (value: boolean) => void)(false);
    expect(updates.at(-1)).toEqual(['zz-mai', { allergiesMedical: 'ZZ TEST peanuts', careNoneConfirmed: false, careSource: undefined }]);
    view.rerender(maiSlot({ careNoneConfirmed: false }));
    expect(box().props.value).toBe('');
    expect(done().props.disabled).toBe(true);

    // Written in: the family's note goes to the till, no tick asked.
    (box().props.onChange as (value: string) => void)('ZZ TEST sesame');
    expect(updates.at(-1)).toEqual(['zz-mai', { allergiesMedical: 'ZZ TEST sesame' }]);
    view.rerender(maiSlot({ allergiesMedical: 'ZZ TEST sesame' }));
    expect(tick()).toBeUndefined();
    expect(done().props.disabled).toBe(false);
    view.unmount();
  });

  it('the rule itself, and staff’s copy keeps the box as before', () => {
    expect(halfCareState({ allergiesMedical: 'ZZ TEST peanuts' }, false)).toEqual({ shown: 'ZZ TEST peanuts', asksTick: false, pending: false });
    expect(halfCareState({ allergiesMedical: 'ZZ TEST peanuts' }, true)).toEqual({ shown: '', asksTick: true, pending: true });
    expect(halfCareState({ allergiesMedical: '', careNoneConfirmed: true }, false)).toEqual({ shown: '', asksTick: true, pending: false });
    expect(halfCareState({ allergiesMedical: '' }, false)).toEqual({ shown: '', asksTick: false, pending: false });
    const updates: [string, Partial<SupervisedSlot>][] = [];
    const staff = half(maiSlot(), { staffScreen: true, onDone: undefined }, updates);
    const box = elements(staff.result.current).find((node) => node.props.testId === 'consent-allergies')!;
    (box.props.onChange as (value: string) => void)('');
    expect(updates).toEqual([['zz-mai', { allergiesMedical: '' }]]);
    staff.unmount();
  });
});

describe('the till wires it', () => {
  it('tells the display when the photos are staff’s, and gives its half the profile’s notes', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
    expect(till).toMatch(/const consentPhotoWithStaff = consentRows\.some\(photoMissing\)\s*&& consentRows\.filter\(photoMissing\)\.every\(row => photoStateOf\(row\.slot\) !== 'today'\);/);
    expect(till).toContain("...(consentPhotoWithStaff ? { photoWithStaff: true as const } : {}),");
    expect(till).toContain('profileNoteOf={(slot) => profileCareNote(slot, member?.savedChildren ?? [])}');
  });
});
