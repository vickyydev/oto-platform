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
 *
 * Left as it was, the type may be No Cake, the default of every new BEO, and
 * every reader skips a No Cake cake (the timeline, the PDF, Generate from
 * BEO). So the preview and the review say when the type they keep is No Cake
 * and what to choose to keep the cake's time, and the editor's Cake block
 * shows a time or notes held under No Cake with the same words.
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

/** The BEO editor's own names for its cake types, as its buttons say them. */
export const EDITOR_CAKE_TYPE: Record<"INTERNAL" | "EXTERNAL" | "NONE", string> = {
  INTERNAL: "Our Cake",
  EXTERNAL: "Own Cake",
  NONE: "No Cake",
};

const keepWhat = (cake: { time?: string | null; notes?: string | null }) => {
  const time = text(cake.time);
  return time ? `the ${time} cake time` : "the cake notes";
};

/**
 * The preview's words beside a cake whose type the message does not say
 * (SCRUM-787), given the form's own cake type. The form's type stays as it
 * is (the owner's default), so when that type is No Cake the time and notes
 * Load into Editor writes would sit under a type every reader skips (the
 * timeline, the PDF, Generate from BEO): the line says so, and what to choose
 * to keep them. Null when the message does say whose cake it is.
 */
export function aiFillCakeNotSaidNote(line: AiFillCakeLine | null, formCakeMode: string | null | undefined): string | null {
  if (!line || !line.notSaid) return null;
  const form = saidMode(formCakeMode);
  if (form === "NONE") return `not said — the BEO says No Cake: choose Our Cake or Own Cake to keep ${keepWhat(line)}`;
  return form ? `not said — the form's cake type stays as it is (${EDITOR_CAKE_TYPE[form]})` : "not said — the form's cake type stays as it is";
}

/**
 * The review's words beside a cake whose type the chat does not say, given
 * the BEO's own cake type: Approve and create keeps that type, so when it is
 * No cake the review says so, and that choosing the park's or the family's
 * cake here keeps the cake's time. Null when the cake's type is chosen.
 */
export function aiReviewCakeNotSaidNote(
  cake: { mode: string | null; time?: string | null; notes?: string | null } | null,
  bookedCakeMode: string | null | undefined,
): string | null {
  if (!cake || cake.mode) return null;
  const booked = saidMode(bookedCakeMode);
  if (booked === "NONE") {
    return `Not said who brings the cake, and the BEO says No cake: choose the park's or the family's cake here to keep ${keepWhat(cake)}.`;
  }
  return booked
    ? `Not said who brings the cake: the BEO keeps its own cake type (${AI_FILL_CAKE_TYPE[booked].toLowerCase()}).`
    : "Not said who brings the cake: the BEO keeps its own cake type.";
}

/**
 * The editor's words for a cake time or notes the BEO holds under No Cake (an
 * AI fill loaded or approved them while whose cake it is was not said): the
 * Cake block shows them with these words, so the value is never out of sight.
 * Null when the type is a cake, or nothing sits under No Cake.
 */
export function cakeUnderNoCakeNote(
  cakeMode: string | null | undefined,
  cakeTime: string | null | undefined,
  cakeNotes: string | null | undefined,
): string | null {
  if ((saidMode(cakeMode) ?? "NONE") !== "NONE") return null;
  if (!text(cakeTime) && !text(cakeNotes)) return null;
  return `No Cake is chosen: choose Our Cake or Own Cake to keep ${keepWhat({ time: cakeTime, notes: cakeNotes })}.`;
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
    filled(partyDetails.depositRequested) ||
    filled(text(partyDetails.notes)) ||
    (Array.isArray(partyDetails.items) && partyDetails.items.length > 0)
  );
}
