import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationIntent } from '@oto/shared';

/**
 * SCRUM-975 (points 13 and 14 of the lane) — A DISPLAY MESSAGE'S TIME LIMIT,
 * AND THE DISPLAY PAGE TAKING A NEW BUILD BY ITSELF ONLY WHEN IDLE.
 */
// The hooks runner has no external store: each render reads the store's value of the moment.
vi.mock('react', async () => ({
  ...await vi.importActual('react'), ...await import('./support/hooks'),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
const sw = vi.hoisted(() => ({
  state: { supported: true, registered: true, updateReady: false, buildId: 'zz-old' },
  listeners: new Set<() => void>(),
  apply: vi.fn(),
  register: vi.fn(),
}));
vi.mock('@/pwa/register', () => ({
  getServiceWorkerState: () => sw.state,
  subscribeServiceWorker: (listener: () => void) => { sw.listeners.add(listener); return () => sw.listeners.delete(listener); },
  applyServiceWorkerUpdate: sw.apply,
  registerServiceWorker: sw.register,
}));

import { NetworkError } from '@/api/client';
import { DISPLAY_INTENT_LIMIT_MS, displayBridgeApi } from '@/api/bridge';
import { DISPLAY_IDLE_MS, DisplayUpdater } from '@/pwa/DisplayUpdater';
import { setDisplayIdle } from '@/pwa/displayIdle';
import { renderHook } from './support/hooks';

const intent: StationIntent = { type: 'display.consent', payload: { action: 'staff_help' }, actionId: 'zz-975-ask', lastSeenSequence: 1 } as StationIntent;
const target = new EventTarget();

beforeEach(() => {
  vi.useFakeTimers();
  sw.apply.mockClear();
  sw.register.mockClear();
  sw.state = { ...sw.state, updateReady: false };
  setDisplayIdle(false);
  vi.stubGlobal('window', Object.assign(target, {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a display message gives up after eight seconds (SCRUM-975, 13)', () => {
  /** A box that never answers: the request hangs until it is called off. */
  const hanging = () => vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  })));

  it('the limit is the display’s other calls’ eight seconds', () => {
    expect(DISPLAY_INTENT_LIMIT_MS).toBe(8_000);
  });

  it('a message that hangs counts as not sent (a NetworkError) at eight seconds, not before', async () => {
    hanging();
    let outcome: unknown = 'pending';
    void displayBridgeApi.intent('station', 'zz-bearer', intent).then(() => { outcome = 'answered'; }, (err: unknown) => { outcome = err; });
    await vi.advanceTimersByTimeAsync(DISPLAY_INTENT_LIMIT_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(NetworkError);
  });

  it('the caller calling it off is still the caller’s abort', async () => {
    hanging();
    const controller = new AbortController();
    const sent = displayBridgeApi.intent('station', 'zz-bearer', intent, controller.signal);
    controller.abort();
    await expect(sent).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an answer inside the limit is taken as before', async () => {
    const document = { stationId: '01990000-0000-7000-8000-000000000975', boxId: '01990000-0000-7000-8000-000000000976', schemaVersion: 1, sequence: 2, stage: 'welcome', language: 'en', lease: null,
      takeoverCount: 0, updatedAt: '2026-11-13T03:00:00.000Z', cart: null, member: null, totals: null, payment: null, prompt: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ document }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(displayBridgeApi.intent('station', 'zz-bearer', intent)).resolves.toMatchObject({ document: { sequence: 2 } });
  });
});

describe('the display page takes a new build only when idle (SCRUM-975, 14)', () => {
  const mount = () => renderHook(() => DisplayUpdater());
  const ready = () => { sw.state = { ...sw.state, updateReady: true }; for (const listener of sw.listeners) listener(); };

  it('registers the till’s worker, and applies a waiting build after 30 idle, untouched seconds', async () => {
    const page = mount();
    expect(sw.register).toHaveBeenCalledTimes(1);
    setDisplayIdle(true);
    ready();
    page.rerender(undefined);
    await vi.advanceTimersByTimeAsync(DISPLAY_IDLE_MS - 1);
    expect(sw.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sw.apply).toHaveBeenCalledTimes(1);
    page.unmount();
  });

  it('a touch on the screen starts the wait again', async () => {
    const page = mount();
    setDisplayIdle(true);
    ready();
    page.rerender(undefined);
    await vi.advanceTimersByTimeAsync(20_000);
    target.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sw.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sw.apply).toHaveBeenCalledTimes(1);
    page.unmount();
  });

  it('never while a family is on it: not idle, nothing applied; a family arriving calls the wait off', async () => {
    const page = mount();
    ready();
    page.rerender(undefined);
    await vi.advanceTimersByTimeAsync(5 * DISPLAY_IDLE_MS);
    expect(sw.apply).not.toHaveBeenCalled();
    setDisplayIdle(true);
    page.rerender(undefined);
    await vi.advanceTimersByTimeAsync(DISPLAY_IDLE_MS - 5_000);
    setDisplayIdle(false);
    page.rerender(undefined);
    await vi.advanceTimersByTimeAsync(5 * DISPLAY_IDLE_MS);
    expect(sw.apply).not.toHaveBeenCalled();
    page.unmount();
  });

  it('with no new build waiting, nothing is applied however idle it is', async () => {
    const page = mount();
    setDisplayIdle(true);
    page.rerender(undefined);
    await vi.advanceTimersByTimeAsync(5 * DISPLAY_IDLE_MS);
    expect(sw.apply).not.toHaveBeenCalled();
    page.unmount();
  });
});
