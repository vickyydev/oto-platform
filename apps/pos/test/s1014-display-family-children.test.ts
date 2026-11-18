import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildReviewPromptSchema, type ChildReviewAction, type ChildReviewPrompt } from '@oto/shared';
import { NEW_CHILD_SEND_MS, PublicSavedChildrenReview } from '@/components/shared/PublicSavedChildrenReview';
import { SavedChildrenReview } from '@/components/shared/SavedChildrenReview';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { MAX_CHILD_AGE } from '@/lib/childDob';
import { familyReviewChange, familyReviewChangeLine } from '@/lib/familyReviewChange';
import { goesAgainByItself } from '@/lib/displaySendQueue';
import type { SavedChild } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: actual.tFor('en') }) };
});
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-1014 — THE PARENT ADDS AND REMOVES SAVED CHILDREN ON THE CUSTOMER
 * DISPLAY (the owner's ruling of 19 November on SCRUM-497, point 22).
 *
 * The prototype's customer screen (`SavedChildrenReview.tsx`) lets the parent
 * pick "+ A new child" and type the child into the emptied place ("New —
 * we'll save this"), or press "Remove from saved", which takes the child off
 * the family's saved record and empties the place; ages stop at 12 (its
 * `MAX_CHILD_AGE`). The paired display used to send both to staff and offered
 * ages to 17. These tests pin, in order:
 *
 * 1. the display's review in the prototype's words, with ages to 12 and the
 *    allergy lines still kept off it;
 * 2. what each press sends to the till, a new child's name and age as they
 *    are typed (without locking the screen), and Done only once the till
 *    holds what the screen shows;
 * 3. what the till makes of each answer, and what it tells the cashier.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const REFERENCE = '2026-11-19';
type Slot = ChildReviewPrompt['slots'][number];
const saved = (extra: Partial<Slot> = {}): Slot => ({ id: 'place-1', savedChildId: 'zz-child-1', name: 'ZZ TEST Aya',
  dateOfBirth: '2020-01-01', ageYears: 6, confirmed: false, ...extra });
const empty = (extra: Partial<Slot> = {}): Slot => ({ id: 'place-2', savedChildId: null, name: '', dateOfBirth: null,
  ageYears: null, confirmed: false, ...extra });
const promptOf = (slots: Slot[], extra: Partial<ChildReviewPrompt> = {}): ChildReviewPrompt => ChildReviewPromptSchema.parse({
  kind: 'child_review', requestId: 'zz-1014-request', visitorId: 'zz-1014-visitor', referenceDate: REFERENCE, slots,
  choices: [{ id: 'zz-child-1', name: 'ZZ TEST Aya', dateOfBirth: '2020-01-01', ageYears: 6 },
    { id: 'zz-child-2', name: 'ZZ TEST Ben', dateOfBirth: null, ageYears: 8 }],
  save: { status: 'idle', slotId: null, actionId: null }, canContinue: false, ...extra,
});

describe('SCRUM-1014 (1): the display\'s review reads as the prototype\'s customer screen', () => {
  const review = (slots: React.ComponentProps<typeof SavedChildrenReview>['slots']) => elements(renderHook(() => SavedChildrenReview({
    slots, savedChildren: [{ id: 'zz-child-1', childName: 'ZZ TEST Aya', dateOfBirth: '2020-01-01', childAge: 6 }],
    confirmedIds: [], publicMode: true, publicReferenceDate: REFERENCE, lang: 'en', onStaffHelp: () => undefined,
    onUpdateSlot: () => undefined, onConfirmSlot: () => undefined, onAssignSaved: () => undefined, onMarkNew: () => undefined,
    onRemoveSaved: () => undefined, onBack: () => undefined, onContinue: () => undefined, canContinue: false,
  })).result.current);

  it('says "Remove from saved", "+ A new child" and "New — we\'ll save this", never "ask the team" for them', () => {
    const tree = review([{ id: 'a', savedChildId: 'zz-child-1', name: 'ZZ TEST Aya', age: '6', dateOfBirth: '2020-01-01',
      allergiesMedical: 'ZZ TEST peanuts' }, { id: 'b', name: '', age: '' }]);
    const text = words(tree);
    for (const shown of ['We saved their details from last time — check each one and confirm.', 'Remove from saved',
      '+ A new child', "New — we'll save this"]) expect(text).toContain(shown);
    expect(text.toLowerCase()).not.toContain('ask the team');
    expect(text).not.toContain('Adding or removing a child continues on the staff screen');
    // The allergy lines stay off the family's display (R-58), as before.
    expect(text).not.toContain('ZZ TEST peanuts');
  });

  it('lets the family type a new child\'s name and pick an age, which stops at 12', () => {
    const tree = review([{ id: 'b', name: '', age: '' }]);
    const input = tree.find((el) => el.props['aria-label'] === 'Child 1 name')!;
    expect(input.props.disabled).toBe(false);
    const picker = tree.find((el) => el.type === ChildDobPicker)!;
    expect(picker.props.disabled).toBe(false);
    expect(picker.props.maxAge).toBeUndefined();
    expect(MAX_CHILD_AGE).toBe(12);
  });

  it('no longer widens the display\'s picker to 17, and removes for itself', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/shared/SavedChildrenReview.tsx'), 'utf8');
    expect(source).not.toMatch(/maxAge=\{publicMode \? 17/);
    expect(source).toContain('onClick={() => onRemoveSaved(slot.id, slot.savedChildId!)}');
  });
});

interface Props { prompt: ChildReviewPrompt; busy?: boolean; answerPending?: boolean }
function open(initial: Props) {
  const sent: ChildReviewAction[] = [];
  let props = initial;
  const view = renderHook((p: Props) => PublicSavedChildrenReview({ prompt: p.prompt, busy: p.busy ?? false,
    answerPending: p.answerPending ?? p.busy ?? false, onAction: (action) => { sent.push(action); } }), initial);
  const inner = () => elements(view.result.current).find((el) => el.type === SavedChildrenReview)!.props as unknown as
    React.ComponentProps<typeof SavedChildrenReview>;
  const set = (next: Partial<Props>) => { props = { ...props, ...next }; view.rerender(props); };
  return { sent, inner, set };
}

describe('SCRUM-1014 (2): what the display sends to the till', () => {
  it('"+ A new child" empties the place, and "Remove from saved" names the saved child in it', () => {
    const form = open({ prompt: promptOf([saved()]) });
    form.inner().onMarkNew('place-1');
    form.inner().onRemoveSaved('place-1', 'zz-child-1');
    expect(form.sent).toEqual([
      { requestId: 'zz-1014-request', visitorId: 'zz-1014-visitor', action: 'select', slotId: 'place-1', choiceId: null },
      { requestId: 'zz-1014-request', visitorId: 'zz-1014-visitor', action: 'remove', slotId: 'place-1', savedChildId: 'zz-child-1' },
    ]);
  });

  it('sends nothing while an answer the screen waits on is out', () => {
    const form = open({ prompt: promptOf([saved()]), busy: true });
    form.inner().onMarkNew('place-1');
    form.inner().onRemoveSaved('place-1', 'zz-child-1');
    expect(form.sent).toEqual([]);
  });

  it('sends a new child\'s name and age once both are there and the typing pauses', () => {
    const form = open({ prompt: promptOf([empty()]) });
    form.inner().onUpdateSlot('place-2', { name: 'ZZ TEST Mali' });
    vi.advanceTimersByTime(NEW_CHILD_SEND_MS * 2);
    expect(form.sent).toEqual([]);
    form.inner().onUpdateSlot('place-2', { dateOfBirth: '2022-05-01', age: '4' });
    vi.advanceTimersByTime(NEW_CHILD_SEND_MS - 1);
    expect(form.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(form.sent).toEqual([{ requestId: 'zz-1014-request', visitorId: 'zz-1014-visitor', action: 'new_child',
      slotId: 'place-2', name: 'ZZ TEST Mali', dateOfBirth: '2022-05-01', ageYears: 4 }]);
  });

  it('keeps the screen open while the till takes the name, sends the rest after, and lets Done go once the till has it', () => {
    const form = open({ prompt: promptOf([empty()]) });
    form.inner().onUpdateSlot('place-2', { name: 'ZZ TEST Mal', dateOfBirth: '2022-05-01', age: '4' });
    vi.advanceTimersByTime(NEW_CHILD_SEND_MS);
    expect(form.sent).toHaveLength(1);
    // The till has the answer: the family keeps typing, nothing else goes yet.
    form.set({ answerPending: true });
    expect(form.inner().busy).toBe(false);
    form.inner().onUpdateSlot('place-2', { name: 'ZZ TEST Mali' });
    vi.advanceTimersByTime(NEW_CHILD_SEND_MS * 2);
    expect(form.sent).toHaveLength(1);
    // The till took the first name; the screen sends the name as it now reads.
    form.set({ answerPending: false, prompt: promptOf([empty({ name: 'ZZ TEST Mal', dateOfBirth: '2022-05-01', ageYears: 4 })],
      { requestId: 'zz-1014-request-2', canContinue: true }) });
    expect(form.inner().canContinue).toBe(false);
    vi.advanceTimersByTime(NEW_CHILD_SEND_MS);
    expect(form.sent.at(-1)).toMatchObject({ action: 'new_child', name: 'ZZ TEST Mali', requestId: 'zz-1014-request-2' });
    form.set({ prompt: promptOf([empty({ name: 'ZZ TEST Mali', dateOfBirth: '2022-05-01', ageYears: 4 })],
      { requestId: 'zz-1014-request-3', canContinue: true }) });
    expect(form.inner().canContinue).toBe(true);
    vi.advanceTimersByTime(NEW_CHILD_SEND_MS * 2);
    expect(form.sent).toHaveLength(2);
    form.inner().onContinue();
    expect(form.sent.at(-1)).toMatchObject({ action: 'done', requestId: 'zz-1014-request-3' });
  });

  it('a new child\'s name goes again by itself when its reply is lost, as the form\'s fill does', () => {
    expect(goesAgainByItself({ type: 'display.child_review', payload: { action: 'new_child' } })).toBe(true);
    for (const action of ['remove', 'select', 'confirm', 'done', 'staff_help']) {
      expect(goesAgainByItself({ type: 'display.child_review', payload: { action } })).toBe(false);
    }
  });
});

describe('SCRUM-1014 (3): what the till makes of the family\'s answers', () => {
  const savedChild: SavedChild = { id: 'zz-child-1', childName: 'ZZ TEST Aya', childAge: 6, dateOfBirth: '2020-01-01',
    savedAt: '', updatedAt: '' } as SavedChild;
  const held = { slots: [{ id: 'place-1', savedChildId: 'zz-child-1' }, { id: 'place-2', savedChildId: undefined }],
    savedChildren: [savedChild], referenceDate: REFERENCE };
  const fence = { requestId: 'r', visitorId: 'v' };

  it('"+ A new child" empties the place; "Remove from saved" takes the child in it off the record', () => {
    expect(familyReviewChange({ ...fence, action: 'select', slotId: 'place-1', choiceId: null }, held))
      .toEqual({ kind: 'mark_new', slotId: 'place-1' });
    const removal = familyReviewChange({ ...fence, action: 'remove', slotId: 'place-1', savedChildId: 'zz-child-1' }, held);
    expect(removal).toEqual({ kind: 'remove', slotId: 'place-1', child: savedChild });
    expect(familyReviewChangeLine(removal!)).toBe('The family removed ZZ TEST Aya from their saved children on the customer display.');
  });

  it('holds a new child\'s name and age in an empty place, and tells the cashier', () => {
    const named = familyReviewChange({ ...fence, action: 'new_child', slotId: 'place-2', name: ' ZZ TEST Mali ',
      dateOfBirth: '2022-05-01', ageYears: 4 }, held);
    expect(named).toEqual({ kind: 'name_new', slotId: 'place-2', patch: { name: 'ZZ TEST Mali', dateOfBirth: '2022-05-01', age: '4' } });
    expect(familyReviewChangeLine(named!)).toBe('The family added a new child on the customer display: ZZ TEST Mali, 4.');
  });

  it('takes nothing that no longer fits the places it holds', () => {
    for (const action of [
      { ...fence, action: 'remove', slotId: 'place-1', savedChildId: 'zz-child-2' },
      { ...fence, action: 'remove', slotId: 'place-2', savedChildId: 'zz-child-1' },
      { ...fence, action: 'remove', slotId: 'missing', savedChildId: 'zz-child-1' },
      { ...fence, action: 'new_child', slotId: 'place-1', name: 'ZZ TEST Mali', dateOfBirth: null, ageYears: 4 },
      { ...fence, action: 'new_child', slotId: 'place-2', name: 'ZZ TEST Mali', dateOfBirth: '2022-05-01', ageYears: 7 },
      { ...fence, action: 'new_child', slotId: 'place-2', name: 'ZZ TEST Mali', dateOfBirth: null, ageYears: 13 },
      { ...fence, action: 'select', slotId: 'place-1', choiceId: 'zz-child-1' },
      { ...fence, action: 'done' },
    ] as ChildReviewAction[]) expect(familyReviewChange(action, held), JSON.stringify(action)).toBeNull();
  });

  it('carries the removal out as the audited archive with the display named, and the gate\'s new child with it too', () => {
    const till = readFileSync(resolve(__dirname, '../src/pages/Till.tsx'), 'utf8');
    expect(till).toContain('await childrenApi.archive(saved.id, { fromDisplay: true });');
    expect(till).toMatch(/membersApi\.addChild\(memberId, body, id,\s+\[\.\.\.reviewDisplaySlotsRef\.current\]/);
    // A new place no longer keeps the review off the display.
    expect(till).not.toContain('superSlots.every(slot => !!slot.savedChildId)');
    const members = readFileSync(resolve(__dirname, '../src/api/members.ts'), 'utf8');
    expect(members).toContain("options.fromDisplay ? '?source=customer_display' : ''");
  });
});
