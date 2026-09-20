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
import { uniqueViolationInfo } from '@oto/telemetry';
import { AppError } from './errors';

export { isPgError, scrubPgError, scrubUrl, redact } from '@oto/telemetry';
export { phoneHash } from '@oto/telemetry/node';

/** 23505 → 409 with a business code; anything else → null (unhandled). */
export function uniqueViolationToAppError(err: unknown): AppError | null {
  const info = uniqueViolationInfo(err);
  return info ? new AppError(info.statusCode, info.code, info.message, info.details) : null;
}
