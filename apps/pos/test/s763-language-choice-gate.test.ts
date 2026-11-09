import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { LANGUAGES, type SupportedLang } from '@/i18n/types';
import type { StationSessionDocument } from '@oto/shared';
import { readTicketDisplayView, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import {
  heldSaleKey,
  languageChoiceMade,
  languageChoiceOpen,
  languageChoiceStart,
  settleLanguageChoice,
  useHeldSaleKey,
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

/**
 * The paired display as `pages/Display.tsx` holds it: the sale's name read off
 * the first screen's prompt (`view.saleKey`, absent on every later screen and
 * from an older till), kept by `useHeldSaleKey`, and handed to the gate.
 */
type Shown = { atStart: boolean; named?: string };
function usePairedGate({ atStart, named }: Shown) {
  const saleKey = useHeldSaleKey(atStart, named);
  return useLanguageChoice(atStart, saleKey);
}
const paired = (first: Shown) => renderHook(usePairedGate, first);

describe('a paired display told its sale on the first screen', () => {
  it('a sale cancelled or held on its first screen is the next guest, though the screen never left it', () => {
    const view = paired({ atStart: true, named: 'sale-a' });
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    view.rerender({ atStart: true, named: 'sale-a' }); // guest A typing
    expect(view.result.current.open).toBe(false);
    // Cancel at step 1 (or Hold): resetSale keeps the stage at identify, with a new name.
    view.rerender({ atStart: true, named: 'sale-b' });
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    expect(view.result.current.open).toBe(false);
  });

  it('the phone till’s Back to its first screen inside one sale is the same guest: not asked again', () => {
    const view = paired({ atStart: true, named: 'sale-a' });
    view.result.current.choose();
    view.rerender({ atStart: false }); // staff chose a tier: welcome, no name on it
    expect(view.result.current.open).toBe(false);
    view.rerender({ atStart: true, named: 'sale-a' }); // Back: tickets → tier, identify again
    expect(view.result.current.open).toBe(false);
  });

  it('a display that loses its session and finds it again inside the sale does not ask again', () => {
    const view = paired({ atStart: true, named: 'sale-a' });
    view.result.current.choose();
    view.rerender({ atStart: false }); // no view: set up again, or the idle screen
    view.rerender({ atStart: true, named: 'sale-a' });
    expect(view.result.current.open).toBe(false);
  });

  it('the next sale after a whole visit is the next guest, on the render its first screen arrives', () => {
    const view = paired({ atStart: true, named: 'sale-a' });
    view.result.current.choose();
    for (let i = 0; i < 5; i += 1) view.rerender({ atStart: false }); // welcome … thank-you
    view.rerender({ atStart: true, named: 'sale-b' });
    expect(view.result.current.open).toBe(true);
  });

  it('a display that pairs in the middle of a sale asks that guest once', () => {
    const view = paired({ atStart: false });
    view.rerender({ atStart: true, named: 'sale-a' });
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    view.rerender({ atStart: true, named: 'sale-a' });
    expect(view.result.current.open).toBe(false);
  });

  it('a first screen with no name (an older till or box) falls back to the stage rule', () => {
    const view = paired({ atStart: true, named: 'sale-a' });
    view.result.current.choose();
    view.rerender({ atStart: true }); // the till behind it no longer names its sale
    expect(view.result.current.open).toBe(true);
    view.result.current.choose();
    view.rerender({ atStart: true });
    expect(view.result.current.open).toBe(false);
    view.rerender({ atStart: false });
    view.rerender({ atStart: true });
    expect(view.result.current.open).toBe(true);
  });

  it('the name is read on the first screen only and kept through the screens after it', () => {
    expect(heldSaleKey(null, true, 'sale-a')).toBe('sale-a');
    expect(heldSaleKey('sale-a', false, undefined)).toBe('sale-a');
    expect(heldSaleKey('sale-a', false, 'sale-b')).toBe('sale-a');
    expect(heldSaleKey('sale-a', true, 'sale-b')).toBe('sale-b');
    expect(heldSaleKey('sale-a', true, undefined)).toBe(null);
    expect(heldSaleKey('sale-a', true, null)).toBe(null);
  });
});

describe('a paired display behind an older till (told the stage, not the sale)', () => {
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

  it('a screen that knows its sale asks exactly when the sale is new to it or nobody chose in it, wherever it has been', () => {
    for (const state of states) for (const saleKey of ['a', 'b']) {
      expect(languageChoiceOpen(state, true, saleKey), JSON.stringify({ state, saleKey }))
        .toBe(state.saleKey !== saleKey || !state.chosen);
    }
    let state = languageChoiceMade('a');
    for (const atStart of [false, true, false, false, true]) {
      state = settleLanguageChoice(state, atStart, 'a');
      expect(languageChoiceOpen(state, true, 'a')).toBe(false);
    }
    expect(languageChoiceOpen(state, true, 'b')).toBe(true);
  });
});

describe('the sale’s name on the wire', () => {
  const state = (overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => ({
    stage: 'identify', step: 1, sessionKey: '0', saleKey: 'sale-name-1', tier: 'tourist',
    phone: '', nickname: '', contactChannel: 'whatsapp', member: null, ...overrides,
  });
  const document = (overrides: Partial<StationSessionDocument>): StationSessionDocument => ({
    stationId: 'station-1', boxId: 'box-1', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
    takeoverCount: 0, updatedAt: '2026-11-09T12:00:00.000Z', ...overrides,
  });
  const presented = (at: TicketDisplayState) => document(ticketDisplayPresentation(at, 'prompt-1'));

  it('the till puts it on the first screen’s prompt, and on no other', () => {
    expect(ticketDisplayPresentation(state(), 'prompt-1').prompt).toEqual({ kind: 'identify', requestId: 'prompt-1',
      phone: '', nickname: '', contactChannel: 'whatsapp', saleKey: 'sale-name-1' });
    expect(ticketDisplayPresentation(state({ stage: 'input', step: 4 }), 'prompt-1').prompt).toEqual({ kind: 'contact',
      requestId: 'prompt-1', phone: '', nickname: '', contactChannel: 'whatsapp' });
    expect(ticketDisplayPresentation(state({ stage: 'welcome', step: 2 }), 'prompt-1').prompt).toBe(null);
    // A till state with no name publishes the first screen as before.
    expect(ticketDisplayPresentation(state({ saleKey: undefined }), 'prompt-1').prompt).toEqual({ kind: 'identify',
      requestId: 'prompt-1', phone: '', nickname: '', contactChannel: 'whatsapp' });
  });

  it('the display reads it off the first screen, and an unreadable one as no name', () => {
    expect(readTicketDisplayView(presented(state()))?.saleKey).toBe('sale-name-1');
    expect(readTicketDisplayView(presented(state({ saleKey: undefined })))?.stage).toBe('identify');
    expect(readTicketDisplayView(presented(state({ saleKey: undefined }))) ?? {}).not.toHaveProperty('saleKey');
    const shown = presented(state());
    for (const saleKey of ['', '   ', 'x'.repeat(65), 7]) {
      const view = readTicketDisplayView({ ...shown, prompt: { ...shown.prompt, saleKey } });
      expect(view?.stage, JSON.stringify(saleKey)).toBe('identify');
      expect(view?.saleKey, JSON.stringify(saleKey)).toBeUndefined();
    }
    // A name left on a later screen's prompt is not a first screen's.
    const details = presented(state({ stage: 'input', step: 4 }));
    expect(readTicketDisplayView({ ...details, prompt: { ...details.prompt, saleKey: 'sale-name-1' } })?.saleKey).toBeUndefined();
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
