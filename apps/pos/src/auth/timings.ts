/**
 * Session timings — the single source of truth for how long a till may sit
 * untouched (S2-01a).
 *
 * These were in `mockApi.ts`, the module that holds the prototype's in-memory
 * fixtures, which meant a real security control lived in the file everything
 * else is being moved OFF. The values themselves are the prototype's own and
 * are unchanged: two minutes of no interaction, with the last fifteen seconds
 * spent warning.
 *
 * Reaching the end LOCKS the session, it does not end it: the account stays
 * signed in on the server, and the password unlocks the same session. That is
 * what lets a box unlock a till with no network later (S2-06).
 */
export const INACTIVITY_TIMEOUT_MS = 120_000;
export const INACTIVITY_WARNING_MS = 15_000;
