import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentAction, ConsentPrompt } from '@oto/shared';
import { LIVE_FILL_MS, PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-1041 — TWO DISPLAYS ON ONE TILL, ONE FORM.
 *
 * Every display paired to a till shows the station's one copy of the drop-off
 * form. What the family types or presses on one display reaches the till once
 * (the station keeps one answer at a time and refuses a second made on the
 * same copy) and shows on the others when the till's next copy arrives. Each
 * field is settled by the rule the till and one display already follow
 * (`mergeConsentDraft`): a display takes the till's value for a field it has
 * not changed, keeps its own typing that has not reached the till yet, and
 * gives way where the till took another display's change first. The step the
 * family is on follows the same rule, so the displays move through the form
 * together and none pulls the others back.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

type Slot = ConsentPrompt['slots'][number];
const child = (id: string, extra: Partial<Slot> = {}): Slot => ({ id, name: '', ageYears: null, requirement: 'none',
  dateOfBirth: null, allergiesMedical: '', foodRestrictions: '', ...extra });
const first: ConsentPrompt = {
  kind: 'consent', requestId: 'zz-1041-1', visitorId: 'zz-1041-visitor',
  slots: [child('a'), child('b')],
  guardianName: '', guardianPhone: '+66898104101', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'children',
  consentRequired: true, consentAcknowledged: false,
  confirmations: [{ id: 'pickup', text: 'ZZ TEST pick-up before closing', required: true, acknowledged: false }],
  staffReady: false, canContinue: false, completed: false,
};
type Fill = Extract<ConsentAction, { action: 'fill' }>;

function display(prompt: ConsentPrompt) {
  const sent: ConsentAction[] = [];
  const view = renderHook((p: ConsentPrompt) => PublicConsentCapture({ prompt: p, busy: false, answerPending: false,
    onAction: (action) => { sent.push(action); } }), prompt);
  const all = () => elements(view.result.current);
  const byId = (id: string) => all().find((node) => node.props.id === id);
  const button = (label: string) => all().find((node) => words(node.props.children) === label && typeof node.props.onClick === 'function');
  return {
    view, sent,
    fills: () => sent.filter((action): action is Fill => action.action === 'fill'),
    value: (id: string) => byId(id)!.props.value as string,
    type: (id: string, value: string) => (byId(id)!.props.onChange as (v: string) => void)(value),
    press: (label: string) => (button(label)!.props.onClick as () => void)(),
    text: () => words(view.result.current),
  };
}

/** The till takes one answer and publishes its next copy of the form to every display. */
function station(displays: ReturnType<typeof display>[], start: ConsentPrompt = first) {
  let copy = start;
  let request = 1;
  return {
    get copy() { return copy; },
    take(fill: Fill) {
      request += 1;
      copy = { ...copy, requestId: `zz-1041-${request}`, guardianName: fill.guardianName,
        slots: copy.slots.map((slot) => {
          const filled = fill.slots.find((item) => item.id === slot.id);
          return filled ? { ...slot, name: filled.name, ageYears: filled.ageYears, dateOfBirth: filled.dateOfBirth,
            ...(filled.name && filled.ageYears !== null ? { requirement: 'drop_off' as const } : {}) } : slot;
        }),
        ...(fill.step ? { familyStep: fill.step } : {}),
      };
      for (const screen of displays) screen.view.rerender(copy);
    },
  };
}

describe('two displays show one form', () => {
  it('what the family types on one display shows on the other once the till has it, and the other sends nothing back', () => {
    const left = display(first);
    const right = display(first);
    const till = station([left, right]);
    left.type('consent-child-0', 'ZZ TEST Mai');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(left.fills()).toHaveLength(1);
    till.take(left.fills()[0]!);
    expect(right.value('consent-child-0')).toBe('ZZ TEST Mai');
    expect(left.value('consent-child-0')).toBe('ZZ TEST Mai');
    vi.advanceTimersByTime(5_000);
    expect(right.fills()).toHaveLength(0);
    expect(left.fills()).toHaveLength(1);
    left.view.unmount(); right.view.unmount();
  });

  it('a step pressed on one display moves the other with it, and neither pulls the form back', () => {
    const named = { ...first, slots: [child('a', { name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off' }),
      child('b', { name: 'ZZ TEST Nok', ageYears: 4, requirement: 'drop_off' })] };
    const left = display(named);
    const right = display(named);
    const till = station([left, right], named);
    expect(right.text()).toContain('superviseConsent.stepOf:1,3');
    // Continue on the left display: the step goes with the fill.
    left.press('common.continue');
    const step = left.fills().at(-1)!;
    expect(step.step).toBe('care');
    till.take(step);
    expect(right.text()).toContain('superviseConsent.stepOf:2,3');
    expect(left.text()).toContain('superviseConsent.stepOf:2,3');
    vi.advanceTimersByTime(5_000);
    // The right display sends no step of its own to pull the form back to the first.
    expect(right.fills().filter((fill) => fill.step === 'children')).toHaveLength(0);
    // Back on the right display moves the left one too.
    right.press('common.back');
    const back = right.fills().at(-1)!;
    expect(back.step).toBe('children');
    till.take(back);
    expect(left.text()).toContain('superviseConsent.stepOf:1,3');
    left.view.unmount(); right.view.unmount();
  });

  it('two families typing different fields at once keep both: the second goes once the till has the first', () => {
    const left = display(first);
    const right = display(first);
    const till = station([left, right]);
    left.type('consent-child-0', 'ZZ TEST Mai');
    right.type('consent-child-1', 'ZZ TEST Nok');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    // Both sent on the same copy: the station took the left one and refused the right one.
    expect(left.fills()).toHaveLength(1);
    expect(right.fills()).toHaveLength(1);
    till.take(left.fills()[0]!);
    // The right display shows the left one's child and keeps the child it typed.
    expect(right.value('consent-child-0')).toBe('ZZ TEST Mai');
    expect(right.value('consent-child-1')).toBe('ZZ TEST Nok');
    // The left display keeps what the till holds: the right display's typing has not reached it.
    expect(left.value('consent-child-1')).toBe('');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    const again = right.fills().at(-1)!;
    expect(again.requestId).toBe(till.copy.requestId);
    expect(again.slots.map((slot) => slot.name)).toEqual(['ZZ TEST Mai', 'ZZ TEST Nok']);
    till.take(again);
    expect(left.value('consent-child-0')).toBe('ZZ TEST Mai');
    expect(left.value('consent-child-1')).toBe('ZZ TEST Nok');
    left.view.unmount(); right.view.unmount();
  });

  it('the same field typed on both: the change the till took first shows on both', () => {
    const left = display(first);
    const right = display(first);
    const till = station([left, right]);
    left.type('consent-child-0', 'ZZ TEST Mai');
    right.type('consent-child-0', 'ZZ TEST Mint');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    till.take(left.fills()[0]!);
    expect(left.value('consent-child-0')).toBe('ZZ TEST Mai');
    expect(right.value('consent-child-0')).toBe('ZZ TEST Mai');
    vi.advanceTimersByTime(5_000);
    // Nothing is sent to take it back.
    expect(right.fills().filter((fill) => fill.requestId === till.copy.requestId)).toHaveLength(0);
    left.view.unmount(); right.view.unmount();
  });
});
