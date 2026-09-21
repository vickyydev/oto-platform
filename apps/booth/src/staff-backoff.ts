/**
 * How long the sign-in panel waits after a run of wrong PINs.
 *
 * Five wrong attempts are free — a booth is worked standing up, in a mall,
 * often by somebody who has just come on shift, and locking them out on the
 * fifth try would make the platform's security policy into an operational
 * problem. The sixth starts a 30-second wait, and each further wrong attempt
 * doubles it to a ceiling of fifteen minutes: long enough that guessing four
 * digits at this rate is pointless, short enough that a shift is not lost.
 *
 * **This is the panel's arithmetic, not the booth's.** A backoff counted in a
 * browser is a courtesy: reloading the page clears it, and a booth's URL bar
 * is one remote press away. Whatever actually verifies the PIN has to enforce
 * its own, which is what `StaffSignInResponse.retryAfterMs` carries; the panel
 * waits for the longer of the two.
 *
 * And it never reaches the game. Nothing in this file is consulted by the
 * press path: a staff member fumbling a PIN must not stop a child spinning.
 */

/** Wrong attempts allowed before any wait at all. */
export const FREE_ATTEMPTS = 5;
/** The wait the first backoff imposes. */
export const FIRST_BACKOFF_MS = 30_000;
/** The ceiling. Reached on the tenth consecutive wrong attempt. */
export const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * The wait after `failures` consecutive wrong attempts, in milliseconds.
 * Zero while the attempt count is still within the free allowance.
 */
export function backoffFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const doublings = failures - FREE_ATTEMPTS - 1;
  // 2 ** doublings overflows into Infinity long before it matters, and
  // Math.min handles Infinity correctly, so no separate guard is needed for a
  // booth somebody has typed at four hundred times.
  return Math.min(FIRST_BACKOFF_MS * 2 ** doublings, MAX_BACKOFF_MS);
}

/** Whole seconds remaining, for the panel's countdown. Never negative. */
export function secondsLeft(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}
