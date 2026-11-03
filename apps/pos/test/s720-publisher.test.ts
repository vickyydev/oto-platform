import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
vi.mock('react', () => import('./support/hooks'));
const mock = vi.hoisted(() => ({ lease: vi.fn(), renew: vi.fn(), session: vi.fn(), publish: vi.fn(), release: vi.fn(), watch: vi.fn(), get: vi.fn(), displays: vi.fn(), lane: { value: 'platform' }, local: { value: false } }));
vi.mock('@/api/bridge', () => ({ bridgeApi: mock, watchBridgeSnapshots: mock.watch, hasBridgeOrigin: () => mock.local.value }));
vi.mock('@/api/client', async () => ({ ...await vi.importActual('@/api/client'), api: { get: mock.get } }));
vi.mock('@/lib/lane', () => ({ currentLane: () => mock.lane.value, isBoxLaneTrigger: () => false }));
import { takeTicketDisplayLeaseForSignOut, useTicketDisplay, type StationDisplayState, type TicketDisplayState } from '@/lib/displaySession';
import { ApiError, NetworkError } from '@/api/client';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

type Handlers = { onSnapshot: (doc: StationSessionDocument) => void; onState: (value: boolean) => void };
const state = (nickname = ''): TicketDisplayState => ({ stage: 'identify', step: 1, sessionKey: 'visitor', tier: 'tourist', phone: '', nickname, contactChannel: 'whatsapp', member: null, online: true });
const held = (leaseId: string): NonNullable<StationSessionDocument['lease']> => ({ leaseId, holder: 'till', holderKind: 'till', accountId: 'account', startedAt: '2026-11-02T00:00:00Z', heartbeatAt: '2026-11-02T00:00:00Z', expiresAt: '2026-11-02T00:01:00Z' });

/** The box's own compare-and-set: the sequence and the lease must both match. */
let box: StationSessionDocument;
let stream: Handlers;
let stopStream: ReturnType<typeof vi.fn>;
let leases: number;
const stale = () => new ApiError(409, 'STATION_STALE', 'The screen moved on; this is the latest.');
const claim = async () => {
  leases += 1;
  box = { ...box, sequence: box.sequence + 1, lease: held(`lease-${leases}`) };
  return { lease: { leaseId: box.lease!.leaseId }, document: box };
};
const notReady = new ApiError(409, 'STATION_NOT_READY', 'This till is not ready yet.');

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.lane.value = 'platform';
  mock.local.value = false;
  leases = 0;
  box = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 100, stage: 'identify', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-02T00:00:00Z' };
  mock.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST', connected: true }] });
  mock.displays.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST local', connected: true }] });
  mock.lease.mockImplementation(claim);
  mock.session.mockImplementation(async () => ({ document: box }));
  mock.renew.mockImplementation(async (_station: string, leaseId: string) => {
    if (box.lease?.leaseId !== leaseId) throw stale();
    return { document: box };
  });
  mock.publish.mockImplementation(async (_station: string, intent: { leaseId: string; lastSeenSequence: number; payload: Record<string, unknown> }) => {
    if (intent.lastSeenSequence !== box.sequence || intent.leaseId !== box.lease?.leaseId) throw stale();
    box = { ...box, ...intent.payload, sequence: box.sequence + 1 };
    return { document: box };
  });
  mock.release.mockResolvedValue({ released: true });
  stopStream = vi.fn();
  mock.watch.mockImplementation((_station: string, handlers: Handlers) => { stream = handlers; return stopStream; });
});
afterEach(() => vi.useRealTimers());

const mount = async () => {
  const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), state());
  await settle();
  return hook;
};
const lastPublish = () => mock.publish.mock.calls.at(-1)![1] as { lastSeenSequence: number; payload: { prompt: { nickname: string } } };

const tender = (subject = 'event_pass'): StationDisplayState => ({ key: `tender:${subject}`, supported: true,
  presentation: () => ({ stage: 'payment', step: null, cart: { kind: 'tender', supported: true, subject, method: 'qr' },
    member: null, totals: null, prompt: null,
    payment: { saleId: null, amountSatang: 12000, qrPayload: 'ZZ TEST code', qrImageUrl: null, expiresAt: null, status: 'pending', offline: false, online: true } }) });

describe('SCRUM-738 tender handoff keeps one publisher and lease', () => {
  it('HIGH: restores the latest till screen with the same lease after the tender ends', async () => {
    const hook = await mount();
    const release = hook.result.current.handover(tender());
    await vi.advanceTimersByTimeAsync(100);
    expect(box.cart?.kind).toBe('tender');
    expect(box.prompt).toBeNull();
    hook.rerender(state('ZZ TEST latest visitor'));
    await vi.advanceTimersByTimeAsync(100);
    expect(box.cart?.kind).toBe('tender');
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(box.stage).toBe('identify');
    expect(box.prompt?.nickname).toBe('ZZ TEST latest visitor');
    expect(box.payment).toBeNull();
    expect(mock.lease).toHaveBeenCalledOnce();
    expect(mock.release).not.toHaveBeenCalled();
    hook.unmount();
    expect(mock.release).toHaveBeenCalledWith('station', 'lease-1');
  });

  it('HIGH: an old cleanup cannot end a newer tender', async () => {
    const hook = await mount();
    const older = hook.result.current.handover(tender());
    const newer = hook.result.current.handover(tender('party_balance'));
    older();
    await vi.advanceTimersByTimeAsync(100);
    expect(box.cart?.subject).toBe('party_balance');
    newer();
    await vi.advanceTimersByTimeAsync(100);
    expect(box.stage).toBe('identify');
    hook.unmount();
  });

  it('HIGH: an old visitor answer is not consumed during the tender or after restoration', async () => {
    const answer = vi.fn();
    const hook = renderHook(() => useTicketDisplay('station', state(), answer));
    await settle();
    const prior = box.prompt!;
    const release = hook.result.current.handover(tender());
    stream.onSnapshot({ ...box, prompt: { ...prior, answer: { type: 'skip_identify', actionId: 'late-answer' } } });
    await vi.advanceTimersByTimeAsync(100);
    expect(answer).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(answer).not.toHaveBeenCalled();
    expect(box.prompt?.requestId).not.toBe(prior.requestId);
    hook.unmount();
  });

  it('HIGH: sign-out during a tender hands over the existing lease and stops all later publication', async () => {
    const hook = await mount();
    const release = hook.result.current.handover(tender());
    await vi.advanceTimersByTimeAsync(100);
    await expect(takeTicketDisplayLeaseForSignOut()).resolves.toBe('lease-1');
    const count = mock.publish.mock.calls.length;
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.publish).toHaveBeenCalledTimes(count);
    expect(mock.renew).not.toHaveBeenCalled();
    hook.unmount();
    expect(mock.release).not.toHaveBeenCalled(); // The authenticated sign-out owns that release.
  });

  it('HIGH: sign-out also captures a claim already on the wire, before its tender could publish', async () => {
    let finish!: () => void;
    mock.lease.mockImplementation(() => new Promise(resolve => { finish = () => { void claim().then(resolve); }; }));
    const hook = await mount();
    hook.result.current.handover(tender());
    const signingOut = takeTicketDisplayLeaseForSignOut();
    finish();
    await expect(signingOut).resolves.toBe('lease-1');
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.publish).not.toHaveBeenCalled();
    hook.unmount();
    expect(mock.release).not.toHaveBeenCalled();
  });

  it('HIGH: a staff lock pauses a tender and unlock publishes its latest state', async () => {
    const hook = renderHook((active: boolean) => useTicketDisplay('station', state(), vi.fn(), active), true as boolean);
    await settle();
    hook.rerender(false);
    hook.result.current.handover(tender('party_balance'));
    const count = mock.publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.publish).toHaveBeenCalledTimes(count);
    hook.rerender(true);
    await settle();
    expect(box.cart?.subject).toBe('party_balance');
    expect(mock.lease).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('MEDIUM: a paused ticket quote cannot freeze an independent pass tender', async () => {
    const value: TicketDisplayState = { ...state(), step: 8, quoteRefreshing: true };
    const hook = renderHook((input: TicketDisplayState) => useTicketDisplay('station', input, vi.fn()), value);
    await settle();
    expect(mock.publish).not.toHaveBeenCalled();
    const release = hook.result.current.handover(tender());
    await settle();
    expect(box.cart?.kind).toBe('tender');
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(box.stage).toBe('welcome');
    expect(box.payment).toBeNull();
    expect(box.prompt).toBeNull();
    hook.rerender({ ...state(), nickname: 'ZZ TEST refreshed' });
    await vi.advanceTimersByTimeAsync(100);
    expect(box.prompt?.nickname).toBe('ZZ TEST refreshed');
    hook.unmount();
  });

  it('HIGH: a callback retained by another station cannot take over the new station', async () => {
    const hook = renderHook((stationId: string) => useTicketDisplay(stationId, state(), vi.fn()), 'station' as string);
    await settle();
    const old = hook.result.current.handover;
    hook.rerender('station-other');
    await settle();
    old(tender());
    await vi.advanceTimersByTimeAsync(100);
    expect(box.cart?.kind).not.toBe('tender');
    hook.unmount();
  });
});

describe('SCRUM-720 a box whose sequence fell', () => {
  it('HIGH SCRUM-713: a local display keeps following online without a cloud presence record', async () => {
    mock.local.value = true;
    mock.get.mockResolvedValue({ displays: [] });
    const hook = await mount();
    expect(mock.publish).toHaveBeenCalledOnce();
    expect(hook.result.current.connected).toEqual([{ id: 'display', name: 'ZZ TEST local', connected: true }]);
    await vi.advanceTimersByTimeAsync(60_000);
    hook.rerender(state('ZZ TEST local display after idle'));
    await vi.advanceTimersByTimeAsync(100);
    expect(lastPublish().payload.prompt.nickname).toBe('ZZ TEST local display after idle');
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.lane.value).toBe('platform');
    hook.unmount();
  });

  it('recovers with one claim and one publish, and does not loop until a reload', async () => {
    const hook = await mount();
    expect(box.sequence).toBe(102);
    // The store comes back from an earlier copy: a lower number and no lease.
    box = { ...box, sequence: 5, lease: null };
    hook.rerender(state('ZZ TEST after restore'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.lease).toHaveBeenCalledTimes(2);
    expect(mock.publish.mock.calls.length).toBeLessThanOrEqual(3);
    expect(box.sequence).toBe(7);
    expect((box.prompt as { nickname: string }).nickname).toBe('ZZ TEST after restore');
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it('takes the lower number from a plain read, so a held lease publishes without a claim', async () => {
    const hook = await mount();
    // The store lost what the till told it, so the same presentation goes again.
    box = { ...box, sequence: 5, prompt: null };
    await vi.advanceTimersByTimeAsync(500);
    expect(lastPublish().lastSeenSequence).toBe(5);
    expect(box.prompt).not.toBeNull();
    hook.rerender(state('ZZ TEST read'));
    await vi.advanceTimersByTimeAsync(50);
    expect(lastPublish().lastSeenSequence).toBe(6);
    expect(mock.lease).toHaveBeenCalledOnce();
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it('keeps a snapshot that arrived while an older reply was still on the wire', async () => {
    const hook = await mount();
    const older = box;
    let answer: (value: { document: StationSessionDocument }) => void = () => undefined;
    mock.session.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await vi.advanceTimersByTimeAsync(500);
    box = { ...box, sequence: box.sequence + 1 };
    stream.onSnapshot(box);
    answer({ document: older });
    await settle();
    hook.rerender(state('ZZ TEST newer'));
    await vi.advanceTimersByTimeAsync(100);
    expect(lastPublish().lastSeenSequence).toBe(103);
    expect(lastPublish().payload.prompt.nickname).toBe('ZZ TEST newer');
    expect(mock.lease).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('asks the box when a live stream delivers a lower number, because the snapshot may be late or the box may have fallen', async () => {
    const hook = await mount();
    stream.onState(true);
    await vi.advanceTimersByTimeAsync(1_500);
    mock.session.mockClear();
    // A late snapshot: the box is still ahead of it, and nothing is lost.
    stream.onSnapshot({ ...box, sequence: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(mock.session).toHaveBeenCalledOnce();
    hook.rerender(state('ZZ TEST late'));
    await vi.advanceTimersByTimeAsync(50);
    expect(lastPublish().lastSeenSequence).toBe(102);
    // A real fall: the read that follows is the box's own word for it.
    box = { ...box, sequence: 5 };
    stream.onSnapshot(box);
    await vi.advanceTimersByTimeAsync(50);
    expect(lastPublish().lastSeenSequence).toBe(5);
    expect(mock.lease).toHaveBeenCalledOnce();
    hook.unmount();
  });
});

describe('SCRUM-720 a refused claim', () => {
  it('backs off to one claim every thirty seconds, not two a second', async () => {
    mock.lease.mockRejectedValue(notReady);
    const hook = await mount();
    expect(mock.lease).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    // 0, 1, 3, 7, 15 and 31 seconds.
    expect(mock.lease).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60_000);
    // 61 and 91 seconds: the cap holds.
    expect(mock.lease).toHaveBeenCalledTimes(8);
    hook.unmount();
  });

  it('leaves the till showing its own inline display, with the reason, for the whole wait', async () => {
    mock.lease.mockRejectedValue(notReady);
    const hook = await mount();
    for (let second = 0; second < 60; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hook.result.current.connected).toEqual([]);
      expect(hook.result.current.error).toBe(notReady.message);
    }
    hook.unmount();
  });

  it('asks again at once when the till itself changes, and the display takes over on success', async () => {
    mock.lease.mockRejectedValue(notReady);
    const hook = await mount();
    await vi.advanceTimersByTimeAsync(40_000);
    const asked = mock.lease.mock.calls.length;
    mock.lease.mockImplementation(claim);
    hook.rerender(state('ZZ TEST ready'));
    await vi.advanceTimersByTimeAsync(50);
    expect(mock.lease).toHaveBeenCalledTimes(asked + 1);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.connected).toHaveLength(1);
    expect(lastPublish().payload.prompt.nickname).toBe('ZZ TEST ready');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.lease).toHaveBeenCalledTimes(asked + 1);
    hook.unmount();
  });

  it('asks again right after a refusal when the till changed while the claim was on the wire', async () => {
    let refuse: (reason: unknown) => void = () => undefined;
    mock.lease.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const hook = await mount();
    hook.rerender(state('ZZ TEST during claim'));
    mock.lease.mockRejectedValueOnce(notReady);
    refuse(notReady);
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    expect(mock.lease).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('does not ask again because a snapshot arrived during the wait', async () => {
    mock.lease.mockRejectedValue(notReady);
    const hook = await mount();
    await vi.advanceTimersByTimeAsync(40_000);
    const asked = mock.lease.mock.calls.length;
    for (let burst = 0; burst < 20; burst += 1) {
      stream.onSnapshot({ ...box, sequence: 200 + burst });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(mock.lease).toHaveBeenCalledTimes(asked);
    hook.unmount();
  });

  it('keeps the usual pace when the claim never reached the box', async () => {
    mock.lease.mockRejectedValue(new NetworkError(new Error('offline')));
    const hook = await mount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.lease.mock.calls.length).toBeGreaterThanOrEqual(10);
    hook.unmount();
  });
});

describe('SCRUM-720 the staff stream follows the display', () => {
  it('stays closed with no display, opens when one connects and closes when it leaves', async () => {
    mock.get.mockResolvedValue({ displays: [] });
    const hook = await mount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.watch).not.toHaveBeenCalled();
    mock.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST', connected: true }] });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mock.watch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.watch).toHaveBeenCalledOnce();
    stream.onState(true);
    mock.get.mockResolvedValue({ displays: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stopStream).toHaveBeenCalledOnce();
    hook.unmount();
    expect(stopStream).toHaveBeenCalledOnce();
  });

  it('opens on the box lane, where the platform cannot say who is watching', async () => {
    mock.lane.value = 'box';
    const hook = await mount();
    expect(mock.watch).toHaveBeenCalledOnce();
    hook.unmount();
    expect(stopStream).toHaveBeenCalledOnce();
  });

  it('polls again when the display that left took the stream with it', async () => {
    const hook = await mount();
    stream.onState(true);
    mock.get.mockResolvedValue({ displays: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    mock.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST', connected: true }] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mock.watch).toHaveBeenCalledTimes(2);
    mock.session.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.session).toHaveBeenCalled();
    hook.unmount();
  });
});
