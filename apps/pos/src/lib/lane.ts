import { useSyncExternalStore } from 'react';
import { BOX_LANE_PAYMENT_REFUSAL, type BridgeLane } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';

/**
 * THE LANE ARBITER — which way this till is working (offline plan OD-1, Round 3).
 *
 * While the internet is up the till works through the platform, exactly as it
 * always has. It moves to its BOX — the station bridge, `api/bridge.ts` —
 * the moment any of three things is true:
 *
 *   - the platform answers `503 STATION_FORCED_OFFLINE` (the Console's test
 *     switch, SCRUM-285);
 *   - a call reaches nothing at all (`NetworkError`: the mall's link is down);
 *   - the box itself says its link is down (`GET status`).
 *
 * And it moves back when the box says its link is up again and the Console's
 * switch is off. The ids are the till's either way (OD-12), so a record begun
 * on one lane and finished on the other meets itself on replay.
 *
 * Module state rather than a React context, because the callers are the api
 * wrappers in `api/platform.ts` and `api/sales.ts`, which every screen shares
 * and which are not components. `useLane` is the hook a banner reads.
 */

let stationId: string | null = null;
let lane: BridgeLane = 'platform';
let probe: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/** How often a till on the box lane asks its box whether the link is back. */
const PROBE_MS = 15_000;

function emit(): void {
  for (const listener of listeners) listener();
}

function stopProbe(): void {
  if (probe) clearInterval(probe);
  probe = null;
}

function startProbe(): void {
  if (probe || !stationId) return;
  probe = setInterval(() => {
    void refreshLane();
  }, PROBE_MS);
}

function setLane(next: BridgeLane): void {
  if (next === lane) return;
  lane = next;
  if (lane === 'box') startProbe();
  else stopProbe();
  emit();
}

/** The station this till is standing at, from the station picker. Null clears the lane. */
export function setLaneStation(id: string | null): void {
  if (id === stationId) return;
  stationId = id;
  stopProbe();
  lane = 'platform';
  emit();
}

export function laneStation(): string | null {
  return stationId;
}

export function currentLane(): BridgeLane {
  return lane;
}

/** Whether a failure means "go to the box" rather than "the platform said no". */
export function isBoxLaneTrigger(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  return err instanceof ApiError && err.status === 503 && err.code === 'STATION_FORCED_OFFLINE';
}

/** Note a failure the platform lane met; moves to the box when it is a trigger. */
export function noteLaneFailure(err: unknown): void {
  if (stationId && isBoxLaneTrigger(err)) setLane('box');
}

/**
 * Ask the box which lane to be on. Its `link.lane` is `platform` only while
 * the box can reach the platform AND the Console's switch is off.
 */
export async function refreshLane(): Promise<BridgeLane> {
  const id = stationId;
  if (!id) return lane;
  try {
    const status = await bridgeApi.status(id);
    if (stationId === id) setLane(status.link.lane);
  } catch {
    // The box did not answer either: stay where we are. The next call decides.
  }
  return lane;
}

/**
 * One operation, on whichever lane is right.
 *
 * On the platform lane the platform is asked first, and only a trigger moves
 * the call to the box; any other refusal is the platform's answer and stands.
 * On the box lane the box is asked, and a till with no station has no box.
 */
export async function viaLane<T>(
  onPlatform: () => Promise<T>,
  onBox: (stationId: string) => Promise<T>,
): Promise<T> {
  const id = stationId;
  if (!id) return onPlatform();
  if (lane === 'box') return onBox(id);
  try {
    return await onPlatform();
  } catch (err) {
    if (!isBoxLaneTrigger(err)) throw err;
    setLane('box');
    return onBox(id);
  }
}

/**
 * What a payment meets on the box lane this round (round 4 builds it), in
 * words a guest can hear: the platform's forced-offline answer, or a dropped
 * link on a till already working through its box. A single dropped request on
 * the platform lane keeps its own words — it may be a blip, and saying the
 * counter is offline would send staff after the wrong thing — but it still
 * moves the till to its box for what follows.
 */
export function paymentRefusalMessage(err: unknown): string | null {
  if (!isBoxLaneTrigger(err)) return null;
  const alreadyOnBox = lane === 'box' && stationId !== null;
  noteLaneFailure(err);
  const forced = err instanceof ApiError && err.code === 'STATION_FORCED_OFFLINE';
  return forced || alreadyOnBox ? BOX_LANE_PAYMENT_REFUSAL.message : null;
}

export function useLane(): BridgeLane {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => lane,
    () => lane,
  );
}
