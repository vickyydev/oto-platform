import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { LANGUAGES, type SupportedLang } from '@/i18n/types';
import {
  languageChoiceMade,
  languageChoiceOpen,
  languageChoiceStart,
  settleLanguageChoice,
  useLanguageChoice,
  type LanguageChoiceState,
} from '@/lib/languageChoice';

/**
 * SCRUM-763 — THE LANGUAGE GATE THE TILL AND THE PAIRED DISPLAY HOLD.
 *
 * `useLanguageChoice` run as React runs it (`support/hooks`): the choice is
 * open on a sale's first screen, closed once the guest presses, kept through
 * the steps of their visit, and open again for the next guest — on the very
 * render the next guest's first screen appears, so they never see the last
 * guest's phone-number step. And the small language button still changes the
 * language after the choice, without bringing the choice back.
 */
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
const seam = vi.hoisted(() => ({ lang: 'en' as 'en' | 'zh' | 'th' | 'ru' | 'fr' }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return {
    ...actual,
    useLanguage: () => ({ lang: seam.lang, setLang: (next: SupportedLang) => { seam.lang = next; }, t: actual.tFor(seam.lang) }),
  };
});

// The runner compiles JSX to React.createElement; the till's build needs no such global.
beforeEach(() => { seam.lang = 'en'; vi.stubGlobal('React', React); });

type Screen = { atStart: boolean; saleKey: string | null };
const gate = (first: Screen) => renderHook(({ atStart, saleKey }: Screen) => useLanguageChoice(atStart, saleKey), first);

describe('the till’s customer half (it knows its sale)', () => {
  it('opens on the first screen, closes on a press, and stays closed through the visit', () => {
    const view = gate({ atStart: true, saleKey: '0' });
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    expect(view.result.current.open).toBe(false);
    // Typing the number re-draws the first screen: never the choice again.
    for (let i = 0; i < 3; i += 1) {
      view.rerender({ atStart: true, saleKey: '0' });
      expect(view.result.current.open).toBe(false);
    }
    for (let i = 0; i < 4; i += 1) {
      view.rerender({ atStart: false, saleKey: '0' });
      expect(view.result.current.open).toBe(false);
    }
  });

  it('a finished or cancelled sale (resetSale moves the epoch) opens it for the next guest, on that very render', () => {
    const view = gate({ atStart: true, saleKey: '0' });
    view.result.current.choose();
    view.rerender({ atStart: false, saleKey: '0' });
    view.rerender({ atStart: true, saleKey: '1' });
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    expect(view.result.current.open).toBe(false);
  });

  it('a sale reset on its own first screen still asks the next guest', () => {
    const view = gate({ atStart: true, saleKey: '4' });
    view.result.current.choose();
    view.rerender({ atStart: true, saleKey: '5' });
    expect(view.result.current.open).toBe(true);
  });

  it('a resumed sale that opens on its payment shows no choice there', () => {
    const view = gate({ atStart: false, saleKey: '2' });
    expect(view.result.current.open).toBe(false);
  });
});

describe('a paired display (it is told the stage, not the sale)', () => {
  it('back at the first screen from any other is the next guest', () => {
    const view = gate({ atStart: false, saleKey: null }); // not paired yet, or the idle screen
    view.rerender({ atStart: true, saleKey: null });
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    view.rerender({ atStart: true, saleKey: null });
    expect(view.result.current.open).toBe(false);
    view.rerender({ atStart: false, saleKey: null }); // welcome, order, … thank-you
    expect(view.result.current.open).toBe(false);
    view.rerender({ atStart: true, saleKey: null }); // the next sale's first screen
    expect(view.result.current.open).toBe(true);
  });
});

describe('the rule itself', () => {
  const states: LanguageChoiceState[] = [];
  for (const chosen of [false, true]) for (const leftStart of [false, true]) for (const saleKey of [null, 'a', 'b']) {
    states.push({ chosen, leftStart, saleKey });
  }

  it('settling never changes what is on the screen: the screen is drawn from the state before it settles', () => {
    for (const state of states) for (const atStart of [false, true]) for (const saleKey of [null, 'a', 'b']) {
      const settled = settleLanguageChoice(state, atStart, saleKey);
      expect(languageChoiceOpen(settled, atStart, saleKey), JSON.stringify({ state, atStart, saleKey }))
        .toBe(languageChoiceOpen(state, atStart, saleKey));
    }
  });

  it('a settled state settles to itself, so the screen does not draw again for nothing', () => {
    for (const state of states) for (const atStart of [false, true]) for (const saleKey of [null, 'a', 'b']) {
      const settled = settleLanguageChoice(state, atStart, saleKey);
      expect(settleLanguageChoice(settled, atStart, saleKey)).toBe(settled);
    }
  });

  it('only the first screen ever asks', () => {
    for (const state of [...states, languageChoiceStart('a'), languageChoiceMade('a')]) {
      expect(languageChoiceOpen(state, false, 'a')).toBe(false);
    }
  });
});

describe('the language button, after the choice', () => {
  type Node = React.ReactElement<Record<string, unknown>>;
  const nodes = (tree: React.ReactNode): Node[] => {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
    return [tree, ...nodes(tree.props.children as React.ReactNode)];
  };
  const buttons = (tree: React.ReactNode) => nodes(tree).filter((node) => node.type === 'button');
  /** A button's own words: its icon is an element, its name the text beside it. */
  const text = (node: Node): string =>
    [node.props.children].flat().filter((part): part is string => typeof part === 'string').join('');

  it('still opens its list and changes the language, and the choice does not come back', () => {
    vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined });
    const choice = gate({ atStart: true, saleKey: '0' });
    seam.lang = 'th';
    choice.result.current.choose();

    const pill = renderHook(() => LanguageSwitcher({ variant: 'dark' }));
    const [face] = buttons(pill.result.current);
    expect(face!.props['aria-label']).toBe('เปลี่ยนภาษา');
    expect(text(face!)).toContain('ไทย');
    (face!.props.onClick as () => void)();
    const listed = buttons(pill.result.current).slice(1);
    expect(listed.map(text)).toEqual(LANGUAGES.map((option) => option.nativeLabel));
    (listed.find((node) => text(node) === 'Français')!.props.onClick as () => void)();
    expect(seam.lang).toBe('fr');

    choice.rerender({ atStart: true, saleKey: '0' });
    expect(choice.result.current.open).toBe(false);
  });
});
