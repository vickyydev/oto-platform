import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone conventions (CLAUDE.md §3): normalised to E.164 on write, default
 * region TH. Uniqueness constraints compare the normalised value.
 *
 *   "+66 81 895 3926" → +66818953926
 *   "0818953926"      → +66818953926   (local Thai trunk prefix)
 *   "0066818953926"   → +66818953926   (leading 00 read as the international
 *                                       access code — SEE BELOW, this one is
 *                                       NOT what the prototype does)
 *
 * WHERE THIS AGREES WITH THE PROTOTYPE AND WHERE IT DOES NOT. The prototype's
 * `normalizePhone` (lib/phoneUtils.ts:26-43) returns BARE DIGITS for comparison
 * ("66818953926"), not E.164; this returns the stored E.164 form and
 * `phoneDigits` below produces the prototype's comparison form from it. On the
 * first two lines the two agree number-for-number. On the third they do not:
 * the prototype treats a leading "00" as "already international" and then just
 * strips non-digits, so "0066818953926" stays "0066818953926" — a thirteen-digit
 * key that matches no member and, at a till, quietly creates a second member
 * record for someone who already exists. An earlier version of this comment
 * claimed the prototype produced +66818953926 here and called the behaviour a
 * "prototype rule". It is not one; it is ours, and it is deliberate: 00 is the
 * ITU international access code a visitor's own handset and contact list use,
 * so reading it as "+" is what finds the member.
 *
 * NOT A FREE CHANGE EITHER WAY. This shipped in Sprint 1 and member rows exist
 * against it, so the normalisation cannot be revisited without deciding what
 * happens to numbers already stored. (Thailand's own outbound IDD prefixes are
 * 001/007/008/009 rather than a bare 00, so "001..." typed here becomes a "+1"
 * number and is rejected as impossible rather than mis-stored — recorded as the
 * known edge of this rule.)
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  let trimmed = input.trim();
  if (!trimmed) return null;
  // A leading "00" is the international access code, so map it to "+". The
  // prototype instead keeps the digits as typed (phoneUtils.ts:29-32); see the
  // note above for why this diverges and what it costs not to.
  if (/^00\d/.test(trimmed)) trimmed = `+${trimmed.slice(2)}`;
  const parsed = parsePhoneNumberFromString(trimmed, 'TH');
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number; // E.164, e.g. +66818953926
}

/** Digits-only key (no +) — the prototype's comparison form. */
export function phoneDigits(e164: string): string {
  return e164.replace(/\D/g, '');
}

/**
 * Human-readable display, matching the prototype's grouping fallback:
 * "+66818953926" → "+66 81 895 3926" (national format via libphonenumber
 * where known, prototype-style 4-digit grouping otherwise).
 */
export function formatDisplayPhone(e164: string): string {
  if (!e164) return '';
  const parsed = parsePhoneNumberFromString(e164);
  if (parsed) return parsed.formatInternational();
  return e164;
}

/** True when two raw inputs refer to the same normalised number. */
export function samePhone(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na !== null && na === nb;
}
