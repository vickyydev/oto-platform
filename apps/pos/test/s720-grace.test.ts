import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string) => key === 'display.connectionPaused' ? 'Connection paused, your order is safe' : 'Reconnecting' }) }));
vi.mock('@/lib/displaySession', () => ({ readTicketDisplayView: () => null }));
vi.mock('@/api/display', async () => ({ ...await vi.importActual('@/api/display'),
  displayApi: { pairing: vi.fn(async () => ({ status: 'paired', station: { id: '018f0000-0000-7000-8000-0000000057a1', name: 'ZZ TEST counter', kind: 'till' } })) },
  readDisplayCredential: () => 'a'.repeat(64), rememberDisplayCredential: () => true }));
import Display from '@/pages/Display';
import { watchBridgeSnapshots } from '@/api/bridge';
import { renderHook } from './support/hooks';

const id = '018f0000-0000-7000-8000-0000000057a1';
const document = { stationId: id, boxId: '018f0000-0000-7000-8000-00000000b0c5', schemaVersion: 1, sequence: 1, stage: 'welcome', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-02T00:00:00Z' };
const session = { station: { id, name: 'ZZ TEST counter', kind: 'till' }, device: { id: '018f0000-0000-7000-8000-00000000d15b', name: 'ZZ TEST screen' }, document };
const PAUSED = 'Connection paused, your order is safe';
const encoder = new TextEncoder();
const snapshot = `event: snapshot\ndata: ${JSON.stringify({ kind: 'snapshot', document })}\n\n`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('React', React);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The network: a stream the test feeds, and reads that hang once the line goes dead. */
const network = () => {
  const line = { wire: null as ReadableStreamDefaultController<Uint8Array> | null, dead: false };
  const hang = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (line.dead) return hang(init);
    if (url.endsWith('/display/channel')) {
      init?.signal?.addEventListener('abort', () => { try { line.wire?.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
      return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { line.wire = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(session), { headers: { 'content-type': 'application/json' } });
  }));
  return line;
};

describe('SCRUM-720 a silent stream, through the real stream reader', () => {
  it('hides the total fifteen seconds after the last byte', async () => {
    const line = network();
    let tree: unknown;
    const hook = renderHook(() => { tree = Display(); });
    const text = () => JSON.stringify(tree);
    await vi.advanceTimersByTimeAsync(0);
    line.wire!.enqueue(encoder.encode(snapshot));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(text()).toContain('ZZ TEST counter');
    // The last byte the display will ever get: a heartbeat at five seconds.
    line.wire!.enqueue(encoder.encode(': heartbeat\n\n'));
    line.dead = true;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(text()).not.toContain(PAUSED);
    expect(text()).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(text()).toContain(PAUSED);
    hook.unmount();
  });
});

describe('SCRUM-720 the stream reader reports what it hears', () => {
  it('reports every chunk, heartbeats included, and nothing before the first byte', async () => {
    let wire: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => { wire = controller; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
    const onActivity = vi.fn();
    const stop = watchBridgeSnapshots(id, { bearer: 'a'.repeat(64), onSnapshot: vi.fn(), onState: vi.fn(), onFailure: vi.fn(), onActivity });
    await vi.advanceTimersByTimeAsync(0);
    expect(onActivity).not.toHaveBeenCalled();
    wire!.enqueue(encoder.encode(': heartbeat\n\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onActivity).toHaveBeenCalledOnce();
    wire!.enqueue(encoder.encode(snapshot));
    await vi.advanceTimersByTimeAsync(0);
    expect(onActivity).toHaveBeenCalledTimes(2);
    stop();
  });
});
