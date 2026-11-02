import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyntheticEvent } from 'react';
import { renderHook } from './support/hooks';
import { api } from '@/api/client';
import type { ApiBoard } from '@/api/checkin';
import { useBoardPhotos } from '@/hooks/useBoardPhotos';

vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/client', () => ({ api: { get: vi.fn() }, idemKey: vi.fn() }));
const start = Date.UTC(2026, 10, 2, 2);
const signed = (tag: string) => `https://photos.example.test/${tag}?X-Amz-Date=20261102T020000Z&X-Amz-Expires=300`;
const board = (id: string) => ({ families: [{ photoFileId: id, children: [{ photoFileId: null }, { photoFileId: null }] }] }) as unknown as ApiBoard;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
class Photo { constructor(public src: string) {} get currentSrc() { return this.src; } }
const failed = (url: string) => ({ target: new Photo(url) }) as unknown as SyntheticEvent<HTMLDivElement>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start); vi.stubGlobal('HTMLImageElement', Photo); vi.mocked(api.get).mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SCRUM-706 board photo lifecycle', () => {
  it('refreshes an already displayed family photo on a later board read, without duplicate sibling or redraw requests', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ url: signed('old') }).mockResolvedValueOnce({ url: signed('new') });
    const view = renderHook(useBoardPhotos, board('board-expiry'));
    await flush(); expect(view.result.current.photos['board-expiry']).toBe(signed('old'));
    view.rerender(board('board-expiry')); await flush(); expect(api.get).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 270_000); view.rerender(board('board-expiry')); await flush();
    expect(view.result.current.photos['board-expiry']).toBe(signed('new'));
    expect(api.get).toHaveBeenCalledTimes(2); view.unmount();
  });
  it('renews a failed image immediately, bounds repeated failures, and retries on the next board read', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ url: signed('broken') }).mockResolvedValueOnce({ url: signed('retry') }).mockResolvedValueOnce({ url: signed('recovered') });
    const view = renderHook(useBoardPhotos, board('board-error')); await flush();
    view.result.current.handlePhotoError(failed(signed('broken'))); await flush();
    expect(view.result.current.photos['board-error']).toBe(signed('retry'));
    view.result.current.handlePhotoError(failed(signed('retry'))); await flush();
    expect(api.get).toHaveBeenCalledTimes(2);
    vi.setSystemTime(start + 30_000); view.rerender(board('board-error')); await flush();
    expect(view.result.current.photos['board-error']).toBe(signed('recovered'));
    expect(api.get).toHaveBeenCalledTimes(3); view.unmount();
  });
  it('ignores a late image failure for a URL already replaced and unrelated images', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ url: signed('old-error') }).mockResolvedValueOnce({ url: signed('current') });
    const view = renderHook(useBoardPhotos, board('late-image')); await flush();
    view.result.current.handlePhotoError(failed(signed('old-error'))); await flush();
    view.result.current.handlePhotoError(failed(signed('old-error')));
    view.result.current.handlePhotoError(failed(signed('unrelated'))); await flush();
    expect(api.get).toHaveBeenCalledTimes(2); view.unmount();
  });
  it('MEDIUM fixed finding: signing twice in one second may return the same URL; remount the failed image even then', async () => {
    vi.mocked(api.get).mockResolvedValue({ url: signed('same-second') });
    const view = renderHook(useBoardPhotos, board('same-second')); await flush();
    view.result.current.handlePhotoError(failed(signed('same-second')));
    expect(view.result.current.photos['same-second']).toBeUndefined();
    await flush(); expect(view.result.current.photos['same-second']).toBe(signed('same-second'));
    expect(api.get).toHaveBeenCalledTimes(2); view.unmount();
  });
  it('does not apply a photo reply after leaving the board', async () => {
    let finish!: (value: { url: string }) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(useBoardPhotos, board('left-board') as ApiBoard | null);
    view.rerender(null); finish({ url: signed('late') }); await flush();
    expect(view.result.current.photos).toEqual({}); view.unmount();
  });
});
