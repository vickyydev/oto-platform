/**
 * `@oto/telemetry` — what may be written down, decided once.
 *
 * Everything exported here runs in a browser as well as in Node, so the POS,
 * the booth display, the launcher and the console redact by the same rules as
 * the api. `phoneHash` needs `node:crypto` and is exported from
 * `@oto/telemetry/node`; the ESLint rule is `@oto/telemetry/eslint`.
 */

export {
  redact,
  redactBindings,
  createRedactor,
  isSensitiveKey,
  scrubText,
  type RedactOptions,
} from './redact';

export {
  scrubUrl,
  isPgError,
  scrubPgError,
  uniqueViolationInfo,
  type PgErrorShape,
  type UniqueViolationInfo,
} from './scrub';

export { safeLogger, type PinoLike, type LogFn } from './logger';
