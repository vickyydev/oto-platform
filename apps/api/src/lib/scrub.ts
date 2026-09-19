import { createHash } from 'node:crypto';
import { AppError } from './errors';

/**
 * Log and error-report redaction (S2-01a).
 *
 * Sprint 1 logged the full request line, so `GET /members/lookup?phone=+66…`
 * put a customer's phone number in stdout — and on Render stdout is a hosted
 * log stream the whole team can read. Nothing here is optional prettiness:
 * a phone number is the park's primary customer identifier and the key its
 * members are looked up by.
 */

/** Path only. Query strings carry phones, codes and search terms. */
export function scrubUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

/**
 * Stable, non-reversible handle for a phone number. Enough to correlate
 * "the same number failed five times" in a log without the number itself.
 */
export function phoneHash(phone: string): string {
  return `ph_${createHash('sha256').update(phone).digest('hex').slice(0, 12)}`;
}

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  schema?: unknown;
  routine?: unknown;
  severity?: unknown;
  message?: unknown;
}

/** A node-postgres error: 5-char SQLSTATE plus the server's own fields. */
export function isPgError(err: unknown): err is PgErrorShape {
  if (!err || typeof err !== 'object') return false;
  const e = err as PgErrorShape;
  return (
    typeof e.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(e.code) &&
    (typeof e.severity === 'string' || typeof e.routine === 'string')
  );
}

/**
 * The parts of a pg error that are safe to log. `detail`, `hint`, `where`,
 * `parameters` and the query text are dropped: on a unique violation
 * `detail` reads `Key (phone)=(+66811111111) already exists`, which is the
 * exact leak this ticket exists to close. `code` and `constraint` are what
 * an engineer actually needs.
 */
export function scrubPgError(err: PgErrorShape): Record<string, unknown> {
  return {
    pgCode: err.code,
    constraint: err.constraint,
    table: err.table,
    schema: err.schema,
    routine: err.routine,
    // The server's message names the constraint, never the value.
    message: typeof err.message === 'string' ? err.message.slice(0, 200) : undefined,
  };
}

/**
 * Business meaning of a unique violation, by constraint name. Returning a
 * typed 409 keeps the offending value out of the response as well as the log
 * — the client already knows what it sent.
 */
const UNIQUE_VIOLATIONS: Record<string, { code: string; message: string }> = {
  member_phone_unique: { code: 'MEMBER_PHONE_EXISTS', message: 'A member with this phone already exists' },
  account_phone_unique: { code: 'ACCOUNT_PHONE_EXISTS', message: 'An account with this phone already exists' },
  branch_code_unique: { code: 'BRANCH_CODE_EXISTS', message: 'A branch with this code already exists' },
  role_name_unique: { code: 'ROLE_NAME_EXISTS', message: 'A role with this name already exists' },
  role_assignment_unique: { code: 'ROLE_ASSIGNMENT_EXISTS', message: 'That role is already assigned at this scope' },
  role_permission_unique: { code: 'ROLE_PERMISSION_EXISTS', message: 'That permission is already on the role' },
  tier_code_unique: { code: 'TIER_CODE_EXISTS', message: 'A tier with this code already exists' },
  ticket_package_name_unique: { code: 'PACKAGE_NAME_EXISTS', message: 'A package with this name already exists' },
  branch_tax_config_unique: { code: 'TAX_CONFIG_EXISTS', message: 'Tax rules for this branch already exist' },
  booking_reference_unique: { code: 'BOOKING_REFERENCE_EXISTS', message: 'That booking reference is taken' },
};

/** 23505 → 409 with a business code; anything else → null (unhandled). */
export function uniqueViolationToAppError(err: unknown): AppError | null {
  if (!isPgError(err) || err.code !== '23505') return null;
  const constraint = typeof err.constraint === 'string' ? err.constraint : '';
  const known = UNIQUE_VIOLATIONS[constraint];
  return new AppError(
    409,
    known?.code ?? 'DUPLICATE',
    known?.message ?? 'That value is already taken',
    // The constraint name is safe to hand back; the value is not.
    constraint ? { constraint } : undefined,
  );
}
