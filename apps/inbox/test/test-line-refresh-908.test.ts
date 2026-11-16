import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxMe } from '@/api/inbox';
import { fastInboxRefresh, startFastInboxRefresh } from '@/lib/refresh';

const me = { simulator: null, testLines: [{ id: 'sandbox', channel: 'whatsapp', displayName: 'WhatsApp test line', branchId: null, startOver: true }] } as Pick<InboxMe, 'simulator' | 'testLines'>;
afterEach(() => vi.useRealTimers());

describe('SCRUM-908: live test-line refresh', () => {
  it('refreshes an empty named test inbox and an open test chat reached from All or General', () => {
    expect(fastInboxRefresh(me, false, 'sandbox', null)).toBe(true);
    expect(fastInboxRefresh(me, false, '', 'sandbox')).toBe(true);
    expect(fastInboxRefresh(me, false, '', 'ordinary')).toBe(false);
    expect(fastInboxRefresh({ testLines: [], simulator: null }, false, 'sandbox', 'sandbox')).toBe(false);
  });

  it('keeps simulator refresh, with one timer even when the test line is selected too', () => {
    vi.useFakeTimers();
    const simulator = { ...me, simulator: { channelAccounts: [] } } as Pick<InboxMe, 'simulator' | 'testLines'>;
    expect(fastInboxRefresh(simulator, true, '', null)).toBe(true);
    expect(fastInboxRefresh(simulator, false, '', null)).toBe(false);
    const refresh = vi.fn();
    const stop = startFastInboxRefresh(fastInboxRefresh(simulator, true, 'sandbox', 'sandbox'), () => true, refresh);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(9000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses hidden-tab requests and stops when the view changes or unmounts', () => {
    vi.useFakeTimers();
    let visible = true;
    const refresh = vi.fn();
    const stop = startFastInboxRefresh(true, () => visible, refresh);
    vi.advanceTimersByTime(2999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    visible = false;
    vi.advanceTimersByTime(9000);
    expect(refresh).toHaveBeenCalledTimes(1);
    visible = true;
    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop?.();
    expect(startFastInboxRefresh(false, () => true, refresh)).toBeUndefined();
    vi.advanceTimersByTime(30000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
