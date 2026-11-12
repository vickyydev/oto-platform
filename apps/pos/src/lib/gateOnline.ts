import { ApiError } from '@/api/client';
import { answeredByBox } from '@/api/bridge';
import { currentLane, holdPlatformLane, isConnectionDrop, platformLaneHeld } from './lane';
import type { SaleWriteState } from './saleWriter';

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
 *
 * A gate that started online and reached payment keeps the hold for that
 * family's sale (`carryToSale`): the box has not pulled the guardian the gate
 * wrote seconds before and would refuse the cart, so a dropped link at Pay or
 * at the cash press is tried again online under the sale's own ids. The hold
 * ends when the sale is written or the cart cleared (`endSale`), or when a
 * held sale call runs out of retries: what follows is the lane's own rule.
 *
 * A sale written while that hold was still carried was written online, and
 * the door choice that follows it — check the children in now, or leave them
 * booked — names that sale and that registration, neither of which the box
 * has pulled yet. So each door press is held the same way (`beginDoor`): a
 * long outage that moved the lane to the box does not send the check-in
 * there. A door press whose held retries run out ends it: the next press
 * follows the lane's own rule.
 */
export interface GateOnlineHold {
  /** Whether this gate has written the guardian or a child on the platform. */
  readonly startedOnline: boolean;
  /** Continue pressed: a gate that started online is held for the press. */
  beginPress(): void;
  /** A write of this gate was answered. */
  noteWrite(): void;
  /** The press reached payment: a gate that started online keeps the hold for the sale. */
  carryToSale(): void;
  /** The press ended, however it ended: the hold is released unless carried to the sale. */
  endPress(): void;
  /**
   * The family's sale was written: the hold is released. Written while it was
   * still carried, it was written online, and its door choice is held too.
   */
  endSale(): void;
  /** A door choice for this family is pressed: held for the press when its sale was written online. */
  beginDoor(): void;
  /** The door press ended, however it ended: the hold is released. */
  endDoor(): void;
  /** A new gate (the form opened again, or a new sale): nothing written yet, nothing held. */
  reset(): void;
}

/** What staff are told, the first time a held call is retried. */
export interface GateRetryWords {
  readonly title: string;
  readonly description: string;
}

/** `onRetrying` is called once per press (once per sale, once per door press), the first time a held call is retried. */
export function gateOnlineHold(onRetrying: (words: GateRetryWords) => void): GateOnlineHold {
  let startedOnline = false;
  let release: (() => void) | null = null;
  let said = false;
  let carried = false;
  let sale = false;
  /** The family's sale was written online: its door choice is held. */
  let door = false;
  let doorPress = false;
  const drop = () => {
    release?.();
    release = null;
    carried = false;
    sale = false;
    doorPress = false;
  };
  const take = () => {
    if (release) return;
    said = false;
    release = holdPlatformLane(
      () => {
        if (said) return;
        said = true;
        onRetrying(sale ? GATE_SALE_RETRYING : doorPress ? GATE_DOOR_RETRYING : GATE_RETRYING);
      },
      () => {
        // The sale's held retries ran out: the lane's own rule from here.
        if (sale) drop();
        // So did a door press's: its next press follows the lane.
        if (doorPress) door = false;
      },
    );
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
    carryToSale() {
      if (startedOnline && release) carried = true;
    },
    endPress() {
      if (carried) {
        carried = false;
        sale = true;
        said = false;
        return;
      }
      drop();
    },
    endSale() {
      if (sale && release) door = true;
      drop();
    },
    beginDoor() {
      if (!door) return;
      take();
      doorPress = true;
    },
    endDoor() {
      if (doorPress) drop();
    },
    reset() {
      drop();
      startedOnline = false;
      door = false;
    },
  };
}

/** The tail every gate failure ends with: nothing was taken. */
export const GATE_NOTHING_TAKEN = 'Nobody has been checked in or charged — the details are still on screen.';

/** Shown once per press, the first time a held call is retried. */
export const GATE_RETRYING: GateRetryWords = {
  title: 'Connection dropped — retrying',
  description:
    'These children are already saved online. The till is finishing their registration online — please wait, there is nothing to type again.',
};

/** Shown once per door press, the first time its held check-in call is retried. */
export const GATE_DOOR_RETRYING: GateRetryWords = {
  title: 'Connection dropped — retrying',
  description:
    'This family is already registered and paid online. The till is finishing their check-in online — please wait, there is nothing to press again.',
};

/** Shown once per sale, the first time a held sale call (Pay, the cash press) is retried. */
export const GATE_SALE_RETRYING: GateRetryWords = {
  title: 'Connection dropped — retrying',
  description:
    "This family is already saved online. The till is finishing this sale online under the same sale number — please wait, there is nothing to press again and the visitor can't be charged twice.",
};

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

/**
 * The sale's box refused a family this gate wrote online: after the held
 * retries ran out the sale fell to the counter's box, which has not pulled the
 * guardian yet. Its own "Member not found" would read as a wrong record.
 */
export const GATE_SALE_BOX_NOT_SYNCED =
  "This family was registered online, and this counter's box has not received their record yet — the connection dropped before it could. The box saved nothing and took no payment. Wait a minute, then press Try again: the till sends the same sale number, so the visitor can't be charged twice.";

/**
 * The sale panel's failure, for a family this gate wrote online: the box's
 * "Member not found" becomes the words above, and a press to try again (the
 * box pulls the family within a minute, or the till moves back online). The
 * box answered, so the cause says so (`box-not-synced`): the panel adds no
 * "nothing answered, this sale may already be saved" to "the box saved
 * nothing". Every other state stands as it came.
 */
export function gateSaleFailure<S extends SaleWriteState>(state: S, startedOnline: boolean): S {
  if (
    !startedOnline
    || state.kind !== 'failed'
    || state.answeredBy !== 'box'
    || state.code !== 'NOT_FOUND'
    || state.message !== 'Member not found'
  ) {
    return state;
  }
  return { ...state, message: GATE_SALE_BOX_NOT_SYNCED, cause: 'box-not-synced', retryable: true };
}
