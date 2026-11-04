import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, type RenderedHook } from './support/hooks';
import { useStationScans, type StationScanEvent } from '@/lib/scanChannel';

vi.mock('react', () => import('./support/hooks'));
const bridge = vi.hoisted(() => ({ local: true, callbacks: [] as Array<{ onScan: (scan: StationScanEvent) => void }>, stop: vi.fn() }));
vi.mock('@/api/bridge', () => ({
  hasBridgeOrigin: () => bridge.local,
  watchBridgeSnapshots: (_station: string, callbacks: { onScan: (scan: StationScanEvent) => void }) => {
    bridge.callbacks.push(callbacks); return bridge.stop;
  },
}));

class Channel {
  static CLOSED = 2;
  static latest: Channel;
  readyState = 1;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor() { Channel.latest = this; }
  addEventListener(kind: string, fn: (event: MessageEvent<string>) => void) { this.listeners.set(kind, fn); }
  removeEventListener(kind: string) { this.listeners.delete(kind); }
  close() { this.readyState = 2; }
  scan(value: StationScanEvent) { this.listeners.get('scan')?.({ data: JSON.stringify(value) } as MessageEvent<string>); }
}
const scan = (id = '018f0000-0000-7000-8000-000000000001'): StationScanEvent & { scanId: string } => ({
  kind: 'scan', scanId: id, source: 'box_hid', codeKind: 'wallet', codeFingerprint: 'a'.repeat(16),
  outcome: 'handled', handler: 'wallet-qr', errorCode: null,
  detail: { walletKey: 'ZZ TEST synthetic voucher' }, actionId: null, scannedAt: new Date().toISOString(),
});
let hook: RenderedHook<void, void> | undefined;
let visibility: string;
beforeEach(() => {
  vi.useFakeTimers(); visibility = 'visible'; bridge.local = true; bridge.callbacks.length = 0; bridge.stop.mockClear();
  vi.stubGlobal('EventSource', Channel);
  vi.stubGlobal('document', { get visibilityState() { return visibility; }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { hook?.unmount(); hook = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SCRUM-736: the direct box and platform hear one physical scan', () => {
  it.each(['box first', 'platform first'])('HIGH: one delivery when both paths are up (%s)', (order) => {
    const heard = vi.fn(); hook = renderHook(() => useStationScans('station-1', heard));
    expect(bridge.callbacks).toHaveLength(1);
    const message = scan();
    const direct = () => bridge.callbacks[0]!.onScan(message);
    const platform = () => Channel.latest.scan(message);
    if (order === 'box first') { direct(); platform(); } else { platform(); direct(); }
    expect(heard).toHaveBeenCalledExactlyOnceWith(message);
  });
  it('HIGH: a second deliberate scan of the same code is still delivered', () => {
    const heard = vi.fn(); hook = renderHook(() => useStationScans('station-1', heard));
    expect(bridge.callbacks).toHaveLength(1);
    bridge.callbacks[0]!.onScan(scan());
    bridge.callbacks[0]!.onScan(scan('018f0000-0000-7000-8000-000000000002'));
    expect(heard).toHaveBeenCalledTimes(2);
  });
  it('HIGH: the local scan works while the platform gives no answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('platform unreachable')));
    const heard = vi.fn(); hook = renderHook(() => useStationScans('station-1', heard));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bridge.callbacks).toHaveLength(1);
    bridge.callbacks[0]!.onScan(scan());
    expect(heard).toHaveBeenCalledOnce();
  });
  it('HIGH: a hidden scan cannot return through the other path after waking', () => {
    const heard = vi.fn(); hook = renderHook(() => useStationScans('station-1', heard));
    expect(bridge.callbacks).toHaveLength(1);
    visibility = 'hidden'; bridge.callbacks[0]!.onScan(scan());
    visibility = 'visible'; Channel.latest.scan(scan());
    expect(heard).not.toHaveBeenCalled();
  });
  it('HIGH: locking or switching stations stops the old direct subscriber', () => {
    let station: string | undefined = 'station-1';
    const heard = vi.fn(); hook = renderHook(() => useStationScans(station, heard));
    expect(bridge.callbacks).toHaveLength(1);
    const old = bridge.callbacks[0]!;
    station = undefined; hook.rerender(); old.onScan(scan());
    expect(bridge.stop).toHaveBeenCalledOnce(); expect(heard).not.toHaveBeenCalled();
    station = 'station-2'; hook.rerender(); old.onScan(scan());
    expect(heard).not.toHaveBeenCalled();
    bridge.callbacks[1]!.onScan(scan()); expect(heard).toHaveBeenCalledOnce();
  });
  it('MEDIUM: a virtual box keeps its working platform channel', () => {
    bridge.local = false;
    const heard = vi.fn(); hook = renderHook(() => useStationScans('station-1', heard));
    expect(bridge.callbacks).toHaveLength(0); Channel.latest.scan(scan());
    expect(heard).toHaveBeenCalledOnce();
  });
});
