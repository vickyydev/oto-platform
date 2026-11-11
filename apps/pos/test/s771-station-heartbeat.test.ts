import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCANNER_BURST_GAP_MS, SCANNER_BURST_MIN_LENGTH, SCREEN_HEARTBEAT_INTERVAL_S, SCREEN_SCAN_AGE_MAX_S } from '@oto/shared';
import { renderHook, type RenderedHook } from './support/hooks';
import { useStationHeartbeat } from '@/station/heartbeat';
import { useScannerBurst } from '@/lib/scannerBurst';
// The wristband field's own gap (`FIELD_SCAN_GAP_MS` is this) is the page listener's.
import { SCAN_PACE_GAP_MS, registerPageScanRoute, usePageScanShell } from '@/lib/pageScan';

const FIELD_SCAN_GAP_MS = SCAN_PACE_GAP_MS;
import {
  NO_PACED_RUN,
  forgetScannerUse,
  lastScanSecondsAgo,
  nextPacedRun,
  noteScannerUse,
  pacedLikeScanner,
  scanAgeMs,
  type PacedRun,
  type ScanClock,
} from '@/lib/scannerUse';

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

describe('what the staff app’s one page listener counts as the scanner typing (SCRUM-766)', () => {
  type Listener = (event: unknown) => void;
  let listeners: Map<string, Set<Listener>>;
  let shell: RenderedHook<void, void> | undefined;
  let leave: () => void;
  let taken: string[];
  const body = { tagName: 'BODY', closest: () => null };
  /** A field that reads codes itself: the wristband box, which notes its own. */
  const ownField = { tagName: 'INPUT', type: 'text', value: '', closest: (s: string) => (s === '[data-reads-scans]' ? {} : null) };

  const fire = (type: string, event: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };
  const press = (key: string, at: number, target: unknown) =>
    fire('keydown', {
      key, timeStamp: at, target, isComposing: false, ctrlKey: false, altKey: false, metaKey: false,
      preventDefault: () => undefined, stopPropagation: () => undefined,
    });
  const type = (text: string, gap: number, target: unknown = body, enter = true) => {
    [...text].forEach((key, index) => press(key, 1_000 + index * gap, target));
    if (enter) press('Enter', 1_000 + text.length * gap, target);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    forgetScannerUse();
    listeners = new Map();
    taken = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    });
    vi.stubGlobal('document', { activeElement: body, visibilityState: 'visible' });
    shell = renderHook(() => usePageScanShell());
    leave = registerPageScanRoute(() => ({ tab: (scan) => taken.push(scan.ok ? scan.key : '') }));
  });

  afterEach(() => {
    leave();
    shell?.unmount();
    shell = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('notes a scanner-paced code, whether a screen takes it or not, and one that ends with no Enter', () => {
    type('T1-7KMQ4XABCD', 15);
    expect(lastScanSecondsAgo()).not.toBeNull();
    forgetScannerUse();
    // A retail barcode: no screen here takes it, and it is still the scanner.
    type('8851234567890', 15);
    expect(taken).toEqual([]);
    expect(lastScanSecondsAgo()).not.toBeNull();
    forgetScannerUse();
    type('8851234567890', 15, body, false);
    vi.advanceTimersByTime(500);
    expect(lastScanSecondsAgo()).not.toBeNull();
  });

  it('does not note a person typing, a run at the page’s own wider gap, or a paste', () => {
    type('T1-7KMQ4XABCD', 400);
    expect(lastScanSecondsAgo()).toBeNull();
    type('8851234567890', SCAN_PACE_GAP_MS);
    vi.advanceTimersByTime(500);
    expect(lastScanSecondsAgo()).toBeNull();
    fire('paste', {
      target: body, clipboardData: { getData: () => '8851234567890' }, preventDefault: () => undefined,
    });
    expect(lastScanSecondsAgo()).toBeNull();
  });

  it('leaves a field that reads codes itself to note its own', () => {
    type('T1-7KMQ4XABCD', 15, ownField);
    vi.advanceTimersByTime(500);
    expect(lastScanSecondsAgo()).toBeNull();
  });
});

describe('the till is wired to it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = (path: string) => readFileSync(join(here, '..', 'src', path), 'utf8');

  it('beats for the platform station it holds, through the lock', () => {
    expect(source('station/StationContext.tsx')).toContain('useStationHeartbeat(laneStationId)');
  });

  it('the wristband field notes only a run at a scanner’s pace, on its quiet and on its Enter', () => {
    // SCRUM-802 moved the field rule intact into the shared hook used by F&B and History.
    expect(source('components/fnb/ScanWristband.tsx')).toContain('useScanField((value) => submit(value))');
    const text = source('lib/useScanField.ts');
    expect(text).toContain('paced.current = nextPacedRun(paced.current, { added, at, pasted });');
    expect(text.match(/noteScannerUse\(\)/g)).toHaveLength(2);
    expect(text.match(/if \(byScanner\) noteScannerUse\(\);/g)).toHaveLength(2);
    expect(text.match(/const byScanner = takePacedRun\(\);/g)).toHaveLength(2);
    // What opens the tab is not what notes the scanner: a paste still opens it.
    expect(text).not.toContain('arrivedWhole');
  });
});

describe('a run the wristband field reads as a scanner', () => {
  /** Each change to the field in turn, from an empty run. */
  const runOf = (changes: Array<{ added: number; at: number; pasted?: boolean }>): PacedRun =>
    changes.reduce<PacedRun>((run, change) => nextPacedRun(run, { pasted: false, ...change }), NO_PACED_RUN);
  /** `length` single characters, `gap` ms apart. */
  const keys = (length: number, gap: number) => Array.from({ length }, (_, i) => ({ added: 1, at: 1_000 + i * gap }));

  it('is a run of single characters at the shared scanner pace, as long as a scan', () => {
    expect(pacedLikeScanner(runOf(keys(SCANNER_BURST_MIN_LENGTH, SCANNER_BURST_GAP_MS)))).toBe(true);
    expect(pacedLikeScanner(runOf(keys(13, 20)))).toBe(true);
    expect(pacedLikeScanner(runOf(keys(SCANNER_BURST_MIN_LENGTH - 1, 20)))).toBe(false);
  });

  it('is not a paste, nor a single bulk insertion (QuickType, dictation), whatever its length', () => {
    expect(pacedLikeScanner(runOf([{ added: 13, at: 1_000, pasted: true }]))).toBe(false);
    expect(pacedLikeScanner(runOf([{ added: 13, at: 1_000 }]))).toBe(false);
    // A paste inside a paced run ends it.
    expect(pacedLikeScanner(runOf([...keys(4, 20), { added: 4, at: 1_080, pasted: true }, { added: 1, at: 1_090 }]))).toBe(false);
  });

  it('is not a run paced by the field’s own wider gap, nor a person typing', () => {
    expect(FIELD_SCAN_GAP_MS).toBeGreaterThan(SCANNER_BURST_GAP_MS);
    expect(pacedLikeScanner(runOf(keys(13, FIELD_SCAN_GAP_MS)))).toBe(false);
    expect(pacedLikeScanner(runOf(keys(13, 400)))).toBe(false);
  });
});
