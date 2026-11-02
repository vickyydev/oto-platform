import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchBridgeSnapshots } from '@/api/bridge';
const id = '018f0000-0000-7000-8000-0000000057a1';
const doc = { stationId: id, boxId: '018f0000-0000-7000-8000-00000000b0c5', schemaVersion: 1, sequence: 1, stage: 'welcome', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-02T00:00:00Z' };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('reads fragmented snapshots, uses only header credentials, falls back and retries after a drop', async () => {
  let wire: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: controller => { wire = controller; } });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    .mockResolvedValue(new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const onSnapshot = vi.fn(), onState = vi.fn(), onFailure = vi.fn();
  const stop = watchBridgeSnapshots(id, { bearer: 'a'.repeat(64), onSnapshot, onState, onFailure });
  await vi.advanceTimersByTimeAsync(0);
  const frame = `event: snapshot\ndata: ${JSON.stringify({ kind: 'snapshot', document: doc })}\n\n`;
  wire!.enqueue(new TextEncoder().encode(frame.slice(0, 15)));
  wire!.enqueue(new TextEncoder().encode(frame.slice(15)));
  await vi.advanceTimersByTimeAsync(0);
  expect(onSnapshot).toHaveBeenCalledWith(doc);
  expect(onState).toHaveBeenLastCalledWith(true);
  expect(fetcher.mock.calls[0]![0]).not.toContain('a'.repeat(64));
  expect(fetcher.mock.calls[0]![1].credentials).toBe('omit');
  wire!.close(); await vi.advanceTimersByTimeAsync(0);
  expect(onState).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  stop(); await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('abandons a buffered or silent stream after three seconds so polling can continue', async () => {
  vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))));
  const onState = vi.fn(), onFailure = vi.fn();
  const stop = watchBridgeSnapshots(id, { bearer: 'a'.repeat(64), onSnapshot: vi.fn(), onState, onFailure });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(onState).toHaveBeenCalledWith(false);
  expect(onFailure).toHaveBeenCalledOnce(); stop();
});
