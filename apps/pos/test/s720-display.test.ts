import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: 'en', t: actual.tFor('en') }) };
});
vi.mock('@/lib/displaySession', () => ({ readTicketDisplayView: () => null }));
const mock = vi.hoisted(() => ({ session: vi.fn(), pairing: vi.fn(), start: vi.fn(), stream: vi.fn(), intent: vi.fn() }));
vi.mock('@/api/bridge', () => ({ displayBridgeApi: { session: mock.session, intent: mock.intent }, watchBridgeSnapshots: mock.stream }));
vi.mock('@/api/display', async () => ({ ...await vi.importActual('@/api/display'), displayApi: { pairing: mock.pairing, start: mock.start }, readDisplayCredential: () => 'a'.repeat(64), rememberDisplayCredential: () => true }));
import Display from '@/pages/Display';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

const document: StationSessionDocument = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 5, stage: 'welcome', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-02T00:00:00Z' };
const session = { station: { id: 'station', name: 'ZZ TEST counter', kind: 'till' }, device: { id: 'display', name: 'ZZ TEST screen' }, document };
const PAUSED = 'Connection paused, your order is safe';
let listener: { onSnapshot: (document: StationSessionDocument) => void; onState: (value: boolean) => void; onFailure: (failure: unknown) => void; onActivity?: () => void };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('React', React);
  mock.pairing.mockResolvedValue({ status: 'paired', station: session.station });
  mock.session.mockResolvedValue(session);
  mock.intent.mockImplementation(async (_station, _bearer, intent) => ({ document: { ...document, sequence: intent.lastSeenSequence } }));
  mock.stream.mockImplementation((_id, handlers) => { listener = handlers; return vi.fn(); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = async () => {
  let tree: unknown;
  const hook = renderHook(() => { tree = Display(); });
  await settle();
  return { hook, text: () => JSON.stringify(tree) };
};
describe('SCRUM-738 paired tender frame', () => {
  const tender = { ...document, stage: 'payment' as const,
    cart: { kind: 'tender', supported: true, subject: 'party_balance', method: 'qr' }, member: null, prompt: null, totals: null,
    payment: { saleId: null, amountSatang: 12000, qrPayload: 'ZZ TEST gateway payload', qrImageUrl: null,
      expiresAt: null, status: 'pending', offline: false, online: true } };
  it('HIGH: the paired display selects the finite tender screen and gateway metadata', async () => {
    mock.session.mockResolvedValue({ ...session, document: tender });
    const view = await mount();
    expect(view.text()).toContain('ZZ TEST gateway payload');
    expect(view.text()).toContain('party_balance');
    expect(view.text()).not.toContain('Welcome to OTO Park');
    view.hook.unmount();
  });
  it('HIGH: a malformed tender or mixed visitor frame falls back without exposing its QR', async () => {
    for (const changes of [
      { stage: 'identify' }, { payment: null }, { payment: { ...tender.payment, amountSatang: -1 } },
      { member: { nickname: 'PRIVATE' } }, { prompt: { kind: 'identify' } }, { totals: {} },
      { cart: { ...tender.cart, subject: 'account' } },
    ]) {
      mock.session.mockResolvedValue({ ...session, document: { ...tender, ...changes } });
      const view = await mount();
      expect(view.text()).toContain('Welcome to OTO Park');
      expect(view.text()).not.toContain('ZZ TEST gateway payload');
      expect(view.text()).not.toContain('PRIVATE');
      view.hook.unmount();
    }
  });
});
/** A live stream that then goes down, so the only way back is an accepted document. */
const pause = async () => {
  const view = await mount();
  listener.onSnapshot(document); listener.onState(true);
  mock.session.mockRejectedValue(new Error('offline'));
  listener.onState(false); listener.onFailure(new Error('dropped'));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(view.text()).toContain(PAUSED);
  return view;
};

describe('SCRUM-720 display polling pace', () => {
  it('polls about once a second with no stream open, not five times a second', async () => {
    const view = await mount();
    mock.session.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.session.mock.calls.length).toBeGreaterThanOrEqual(59);
    expect(mock.session.mock.calls.length).toBeLessThanOrEqual(61);
    view.hook.unmount();
  });
});

describe('SCRUM-720 only an accepted document lifts the pause', () => {
  it('keeps the pause on a snapshot older than the held screen, and lifts it on an accepted one', async () => {
    const view = await pause();
    listener.onSnapshot({ ...document, sequence: 4 });
    await settle();
    expect(view.text()).toContain(PAUSED);
    listener.onSnapshot({ ...document, sequence: 5 });
    await settle();
    expect(view.text()).not.toContain(PAUSED);
    expect(view.text()).toContain('ZZ TEST counter');
    view.hook.unmount();
  });

  it('keeps the reconnecting grace running through an older snapshot', async () => {
    const view = await mount();
    listener.onSnapshot(document); listener.onState(true);
    mock.session.mockRejectedValue(new Error('offline'));
    listener.onState(false); listener.onFailure(new Error('dropped'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.text()).toContain('Reconnecting');
    listener.onSnapshot({ ...document, sequence: 4 });
    await settle();
    expect(view.text()).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.text()).toContain(PAUSED);
    view.hook.unmount();
  });

  it('follows a box whose sequence fell: the read after a refused snapshot is the box speaking', async () => {
    const view = await pause();
    mock.session.mockResolvedValue({ ...session, document: { ...document, sequence: 2, language: 'th' } });
    mock.session.mockClear();
    listener.onSnapshot({ ...document, sequence: 2, language: 'th' });
    listener.onState(true);
    await settle();
    expect(view.text()).toContain(PAUSED);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.session).toHaveBeenCalledOnce();
    expect(view.text()).not.toContain(PAUSED);
    // The older number is now the held one: the language gesture quotes it.
    expect(mock.intent.mock.calls.at(-1)![2].lastSeenSequence).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.session).toHaveBeenCalledOnce();
    view.hook.unmount();
  });

  it('asks the box again when that read fails', async () => {
    const view = await pause();
    listener.onSnapshot({ ...document, sequence: 2 });
    listener.onState(true);
    mock.session.mockClear();
    mock.session.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.session).toHaveBeenCalledOnce();
    expect(view.text()).toContain(PAUSED);
    mock.session.mockResolvedValue({ ...session, document: { ...document, sequence: 2 } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.session).toHaveBeenCalledTimes(2);
    expect(view.text()).not.toContain(PAUSED);
    view.hook.unmount();
  });

  it('does not let a poll overtaken in flight bring back an older visitor', async () => {
    const view = await mount();
    let answer: (value: typeof session) => void = () => undefined;
    mock.session.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await vi.advanceTimersByTimeAsync(1_000);
    listener.onSnapshot({ ...document, sequence: 9 });
    await settle();
    mock.intent.mockClear();
    answer({ ...session, document: { ...document, sequence: 8, language: 'th' } });
    await settle();
    expect(mock.intent).not.toHaveBeenCalled();
    view.hook.unmount();
  });
});

describe('SCRUM-720 the grace runs from the last byte', () => {
  it('hides the total fifteen seconds after the last byte of a silent stream, not twenty-seven', async () => {
    const view = await mount();
    listener.onSnapshot(document); listener.onState(true);
    listener.onActivity!();
    mock.session.mockRejectedValue(new Error('offline'));
    // The idle abort finds the silence twelve seconds after the last byte.
    // SCRUM-973 — the word comes before it, once a heartbeat is missed (eight
    // seconds); it said nothing until the abort before. The grace is unchanged.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(view.text()).not.toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.text()).toContain('Reconnecting');
    expect(view.text()).not.toContain(PAUSED);
    listener.onState(false); listener.onFailure(new Error('silent'));
    await settle();
    expect(view.text()).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(view.text()).not.toContain(PAUSED);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.text()).toContain(PAUSED);
    view.hook.unmount();
  });

  it('counts a heartbeat as a byte', async () => {
    const view = await mount();
    listener.onSnapshot(document); listener.onState(true);
    mock.session.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(9_000);
    listener.onActivity!();
    await vi.advanceTimersByTimeAsync(2_000);
    listener.onState(false); listener.onFailure(new Error('dropped'));
    await vi.advanceTimersByTimeAsync(12_999);
    expect(view.text()).not.toContain(PAUSED);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.text()).toContain(PAUSED);
    view.hook.unmount();
  });

  it('counts from the last reply when polling fails', async () => {
    const view = await mount();
    // Ten seconds of answered polls: the last reply, not the mount, starts the count.
    await vi.advanceTimersByTimeAsync(10_000);
    mock.session.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(view.text()).toContain('Reconnecting');
    expect(view.text()).not.toContain(PAUSED);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.text()).toContain(PAUSED);
    view.hook.unmount();
  });

  it('gives a full fifteen seconds from the moment the browser reports it went offline', async () => {
    const view = await mount();
    listener.onSnapshot(document); listener.onState(true);
    listener.onActivity!();
    mock.session.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(4_000);
    window.dispatchEvent(new Event('offline'));
    await settle();
    expect(view.text()).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(view.text()).not.toContain(PAUSED);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.text()).toContain(PAUSED);
    view.hook.unmount();
  });
});

describe('SCRUM-973 — the display says "Reconnecting" as soon as it knows the line is down', () => {
  it('the browser says it is offline: an answer already on its way does not take the word away; the next answer once online does', async () => {
    const view = await mount();
    listener.onSnapshot(document); listener.onState(true); listener.onActivity!();
    vi.stubGlobal('navigator', { onLine: false });
    window.dispatchEvent(new Event('offline'));
    await settle();
    expect(view.text()).toContain('Reconnecting');
    // A newer snapshot already on the wire lands after the browser said so (Chromium delivers
    // it, and keeps a stream that was open running): the word stays while the browser is offline.
    listener.onSnapshot({ ...document, sequence: 6 }); listener.onState(true);
    await settle();
    expect(view.text()).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(view.text()).toContain('Reconnecting');
    // Back online: the box is asked afresh, and its answer takes the word away.
    vi.stubGlobal('navigator', { onLine: true });
    mock.session.mockResolvedValue({ ...session, document: { ...document, sequence: 6 } });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.text()).not.toContain('Reconnecting');
    view.hook.unmount();
  });

  it('a stream gone silent is said once a heartbeat is missed, not at its twelve-second abort; the next byte takes the word away', async () => {
    const view = await mount();
    listener.onSnapshot(document); listener.onState(true);
    mock.session.mockRejectedValue(new Error('offline'));
    listener.onActivity!();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(view.text()).not.toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(view.text()).toContain('Reconnecting');
    // The box is asked afresh meanwhile, at the poll's pace.
    expect(mock.session).toHaveBeenCalled();
    // A heartbeat: the line works, and the word goes; nothing was hidden.
    listener.onActivity!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.text()).not.toContain('Reconnecting');
    expect(view.text()).not.toContain(PAUSED);
    view.hook.unmount();
  });
});
