import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * THE OTO APP'S PASSWORD CHECK, PORTED (SCRUM-795).
 *
 * The OTO App stores a password as `<hex>.<salt>`: 64 bytes of scrypt output
 * in hex, a dot, and a random 16-byte salt written as 32 hex characters, with
 * Node's default scrypt cost (N=16384, r=8, p=1). `hashPassword` and
 * `comparePasswords` in `apps/oto-app/server/auth.ts` are the definition;
 * `compareOtoAppPassword` below is `comparePasswords` line for line — the same
 * split on ".", the salt used as the STRING it is stored as (not decoded from
 * hex), keylen 64, and `timingSafeEqual` over the two buffers.
 *
 * One difference, deliberately: the app's function throws on a stored value
 * that is not 64 bytes of hex and a salt (`timingSafeEqual` refuses buffers of
 * different lengths, and scrypt refuses an undefined salt). Here such a value
 * is simply not a match — after the same scrypt work, so a malformed hash is
 * not answered sooner than a real one. Restored rows are data, and one odd row
 * must not turn a refused sign-in into a 500.
 *
 * Used by `signIn` once per person: the first sign-in of an account that has
 * no platform password yet, checked against the app's hash, after which the
 * platform's own argon2 hash is the only one consulted. Nothing here stores,
 * copies or logs either the password or the hash.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/** The scrypt output length the app writes and compares (`hashPassword`). */
export const OTOAPP_SCRYPT_KEYLEN = 64;

const WELL_FORMED = /^[0-9a-f]{128}$/i;

/** A well-formed value nobody's password produces, for the equalising work below. */
const DUMMY_STORED = `${randomBytes(OTOAPP_SCRYPT_KEYLEN).toString('hex')}.${randomBytes(16).toString('hex')}`;

/** Does `supplied` match `stored`, by the OTO App's own rule? */
export async function compareOtoAppPassword(supplied: string, stored: string): Promise<boolean> {
  const [hashed, salt] = stored.split('.');
  if (!hashed || !salt || !WELL_FORMED.test(hashed)) {
    await equalizeOtoAppCompareCost(supplied);
    return false;
  }
  const hashedBuf = Buffer.from(hashed, 'hex');
  const suppliedBuf = await scryptAsync(supplied, salt, OTOAPP_SCRYPT_KEYLEN);
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

/**
 * Spend one app-password check that cannot succeed, so that a refusal which
 * never reached a real one costs the same (the scrypt half of SCRUM-325's
 * rule, see `signIn`). The result is discarded and a failure swallowed: this
 * is a stopwatch's worth of work, never a credential.
 */
export async function equalizeOtoAppCompareCost(supplied: string): Promise<void> {
  try {
    const [hashed, salt] = DUMMY_STORED.split('.');
    await scryptAsync(supplied, salt!, OTOAPP_SCRYPT_KEYLEN).then((b) =>
      timingSafeEqual(Buffer.from(hashed!, 'hex'), b),
    );
  } catch {
    // Deliberately nothing: the answer was known before the call.
  }
}
