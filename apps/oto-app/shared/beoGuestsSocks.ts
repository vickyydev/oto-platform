/**
 * THE EXPECTED EXTRA GUESTS AND THE SOCKS ARRANGEMENT (SCRUM-1031).
 *
 * The operations brief (Event Info, "Expected Additional Guests" and "Socks — Payment
 * Arrangement"), as the owner kept it: information for reception only, on the BEO editor's
 * Event Info and in the Staff BEO's header. Never on the till: the platform's views read none
 * of these columns, nothing is charged, priced, counted or taken from stock from them.
 *
 *   - expected extra guests: how many children and adults the family expects beyond the
 *     planned counts ("Expected extra: +1 child, +6 adults"); reception adds the real ones
 *     to POS on arrival;
 *   - the socks arrangement: one of the brief's three options, or none chosen (left for a
 *     manager to decide); "Other / Custom" carries an optional short note.
 *
 * Stored on the party (core_events, app migration 0054), every one optional and empty on a
 * party saved before them. Empty prints nothing.
 */

/** The brief's three options, in its order. */
export const SOCKS_ARRANGEMENTS = ["birthday_parent", "guests", "other"] as const;
export type SocksArrangement = (typeof SOCKS_ARRANGEMENTS)[number];

/** Each option in the brief's own words. */
export const SOCKS_ARRANGEMENT_LABELS: Readonly<Record<SocksArrangement, string>> = {
  birthday_parent: "Birthday Parent Pays",
  guests: "Guests Pay Individually",
  other: "Other / Custom",
};

/** The editor's labels, in the operations brief's drawing's words. */
export const EXPECTED_EXTRA_LABEL = "Expected extra (add to POS on arrival)";
export const SOCKS_LABEL = "Socks (payment)";
export const SOCKS_HINT = "How socks will be charged (not linked to POS)";
/** The print's label for the arrangement, as the drawing's header box names it. */
export const SOCKS_PRINT_LABEL = "Socks arrangement";

/** The largest count and the longest note a Save may store. */
export const EXPECTED_EXTRA_MAX = 999;
export const SOCKS_NOTE_MAX = 200;

export const isSocksArrangement = (value: unknown): value is SocksArrangement =>
  typeof value === "string" && (SOCKS_ARRANGEMENTS as readonly string[]).includes(value);

/** The four stored fields as the party holds them. */
export interface BeoGuestsSocks {
  expectedExtraKids?: number | null;
  expectedExtraAdults?: number | null;
  socksArrangement?: string | null;
  socksNote?: string | null;
}

const countOf = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);

/**
 * The expected extra guests in the brief's words: "+1 child · +6 adults", "+2 children",
 * "+1 adult". Only a count above nought is said; none at all says nothing (null).
 */
export function expectedExtraWordsOf(stored: Pick<BeoGuestsSocks, "expectedExtraKids" | "expectedExtraAdults"> | null | undefined): string | null {
  const kids = countOf(stored?.expectedExtraKids);
  const adults = countOf(stored?.expectedExtraAdults);
  const words = [
    kids ? `+${kids} ${kids === 1 ? "child" : "children"}` : "",
    adults ? `+${adults} ${adults === 1 ? "adult" : "adults"}` : "",
  ].filter(Boolean);
  return words.length ? words.join(" · ") : null;
}

/**
 * The socks arrangement in the brief's words: "Birthday Parent Pays", "Guests Pay
 * Individually", "Other / Custom: <the note as written>". None chosen says nothing (null);
 * the note is read only with "Other / Custom", the option it belongs to.
 */
export function socksWordsOf(stored: Pick<BeoGuestsSocks, "socksArrangement" | "socksNote"> | null | undefined): string | null {
  const arrangement = stored?.socksArrangement;
  if (!isSocksArrangement(arrangement)) return null;
  const note = arrangement === "other" && typeof stored?.socksNote === "string" ? stored.socksNote.trim() : "";
  return note ? `${SOCKS_ARRANGEMENT_LABELS[arrangement]}: ${note}` : SOCKS_ARRANGEMENT_LABELS[arrangement];
}

/**
 * Why a BEO Save's four fields cannot be stored, in staff words; null when they can. Each is
 * checked only when the Save names it: a count is empty (null) or a whole number from 0 to
 * 999, the arrangement empty or one of the three options, the note empty or a short text.
 */
export function guestsSocksRefusal(body: Record<string, unknown> | null | undefined): string | null {
  if (!body) return null;
  for (const key of ["expectedExtraKids", "expectedExtraAdults"] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > EXPECTED_EXTRA_MAX) {
      return `The expected extra ${key === "expectedExtraKids" ? "children" : "adults"} must be a whole number from 0 to ${EXPECTED_EXTRA_MAX}, or empty.`;
    }
  }
  if ("socksArrangement" in body && body.socksArrangement !== null && !isSocksArrangement(body.socksArrangement)) {
    return `The socks arrangement must be one of: ${SOCKS_ARRANGEMENTS.map((a) => SOCKS_ARRANGEMENT_LABELS[a]).join(", ")}; or not set.`;
  }
  if ("socksNote" in body && body.socksNote !== null && (typeof body.socksNote !== "string" || body.socksNote.length > SOCKS_NOTE_MAX)) {
    return `The socks note must be a short text of at most ${SOCKS_NOTE_MAX} characters.`;
  }
  return null;
}
