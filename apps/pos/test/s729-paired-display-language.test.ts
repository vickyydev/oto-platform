import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import type { SupportedLang } from '@/i18n/types';

/**
 * SCRUM-729 — the paired display's own lines, on the display page itself.
 *
 * The harness `s710-display.test.ts` drives the page with, set to one language by
 * the real translator. The pairing screen is the one part left in English: staff
 * read it while setting a device up, before there is a customer in front of it.
 */

vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
const language = vi.hoisted(() => ({ current: 'en' as SupportedLang }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: language.current, setLang: () => undefined, t: actual.tFor(language.current) }) };
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
import { tFor } from '@/i18n/LanguageContext';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

const document = {
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 1, stage: 'welcome', language: 'ru',
  lease: null, takeoverCount: 0, updatedAt: '2026-11-03T00:00:00Z', cart: null, member: null, totals: null, payment: null, prompt: null,
} as unknown as StationSessionDocument;
const session = {
  station: { id: 'station', name: 'ZZ TEST counter', kind: 'till' },
  device: { id: 'display', name: 'ZZ TEST screen' }, document,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('React', React);
  mock.pairing.mockResolvedValue({ status: 'paired', station: session.station });
  mock.session.mockResolvedValue(session);
  mock.start.mockResolvedValue({ pairingCode: '000000', expiresAt: '2026-11-03T00:10:00Z' });
  mock.intent.mockResolvedValue({ document });
  mock.stream.mockImplementation(() => () => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const mount = () => {
  let tree: unknown;
  const hook = renderHook(() => { tree = Display(); });
  return { hook, text: () => JSON.stringify(tree) };
};

describe.each(['en', 'ru', 'th'] as const)('the paired display page in %s', (lang) => {
  beforeEach(() => { language.current = lang; });
  const t = tFor(lang);

  it('greets and points to the staff screen in that language while there is nothing to show', async () => {
    const view = mount();
    await settle();
    expect(view.text()).toContain(t('display.idle.title'));
    expect(view.text()).toContain(t('display.idle.followStaff'));
    if (lang !== 'en') {
      expect(view.text()).not.toContain('Welcome to OTO Park');
      expect(view.text()).not.toContain('Please follow the staff screen');
    }
    view.hook.unmount();
  });

  it('says it is reconnecting and that the order is safe in that language', async () => {
    const view = mount();
    await settle();
    mock.session.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.text()).toContain(t('display.reconnecting'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.text()).toContain(t('display.connectionPaused'));
    if (lang !== 'en') expect(view.text()).not.toContain('Connection paused');
    view.hook.unmount();
  });
});

describe('the pairing screen', () => {
  it('stays in English for the person setting the device up', async () => {
    language.current = 'ru';
    mock.pairing.mockResolvedValue({ status: 'unpaired' });
    const view = mount();
    await settle();
    expect(view.text()).toContain('Set up this display');
    expect(view.text()).toContain('In the Console, open Devices');
    view.hook.unmount();
  });
});
