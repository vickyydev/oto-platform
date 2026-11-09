import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_HEARTBEAT_INTERVAL_S, SCREEN_SCAN_AGE_MAX_S } from '@oto/shared';
import { renderHook, type RenderedHook } from './support/hooks';
import { useStationHeartbeat } from '@/station/heartbeat';
import { useScannerBurst } from '@/lib/scannerBurst';
import { forgetScannerUse, lastScanSecondsAgo, noteScannerUse, scanAgeMs, type ScanClock } from '@/lib/scannerUse';

/**
 * SCRUM-771 — the till's screen tells the platform it is still there, every
 * minute while a station is held, with how long ago a scanner last typed into
 * it. A cradle plugged into the iPad is a keyboard to it, so the codes it types
 * are the only sign of it the till has.
 */
vi.mock('react', () => import('./support/hooks'));

describe('when a scanner last typed into this till', () => {
  beforeEach(() => forgetScannerUse());

  /** A moment with both clocks agreeing, as they do while the iPad is awake. */
  const at = (ms: number): ScanClock => ({ wall: 1_794_000_000_000 + ms, mono: ms });
  const HOUR = 3_600_000;

  it('is nothing until a scanner has typed, then an age in whole seconds', () => {
    expect(lastScanSecondsAgo(at(1_000))).toBeNull();
    noteScannerUse(at(1_000));
    expect(lastScanSecondsAgo(at(1_000))).toBe(0);
    expect(lastScanSecondsAgo(at(46_400))).toBe(45);
  });

  it('keeps the newest scan, and reports nothing once it is older than the platform will take', () => {
    noteScannerUse(at(1_000));
    noteScannerUse(at(5_000));
    expect(lastScanSecondsAgo(at(15_000))).toBe(10);
    expect(lastScanSecondsAgo(at(5_000 + SCREEN_SCAN_AGE_MAX_S * 1000))).toBe(SCREEN_SCAN_AGE_MAX_S);
    expect(lastScanSecondsAgo(at(5_000 + (SCREEN_SCAN_AGE_MAX_S + 1) * 1000))).toBeNull();
  });

  it('counts the hours the iPad slept, while its monotonic clock stood still', () => {
    // Scanned at 09:00; awake until 09:05, asleep until 12:00. The monotonic
    // clock moved five minutes, the wall clock three hours.
    noteScannerUse({ wall: 0, mono: 1_000 });
    expect(lastScanSecondsAgo({ wall: 3 * HOUR, mono: 1_000 + 300_000 })).toBe(3 * 3_600);
    expect(scanAgeMs({ wall: 0, mono: 1_000 }, { wall: 3 * HOUR, mono: 1_000 })).toBe(3 * HOUR);
  });

  it('reads the monotonic clock alone when the wall clock was set back since the scan', () => {
    noteScannerUse({ wall: 10 * HOUR, mono: 1_000 });
    expect(lastScanSecondsAgo({ wall: 9 * HOUR, mono: 46_000 })).toBe(45);
    // Set back by less than has passed: the larger difference, the true one, still wins.
    expect(lastScanSecondsAgo({ wall: 10 * HOUR + 10_000, mono: 46_000 })).toBe(45);
  });
});

describe('the heartbeat', () => {
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let answer: () => Promise<Response>;
  let hook: RenderedHook<{ stationId: string | null }, void> | undefined;
  const listeners = new Map<string, Set<() => void>>();
  let visibility: 'visible' | 'hidden';

  const ok = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ stationId: 'station-1', lastSeenAt: new Date().toISOString(), scannerLastUsedAt: null }),
    } as Response);
  const fire = (type: string) => listeners.get(type)?.forEach((listener) => listener());
  const target = {
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => listeners.get(type)?.delete(listener),
  };
  /** Let the request's promise chain settle, so the next beat is not still "in flight". */
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    forgetScannerUse();
    calls = [];
    answer = ok;
    listeners.clear();
    visibility = 'visible';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return answer();
    }));
    vi.stubGlobal('window', { ...target, dispatchEvent: () => true });
    vi.stubGlobal('document', {
      ...target,
      get visibilityState() {
        return visibility;
      },
    });
  });

  afterEach(() => {
    hook?.unmount();
    hook = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const start = (stationId: string | null) => {
    hook = renderHook(({ stationId: id }: { stationId: string | null }) => useStationHeartbeat(id), { stationId });
  };

  it('says the till is there at once, then every minute, to its own route', async () => {
    start('station-1');
    await settle();
    expect(calls).toEqual([{ url: '/api/me/station/heartbeat', method: 'POST', body: { lastScanSecondsAgo: null } }]);
    await vi.advanceTimersByTimeAsync(SCREEN_HEARTBEAT_INTERVAL_S * 1000 - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SCREEN_HEARTBEAT_INTERVAL_S * 1000);
    expect(calls).toHaveLength(3);
  });

  it('carries how long ago a scanner last typed into the till', async () => {
    start('station-1');
    await settle();
    noteScannerUse();
    await vi.advanceTimersByTimeAsync(SCREEN_HEARTBEAT_INTERVAL_S * 1000);
    expect(calls.at(-1)!.body).toEqual({ lastScanSecondsAgo: SCREEN_HEARTBEAT_INTERVAL_S });
  });

  it('sends nothing without a station, and stops when the station goes', async () => {
    start(null);
    await vi.advanceTimersByTimeAsync(SCREEN_HEARTBEAT_INTERVAL_S * 3000);
    expect(calls).toHaveLength(0);

    hook!.rerender({ stationId: 'station-1' });
    await settle();
    expect(calls).toHaveLength(1);
    hook!.rerender({ stationId: null });
    await vi.advanceTimersByTimeAsync(SCREEN_HEARTBEAT_INTERVAL_S * 3000);
    expect(calls).toHaveLength(1);
    expect(listeners.get('online')?.size ?? 0).toBe(0);
    expect(listeners.get('visibilitychange')?.size ?? 0).toBe(0);
  });

  it('keeps beating after one that failed, and beats again the moment the iPad wakes or its Wi-Fi returns', async () => {
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    start('station-1');
    await settle();
    answer = ok;
    await vi.advanceTimersByTimeAsync(SCREEN_HEARTBEAT_INTERVAL_S * 1000);
    expect(calls).toHaveLength(2);

    fire('online');
    await settle();
    expect(calls).toHaveLength(3);
    visibility = 'hidden';
    fire('visibilitychange');
    await settle();
    expect(calls).toHaveLength(3);
    visibility = 'visible';
    fire('visibilitychange');
    await settle();
    expect(calls).toHaveLength(4);
  });
});

describe('what counts as the scanner typing', () => {
  let keydown: ((event: KeyboardEvent) => void) | null;
  let hook: RenderedHook<void, void> | undefined;

  beforeEach(() => {
    forgetScannerUse();
    keydown = null;
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
        if (type === 'keydown') keydown = listener;
      },
      removeEventListener: () => undefined,
    });
  });

  afterEach(() => {
    hook?.unmount();
    hook = undefined;
    vi.unstubAllGlobals();
  });

  const press = (key: string, at: number) =>
    keydown!({
      key, timeStamp: at, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, target: null,
      preventDefault: () => undefined, stopPropagation: () => undefined,
    } as unknown as KeyboardEvent);
  const type = (text: string, start: number, gap: number) => {
    [...text].forEach((key, index) => press(key, start + index * gap));
    press('Enter', start + text.length * gap);
  };

  it('notes a scan-paced burst, even one this page does not take', () => {
    hook = renderHook(() => useScannerBurst(() => undefined, { accept: () => false }));
    type('T1-7KMQ4XABCD', 1_000, 5);
    expect(lastScanSecondsAgo()).not.toBeNull();
  });

  it('does not note a person typing', () => {
    hook = renderHook(() => useScannerBurst(() => undefined));
    type('T1-7KMQ4XABCD', 1_000, 400);
    expect(lastScanSecondsAgo()).toBeNull();
  });
});

describe('the till is wired to it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = (path: string) => readFileSync(join(here, '..', 'src', path), 'utf8');

  it('beats for the platform station it holds, through the lock', () => {
    expect(source('station/StationContext.tsx')).toContain('useStationHeartbeat(laneStationId)');
  });

  it('the wristband field notes a code that arrived as a scan or a paste, never one typed by hand', () => {
    const text = source('components/fnb/ScanWristband.tsx');
    expect(text.match(/noteScannerUse\(\)/g)).toHaveLength(2);
    expect(text).toContain('if (arrivedWhole()) noteScannerUse();');
    expect(text).toContain('run.current.pasted || run.current.length >= SCANNER_BURST_MIN_LENGTH');
  });
});
