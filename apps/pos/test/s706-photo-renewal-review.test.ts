import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { forgetPhotoUrl, photoUrlOf } from '@/api/checkin';

vi.mock('@/api/client', () => ({ api: { get: vi.fn() }, idemKey: vi.fn() }));
const start = Date.UTC(2026, 10, 2, 2);
const signed = (tag: string, seconds = 300) => `https://photos.example.test/${tag}?X-Amz-Date=20261102T020000Z&X-Amz-Expires=${seconds}`;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); vi.mocked(api.get).mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('SCRUM-706 adversarial photo-cache review', () => {
  it('control: redraws and concurrent readers share one access-logged request', async () => {
    vi.mocked(api.get).mockResolvedValue({ url: signed('shared') });
    const first = photoUrlOf('shared'); const second = photoUrlOf('shared');
    expect(first).toBe(second);
    expect(await first).toBe(signed('shared'));
    vi.setSystemTime(start + 60_000);
    expect(await photoUrlOf('shared')).toBe(signed('shared'));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it('MEDIUM fixed finding: renew thirty seconds before the link signed expiry', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ url: signed('first') }).mockResolvedValueOnce({ url: signed('renewed') });
    await photoUrlOf('expiry');
    vi.setSystemTime(start + 269_999);
    expect(await photoUrlOf('expiry')).toBe(signed('first'));
    expect(api.get).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 270_000);
    expect(await photoUrlOf('expiry')).toBe(signed('renewed'));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it('MEDIUM fixed finding: use the signing time and actual lifetime, not the time the client read the link', async () => {
    vi.setSystemTime(start + 100_000);
    vi.mocked(api.get).mockResolvedValueOnce({ url: signed('short', 120) }).mockResolvedValueOnce({ url: signed('fresh') });
    await photoUrlOf('short');
    expect(await photoUrlOf('short')).toBe(signed('fresh'));
  });
  it('control: a refused URL request is not remembered', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ url: signed('recovered') });
    expect(await photoUrlOf('network')).toBeNull();
    expect(await photoUrlOf('network')).toBe(signed('recovered'));
  });
  it('MEDIUM pin: an image failure drops its URL and concurrent retries share one fresh read', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ url: signed('broken') }).mockResolvedValueOnce({ url: signed('replacement') });
    const broken = await photoUrlOf('image-failure');
    forgetPhotoUrl('image-failure', broken!);
    const first = photoUrlOf('image-failure');
    forgetPhotoUrl('image-failure', broken!);
    expect(photoUrlOf('image-failure')).toBe(first);
    expect(await first).toBe(signed('replacement'));
    forgetPhotoUrl('image-failure', broken!);
    expect(await photoUrlOf('image-failure')).toBe(signed('replacement'));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it('MEDIUM pin: an unreadable expiry is never remembered indefinitely', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ url: 'https://photos.example.test/no-expiry' }).mockResolvedValueOnce({ url: signed('known') });
    await photoUrlOf('unknown-expiry');
    expect(await photoUrlOf('unknown-expiry')).toBe(signed('known'));
  });
});
