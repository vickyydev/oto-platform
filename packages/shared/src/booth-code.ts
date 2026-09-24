/**
 * The voucher code a booth prints (S2-07a, D8), with its check character
 * (S2-10b).
 *
 * Two characters of booth prefix, eight random characters and one check
 * character, eleven in all: `B1RT7KMQ4XW`. It is minted on the box, inside the
 * transaction that records the spin, so a booth with no internet still prints
 * a code the park will honour — which is the whole reason the code is random
 * rather than a counter.
 *
 * Nothing here talks to a database. Uniqueness is the unique index on
 * `promo.voucher (operator_id, code)`; this file only produces and reads the
 * string. See `mintBoothCode` for what that division of labour requires of a
 * caller.
 *
 * **Codes printed before the check character existed are ten characters** and
 * are still in families' hands on staging. They are not re-coded: a till looks
 * a well-formed ten-character code up as it is (`isLegacyBoothCode`), and only
 * an ELEVEN-character code is held to the check. No box mints ten characters
 * any more, so a ten-character code the platform does not know is a current
 * code with a character dropped, and the till says so ("Invalid code").
 */

/**
 * The same thirty characters `mintClaimCode` uses (`apps/api/src/services/box.ts`).
 *
 * **One alphabet, not two.** A claim code is read off a sticker on a Raspberry
 * Pi and a voucher code is read off a printed slip at reception, and both end
 * up typed by somebody who is looking at paper. A platform with two
 * "unambiguous" sets has an argument waiting for whoever writes the third one.
 *
 * What it actually drops is `0 1 I L O U` — every pair where BOTH members
 * would otherwise be present, so within the eight DRAWN characters a misread
 * `0`/`O` or `1`/`I`/`l` cannot happen: neither character is ever drawn. The
 * two-character prefix is a different matter and is covered below; the park's
 * own `B1` contains a character this set does not.
 *
 * **What it does not drop, and this is worth knowing before somebody relies on
 * the word "unambiguous":** `5`/`S`, `2`/`Z`, `8`/`B` and `6`/`G` are all still
 * in the set, and on a thermal slip in a mall they are confusable. Nothing here
 * corrects them, and nothing can: both members are live characters, so `S` → `5`
 * is not a normalisation, it is a different code. What a misread costs is a
 * lookup that finds nothing — see the collision arithmetic below for why it
 * will not quietly find somebody else's voucher — and staff retyping. If that
 * turns out to be a daily annoyance at reception, the fix is to narrow this set
 * for both kinds of code at once and accept the smaller space, not to add a
 * second alphabet.
 *
 * The duplication itself is not enforced by anything today: `CLAIM_ALPHABET`
 * lives in the api and this lives in `@oto/shared`, and they are equal by
 * inspection at the time of writing, not by a test.
 */
export const BOOTH_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `B1` — which booth printed it. Assigned per booth; `core.station.code_prefix`.
 *
 * **The prefix is NOT drawn from the alphabet above, and cannot be.** Booth 1
 * is called `B1` by the people who work at it, and `1` is one of the
 * characters the alphabet drops. D8 puts the alphabet on the eight random
 * characters, which is the part this module actually draws; the prefix is a
 * label the park chose, and a rule that outlawed the booth's own name would be
 * a rule somebody works around with a worse one.
 *
 * So it is validated as two upper-case alphanumerics and no more than that.
 * Whoever allocates prefixes should still keep them apart by eye — `B1` and
 * `BI` on two booths would be a daily annoyance at reception — but nothing
 * here can enforce that without refusing the name the booth already has.
 */
export const BOOTH_CODE_PREFIX_LENGTH = 2;
/** The part that has to be unguessable and unique. */
export const BOOTH_CODE_RANDOM_LENGTH = 8;
/** One check character, last, drawn from the same alphabet. See `boothCodeCheckCharacter`. */
export const BOOTH_CODE_CHECK_LENGTH = 1;
/** Eleven characters: prefix, random, check. Stored without a separator. */
export const BOOTH_CODE_LENGTH =
  BOOTH_CODE_PREFIX_LENGTH + BOOTH_CODE_RANDOM_LENGTH + BOOTH_CODE_CHECK_LENGTH;
/**
 * The ten-character shape every code had before the check character (the
 * length `docs/features/booth.md` specified). Still honoured at a till, looked
 * up as it is, because those slips are already printed.
 */
export const LEGACY_BOOTH_CODE_LENGTH = BOOTH_CODE_PREFIX_LENGTH + BOOTH_CODE_RANDOM_LENGTH;

/**
 * How many times a minting loop should re-draw before giving up, and the
 * arithmetic behind the number.
 *
 * The random part is 8 characters from 30, so there are 30^8 =
 * 656,100,000,000 draws per prefix, and the check character keeps about 30/37
 * of them (see `boothCodeCheckCharacter` — a draw whose check would land
 * outside the alphabet is drawn again), so N ≈ 5.3e11 codes per prefix, just
 * under 39 bits. Take the booth at 500 spins a day: 182,500 codes a year, and a
 * shade under 1.8 million after a decade. Then, with `n` codes already issued
 * under one prefix:
 *
 *   - a freshly drawn code collides with one of them with probability `n / N`.
 *     At n = 1.8 million that is 3.4e-6, about one in 290,000;
 *   - across that whole decade the expected number of collisions is
 *     `n² / 2N` ≈ **3**. So collisions are not hypothetical: over ten years
 *     this booth should expect to draw a code it has drawn before two or three
 *     times. That is why the unique index exists and why minting retries,
 *     rather than the usual "the space is so large it cannot happen";
 *   - the chance that five consecutive draws ALL collide, at that same n, is
 *     (n/N)^5 ≈ 4.8e-28. Five is therefore a bound that gives up on a bug —
 *     a prefix collision, a stuck random source — rather than on bad luck.
 *
 * A caller that exhausts these attempts must fail the mint loudly. It must not
 * widen the code, drop the prefix, or fall back to a timestamp: each of those
 * turns an unguessable code into a guessable one.
 */
export const BOOTH_CODE_MINT_ATTEMPTS = 5;

/** A source of integers in `[0, maxExclusive)`. See `mintBoothCode`. */
export type RandomIndex = (maxExclusive: number) => number;

// --- The check character (S2-10b) -------------------------------------------

/**
 * The check character is ISO/IEC 7064 MOD 37-2, exactly as the standard defines
 * it: a pure system with modulus 37 and radix 2 over the character set below,
 * with the standard's own target — a string is valid when its checksum is 1.
 * Any conforming implementation (python-stdnum's `iso7064.mod_37_2`, for one)
 * therefore validates exactly the codes a booth prints, and computes the same
 * check character for them. `packages/shared/test/booth-code.test.ts` pins that
 * against an independent copy of the standard's algorithm.
 *
 * The standard's set is `0`–`9` then `A`–`Z`, worth 0 to 35, and `*`, worth 36,
 * which only ever appears as a check character.
 *
 * Not the booth alphabet, and that is the point. The prefix is the park's own
 * label and is drawn from all thirty-six (`B1` has a `1` the alphabet drops), so
 * a check computed only over the thirty drawn characters could not see a
 * mistyped prefix at all. Valuing every character by its place in the full set
 * keeps every one of them distinct.
 */
const CHECK_SYMBOLS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*';

/** What a character before the check may be worth: 0–35. `*` (36) is a check character only. */
const VALUE_SYMBOLS = CHECK_SYMBOLS.slice(0, 36);

/** MOD 37-2: the modulus is the prime 37 … */
const CHECK_MODULUS = 37;
/** … the radix is 2 … */
const CHECK_RADIX = 2;
/** … and a valid string's checksum is 1 (ISO/IEC 7064, the pure systems' target). */
const CHECK_TARGET = 1;

/**
 * The standard's checksum of a string: `Σ value(c_i) × 2^(n−i) mod 37`, the
 * rightmost character carrying weight 1 — computed by the standard's own
 * recursion, `p = (p × 2 + value) mod 37`. Null when a character has no value.
 */
function mod37Checksum(chars: string, symbols: string): number | null {
  let p = 0;
  for (const char of chars) {
    const value = symbols.indexOf(char);
    if (value < 0) return null;
    p = (p * CHECK_RADIX + value) % CHECK_MODULUS;
  }
  return p;
}

/**
 * How many times `mintBoothCode` re-draws the random part before deciding the
 * random source is not random.
 *
 * About 7 draws in 37 have a check value with no symbol in the alphabet and are
 * drawn again, so a uniform source is refused this many times in a row with
 * probability (7/37)^64, about 1e-46. A source refused sixty-four times running
 * is a constant or a broken one, and printing whatever it gives would be worse
 * than refusing.
 */
export const BOOTH_CODE_CHECK_REDRAWS = 64;

/**
 * The check character for the ten characters before it — prefix and random —
 * or `null` when the check has no symbol in the booth alphabet.
 *
 * THE ALGORITHM is ISO/IEC 7064 MOD 37-2, and nothing of ours: the check
 * character is the one that brings the checksum of all eleven characters to 1
 * modulo 37, which is `(1 − 2 × checksum(body)) mod 37`. The weights are
 * `2^(10 − i) mod 37` for the character at index `i`, the check itself
 * carrying 1.
 *
 * WHAT IT CATCHES, and why — both follow from 37 being prime and 2 being a
 * primitive root modulo 37 (its order is 36, so the eleven weights are
 * distinct and none is zero):
 *
 *   - EVERY single-character error, in any of the eleven places, the prefix
 *     and the check itself included: a changed character moves the sum by
 *     `w × d` with `w` non-zero and `0 < |d| ≤ 36 < 37`, which is never 0
 *     modulo a prime.
 *   - EVERY transposition of two adjacent characters (and of two characters one
 *     apart): the sum moves by `(w_i − w_j) × d`, and no two weights are equal.
 *
 * The target (1 rather than 0) shifts which character is the check and changes
 * none of that: detection depends only on the differences between weights. A
 * brute-force run over 20,000 minted codes — every single substitution with any
 * of the 36 symbols and every adjacent swap — found no miss, and neither does
 * the algebra. The ISO 7064 hybrid system over thirty symbols (MOD 31,30) was
 * tried first and rejected: it misses 60 adjacent-transposition cases.
 *
 * WHY IT CAN BE `null`. The check value is one of 37, and only 30 of those
 * are symbols the booth prints — `0 1 I L O U` are the ambiguous characters the
 * alphabet exists to drop, and 36 is the standard's `*`. `mintBoothCode` draws
 * the random part again when that happens, so a printed check character is
 * always one a person can read off a slip without guessing, and every printed
 * code is still a valid MOD 37-2 string.
 */
export function boothCodeCheckCharacter(body: string): string | null {
  if (body.length !== BOOTH_CODE_PREFIX_LENGTH + BOOTH_CODE_RANDOM_LENGTH) return null;
  const sum = mod37Checksum(body, VALUE_SYMBOLS);
  if (sum === null) return null;
  const needed =
    (((CHECK_TARGET - CHECK_RADIX * sum) % CHECK_MODULUS) + CHECK_MODULUS) % CHECK_MODULUS;
  const symbol = CHECK_SYMBOLS[needed];
  return symbol !== undefined && BOOTH_CODE_ALPHABET.includes(symbol) ? symbol : null;
}

/** Two halves, two rules — see the note on `BOOTH_CODE_PREFIX_LENGTH`. */
const PREFIX_PATTERN = new RegExp(`^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}$`);
const CODE_PATTERN = new RegExp(
  `^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}[${BOOTH_CODE_ALPHABET}]{${BOOTH_CODE_RANDOM_LENGTH + BOOTH_CODE_CHECK_LENGTH}}$`,
);
const LEGACY_CODE_PATTERN = new RegExp(
  `^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}[${BOOTH_CODE_ALPHABET}]{${BOOTH_CODE_RANDOM_LENGTH}}$`,
);

export interface BoothCodeParts {
  /** The whole code, upper case, no separator — what goes in `promo.voucher.code`. */
  code: string;
  /** The booth that printed it. */
  prefix: string;
  /** The eight drawn characters. */
  random: string;
  /** The check character, or null on a code printed before there was one. */
  check: string | null;
}

/**
 * Draw one code. The randomness is the CALLER'S, and deliberately so.
 *
 * There is no default source and there will not be one. `Math.random` is a
 * recoverable PRNG — a handful of outputs pin its state — and this code is
 * money a family can walk to a counter with (D3). The box passes `randomInt`
 * from `node:crypto`; a test passes a counter. This module stays free of
 * `node:crypto` because `@oto/shared` is bundled into the browser, and a
 * Node-only import in the barrel breaks the POS build.
 *
 * `randomIndex` is called once per random character with the alphabet length,
 * and must return an integer in `[0, maxExclusive)` drawn uniformly — eight
 * times per draw, and eight more for a whole new draw when the check character
 * would fall outside the alphabet (`boothCodeCheckCharacter`). Re-drawing all
 * eight rather than only the last keeps every printable code equally likely.
 * `randomInt` rejects the biased tail of its range to manage uniformity; a
 * hand-rolled `byte % 30` does not, and quietly favours the first sixteen
 * characters of the alphabet. What this function checks is the RANGE — an index
 * it has no character for is a thrown error rather than a short code. The
 * distribution behind that index is a requirement on the caller and is not
 * checkable here.
 *
 * Callers own the unique-index retry loop, because only they can see the
 * violation that makes a retry necessary; `BOOTH_CODE_MINT_ATTEMPTS` is the
 * bound to use.
 *
 * @throws if the prefix is not two upper-case alphanumerics — a booth
 * configured with a prefix this function cannot print is a configuration
 * error, and printing a code of the wrong shape would be worse than refusing;
 * and if `BOOTH_CODE_CHECK_REDRAWS` draws in a row have no printable check
 * character, which a working random source does not do.
 */
export function mintBoothCode(prefix: string, randomIndex: RandomIndex): string {
  const normalised = prefix.toUpperCase();
  if (!PREFIX_PATTERN.test(normalised)) {
    throw new Error(
      `A booth code prefix is ${BOOTH_CODE_PREFIX_LENGTH} letters or digits; got ${JSON.stringify(prefix)}`,
    );
  }
  for (let draw = 0; draw < BOOTH_CODE_CHECK_REDRAWS; draw += 1) {
    let random = '';
    for (let i = 0; i < BOOTH_CODE_RANDOM_LENGTH; i += 1) {
      const index = randomIndex(BOOTH_CODE_ALPHABET.length);
      if (!Number.isInteger(index) || index < 0 || index >= BOOTH_CODE_ALPHABET.length) {
        throw new Error(
          `The random source returned ${String(index)}, which is not an index into a ${BOOTH_CODE_ALPHABET.length}-character alphabet`,
        );
      }
      random += BOOTH_CODE_ALPHABET[index];
    }
    const check = boothCodeCheckCharacter(`${normalised}${random}`);
    if (check !== null) return `${normalised}${random}${check}`;
  }
  throw new Error(
    `${BOOTH_CODE_CHECK_REDRAWS} draws in a row had no printable check character — the random source is not random`,
  );
}

/**
 * A code as somebody typed or scanned it, in the one form the table stores.
 *
 * Upper case, with spaces and dashes removed: `b1-rt7k mq4x w` and
 * `B1RT7KMQ4XW` are one code — the same rule `normaliseClaimCode` follows. A
 * scanner's trailing Enter or line feed is whitespace and goes with them.
 * Anything else stays, so a stray character makes an invalid code rather than a
 * different one.
 */
export function normaliseBoothCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

export type BoothCodeVerification =
  { ok: true; prefix: string } | { ok: false; reason: 'length' | 'alphabet' | 'check' };

/**
 * Whether a code is one a booth could have printed since the check character
 * existed — decided from the string alone, with no database.
 *
 *   - `length`   not eleven characters once normalised. A ten-character code
 *                answers `length` too: whether it is a LEGACY code is a
 *                separate question (`isLegacyBoothCode`), because the check
 *                does not apply to it.
 *   - `alphabet` a character the prefix or the booth alphabet does not allow
 *                where it stands — an `O` among the random characters, a `.`.
 *   - `check`    the right shape and the wrong check character: a mistyped or
 *                invented code. A till says "Invalid code" and never asks the
 *                database, so a mistake reads as a mistake rather than as "not
 *                synced yet".
 */
export function verifyBoothCode(raw: string): BoothCodeVerification {
  const code = normaliseBoothCode(raw);
  if (code.length !== BOOTH_CODE_LENGTH) return { ok: false, reason: 'length' };
  if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'alphabet' };
  // The standard's own validation: the checksum of all eleven characters is 1.
  // The pattern above has already kept the check character to the booth
  // alphabet, so a string a booth would never print cannot pass here either.
  if (mod37Checksum(code, CHECK_SYMBOLS) !== CHECK_TARGET) {
    return { ok: false, reason: 'check' };
  }
  return { ok: true, prefix: code.slice(0, BOOTH_CODE_PREFIX_LENGTH) };
}

/**
 * Whether a code has the ten-character shape every booth printed before the
 * check character: a prefix and eight characters of the alphabet. Such a code
 * carries no check, so the only test left for it is whether it exists.
 */
export function isLegacyBoothCode(raw: string): boolean {
  return LEGACY_CODE_PATTERN.test(normaliseBoothCode(raw));
}

/**
 * Read a code somebody typed or scanned.
 *
 * Returns the parts of a current code whose check character is right, or of a
 * legacy ten-character code (with `check: null`). Returns null for everything
 * else — a current-length code with a wrong check included, since that is a
 * mistyped code and not a booth's — and for the park's legacy SPIN codes: those
 * are four digits, or four characters beginning with a letter
 * (`docs/features/booth.md`), and they live in the same `promo.voucher` table.
 * A caller looking a code up at a till should not assume a null means "no such
 * voucher".
 */
export function parseBoothCode(raw: string): BoothCodeParts | null {
  const code = normaliseBoothCode(raw);
  const prefix = code.slice(0, BOOTH_CODE_PREFIX_LENGTH);
  if (verifyBoothCode(code).ok) {
    return {
      code,
      prefix,
      random: code.slice(
        BOOTH_CODE_PREFIX_LENGTH,
        BOOTH_CODE_PREFIX_LENGTH + BOOTH_CODE_RANDOM_LENGTH,
      ),
      check: code.slice(-BOOTH_CODE_CHECK_LENGTH),
    };
  }
  if (isLegacyBoothCode(code)) {
    return { code, prefix, random: code.slice(BOOTH_CODE_PREFIX_LENGTH), check: null };
  }
  return null;
}
