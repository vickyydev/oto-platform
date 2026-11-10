/**
 * AI FILL'S FREE-TEXT PREVIEW ("Review & Confirm") — the cake and Party
 * Details as it shows and loads them (SCRUM-787). Pure, so the app's check
 * holds it.
 *
 * The model answered a cake type even when the message never said who brings
 * the cake (a time and "a cake" only), and Load into Editor applied that
 * guess. Now the answer may say NOT_SAID (or give no type): the preview
 * always shows the cake type line when the message gives a cake time, marked
 * "not said" when so, and Load into Editor applies the cake's time and notes
 * while the form's cake type stays as it was (the owner's rule on an unknown
 * type is open; leaving it as it was is the default). A Party Details box
 * with nothing in it is not shown.
 */

export type AiFillCakeMode = "INTERNAL" | "EXTERNAL" | "NONE" | "NOT_SAID";

/** The cake types the BEO knows, as the review in edit mode names them. */
export const AI_FILL_CAKE_TYPE: Record<Exclude<AiFillCakeMode, "NOT_SAID">, string> = {
  INTERNAL: "The park's cake",
  EXTERNAL: "The family's own cake",
  NONE: "No cake",
};

interface KitchenPlanFill {
  cakeMode?: string | null;
  cakeNotes?: string | null;
  cakeTime?: string | null;
  cakeIncluded?: boolean | null;
  cakePrice?: number | null;
  cakeQuantity?: number | null;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const saidMode = (v: unknown): "INTERNAL" | "EXTERNAL" | "NONE" | null =>
  v === "INTERNAL" || v === "EXTERNAL" || v === "NONE" ? v : null;

/** The preview's cake line; null when the fill names no cake at all. */
export interface AiFillCakeLine {
  /** "The park's cake", ...; null when the message does not say who brings it. */
  type: string | null;
  notSaid: boolean;
  notes: string | null;
  time: string | null;
}

export function aiFillCakeLine(kitchenPlan: KitchenPlanFill | null | undefined): AiFillCakeLine | null {
  if (!kitchenPlan) return null;
  const mode = saidMode(kitchenPlan.cakeMode);
  const notes = text(kitchenPlan.cakeNotes);
  const time = text(kitchenPlan.cakeTime);
  // "No cake" with nothing else is no line, as the preview has always shown it.
  if (mode === "NONE" && !notes && !time) return null;
  if (!mode && !notes && !time) return null;
  return { type: mode ? AI_FILL_CAKE_TYPE[mode] : null, notSaid: !mode, notes, time };
}

/**
 * What Load into Editor sets of the cake: the time and notes the message
 * gives; the type (and its price, quantity and whether it is included) only
 * when the message says the park's or the family's cake. "No cake" and a
 * type not said leave the form's as they were.
 */
export function aiFillCakeApply(kitchenPlan: KitchenPlanFill | null | undefined): {
  mode?: "INTERNAL" | "EXTERNAL";
  notes?: string;
  time?: string;
  included?: boolean;
  price?: number;
  quantity?: number;
} {
  if (!kitchenPlan) return {};
  const mode = saidMode(kitchenPlan.cakeMode);
  if (mode === "NONE") return {};
  const out: ReturnType<typeof aiFillCakeApply> = {};
  const notes = text(kitchenPlan.cakeNotes);
  const time = text(kitchenPlan.cakeTime);
  if (notes) out.notes = notes;
  if (time) out.time = time;
  if (mode) {
    out.mode = mode;
    out.included = kitchenPlan.cakeIncluded !== false;
    out.price = kitchenPlan.cakePrice || 0;
    if (typeof kitchenPlan.cakeQuantity === "number") out.quantity = kitchenPlan.cakeQuantity;
  }
  return out;
}

/** Whether the preview's Party Details box has anything to show (its rows hide an empty or 0 value). */
export function aiFillPartyDetailsShown(partyDetails: Record<string, unknown> | null | undefined): boolean {
  if (!partyDetails) return false;
  const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== 0;
  return (
    filled(text(partyDetails.packageName)) ||
    filled(partyDetails.packageBasePrice) ||
    filled(partyDetails.prepaymentReceived) ||
    filled(text(partyDetails.notes)) ||
    (Array.isArray(partyDetails.items) && partyDetails.items.length > 0)
  );
}
