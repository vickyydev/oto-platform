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
 * cart-totals.ts, business-date.ts, rounding.ts — is pure in the sense that
 * matters: every answer is a function of the arguments alone. Nothing in it
 * reads the clock, the HOST timezone, the host locale or a store, and the rules
 * below are absolute there.
 *
 * "No timezone" means no AMBIENT one. business-date.ts and dates.ts do resolve
 * a timezone — the BRANCH's, passed in as an argument — through
 * `Intl.DateTimeFormat`, which is what the environmental requirement at the
 * bottom of this comment is about. That is a zone the caller named, not one the
 * machine supplied, so two boxes handed the same arguments still agree.
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
 *     timezone is always an argument. (The prototype does all three — its six
 *     disagreeing day boundaries are listed, with their files and lines, in the
 *     comment at the top of business-date.ts.)
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
 * time-zone data, because `businessDate` resolves the branch timezone it is
 * GIVEN through `Intl.DateTimeFormat`. Nothing above is contradicted by that:
 * the zone is an argument, and the priced-amount path never constructs a
 * formatter at all — a test installs a hostile `Intl.DateTimeFormat` and prices
 * every fixture cart through it.
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
export const LEGACY_SATANG_ENGINE_VERSION = '2026.09.20-5';
export const PRICING_ENGINE_VERSION = '2026.10.06-1';

// Manual percentage discounts round to whole baht. Offline facts created by
// the previous engine retain its satang policy when replayed into the ledger.

/*
 * -5 (2026-09-20). THE FOUR RULINGS on the questions the engine was pinned
 * against (OPEN_QUESTIONS.md §3c). Three of them move money. Each says whether
 * it implements a rule this repository already held or a decision we took.
 *
 *   - RULING 1 — A FREE ITEM GOES ON AT ฿0 AND THE REST OF THE BILL IS
 *     UNTOUCHED. A CITED RULE, and the engine had a DEFECT against it. A
 *     free-item promo line now carries a taxable base of its own — the item's
 *     price, in the item's own category (`fnb` for a menu item, `merch` for
 *     merchandise) — so the offsetting discount lands on the thing that was
 *     given away instead of being apportioned onto whatever other bases exist.
 *     WE-8's guest pays 213000 rather than 208000: the ฿50 cone was coming off
 *     the TICKETS base as well as off the shelf, so the park gave it away twice
 *     and booked one markdown. Cited to POS_BACKEND_LOGIC §6.2, R-29,
 *     AGENCY_PROPOSAL week 20, SPRINT_2_PLAN, and to the prototype's own
 *     invariant at `lib/sale.ts:122-124`, which its code violated.
 *     (cart-totals.ts `cartUnits`, `promoItemTaxCategory`.)
 *
 *   - RULING 2 — A SCOPED DISCOUNT MAY ONLY SPEND WHAT ITS OWN SCOPE HAS LEFT.
 *     A DECISION, not a found rule; the reasoning is recorded in
 *     `computeTicketCartTotals`. A scoped promo's base now comes from a ledger
 *     of what each unit of the cart has left rather than from the undiscounted
 *     breakdown clamped by the order balance. SOME GUESTS PAY MORE: EC-15 moves
 *     from 0 to 100000 (a comped line no longer lets a ticket-scoped code carry
 *     ฿1,000 of lockers out free) and EC-17 from 0 to 30000. A code that finds
 *     its scope already spent now says so on `AppliedPromo.exhaustedReason`,
 *     in the promo vocabulary's own wording.
 *     THIS IS THE AMOUNT LINE, NOT THE ATTRIBUTION LINE — the attribution
 *     change of -3 is untouched, and both are documented side by side in
 *     cart-totals.ts so the next reader does not mistake one for the other.
 *
 *   - RULING 3 — A SALE IS PRICED BY THE BUSINESS DATE. A DECISION.
 *     `rateModeToday` resolves the rate mode from `businessDate` rather than
 *     `branchToday`, and takes the branch's `business_day_start`. A cart rung
 *     up at 00:30 on Saturday while Friday's session is still open is charged
 *     Friday's prices. No guest sale falls in the window where the two rules
 *     disagree — the park trades 10:00–20:00 and the day starts at 05:00.
 *
 *   - RULING 4 — A PROMO CODE IS VALIDATED AGAINST THE BUSINESS DATE. A
 *     DECISION, and it also corrects a plain bug: the prototype compares
 *     against the UTC date (`pages/Till.tsx:560`) while pricing the same cart
 *     from local midnight — one engine, two day boundaries, seven hours apart.
 *     Measured, the UTC date is a day behind the business date between 05:00
 *     and 06:59 local, so a code valid FROM Friday was refused at 06:00 on
 *     Friday and a code valid UNTIL Friday was still accepted at 06:00 on
 *     Saturday. `promoValidityDate` is the one right answer to pass.
 *     No fixture's money moves; TD-* pin the boundaries.
 *
 * -4 (2026-09-20). One change of behaviour, and it is a refusal rather than a
 * new number:
 *   - `computeManualDiscount` throws when two manual discounts share an id
 *     instead of letting the last one overwrite the first in `amounts`
 *     (discount.ts). Under -3 the cart still counted both in its total while
 *     the tax cascade received one of them twice and the other not at all: on
 *     the 109000 cart of fixture MD-2, with a 30000 discount on the kids and a
 *     5000 on the socks both carrying id 'dup', the cart reported 35000 of
 *     discount, the cascade placed 10000, and the guest was charged 99000
 *     instead of 74000 with `unappliedDiscount` reporting 0. MD-1 pins the
 *     refusal and MD-2 the same cart with distinct ids.
 *
 * `ManualDiscount` also gained the fields its own docstring and S2-09a both
 * promised — `reason` (required), `note`, `targetLabel` — and a
 * `ManualDiscountRecord` for what the sale record stores. No priced amount
 * moves: the engine reads none of them.
 *
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
