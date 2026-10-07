import { useCallback, useEffect, useRef, useState } from 'react';
import { KIOSK_IDLE_TIMEOUT_MS, KIOSK_REASONS, newId, type KioskDeskEntry, type KioskRedeemAnswer } from '@oto/shared';
import { KioskError, newKioskCredential, type KioskApi } from '@/api/kiosk';

/**
 * S2-20 K2 (SCRUM-217) — THE SELF-SERVICE KIOSK'S FLOW, without markup.
 *
 * The prototype has no kiosk; the authority is the events-kiosk plan
 * (§5, the K2 row of §9, Q9) and K1's redemption. This file owns the rules
 * the screen follows, so they can be driven and pinned without a browser
 * (`test/s220-k2-kiosk.test.ts`); `pages/Kiosk.tsx` only draws them.
 *
 *   attract  → a touch (or a scan) opens the guest's SESSION on the platform,
 *              so walking away from it can be recorded at all;
 *   scan     → waiting for the booking QR; "Start over" abandons the session
 *              (`cancelled`);
 *   working  → one press in flight — never timed out, the guest is watching
 *              the printer; a lost answer is asked again under the SAME action
 *              id, which K1 answers from the session row instead of redeeming
 *              twice;
 *   result   → one guest-readable screen per ending (`kioskScreenOf`).
 *
 * Q9: 60 seconds of no touch or scan on `scan` or `result` returns to
 * `attract`; on `scan` the session is first recorded abandoned (`idle`). A
 * result screen's session has already ended, so nothing more is sent.
 */

// --- What the guest is shown, per ending ------------------------------------------

export type KioskScreenKind =
  /** Every band printed and the credit loaded: nothing left for the desk. */
  | 'done'
  /** A mixed booking: the regular bands printed, the supervised children are the desk's. */
  | 'done_desk'
  /** Every child is a drop-off or nanny child: nothing was issued, the desk does it all. */
  | 'desk_supervised'
  /**
   * A printer fault or paper out: nothing was issued, the booking is still
   * good. When wristbands came out before the set was called off
   * (`answer.calledOffBands`, SCRUM-504), the guest is asked to hand them in.
   */
  | 'printer'
  /** The kiosk's box is offline, or the kiosk cannot reach the park. */
  | 'offline'
  /** The booking was redeemed before: when and where. */
  | 'already'
  /** The booking is not paid (or no longer redeemable). */
  | 'not_paid'
  /** Not a booking QR this park signed. */
  | 'unrecognised'
  /** Another park's booking. */
  | 'other_branch'
  /** Anything else: the desk will help. */
  | 'desk';

export interface KioskScreen {
  kind: KioskScreenKind;
  /** The redemption's answer, when there was one. Strict: no name, no allergy, no phone. */
  answer: KioskRedeemAnswer | null;
  /** For the printer screen: the fault was paper, which a guest can be told in a word. */
  paperOut: boolean;
}

/** Reasons that mean the set did not come out whole, whoever's code they are. */
const PRINT_REASONS: ReadonlySet<string> = new Set([
  KIOSK_REASONS.noBandPrinter,
  KIOSK_REASONS.bandsNotIssued,
  KIOSK_REASONS.printRouting,
  KIOSK_REASONS.printTimeout,
  KIOSK_REASONS.printHoldLost,
  'PRINT_FAILED',
]);

/**
 * SCRUM-504 — wristbands that came out of the printer for a set the kiosk
 * then called off: nothing was committed, so they open nothing at the gate.
 */
export function calledOffBandsOf(answer: Pick<KioskRedeemAnswer, 'outcome' | 'calledOffBands'> | null): number {
  return answer?.outcome === 'failed' ? (answer.calledOffBands ?? 0) : 0;
}

const UNRECOGNISED_REASONS: ReadonlySet<string> = new Set([
  KIOSK_REASONS.notABookingQr,
  'BOOKING_QR_SIGNATURE_INVALID',
  'BOOKING_NOT_FOUND',
  'NOT_FOUND',
]);

/** One ending, one screen. Printer codes are the box's own (`PRINTER_*`), passed through by K1. */
export function kioskScreenOf(answer: KioskRedeemAnswer): KioskScreen {
  const screen = (kind: KioskScreenKind, paperOut = false): KioskScreen => ({ kind, answer, paperOut });
  if (answer.outcome === 'issued') return screen('done');
  if (answer.outcome === 'handed_off') return screen(answer.bands.length > 0 ? 'done_desk' : 'desk_supervised');
  const reason = answer.reason ?? '';
  if (reason === 'BOOKING_ALREADY_REDEEMED') return screen('already');
  if (reason === 'BOOKING_NOT_REDEEMABLE') return screen('not_paid');
  if (reason === KIOSK_REASONS.boxOffline) return screen('offline');
  if (reason.startsWith('PRINTER_') || PRINT_REASONS.has(reason)) {
    return screen('printer', reason === 'PRINTER_PAPER_OUT');
  }
  if (UNRECOGNISED_REASONS.has(reason)) return screen('unrecognised');
  if (reason === KIOSK_REASONS.otherBranch) return screen('other_branch');
  return screen('desk');
}

// --- The flow -----------------------------------------------------------------------

export type KioskStage =
  | { kind: 'attract' }
  | { kind: 'scan' }
  | { kind: 'working' }
  | { kind: 'result'; screen: KioskScreen };

/** How often, and for how long, a press whose answer was lost is asked again. */
export const KIOSK_PRESS_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export interface KioskFlowOptions {
  api: KioskApi;
  bearer: string;
  stationId: string;
  /** The platform's figure (`GET kiosk/state`); Q9's 60 seconds until it has answered. */
  idleTimeoutMs?: number;
  /** The kiosk's credential was refused: it is not paired any more. */
  onUnpaired: () => void;
  /** Ids for sessions and presses; `newId` (UUIDv7) unless a test supplies its own. */
  mintId?: () => string;
  /** The clock the idle rule reads; `Date.now` unless a test supplies its own. */
  now?: () => number;
}

export interface KioskFlow {
  stage: KioskStage;
  /** The guest touched the attract screen. */
  begin: () => void;
  /** A code came in from the scanner. */
  scanned: (code: string) => void;
  /** "Start over" on the scan step: the session is abandoned as cancelled. */
  startOver: () => void;
  /** "Done" on a result screen. */
  finish: () => void;
  /** "Try again" on a result screen: a new session, straight to the scan step. */
  tryAgain: () => void;
  /** Any touch on the screen: the idle clock starts again. */
  activity: () => void;
}

interface OpenSession {
  id: string;
  /** Resolves true once the platform holds it; false if it never did (the press opens its own). */
  started: Promise<boolean>;
  /** A press was made on it: its ending is the press's, never an abandonment. */
  pressed: boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A press whose answer may simply have been lost: ask again, under the same action id. */
function askAgain(err: unknown): boolean {
  if (!(err instanceof KioskError)) return true;
  return err.status === 0 || err.status >= 500 || err.code === KIOSK_REASONS.inProgress;
}

export function useKioskFlow(options: KioskFlowOptions): KioskFlow {
  const [stage, setStage] = useState<KioskStage>({ kind: 'attract' });
  const opts = useRef(options);
  opts.current = options;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const session = useRef<OpenSession | null>(null);
  const lastActivity = useRef(0);
  /** Bumped whenever the flow moves on, so a press answered after the guest left is dropped. */
  const generation = useRef(0);

  const now = () => (opts.current.now ?? Date.now)();
  const mint = () => (opts.current.mintId ?? newId)();
  const unpaired = (err: unknown) => {
    if (err instanceof KioskError && err.status === 401) {
      opts.current.onUnpaired();
      return true;
    }
    return false;
  };

  const go = useCallback((next: KioskStage) => {
    generation.current += 1;
    lastActivity.current = (opts.current.now ?? Date.now)();
    stageRef.current = next;
    setStage(next);
  }, []);

  /** Open the guest's session on the platform, without waiting for it. */
  const openSession = useCallback((): OpenSession => {
    const { api, bearer, stationId } = opts.current;
    const id = mint();
    const started = api
      .startSession(bearer, stationId, id)
      .then(() => true)
      .catch((err: unknown) => {
        unpaired(err);
        return false;
      });
    const opened: OpenSession = { id, started, pressed: false };
    session.current = opened;
    return opened;
     
  }, []);

  /** Record the guest walking away, if they scanned nothing. Never waits, never throws. */
  const abandonSession = useCallback((cause: 'idle' | 'cancelled') => {
    const open = session.current;
    session.current = null;
    if (!open || open.pressed) return;
    const { api, bearer, stationId } = opts.current;
    void open.started.then((held) => {
      if (!held) return;
      return api.abandon(bearer, stationId, open.id, cause).then(
        () => undefined,
        (err: unknown) => {
          unpaired(err);
        },
      );
    });
     
  }, []);

  const begin = useCallback(() => {
    if (stageRef.current.kind !== 'attract') return;
    openSession();
    go({ kind: 'scan' });
  }, [go, openSession]);

  const scanned = useCallback(
    (raw: string) => {
      const code = raw.trim();
      const current = stageRef.current.kind;
      if (!code || current === 'working') return;
      // From the attract screen or after an ending, a scan is a new guest's first move.
      const open = current === 'scan' && session.current ? session.current : openSession();
      open.pressed = true;
      go({ kind: 'working' });
      const mine = generation.current;
      const actionId = mint();
      const { api, bearer, stationId } = opts.current;

      void (async () => {
        const held = await open.started;
        let screen: KioskScreen | null = null;
        for (let attempt = 0; screen === null; attempt += 1) {
          try {
            const answer = await api.redeem(bearer, stationId, {
              actionId,
              qr: code,
              ...(held ? { sessionId: open.id } : {}),
            });
            screen = kioskScreenOf(answer);
          } catch (err) {
            if (unpaired(err)) return;
            const delay = KIOSK_PRESS_RETRY_DELAYS_MS[attempt];
            if (askAgain(err) && delay !== undefined) {
              await wait(delay);
              if (generation.current !== mine) return;
              continue;
            }
            // A request the platform refused outright (a code too long to be
            // a booking QR) is a code we could not read; anything else after
            // every retry is a kiosk that cannot reach the park.
            screen = {
              kind: err instanceof KioskError && err.status === 400 ? 'unrecognised' : 'offline',
              answer: null,
              paperOut: false,
            };
          }
        }
        if (generation.current !== mine) return;
        if (session.current === open) session.current = null;
        go({ kind: 'result', screen });
      })();
    },
     
    [go, openSession],
  );

  const startOver = useCallback(() => {
    if (stageRef.current.kind === 'working') return;
    if (stageRef.current.kind === 'scan') abandonSession('cancelled');
    go({ kind: 'attract' });
  }, [abandonSession, go]);

  const finish = useCallback(() => {
    if (stageRef.current.kind !== 'result') return;
    go({ kind: 'attract' });
  }, [go]);

  const tryAgain = useCallback(() => {
    if (stageRef.current.kind !== 'result') return;
    openSession();
    go({ kind: 'scan' });
  }, [go, openSession]);

  const activity = useCallback(() => {
    lastActivity.current = (opts.current.now ?? Date.now)();
  }, []);

  /**
   * Q9 — THE IDLE CLOCK. Armed on the scan step and on every result screen,
   * never while a press is in flight. A touch moves `lastActivity` rather than
   * re-arming the timer, so a finger on the screen costs no render; when the
   * timer fires early because of one, it sleeps for what is left.
   */
  const idleMs = options.idleTimeoutMs ?? KIOSK_IDLE_TIMEOUT_MS;
  useEffect(() => {
    if (stage.kind !== 'scan' && stage.kind !== 'result') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const left = lastActivity.current + idleMs - now();
      if (left > 0) {
        timer = setTimeout(check, left);
        return;
      }
      if (stageRef.current.kind === 'scan') abandonSession('idle');
      go({ kind: 'attract' });
    };
    timer = setTimeout(check, Math.max(0, lastActivity.current + idleMs - now()));
    return () => clearTimeout(timer);
     
  }, [stage, idleMs, abandonSession, go]);

  return { stage, begin, scanned, startOver, finish, tryAgain, activity };
}

// --- Pairing ---------------------------------------------------------------------------

export type KioskPairingView =
  | { kind: 'connecting' }
  | { kind: 'code'; pairingCode: string; expiresAt: string }
  | { kind: 'expired' }
  | { kind: 'paired'; stationId: string; stationName: string };

export interface KioskPairingOptions {
  api: KioskApi;
  /** The secret this browser already holds, if any. */
  initialBearer: string | null;
  /** Keep the secret; false when this browser cannot. */
  remember: (bearer: string) => boolean;
  newBearer?: () => string;
  /** How often an unpaired kiosk asks whether its code was claimed. */
  pollMs?: number;
}

export interface KioskPairing {
  view: KioskPairingView;
  bearer: string;
  /** False when this browser cannot keep the secret: the page says so. */
  persistent: boolean;
  error: string | null;
  /** The platform said this kiosk is not paired any more: start again with a new secret. */
  reset: () => void;
  /** Call the code shown off, and wait for a person to ask for a new one. */
  expire: () => void;
  /** A new code, after one was called off or ran out. */
  newCode: () => void;
}

/**
 * A KIOSK PAIRS AS A DISPLAY DOES (`pages/Display.tsx`): its own secret first,
 * then a code a manager types into Console > Devices > Pair a kiosk. Polled
 * every two seconds until the code is claimed; a code that ran out, or a
 * credential since revoked, reads as `expired`, and a new code is minted under
 * a NEW secret so the old one is dead everywhere.
 */
export function useKioskPairing(options: KioskPairingOptions): KioskPairing {
  const opts = useRef(options);
  opts.current = options;
  const fresh = () => (opts.current.newBearer ?? newKioskCredential)();
  const [bearer, setBearer] = useState(() => options.initialBearer ?? fresh());
  const [view, setView] = useState<KioskPairingView>({ kind: 'connecting' });
  const [persistent, setPersistent] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to restart the poll: a reset, or a new code after an expiry. */
  const [round, setRound] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasCode = false;
    const tick = async () => {
      const { api, remember, pollMs } = opts.current;
      try {
        setPersistent(remember(bearer));
        const status = await api.pairingStatus(bearer, controller.signal);
        if (stopped) return;
        if (status.status === 'paired' && status.station) {
          setView({ kind: 'paired', stationId: status.station.id, stationName: status.station.name });
          setError(null);
          return; // Paired: the flow takes over; nothing more to poll here.
        }
        if (status.status === 'expired' && hasCode) {
          // The code ran out on screen: a new secret, a new code.
          setBearer(fresh());
          return;
        }
        if (!hasCode || status.status === 'expired') {
          const code = await api.startPairing(bearer, controller.signal);
          if (stopped) return;
          hasCode = true;
          setView({ kind: 'code', pairingCode: code.pairingCode, expiresAt: code.expiresAt });
        }
        setError(null);
      } catch (err) {
        if (stopped) return;
        if (err instanceof KioskError && (err.code === 'KIOSK_ALREADY_PAIRED' || err.status === 401)) {
          // A secret some device already holds, or one the platform will not take: start again.
          setBearer(fresh());
          return;
        }
        setError(err instanceof Error ? err.message : 'This kiosk could not connect.');
      }
      if (!stopped) timer = setTimeout(() => void tick(), pollMs ?? 2_000);
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
     
  }, [bearer, round, paused]);

  const reset = useCallback(() => {
    setView({ kind: 'connecting' });
    setPaused(false);
    setBearer((opts.current.newBearer ?? newKioskCredential)());
  }, []);

  const expire = useCallback(() => {
    setPaused(true);
    setView({ kind: 'expired' });
    void opts.current.api.expirePairing(bearer).catch(() => undefined);
  }, [bearer]);

  const newCode = useCallback(() => {
    setView({ kind: 'connecting' });
    setPaused(false);
    setBearer((opts.current.newBearer ?? newKioskCredential)());
    setRound((r) => r + 1);
  }, []);

  return { view, bearer, persistent, error, reset, expire, newCode };
}

// --- The staff desk's view -----------------------------------------------------------------

/**
 * What the desk reads on a family a kiosk sent to it, in the till's English:
 * why the kiosk stopped, and so what the desk does next. Staff-facing, so it
 * may name the printer and the box; it still names no child.
 */
export function deskReasonOf(
  entry: Pick<KioskDeskEntry, 'outcome' | 'reason' | 'supervisedChildren' | 'bandsIssued' | 'calledOffBands'>,
): string {
  const reason = entry.reason ?? '';
  const children = (n: number) => `${n} supervised child${n === 1 ? '' : 'ren'}`;
  if (entry.outcome === 'handed_off') {
    return entry.bandsIssued > 0
      ? `Regular bands printed at the kiosk; ${children(entry.supervisedChildren)} to check in here.`
      : `Drop-off or nanny booking (${children(entry.supervisedChildren)}): nothing was issued at the kiosk.`;
  }
  const why = failedReasonOf(reason);
  /**
   * SCRUM-504 — a set called off part-way: nothing was issued, but bands may
   * be in the family's hands. They open nothing at the gate; the desk takes
   * them back, so nobody is left holding a band that looks like a ticket.
   */
  const out = entry.calledOffBands ?? 0;
  if (out > 0) {
    const bands = out === 1 ? '1 wristband' : `${out} wristbands`;
    return `${why} ${bands} may have come out at the kiosk — take ${out === 1 ? 'it' : 'them'} back from the family; ${out === 1 ? 'it opens' : 'they open'} nothing at the gate.`;
  }
  return why;
}

/** Why the kiosk stopped, in the till's English, for a session that issued nothing. */
function failedReasonOf(reason: string): string {
  if (reason === 'PRINTER_UNREACHABLE' || reason === 'PRINTER_OFFLINE') {
    return 'The kiosk printer was offline: nothing was issued.';
  }
  if (reason === 'PRINTER_PAPER_OUT') return 'The kiosk printer ran out of paper: nothing was issued.';
  if (reason === KIOSK_REASONS.printTimeout) return 'The kiosk printer took too long: nothing was issued.';
  if (reason === KIOSK_REASONS.printHoldLost) {
    return 'The kiosk lost its connection to the park while printing: nothing was issued.';
  }
  if (reason.startsWith('PRINTER_') || PRINT_REASONS.has(reason)) {
    return 'The kiosk printer failed: nothing was issued.';
  }
  if (reason === KIOSK_REASONS.boxOffline) return "The kiosk's box was offline: nothing was issued.";
  if (reason === 'BOOKING_ALREADY_REDEEMED') return 'Already redeemed: the family scanned it again at the kiosk.';
  if (reason === 'BOOKING_NOT_REDEEMABLE') return 'Not paid: the kiosk could not issue it.';
  if (reason === 'BOOKING_REDEMPTION_IN_PROGRESS') {
    return 'Being redeemed elsewhere at the same moment: open the booking to see how that ended.';
  }
  return `The kiosk could not finish (${reason || 'no reason given'}): nothing was issued.`;
}
