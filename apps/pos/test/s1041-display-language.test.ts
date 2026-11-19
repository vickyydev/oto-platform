import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationIntent, StationSessionDocument } from '@oto/shared';
import type { SupportedLang } from '@/i18n/types';

/**
 * SCRUM-1041 — THE LANGUAGE CHOSEN ON ONE DISPLAY FOLLOWS ON THE OTHERS.
 *
 * A till may have up to three displays, and the station's document holds the
 * one language of its sale (one sale, one customer): each display tells the
 * station the language its guest chose (`display.set_language`). With two
 * displays each telling its own, they would take the language back and forth
 * for ever. So a display follows a language another display put on the
 * station — and counts it as this sale's choice, so its own first screen does
 * not ask again — and never tells its own back over it. A box that fell back
 * to an earlier copy is told this screen's language, as before; and a screen
 * whose own choice is still on its way does not take the older one back.
 */

vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
const language = vi.hoisted(() => ({ lang: 'en' as SupportedLang, set: [] as SupportedLang[] }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: language.lang,
    setLang: (next: SupportedLang) => { language.set.push(next); language.lang = next; }, t: actual.tFor(language.lang) }) };
});
const choice = vi.hoisted(() => ({ chosen: 0 }));
vi.mock('@/lib/languageChoice', async () => {
  const actual = await vi.importActual<typeof import('@/lib/languageChoice')>('@/lib/languageChoice');
  return { ...actual, useLanguageChoice: () => ({ open: false, choose: () => { choice.chosen += 1; } }) };
});
vi.mock('@/lib/displaySession', () => ({ readTicketDisplayView: () => null }));
const mock = vi.hoisted(() => ({ session: vi.fn(), pairing: vi.fn(), start: vi.fn(), stream: vi.fn(), intent: vi.fn() }));
vi.mock('@/api/bridge', () => ({ displayBridgeApi: { session: mock.session, intent: mock.intent }, watchBridgeSnapshots: mock.stream }));
vi.mock('@/api/display', async () => ({
  ...await vi.importActual('@/api/display'),
  displayApi: { pairing: mock.pairing, start: mock.start, session: mock.session },
  readDisplayCredential: () => 'zz-credential', rememberDisplayCredential: () => true,
}));

import Display from '@/pages/Display';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

const frame = (sequence: number, lang: string) => ({
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence, stage: 'welcome', language: lang,
  lease: null, takeoverCount: 0, updatedAt: '2026-11-19T08:00:00Z', cart: null, member: null, totals: null, payment: null, prompt: null,
}) as unknown as StationSessionDocument;
const station = { id: 'station', name: 'ZZ TEST counter', kind: 'till' };
const device = { id: 'display-right', name: 'ZZ TEST right' };
const languageIntents = () => mock.intent.mock.calls.map((call) => call[2] as StationIntent)
  .filter((intent) => intent.type === 'display.set_language');

let snapshot: ((document: StationSessionDocument) => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  language.lang = 'en';
  language.set = [];
  choice.chosen = 0;
  snapshot = null;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('React', React);
  mock.pairing.mockResolvedValue({ status: 'paired', station });
  mock.start.mockResolvedValue({ pairingCode: '000000', expiresAt: '2026-11-19T08:10:00Z' });
  mock.stream.mockImplementation((_station: string, handlers: { onSnapshot: (document: StationSessionDocument) => void; onState: (value: boolean) => void }) => {
    snapshot = handlers.onSnapshot;
    handlers.onState(true);
    return () => undefined;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const mount = () => {
  const hook = renderHook(() => { Display(); });
  return { hook, again: () => hook.rerender(undefined) };
};

describe('a language another display chose', () => {
  it('is followed here, counted as this sale\'s choice, and not told back to the station', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(4, 'en') });
    const view = mount();
    await settle();
    expect(languageIntents()).toHaveLength(0);
    // The family at the other display chooses Thai.
    snapshot!(frame(4, 'th'));
    view.again();
    await settle();
    expect(language.set).toEqual(['th']);
    expect(choice.chosen).toBe(1);
    view.again();
    await settle();
    expect(languageIntents()).toHaveLength(0);
    view.hook.unmount();
  });

  it('its own choice is told and kept; a later choice on the other display is followed', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(4, 'en') });
    mock.intent.mockImplementation(async (_station: string, _bearer: string, intent: StationIntent) => ({
      document: frame(4, String(intent.payload.language)) }));
    const view = mount();
    await settle();
    // This screen's guest chooses Russian: told to the station, and held there.
    language.lang = 'ru';
    view.again();
    await settle();
    snapshot!(frame(4, 'ru'));
    view.again();
    await settle();
    expect(languageIntents().map((intent) => intent.payload.language)).toEqual(['ru']);
    expect(language.set).toEqual([]);
    // Then the guest at the other display chooses Thai: followed, not taken back.
    snapshot!(frame(4, 'th'));
    view.again();
    await settle();
    expect(language.set).toEqual(['th']);
    view.again();
    await settle();
    expect(languageIntents().map((intent) => intent.payload.language)).toEqual(['ru']);
    view.hook.unmount();
  });

  it('a box that fell back to an earlier copy is told this screen\'s language, as before', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(9, 'th') });
    mock.intent.mockImplementation(async (_station: string, _bearer: string, intent: StationIntent) => ({
      document: frame(9, String(intent.payload.language)) }));
    language.lang = 'th';
    const view = mount();
    await settle();
    expect(languageIntents()).toHaveLength(0);
    // The box was restored from an earlier copy: a lower number, in English.
    mock.session.mockResolvedValue({ station, device, document: frame(2, 'en') });
    snapshot!(frame(2, 'en'));
    await vi.advanceTimersByTimeAsync(1_500);
    view.again();
    await settle();
    expect(language.set).toEqual([]);
    expect(languageIntents().map((intent) => intent.payload.language)).toEqual(['th']);
    view.hook.unmount();
  });
});

describe('one display, as before', () => {
  it('tells the station its own language when the station holds another', async () => {
    language.lang = 'ru';
    mock.session.mockResolvedValue({ station, device, document: frame(1, 'en') });
    mock.intent.mockImplementation(async () => ({ document: frame(1, 'ru') }));
    const view = mount();
    await settle();
    expect(languageIntents().map((intent) => intent.payload.language)).toEqual(['ru']);
    expect(language.set).toEqual([]);
    view.hook.unmount();
  });
});
