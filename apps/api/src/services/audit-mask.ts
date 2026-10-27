/**
 * The audit read's masking (S2-03), shared since SCRUM-648 so the support
 * lookup masks a member and their children exactly as the activity history
 * masks them: by key name, recursively, unless the reader holds
 * `admin:audit:read_sensitive`.
 *
 * Keys whose values are personal. Masked by name rather than by row type
 * because the payload is free-form jsonb: a new route that audits a phone
 * number is covered on the day it is written, without anyone remembering to
 * come back here.
 */
const SENSITIVE_KEY =
  /^(phone|phone_?number|mobile|email|name|nickname|first_?name|last_?name|full_?name|address|allergies|allergy|medical_?notes|medical_?alert|dietary|food_?restrictions|notes?|date_?of_?birth|dob|age_?years|guardian_?name|password|token|secret)$/i;

export const MASK = '[redacted]';
const MAX_DEPTH = 8;

/** Replace the values of personal keys, keeping the shape of the change. */
export function maskPersonal(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskPersonal(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? (v === null ? null : MASK) : maskPersonal(v, depth + 1);
  }
  return out;
}

