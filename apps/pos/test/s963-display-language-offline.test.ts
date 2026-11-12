import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentPrompt, StationIntent, StationSessionDocument } from '@oto/shared';

/**
 * SCRUM-963 (point 2 of SCRUM-962) — A LANGUAGE CHOSEN WHILE THE DISPLAY IS
 * RECONNECTING NO LONGER LOCKS THE FAMILY'S FORM.
 *
 * The proof of 12 November (docs/qa/proof-2026-11-12/SCRUM-954, pictures 06a
 * to 06c): with the paired display's connection down, the family chose Thai.
 * A "Please try again / Retry" bar pushed the form down, every box stopped
 * taking a press, the line under the form said to wait for the team, and
 * eight seconds after the connection came back it was still so; only Retry
 * freed it. The display kept the language it could not send (`pending`), the
 * form counted that as an answer the till must confirm, and nothing sent it
 * again by itself.
 *
 * Now a language that could not be sent behaves as the family's typing does:
 * the screen is in their language at once, the form stays open with only the
 * reconnecting line over it, and the choice goes again by itself, under the
 * same action id, when the box is heard from (or every few seconds while the
 * box answers and the reply alone was lost). Done and "Ask the team" still
 * lock the form until the till has them. Driven through the real page with
 * the station's calls stubbed, as `s942-display-form-lines` does.
 */

vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
const language = vi.hoisted(() => ({ lang: 'en' as 'en' | 'th' }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: language.lang, setLang: () => undefined, t: actual.tFor(language.lang) }) };
});
const view = vi.hoisted(() => ({ consent: null as ConsentPrompt | null }));
vi.mock('@/lib/displaySession', () => ({
  readTicketDisplayView: (document: { prompt?: unknown }) => view.consent
    ? { stage: 'input', consent: { ...view.consent, ...(document.prompt as object) }, childReview: null } : null,
}));
const mock = vi.hoisted(() => ({ session: vi.fn(), pairing: vi.fn(), start: vi.fn(), stream: vi.fn(), intent: vi.fn() }));
vi.mock('@/api/bridge', () => ({ displayBridgeApi: { session: mock.session, intent: mock.intent }, watchBridgeSnapshots: mock.stream }));
vi.mock('@/api/display', async () => ({
  ...await vi.importActual('@/api/display'),
  displayApi: { pairing: mock.pairing, start: mock.start, session: mock.session },
  readDisplayCredential: () => 'zz-credential', rememberDisplayCredential: () => true,
}));

import Display, { FILL_RESEND_MS } from '@/pages/Display';
import { tFor } from '@/i18n/LanguageContext';
import { goesAgainByItself } from '@/lib/displaySendQueue';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

const prompt: ConsentPrompt = {
  kind: 'consent', requestId: 'zz-963', visitorId: 'zz-963-visitor',
  slots: [{ id: 'a', name: 'ZZ TEST Aya', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: '', guardianPhone: '+66898963001', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'care',
  consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: false, canContinue: false, completed: false,
};
const frame = (sequence: number, lang: 'en' | 'th', answer?: Record<string, unknown>) => ({
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence, stage: 'input', language: lang,
  lease: null, takeoverCount: 0, updatedAt: '2026-11-13T03:00:00Z', cart: { supported: true }, member: null, totals: null, payment: null,
  prompt: { ...prompt, ...(answer ? { answer } : {}) },
}) as unknown as StationSessionDocument;
const station = { id: 'station', name: 'ZZ TEST counter', kind: 'till' };
const device = { id: 'display', name: 'ZZ TEST screen' };
const offline = () => new TypeError('Failed to fetch');

type Node = React.ReactElement<Record<string, unknown>>;
const nodes = (tree: unknown): Node[] => Array.isArray(tree) ? tree.flatMap(nodes)
  : React.isValidElement<Record<string, unknown>>(tree) ? [tree, ...nodes(tree.props.children)] : [];
const words = (tree: unknown): string => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(words).join('') : React.isValidElement<Record<string, unknown>>(tree) ? words(tree.props.children) : '';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  language.lang = 'en';
  view.consent = prompt;
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => undefined } }));
  vi.stubGlobal('React', React);
  mock.pairing.mockResolvedValue({ status: 'paired', station });
  mock.stream.mockImplementation(() => () => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const mount = () => {
  let tree: unknown;
  const hook = renderHook(() => { tree = Display(); });
  const byTestId = (id: string) => nodes(tree).find((node) => node.props['data-testid'] === id);
  const form = () => nodes(tree).find((node) => typeof node.props.onAction === 'function' && node.props.prompt);
  /** The part that holds the form: `inert` while the form is locked. */
  const holder = () => nodes(tree).find((node) => node.props.inert !== undefined && nodes(node.props.children).includes(form()!));
  return {
    hook, byTestId, form, text: () => words(tree),
    locked: () => holder()?.props.inert === true,
    alerts: () => nodes(tree).filter((node) => node.props.role === 'alert').length,
    /** The family presses the language button and chooses another language. */
    choose: (lang: 'en' | 'th') => { language.lang = lang; hook.rerender(undefined); },
  };
};
const languageIntents = () => mock.intent.mock.calls.map((call) => call[2] as StationIntent)
  .filter((intent) => intent.type === 'display.set_language');

describe('a language chosen while the display is reconnecting (SCRUM-963, 1)', () => {
  it('leaves the form open with only the reconnecting line, and goes by itself when the box is heard from', async () => {
    mock.session.mockResolvedValueOnce({ station, device, document: frame(1, 'en') });
    const display = mount();
    await settle();
    expect(display.locked()).toBe(false);
    // The connection drops: reads and answers reach nothing.
    mock.session.mockRejectedValue(offline());
    mock.intent.mockRejectedValue(offline());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(display.byTestId('display-form-reconnecting')).toBeDefined();
    // The family chooses Thai.
    display.choose('th');
    await settle();
    expect(languageIntents()).toHaveLength(1);
    expect(languageIntents()[0]).toMatchObject({ payload: { language: 'th' } });
    // The screen is in Thai already; the form is not locked, nothing is laid
    // above it, and the line under it does not ask them to wait for the team.
    expect(display.text()).toContain(tFor('th')('display.reconnectingSendsItself'));
    expect(display.locked()).toBe(false);
    expect(display.form()!.props.busy).toBe(false);
    expect(display.alerts()).toBe(0);
    expect(display.byTestId('display-consent-wait')).toBeUndefined();
    expect(display.text()).not.toContain(tFor('th')('display.waitForConfirm'));
    expect(display.text()).not.toContain(tFor('th')('display.retry'));
    // Still down a while later: still open, still not sent again into nothing.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(display.locked()).toBe(false);
    expect(display.alerts()).toBe(0);
    // The box is heard from again, still in English (it never had the choice):
    // the choice goes again by itself, the same answer under the same action id.
    const box = { language: 'en' as 'en' | 'th' };
    mock.session.mockImplementation(async () => ({ station, device, document: frame(1, box.language) }));
    mock.intent.mockImplementation(async (_station: string, _bearer: string, intent: StationIntent) => {
      if (intent.type === 'display.set_language') box.language = intent.payload.language as 'en' | 'th';
      return { document: frame(1, box.language) };
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    const sent = languageIntents();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.actionId).toBe(sent[0]!.actionId);
    expect(sent[1]).toMatchObject({ type: 'display.set_language', payload: { language: 'th' } });
    // The till's copy follows: the box now holds Thai.
    expect(box.language).toBe('th');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(languageIntents()).toHaveLength(2);
    // Taken: no line over the form, nothing waiting, nothing locked.
    expect(display.byTestId('display-form-reconnecting')).toBeUndefined();
    expect(display.locked()).toBe(false);
    expect(display.form()!.props.answerPending).toBe(false);
    display.hook.unmount();
  });

  it('a reply lost while the box still answers: sent again after a few seconds, with no Retry over the form', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(1, 'en') });
    mock.stream.mockImplementation((_station: string, options: { onState: (value: boolean) => void }) => {
      // The live stream is up, so the reads stop and the connection stays good.
      options.onState(true);
      return () => undefined;
    });
    const display = mount();
    await settle();
    mock.intent.mockRejectedValueOnce(offline()).mockResolvedValue({ document: frame(1, 'th') });
    display.choose('th');
    await settle();
    expect(languageIntents()).toHaveLength(1);
    expect(display.locked()).toBe(false);
    expect(display.alerts()).toBe(0);
    expect(display.byTestId('display-form-reconnecting')).toBeDefined();
    await vi.advanceTimersByTimeAsync(FILL_RESEND_MS + 10);
    await settle();
    expect(languageIntents()).toHaveLength(2);
    expect(languageIntents()[1]!.actionId).toBe(languageIntents()[0]!.actionId);
    expect(display.byTestId('display-form-reconnecting')).toBeUndefined();
    display.hook.unmount();
  });

  it('what the family types meanwhile waits for the language, then goes', async () => {
    mock.session.mockResolvedValueOnce({ station, device, document: frame(1, 'en') });
    const display = mount();
    await settle();
    mock.session.mockRejectedValue(offline());
    mock.intent.mockRejectedValue(offline());
    await vi.advanceTimersByTimeAsync(1_500);
    display.choose('th');
    await settle();
    // The form holds its fill while the language is out (one answer at a time)…
    expect(display.form()!.props.answerPending).toBe(true);
    // …and a fill pressed on anyway is not sent ahead of it.
    (display.form()!.props.onAction as (action: unknown) => void)({ action: 'fill', requestId: 'zz-963', visitorId: 'zz-963-visitor',
      slots: [], guardianName: 'ZZ TEST Ploy', consentAcknowledged: false, acknowledgedConfirmationIds: [] });
    await settle();
    expect(mock.intent.mock.calls.map((call) => (call[2] as StationIntent).type)).toEqual(['display.set_language']);
    const box = { language: 'en' as 'en' | 'th' };
    mock.session.mockImplementation(async () => ({ station, device, document: frame(1, box.language) }));
    mock.intent.mockImplementation(async (_station: string, _bearer: string, intent: StationIntent) => {
      if (intent.type === 'display.set_language') box.language = intent.payload.language as 'en' | 'th';
      return { document: frame(1, box.language) };
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(box.language).toBe('th');
    // The language is taken, and the form is free to send what it holds.
    expect(display.form()!.props.answerPending).toBe(false);
    display.hook.unmount();
  });
});

describe('what still locks the form (SCRUM-963, 1)', () => {
  it('Done waiting for the till locks it, as before', async () => {
    mock.session.mockResolvedValue({ station, device,
      document: frame(1, 'en', { type: 'consent', actionId: 'zz-done', payload: { action: 'done', requestId: 'zz-963', visitorId: 'zz-963-visitor' } }) });
    const display = mount();
    await settle();
    expect(display.locked()).toBe(true);
    expect(words(display.byTestId('display-consent-wait'))).toBe(tFor('en')('display.teamInAMoment'));
    display.hook.unmount();
  });

  it('"Ask the team" whose reply was lost locks it and offers Retry, as before', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(1, 'en') });
    const display = mount();
    await settle();
    mock.intent.mockRejectedValue(offline());
    (display.form()!.props.onAction as (action: unknown) => void)({ action: 'staff_help', requestId: 'zz-963', visitorId: 'zz-963-visitor' });
    await settle();
    expect(display.locked()).toBe(true);
    expect(display.alerts()).toBe(1);
    expect(words(display.byTestId('display-consent-wait'))).toBe(tFor('en')('display.waitForConfirm'));
    display.hook.unmount();
  });
});

describe('the answers that go again by themselves', () => {
  it('the form’s live fill and the family’s language; nothing else', () => {
    expect(goesAgainByItself({ type: 'display.set_language', payload: { language: 'th' } })).toBe(true);
    expect(goesAgainByItself({ type: 'display.consent', payload: { action: 'fill' } })).toBe(true);
    for (const action of ['done', 'staff_help', 'photo', 'acknowledge']) {
      expect(goesAgainByItself({ type: 'display.consent', payload: { action } }), action).toBe(false);
    }
    for (const type of ['display.identify', 'display.contact_done', 'display.child_review', 'display.answer_prompt']) {
      expect(goesAgainByItself({ type, payload: {} }), type).toBe(false);
    }
    expect(goesAgainByItself(null)).toBe(false);
  });
});
