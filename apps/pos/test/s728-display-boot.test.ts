import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startDisplayBoot } from '../box-display/boot';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('HIGH: a cold agent 503 recovers automatically; it is not a build mismatch', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ build: 'same-build' })));
  vi.stubGlobal('fetch', fetch);
  const show = vi.fn(); const stop = startDisplayBoot('same-build', show);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(show).toHaveBeenLastCalledWith('ready');
    expect(show).not.toHaveBeenCalledWith('mismatch');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});

it('HIGH: an answered build mismatch keeps the reload notice and stops retrying', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ build: 'other-build' })));
  vi.stubGlobal('fetch', fetch);
  const show = vi.fn(); const stop = startDisplayBoot('same-build', show);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(show).toHaveBeenLastCalledWith('mismatch');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

it('MEDIUM: a hung agent read is bounded, and stopping cancels the next attempt', async () => {
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetch);
  const show = vi.fn(); const stop = startDisplayBoot('same-build', show);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  expect(show).not.toHaveBeenCalledWith('mismatch');
  stop(); await vi.advanceTimersByTimeAsync(30_000);
  expect(fetch).toHaveBeenCalledTimes(1);
});
