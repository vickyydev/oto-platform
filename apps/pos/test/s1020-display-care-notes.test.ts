import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentPromptSchema, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import type { ApiChild } from '@/api/platform';
import { PublicConsentCapture, careNeedsTick, carePending, mergeConsentDraft } from '@/components/till/PublicConsentCapture';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { consentSlotPatches, takeConsentAction } from '@/lib/consentForm';
import { displayCareLine, displayCarePatch, displayCareWrite, careShownFor, profileCareNote } from '@/lib/displayCareNotes';
import { saveGateChildren } from '@/lib/gateChildren';
import { DICTIONARY } from '@/i18n/dictionary';
import type { Member } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-1020 — A SAVED CHILD'S CARE NOTES ON THE CUSTOMER DISPLAY (the
 * owner's answer of 19 November: a saved child's allergy and medical notes
 * are shown to the parent on the customer display, and the parent may update
 * them there). Until now the display said "Saved on your profile, tell the
 * team if anything has changed", and only staff could open the notes.
 *
 * These tests pin, in order:
 *
 * 1. the display shows the note of each saved child in care, in the care
 *    step and on the agreements-only form, and a form without the till's mark
 *    is the form as it was;
 * 2. an emptied note is never sent without the family's "no allergies":
 *    the box stands empty, Done waits and says why, and the tick sends it;
 * 3. what the till takes from each step, and what it tells the cashier;
 * 4. the write: the family's change goes on its own, naming the display and
 *    the family, and the rest of a child's changes as before;
 * 5. the till wires it, and the words exist in every language.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const PEANUTS = 'ZZ TEST peanuts';
type PromptSlot = ConsentPrompt['slots'][number];
const mai = (extra: Partial<PromptSlot> = {}): PromptSlot => ({ id: 'zz-mai', name: 'ZZ TEST Mai', ageYears: 6,
  requirement: 'drop_off', saved: true, careShown: true, allergiesMedical: PEANUTS, ...extra });
const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ConsentPromptSchema.parse({
  kind: 'consent', requestId: 'zz-1020-request', visitorId: 'zz-1020-visitor', slots: [mai()],
  guardianName: 'ZZ TEST Ploy', guardianPhone: '+66898020001', contactChannel: 'whatsapp', consentRequired: true,
  consentAcknowledged: true, confirmations: [{ id: 'zz-rule', text: 'ZZ TEST rule', required: true, acknowledged: true }],
  staffReady: true, canContinue: true, completed: false, familyStep: 'agreements',
  phoneFixed: true, guardianFixed: true, agreementsOnly: true, ...extra,
});

function open(initial: ConsentPrompt) {
  const sent: ConsentAction[] = [];
  const view = renderHook((prompt: ConsentPrompt) => PublicConsentCapture({ prompt, busy: false, onAction: (action) => { sent.push(action); } }), initial);
  const all = () => elements(view.result.current);
  const byTest = (id: string) => all().filter((node) => node.props['data-testid'] === id || node.props.testId === id);
  const button = (label: string) => all().find((node) => typeof node.props.onClick === 'function' && words(node.props.children) === label);
  return { view, sent, all, byTest, button, text: () => words(view.result.current) };
}
const fills = (sent: ConsentAction[]) => sent.filter((action): action is Extract<ConsentAction, { action: 'fill' }> => action.action === 'fill');

describe('SCRUM-1020 (1): the display shows a saved child\'s care notes to update', () => {
  it('on the agreements-only form: the note in its box, from the profile, under the child', () => {
    const form = open(promptOf());
    expect(form.byTest('consent-child-shown')).toHaveLength(1);
    expect(form.byTest('consent-saved-care')).toHaveLength(1);
    const box = form.byTest('consent-saved-allergies')[0]!;
    expect(box.props.value).toBe(PEANUTS);
    const card = words(form.byTest('consent-child-shown')[0]);
    expect(card).toContain('superviseConsent.allergiesMedical');
    expect(card).toContain('superviseConsent.careFromProfile');
    // (The parent's name from the profile still says "Saved on your profile".)
    expect(card).not.toContain('superviseConsent.savedOnProfile');
    // Nothing to confirm while the note has text.
    expect(form.byTest('public-consent-allergies-none')).toHaveLength(0);
    form.view.unmount();
  });

  it('in the care step of the three-step form, for the saved child; food notes stay the profile\'s', () => {
    const form = open(promptOf({ agreementsOnly: undefined, familyStep: 'care' }));
    // The display opens on the step the till last heard.
    expect(form.byTest('consent-care')).toHaveLength(1);
    expect(form.byTest('consent-saved-allergies')[0]!.props.value).toBe(PEANUTS);
    expect(form.byTest('consent-saved-care')).toHaveLength(1);
    expect(form.byTest('consent-dietary')).toHaveLength(0);
    form.view.unmount();
  });

  it('a saved child without the till\'s mark (an older till or station) keeps "Saved on your profile"', () => {
    const form = open(promptOf({ slots: [mai({ careShown: undefined, allergiesMedical: undefined })] }));
    expect(form.byTest('consent-saved-care')).toHaveLength(0);
    expect(form.text()).not.toContain(PEANUTS);
    const care = open(promptOf({ agreementsOnly: undefined, familyStep: 'care', slots: [mai({ careShown: undefined })] }));
    expect(care.text()).toContain('superviseConsent.savedOnProfile');
    expect(care.byTest('consent-saved-care')).toHaveLength(0);
    form.view.unmount(); care.view.unmount();
  });

  it('a child reception adds in "Edit details" arrives on the family\'s open form, nothing they typed lost', async () => {
    const form = open(promptOf({ agreementsOnly: undefined, familyStep: 'children' }));
    const added = promptOf({ agreementsOnly: undefined, familyStep: 'children', requestId: 'zz-1020-request-added',
      consentAcknowledged: true, slots: [mai(), { id: 'zz-new', name: '', ageYears: null, requirement: 'none',
        allergiesMedical: '', foodRestrictions: '' }], canContinue: false });
    // The till's next copy carries one more place: the screen draws it at once.
    expect(() => form.view.rerender(added)).not.toThrow();
    expect(form.byTest('consent-child')).toHaveLength(2);
    expect(form.byTest('consent-child-name').map((node) => node.props.value)).toEqual(['ZZ TEST Mai', '']);
    // The new child is the family's to name before they go on.
    expect(form.text()).toContain('superviseConsent.nameAndAgeFirst');
    form.view.unmount();
  });

  it('the family\'s change goes to the till as they type it', async () => {
    const form = open(promptOf());
    (form.byTest('consent-saved-allergies')[0]!.props.onChange as (v: string) => void)(`${PEANUTS}, eggs`);
    form.view.rerender(promptOf());
    await vi.advanceTimersByTimeAsync(1_100);
    const sent = fills(form.sent);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)!.slots).toEqual([expect.objectContaining({ id: 'zz-mai', allergiesMedical: `${PEANUTS}, eggs` })]);
    expect(sent.at(-1)!.slots[0]).not.toHaveProperty('allergiesNone');
    form.view.unmount();
  });
});

describe('SCRUM-1020 (2): an emptied note is never sent without the family\'s plain "no allergies"', () => {
  it('the box stands empty, the tick is asked, Done waits and says why; nothing reaches the till', async () => {
    const form = open(promptOf());
    (form.byTest('consent-saved-allergies')[0]!.props.onChange as (v: string) => void)('');
    form.view.rerender(promptOf());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fills(form.sent)).toHaveLength(0);
    expect(form.byTest('consent-saved-allergies')[0]!.props.value).toBe('');
    expect(form.byTest('public-consent-allergies-none')).toHaveLength(1);
    expect(form.text()).toContain('superviseConsent.noAllergiesConfirm:ZZ TEST Mai');
    expect(form.text()).toContain('superviseConsent.careClearedLine:ZZ TEST Mai');
    expect(form.button('common.done')!.props.disabled).toBe(true);
    form.view.unmount();
  });

  it('the tick sends the empty note with their word; the till then holds it, and Done is theirs to press', async () => {
    const form = open(promptOf());
    (form.byTest('consent-saved-allergies')[0]!.props.onChange as (v: string) => void)('');
    form.view.rerender(promptOf());
    (form.byTest('public-consent-allergies-none')[0]!.props.onCheckedChange as (v: boolean) => void)(true);
    form.view.rerender(promptOf());
    await vi.advanceTimersByTimeAsync(50);
    const sent = fills(form.sent).at(-1)!;
    expect(sent.slots[0]).toMatchObject({ id: 'zz-mai', allergiesMedical: '', allergiesNone: true });
    expect(ConsentPromptSchema.safeParse(promptOf()).success).toBe(true);
    // The till's next copy: the note is empty on the family's word.
    const held = promptOf({ requestId: 'zz-1020-request-2', slots: [mai({ allergiesMedical: '', allergiesNone: true })] });
    form.view.rerender(held);
    expect(form.byTest('public-consent-allergies-none')[0]!.props.checked).toBe(true);
    expect(form.text()).not.toContain('superviseConsent.careClearedLine');
    expect(form.button('common.done')!.props.disabled).toBe(false);
    form.view.unmount();
  });

  it('the rule, read alone: the tick is asked only where a note had text or the family said none', () => {
    expect(careNeedsTick(mai(), { allergiesMedical: '' })).toBe(true);
    expect(careNeedsTick(mai(), { allergiesMedical: 'ZZ TEST eggs' })).toBe(false);
    expect(careNeedsTick(mai({ allergiesMedical: '' }), { allergiesMedical: '' })).toBe(false);
    expect(careNeedsTick(mai({ allergiesMedical: '', allergiesNone: true }), { allergiesMedical: '' })).toBe(true);
    expect(careNeedsTick(mai({ careShown: undefined }), { allergiesMedical: '' })).toBe(false);
    expect(carePending(mai(), { allergiesMedical: '', allergiesNone: true })).toBe(false);
    expect(carePending(mai(), { allergiesMedical: '' })).toBe(true);
  });

  it('a copy from the till keeps the family\'s emptied box and their tick, field by field', () => {
    const base = { slots: { a: { name: 'Mai', dateOfBirth: null, ageYears: 6, allergiesMedical: PEANUTS, foodRestrictions: '', allergiesNone: false } },
      guardianName: '', guardianPhone: '', consentAcknowledged: false, confirmations: [] as string[] };
    const local = { ...base, slots: { a: { ...base.slots.a, allergiesMedical: '', allergiesNone: true } } };
    // Staff changed nothing of the note meanwhile: the family's stay.
    expect(mergeConsentDraft(local, base, base).slots.a).toMatchObject({ allergiesMedical: '', allergiesNone: true });
    // Staff wrote a new note on the till: theirs wins, and the tick with it.
    const fromTill = { ...base, slots: { a: { ...base.slots.a, allergiesMedical: 'ZZ TEST eggs' } } };
    expect(mergeConsentDraft(local, base, fromTill).slots.a.allergiesMedical).toBe('ZZ TEST eggs');
  });

  it('the station takes "no allergies" only for a saved child whose notes the form shows', async () => {
    const { consentActionAllowed, ConsentActionSchema } = await import('@oto/shared');
    const slotOf = (allergiesNone?: true) => ({ id: 'zz-mai', name: 'ZZ TEST Mai', dateOfBirth: null, ageYears: 6,
      allergiesMedical: '', foodRestrictions: '', ...(allergiesNone ? { allergiesNone } : {}) });
    const fillOf = (slots: Record<string, unknown>[]) => ({ action: 'fill', requestId: 'zz-1020-request', visitorId: 'zz-1020-visitor',
      slots, guardianName: 'ZZ TEST Ploy', consentAcknowledged: true, acknowledgedConfirmationIds: ['zz-rule'] });
    const fill = (allergiesNone?: true) => ConsentActionSchema.parse(fillOf([slotOf(allergiesNone)]));
    expect(consentActionAllowed(promptOf(), fill(true))).toBe(true);
    expect(consentActionAllowed(promptOf({ slots: [mai({ careShown: undefined })] }), fill(true))).toBe(false);
    expect(consentActionAllowed(promptOf({ slots: [mai({ saved: undefined })] }), fill(true))).toBe(false);
    expect(ConsentActionSchema.safeParse(fillOf([{ ...slotOf(), allergiesNone: false }])).success).toBe(false);
  });
});

const slot = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id: 'zz-mai', sourceLineId: 'line', ticketType: {} as SupervisedSlot['ticketType'], name: 'ZZ TEST Mai', age: '6', waived: false,
  allergiesMedical: PEANUTS, foodRestrictions: '', mayOrderFood: false, savedChildId: 'zz-child-mai', ...extra,
});
const filled = (allergiesMedical: string, allergiesNone?: true) => ({ id: 'zz-mai', name: 'ZZ TEST Mai', dateOfBirth: null,
  ageYears: 6, allergiesMedical, foodRestrictions: 'ZZ TEST typed food', ...(allergiesNone ? { allergiesNone } : {}) });

describe('SCRUM-1020 (3): what the till takes from the family\'s step, and tells the cashier', () => {
  it('takes their note, marked as theirs; never their food notes', () => {
    const care = { shown: ['zz-mai'], profileNote: () => PEANUTS };
    const [patch] = consentSlotPatches([slot()], [filled(`${PEANUTS}, eggs`)], care);
    expect(patch!.patch).toMatchObject({ allergiesMedical: `${PEANUTS}, eggs`, careSource: 'display', careNoneConfirmed: false });
    expect(patch!.patch).not.toHaveProperty('foodRestrictions');
  });

  it('a saved child the form did not show the notes for keeps the profile\'s, as before', () => {
    const [patch] = consentSlotPatches([slot()], [filled('ZZ TEST typed')], { shown: [], profileNote: () => PEANUTS });
    expect(patch!.patch).not.toHaveProperty('allergiesMedical');
    expect(consentSlotPatches([slot()], [filled('ZZ TEST typed')])[0]!.patch).not.toHaveProperty('allergiesMedical');
  });

  it('empty: kept without the tick, "none" with it, the profile\'s note back when the tick is taken back', () => {
    expect(displayCarePatch(slot(), filled(''), PEANUTS)).toBeNull();
    const none = displayCarePatch(slot(), filled('', true), PEANUTS);
    expect(none).toEqual({ allergiesMedical: '', careNoneConfirmed: true, careSource: 'display' });
    const confirmed = slot({ allergiesMedical: '', careNoneConfirmed: true, careSource: 'display' });
    expect(displayCarePatch(confirmed, filled('', true), PEANUTS)).toBeNull();
    expect(displayCarePatch(confirmed, filled(''), PEANUTS)).toEqual({ allergiesMedical: PEANUTS, careNoneConfirmed: false, careSource: undefined });
    // Nothing to confirm where there was no note at all.
    expect(displayCarePatch(slot({ allergiesMedical: '' }), filled('', true), '')).toBeNull();
    // The same note again changes nothing.
    expect(displayCarePatch(slot(), filled(PEANUTS), PEANUTS)).toBeNull();
  });

  it('the cashier is told what changed and from what, only for a change from the display', () => {
    expect(displayCareLine(slot({ allergiesMedical: `${PEANUTS}, eggs`, careSource: 'display' }), PEANUTS))
      .toBe(`The family updated ZZ TEST Mai's allergies / medical notes on the customer display: now “${PEANUTS}, eggs” (was “${PEANUTS}”).`);
    expect(displayCareLine(slot({ allergiesMedical: '', careSource: 'display', careNoneConfirmed: true }), PEANUTS))
      .toBe(`The family confirmed on the customer display that ZZ TEST Mai has no allergies or medical needs (was “${PEANUTS}”).`);
    expect(displayCareLine(slot({ allergiesMedical: 'ZZ TEST eggs', careSource: 'display' }), ''))
      .toBe('The family updated ZZ TEST Mai\'s allergies / medical notes on the customer display: now “ZZ TEST eggs” (there was no note).');
    // Staff's own change, or the profile's note again: nothing to say.
    expect(displayCareLine(slot({ allergiesMedical: 'ZZ TEST eggs' }), PEANUTS)).toBeNull();
    expect(displayCareLine(slot({ careSource: 'display' }), PEANUTS)).toBeNull();
  });

  it('a step through takeConsentAction carries the care context to the slot patches', () => {
    const updateSlot = vi.fn();
    takeConsentAction({ action: 'fill', requestId: 'r', visitorId: 'v', slots: [filled('ZZ TEST eggs')], guardianName: 'ZZ TEST Ploy',
      consentAcknowledged: true, acknowledgedConfirmationIds: [] }, {
      slots: [slot()], guardianPhone: '', signature: 's', care: { shown: ['zz-mai'], profileNote: () => PEANUTS },
      updateSlot, setGuardianName: vi.fn(), setGuardianPhone: vi.fn(), setContactChannel: vi.fn(), setConsentAcknowledged: vi.fn(),
      setAcknowledgedConfirmationIds: vi.fn(), setCompletedSignature: vi.fn(), askedForHelp: vi.fn(), answered: vi.fn(),
    });
    expect(updateSlot).toHaveBeenCalledWith('zz-mai', expect.objectContaining({ allergiesMedical: 'ZZ TEST eggs', careSource: 'display' }));
  });

  it('the form shows the notes for a saved child in care only, and reads the profile\'s note', () => {
    expect(careShownFor({ savedChildId: 'zz-child-mai' }, true)).toBe(true);
    expect(careShownFor({ savedChildId: 'zz-child-mai' }, false)).toBe(false);
    expect(careShownFor({}, true)).toBe(false);
    expect(profileCareNote({ savedChildId: 'zz-child-mai' }, [{ id: 'zz-child-mai', allergiesMedical: PEANUTS }])).toBe(PEANUTS);
    expect(profileCareNote({ savedChildId: 'zz-other' }, [{ id: 'zz-child-mai', allergiesMedical: PEANUTS }])).toBe('');
  });
});

describe('SCRUM-1020 (4): the write names the display and the family, apart from staff\'s changes', () => {
  it('splits the family\'s note from the rest; staff\'s changes go as before', () => {
    expect(displayCareWrite(slot({ careSource: 'display' }), { allergies: 'ZZ TEST eggs', name: 'ZZ TEST Mai T' }))
      .toEqual({ care: { allergies: 'ZZ TEST eggs' }, rest: { name: 'ZZ TEST Mai T' } });
    expect(displayCareWrite(slot({ careSource: 'display', careNoneConfirmed: true }), { allergies: null }))
      .toEqual({ care: { allergies: null, confirmedNone: true }, rest: null });
    expect(displayCareWrite(slot(), { allergies: null })).toEqual({ care: null, rest: { allergies: null } });
    expect(displayCareWrite(slot({ careSource: 'display' }), { name: 'x' })).toEqual({ care: null, rest: { name: 'x' } });
  });

  const apiChild = (allergies: string | null, name = 'ZZ TEST Mai'): ApiChild => ({ id: 'zz-child-mai', name, dateOfBirth: null, ageYears: 6,
    allergies, medicalNotes: null, medicalAlert: !!allergies, dietary: null, foodRestrictions: null, notes: null, lastConfirmedAt: null } as ApiChild);
  const guardian = { id: 'zz-family', phone: '+66898020001', nickname: 'ZZ TEST Ploy',
    savedChildren: [{ id: 'zz-child-mai', childName: 'ZZ TEST Mai', childAge: 6, allergiesMedical: PEANUTS }] } as unknown as Member;

  it('the gate writes the family\'s "none" on its own, for the family it is saved on', async () => {
    const care = vi.fn(async (_id: string, c: { allergies: string | null }) => ({ child: apiChild(c.allergies) }));
    const update = vi.fn(async () => ({ child: apiChild(null) }));
    await saveGateChildren({ guardian, slots: [{ slot: slot({ allergiesMedical: '', careSource: 'display', careNoneConfirmed: true }), age: 6 }],
      childIdFor: () => 'unused', matchedSlots: new Map(), addChild: vi.fn(), updateChild: update,
      updateChildCareFromDisplay: care, onSaved: vi.fn() });
    expect(care).toHaveBeenCalledWith('zz-child-mai', { allergies: null, confirmedNone: true }, 'zz-family');
    expect(update).not.toHaveBeenCalled();
  });

  it('staff\'s note, or a till without the display write, goes through the one update as before', async () => {
    const care = vi.fn();
    const update = vi.fn(async () => ({ child: apiChild('ZZ TEST eggs') }));
    await saveGateChildren({ guardian, slots: [{ slot: slot({ allergiesMedical: 'ZZ TEST eggs' }), age: 6 }],
      childIdFor: () => 'unused', matchedSlots: new Map(), addChild: vi.fn(), updateChild: update,
      updateChildCareFromDisplay: care, onSaved: vi.fn() });
    expect(care).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('zz-child-mai', { allergies: 'ZZ TEST eggs' });
  });
});

describe('SCRUM-1020 (5): the till wires it', () => {
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');

  it('publishes the note of each saved child in care, with the family\'s "none"', () => {
    expect(till).toContain('...(slot.savedChildId ? { saved: true, ...(careShownFor(slot, outcome.needsConsent) ? {');
    expect(till).toContain('careShown: true, allergiesMedical: slot.allergiesMedical.slice(0, 500),');
    expect(till).toContain("...(slot.careNoneConfirmed && !slot.allergiesMedical.trim() ? { allergiesNone: true } : {}),");
  });

  it('takes the family\'s steps with the care it published; a change on the till is the till\'s', () => {
    expect(till).toMatch(/care: \{ shown: prompt\.data\.slots\.flatMap\(\(slot\) => \(slot\.saved && slot\.careShown \? \[slot\.id\] : \[\]\)\),/);
    const update = till.slice(till.indexOf('const handleUpdateSlot = '), till.indexOf('const handleToggleWaiver'));
    expect(update).toContain("'allergiesMedical' in patch && !('careSource' in patch)");
    expect(update).toContain('careSource: undefined, careNoneConfirmed: undefined');
  });

  it('tells the cashier as it happens, and writes the family\'s change naming the display', () => {
    expect(till).toContain('data-testid="consent-display-care">{line}</p>)}');
    expect(till).toContain('membersApi.updateChildCareFromDisplay(childId, { ...care, memberId }),');
    const platform = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'api', 'platform.ts'), 'utf8');
    expect(platform).toContain("cloudMembersApi.updateChild(childId, { source: 'customer_display', ...care })");
    // The box's fact stays the child.update it has always taken.
    expect(platform).toContain("onBox<{ child: ApiChild }>(stationId, 'child.update', { childId, allergies: care.allergies })");
  });

  it('every new word is there in all five languages', () => {
    for (const key of ['superviseConsent.careFromProfile', 'superviseConsent.noAllergiesConfirm', 'superviseConsent.careClearedLine']) {
      const entry = DICTIONARY[key]!;
      for (const lang of ['en', 'zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).toBeTruthy();
      for (const lang of ['zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).not.toBe(entry.en);
    }
    expect(DICTIONARY['superviseConsent.noAllergiesConfirm']!.th).toContain('{{name}}');
  });
});
