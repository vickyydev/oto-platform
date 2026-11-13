import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentPrompt, StationIntent, StationSessionDocument } from '@oto/shared';

/**
 * SCRUM-975 (points 3, 6 and 8 of the ticket: the display's leftovers) — THE
 * PAIRED DISPLAY'S KEPT ANSWERS, AND WHEN IT MAY TAKE A NEW BUILD.
 *
 * The proof (docs/qa/proof-2026-11-13/SCRUM-963, pictures 01h, 01i): "Ask the
 * team" pressed while the display was cut off did not go by itself when the
 * connection came back (12 seconds waited); it needed Retry. A family-form
 * photo whose answer was lost raised the amber Retry bar over the form. Now
 * every kept answer goes again by itself, under its own action id, when the
 * box is heard from (the lock while it is out stays), and a photo goes as a
 * fill does, with no bar. And the page says when it is idle, for its updater.
 * Driven through the real page with the station's calls stubbed, as
 * `s963-display-language-offline` does.
 */

vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: actual.tFor('en') }) };
});
const view = vi.hoisted(() => ({ consent: null as ConsentPrompt | null }));
vi.mock('@/lib/displaySession', () => ({
  readTicketDisplayView: (document: { prompt?: unknown; stage?: string }) => view.consent && document.stage === 'input'
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
import { goesAgainByItself, sentAgainWhenBack } from '@/lib/displaySendQueue';
import { displayIdleForUpdate, getDisplayIdle } from '@/pwa/displayIdle';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

const prompt: ConsentPrompt = {
  kind: 'consent', requestId: 'zz-975', visitorId: 'zz-975-visitor',
  slots: [{ id: 'a', name: 'ZZ TEST Aya', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '', photo: 'needed' }],
  guardianName: 'ZZ TEST Nok', guardianPhone: '+66898975001', contactChannel: 'whatsapp', contactConfirmed: true, familyStep: 'agreements',
  consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: false, canContinue: false, completed: false,
};
const document = (sequence: number, extra: { answer?: Record<string, unknown>; stage?: string; prompt?: unknown } = {}) => ({
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence, stage: extra.stage ?? 'input', language: 'en',
  lease: null, takeoverCount: 0, updatedAt: '2026-11-13T03:00:00Z', cart: { supported: true }, member: null, totals: null, payment: null,
  prompt: extra.prompt !== undefined ? extra.prompt : { ...prompt, ...(extra.answer ? { answer: extra.answer } : {}) },
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
  const holder = () => nodes(tree).find((node) => node.props.inert !== undefined && nodes(node.props.children).includes(form()!));
  return {
    hook, byTestId, form, text: () => words(tree),
    locked: () => holder()?.props.inert === true,
    alerts: () => nodes(tree).filter((node) => node.props.role === 'alert').length,
    press: (action: Record<string, unknown>) => (form()!.props.onAction as (value: unknown) => void)({ requestId: 'zz-975', visitorId: 'zz-975-visitor', ...action }),
  };
};
const consentIntents = () => mock.intent.mock.calls.map((call) => call[2] as StationIntent).filter((intent) => intent.type === 'display.consent');

/** A box that holds the family's answer once it arrives, as `station-session.ts` does. */
function boxHolding() {
  const box: { answer?: Record<string, unknown>; sequence: number } = { sequence: 1 };
  mock.session.mockImplementation(async () => ({ station, device, document: document(box.sequence, box.answer ? { answer: box.answer } : {}) }));
  mock.intent.mockImplementation(async (_station: string, _bearer: string, intent: StationIntent) => {
    if ((intent.payload as { action?: string }).action !== 'fill' && (intent.payload as { action?: string }).action !== 'photo') {
      box.answer ??= { type: 'consent', actionId: intent.actionId, payload: intent.payload };
    }
    box.sequence += 1;
    return { document: document(box.sequence, box.answer ? { answer: box.answer } : {}) };
  });
  return box;
}

describe('a locked answer pressed while the display is cut off goes by itself when the line returns (SCRUM-975, 9)', () => {
  for (const [name, action] of [['Ask the team', { action: 'staff_help' }], ['Done', { action: 'done' }]] as const) {
    it(`${name}: locked while it is out, sent again under its action id when the box is heard from, no Retry pressed`, async () => {
      mock.session.mockResolvedValueOnce({ station, device, document: document(1) });
      const display = mount();
      await settle();
      // The line drops: reads and answers reach nothing.
      mock.session.mockRejectedValue(offline());
      mock.intent.mockRejectedValue(offline());
      display.press(action);
      await settle();
      expect(consentIntents()).toHaveLength(1);
      expect(display.locked()).toBe(true);
      await vi.advanceTimersByTimeAsync(12_000);
      // Still out: still locked, and the answer is not thrown at a dead line again and again.
      expect(display.locked()).toBe(true);
      const whileDown = consentIntents().length;
      // The line returns.
      const box = boxHolding();
      await vi.advanceTimersByTimeAsync(1_500);
      await settle();
      const sent = consentIntents();
      expect(sent.length).toBe(whileDown + 1);
      expect(sent.at(-1)!.actionId).toBe(sent[0]!.actionId);
      expect(sent.at(-1)!.payload).toMatchObject(action);
      expect(box.answer).toMatchObject({ actionId: sent[0]!.actionId });
      // Taken: no Retry, and the screen waits for the team as it does for an answer the till holds.
      expect(display.alerts()).toBe(0);
      expect(display.locked()).toBe(true);
      expect(display.text()).not.toContain(tFor('en')('display.retry'));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(consentIntents().length).toBe(sent.length);
      display.hook.unmount();
    });
  }
});

describe('a photo answer that was lost (SCRUM-975, 12)', () => {
  it('raises no Retry bar over the form, and goes again by itself under the same action id', async () => {
    mock.session.mockResolvedValue({ station, device, document: document(1) });
    const display = mount();
    await settle();
    mock.intent.mockRejectedValueOnce(offline()).mockResolvedValue({ document: document(2) });
    display.press({ action: 'photo', slotId: 'a', fileId: '01990000-0000-7000-8000-000000000975' });
    await settle();
    expect(consentIntents()).toHaveLength(1);
    expect(display.alerts()).toBe(0);
    expect(display.locked()).toBe(false);
    await vi.advanceTimersByTimeAsync(FILL_RESEND_MS + 10);
    await settle();
    expect(consentIntents()).toHaveLength(2);
    expect(consentIntents()[1]!.actionId).toBe(consentIntents()[0]!.actionId);
    expect(display.alerts()).toBe(0);
    display.hook.unmount();
  });
});

describe('which answers go again by themselves, after SCRUM-975', () => {
  it('without a lock: the fill, the language and the photo; with the lock kept: every other one the display sends', () => {
    for (const action of ['fill', 'photo']) expect(goesAgainByItself({ type: 'display.consent', payload: { action } }), action).toBe(true);
    expect(goesAgainByItself({ type: 'display.set_language', payload: { language: 'th' } })).toBe(true);
    for (const action of ['done', 'staff_help', 'acknowledge']) {
      expect(goesAgainByItself({ type: 'display.consent', payload: { action } }), action).toBe(false);
      expect(sentAgainWhenBack({ type: 'display.consent' }), action).toBe(true);
    }
    for (const type of ['display.identify', 'display.contact_done', 'display.child_review', 'display.set_language']) {
      expect(sentAgainWhenBack({ type }), type).toBe(true);
    }
    expect(sentAgainWhenBack({ type: 'session.publish_display' })).toBe(false);
    expect(sentAgainWhenBack(null)).toBe(false);
  });
});

describe('the display says when it may take a new build (SCRUM-975, 14)', () => {
  it('the rule: paired, heard from, nothing on its way, the welcome screen with nobody on it', () => {
    const idle = { paired: true, connected: true, sending: false, stage: 'welcome', prompt: null, member: null };
    expect(displayIdleForUpdate(idle)).toBe(true);
    expect(displayIdleForUpdate({ ...idle, paired: false })).toBe(false);
    expect(displayIdleForUpdate({ ...idle, connected: false })).toBe(false);
    expect(displayIdleForUpdate({ ...idle, sending: true })).toBe(false);
    expect(displayIdleForUpdate({ ...idle, prompt: { kind: 'identify' } })).toBe(false);
    expect(displayIdleForUpdate({ ...idle, member: { name: 'ZZ TEST' } })).toBe(false);
    for (const stage of ['identify', 'order', 'input', 'payment', 'thankyou']) expect(displayIdleForUpdate({ ...idle, stage }), stage).toBe(false);
  });

  it('the page: idle on its welcome screen, not on the family’s form', async () => {
    mock.session.mockResolvedValue({ station, device, document: document(1, { stage: 'welcome', prompt: null }) });
    const welcome = mount();
    await settle();
    expect(getDisplayIdle()).toBe(true);
    welcome.hook.unmount();
    expect(getDisplayIdle()).toBe(false);
    mock.session.mockResolvedValue({ station, device, document: document(1) });
    const form = mount();
    await settle();
    expect(form.form()).toBeDefined();
    expect(getDisplayIdle()).toBe(false);
    form.hook.unmount();
  });
});
