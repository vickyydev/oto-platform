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
 * Kept as a time on the page's monotonic clock, never a time of day: the age is
 * what travels, so an iPad whose clock is wrong cannot misdate the scan.
 */

let lastAt: number | null = null;

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A scanner typed a code into this till just now. */
export function noteScannerUse(at: number = clock()): void {
  lastAt = at;
}

/**
 * How many whole seconds ago a scanner last typed into this till, or null when
 * none has since the till was loaded — or so long ago that the platform keeps
 * the time it already has.
 */
export function lastScanSecondsAgo(now: number = clock()): number | null {
  if (lastAt === null) return null;
  const seconds = Math.max(0, Math.round((now - lastAt) / 1000));
  return seconds > SCREEN_SCAN_AGE_MAX_S ? null : seconds;
}

/** Forget it — a test's clean slate. */
export function forgetScannerUse(): void {
  lastAt = null;
}
