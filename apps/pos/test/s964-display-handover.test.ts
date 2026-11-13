import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
vi.mock('react', () => import('./support/hooks'));
const mock = vi.hoisted(() => ({ lease: vi.fn(), renew: vi.fn(), session: vi.fn(), publish: vi.fn(), release: vi.fn(),
  watch: vi.fn(), get: vi.fn(), displays: vi.fn() }));
vi.mock('@/api/bridge', () => ({ bridgeApi: mock, watchBridgeSnapshots: mock.watch, hasBridgeOrigin: () => false }));
vi.mock('@/api/client', async () => ({ ...await vi.importActual('@/api/client'), api: { get: mock.get } }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', isBoxLaneTrigger: () => false }));
import { DISPLAY_HANDOVER_WAIT, forgetDisplayHolders, useTicketDisplay, type TicketDisplayState } from '@/lib/displaySession';
import { signedInAccount } from '@/lib/displayAccount';
import { ApiError } from '@/api/client';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

/**
 * SCRUM-964 (point 1) — A KEPT SALE CONTINUED BY ANOTHER PERSON NO LONGER
 * FREEZES THE COUNTER DISPLAY.
 *
 * Seen on staging (docs/qa/proof-2026-11-13/SCRUM-878, 03a to 03e): ZZ TEST
 * Session A's session was ended mid-sale, ZZ TEST Session B signed in on the
 * same till and pressed Continue, and for the rest of the sale the paired
 * display kept A's last order while the till said "Another till is holding
 * this station": the till kept A's lease, the box refused B's renew and
 * publish 403, and the till only ever cleared a lease on 409.
 *
 * The box here answers as `packages/box-agent/src/station-session.ts` does,
 * word for word where the till reads the words: a lease belongs to the
 * account that claimed it (`heldBy`) and runs 60 seconds from its last
 * renewal; a claim on a live lease that is not the same holder AND the same
 * account is refused `no_lease` (409 STATION_NO_LEASE, the document attached);
 * renew, publish and release by another account are refused `not_permitted`
 * (403 STATION_NOT_PERMITTED, "Another till is holding this station…");
 * another lease id is `stale` (409).
 */

const TTL_MS = 60_000;
const ANN = 'zz-test-ann';
const BEN = 'zz-test-ben';
const NOT_THE_HOLDER = 'Another till is holding this station. A manager can take it over.';
const ANOTHER_TILL = 'Another till is using this station. A manager can take it over.';

/** The account the till's requests carry now (its session cookie); null once that session has ended. */
let caller: string | null = ANN;
let box: StationSessionDocument;
let minted = 0;
const refusal = (status: number, code: string, message: string) => new ApiError(status, code, message, { document: box });
const live = () => box.lease !== null && Date.parse(box.lease.expiresAt) > Date.now();

function boxAnswersAsTheBoxDoes() {
  mock.lease.mockImplementation(async (_station: string, holder: string) => {
    if (caller === null) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
    const held = box.lease;
    const sameScreen = held !== null && held.holder === holder && held.accountId === caller;
    if (live() && !sameScreen) throw refusal(409, 'STATION_NO_LEASE', ANOTHER_TILL);
    const renewing = live() && sameScreen;
    const now = new Date().toISOString();
    const leaseId = renewing ? held!.leaseId : `lease-${(minted += 1)}`;
    box = { ...box, sequence: renewing ? box.sequence : box.sequence + 1, lease: { leaseId, holder, holderKind: 'till',
      accountId: caller, startedAt: renewing ? held!.startedAt : now, heartbeatAt: now,
      expiresAt: new Date(Date.now() + TTL_MS).toISOString() } };
    return { lease: { leaseId }, document: box };
  });
  mock.renew.mockImplementation(async (_station: string, leaseId: string) => {
    if (caller === null) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
    if (!box.lease || box.lease.leaseId !== leaseId) throw refusal(409, 'STATION_STALE', 'Session moved to another till.');
    if (box.lease.accountId !== caller) throw refusal(403, 'STATION_NOT_PERMITTED', NOT_THE_HOLDER);
    box = { ...box, lease: { ...box.lease, heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString() } };
    return { document: box };
  });
  mock.publish.mockImplementation(async (_station: string, intent: { leaseId?: string; lastSeenSequence: number; payload: Record<string, unknown> }) => {
    if (caller === null) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
    if (!intent.leaseId) throw refusal(409, 'STATION_NO_LEASE', 'This till does not hold the station.');
    if (box.lease?.leaseId !== intent.leaseId) throw refusal(409, 'STATION_STALE', 'Session moved to another till.');
    if (box.lease.accountId !== caller) throw refusal(403, 'STATION_NOT_PERMITTED', NOT_THE_HOLDER);
    if (intent.lastSeenSequence !== box.sequence) throw refusal(409, 'STATION_STALE', 'The screen moved on; this is the latest.');
    box = { ...box, ...intent.payload, sequence: box.sequence + 1 };
    return { document: box };
  });
  mock.release.mockImplementation(async (_station: string, leaseId: string) => {
    if (box.lease && box.lease.leaseId === leaseId && box.lease.accountId !== caller) throw refusal(403, 'STATION_NOT_PERMITTED', NOT_THE_HOLDER);
    if (box.lease?.leaseId !== leaseId) return { released: false };
    box = { ...box, lease: null, sequence: box.sequence + 1, stage: 'identify', prompt: null };
    return { released: true };
  });
  mock.session.mockImplementation(async () => ({ document: box }));
}

/** What the till publishes for the sale on screen, named so a change is visible on the box. */
const screen = (nickname: string): TicketDisplayState => ({ stage: 'identify', step: 1, sessionKey: 'kept-sale', tier: 'tourist',
  phone: '', nickname, contactChannel: 'whatsapp', member: null, online: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 13, 13, 0));
  vi.clearAllMocks();
  forgetDisplayHolders();
  caller = ANN;
  signedInAccount.set(ANN);
  minted = 0;
  box = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 100, stage: 'identify', language: 'en', lease: null,
    takeoverCount: 0, updatedAt: '2026-11-13T13:00:00Z' };
  mock.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST display', connected: true }] });
  mock.watch.mockImplementation(() => () => undefined);
  boxAnswersAsTheBoxDoes();
});
afterEach(() => {
  signedInAccount.set(null);
  vi.useRealTimers();
});

/** A's session at the till: the sale on screen is published under A's own lease. */
async function annAtTheTill() {
  const till = renderHook((props: { shown: TicketDisplayState; active: boolean }) =>
    useTicketDisplay('station', props.shown, vi.fn(), props.active), { shown: screen('ZZ TEST cart'), active: true });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(box.lease?.accountId).toBe(ANN);
  expect(box.prompt?.nickname).toBe('ZZ TEST cart');
  return till;
}

describe('SCRUM-964 — the display lease follows the person carrying the sale on', () => {
  it('HIGH: another person continues the kept sale: the till lets the ended session’s lease go, takes its own when the box frees it, and the display shows the sale at once', async () => {
    const till = await annAtTheTill();
    try {
      // A renews every 15 s while unlocked; the last renewal is what the box's 60 s run from.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(mock.renew).toHaveBeenCalledWith('station', 'lease-1');
      const annsLastRenewal = Date.now();
      // A's session ends on the platform: its calls answer 401, and the till locks over the sale.
      caller = null;
      till.rerender({ shown: screen('ZZ TEST cart'), active: false });
      await vi.advanceTimersByTimeAsync(20_000);

      // B signs in on the same till and presses Continue: the till is unlocked, the same publisher.
      caller = BEN;
      signedInAccount.set(BEN);
      const renewsBefore = mock.renew.mock.calls.length;
      const publishesBefore = mock.publish.mock.calls.length;
      const claimsBefore = mock.lease.mock.calls.length;
      till.rerender({ shown: screen('ZZ TEST cart'), active: true });
      await vi.advanceTimersByTimeAsync(100);

      // Never renewed or published under A's lease as B, the way the frozen display was made.
      expect(mock.renew.mock.calls.slice(renewsBefore)).toEqual([]);
      expect(mock.publish.mock.calls.slice(publishesBefore)).toEqual([]);
      // B's claim, refused while A's lease still runs: the till says it is its own lease running out.
      expect(mock.lease.mock.calls.length).toBe(claimsBefore + 1);
      expect(till.result.current.error).toBe(DISPLAY_HANDOVER_WAIT);
      expect(till.result.current.error).not.toBe(NOT_THE_HOLDER);

      // Bounded: it asks again when A's lease is free, not in a loop meanwhile.
      const freeAt = annsLastRenewal + TTL_MS;
      await vi.advanceTimersByTimeAsync(freeAt - Date.now() - 1_000);
      expect(mock.lease.mock.calls.length).toBe(claimsBefore + 1);
      expect(box.lease?.accountId).toBe(ANN);
      await vi.advanceTimersByTimeAsync(3_000);

      // B's own lease, and the sale on screen published under it at once.
      expect(box.lease?.accountId).toBe(BEN);
      expect(box.lease?.leaseId).toBe('lease-2');
      expect(mock.publish.mock.calls.at(-1)?.[1]).toMatchObject({ leaseId: 'lease-2' });
      expect(till.result.current.error).toBeNull();
      // B changes the sale: the display follows at once.
      till.rerender({ shown: screen('ZZ TEST cart, a second kid'), active: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(box.prompt?.nickname).toBe('ZZ TEST cart, a second kid');
      // A's lease is never released by B (only A's session may), and nothing was refused 403 along the way.
      expect(mock.release).not.toHaveBeenCalled();
    } finally {
      till.unmount();
    }
  });

  it('a change B makes while A’s lease runs out asks the box again at once, and is on the display as soon as the box frees it', async () => {
    const till = await annAtTheTill();
    try {
      caller = null;
      till.rerender({ shown: screen('ZZ TEST cart'), active: false });
      await vi.advanceTimersByTimeAsync(10_000);
      caller = BEN;
      signedInAccount.set(BEN);
      till.rerender({ shown: screen('ZZ TEST cart'), active: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(till.result.current.error).toBe(DISPLAY_HANDOVER_WAIT);
      // The till's own change asks once more (refused: the box still holds A's lease), and waits again.
      const claims = mock.lease.mock.calls.length;
      till.rerender({ shown: screen('ZZ TEST cart, B’s change'), active: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(mock.lease.mock.calls.length).toBe(claims + 1);
      expect(till.result.current.error).toBe(DISPLAY_HANDOVER_WAIT);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(box.lease?.accountId).toBe(BEN);
      expect(box.prompt?.nickname).toBe('ZZ TEST cart, B’s change');
    } finally {
      till.unmount();
    }
  });

  it('a 403 STATION_NOT_PERMITTED on renew drops the lease and claims afresh, never renews it again, and never loops', async () => {
    const till = await annAtTheTill();
    try {
      // The till was not told who signed in (no account named): the box's 403 is what says it.
      signedInAccount.set(null);
      caller = BEN;
      await vi.advanceTimersByTimeAsync(16_000);
      const renewsWithOld = () => mock.renew.mock.calls.filter(([, id]) => id === 'lease-1').length;
      expect(renewsWithOld()).toBe(1);
      const claims = mock.lease.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      // Never renewed again under A's lease; claims refused while it runs, at the claim's own back-off.
      expect(renewsWithOld()).toBe(1);
      expect(mock.lease.mock.calls.length - claims).toBeGreaterThan(0);
      expect(mock.lease.mock.calls.length - claims).toBeLessThanOrEqual(6);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(box.lease?.accountId).toBe(BEN);
      expect(box.prompt?.nickname).toBe('ZZ TEST cart');
      expect(till.result.current.error).toBeNull();
    } finally {
      till.unmount();
    }
  });

  it('a 403 on publish is the same: a lease of its own, and the sale published under it', async () => {
    const till = await annAtTheTill();
    try {
      signedInAccount.set(null);
      caller = BEN;
      // Expire A's lease on the box first, as if a minute had passed with the till locked.
      box = { ...box, lease: { ...box.lease!, expiresAt: new Date(Date.now() - 1).toISOString() } };
      till.rerender({ shown: screen('ZZ TEST cart, published by B'), active: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(mock.publish.mock.calls.at(-1)?.[1]).toMatchObject({ leaseId: 'lease-1' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(box.lease?.accountId).toBe(BEN);
      expect(box.prompt?.nickname).toBe('ZZ TEST cart, published by B');
    } finally {
      till.unmount();
    }
  });

  it('a real second till keeps the notice it always had: "Another till is using this station", at the claim’s back-off', async () => {
    // Another till (another holder, another person) holds the station.
    box = { ...box, lease: { leaseId: 'lease-other', holder: 'other-till', holderKind: 'till', accountId: 'zz-test-carl',
      startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString() } };
    const keepAlive = setInterval(() => {
      box = { ...box, lease: { ...box.lease!, expiresAt: new Date(Date.now() + TTL_MS).toISOString() } };
    }, 15_000);
    const till = renderHook(() => useTicketDisplay('station', screen('ZZ TEST cart'), vi.fn(), true));
    try {
      await settle();
      await vi.advanceTimersByTimeAsync(100);
      expect(till.result.current.error).toBe(ANOTHER_TILL);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(till.result.current.error).toBe(ANOTHER_TILL);
      // 1 s, 2 s, 4 s, 8 s, 16 s: a handful of claims in half a minute, never a loop.
      expect(mock.lease.mock.calls.length).toBeLessThanOrEqual(6);
      expect(mock.publish).not.toHaveBeenCalled();
      expect(box.lease?.accountId).toBe('zz-test-carl');
    } finally {
      clearInterval(keepAlive);
      till.unmount();
    }
  });

  it('a 401 (the staff session gone) is not said as a display problem: the till keeps what it knew of the display', async () => {
    const till = await annAtTheTill();
    try {
      expect(till.result.current.connected).toHaveLength(1);
      caller = null;
      mock.get.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in'));
      till.rerender({ shown: screen('ZZ TEST cart, typed by the family'), active: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(till.result.current.error).toBeNull();
      expect(till.result.current.connected).toHaveLength(1);
    } finally {
      till.unmount();
    }
  });
});
