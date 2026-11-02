import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyntheticEvent } from 'react';
import { renderHook } from './support/hooks';
import { api } from '@/api/client';
import { photoUrlOf, type ApiBoard } from '@/api/checkin';
import { photoBackoffMs, useBoardPhotos } from '@/hooks/useBoardPhotos';

vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/client', () => ({ api: { get: vi.fn() }, idemKey: vi.fn() }));

const start = Date.UTC(2026, 10, 2, 2);
const POLL_MS = 30_000;
const MINUTE = 60_000;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const board = (id: string) => ({ families: [{ photoFileId: id, children: [{ photoFileId: null }, { photoFileId: null }] }] }) as unknown as ApiBoard;
class Photo { constructor(public src: string) {} get currentSrc() { return this.src; } }
const image = (url: string) => ({ target: new Photo(url) }) as unknown as SyntheticEvent<HTMLDivElement>;

/** A link signed at this moment by a server whose clock differs from the device's. */
let serverAheadOfDevice = 0;
let minted = 0;
function freshLink(seconds = 300): string {
  const stamp = new Date(Date.now() + serverAheadOfDevice).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `https://photos.example.test/${++minted}?X-Amz-Date=${stamp}&X-Amz-Expires=${seconds}`;
}
const reads = () => vi.mocked(api.get).mock.calls.length;
const answerWithFreshLinks = () => vi.mocked(api.get).mockImplementation(async () => ({ url: freshLink() }));

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start); vi.stubGlobal('HTMLImageElement', Photo); vi.mocked(api.get).mockReset();
  serverAheadOfDevice = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SCRUM-716: a photo that cannot load is paced', () => {
  it('the wait starts at nothing, doubles from thirty seconds and stops at fifteen minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 40, 5000].map(n => photoBackoffMs(n) / 1000)).toEqual([0, 30, 60, 120, 240, 480, 900, 900, 900, 900]);
  });

  /** Keep the board open, polling every thirty seconds, with every link's image failing. */
  async function openWithBrokenFile(id: string, minutes: number, each?: (at: number) => void) {
    answerWithFreshLinks();
    const view = renderHook(useBoardPhotos, board(id));
    await flush();
    const breakImage = async () => {
      const url = view.result.current.photos[id];
      if (url) { view.result.current.handlePhotoError(image(url)); await flush(); }
    };
    await breakImage(); await breakImage();
    for (let elapsed = POLL_MS; elapsed <= minutes * MINUTE; elapsed += POLL_MS) {
      vi.setSystemTime(start + elapsed);
      view.rerender(board(id));
      await flush();
      await breakImage(); await breakImage();
      each?.(elapsed);
    }
    return view;
  }

  it('HIGH fixed finding: a missing file asked for a link on every poll, up to 240 access-log rows an hour; it now settles to four', async () => {
    const atHour: Record<number, number> = {};
    const view = await openWithBrokenFile('missing-file', 180, (elapsed) => { atHour[elapsed / MINUTE] = reads(); });
    expect(reads()).toBeLessThan(25);
    expect(atHour[120]! - atHour[60]!).toBe(4);
    expect(atHour[180]! - atHour[120]!).toBe(4);
    view.unmount();
  });

  it('never waits longer than the cap between two asks', async () => {
    const askedAt: number[] = [];
    let seen = 0;
    const view = await openWithBrokenFile('capped-file', 120, (elapsed) => {
      if (reads() > seen) { seen = reads(); askedAt.push(elapsed); }
    });
    const gaps = askedAt.slice(1).map((at, i) => at - askedAt[i]!);
    expect(Math.max(...gaps)).toBe(15 * MINUTE);
    view.unmount();
  });

  it('a successful load resets it: the next failure retries at once and waits only thirty seconds', async () => {
    const view = await openWithBrokenFile('recovers', 10);
    const backedOff = reads();
    // A long way into the pause the file comes back, and the next allowed read loads.
    let elapsed = 10 * MINUTE;
    while (reads() === backedOff) {
      elapsed += POLL_MS;
      vi.setSystemTime(start + elapsed);
      view.rerender(board('recovers'));
      await flush();
    }
    const loaded = view.result.current.photos.recovers!;
    view.result.current.handlePhotoLoad(image(loaded));

    const beforeFailure = reads();
    view.result.current.handlePhotoError(image(loaded));
    await flush();
    expect(reads()).toBe(beforeFailure + 1); // at once, as a first failure
    const again = view.result.current.photos.recovers!;
    view.result.current.handlePhotoError(image(again));
    await flush();
    expect(reads()).toBe(beforeFailure + 1); // the second waits
    vi.setSystemTime(start + elapsed + POLL_MS);
    view.rerender(board('recovers'));
    await flush();
    expect(reads()).toBe(beforeFailure + 2); // and only thirty seconds
    view.unmount();
  });

  it('a link read that succeeds is not a recovery: only an image that loaded clears the count', async () => {
    const view = await openWithBrokenFile('still-broken', 5);
    const before = reads();
    let elapsed = 5 * MINUTE;
    while (reads() === before) {
      elapsed += POLL_MS;
      vi.setSystemTime(start + elapsed);
      view.rerender(board('still-broken'));
      await flush();
    }
    const url = view.result.current.photos['still-broken']!;
    view.result.current.handlePhotoError(image(url));
    await flush();
    expect(reads()).toBe(before + 1); // no immediate retry: the count carried on
    view.unmount();
  });

  it('a refused link read counts as a failure too, and recovers through a load', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('refused'));
    const view = renderHook(useBoardPhotos, board('refused-read'));
    await flush();
    for (let elapsed = POLL_MS; elapsed <= 30 * MINUTE; elapsed += POLL_MS) {
      vi.setSystemTime(start + elapsed);
      view.rerender(board('refused-read'));
      await flush();
    }
    expect(reads()).toBeLessThan(10);
    answerWithFreshLinks();
    let elapsed = 30 * MINUTE;
    while (!view.result.current.photos['refused-read']) {
      elapsed += POLL_MS;
      vi.setSystemTime(start + elapsed);
      view.rerender(board('refused-read'));
      await flush();
    }
    view.result.current.handlePhotoLoad(image(view.result.current.photos['refused-read']!));
    const before = reads();
    view.result.current.handlePhotoError(image(view.result.current.photos['refused-read']!));
    await flush();
    expect(reads()).toBe(before + 1);
    view.unmount();
  });

  it('sibling cards failing together on one family photo count as one failure', async () => {
    answerWithFreshLinks();
    const view = renderHook(useBoardPhotos, board('siblings'));
    await flush();
    const handler = view.result.current.handlePhotoError;
    const url = view.result.current.photos.siblings!;
    handler(image(url)); handler(image(url));
    await flush();
    expect(reads()).toBe(2); // one immediate retry
    const retry = view.result.current.photos.siblings!;
    expect(retry).not.toBe(url);
    view.result.current.handlePhotoError(image(retry));
    await flush();
    // That was the second failure, so the wait is thirty seconds and not sixty.
    vi.setSystemTime(start + POLL_MS);
    view.rerender(board('siblings'));
    await flush();
    expect(reads()).toBe(3);
    view.unmount();
  });

  it('control: a healthy photo never enters the pause, and a second photo on the board is not held by a broken one', async () => {
    answerWithFreshLinks();
    const both = { families: [{ photoFileId: 'broken-one', children: [{ photoFileId: null }] }, { photoFileId: 'healthy-one', children: [{ photoFileId: null }] }] } as unknown as ApiBoard;
    const view = renderHook(useBoardPhotos, both);
    await flush();
    view.result.current.handlePhotoLoad(image(view.result.current.photos['healthy-one']!));
    for (let round = 0; round < 3; round++) {
      const broken = view.result.current.photos['broken-one'];
      if (broken) { view.result.current.handlePhotoError(image(broken)); await flush(); }
    }
    expect(view.result.current.photos['healthy-one']).toBeDefined();
    const renewedBefore = view.result.current.photos['healthy-one'];
    vi.setSystemTime(start + 240_000);
    view.rerender({ ...both } as ApiBoard);
    await flush();
    expect(view.result.current.photos['healthy-one']).not.toBe(renewedBefore);
    view.unmount();
  });
});

describe('SCRUM-716: the expiry the board uses on a clock that is wrong', () => {
  /** Keep a healthy photo's board open, polling every thirty seconds. */
  async function pollHealthy(id: string, minutes: number) {
    answerWithFreshLinks();
    const view = renderHook(useBoardPhotos, board(id));
    await flush();
    for (let elapsed = POLL_MS; elapsed <= minutes * MINUTE; elapsed += POLL_MS) {
      vi.setSystemTime(start + elapsed);
      view.rerender(board(id));
      await flush();
    }
    return view;
  }

  it('control: a correct clock renews once per four minutes', async () => {
    const view = await pollHealthy('right-clock', 12);
    expect(reads()).toBe(4); // minutes 0, 4, 8 and 12
    view.unmount();
  });

  it.each([
    ['ten minutes', 10 * MINUTE],
    ['four and a half minutes', 4.5 * MINUTE],
    ['three minutes forty', 220_000],
    ['an hour', 60 * MINUTE],
  ])('HIGH fixed finding: a device %s fast re-read every photo on every poll; one extra read, then once per four minutes', async (_name, fast) => {
    serverAheadOfDevice = -fast;
    const view = await pollHealthy(`fast-${fast}`, 12);
    expect(reads()).toBeLessThanOrEqual(5);
    // What the old rule did on this clock: every poll for 12 minutes is 25 reads.
    expect(reads()).toBeLessThan(25 / 4);
    view.unmount();
  });

  it('a device a little fast keeps to the same pace', async () => {
    serverAheadOfDevice = -45_000;
    const view = await pollHealthy('slightly-fast', 12);
    expect(reads()).toBeLessThanOrEqual(5);
    view.unmount();
  });

  it('HIGH fixed finding: a slow device trusted the signature past the real expiry; the time it received the link caps it', async () => {
    serverAheadOfDevice = 10 * MINUTE;
    vi.mocked(api.get).mockImplementationOnce(async () => ({ url: freshLink() })).mockImplementationOnce(async () => ({ url: 'https://photos.example.test/renewed' }));
    await photoUrlOf('slow-clock');
    vi.setSystemTime(start + 239_999);
    await photoUrlOf('slow-clock');
    expect(reads()).toBe(1);
    vi.setSystemTime(start + 240_000);
    expect(await photoUrlOf('slow-clock')).toBe('https://photos.example.test/renewed');
    expect(reads()).toBe(2);
  });

  it('MEDIUM pin: the first old-looking link is still believed; a link that truly is old is asked for again at once', async () => {
    vi.setSystemTime(start + 100_000);
    const old = `https://photos.example.test/old?X-Amz-Date=20261102T020000Z&X-Amz-Expires=120`;
    vi.mocked(api.get).mockResolvedValueOnce({ url: old }).mockImplementationOnce(async () => ({ url: freshLink() }));
    expect(await photoUrlOf('old-link')).toBe(old);
    expect(await photoUrlOf('old-link')).not.toBe(old);
    expect(reads()).toBe(2);
    expect(await photoUrlOf('old-link')).not.toBe(old);
    expect(reads()).toBe(2);
  });

  it('MEDIUM pin: a good link on the same device does not inherit a fast-clock reading', async () => {
    serverAheadOfDevice = -10 * MINUTE;
    answerWithFreshLinks();
    await photoUrlOf('clock-fixed');
    await photoUrlOf('clock-fixed');
    expect(reads()).toBe(2);
    // The device's clock is corrected: the next link's own expiry rules again.
    serverAheadOfDevice = 0;
    vi.setSystemTime(start + 10 * MINUTE);
    await photoUrlOf('clock-fixed');
    expect(reads()).toBe(3);
    vi.setSystemTime(start + 10 * MINUTE + 239_999);
    await photoUrlOf('clock-fixed');
    expect(reads()).toBe(3);
    vi.setSystemTime(start + 10 * MINUTE + 240_000);
    await photoUrlOf('clock-fixed');
    expect(reads()).toBe(4);
  });
});
