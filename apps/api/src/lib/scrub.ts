/**
 * Redaction moved to `@oto/telemetry` in S2-03 so that the POS, the launcher,
 * the console and the box agent share ONE implementation. Two of them would
 * drift, and the one that drifted would be the one nobody was reading when a
 * phone number reached a log.
 *
 * This file is the api's thin binding: the package decides what a unique
 * violation means, and the api turns that into its own error envelope.
 * `AppError` stays here deliberately — a browser bundle importing the
 * redactor should not be importing Fastify's error shape with it.
 */
import { isPgError, uniqueViolationInfo, type PgErrorShape } from '@oto/telemetry';
import { AppError } from './errors';

export { isPgError, scrubPgError, scrubUrl, redact } from '@oto/telemetry';
export { phoneHash } from '@oto/telemetry/node';

/**
 * The pg error inside whatever the driver stack wrapped it in.
 *
 * Drizzle raises a `DrizzleQueryError` carrying the query, its parameters and
 * the real error as `cause`, so `isPgError` applied to what a route catches is
 * false every time — and the whole unique-violation mapping below has
 * therefore never once fired. Every duplicate this api could not pre-check has
 * been answering `500 INTERNAL` instead of the 409 with a constraint name that
 * was written for it (found while building the fleet routes, S2-04).
 *
 * Walking `cause` rather than reaching for `err.cause` once: the chain is the
 * driver's business and may grow a link. Bounded so a cycle cannot hang a
 * request.
 */
export function pgErrorOf(err: unknown): PgErrorShape | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (isPgError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** 23505 → 409 with a business code; anything else → null (unhandled). */
export function uniqueViolationToAppError(err: unknown): AppError | null {
  const info = uniqueViolationInfo(pgErrorOf(err));
  return info ? new AppError(info.statusCode, info.code, info.message, info.details) : null;
}
