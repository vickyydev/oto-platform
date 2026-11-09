import type {
  BeoAiApproveBody,
  BeoAiCakeMode,
  BeoAiFrom,
  BeoAiMenu,
  BeoAiPackage,
  BeoAiReview,
  BeoAiSetMenuItem,
} from "@shared/beoAiFill";

/**
 * THE AI FILL'S REVIEW IN EDIT MODE (SCRUM-815), its state and what it sends.
 *
 * Create BEO's AI Fill proposes the BEO from the whole conversation, matched
 * to the park's catalogue (`BeoAiReview`). The review shows it as the BEO's
 * own sections, editable: every field starts at the proposal (the family's
 * values as defaults, the team's confirmation where it spoke) and carries its
 * source; a field the reviewer changes is theirs ("changed here"). A line the
 * catalogue lacks waits for a decision (keep it as a free line, or leave it
 * out) before "Approve and create" can be pressed; nothing is written before
 * it is. Pure, so the app's check holds it.
 */

export type BeoAiDecision = "keep" | "drop" | null;

/** A value, where it came from, and whether the reviewer changed it. */
export interface Reviewed<T> {
  value: T;
  from: BeoAiFrom | null;
  changed: boolean;
}

export interface ReviewMenuLine {
  key: string;
  menu: BeoAiMenu;
  itemName: string;
  quantity: number;
  productCode: string | null;
  matchedName: string | null;
  notInMenu: boolean;
  chatPrice: number | null;
  from: BeoAiFrom | null;
  changed: boolean;
  /** A line the menu does not have: kept as a free line, or left out. Null until decided. */
  decision: BeoAiDecision;
}

export interface ReviewEntertainment {
  key: string;
  /** Null on a line the entertainment menu does not have. */
  templateId: string | null;
  name: string;
  quantity: number;
  chatPrice: number | null;
  notInCatalogue: boolean;
  from: BeoAiFrom | null;
  changed: boolean;
  decision: BeoAiDecision;
}

export interface ReviewOtherLine {
  key: string;
  text: string;
  chatPrice: number | null;
  from: BeoAiFrom;
  decision: BeoAiDecision;
}

export interface BeoAiReviewState {
  packageId: Reviewed<string | null>;
  /** Quantities of the chosen package's add-ons, by line id. */
  addOns: Record<string, Reviewed<number>>;
  setMenuId: Reviewed<string | null>;
  /** The chosen option of each choice group, by the group's id ("" none). */
  choices: Record<string, Reviewed<string>>;
  menuLines: ReviewMenuLine[];
  entertainment: ReviewEntertainment[];
  otherLines: ReviewOtherLine[];
  childName: Reviewed<string> | null;
  numChildren: Reviewed<number> | null;
  numAdults: Reviewed<number> | null;
  startTime: Reviewed<string> | null;
  endTime: Reviewed<string> | null;
  cake: Reviewed<{ mode: BeoAiCakeMode; notes: string; time: string }> | null;
  deposit: Reviewed<{ amount: number; paid: boolean; date: string }> | null;
}

let seq = 0;
const key = (prefix: string) => `${prefix}_${++seq}`;
const fresh = <T>(value: T, from: BeoAiFrom | null): Reviewed<T> => ({ value, from, changed: false });

/** The review as it opens: the proposal, every field with its source. */
export function initialReviewState(review: BeoAiReview): BeoAiReviewState {
  const p = review.proposal;
  const addOns: BeoAiReviewState["addOns"] = {};
  for (const a of p.addOns) addOns[a.lineId] = fresh(a.quantity, a.from);
  const choices: BeoAiReviewState["choices"] = {};
  for (const c of p.setMenu?.choices ?? []) choices[c.itemId] = fresh(c.option, c.from);
  const sourced = <T>(f: { value: T; from: BeoAiFrom } | undefined) => (f ? fresh(f.value, f.from) : null);
  return {
    packageId: fresh(p.package?.templateId ?? null, p.package?.from ?? null),
    addOns,
    setMenuId: fresh(p.setMenu?.templateId ?? null, p.setMenu?.from ?? null),
    choices,
    menuLines: p.menuLines.map((l) => ({
      key: key("menu"),
      menu: l.menu,
      itemName: l.itemName,
      quantity: l.quantity,
      productCode: l.productCode,
      matchedName: l.matchedName,
      notInMenu: l.notInMenu,
      chatPrice: l.chatPrice,
      from: l.from,
      changed: false,
      decision: null,
    })),
    entertainment: p.entertainment.map((e) => ({
      key: key("ent"),
      templateId: e.templateId,
      name: e.name,
      quantity: e.quantity,
      chatPrice: e.chatPrice,
      notInCatalogue: e.notInCatalogue,
      from: e.from,
      changed: false,
      decision: null,
    })),
    otherLines: p.otherLines.map((o) => ({ key: key("other"), text: o.text, chatPrice: o.chatPrice, from: o.from, decision: null })),
    childName: sourced(p.event.childName),
    numChildren: sourced(p.event.numChildren),
    numAdults: sourced(p.event.numAdults),
    startTime: sourced(p.event.startTime),
    endTime: sourced(p.event.endTime),
    cake: p.cake ? fresh({ mode: p.cake.mode, notes: p.cake.notes ?? "", time: p.cake.time ?? "" }, p.cake.from) : null,
    deposit: p.deposit ? fresh({ amount: p.deposit.amount, paid: p.deposit.paid, date: p.deposit.date ?? "" }, p.deposit.from) : null,
  };
}

/** A field the reviewer set: their value, marked as changed here. */
export function edited<T>(field: Reviewed<T> | null, value: T): Reviewed<T> {
  return { value, from: field?.from ?? null, changed: true };
}

/** What the small mark beside a field says. */
export function sourceOf(field: { from: BeoAiFrom | null; changed: boolean } | null): "team" | "family" | "staff" | null {
  if (!field) return null;
  if (field.changed || !field.from) return field.changed ? "staff" : null;
  return field.from.source;
}

/** Lines the catalogue lacks that still wait for a decision; Approve and create waits for none. */
export function undecidedLines(state: BeoAiReviewState): number {
  return (
    state.menuLines.filter((l) => l.notInMenu && l.decision === null).length +
    state.entertainment.filter((e) => e.notInCatalogue && e.decision === null).length +
    state.otherLines.filter((o) => o.decision === null).length
  );
}

export const packageOf = (review: BeoAiReview, id: string | null): BeoAiPackage | undefined =>
  id ? review.catalogue.packages.find((p) => p.id === id) : undefined;

/** The chosen package's add-ons: the lines it does not include. */
export const addOnLinesOf = (pkg: BeoAiPackage | undefined) => (pkg ? pkg.lines.filter((l) => !l.included) : []);

export const choiceGroupsOf = (review: BeoAiReview, setMenuId: string | null) =>
  (review.catalogue.setMenus.find((m) => m.id === setMenuId)?.items ?? []).filter(
    (i): i is Extract<BeoAiSetMenuItem, { type: "choice_group" }> => i.type === "choice_group",
  );

/**
 * The catalogue's price beside the chat's, in baht: both shown, the
 * catalogue's kept; `differs` marks a chat price that is neither of the
 * catalogue's (a package has a weekday and a weekend price).
 */
export function priceBeside(chatPrice: number | null, catalogueSatang: Array<number | null>): {
  chat: number | null;
  catalogue: number[];
  differs: boolean;
} {
  const catalogue = [...new Set(catalogueSatang.filter((v): v is number => typeof v === "number").map((v) => Math.round(v) / 100))];
  return { chat: chatPrice, catalogue, differs: chatPrice !== null && catalogue.length > 0 && !catalogue.includes(chatPrice) };
}

/** "฿16,900" */
export const thb = (baht: number) => `฿${baht.toLocaleString("en", { maximumFractionDigits: 2 })}`;

/** The add-on, entertainment or package price the catalogue holds, in satang, for `priceBeside`. */
export const packagePrices = (pkg: BeoAiPackage) => [pkg.priceWeekday ?? pkg.basePrice, pkg.priceWeekend ?? pkg.basePrice];

/**
 * What "Approve and create" sends: the BEO as the reviewer left it. Kept free
 * lines go in their own words; lines left out, a package of none and empty
 * fields are not sent. Each field's source rides along for the activity row.
 */
export function approveBodyOf(
  review: BeoAiReview,
  state: BeoAiReviewState,
  ids: { conversationId: string | null; messageId: string | null },
): BeoAiApproveBody {
  const sources: BeoAiApproveBody["sources"] = [];
  const note = (field: string, f: { from: BeoAiFrom | null; changed: boolean } | null) => {
    const source = sourceOf(f);
    if (source) sources.push({ field, source, at: f?.changed ? null : (f?.from?.at ?? null) });
  };

  const pkg = packageOf(review, state.packageId.value);
  note("package", pkg ? state.packageId : null);
  const addOns = addOnLinesOf(pkg).flatMap((line) => {
    const q = state.addOns[line.id];
    if (!q || !(q.value > 0)) return [];
    note(`addOn:${line.id}`, q);
    return [{ lineId: line.id, quantity: Math.round(q.value) }];
  });

  const groups = choiceGroupsOf(review, state.setMenuId.value);
  const choices = groups.flatMap((g) => {
    const c = state.choices[g.id];
    if (!c?.value) return [];
    note(`choice:${g.id}`, c);
    return [{ itemId: g.id, options: [c.value] }];
  });
  const setMenu = state.setMenuId.value ? { templateId: state.setMenuId.value, choices } : null;
  if (setMenu) note("setMenu", state.setMenuId);

  const menuLines = state.menuLines
    .filter((l) => !l.notInMenu || l.decision === "keep")
    .filter((l) => l.itemName.trim() && l.quantity > 0)
    .map((l, i) => {
      note(`menu:${i}`, l);
      return {
        menu: l.menu,
        itemName: l.itemName.trim(),
        quantity: Math.round(l.quantity),
        productCode: l.notInMenu ? null : l.productCode,
        notes: null,
      };
    });

  const entertainment = state.entertainment
    .filter((e) => !e.notInCatalogue || e.decision === "keep")
    .filter((e) => (e.templateId || e.name.trim()) && e.quantity > 0)
    .map((e, i) => {
      note(`entertainment:${i}`, e);
      const t = e.templateId ? review.catalogue.entertainment.find((x) => x.id === e.templateId) : undefined;
      return { templateId: t?.id ?? null, name: (t?.name ?? e.name).trim(), quantity: Math.round(e.quantity), notes: null };
    });

  const otherLines = state.otherLines.filter((o) => o.decision === "keep").map((o, i) => {
    note(`other:${i}`, { from: o.from, changed: false });
    return o.text;
  });

  const event: BeoAiApproveBody["event"] = {};
  if (state.childName?.value.trim()) {
    event.childName = state.childName.value.trim();
    note("childName", state.childName);
  }
  for (const k of ["numChildren", "numAdults"] as const) {
    const f = state[k];
    if (f && Number.isInteger(f.value) && f.value >= 0) {
      event[k] = f.value;
      note(k, f);
    }
  }
  for (const k of ["startTime", "endTime"] as const) {
    const f = state[k];
    if (f && /^([01]\d|2[0-3]):[0-5]\d$/.test(f.value)) {
      event[k] = f.value;
      note(k, f);
    }
  }
  if (review.finalMessage) event.internalStaffNotes = review.finalMessage;

  const cake = state.cake
    ? {
        mode: state.cake.value.mode,
        notes: state.cake.value.notes.trim() || null,
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(state.cake.value.time) ? state.cake.value.time : null,
      }
    : null;
  if (cake) note("cake", state.cake);

  const deposit =
    state.deposit && state.deposit.value.amount > 0
      ? {
          amount: Math.round(state.deposit.value.amount),
          paid: state.deposit.value.paid,
          date: /^\d{4}-\d{2}-\d{2}$/.test(state.deposit.value.date) ? state.deposit.value.date : null,
        }
      : null;
  if (deposit) note("deposit", state.deposit);

  return {
    conversationId: ids.conversationId,
    messageId: ids.messageId,
    package: pkg ? { templateId: pkg.id, addOns } : null,
    setMenu,
    menuLines,
    entertainment,
    otherLines,
    event,
    cake,
    deposit,
    sources,
  };
}
