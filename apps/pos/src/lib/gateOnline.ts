import { ApiError } from '@/api/client';
import { answeredByBox } from '@/api/bridge';
import { currentLane, holdPlatformLane, isConnectionDrop, platformLaneHeld } from './lane';

/**
 * SCRUM-887 — WHAT THE DROP-OFF GATE SAYS WHEN THE CONNECTION DROPS.
 *
 * Once the gate has written the guardian or a child on the platform it
 * finishes there (`holdPlatformLane` in `lib/lane.ts`): a dropped link is
 * retried online and never handed to the box, which has not pulled those
 * records yet. These are the words staff see while it retries and when it
 * gives up, so they know what to do rather than read "Member not found".
 * Every other failure keeps the words it always had.
 */

/**
 * One gate's hold on the platform lane. The gate tells it when a write it
 * made has been answered; answered on the platform (the lane still the
 * platform's, or held there), the gate has started online and every call it
 * makes from then on, in this press and any press after it, is held there.
 * A write the box answered (a till offline from the start, or one moved to
 * its box before this gate wrote anything) takes no hold: that family is the
 * box's, as before.
 */
export interface GateOnlineHold {
  /** Whether this gate has written the guardian or a child on the platform. */
  readonly startedOnline: boolean;
  /** Continue pressed: a gate that started online is held for the press. */
  beginPress(): void;
  /** A write of this gate was answered. */
  noteWrite(): void;
  /** The press ended, however it ended: the hold is released. */
  endPress(): void;
  /** A new gate (the form opened again): nothing written yet. */
  reset(): void;
}

/** `onRetrying` is called once per press, the first time a held call is retried. */
export function gateOnlineHold(onRetrying: () => void): GateOnlineHold {
  let startedOnline = false;
  let release: (() => void) | null = null;
  let said = false;
  const take = () => {
    if (release) return;
    said = false;
    release = holdPlatformLane(() => {
      if (said) return;
      said = true;
      onRetrying();
    });
  };
  return {
    get startedOnline() {
      return startedOnline;
    },
    beginPress() {
      if (startedOnline) take();
    },
    noteWrite() {
      if (currentLane() !== 'platform' && !platformLaneHeld()) return;
      startedOnline = true;
      take();
    },
    endPress() {
      release?.();
      release = null;
    },
    reset() {
      startedOnline = false;
    },
  };
}

/** The tail every gate failure ends with: nothing was taken. */
export const GATE_NOTHING_TAKEN = 'Nobody has been checked in or charged — the details are still on screen.';

/** Shown once per press, the first time a held call is retried. */
export const GATE_RETRYING = {
  title: 'Connection dropped — retrying',
  description:
    'These children are already saved online. The till is finishing their registration online — please wait, there is nothing to type again.',
} as const;

/** The held retries ran out: the link is still down. */
export const GATE_CONNECTION_DROPPED =
  "The connection dropped and has not come back yet. What was saved stays saved online. Check the counter's internet, then press Continue again — the till finishes this same registration online, without entering anyone twice.";

/** The Console's offline switch sent a held call to a box that has not pulled the family yet. */
export const GATE_BOX_NOT_SYNCED =
  "This counter's box has not received this family's record yet. Wait a minute, then press Continue again.";

/**
 * The toast description for a gate failure. `startedOnline` is whether this
 * gate has already written the guardian or a child on the platform.
 */
export function gateFailureDescription(err: unknown, startedOnline: boolean): string {
  if (startedOnline && isConnectionDrop(err)) return `${GATE_CONNECTION_DROPPED} ${GATE_NOTHING_TAKEN}`;
  if (startedOnline && err instanceof ApiError && err.status === 404 && answeredByBox(err)) {
    return `${GATE_BOX_NOT_SYNCED} ${GATE_NOTHING_TAKEN}`;
  }
  return `${err instanceof Error ? err.message : 'Unknown error'} ${GATE_NOTHING_TAKEN}`;
}
