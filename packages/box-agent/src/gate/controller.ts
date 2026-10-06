/**
 * THE CONTROLLER'S STATE, and what the box infers from it (S2-12 round 2;
 * plan §2.4, OD-A13).
 *
 * Pure over time and frames: the host feeds in what the board said (`link.ts`)
 * and the clock, and reads back credited passages, timeouts, alarms and
 * faults. Nothing here touches a port.
 *
 * CREDITING — the rule the whole anti-passback rests on:
 *
 *   exactly ONE pending open per side of the lane; the next passage feedback
 *   on that side within open duration (HX-X1 L-1) + close delay (L-3) is
 *   credited to it, and to nobody else.
 *
 * A second open on a side with one pending is refused (`GATE_BUSY`) rather
 * than queued, because two opens in flight would make "the next feedback" name
 * either guest. Feedback outside the window, or with nothing pending, credits
 * no one. The rule is sound only while the board's entry/exit memory (L-9) is
 * off — with it on, the board may bank an open and report the passage later —
 * and the board must push its feedback (L-34 ≠ 0), so startup READS both and
 * reports a fault when either is wrong. The box never writes a setting.
 *
 * AN ENTRY IS TRUSTED TO THE RULE ONLY WHEN THE RULE CAN BE SHOWN TO HOLD
 * (`creditBlocker`): the board answers, L-9 and L-34 were actually READ and
 * are sound, and opens are not ending without any feedback. A value the board
 * never answered is not a sound value — a board still booting at the startup
 * read answers nothing, and would otherwise pass as sound while it never
 * pushes a passage. When a board comes back after a silence, `noteReply` says
 * so, and the host reads the settings again on real values.
 *
 * FAULTS — the board's own fault codes (HX-X1 §7, E1–E30) show only on its
 * display; GE-X2 carries none (OD-A13). So the box infers what it can see:
 *
 *   not_answering       replies stopped (missed acknowledgements and polls);
 *                       power loss also opens the gate (HX-X1 feature 12);
 *   stuck_initialising  the door state stays initialising or searching zero;
 *   infrared_fault      a beam stays broken with nobody expected in the lane
 *                       (the board calls this an IR fault after L-35, 60 s);
 *   held_open           the door stands open with no open pending — the fire
 *                       alarm input, or forced; nothing is credited until it
 *                       closes;
 *   no_feedback         opens keep ending without any §2 feedback while the
 *                       board answers polls — upload mode or wiring;
 *   settings_*          what the startup read found.
 */

import { HX_X1_FACTORY, WATCHED_SETTING_KEYS, isDoorOpen } from './ge-x2';
import type { DoorState, GateFeedback, GateSide, InfraredState, WatchedSetting } from './ge-x2';
import type { GateDirection } from './config';

// --- Settings -----------------------------------------------------------------

export interface SettingsCheck {
  /** What the board said, per setting; null where it did not answer. */
  read: Record<WatchedSetting, number | null>;
  /** Configured expectations the board does not meet. */
  mismatches: Array<{ key: WatchedSetting; expected: number; actual: number }>;
  unread: WatchedSetting[];
  /**
   * L-9 = 0 and L-34 ≠ 0, as far as the board said. An unread value says
   * nothing either way: see `creditingUnread` for what still has to be read.
   */
  creditingSound: boolean;
  notes: string[];
}

/** The settings the crediting rule rests on. Both must have been READ before an entry is trusted to it. */
export const CREDITING_SETTINGS: readonly WatchedSetting[] = ['entryExitMemory', 'uploadMode'];

/** Which of `CREDITING_SETTINGS` the board has not answered — all of them before any read. */
export function creditingUnread(check: SettingsCheck | null): WatchedSetting[] {
  if (!check) return [...CREDITING_SETTINGS];
  return CREDITING_SETTINGS.filter((key) => check.read[key] === null);
}

/**
 * Why a passage opened now could not be credited, as far as the board's state
 * says. The host refuses an ENTRY on any of these — an exit is let out
 * regardless (OD-A4) — because an open that cannot be credited would expire
 * as a timeout, commit nothing, and let the same band in again a window later.
 *
 *   not_answering      the board is silent (or was, and has not answered since);
 *   settings_unread    L-9 or L-34 was never answered, so the rule is unverified;
 *   crediting_unsound  the board said L-9 is on or L-34 is 0;
 *   no_feedback        opens keep ending with no §2 report while the board answers.
 */
export type CreditBlocker =
  'not_answering' | 'settings_unread' | 'crediting_unsound' | 'no_feedback';

export function checkSettings(
  read: Partial<Record<WatchedSetting, number | null>>,
  expected: Partial<Record<WatchedSetting, number>>,
): SettingsCheck {
  const values = {} as Record<WatchedSetting, number | null>;
  const unread: WatchedSetting[] = [];
  const mismatches: SettingsCheck['mismatches'] = [];
  const notes: string[] = [];
  for (const key of WATCHED_SETTING_KEYS) {
    const value = read[key];
    values[key] = typeof value === 'number' ? value : null;
    if (values[key] === null) {
      unread.push(key);
      continue;
    }
    const want = expected[key];
    if (typeof want === 'number' && want !== values[key]) {
      mismatches.push({ key, expected: want, actual: values[key]! });
    }
  }
  let creditingSound = true;
  if (values.entryExitMemory !== null && values.entryExitMemory !== 0) {
    creditingSound = false;
    notes.push('entry/exit memory (L-9) is on: a passage may be reported long after its open');
  }
  if (values.uploadMode === 0) {
    creditingSound = false;
    notes.push(
      'upload mode (L-34) is 0: the board does not push passages, so none can be credited',
    );
  }
  if (values.workingMode !== null && values.workingMode !== 0) {
    notes.push(
      `working mode (L-2) is ${values.workingMode}: a side that opens on infrared lets people through uncredited`,
    );
  }
  return { read: values, mismatches, unread, creditingSound, notes };
}

// --- Pending opens --------------------------------------------------------------

export interface PendingOpen {
  id: string;
  side: GateSide;
  direction: GateDirection;
  bandId: string;
  openedAt: number;
  /** The box had no link to the platform when it decided. */
  offline: boolean;
  /** An exit on a revoked band (the deny list's refunded guest leaving). */
  revoked: boolean;
}

export type ControllerOutcome =
  /** Credited: the band's passage is committed. */
  | { type: 'passed'; pending: PendingOpen; at: number }
  /** The open ended with nobody through. `inferred` when the board never said so. */
  | { type: 'timeout'; pending: PendingOpen; at: number; inferred: boolean; personInLane: boolean }
  /** Reverse or tailgating. Names the pending open it followed, credits nobody. */
  | {
      type: 'alarm';
      alarm: 'reverse' | 'tailgating';
      side: GateSide;
      pending: PendingOpen | null;
      at: number;
    }
  /** A passage the box can credit to nobody. */
  | { type: 'uncredited_passage'; side: GateSide; at: number; why: 'no_pending' | 'held_open' }
  /** §2 `95`: a beam broken with the gate at rest. */
  | { type: 'ir_blocked_standby'; at: number };

export type GateFaultCode =
  | 'not_answering'
  | 'stuck_initialising'
  | 'infrared_fault'
  | 'held_open'
  | 'no_feedback'
  | 'settings_mismatch'
  | 'settings_unread'
  | 'crediting_unsound';

export interface GateFault {
  code: GateFaultCode;
  message: string;
  since: number;
}

export interface ControllerOptions {
  /** Real time, in ms. */
  now: () => number;
  /**
   * Added to open duration + close delay for the wire: the board reports a
   * passage after the lane closes, and the report takes a moment to arrive.
   */
  graceMs?: number;
  /** Consecutive missed replies before the board is called not answering. */
  missedRepliesForFault?: number;
  /** How long initialising / zero search may last before it is stuck. */
  stuckInitialisingMs?: number;
  /** How long a beam may stay broken with nobody expected (HX-X1 L-35 default 60 s). */
  infraredFaultMs?: number;
  /** How long the door may stand open with nothing pending before it is held open. */
  heldOpenAfterMs?: number;
  /** Opens in a row ending with no feedback at all before `no_feedback`. */
  silentOpensForFault?: number;
  /** A pending open's id. */
  mintId: () => string;
}

export const GATE_GRACE_MS = 1_500;

export interface GateController {
  /** Adopt what the startup read found; returns the check. */
  applySettings(
    read: Partial<Record<WatchedSetting, number | null>>,
    expected: Partial<Record<WatchedSetting, number>>,
  ): SettingsCheck;
  settings(): SettingsCheck | null;
  /** Open duration + close delay + grace, from the board's values where read. */
  windowMs(): number;
  /**
   * Take the side's one pending open. Opens already past their window are
   * expired first; those timeouts come back in `expired` for the host to
   * journal, whether or not the claim succeeds.
   */
  claim(
    input: Omit<PendingOpen, 'id' | 'openedAt'>,
  ):
    | { ok: true; pending: PendingOpen; expired: ControllerOutcome[] }
    | { ok: false; reason: 'GATE_BUSY' | 'GATE_NOT_READY'; expired: ControllerOutcome[] };
  /** Give a claim back — its open failed and the lane never moved. */
  release(pendingId: string): void;
  pending(side: GateSide): PendingOpen | null;
  onFeedback(feedback: GateFeedback, at?: number): ControllerOutcome[];
  /** Expire opens past their window as inferred timeouts. Called on every tick. */
  expire(at?: number): ControllerOutcome[];
  onDoorState(state: DoorState, at?: number): void;
  onInfraredState(state: InfraredState, at?: number): void;
  /**
   * Any frame from the board. True when this frame ended a not-answering
   * spell: the board booted late or came back, and what the last settings
   * read saw (or missed) is not to be trusted until it is read again.
   */
  noteReply(at?: number): boolean;
  /** A request the board did not answer in time. */
  noteMissedReply(at?: number): void;
  isHeldOpen(): boolean;
  isAnswering(): boolean;
  /** Why an entry opened now could not be credited, or null when it could. */
  creditBlocker(): CreditBlocker | null;
  faults(at?: number): GateFault[];
}

export function createGateController(options: ControllerOptions): GateController {
  const now = options.now;
  const graceMs = options.graceMs ?? GATE_GRACE_MS;
  const missedForFault = options.missedRepliesForFault ?? 3;
  const stuckMs = options.stuckInitialisingMs ?? 30_000;
  const irFaultMs = options.infraredFaultMs ?? 60_000;
  const silentOpensForFault = options.silentOpensForFault ?? 3;

  let check: SettingsCheck | null = null;
  let expectedHeld: Partial<Record<WatchedSetting, number>> = {};
  const pendings: Record<GateSide, PendingOpen | null> = { left: null, right: null };

  let missed = 0;
  let notAnsweringSince: number | null = null;
  let door: DoorState = 'unknown';
  let initialisingSince: number | null = null;
  let doorOpenIdleSince: number | null = null;
  let heldOpenSince: number | null = null;
  let infraredBlockedSince: number | null = null;
  let silentOpens = 0;
  let noFeedbackSince: number | null = null;

  function setting(key: WatchedSetting): number {
    return check?.read[key] ?? expectedHeld[key] ?? HX_X1_FACTORY[key];
  }

  function windowMs(): number {
    return setting('openDurationS') * 1000 + setting('closeDelayDs') * 100 + graceMs;
  }

  function anyPending(): boolean {
    return pendings.left !== null || pendings.right !== null;
  }

  function expire(at = now()): ControllerOutcome[] {
    const out: ControllerOutcome[] = [];
    for (const side of ['left', 'right'] as const) {
      const p = pendings[side];
      if (!p || at - p.openedAt <= windowMs()) continue;
      pendings[side] = null;
      out.push({ type: 'timeout', pending: p, at, inferred: true, personInLane: false });
      // The board answers but never reported this open's end: evidence that
      // it is not pushing feedback (L-34) or the line is one-way.
      if (notAnsweringSince === null) {
        silentOpens += 1;
        if (silentOpens >= silentOpensForFault && noFeedbackSince === null) noFeedbackSince = at;
      }
    }
    return out;
  }

  function sawFeedback(): void {
    silentOpens = 0;
    noFeedbackSince = null;
  }

  return {
    applySettings(read, expected) {
      expectedHeld = { ...expected };
      check = checkSettings(read, expected);
      return check;
    },
    settings: () => check,
    windowMs,

    claim(input) {
      // Anything past its window is over, whatever the next tick would say —
      // and its timeout is handed back, never dropped.
      const expired = expire();
      if (heldOpenSince !== null) return { ok: false, reason: 'GATE_NOT_READY', expired };
      if (pendings[input.side]) return { ok: false, reason: 'GATE_BUSY', expired };
      const pending: PendingOpen = { ...input, id: options.mintId(), openedAt: now() };
      pendings[input.side] = pending;
      return { ok: true, pending, expired };
    },

    release(pendingId) {
      for (const side of ['left', 'right'] as const) {
        if (pendings[side]?.id === pendingId) pendings[side] = null;
      }
    },

    pending: (side) => pendings[side],

    onFeedback(feedback, at = now()) {
      const out = expire(at);
      if (feedback.kind === 'ir_blocked_standby') {
        out.push({ type: 'ir_blocked_standby', at });
        return out;
      }
      sawFeedback();
      const side = feedback.side;
      const p = pendings[side];
      switch (feedback.kind) {
        case 'passed':
          if (heldOpenSince !== null) {
            out.push({ type: 'uncredited_passage', side, at, why: 'held_open' });
          } else if (p) {
            pendings[side] = null;
            out.push({ type: 'passed', pending: p, at });
          } else {
            out.push({ type: 'uncredited_passage', side, at, why: 'no_pending' });
          }
          break;
        case 'timeout':
        case 'timeout_in_lane':
          if (p) {
            pendings[side] = null;
            out.push({
              type: 'timeout',
              pending: p,
              at,
              inferred: false,
              personInLane: feedback.kind === 'timeout_in_lane',
            });
          }
          break;
        case 'reverse':
        case 'tailgating':
          // Nobody is credited and the open stays pending: the guest it was
          // for may still pass, and their "passed" is theirs.
          out.push({ type: 'alarm', alarm: feedback.kind, side, pending: p, at });
          break;
      }
      return out;
    },

    expire,

    onDoorState(state, at = now()) {
      door = state;
      if (state === 'initialising' || state === 'zero_search') {
        initialisingSince ??= at;
      } else {
        initialisingSince = null;
      }
      if (isDoorOpen(state) && !anyPending()) {
        doorOpenIdleSince ??= at;
        const heldAfter = options.heldOpenAfterMs ?? windowMs();
        if (heldOpenSince === null && at - doorOpenIdleSince >= heldAfter) heldOpenSince = at;
      } else if (state === 'closed') {
        doorOpenIdleSince = null;
        heldOpenSince = null;
      } else if (anyPending()) {
        doorOpenIdleSince = null;
      }
    },

    onInfraredState(state, at = now()) {
      const blocked = state !== 'clear' && state !== 'passed_standby' && state !== 'unknown';
      if (blocked && !anyPending()) infraredBlockedSince ??= at;
      else infraredBlockedSince = null;
    },

    noteReply() {
      const recovered = notAnsweringSince !== null;
      missed = 0;
      notAnsweringSince = null;
      return recovered;
    },

    noteMissedReply(at = now()) {
      missed += 1;
      if (missed >= missedForFault) notAnsweringSince ??= at;
    },

    isHeldOpen: () => heldOpenSince !== null,
    isAnswering: () => notAnsweringSince === null,

    creditBlocker() {
      if (notAnsweringSince !== null) return 'not_answering';
      // What the board DID say comes first: a read L-9 = 1 is unsound whether
      // or not L-34 was answered too.
      if (check && !check.creditingSound) return 'crediting_unsound';
      if (creditingUnread(check).length > 0) return 'settings_unread';
      if (noFeedbackSince !== null) return 'no_feedback';
      return null;
    },

    faults(at = now()) {
      const faults: GateFault[] = [];
      if (notAnsweringSince !== null) {
        faults.push({
          code: 'not_answering',
          message:
            'gate controller not answering (cable, power, or power loss holding the gate open)',
          since: notAnsweringSince,
        });
      }
      if (initialisingSince !== null && at - initialisingSince >= stuckMs) {
        faults.push({
          code: 'stuck_initialising',
          message: `gate stuck ${door === 'zero_search' ? 'searching zero' : 'initialising'}`,
          since: initialisingSince,
        });
      }
      if (infraredBlockedSince !== null && at - infraredBlockedSince >= irFaultMs) {
        faults.push({
          code: 'infrared_fault',
          message: 'an infrared beam stays broken with nobody expected in the lane',
          since: infraredBlockedSince,
        });
      }
      if (heldOpenSince !== null) {
        faults.push({
          code: 'held_open',
          message:
            'gate held open with no open pending (fire alarm or forced); passages not credited',
          since: heldOpenSince,
        });
      }
      if (noFeedbackSince !== null) {
        faults.push({
          code: 'no_feedback',
          message:
            'opens end with no passage report from the board (check upload mode L-34 and wiring)',
          since: noFeedbackSince,
        });
      }
      if (check && check.mismatches.length > 0) {
        faults.push({
          code: 'settings_mismatch',
          message: `board settings differ from config: ${check.mismatches
            .map((m) => `${m.key} ${m.actual} (expected ${m.expected})`)
            .join(', ')}`,
          since: 0,
        });
      }
      if (check && check.unread.length > 0) {
        faults.push({
          code: 'settings_unread',
          message: `board did not answer the settings read: ${check.unread.join(', ')}`,
          since: 0,
        });
      }
      if (check && !check.creditingSound) {
        faults.push({ code: 'crediting_unsound', message: check.notes.join('; '), since: 0 });
      }
      return faults;
    },
  };
}
