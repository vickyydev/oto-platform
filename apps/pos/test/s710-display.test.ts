import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string) => key === 'display.connectionPaused' ? 'Connection paused, your order is safe' : 'Reconnecting' }) }));
vi.mock('@/lib/displaySession', () => ({ readTicketDisplayView: () => null }));
const mock = vi.hoisted(() => ({ session: vi.fn(), pairing: vi.fn(), start: vi.fn(), stream: vi.fn(), intent: vi.fn() }));
vi.mock('@/api/bridge', () => ({ displayBridgeApi: { session: mock.session, intent: mock.intent }, watchBridgeSnapshots: mock.stream }));
vi.mock('@/api/display', async () => ({ ...await vi.importActual('@/api/display'), displayApi: { pairing: mock.pairing, start: mock.start }, readDisplayCredential: () => 'a'.repeat(64), rememberDisplayCredential: () => true }));
import Display from '@/pages/Display';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';
import { ApiError } from '@/api/client';

const document: StationSessionDocument = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 1, stage: 'welcome', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-02T00:00:00Z' };
const session = { station: { id: 'station', name: 'ZZ TEST counter', kind: 'till' }, device: { id: 'display', name: 'ZZ TEST screen' }, document };
let listener: { onSnapshot: (document: StationSessionDocument) => void; onState: (value: boolean) => void; onFailure: (failure: unknown) => void };
let stop: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('React', React);
  mock.pairing.mockResolvedValue({ status: 'paired', station: session.station });
  mock.session.mockResolvedValue(session);
  mock.start.mockResolvedValue({ pairingCode: '000000', expiresAt: '2026-11-02T00:10:00Z' });
  stop = vi.fn();
  mock.stream.mockImplementation((_id, handlers) => { listener = handlers; return stop; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = () => {
  let tree: unknown;
  const hook = renderHook(() => { tree = Display(); });
  return { hook, text: () => JSON.stringify(tree) };
};
describe('SCRUM-710 display recovery', () => {
  it('keeps the last screen at ten seconds, hides it after fifteen and recovers from a snapshot', async () => {
    const view = mount(); await settle();
    listener.onState(true);
    mock.session.mockRejectedValue(new Error('offline'));
    listener.onState(false); listener.onFailure(new Error('dropped'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.text()).toContain('ZZ TEST counter');
    expect(view.text()).toContain('Reconnecting');
    expect(view.text()).not.toContain('Connection paused');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.text()).toContain('Connection paused, your order is safe');
    expect(view.text()).not.toContain('Welcome to OTO Park');
    listener.onSnapshot({ ...document, sequence: 2 }); listener.onState(true);
    await settle();
    expect(view.text()).not.toContain('Connection paused');
    expect(view.text()).toContain('ZZ TEST counter');
    view.hook.unmount(); expect(stop).toHaveBeenCalledOnce();
  });
  it('stops session polling during a live stream and resumes after a drop', async () => {
    const view = mount(); await settle();
    listener.onSnapshot(document); listener.onState(true);
    mock.session.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mock.session).not.toHaveBeenCalled();
    listener.onState(false); listener.onFailure(new Error('drop'));
    await vi.advanceTimersByTimeAsync(1_050);
    expect(mock.session).toHaveBeenCalled();
    expect(view.text()).not.toContain('Reconnecting');
    view.hook.unmount();
  });
  it('FIXED MEDIUM: a late failed poll must not pause an already recovered stream; ignore obsolete transport failure', async () => {
    const view = mount(); await settle();
    let reject: (failure: Error) => void = () => undefined;
    mock.session.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    mock.session.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.session).toHaveBeenCalledOnce();
    listener.onSnapshot({ ...document, sequence: 2 }); listener.onState(true);
    reject(new Error('old poll failed')); await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(view.text()).not.toContain('Connection paused');
    expect(view.text()).not.toContain('Reconnecting');
    view.hook.unmount();
  });
  it('FIXED MEDIUM: an unavailable stream must not flash reconnecting while polling is healthy', async () => {
    const view = mount(); await settle();
    listener.onState(false); listener.onFailure(new Error('proxy buffers stream'));
    expect(view.text()).not.toContain('Reconnecting');
    view.hook.unmount();
  });
  it('returns immediately to pairing on a refused stream', async () => {
    const view = mount(); await settle();
    mock.pairing.mockResolvedValue({ status: 'expired' });
    listener.onFailure(new ApiError(401, 'DISPLAY_UNPAIRED', 'revoked'));
    await settle();
    expect(view.text()).toContain('Set up this display');
    expect(view.text()).not.toContain('Connection paused');
    view.hook.unmount();
  });
});
