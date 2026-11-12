import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';

/**
 * SCRUM-929 — THE PAIRED DISPLAY TAKES THE TILL'S LOOK AND REMEMBERS IT.
 *
 * The separate display drew a fixed dark page. It now draws the look its till
 * last told it, remembers that beside its pairing so a reload or a restarted
 * browser comes back in it at once (before the first document arrives), and
 * stays dark when it was never told. A document that says nothing about the
 * look (a box never told one, or a box from before the field) leaves the
 * remembered look as it is.
 */

vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: actual.tFor('en') }) };
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

const THEME_KEY = 'oto.display.theme';
let stored: Map<string, string>;
let stream: { onSnapshot: (document: StationSessionDocument) => void } | null;

const frame = (sequence: number, theme?: 'light' | 'dark' | null) => ({
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence, stage: 'welcome', language: 'en',
  lease: null, takeoverCount: 0, updatedAt: '2026-11-12T03:00:00Z', cart: null, member: null, totals: null, payment: null, prompt: null,
  ...(theme === undefined ? {} : { theme }),
}) as unknown as StationSessionDocument;
const station = { id: 'station', name: 'ZZ TEST counter', kind: 'till' };
const device = { id: 'display', name: 'ZZ TEST screen' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stored = new Map();
  stream = null;
  const window = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    },
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('React', React);
  mock.pairing.mockResolvedValue({ status: 'paired', station });
  mock.start.mockResolvedValue({ pairingCode: '000000', expiresAt: '2026-11-12T03:10:00Z' });
  mock.stream.mockImplementation((_station: string, handlers: typeof stream) => { stream = handlers; return () => undefined; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const mount = () => {
  let tree: unknown;
  const hook = renderHook(() => { tree = Display(); });
  return { hook, look: () => String((tree as { props: { className: string } }).props.className).split(' ')[0] };
};

describe('the separate display’s look (SCRUM-929)', () => {
  it('is dark for a display that was never told one, and a document that says nothing keeps it', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(1, null) });
    const view = mount();
    expect(view.look()).toBe('dark');
    await settle();
    expect(view.look()).toBe('dark');
    expect(stored.has(THEME_KEY)).toBe(false);
    view.hook.unmount();
  });

  it('takes the look its till told it and remembers it beside the pairing', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(1, 'light') });
    const view = mount();
    await settle();
    expect(view.look()).toBe('light');
    expect(stored.get(THEME_KEY)).toBe('light');
    // The till's next press arrives on the stream.
    stream!.onSnapshot(frame(2, 'dark'));
    await settle();
    expect(view.look()).toBe('dark');
    expect(stored.get(THEME_KEY)).toBe('dark');
    view.hook.unmount();
  });

  it('comes back in the remembered look at once after a reload, before the first document arrives', async () => {
    stored.set(THEME_KEY, 'light');
    mock.session.mockReturnValue(new Promise(() => undefined));
    const view = mount();
    expect(view.look()).toBe('light');
    await settle();
    expect(view.look()).toBe('light');
    view.hook.unmount();
  });

  it('keeps the remembered look when its box was never told one, or is from before the field', async () => {
    stored.set(THEME_KEY, 'light');
    mock.session.mockResolvedValue({ station, device, document: frame(1) });
    const view = mount();
    await settle();
    expect(view.look()).toBe('light');
    stream!.onSnapshot(frame(2, null));
    await settle();
    expect(view.look()).toBe('light');
    expect(stored.get(THEME_KEY)).toBe('light');
    view.hook.unmount();
  });

  it('draws the pairing screen in the remembered look too', async () => {
    stored.set(THEME_KEY, 'light');
    mock.pairing.mockResolvedValue({ status: 'unpaired' });
    const view = mount();
    await settle();
    expect(view.look()).toBe('light');
    view.hook.unmount();
  });

  it('cannot be told anything but light or dark', async () => {
    stored.set(THEME_KEY, 'blue');
    mock.session.mockResolvedValue({ station, device, document: { ...frame(1), theme: 'blue' } as unknown as StationSessionDocument });
    const view = mount();
    expect(view.look()).toBe('dark');
    await settle();
    expect(view.look()).toBe('dark');
    expect(stored.get(THEME_KEY)).toBe('blue');
    view.hook.unmount();
  });
});
