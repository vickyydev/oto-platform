import { createHash } from 'node:crypto';

/**
 * The one part of this package that needs a Node builtin, kept behind its own
 * entry point (`@oto/telemetry/node`) so the POS, the booth and the console
 * can import the redactor into a browser bundle without dragging
 * `node:crypto` in with it.
 */

/**
 * Stable, non-reversible handle for a phone number. Enough to correlate
 * "the same number failed five times" in a log without the number itself.
 */
export function phoneHash(phone: string): string {
  return `ph_${createHash('sha256').update(phone).digest('hex').slice(0, 12)}`;
}
