import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationChannelMessage } from '@oto/shared';

const mock = vi.hoisted(() => ({ session: vi.fn(), authenticate: vi.fn(), subscribe: vi.fn() }));
vi.mock('../src/services/display', () => ({ authenticateDisplay: mock.authenticate, displaySession: mock.session }));
vi.mock('../src/services/station-session', () => ({ managerForStation: () => ({ manager: { subscribe: mock.subscribe }, boxId: 'box' }) }));
import { subscribeDisplayChannel } from '../src/services/station-bridge';
import type { DisplayDeviceAuth } from '../src/services/display';
import type { Db } from '@oto/db';

const auth = { credentialId: 'display', station: { id: 'station', boxId: 'box' }, device: { id: 'display', name: 'ZZ TEST' } } as unknown as DisplayDeviceAuth;
const document = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 1, stage: 'welcome', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-02T00:00:00Z' };
const snapshot = (sequence: number) => ({ kind: 'snapshot', view: 'customer', document: { ...document, sequence }, actionId: null, serverTime: '2026-11-02T00:00:00Z' }) as unknown as StationChannelMessage;

describe('SCRUM-720 the record kept from a stream', () => {
  let push: (message: StationChannelMessage) => void;
  let close: ReturnType<typeof vi.fn>;
  let sent: StationChannelMessage[];
  const open = async () => {
    const stop = subscribeDisplayChannel({} as Db, auth, 'hash', (message) => { sent.push(message); }, close, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    return stop;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sent = [];
    close = vi.fn();
    mock.authenticate.mockResolvedValue(auth);
    mock.session.mockResolvedValue({ document });
    mock.subscribe.mockImplementation((_id: string, _view: string, send: (message: StationChannelMessage) => void) => { push = send; return vi.fn(); });
  });
  afterEach(() => vi.useRealTimers());

  it('writes the first delivery after a quiet spell at once', async () => {
    const stop = await open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.session).toHaveBeenCalledTimes(1);
    push(snapshot(2));
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.session).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps a burst to one write per gap, and still ends on the last snapshot', async () => {
    const stop = await open();
    mock.session.mockClear();
    for (let sequence = 2; sequence < 102; sequence += 1) {
      push(snapshot(sequence));
      await vi.advanceTimersByTimeAsync(10);
    }
    // One hundred snapshots delivered in a second, no write yet: the gap has not run.
    expect(sent).toHaveLength(101);
    expect(mock.session).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mock.session).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.session).toHaveBeenCalledTimes(1);
    stop();
  });

  it('writes at most once every five seconds over a long stream', async () => {
    const stop = await open();
    mock.session.mockClear();
    for (let second = 0; second < 300; second += 1) {
      push(snapshot(second + 2));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(mock.session.mock.calls.length).toBeGreaterThanOrEqual(59);
    expect(mock.session.mock.calls.length).toBeLessThanOrEqual(60);
    stop();
  });

  it('writes the last snapshot when the stream ends inside a gap, and nothing when it was already written', async () => {
    const stop = await open();
    mock.session.mockClear();
    push(snapshot(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.session).toHaveBeenCalledTimes(0);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.session).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.session).toHaveBeenCalledTimes(1);

    const quiet = await open();
    mock.session.mockClear();
    quiet();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.session).toHaveBeenCalledTimes(0);
  });

  it('keeps the stream open when the record cannot be written', async () => {
    const stop = await open();
    mock.session.mockRejectedValue(new Error('Record unavailable'));
    push(snapshot(2));
    await vi.advanceTimersByTimeAsync(6_000);
    push(snapshot(3));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mock.session.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(close).not.toHaveBeenCalled();
    expect(sent).toHaveLength(3);
    stop();
  });

  it('does not write for a snapshot it refused to deliver', async () => {
    const stop = await open();
    push(snapshot(9));
    await vi.advanceTimersByTimeAsync(6_000);
    mock.session.mockClear();
    push(snapshot(4));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mock.session).toHaveBeenCalledTimes(0);
    stop();
  });
});
