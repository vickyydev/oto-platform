import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentPrompt, StationSessionDocument } from '@oto/shared';

/**
 * SCRUM-942 (first part) / SCRUM-943 — WHAT THE PAIRED DISPLAY SAYS AROUND THE
 * FAMILY'S FORM.
 *
 * - The family pressed Done and the till has not taken it yet (a locked till
 *   takes it when staff unlock): the line under the form says the team will be
 *   with them in a moment, not "Please wait for the team to confirm this
 *   change."
 * - The connection drops while they fill the form: one line laid over the top
 *   of the form (nothing under their finger moves as it appears) says it is
 *   reconnecting and that what they enter goes by itself; no Retry, which
 *   could do nothing a returning connection does not do already.
 */

vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: actual.tFor('en') }) };
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

import Display from '@/pages/Display';
import { tFor } from '@/i18n/LanguageContext';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

const t = tFor('en');
const prompt: ConsentPrompt = {
  kind: 'consent', requestId: 'zz-942', visitorId: 'zz-942-visitor',
  slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: 'ZZ TEST Ploy', guardianPhone: '+66898942001', contactChannel: 'whatsapp', contactConfirmed: true, familyStep: 'agreements',
  consentRequired: true, consentAcknowledged: true, confirmations: [],
  staffReady: true, canContinue: true, completed: false,
};
const frame = (sequence: number, answer?: Record<string, unknown>) => ({
  stationId: 'station', boxId: 'box', schemaVersion: 1, sequence, stage: 'input', language: 'en',
  lease: null, takeoverCount: 0, updatedAt: '2026-11-12T03:00:00Z', cart: { supported: true }, member: null, totals: null, payment: null,
  prompt: { ...prompt, ...(answer ? { answer } : {}) },
}) as unknown as StationSessionDocument;
const station = { id: 'station', name: 'ZZ TEST counter', kind: 'till' };
const device = { id: 'display', name: 'ZZ TEST screen' };

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
  return { hook, byTestId, text: () => words(tree), tree: () => tree };
};

describe('the line under the family’s form while their Done waits (SCRUM-942)', () => {
  it('says the team will be with them in a moment, not that a change waits for confirmation', async () => {
    mock.session.mockResolvedValue({ station, device,
      document: frame(1, { type: 'consent', actionId: 'zz-done', payload: { action: 'done', requestId: 'zz-942', visitorId: 'zz-942-visitor' } }) });
    const display = mount();
    await settle();
    expect(words(display.byTestId('display-consent-wait'))).toBe(t('display.teamInAMoment'));
    expect(display.text()).not.toContain(t('display.waitForConfirm'));
    display.hook.unmount();
  });

  it('keeps the old line for anything else the till has yet to take (Ask the team)', async () => {
    mock.session.mockResolvedValue({ station, device,
      document: frame(1, { type: 'consent', actionId: 'zz-help', payload: { action: 'staff_help', requestId: 'zz-942', visitorId: 'zz-942-visitor' } }) });
    const display = mount();
    await settle();
    expect(words(display.byTestId('display-consent-wait'))).toBe(t('display.waitForConfirm'));
    display.hook.unmount();
  });

  it('says nothing under a form the family is still filling', async () => {
    mock.session.mockResolvedValue({ station, device, document: frame(1) });
    const display = mount();
    await settle();
    expect(display.byTestId('display-consent-wait')).toBeUndefined();
    display.hook.unmount();
  });

  it('is in the family’s language, Thai included', () => {
    expect(tFor('th')('display.teamInAMoment')).not.toBe('display.teamInAMoment');
    expect(tFor('th')('display.teamInAMoment')).not.toBe(t('display.teamInAMoment'));
    expect(tFor('th')('display.reconnectingSendsItself')).not.toBe(t('display.reconnectingSendsItself'));
  });
});

describe('a dropped connection on the family’s form (SCRUM-943)', () => {
  it('is one line laid over the top of the form, saying what they enter goes by itself, with no Retry', async () => {
    mock.session.mockResolvedValueOnce({ station, device, document: frame(1) });
    const display = mount();
    await settle();
    expect(display.byTestId('display-form-reconnecting')).toBeUndefined();
    // The family types: the form sends a fill, and the line is down.
    mock.intent.mockRejectedValue(new TypeError('Failed to fetch'));
    mock.session.mockRejectedValue(new TypeError('Failed to fetch'));
    const form = nodes(display.tree()).find((node) => typeof node.props.onAction === 'function' && node.props.prompt)!;
    (form.props.onAction as (action: unknown) => void)({ action: 'fill', requestId: 'zz-942', visitorId: 'zz-942-visitor',
      slots: [], guardianName: 'ZZ TEST Ploy', consentAcknowledged: true, acknowledgedConfirmationIds: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    const line = display.byTestId('display-form-reconnecting');
    expect(words(line)).toBe(t('display.reconnectingSendsItself'));
    // Laid over the form: absolutely placed, and it takes no touch.
    expect(String(line!.props.className)).toMatch(/\babsolute\b/);
    expect(String(line!.props.className)).toMatch(/pointer-events-none/);
    // Neither the plain reconnecting line nor a Retry pushes the form down.
    expect(display.text()).not.toContain(t('display.retry'));
    expect(display.text()).not.toContain('Please retry when the connection returns');
    expect(nodes(display.tree()).filter((node) => node.props.role === 'alert')).toHaveLength(0);
    display.hook.unmount();
  });
});
