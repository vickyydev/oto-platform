/**
 * The voucher code a booth prints (S2-07a, D8).
 *
 * Two characters of booth prefix and eight random characters, ten in all:
 * `B1RT7KMQ4X`. It is minted on the box, inside the transaction that records
 * the spin, so a booth with no internet still prints a code the park will
 * honour — which is the whole reason the code is random rather than a counter.
 *
 * Nothing here talks to a database. Uniqueness is the unique index on
 * `promo.voucher (operator_id, code)`; this file only produces and reads the
 * string. See `mintBoothCode` for what that division of labour requires of a
 * caller.
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
/** Ten characters, as `docs/features/booth.md` specifies. Stored without a separator. */
export const BOOTH_CODE_LENGTH = BOOTH_CODE_PREFIX_LENGTH + BOOTH_CODE_RANDOM_LENGTH;

/**
 * How many times a minting loop should re-draw before giving up, and the
 * arithmetic behind the number.
 *
 * The random part is 8 characters from 30, so there are 30^8 =
 * 656,100,000,000 of them per prefix — about 39.3 bits. Take the booth at 500
 * spins a day: 182,500 codes a year, and a shade under 1.8 million after a
 * decade. Then, with `n` codes already issued under one prefix:
 *
 *   - a freshly drawn code collides with one of them with probability `n / N`.
 *     At n = 1.8 million that is 2.8e-6, about one in 360,000;
 *   - across that whole decade the expected number of collisions is
 *     `n² / 2N` ≈ **2.5**. So collisions are not hypothetical: over ten years
 *     this booth should expect to draw a code it has drawn before two or three
 *     times. That is why the unique index exists and why minting retries,
 *     rather than the usual "the space is so large it cannot happen";
 *   - the chance that five consecutive draws ALL collide, at that same n, is
 *     (n/N)^5 ≈ 1.7e-28. Five is therefore a bound that gives up on a bug —
 *     a prefix collision, a stuck random source — rather than on bad luck.
 *
 * A caller that exhausts these attempts must fail the mint loudly. It must not
 * widen the code, drop the prefix, or fall back to a timestamp: each of those
 * turns an unguessable code into a guessable one.
 */
export const BOOTH_CODE_MINT_ATTEMPTS = 5;

/** A source of integers in `[0, maxExclusive)`. See `mintBoothCode`. */
export type RandomIndex = (maxExclusive: number) => number;

/** Two halves, two rules — see the note on `BOOTH_CODE_PREFIX_LENGTH`. */
const PREFIX_PATTERN = new RegExp(`^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}$`);
const CODE_PATTERN = new RegExp(
  `^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}[${BOOTH_CODE_ALPHABET}]{${BOOTH_CODE_RANDOM_LENGTH}}$`,
);

export interface BoothCodeParts {
  /** The whole code, upper case, no separator — what goes in `promo.voucher.code`. */
  code: string;
  /** The booth that printed it. */
  prefix: string;
  /** The eight drawn characters. */
  random: string;
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
 * `randomIndex` is called once per character with the alphabet length, and
 * must return an integer in `[0, maxExclusive)` drawn uniformly. `randomInt`
 * rejects the biased tail of its range to manage that; a hand-rolled
 * `byte % 30` does not, and quietly favours the first sixteen characters of
 * the alphabet. What this function checks is the RANGE — an index it has no
 * character for is a thrown error rather than a short code. The distribution
 * behind that index is a requirement on the caller and is not checkable here.
 *
 * Callers own the retry loop, because only they can see the unique-index
 * violation that makes a retry necessary; `BOOTH_CODE_MINT_ATTEMPTS` is the
 * bound to use.
 *
 * @throws if the prefix is not two upper-case alphanumerics — a booth
 * configured with a prefix this function cannot print is a configuration
 * error, and printing a code of the wrong shape would be worse than refusing.
 */
export function mintBoothCode(prefix: string, randomIndex: RandomIndex): string {
  const normalised = prefix.toUpperCase();
  if (!PREFIX_PATTERN.test(normalised)) {
    throw new Error(
      `A booth code prefix is ${BOOTH_CODE_PREFIX_LENGTH} letters or digits; got ${JSON.stringify(prefix)}`,
    );
  }
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
  return `${normalised}${random}`;
}

/**
 * Read a code somebody typed or scanned.
 *
 * Spaces, dashes and case are how it was written down, not part of the code —
 * the same rule `normaliseClaimCode` follows — so `b1-rt7k mq4x` and
 * `B1RT7KMQ4X` are one code. A QR carries the canonical form.
 *
 * Returns null for anything that is not a booth code, INCLUDING the park's
 * legacy spin codes: those are four digits, or four characters beginning with
 * a letter (`docs/features/booth.md`), and they live in the same
 * `promo.voucher` table. A caller looking a code up at a till should try this
 * first and fall through to the legacy shape, not assume a null means "no such
 * voucher".
 */
export function parseBoothCode(raw: string): BoothCodeParts | null {
  const code = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!CODE_PATTERN.test(code)) return null;
  return {
    code,
    prefix: code.slice(0, BOOTH_CODE_PREFIX_LENGTH),
    random: code.slice(BOOTH_CODE_PREFIX_LENGTH),
  };
}
