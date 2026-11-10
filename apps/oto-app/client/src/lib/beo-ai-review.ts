import type {
  BeoAiApproveBody,
  BeoAiCakeMode,
  BeoAiFrom,
  BeoAiMenu,
  BeoAiPackage,
  BeoAiReview,
  BeoAiSetMenuItem,
} from "@shared/beoAiFill";
import { aiFillDateLine, type AiFillDateLine } from "./beo-ai-date";

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
 * it is. The date the confirmation names sits beside the booked one and is
 * applied only when ticked (SCRUM-814). What Approve and create does not
 * write — the form's other fields the same fill read — opens next in the
 * preview of before (`fillBeyondApproval`). Pure, so the app's check holds it.
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
  /**
   * The chosen options of each choice group, by the group's id (none: empty):
   * one for a group of one choice, any of its options for a group that takes several.
   */
  choices: Record<string, Reviewed<string[]>>;
  menuLines: ReviewMenuLine[];
  entertainment: ReviewEntertainment[];
  otherLines: ReviewOtherLine[];
  childName: Reviewed<string> | null;
  numChildren: Reviewed<number> | null;
  numAdults: Reviewed<number> | null;
  startTime: Reviewed<string> | null;
  endTime: Reviewed<string> | null;
  /** SCRUM-787: `mode` null is a cake whose type the chat does not say: the BEO keeps its own. */
  cake: Reviewed<{ mode: BeoAiCakeMode | null; notes: string; time: string }> | null;
  deposit: Reviewed<{ amount: number; paid: boolean; date: string }> | null;
  /** SCRUM-814: the date the confirmation names beside the booked one; null when it names none. */
  date: AiFillDateLine | null;
  /** The read date replaces the booked one only when this is ticked (and they differ). */
  useDate: boolean;
}

let seq = 0;
const key = (prefix: string) => `${prefix}_${++seq}`;
const fresh = <T>(value: T, from: BeoAiFrom | null): Reviewed<T> => ({ value, from, changed: false });

/**
 * The review as it opens: the proposal, every field with its source. `fill`
 * is the free-text fill read beside it (its date, SCRUM-814) and `bookedDate`
 * the date the form holds.
 */
export function initialReviewState(review: BeoAiReview, opts: { fill?: unknown; bookedDate?: string | null } = {}): BeoAiReviewState {
  const p = review.proposal;
  const addOns: BeoAiReviewState["addOns"] = {};
  for (const a of p.addOns) addOns[a.lineId] = fresh(a.quantity, a.from);
  // Every option the proposal gives a group; the group's source is its latest one's.
  const choices: BeoAiReviewState["choices"] = {};
  for (const c of p.setMenu?.choices ?? []) {
    const had = choices[c.itemId];
    choices[c.itemId] = had && !had.value.includes(c.option) ? fresh([...had.value, c.option], laterFrom(had.from, c.from)) : had ?? fresh([c.option], c.from);
  }
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
    date: aiFillDateLine(opts.fill, opts.bookedDate),
    useDate: false,
  };
}

/** Of two sources for one group, the one its mark shows: the team's, else the later line's. */
function laterFrom(a: BeoAiFrom | null, b: BeoAiFrom): BeoAiFrom {
  if (!a) return b;
  if (a.source !== b.source) return a.source === "team" ? a : b;
  return (b.line ?? 0) >= (a.line ?? 0) ? b : a;
}

/** What Approve and create writes, in the words the review says it. */
export const APPROVAL_WRITES = "the child's name, the counts, the times, the date when ticked, the package, the kitchen plan, the bar, the entertainment and the deposit";
/** What it leaves for the preview of before, in the same words. */
export const APPROVAL_LEAVES =
  "the title, the booking name, the location, the special requests, the activities, the decoration, the setup plan, the party details, the timeline and the team";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const filled = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

/**
 * The part of the free-text fill (read from the ruling message) that Approve
 * and create does not write: the event's title, booking name, location,
 * special requests, activities and decoration, the setup plan, Party Details
 * (but its prepayment and deposit date, which the approval writes), the
 * timeline and the team the message names (assigned only where ticked). It
 * opens in the preview of before once the approval is saved, so Load into
 * Editor applies it with the preview's own rules; null when the fill holds
 * none of it. `keptLines` are the free lines the approval added to Special
 * Requests: the message's special requests carry them after its own, so
 * loading one never drops the other.
 */
export function fillBeyondApproval(fill: unknown, keptLines: string[] = []): Record<string, unknown> | null {
  const f = asRecord(fill);
  if (!f) return null;
  const rest: Record<string, unknown> = {};
  const ev = asRecord(f.event) ?? {};
  const event: Record<string, unknown> = {};
  for (const k of ["title", "bookingName", "locationText", "activities", "decoration"]) if (filled(ev[k])) event[k] = ev[k];
  if (typeof ev.specialRequests === "string" && ev.specialRequests.trim()) {
    const own = ev.specialRequests.trim();
    event.specialRequests = [own, ...keptLines.filter((l) => !own.includes(l))].join("\n");
  }
  if (Object.keys(event).length > 0) rest.event = event;
  const setup = asRecord(f.setupPlan);
  if (setup && Object.values(setup).some((v) => (Array.isArray(v) ? v.length > 0 : filled(v)))) rest.setupPlan = setup;
  const party = asRecord(f.partyDetails);
  if (party) {
    const { prepaymentReceived: _paid, depositDate: _on, ...others } = party;
    if (Object.values(others).some((v) => (Array.isArray(v) ? v.length > 0 : filled(v)))) rest.partyDetails = others;
  }
  if (Array.isArray(f.timeline) && f.timeline.length > 0) rest.timeline = f.timeline;
  const proposals = asRecord(f.proposals);
  const team = proposals && Object.values(proposals).some(Boolean) ? proposals : null;
  if (Object.keys(rest).length === 0 && !team) return null;
  if (team) rest.proposals = team;
  if (filled(f.summary)) rest.summary = f.summary;
  return rest;
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
    // The group's own options, in its own order; a group of one choice sends one.
    const options = g.options.filter((o) => c?.value.includes(o));
    if (!c || options.length === 0) return [];
    note(`choice:${g.id}`, c);
    return [{ itemId: g.id, options: g.allowMultiple ? options : options.slice(-1) }];
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
  // SCRUM-814: the date the confirmation names, only where it differs from the booked one and was ticked.
  if (state.date?.differs && state.useDate) {
    event.eventDate = state.date.read;
    note("eventDate", { from: review.ruling, changed: false });
  }
  if (review.finalMessage) event.internalStaffNotes = review.finalMessage;

  const cakeDraft = state.cake
    ? {
        mode: state.cake.value.mode,
        notes: state.cake.value.notes.trim() || null,
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(state.cake.value.time) ? state.cake.value.time : null,
      }
    : null;
  // SCRUM-787: a cake whose type is not said is sent for its time and notes only; with neither, nothing.
  const cake = cakeDraft && (cakeDraft.mode || cakeDraft.notes || cakeDraft.time) ? cakeDraft : null;
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
