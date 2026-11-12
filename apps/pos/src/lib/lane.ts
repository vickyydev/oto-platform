import { useSyncExternalStore } from 'react';
import type { ApiResponse } from '@oto/api-types';
import { BOX_LANE_PAYMENT_REFUSAL, BOX_LANE_UNREACHABLE, type BridgeLane } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { bridgeApi, hasBridgeOrigin } from '@/api/bridge';

/**
 * THE LANE ARBITER — which way this till is working (offline plan OD-1, Round 3).
 *
 * While the internet is up the till works through the platform, exactly as it
 * always has. It moves to its BOX — the station bridge, `api/bridge.ts` —
 * the moment one of these things is true:
 *
 *   - the platform answers `503 STATION_FORCED_OFFLINE` (the Console's test
 *     switch, SCRUM-285);
 *   - a call reaches nothing at all (`NetworkError`: the mall's link is down);
 *   - the forwarder cannot reach its API and this station has a local bridge;
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
let recovery: Promise<BridgeLane> | null = null;
let platformLocked = false;
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
  platformLocked = false;
  emit();
}

export function laneStation(): string | null {
  return stationId;
}

export function currentLane(): BridgeLane {
  return lane;
}

/** The API returned, but its original session still needs the password. */
export function platformNeedsUnlock(): boolean { return platformLocked; }
export function platformUnlocked(): void { platformLocked = false; }

/** Whether a failure means "go to the box" rather than "the platform said no". */
export function isBoxLaneTrigger(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  return err instanceof ApiError && (
    (err.status === 503 && err.code === 'STATION_FORCED_OFFLINE')
    || (hasBridgeOrigin() && err.status === 502 && err.code === 'UPSTREAM_UNAVAILABLE')
  );
}

/**
 * SCRUM-887 — the connection itself dropped: nothing answered, or this till's
 * forwarder could not reach the API. Not the Console's forced-offline switch,
 * which is the platform answering.
 */
export function isConnectionDrop(err: unknown): boolean {
  return err instanceof NetworkError
    || (err instanceof ApiError && hasBridgeOrigin() && err.status === 502 && err.code === 'UPSTREAM_UNAVAILABLE');
}

/**
 * SCRUM-887 — A REGISTRATION BEGUN ON THE PLATFORM FINISHES ON THE PLATFORM.
 *
 * The drop-off gate writes the guardian and the children online, then the
 * registration. A dropped link between those writes used to move the call to
 * the box, which had not yet pulled the member written seconds before (its
 * copy refreshes every minute) and answered "Member not found": the family
 * stood at the desk. While a hold is taken, a call goes to the platform even
 * when the lane says box, a dropped link is tried again there with a short
 * backoff (the ids are the till's, so a write that landed answers with what
 * exists), and nothing moves the lane. The Console's forced-offline switch
 * still sends the call to the box: the platform is up, so the box can pull.
 * A till offline from the start takes no hold and works through its box.
 */
let platformHolds = 0;
const heldRetryListeners = new Set<(attempt: number) => void>();
const HELD_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000];
let heldRetryDelays: readonly number[] = HELD_RETRY_MS;

const heldGiveUpListeners = new Set<() => void>();

/**
 * Take the hold; the answer releases it (once). `onRetry` hears each retry;
 * `onGiveUp` hears a held call run out of retries, before its error is thrown.
 */
export function holdPlatformLane(onRetry?: (attempt: number) => void, onGiveUp?: () => void): () => void {
  platformHolds += 1;
  if (onRetry) heldRetryListeners.add(onRetry);
  if (onGiveUp) heldGiveUpListeners.add(onGiveUp);
  // SCRUM-897: a screen reading the sale's lane (`useSaleLane`) hears the hold.
  emit();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    platformHolds -= 1;
    if (onRetry) heldRetryListeners.delete(onRetry);
    if (onGiveUp) heldGiveUpListeners.delete(onGiveUp);
    emit();
  };
}

export function platformLaneHeld(): boolean {
  return platformHolds > 0;
}

/**
 * SCRUM-897 — THE LANE THE SALE ON SCREEN WORKS ON. The till's lane, except
 * while a hold is taken: the drop-off gate's hold, carried to its family's sale
 * and to its door choice, sends those calls to the platform first whatever the
 * lane says (SCRUM-887), so that sale is online. What the payment step says
 * about it — Hold sale, the Held sales list's Resume — follows this, and never
 * says the till is working through its counter box under a sale written
 * online. Without a hold it is the lane, exactly as before.
 */
export function saleLane(): BridgeLane {
  return platformHolds > 0 ? 'platform' : lane;
}

/** Tests only: the waits between held retries (null restores the defaults). */
export function setHeldRetryDelays(delays: readonly number[] | null): void {
  heldRetryDelays = delays ?? HELD_RETRY_MS;
}

async function onHeldPlatform<T>(
  onPlatform: () => Promise<T>,
  onBox: (stationId: string) => Promise<T>,
  id: string | null,
): Promise<T> {
  try {
    return await retryHeld(onPlatform);
  } catch (err) {
    if (id && err instanceof ApiError && err.status === 503 && err.code === 'STATION_FORCED_OFFLINE') {
      setLane('box');
      return onBox(id);
    }
    throw err;
  }
}

/** A dropped link tried again on the platform with the held backoff. */
async function retryHeld<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (!isConnectionDrop(err)) throw err;
      const wait = heldRetryDelays[attempt];
      if (wait === undefined) {
        for (const listener of [...heldGiveUpListeners]) listener();
        throw err;
      }
      for (const listener of heldRetryListeners) listener(attempt + 1);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * SCRUM-887 — a platform call made outside `viaLane` (the sale writer's
 * commit and cash press): while a hold is taken, a dropped link is tried again
 * on the platform first. What is left after the backoff is the caller's to
 * handle by its own lane rules. Without a hold it is the call, unchanged.
 */
export function onPlatformWhileHeld<T>(call: () => Promise<T>): Promise<T> {
  return platformHolds > 0 ? retryHeld(call) : call();
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
  if (recovery) return recovery;
  recovery = recoverLane().finally(() => { recovery = null; });
  return recovery;
}

async function recoverLane(): Promise<BridgeLane> {
  const id = stationId;
  if (!id) return lane;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const status = await bridgeApi.status(id, controller.signal);
    if (stationId !== id) return lane;
    if (status.link.lane === 'platform' && lane === 'box') {
      // The box and this browser can have different routes to the API. Its
      // heartbeat alone cannot move a browser with a broken forwarder back.
      const me = await api.get<ApiResponse<'/me/', 'get'>>('/me', { signal: controller.signal });
      if (stationId !== id) return lane;
      if (me.sessionLocked) {
        if (!platformLocked) window.dispatchEvent(new CustomEvent('oto:session-locked'));
        platformLocked = true;
        return lane;
      }
      if (me.sessionLocked !== false) return lane;
      platformLocked = false;
    }
    if (stationId === id) setLane(status.link.lane);
  } catch {
    // The box did not answer either: stay where we are. The next call decides.
  } finally { clearTimeout(timeout); }
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
  if (platformHolds > 0) return onHeldPlatform(onPlatform, onBox, id);
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
 * What a payment the box lane could not take says, in words a guest can hear
 * (Round 4 sells on the box lane; `lib/saleWriter.ts` moves a sale there on a
 * trigger). What reaches here is what is left: the platform's forced-offline
 * answer on a till with no station, so no box to sell through; or a dropped
 * link on a till already working through its box — the box did not answer
 * either. A single dropped request on the platform lane keeps its own words —
 * it may be a blip, and saying the counter is offline would send staff after
 * the wrong thing — but it still moves the till to its box for what follows.
 */
export function paymentRefusalMessage(err: unknown): string | null {
  if (!isBoxLaneTrigger(err)) return null;
  const alreadyOnBox = lane === 'box' && stationId !== null;
  noteLaneFailure(err);
  const forced = err instanceof ApiError && err.code === 'STATION_FORCED_OFFLINE';
  if (alreadyOnBox) return BOX_LANE_UNREACHABLE.message;
  return forced ? BOX_LANE_PAYMENT_REFUSAL.message : null;
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

/** SCRUM-897 — `saleLane` for a screen: it renders again when the lane or a hold changes. */
export function useSaleLane(): BridgeLane {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saleLane,
    saleLane,
  );
}
