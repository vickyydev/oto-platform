import { SCREEN_SCAN_AGE_MAX_S } from '@oto/shared';

/**
 * SCRUM-771 — WHEN A SCANNER LAST TYPED INTO THIS TILL.
 *
 * A cradle plugged into the iPad is a keyboard to it. Nothing reports it,
 * nothing can ask it whether it is there; the only sign of it the till has is
 * the codes it types. So every place the till tells a scanner from a person
 * typing notes the moment here — a scan-paced burst the page listener took
 * (`lib/scannerBurst.ts`), and a scan or a paste the wristband field took
 * (`components/fnb/ScanWristband.tsx`) — and the station heartbeat
 * (`station/heartbeat.ts`) reports how long ago that was. A paste counts, as
 * the wristband field already treats it like a scan: it is how a code arrives
 * whole, and it is how the till is tried out with no cradle to hand.
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
