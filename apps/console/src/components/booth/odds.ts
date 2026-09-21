/**
 * The wheel's arithmetic, kept away from anything that draws.
 *
 * This is the part of the Booths page that is worth getting right: a manager
 * editing a prize list is deciding what the park gives away, and the mistake
 * available to them is not a crash — it is a number that looks reasonable and
 * is wrong by a factor of ten. Everything below exists so the screen can say
 * the true thing rather than the typed thing.
 *
 * **Two numbers, and they are not the same number.**
 *
 *   - the WEIGHT somebody typed, in basis points (`weightBp`, 2350 = 23.5 %),
 *     which must sum to 10,000 across the active prizes before a version can
 *     be published (D4);
 *   - the CHANCE a child actually has, which is that weight renormalised over
 *     the prizes the box will really draw from — active, under their daily cap
 *     and in stock (D5). Switch one prize off and every other prize's chance
 *     goes up, immediately, without anybody typing a number.
 *
 * Showing only the first is how somebody switches off the 2.5 % grand prize,
 * sees five weights they did not touch, and does not notice that the ฿200
 * voucher just went from 14.5 % to 14.9 % — or, in the version of this that
 * costs real money, switches off four cheap prizes and quadruples the rate of
 * the expensive one.
 *
 * **Integers decide; floats only paint.** Every verdict below — does it add
 * up, by how much, what does it cost — is computed in integer basis points and
 * integer satang. The only floating point in this file is inside the two
 * `format*` helpers, which produce text for a human and are read by nothing.
 *
 * What this file does NOT model, said here because a screen that implies it
 * would be lying: daily caps and stock also renormalise the draw, and they do
 * it *during the day*, per press, on the box. The chances below are the
 * wheel's as the trading day starts.
 */

/** Basis points in a whole. The active weights must sum to exactly this. */
export const TOTAL_BP = 10_000;

/** The subset of a prize this file needs. Kept structural so tests need no ids. */
export interface Weighted {
  weightBp: number;
  active: boolean;
  /** What the park pays when this one is won, in satang. */
  costSatang: number;
}

/**
 * How the typed weights add up, in integers.
 *
 * `differenceBp` is signed and exact: positive means the list is over 10,000
 * by that many basis points, negative means under. It is reported in basis
 * points rather than as a percentage because that is the number the person has
 * to change, and "you are 50 over" is actionable where "you are 0.5 % over"
 * invites a second rounding error on the way to the keyboard.
 */
export interface WeightVerdict {
  /** Sum of `weightBp` over the ACTIVE prizes. Inactive ones are not drawn. */
  totalBp: number;
  /** `totalBp - 10000`. Zero is the only publishable value. */
  differenceBp: number;
  balanced: boolean;
  activeCount: number;
  /** Prizes that exist but are switched off, so the screen can say how many. */
  inactiveCount: number;
}

export function weightVerdict(prizes: readonly Weighted[]): WeightVerdict {
  const active = prizes.filter((p) => p.active);
  const totalBp = active.reduce((sum, p) => sum + p.weightBp, 0);
  return {
    totalBp,
    differenceBp: totalBp - TOTAL_BP,
    balanced: totalBp === TOTAL_BP,
    activeCount: active.length,
    inactiveCount: prizes.length - active.length,
  };
}

/**
 * The real chance of each prize, renormalised over what the box will draw from.
 *
 * Returned in basis points of the ACTIVE total, so a balanced list gives back
 * exactly the weights that were typed and an unbalanced one gives back what
 * would really happen if it were published as it stands. An inactive prize
 * gets zero — it is not on the wheel.
 *
 * Rounding is stated rather than hidden: each chance is rounded to the nearest
 * basis point for display, so a list of chances can add to 9,999 or 10,001
 * when the weights do not divide evenly. That is a rounding artefact in the
 * text, not a wheel that does not add up — which is why `weightVerdict` above,
 * and not the sum of these, is what decides whether a version may be published.
 */
export function chanceBpOf(prize: Weighted, verdict: WeightVerdict): number {
  if (!prize.active || verdict.totalBp <= 0) return 0;
  return Math.round((prize.weightBp * TOTAL_BP) / verdict.totalBp);
}

/**
 * What the wheel costs the park, per spin, in satang — the expected value of
 * one press across the prizes it can land on.
 *
 * Integer throughout: the weighted sum is computed in `satang × basis points`
 * and divided once, at the end. Nothing here divides twice, so nothing here
 * accumulates a rounding error per prize.
 *
 * Zero-cost prizes are counted as zero, which is a real answer for a giveaway
 * and a wrong one for a prize nobody has costed yet. `uncostedActive` below is
 * how the screen tells those two apart instead of quietly averaging them.
 */
export function expectedCostPerSpinSatang(prizes: readonly Weighted[]): number {
  const verdict = weightVerdict(prizes);
  if (verdict.totalBp <= 0) return 0;
  const weighted = prizes
    .filter((p) => p.active)
    .reduce((sum, p) => sum + p.weightBp * p.costSatang, 0);
  return Math.round(weighted / verdict.totalBp);
}

/**
 * The same figure over a number of spins — "what does this wheel cost me a
 * day", which is the question the owner asks.
 *
 * Multiplied before it is divided, so a hundred spins of a prize costing a
 * third of a satang is not a hundred roundings.
 */
export function expectedCostSatang(prizes: readonly Weighted[], spins: number): number {
  const verdict = weightVerdict(prizes);
  if (verdict.totalBp <= 0 || spins <= 0) return 0;
  const weighted = prizes
    .filter((p) => p.active)
    .reduce((sum, p) => sum + p.weightBp * p.costSatang, 0);
  return Math.round((weighted * spins) / verdict.totalBp);
}

/**
 * One prize's share of that daily cost — chance × cost, over the same spins.
 *
 * On the row beside the prize, because "the ฿200 voucher is 14.5 % of the
 * spins and 61 % of the money" is the sentence a prize list exists to make
 * visible, and no list of weights says it.
 */
export function prizeCostSatang(
  prize: Weighted,
  verdict: WeightVerdict,
  spins: number,
): number {
  if (!prize.active || verdict.totalBp <= 0 || spins <= 0) return 0;
  return Math.round((prize.weightBp * prize.costSatang * spins) / verdict.totalBp);
}

/** Active prizes with no cost against them: the figures above understate by these. */
export function uncostedActive(prizes: readonly Weighted[]): number {
  return prizes.filter((p) => p.active && p.costSatang === 0).length;
}

// ---------------------------------------------------------------------------
// Text for people. Nothing below is read by anything that decides.
// ---------------------------------------------------------------------------

/**
 * Basis points as a percentage: 2350 → "23.5%", 250 → "2.5%", 1000 → "10%".
 *
 * Up to two decimals and no trailing zeroes, because the launch list is halves
 * and "23.50%" reads as false precision on a screen where the next column is
 * money.
 */
export function formatBp(bp: number): string {
  const pct = bp / 100;
  return `${Number(pct.toFixed(2))}%`;
}

/**
 * The signed gap, in the words the person needs: "50 basis points over
 * (0.5%)". Empty string when it is balanced, so a caller can drop it.
 */
export function formatGap(differenceBp: number): string {
  if (differenceBp === 0) return '';
  const over = differenceBp > 0;
  const size = Math.abs(differenceBp);
  return `${size} basis point${size === 1 ? '' : 's'} ${over ? 'over' : 'short'} (${formatBp(size)})`;
}

// ---------------------------------------------------------------------------
// Typing. A person types "23.5"; the database stores 2350.
// ---------------------------------------------------------------------------

/**
 * A decimal somebody typed, as an exact integer of hundredths.
 *
 * Parsed from the DIGITS rather than through `Number`, which is the difference
 * between a rule that holds and one that holds for the launch list. `23.5`
 * survives a float; `0.07` does not — `Number('0.07') * 100` is
 * 7.000000000000001, and a list of those rounds to a total that is one basis
 * point out with no typed number to blame for it. Here the string "23.5" is
 * read as 23 and 50 and added as integers, so what is stored is what was
 * typed, every time.
 *
 * Returns null for anything that is not a plain positive decimal with at most
 * two places — including an empty field, which is a caller's "not set" rather
 * than a zero this function is entitled to invent.
 */
export function parseHundredths(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** "23.5" → 2350 basis points. Null when it is not a percentage 0–100. */
export function parsePercentToBp(text: string): number | null {
  const bp = parseHundredths(text);
  return bp === null || bp > TOTAL_BP ? null : bp;
}

/** "150" or "150.50" → satang. Null when it is not money. */
export function parseBahtToSatang(text: string): number | null {
  return parseHundredths(text);
}

/** The inverse, for putting a stored value back in a field: 2350 → "23.5". */
export function hundredthsToText(value: number): string {
  const whole = Math.trunc(value / 100);
  const fraction = Math.abs(value % 100);
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}
