/**
 * The Lucky Wheel's draw (S2-07a, D5).
 *
 * Its own module, and it imports nothing but types, so the draw can be tested
 * with nothing around it: no store, no clock, no printer — prizes and a source
 * of numbers in, a slice out. The draw is the single piece of this ticket
 * whose wrongness would be invisible — a thumb on the scale does not throw,
 * does not log, and is only discovered by counting several hundred spins — so
 * it is the piece that most deserves a test that costs nothing to run.
 *
 * **Three rules, and each is a defect this code is written against.**
 *
 *  1. **Eligibility is renormalised, not zeroed.** The draw happens over the
 *     prizes that are active AND under their daily cap AND in stock, with the
 *     weights renormalised across exactly that set, computed ONCE per press.
 *     A prize that has hit its cap stops being given away; it does not stop
 *     the wheel and it does not quietly inflate nothing.
 *  2. **Nothing eligible refuses the press.** Drawing from an empty set would
 *     either throw somewhere less obvious or hand out a prize that is not
 *     there. `drawPrize` returns a refusal the caller has to read, which
 *     becomes "Booth not ready — please call staff" on the television.
 *  3. **The weighted pick tests BEFORE it subtracts.** This is not a style
 *     preference. The outgoing game's `pickWeightedPrize` subtracts first and
 *     then tests `roll <= 0`, which lets a ZERO-weight prize win on a
 *     boundary. That was harmless while every slice had a real probability and
 *     becomes a prize-giving bug the moment "inactive" and "capped out" are
 *     modelled as weight zero — which is exactly what this module does. D21.
 *     `apps/booth`'s fake makes the same choice for the same reason; the two
 *     are independent implementations of one rule, not a shared one.
 *
 * **The randomness is the caller's** (D3). There is no default source and
 * there will not be one, for the reason `mintBoothCode` gives: `Math.random`
 * is a recoverable PRNG and this draw is money a family can walk to a counter
 * with. The box passes `randomInt` from `node:crypto`; a test passes a counter
 * or a seeded PRNG. What this module checks is the RANGE of what comes back —
 * an index outside the total is a thrown error rather than a silently wrong
 * prize. The DISTRIBUTION behind that index is a requirement on the caller and
 * cannot be checked from here.
 */

import type { BoothConfigPrize } from '@oto/shared';

/** A source of integers in `[0, maxExclusive)`, drawn uniformly. See above. */
export type RandomIndex = (maxExclusive: number) => number;

/**
 * Why a prize was not in the draw.
 *
 * Kept per prize rather than collapsed into a count because the booth report
 * and the `#debug` overlay both want to say WHICH prize ran out and why — "the
 * 200 baht voucher hit its cap at eleven" is the sentence somebody asks for,
 * and "five prizes were ineligible" is not.
 */
export type IneligibleReason =
  /** `active` is false on the published prize. An administrator turned it off. */
  | 'inactive'
  /** This booth has already given away `dailyCap` of it today. */
  | 'capped'
  /** An inventory-linked prize at zero. See `inStock` below. */
  | 'out_of_stock'
  /**
   * Active, uncapped, in stock — and weighted zero, so it can never be drawn.
   *
   * Separated from `inactive` because they are different mistakes: one is a
   * decision somebody made on the Console, the other is almost always a
   * publish whose weights do not add up the way its author believed.
   */
  | 'zero_weight';

export interface PrizeEligibility {
  prize: BoothConfigPrize;
  /** Index into the bundle's `prizes`, in slice order. Survives the filter. */
  index: number;
  eligible: boolean;
  reason: IneligibleReason | null;
  /** How many of this prize this booth has given away today. */
  used: number;
}

export interface EligibilityOptions {
  /**
   * How many of each prize this booth has already given away today, by
   * `booth_prize.id`. One read before the draw rather than one read per prize
   * — eligibility is computed once per press, and a prize list that changed
   * between two of those reads would renormalise over a set that never
   * existed.
   *
   * A prize absent from the map has been given away zero times.
   */
  counters?: Readonly<Record<string, number>>;
  /**
   * Whether an inventory-linked prize still has stock.
   *
   * **Nothing supplies this yet, and the default is deliberately permissive.**
   * `BoothConfigPrize` carries no stock level and no `stockItemId` — the
   * published bundle is what the wheel needs to draw and to name a prize, and
   * the stock path arrives in S2-15a. So the third clause of D5 is implemented
   * as a seam rather than as behaviour: pass a predicate and it is honoured,
   * pass nothing and every prize counts as in stock. That is a real gap, not a
   * neutral default — a prize whose stock ran out this morning stays on the
   * wheel until something fills this in.
   */
  inStock?: (prize: BoothConfigPrize) => boolean;
}

/**
 * Judge every prize once, keeping the ones that can be won and saying why the
 * rest cannot.
 *
 * Order is the bundle's slice order throughout, and `index` is carried on each
 * entry rather than recovered later with `findIndex`: `SpinResponse.prizeIndex`
 * indexes the published array, and a lookup by identity after a filter is one
 * of the two ways that number goes wrong.
 */
export function judgePrizes(
  prizes: readonly BoothConfigPrize[],
  options: EligibilityOptions = {},
): PrizeEligibility[] {
  const counters = options.counters ?? {};
  const inStock = options.inStock;
  return prizes.map((prize, index) => {
    const used = counters[prize.id] ?? 0;
    let reason: IneligibleReason | null = null;
    if (!prize.active) reason = 'inactive';
    else if (prize.dailyCap !== null && used >= prize.dailyCap) reason = 'capped';
    else if (inStock && !inStock(prize)) reason = 'out_of_stock';
    else if (prize.weightBp <= 0) reason = 'zero_weight';
    return { prize, index, eligible: reason === null, reason, used };
  });
}

/** `booth_prize.id` of every prize that has hit its cap on this booth today. */
export function cappedPrizeIds(judged: readonly PrizeEligibility[]): string[] {
  return judged.filter((entry) => entry.reason === 'capped').map((entry) => entry.prize.id);
}

export type DrawRefusal =
  /** The published wheel has no slices at all. A publish that should not exist. */
  | 'no_prizes'
  /** Every slice is inactive, capped, out of stock or weighted zero (D5). */
  | 'none_eligible';

export type DrawOutcome =
  | {
      ok: true;
      prize: BoothConfigPrize;
      /** Index into the PUBLISHED array, in slice order — what the page animates to. */
      index: number;
      /** What the draw was over, so a caller can report the odds it actually used. */
      judged: PrizeEligibility[];
      /** Sum of the eligible weights, in basis points. The denominator. */
      totalBp: number;
      /** The value drawn from `[0, totalBp)`. Carried for the debug overlay. */
      roll: number;
    }
  | { ok: false; refusal: DrawRefusal; judged: PrizeEligibility[] };

/**
 * One press, one draw.
 *
 * `randomIndex` is called exactly once, with the RENORMALISED total rather
 * than with 10,000 — which is what makes this a draw over the eligible set
 * instead of a draw over the whole wheel with re-rolls. Re-rolling would be
 * the other obvious implementation and it is subtly worse: with one prize left
 * under its cap it loops, and the number of iterations depends on how much of
 * the wheel has been given away.
 */
export function drawPrize(
  prizes: readonly BoothConfigPrize[],
  randomIndex: RandomIndex,
  options: EligibilityOptions = {},
): DrawOutcome {
  const judged = judgePrizes(prizes, options);
  if (prizes.length === 0) return { ok: false, refusal: 'no_prizes', judged };

  const eligible = judged.filter((entry) => entry.eligible);
  const totalBp = eligible.reduce((sum, entry) => sum + entry.prize.weightBp, 0);
  // `totalBp` cannot be zero while `eligible` is non-empty — `zero_weight`
  // takes those out above — but it is tested anyway, because the alternative
  // if that ever stops holding is `randomIndex(0)`, and a source asked for an
  // integer below zero has no correct answer to give.
  if (eligible.length === 0 || totalBp <= 0) {
    return { ok: false, refusal: 'none_eligible', judged };
  }

  const roll = randomIndex(totalBp);
  if (!Number.isInteger(roll) || roll < 0 || roll >= totalBp) {
    throw new Error(
      `The booth's random source returned ${String(roll)}, which is not an index into ${totalBp} basis points of eligible weight`,
    );
  }

  let remaining = roll;
  for (const entry of eligible) {
    // Tested BEFORE the subtraction. See rule 3 at the top of this file.
    if (remaining < entry.prize.weightBp) {
      return { ok: true, prize: entry.prize, index: entry.index, judged, totalBp, roll };
    }
    remaining -= entry.prize.weightBp;
  }

  // Unreachable: `roll` starts below `totalBp`, and `totalBp` is the sum of
  // these same weights, so the remainder is below the last candidate's weight
  // by the time the loop reaches it. It is a thrown error rather than a
  // non-null assertion so that a future edit which breaks the invariant fails
  // loudly instead of handing back the wrong slice.
  throw new Error('The booth draw fell through a total it was drawn from');
}
