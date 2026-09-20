/**
 * The selling engine's identity and its portability contract.
 *
 * WHY THIS LIVES IN `packages/shared`
 * A sale can be priced on a branch box (a Raspberry Pi, offline, its own clock)
 * or in the cloud, and the two must agree to the satang — a receipt printed at
 * the till and the same sale re-derived by a report days later have to add up.
 *
 * WHAT IS ACTUALLY PURE, AND WHERE THE CLOCK GETS IN
 * The priced-amount core — pricing.ts, tax.ts, discount.ts, promo.ts,
 * cart-totals.ts, business-date.ts, rounding.ts — is pure: nothing in it reads
 * a clock, a timezone, a locale or a store, and the rules below are absolute
 * there.
 *
 * Two functions sit OUTSIDE that core and read the clock by default:
 * `branchToday(timeZone, now = new Date())` in dates.ts and
 * `rateModeToday(timeZone, holidays, now = new Date())` in pricing-mode.ts.
 * They are the engine's only clock seam, and an earlier version of this comment
 * hid that by listing the pure modules and leaving these two off the list. A
 * contract that holds by omitting its counter-examples is not a contract.
 *
 * `rateModeToday` decides which of two prices a guest pays, so the consequence
 * is concrete. ON A BOX WHOSE CLOCK HAS DRIFTED, a caller who omits `now` gets
 * the rate mode of whatever day that box believes it is: drift across midnight
 * into a Saturday and every ticket sold until the clock is corrected is charged
 * the WEEKEND price, with nothing in the sale to show it was wrong. Nothing
 * self-corrects later either, because the mode is snapshotted onto the line at
 * the moment it is added. The cloud re-deriving that sale from its stored
 * `pricing_mode` will agree with the box and be wrong with it.
 *
 * So the platform rule is: ANYTHING THAT PRICES MONEY PASSES THE INSTANT. The
 * caller owns one clock read — on the box, the same read that stamps
 * `occurred_at` and sets `clock_trust` (SPRINT_2_PLAN.md "Money and time") —
 * and hands the instant to both. The defaults exist for a convenience caller
 * (an admin screen asking what mode today is in), not for a till.
 *
 * Inside the pure core the following are FORBIDDEN:
 *
 *   - Reading the clock. No `new Date()`, no `Date.now()`. The instant is always
 *     an argument. A function that reads the clock cannot be tested at midnight,
 *     and a box whose clock drifted would price differently from the cloud.
 *     (The two seam functions above are the named exceptions; nothing else may
 *     join them, and neither of them may be called from inside the core.)
 *   - Reading the host timezone. No `getFullYear`/`getDay`/`getHours` on a local
 *     Date, no `toISOString().slice(0,10)` standing in for "today". The branch
 *     timezone is always an argument. (The prototype does all three — see the
 *     six disagreeing day boundaries recorded in the S2-09a specification.)
 *   - Reading the host locale. No `toLocaleString()`/`toLocaleDateString()`
 *     without an explicit locale tag; a box in a th-TH environment must not
 *     produce a different string from the cloud.
 *   - Reading a store, a database, the filesystem, the network or an env var.
 *     Catalogue data (prices, the socks add-on, the tax config, holiday ranges)
 *     is passed in.
 *   - Floating-point money. Every amount in and out is an integer in satang.
 *     Fractions arise only inside a single expression and are rounded once,
 *     deliberately (see rounding.ts).
 *   - `Math.random()` or any other non-deterministic source.
 *
 * THE ONE ENVIRONMENTAL REQUIREMENT that remains is an ICU build carrying IANA
 * time-zone data, because `businessDate` resolves a branch timezone through
 * `Intl.DateTimeFormat`.
 *
 * An earlier version of this comment said a small-icu build "would silently
 * resolve every zone to UTC". That is wrong, and documenting the wrong
 * dependency is worse than documenting none: SMALL-ICU SHIPS THE FULL IANA
 * TIME-ZONE DATABASE — what it trims is LOCALE data, down to English only. So
 * `Asia/Bangkok` resolves correctly on a small-icu box; what breaks there is a
 * format that leans on a locale, which is why dates.ts and business-date.ts now
 * read `formatToParts` with every field pinned and name no locale they need.
 * Full ICU is still what the box image should ship (a Thai-language receipt
 * needs `th` locale data), but the engine's numbers no longer depend on it.
 */

/**
 * Stamped onto every sale that this engine priced, so a later change is
 * traceable rather than silently retroactive: a report that re-derives an old
 * sale can see it was priced by an older engine and refuse to compare it with
 * today's rules.
 *
 * BUMP IT when a change can make the engine return a different number for the
 * same inputs — a rule, a rounding step, an ordering, a new clamp. Do NOT bump
 * it for refactors, comments, new exports, or a new optional field that no
 * existing caller reads. When in doubt, bump: a spurious version is a harmless
 * extra row in a report, a missing one is a receipt nobody can explain.
 *
 * Format is `YYYY.MM.DD-n`, n counting same-day bumps.
 */
export const PRICING_ENGINE_VERSION = '2026.09.20-3';

/*
 * -3 (2026-09-20). One change, and it moves money on carts -2 got wrong:
 *   - a discount's per-category attribution is computed against the bases that
 *     REMAIN after the earlier discounts, not against the undiscounted
 *     breakdown, and the part a scope can no longer absorb returns to being an
 *     order-wide allocation rather than being dropped (cart-totals.ts
 *     `allocateAgainstRemaining`). Under -2 two discounts whose scopes overlap
 *     in one category both claimed the same base, the cascade clamped the
 *     second and discarded the surplus, and the guest was charged for items the
 *     prototype gives away — 3.6 % of mixed carts in a 20,000-cart differential
 *     run, every divergence against the guest, worst ฿871. Fixtures EC-15 and
 *     EC-17 pin it.
 *   - `computeTaxBreakdown` now groups its own inputs by category, because that
 *     attribution step needs one row per category and only `ticketCartTaxInputs`
 *     was grouping (fixture TX-ATTR-7).
 *
 * Bumped even though -2 never left the working tree and stamped no sale: the
 * rule above says bump when in doubt, and the -2 entry below describes an
 * attribution rule that is no longer the one the engine implements.
 *
 * -2 (2026-09-20). Four changes, each of which can move a number:
 *   - a free_item promo's value is resolved to the item's shelf price, so the
 *     offsetting discount exists at all (promo.ts `applyFreeItemPromo`);
 *   - prepaid food is priced into the line total, which the tax engine was
 *     already charging (pricing.ts `priceCartLine`);
 *   - a before-tax discount is attributed to the category it targeted instead
 *     of spread across all of them (tax.ts `computeTaxBreakdown`);
 *   - a cart whose stored line totals were not priced under the given context
 *     is refused rather than totalled (cart-totals.ts `findStaleLines`).
 */
