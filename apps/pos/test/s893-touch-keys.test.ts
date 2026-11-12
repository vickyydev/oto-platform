import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentPrompt } from '@oto/shared';
import { renderHook } from './support/hooks';
import { TouchText, keepKeysInView } from '@/components/till/TouchText';
import { ScreenKeyboard } from '@/components/till/ScreenKeyboard';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';

/**
 * SCRUM-893 / SCRUM-894 — EVERY BOX OF THE FAMILY'S FORM OPENS THE ON-SCREEN
 * KEYBOARD, AND THE BOX BEING TYPED IN STAYS IN VIEW ABOVE IT.
 *
 * On the counter's touch monitor (`/display?keyboard=screen`, no keyboard) the
 * drop-off and nanny form's allergies and medical box was a plain text box: a
 * family could not type a child's allergies. Every text box of the form is now
 * one `TouchText`, on the paired display and on the till's customer half: a
 * touch opens the same keys the nickname box opens, the allergies box keeps its
 * several lines, and the keys type into the box (and so to the till, as any
 * typing does). As the keys open, the box and its keys are scrolled into view,
 * and only one set of keys is open at a time.
 *
 * The real layout at the counter display's two shapes, the keys typing into
 * each box and reaching the till's copy, are driven in a browser in
 * `s893-family-form-touch-browser.test.ts`.
 */
const seam = vi.hoisted(() => ({ flags: { screenKeyboard: false } }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
vi.mock('@/lib/kioskFlags', async () => ({
  ...await vi.importActual<typeof import('@/lib/kioskFlags')>('@/lib/kioskFlags'),
  kioskFlags: seam.flags,
}));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ t: (key: string) => key, lang: 'en', setLang: () => undefined }),
  tFor: () => (key: string) => key,
}));

beforeEach(() => { seam.flags.screenKeyboard = false; vi.stubGlobal('React', React); });

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as React.ReactNode)];
}

function box(props: Partial<Parameters<typeof TouchText>[0]> = {}) {
  const state = { value: props.value ?? '' };
  const view = renderHook(() => TouchText({ ...props, value: state.value, onChange: (next) => { state.value = next; } }));
  const field = () => nodes(view.result.current).find((node) => node.type === Input || node.type === Textarea)!;
  const keyboard = () => nodes(view.result.current).find((node) => node.type === ScreenKeyboard);
  const holder = () => view.result.current as Node;
  return { state, view, field, keyboard, holder, touch: () => { (field().props.onClick as () => void)(); view.rerender(); } };
}

describe('the touch text box', () => {
  it('without a keyboard of its own is the plain box, the allergies box the plain textarea it always was', () => {
    const name = box({ placeholder: 'superviseConsent.fullName' });
    expect(name.field().type).toBe(Input);
    expect(name.field().props.onClick).toBeUndefined();
    const allergies = box({ multiline: true, maxLength: 500 });
    expect(allergies.field().type).toBe(Textarea);
    expect(allergies.field().props.inputMode).toBeUndefined();
    expect(allergies.keyboard()).toBeUndefined();
  });

  it('on a screen with none, the allergies box opens the keys, keeps its lines and types into the box', () => {
    seam.flags.screenKeyboard = true;
    const allergies = box({ multiline: true, maxLength: 500 });
    expect(allergies.field().type).toBe(Textarea);
    expect(allergies.field().props.inputMode).toBe('none');
    expect(allergies.keyboard()).toBeUndefined();
    allergies.touch();
    const keys = allergies.keyboard()!.props as { onChange: (v: string) => void; onDone: () => void; maxLength?: number };
    // The box's own bound, not the nickname's hundred: allergies take five hundred.
    expect(keys.maxLength).toBe(500);
    keys.onChange('Peanuts');
    expect(allergies.state.value).toBe('Peanuts');
    keys.onDone();
    expect(allergies.keyboard()).toBeUndefined();
  });

  it('a box told the screen has its own keyboard stays plain, whatever the page says (the staff copy)', () => {
    seam.flags.screenKeyboard = true;
    const staff = box({ screenKeyboard: false });
    expect(staff.field().type).toBe(Input);
    expect(staff.field().props.onClick).toBeUndefined();
  });

  it('a long value typed on the keys is cut at the box’s own length', () => {
    seam.flags.screenKeyboard = true;
    const dietary = box({ maxLength: 5 });
    dietary.touch();
    (dietary.keyboard()!.props.onChange as (v: string) => void)('Halal food');
    expect(dietary.state.value).toBe('Halal');
  });

  it('scrolls the box and its keys into view as the keys open (SCRUM-894)', () => {
    seam.flags.screenKeyboard = true;
    const care = box({ multiline: true });
    const scrolled = vi.fn();
    (care.holder().props.ref as { current: unknown }).current = { scrollIntoView: scrolled };
    care.touch();
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
    // A touch on a box whose keys are open brings them back into view, and keeps them open.
    care.touch();
    expect(scrolled).toHaveBeenCalledTimes(2);
    expect(care.keyboard()).toBeDefined();
  });

  it('opening another box’s keys puts these away: one set of keys at a time', () => {
    seam.flags.screenKeyboard = true;
    const allergies = box({ multiline: true });
    const dietary = box();
    allergies.touch();
    expect(allergies.keyboard()).toBeDefined();
    dietary.touch();
    expect(dietary.keyboard()).toBeDefined();
    allergies.view.rerender();
    expect(allergies.keyboard()).toBeUndefined();
    allergies.view.unmount();
    dietary.view.unmount();
  });

  it('keepKeysInView is quiet with nothing to scroll', () => {
    expect(() => keepKeysInView(null)).not.toThrow();
    expect(() => keepKeysInView({} as HTMLElement)).not.toThrow();
  });
});

describe('the paired display’s care step', () => {
  const prompt: ConsentPrompt = {
    kind: 'consent', requestId: 'zz-893', visitorId: 'zz-893-visitor',
    slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' }],
    guardianName: '', guardianPhone: '+66898930001', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'care',
    consentRequired: true, consentAcknowledged: false, confirmations: [],
    staffReady: false, canContinue: false, completed: false,
  };

  it('draws the allergies box and the dietary box as touch text boxes, the allergies one with its lines', () => {
    seam.flags.screenKeyboard = true;
    const view = renderHook(() => PublicConsentCapture({ prompt, busy: false, onAction: () => undefined }));
    const boxes = nodes(view.result.current).filter((node) => node.type === TouchText);
    const allergies = boxes.find((node) => node.props.testId === 'consent-allergies');
    const dietary = boxes.find((node) => node.props.testId === 'consent-dietary');
    expect(allergies?.props.multiline).toBe(true);
    expect(allergies?.props.maxLength).toBe(500);
    expect(dietary?.props.maxLength).toBe(200);
    // No plain textarea is left on the form for a family with no keyboard.
    expect(nodes(view.result.current).some((node) => node.type === Textarea)).toBe(false);
    view.unmount();
  });
});

describe('where it is used', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '../src', rel), 'utf8').replace(/\r\n/g, '\n');

  it('every text box of the family’s form, on the display and on the till’s customer half, is a touch text box', () => {
    const display = src('components/till/PublicConsentCapture.tsx');
    const half = src('components/till/ConsentCapture.tsx');
    for (const form of [display, half]) {
      expect(form).not.toMatch(/<Textarea\b/);
      expect(form).not.toMatch(/<Input\b/);
      for (const testId of ['consent-child-name', 'consent-allergies', 'consent-dietary', 'consent-guardian']) {
        expect(form).toContain(`testId="${testId}"`);
      }
    }
    // The customer half brings the keys only for the family's own half, never on the staff copy.
    expect(half).toContain('const screenKeyboard = !staffScreen && kioskFlags.screenKeyboard;');
    expect(half.match(/screenKeyboard=\{screenKeyboard\}/g)).toHaveLength(4);
    expect(half).toContain('showKeypad={screenKeyboard}');
  });
});
