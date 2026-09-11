import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone conventions (CLAUDE.md §3): normalised to E.164 on write, default
 * region TH. Behaviour must match the prototype's `lib/phoneUtils.ts`:
 *   "+66 81 895 3926" → +66818953926
 *   "0818953926"      → +66818953926   (local Thai trunk prefix)
 *   "0066818953926"   → +66818953926   (00 international prefix)
 * Uniqueness constraints compare the normalised value.
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  let trimmed = input.trim();
  if (!trimmed) return null;
  // Prototype rule (phoneUtils.ts:29): a leading "00" is the international
  // prefix — Thailand's own IDD prefixes differ, so map it to "+" explicitly.
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
