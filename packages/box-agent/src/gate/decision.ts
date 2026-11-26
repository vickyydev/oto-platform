/**
 * THE ACCESS DECISION, on the box, with no network (S2-12 round 2; plan §2.5).
 *
 * Decode → only a band code is admissible → signature under the park's key
 * → deny list → kind → anti-passback → answer. Everything here is pure: the
 * host hands in what the box holds (its band copy, its deny list, its passage
 * state) and gets back one answer and, where a band is named, the fact to
 * journal. Nothing here opens anything or writes anything.
 *
 * THE RULES, each from where it was decided:
 *
 *   - a gate admits on a band code and nothing else (`isBandCodeShape`,
 *     `verifyBandCode` in `@oto/shared`) — a booking QR, a voucher or a card
 *     is refused with "scan your wristband";
 *   - the deny list names revoked bands EXPLICITLY. The `bands` copy carries
 *     active bands only, so absence can never be read as revoked — a band
 *     printed after the last pull is absent too;
 *   - kids' bands never operate the gate, in either direction (C8, R-83,
 *     OD-A6): "adult band please";
 *   - the gate checks the band's Gate access flag (BL §7.1, R-83; SCRUM-494):
 *     an adult band from a ticket with Gate access off is refused in either
 *     direction, as a kids band is, and follows its group instead;
 *   - anti-passback moves only on a COMMITTED passage — the board's "passed"
 *     feedback, credited by the controller — never on the open. Entry while
 *     inside is refused `ANTI_PASSBACK`; a timeout changes nothing;
 *   - exit is ALWAYS allowed for an adult band of this park (OD-A4): one the
 *     box did not think was inside is let out and recorded as exit without
 *     entry, and the count never goes below zero. A revoked band is let out
 *     too — the refunded guest walking out is exactly who holds one;
 *   - except (owner's list of 24 November, SCRUM-68): a band whose end time is
 *     KNOWN and has passed is refused in either direction and sent to the
 *     cashier (`playTimeEnded`); an end not known refuses nothing;
 *   - a band this box has never heard of, with no platform to ask, is refused
 *     "please see reception" (OD-A5). Online, the host refreshes its band copy
 *     first and asks again, and a band still unknown is `BAND_NOT_FOUND`.
 */

import {
  GATE_EVENT_TYPE,
  isBandCodeShape,
  verifyBandCode,
  type GateAlarm,
  type GateDenyReason,
  type GateEventKind,
  type GateEventPayload,
} from '@oto/shared';

import type { QueuedFact } from '../store';
import type { GateDirection } from './config';
import type { GateSide } from './ge-x2';

export type BandKind = 'kid' | 'adult';

/**
 * SCRUM-68 — what the platform says of a band's ticket, from the `bands`
 * copy (`BandGateDetails` in `@oto/shared`). Every field may be absent: an
 * older platform sends none, and a line with no stay hours has no end.
 */
export interface BandDetails {
  ticketLabel?: string;
  stayLabel?: string;
  /** When the band's play ends, epoch ms — the band print's "valid until". */
  validUntil?: number;
}

/**
 * What the box knows of one band.
 *
 * `gateAccess` is the band's own flag, taken from its ticket package when it
 * was minted (SCRUM-494). Absent when the copy came from a platform that does
 * not send it; the kind rule alone then decides. `details` is present only
 * when the copy carried any (SCRUM-68).
 */
export type BandLookup =
  /** In the `bands` copy: active. */
  | { state: 'active'; kind: BandKind; gateAccess?: boolean; details?: BandDetails }
  /** On the deny list, or in the copy with a status other than active. */
  | { state: 'revoked'; kind: BandKind | null; gateAccess?: boolean }
  /** In neither. */
  | { state: 'unknown' };

export interface GateDecisionInput {
  /** The decoded card / QR text the reader sent (base64-decoded already). */
  code: string;
  direction: GateDirection;
  /** The park's band key, or null when this box has none. */
  key: string | Uint8Array | null;
  lookup: (bandId: string) => BandLookup;
  /** Whether the last COMMITTED passage of this band was an entry. */
  inside: (bandId: string) => boolean;
  /**
   * What an unknown band means right now: `offline` when no platform could be
   * asked (OD-A5), `not_found` when the box has just refreshed its copy and
   * the band is still not in it.
   */
  unknownMeans: 'offline' | 'not_found';
  /**
   * The box's corrected clock, for the play-time rule (SCRUM-68). Absent, no
   * band is refused on time.
   */
  now?: number;
}

/**
 * Why the box refused, as the box words it: the journal's reasons, plus
 * `OVER_TIME`, which the journal's closed reason list does not hold and which
 * is therefore journalled as its nearest reason (`journalReason`).
 */
export type GateRefusal = GateDenyReason | 'OVER_TIME';

/**
 * SCRUM-68 — minutes past a band's "valid until" before the gate refuses it
 * on time. 0: the end printed on the band is the end at the gate.
 */
export const GATE_OVERTIME_GRACE_MINUTES = 0;

/**
 * THE PLAY-TIME RULE (owner's list of 24 November, SCRUM-68): a band whose
 * end time is KNOWN and has passed is refused at the entry AND at the exit,
 * and sent to the cashier. For this one case it replaces "an adult exit is
 * always allowed" (OD-A4). An end that is not known (an older platform, a
 * line with no stay hours, a box that never received it, a revoked band)
 * refuses nothing: missing data never traps anybody.
 */
export function playTimeEnded(validUntil: number | undefined, now: number | undefined): boolean {
  if (validUntil === undefined || now === undefined) return false;
  if (!Number.isFinite(validUntil) || !Number.isFinite(now)) return false;
  return now > validUntil + GATE_OVERTIME_GRACE_MINUTES * 60_000;
}

/**
 * The reason a refusal is journalled under. The event schema's reason list is
 * closed and the platform validates it, so `OVER_TIME` travels as its nearest
 * existing reason, `NO_GATE_ACCESS` (the band's right to operate the gate has
 * run out), until the platform knows it. The box log names it plainly.
 */
export function journalReason(reason: GateRefusal): GateDenyReason {
  return reason === 'OVER_TIME' ? 'NO_GATE_ACCESS' : reason;
}

export type GateDecision =
  | {
      open: true;
      bandId: string;
      direction: GateDirection;
      /** Exit by a band the box did not think was inside (OD-A4). */
      exitWithoutEntry: boolean;
      /** Let out on a revoked band. Only ever on an exit. */
      revoked: boolean;
      message: string;
    }
  | {
      open: false;
      reason: GateRefusal;
      /** The band the code named, when it named one this park signed. */
      bandId: string | null;
      message: string;
    };

/**
 * What the reader shows — the only thing the guest sees (Gate Interface Spec
 * §1: `message`). Short, English first, Thai second.
 * TRANSLATE: the Thai strings are working copy, marked for the park's review.
 */
export const GATE_MESSAGES = {
  welcome: 'Welcome / ยินดีต้อนรับ',
  goodbye: 'Goodbye / ขอบคุณที่มาเที่ยว',
  NOT_A_BAND: 'Scan your wristband / สแกนสายรัดข้อมือ',
  BOX_NOT_READY: 'Please see reception / กรุณาติดต่อเคาน์เตอร์',
  BAND_INVALID: 'Band not valid / สายรัดข้อมือไม่ถูกต้อง',
  BAND_REVOKED: 'Band not valid, see reception / สายรัดข้อมือใช้ไม่ได้ กรุณาติดต่อเคาน์เตอร์',
  BAND_NOT_FOUND: 'Band not valid, see reception / สายรัดข้อมือใช้ไม่ได้ กรุณาติดต่อเคาน์เตอร์',
  BAND_UNKNOWN_OFFLINE: 'Please see reception / กรุณาติดต่อเคาน์เตอร์',
  // TRANSLATE: "Kids enter with their adult" is new English; the Thai is the earlier line.
  KID_BAND: 'Adult band please. Kids enter with their adult / กรุณาใช้สายรัดผู้ใหญ่',
  // TRANSLATE: new English, no Thai yet (SCRUM-68, owner's list of 24 November).
  OVER_TIME: 'Your play time has ended. Please see the cashier.',
  NO_GATE_ACCESS: 'Band not valid, see reception / สายรัดข้อมือใช้ไม่ได้ กรุณาติดต่อเคาน์เตอร์',
  ANTI_PASSBACK: 'Already entered / สายรัดนี้เข้าแล้ว',
  GATE_BUSY: 'Please wait / กรุณารอสักครู่',
  GATE_NOT_READY: 'Gate not ready, see reception / ประตูยังไม่พร้อม กรุณาติดต่อเคาน์เตอร์',
} as const satisfies Record<GateRefusal | 'welcome' | 'goodbye', string>;

function deny(reason: GateRefusal, bandId: string | null = null): GateDecision {
  return { open: false, reason, bandId, message: GATE_MESSAGES[reason] };
}

export function decideGate(input: GateDecisionInput): GateDecision {
  const code = input.code.trim();
  if (!isBandCodeShape(code)) return deny('NOT_A_BAND');
  if (!input.key) return deny('BOX_NOT_READY');

  let verdict: ReturnType<typeof verifyBandCode>;
  try {
    verdict = verifyBandCode(code, input.key);
  } catch {
    // A key too short to be a band key: the box's configuration is wrong and
    // no band could pass against it — the box's failure, not the band's.
    return deny('BOX_NOT_READY');
  }
  if (!verdict.ok) return deny('BAND_INVALID');
  const bandId = verdict.bandId;

  const known = input.lookup(bandId);
  if (known.state === 'unknown') {
    return deny(
      input.unknownMeans === 'offline' ? 'BAND_UNKNOWN_OFFLINE' : 'BAND_NOT_FOUND',
      bandId,
    );
  }
  // Kids' bands never operate the gate, either way (C8). A revoked band whose
  // kind is not known is treated as not a kid's: the deny list carries the
  // kind, so this only happens for a list from an older platform.
  if (known.kind === 'kid') return deny('KID_BAND', bandId);
  // The ticket's Gate access is off: the band follows its group (SCRUM-494).
  if (known.gateAccess === false) return deny('NO_GATE_ACCESS', bandId);
  // SCRUM-68: only an active band's own end time is read; a revoked one has none.
  const timeEnded =
    known.state === 'active' && playTimeEnded(known.details?.validUntil, input.now);

  if (input.direction === 'entry') {
    if (known.state === 'revoked') return deny('BAND_REVOKED', bandId);
    if (input.inside(bandId)) return deny('ANTI_PASSBACK', bandId);
    if (timeEnded) return deny('OVER_TIME', bandId);
    return {
      open: true,
      bandId,
      direction: 'entry',
      exitWithoutEntry: false,
      revoked: false,
      message: GATE_MESSAGES.welcome,
    };
  }

  // Exit: always (OD-A4) — except a band whose known play time has ended,
  // which is sent to the cashier (owner's list of 24 November, SCRUM-68).
  if (timeEnded) return deny('OVER_TIME', bandId);
  return {
    open: true,
    bandId,
    direction: 'exit',
    exitWithoutEntry: !input.inside(bandId),
    revoked: known.state === 'revoked',
    message: GATE_MESSAGES.goodbye,
  };
}

// --- Anti-passback: the committed passage -------------------------------------

export interface PassageCommit {
  /** The band's state after the passage. */
  inside: boolean;
  /** The box's adult head count after it, floored at zero. */
  count: number;
  exitWithoutEntry: boolean;
}

/**
 * Commit one credited passage. Pure: the host persists the result.
 *
 * An entry puts the band inside and counts one; an exit puts it outside and
 * takes one off, never below zero (OD-A4) — including for an exit without
 * entry, which is somebody the count may never have had.
 */
export function commitPassage(
  wasInside: boolean,
  direction: GateDirection,
  count: number,
): PassageCommit {
  if (direction === 'entry') {
    return { inside: true, count: count + 1, exitWithoutEntry: false };
  }
  return { inside: false, count: Math.max(0, count - 1), exitWithoutEntry: !wasInside };
}

// --- The journal ----------------------------------------------------------------

export interface GateJournalInput {
  eventId: string;
  bandId: string;
  kind: GateEventKind;
  direction: GateDirection;
  side: GateSide;
  stationId: string;
  occurredAt: string;
  reason?: GateDenyReason | null;
  alarm?: GateAlarm | null;
  exitWithoutEntry?: boolean;
  revoked?: boolean;
  inferred?: boolean;
  personInLane?: boolean;
  offline?: boolean;
}

/**
 * The outbox fact for one gate outcome. The actor is the DEVICE: nobody at
 * the gate is signed in, and the band is the subject, not the actor.
 */
export function gateEventFact(input: GateJournalInput): QueuedFact {
  const payload: GateEventPayload = {
    eventId: input.eventId,
    bandId: input.bandId,
    kind: input.kind,
    direction: input.direction,
    side: input.side,
    reason: input.reason ?? null,
    alarm: input.alarm ?? null,
    occurredAt: input.occurredAt,
    ...(input.exitWithoutEntry ? { exitWithoutEntry: true } : {}),
    ...(input.revoked ? { revoked: true } : {}),
    ...(input.inferred ? { inferred: true } : {}),
    ...(input.personInLane ? { personInLane: true } : {}),
    ...(input.offline ? { offline: true } : {}),
  };
  return {
    type: GATE_EVENT_TYPE,
    occurredAt: input.occurredAt,
    stationId: input.stationId,
    actorKind: 'device',
    actorAccountId: null,
    payload: payload as unknown as Record<string, unknown>,
  };
}
