import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { holdBoxSession, setBridgeOrigin, watchBridgeSnapshots } from '@/api/bridge';
const station = '018f0000-0000-7000-8000-0000000057a1';
const scan = { kind: 'scan', scanId: '018f0000-0000-7000-8000-000000000001', source: 'box_hid',
  codeKind: 'wallet', codeFingerprint: 'a'.repeat(16), outcome: 'handled', handler: 'wallet-qr',
  errorCode: null, detail: { walletKey: 'ZZ TEST synthetic key' }, actionId: null, scannedAt: new Date().toISOString() };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test'); setBridgeOrigin('https://counter.example.test'); holdBoxSession('ZZ TEST session'); });
afterEach(() => { setBridgeOrigin(null); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('HIGH: the authenticated staff stream reads fragmented scans, never exposing its bearer in a URL', async () => {
  let wire: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } });
  const request = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', request);
  const onScan = vi.fn();
  const stop = watchBridgeSnapshots(station, { onScan, onSnapshot: vi.fn(), onState: vi.fn(), onFailure: vi.fn() });
  try {
    await vi.advanceTimersByTimeAsync(0);
    const data = 'event: scan\ndata: ' + JSON.stringify(scan) + '\n\n';
    wire!.enqueue(new TextEncoder().encode(data.slice(0, 20))); wire!.enqueue(new TextEncoder().encode(data.slice(20)));
    await vi.advanceTimersByTimeAsync(0);
    expect(onScan).toHaveBeenCalledExactlyOnceWith(scan);
    expect(request.mock.calls[0]![0]).not.toContain('ZZ TEST session');
    expect(request.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { authorization: 'Bearer ZZ TEST session' } });
    holdBoxSession(null);
    wire!.enqueue(new TextEncoder().encode(data)); await vi.advanceTimersByTimeAsync(0);
    expect(onScan).toHaveBeenCalledOnce();
    expect((request.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
  } finally { stop(); wire!.close(); }
});
it('CRITICAL: a paired customer display never invokes the staff scan handler', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(scan) + '\n\n')); controller.close(); } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
  const onScan = vi.fn();
  const stop = watchBridgeSnapshots(station, { bearer: 'ZZ TEST display', onScan, onSnapshot: vi.fn(), onState: vi.fn(), onFailure: vi.fn() });
  await vi.advanceTimersByTimeAsync(0); expect(onScan).not.toHaveBeenCalled(); stop();
});
