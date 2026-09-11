/**
 * Centralized phone-number utilities — single source of truth for
 * normalization, parsing, and display formatting.
 *
 * International format (E.164-style): "+66818953926"
 * Stored value = full international string, no spaces.
 * Backward-compat: a digit-only local Thai string (0XXXXXXXXX or 0XXXXXXXX)
 * is treated as +66 so existing seeds and older stored values still match.
 */

import { COUNTRIES, type CountryOption, DEFAULT_COUNTRY } from '@/data/countries';

// ---------------------------------------------------------------------------
// Normalization — strips formatting, returns bare digit string including
// the country code (no leading +).  Used for equality comparisons only.
//
// "+66 81 895 3926" → "66818953926"
// "+66818953926"    → "66818953926"
// "0818953926"      → "66818953926"  (local Thai → +66)
// "0811111111"      → "66811111111"  (local Thai 10-digit)
//
// Exported and re-used by mockApi.ts and messagingUtils.tsx — do NOT define
// a local copy in those files.
// ---------------------------------------------------------------------------
export function normalizePhone(phone: string): string {
  if (!phone) return '';
  const trimmed = phone.trim();

  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    // International format — strip all non-digits (handles spaces, dashes, etc.)
    return trimmed.replace(/\D/g, '');
  }

  // Local Thai format: leading 0 is the national trunk prefix for +66
  const digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 10) {
    return '66' + digits.slice(1);
  }

  // Fallback — return whatever digits we have
  return digits;
}

// ---------------------------------------------------------------------------
// Parse a stored/input value into { country, nationalNumber } so the
// PhoneInput component can render the picker and number field.
// ---------------------------------------------------------------------------
export function parseInternationalPhone(value: string): {
  country: CountryOption;
  nationalNumber: string;
} {
  const fallback = { country: DEFAULT_COUNTRY, nationalNumber: '' };
  if (!value) return fallback;

  const trimmed = value.trim();

  if (trimmed.startsWith('+')) {
    const after = trimmed.slice(1).replace(/\D/g, '');
    // Try longer codes first to avoid +1 matching before +1868 (Trinidad)
    const sorted = [...COUNTRIES].sort((a, b) => b.dialCode.length - a.dialCode.length);
    for (const country of sorted) {
      if (after.startsWith(country.dialCode)) {
        return {
          country,
          nationalNumber: after.slice(country.dialCode.length),
        };
      }
    }
    // Unknown country code — keep raw digits
    return { country: DEFAULT_COUNTRY, nationalNumber: after };
  }

  // Local Thai format (0XXXXXXXXX)
  const digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 10) {
    return { country: DEFAULT_COUNTRY, nationalNumber: digits.slice(1) };
  }

  // Pure digits with no leading 0 — assume national number for default country
  return { country: DEFAULT_COUNTRY, nationalNumber: digits };
}

// ---------------------------------------------------------------------------
// Compose a full international string from country + national digits.
// Returns "" when nationalNumber is empty (no partial storage).
// ---------------------------------------------------------------------------
export function composePhone(country: CountryOption, nationalNumber: string): string {
  const digits = nationalNumber.replace(/\D/g, '');
  if (!digits) return '';
  return `+${country.dialCode}${digits}`;
}

// ---------------------------------------------------------------------------
// Human-readable display format for showing the composed number.
// "+66818953926" → "+66 81 895 3926" (Thai)
// Falls back to inserting a space every 3 digits after the code.
// ---------------------------------------------------------------------------
export function formatDisplayPhone(value: string): string {
  if (!value) return '';
  const { country, nationalNumber } = parseInternationalPhone(value);
  if (!nationalNumber) return `+${country.dialCode}`;
  // Simple group: up to 3-3-4 for Thailand; fallback for others
  const groups = nationalNumber.match(/.{1,4}/g) ?? [nationalNumber];
  return `+${country.dialCode} ${groups.join(' ')}`;
}
