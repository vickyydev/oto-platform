import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { NicknameField } from '@/components/till/CustomerDisplay';
import { ScreenKeyboard } from '@/components/till/ScreenKeyboard';

/**
 * SCRUM-711 — THE COUNTER'S SCREEN BRINGS ITS OWN KEYBOARD.
 *
 * The counter box opens the customer display on a touch monitor with no
 * keyboard, at `/display?keyboard=screen`. The phone number has always had a
 * keypad on the page; the nickname had nothing. Pinned here: the flag, what the
 * keys type, and that the field is untouched for every screen without the flag.
 */
const seam = vi.hoisted(() => ({ flags: { screenKeyboard: false } }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
vi.mock('@/lib/kioskFlags', async () => ({
  ...await vi.importActual<typeof import('@/lib/kioskFlags')>('@/lib/kioskFlags'),
  kioskFlags: seam.flags,
}));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ t: (key: string) => key, lang: 'en', setLang: () => undefined }),
}));

// The runner compiles JSX to React.createElement; the till's build needs no such global.
beforeEach(() => { seam.flags.screenKeyboard = false; vi.stubGlobal('React', React); });

type Node = React.ReactElement<Record<string, unknown>>;

function nodes(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as React.ReactNode)];
}

/** One key of a keyboard, found the way a person finds it: by its letter, or its label. */
function key(tree: React.ReactNode, name: string): () => void {
  const found = nodes(tree).find((node) => node.type === 'button'
    && (node.props.children === name || node.props['aria-label'] === name));
  if (typeof found?.props.onClick !== 'function') throw new Error(`no key named ${name}`);
  return found.props.onClick as () => void;
}

/** A keyboard over a value, re-drawn after each press as its parent would. */
function typist(start = '', maxLength?: number) {
  const state = { value: start, done: 0 };
  const draw = () => ScreenKeyboard({
    value: state.value, onChange: (next) => { state.value = next; },
    onDone: () => { state.done += 1; }, doneLabel: 'Done', maxLength,
  });
  return { state, press: (...names: string[]) => { for (const name of names) key(draw(), name)(); }, draw };
}

describe('the keyboard=screen flag', () => {
  it('is set by that parameter and by nothing else', async () => {
    const { parseKioskFlags } = await vi.importActual<typeof import('@/lib/kioskFlags')>('@/lib/kioskFlags');
    expect(parseKioskFlags('?keyboard=screen').screenKeyboard).toBe(true);
    expect(parseKioskFlags('?a=1&keyboard=screen').screenKeyboard).toBe(true);
    for (const search of ['', '?keyboard=hardware', '?keyboard', '?screen=keyboard']) {
      expect(parseKioskFlags(search).screenKeyboard).toBe(false);
    }
  });
});

describe('the on-screen keyboard', () => {
  it('has every English letter, a space bar, backspace and done', () => {
    const { draw } = typist();
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(() => key(draw(), letter)).not.toThrow();
    for (const name of ['Space', 'Backspace', 'Done']) expect(() => key(draw(), name)).not.toThrow();
  });

  it('types a name as a name: a capital to start each word, lower case after', () => {
    const { state, press } = typist();
    press('M', 'I', 'A', 'Space', 'R', 'O');
    expect(state.value).toBe('Mia Ro');
  });

  it('backspace takes the last character, and on an empty field does nothing', () => {
    const { state, press } = typist('Mia');
    press('Backspace');
    expect(state.value).toBe('Mi');
    press('Backspace', 'Backspace', 'Backspace');
    expect(state.value).toBe('');
  });

  it('backspace takes a whole character the till handed over, not half of one', () => {
    const { state, press } = typist('Mia😀');
    press('Backspace');
    expect(state.value).toBe('Mia');
  });

  it('stops at the length the display intent accepts', () => {
    const atLimit = typist('x'.repeat(100));
    atLimit.press('A', 'Space');
    expect(atLimit.state.value).toHaveLength(100);
    const short = typist('Mi', 3);
    short.press('A', 'B');
    expect(short.state.value).toBe('Mia');
  });

  it('done says so, and changes nothing', () => {
    const { state, press } = typist('Mia');
    press('Done');
    expect(state).toEqual({ value: 'Mia', done: 1 });
  });
});

describe('the nickname field', () => {
  const field = (start = '') => {
    const state = { value: start };
    const view = renderHook(() => NicknameField({ value: state.value, onChange: (next) => { state.value = next; } }));
    const input = () => {
      const found = nodes(view.result.current).find((node) => node.props.placeholder !== undefined);
      if (!found) throw new Error('no input in the nickname field');
      return found;
    };
    const keyboard = () => nodes(view.result.current).find((node) => node.type === ScreenKeyboard);
    return { state, view, input, keyboard };
  };

  it('without the flag is the plain field: no keyboard, and nothing a touch could open', () => {
    const { view, input, keyboard } = field('Mia');
    expect(keyboard()).toBeUndefined();
    expect(input().props.onClick).toBeUndefined();
    expect(input().props.inputMode).toBeUndefined();
    expect(input().props.value).toBe('Mia');
    expect(input().props.className).not.toContain('md:text-2xl');
    // No wrapper around it either: the markup beside the label is as it always was.
    expect((view.result.current as Node).props.placeholder).toBe('till.identify.nicknamePlaceholder');
  });

  it('with the flag keeps the keys away until the field is touched, and the system keyboard away for good', () => {
    seam.flags.screenKeyboard = true;
    const { input, keyboard } = field();
    expect(keyboard()).toBeUndefined();
    expect(input().props.inputMode).toBe('none');
    expect(input().props.autoComplete).toBe('off');
    expect(input().props.className).toContain('md:text-2xl');
    (input().props.onClick as () => void)();
    expect(keyboard()).toBeDefined();
  });

  it('types into the same value the field shows, and done puts the keys away until the next touch', () => {
    seam.flags.screenKeyboard = true;
    const { state, view, input, keyboard } = field();
    (input().props.onClick as () => void)();
    const typed = keyboard()!.props as { onChange: (next: string) => void; onDone: () => void };
    typed.onChange('Mia');
    expect(state.value).toBe('Mia');
    typed.onDone();
    expect(keyboard()).toBeUndefined();
    view.rerender();
    expect(input().props.value).toBe('Mia');
    (input().props.onClick as () => void)();
    expect(keyboard()).toBeDefined();
  });
});

describe('where it is used', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '../src/components/till/CustomerDisplay.tsx'), 'utf8');

  it('both of the customer display\'s nickname fields go through it, and no other input draws one', () => {
    expect(src.match(/<NicknameField value=\{nickname\} onChange=\{onNicknameChange\} \/>/g)).toHaveLength(2);
    expect(src.match(/till\.identify\.nicknamePlaceholder/g)).toHaveLength(2); // the field's own two branches
  });

  it('the flag is read from the one module, not from the address again', () => {
    expect(src).toContain("from '@/lib/kioskFlags'");
    expect(src).not.toContain('location.search');
  });
});
