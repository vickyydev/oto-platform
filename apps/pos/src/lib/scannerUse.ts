import { SCANNER_BURST_GAP_MS, SCANNER_BURST_MIN_LENGTH, SCREEN_SCAN_AGE_MAX_S } from '@oto/shared';

/**
 * SCRUM-771 — WHEN A SCANNER LAST TYPED INTO THIS TILL.
 *
 * A cradle plugged into the iPad is a keyboard to it. Nothing reports it,
 * nothing can ask it whether it is there; the only sign of it the till has is
 * the codes it types. So every place the till hears keys arrive at a scanner's
 * pace notes the moment here — a scan-paced burst the page listener took
 * (`lib/scannerBurst.ts`), and a scan-paced run the wristband field took
 * (`components/fnb/ScanWristband.tsx`, by `nextPacedRun` below) — and the
 * station heartbeat (`station/heartbeat.ts`) reports how long ago that was. A
 * paste, or text an iPad inserts in one go (QuickType, dictation), is not a
 * scanner and is never noted, whatever the field then does with it.
 *
 * A scanner plugged into the BOX is not noted: the box reads it and reports it
 * on its own heartbeat.
 *
 * What travels is an AGE, never a time of day, so an iPad whose clock is wrong
 * cannot misdate the scan. It is measured on both of the page's clocks:
 *
 *  - the WALL clock (`Date.now()`) keeps running while the iPad sleeps, so a
 *    scan made before an hour's auto-lock is an hour old when it wakes;
 *  - the MONOTONIC clock (`performance.now()`) does not move when the clock is
 *    set back, but on iPadOS it stands still while the device sleeps.
 *
 * The age is the larger of the two differences; only when the wall clock went
 * backwards (set back since the scan) is the monotonic one taken alone.
 */

/** A moment on both of the page's clocks. */
export interface ScanClock {
  /** `Date.now()`: runs on while the iPad sleeps. */
  wall: number;
  /** `performance.now()`: never set back, but stands still while the iPad sleeps. */
  mono: number;
}

let lastAt: ScanClock | null = null;

const clock = (): ScanClock => {
  const wall = Date.now();
  return { wall, mono: typeof performance !== 'undefined' ? performance.now() : wall };
};

/** A scanner typed a code into this till just now. */
export function noteScannerUse(at: ScanClock = clock()): void {
  lastAt = at;
}

/** How long ago `then` was, in milliseconds, read on both clocks. */
export function scanAgeMs(then: ScanClock, now: ScanClock): number {
  const wall = now.wall - then.wall;
  const mono = now.mono - then.mono;
  if (wall < 0) return Math.max(0, mono);
  return Math.max(wall, mono);
}

/**
 * How many whole seconds ago a scanner last typed into this till, or null when
 * none has since the till was loaded — or so long ago that the platform keeps
 * the time it already has.
 */
export function lastScanSecondsAgo(now: ScanClock = clock()): number | null {
  if (lastAt === null) return null;
  const seconds = Math.round(scanAgeMs(lastAt, now) / 1000);
  return seconds > SCREEN_SCAN_AGE_MAX_S ? null : seconds;
}

/** Forget it — a test's clean slate. */
export function forgetScannerUse(): void {
  lastAt = null;
}

/**
 * A run of single characters typed into a field at a scanner's pace — the
 * shared scanner rule (`SCANNER_BURST_GAP_MS`, `SCANNER_BURST_MIN_LENGTH`),
 * the one the page listener and the box apply.
 *
 * It decides presence only. A field may take a paste, a bulk insertion or a
 * slower run as a whole code for its own reasons (the wristband field does);
 * none of those is a scanner, so any change that is not exactly one character
 * typed, and not pasted, ends the run here.
 */
export interface PacedRun {
  length: number;
  /** The last character's time, on the event's monotonic clock. */
  at: number;
}

export const NO_PACED_RUN: PacedRun = { length: 0, at: 0 };

/** The run after one change to the field: `added` characters at `at`, pasted or not. */
export function nextPacedRun(run: PacedRun, change: { added: number; at: number; pasted: boolean }): PacedRun {
  if (change.added !== 1 || change.pasted) return { length: 0, at: change.at };
  const inRun = run.length > 0 && change.at - run.at <= SCANNER_BURST_GAP_MS;
  return { length: inRun ? run.length + 1 : 1, at: change.at };
}

/** Whether the run reads as a scanner: long enough, every key at its pace. */
export function pacedLikeScanner(run: PacedRun): boolean {
  return run.length >= SCANNER_BURST_MIN_LENGTH;
}
