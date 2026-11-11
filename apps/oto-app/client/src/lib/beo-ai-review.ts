import {
  laterLineWins,
  type BeoAiApproveBody,
  type BeoAiCakeMode,
  type BeoAiFrom,
  type BeoAiMenu,
  type BeoAiOrigin,
  type BeoAiPackage,
  type BeoAiRequestKind,
  type BeoAiReview,
  type BeoAiSetMenuItem,
} from "@shared/beoAiFill";
import { aiFillDateLine, type AiFillDateLine } from "./beo-ai-date";

/**
 * THE AI FILL'S REVIEW IN EDIT MODE (SCRUM-815), its state and what it sends.
 *
 * Create BEO's AI Fill proposes the BEO from the whole conversation, matched
 * to the park's catalogue (`BeoAiReview`). The review shows it as the BEO's
 * own sections, editable: every field starts at the proposal (the family's
 * values as defaults, the later line winning where two spoke — the team's
 * confirmation over the family's earlier lines) and carries its source; a
 * field the reviewer changes is theirs ("changed here"). A line the
 * catalogue lacks waits for a decision (keep it as a free line, or leave it
 * out) before "Approve and create" can be pressed; nothing is written before
 * it is. The date the confirmation names sits beside the booked one and is
 * applied only when ticked (SCRUM-814).
 *
 * SCRUM-827 — ONE PASS. The rest of the BEO (the title, the booking name and
 * location, the special requests, decoration and activities, the setup plan,
 * the POS box, the timeline's steps and the team) used to open in a second
 * preview after the approval. It is in this review now (`details`), each
 * field with its source, and Approve and create writes it all at once.
 * Nothing typed is overwritten (SCRUM-826's rule): a text field the BEO
 * already holds keeps its value, with the chat's offered beside it to take
 * with one press; only a field the reviewer leaves different from what the
 * BEO holds is sent. Pure, so the app's check holds it.
 */

export type BeoAiDecision = "keep" | "drop" | null;

/** A value, where it came from, and whether the reviewer changed it. */
export interface Reviewed<T> {
  value: T;
  from: BeoAiFrom | null;
  changed: boolean;
}

/**
 * SCRUM-827: a text field of the rest of the BEO. `held` is what the BEO
 * holds now (null when nothing), `chat` what the fill proposed (null when it
 * proposed nothing). The value starts at the held text when there is one,
 * else at the chat's; "Use the chat's" puts the chat's in.
 */
export interface ReviewText extends Reviewed<string> {
  held: string | null;
  /**
   * What the SAVED BEO holds (null when nothing): `held` is the form's live
   * text, typed but perhaps unsaved. Approve and create writes a value that
   * differs from the saved one — so text typed before the review is written
   * as it stands, not lost to the read-back — and never a saved value over
   * itself.
   */
  saved: string | null;
  chat: string | null;
  /** The line the chat's text is from (the latest, where several), and every line it came from (a joined field may hold the family's and the team's). */
  chatFrom: BeoAiFrom | null;
  froms: BeoAiFrom[];
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

/** SCRUM-827: a setup task, a POS line item or a timeline step the chat gave; removed from the list when left out. */
export interface ReviewLine {
  key: string;
  label: string;
  /** A task's notes; a line item's kind ("included" | "extra"); a step's time (HH:MM). */
  extra: string;
  from: BeoAiFrom | null;
  changed: boolean;
}

/** What AI Fill proposes for a BEO field that assigns somebody (server/lib/beoTeamProposals.ts). */
export type ReviewTeamMatch = { kind: "employee" | "department"; id: string; label: string };
export interface ReviewTeamProposal {
  asked: string;
  match: ReviewTeamMatch | null;
  why: "no_match" | "several" | "same_as_party_host" | "host_list_not_employees" | null;
}
export type ReviewTeamField = "partyHost" | "entertainmentHost" | "setupResponsible";
export type ReviewTeamProposals = Record<ReviewTeamField, ReviewTeamProposal | null>;

export const REVIEW_TEAM_FIELDS: Array<{ field: ReviewTeamField; label: string }> = [
  { field: "partyHost", label: "Party Host" },
  { field: "entertainmentHost", label: "Entertainment Host" },
  { field: "setupResponsible", label: "Setup Who" },
];

/** Why a name the message gave is not proposed, in the review's words. */
export function reviewTeamUnmatchedText(field: ReviewTeamField, why: ReviewTeamProposal["why"]): string {
  const typed = field === "setupResponsible";
  switch (why) {
    case "several":
      return typed
        ? "matches more than one person at this park: it goes in as typed text; pick the person in the form to link them."
        : "matches more than one person at this park: choose the host in the form.";
    case "same_as_party_host":
      return "is the same person as the party host: choose another in the form.";
    case "host_list_not_employees":
      return "this park group's host list is not its employees: choose the host in the form.";
    default:
      return typed
        ? "matches nobody at this park: it goes in as typed text."
        : "matches nobody at this park: choose the host in the form.";
  }
}

/** SCRUM-827: the rest of the BEO, as the review holds it. */
export interface ReviewDetails {
  title: ReviewText;
  bookingName: ReviewText;
  locationText: ReviewText;
  specialRequests: ReviewText;
  activities: ReviewText;
  decoration: ReviewText;
  setupReadyBy: ReviewText;
  setupResponsible: ReviewText;
  setupTasks: ReviewLine[];
  posName: ReviewText;
  posNotes: ReviewText;
  posItems: ReviewLine[];
  timeline: ReviewLine[];
  /** The people the message named, matched to the park's roster; assigned only where ticked. */
  team: { proposals: ReviewTeamProposals; accepted: ReviewTeamField[] };
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
  /** SCRUM-827: the rest of the BEO, in the same pass. */
  details: ReviewDetails;
}

/** SCRUM-827: what the BEO's form holds now of the rest, so nothing typed is overwritten. */
export interface ReviewHeld {
  title: string;
  bookingName: string;
  locationText: string;
  specialRequests: string;
  activities: string;
  decoration: string;
  setupReadyBy: string;
  setupResponsible: string;
  posName: string;
  posNotes: string;
}
export const NOTHING_HELD: ReviewHeld = {
  title: "",
  bookingName: "",
  locationText: "",
  specialRequests: "",
  activities: "",
  decoration: "",
  setupReadyBy: "",
  setupResponsible: "",
  posName: "",
  posNotes: "",
};

let seq = 0;
const key = (prefix: string) => `${prefix}_${++seq}`;
const fresh = <T>(value: T, from: BeoAiFrom | null): Reviewed<T> => ({ value, from, changed: false });
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const sameText = (a: string, b: string) => a.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ") === b.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

/** SCRUM-827: a text field of the rest: the held value stands, else the chat's. */
function reviewText(
  held: string | undefined,
  chat: { value: string; from: BeoAiFrom } | null,
  froms: BeoAiFrom[] = chat ? [chat.from] : [],
  saved: string | undefined = held,
): ReviewText {
  const heldText = held?.trim() ? held.trim() : null;
  const savedText = saved?.trim() ? saved.trim() : null;
  const chatText = chat?.value.trim() ? chat.value.trim() : null;
  const value = heldText ?? chatText ?? "";
  // A held value the chat gives as well wears the chat's mark: it is that line's value.
  const isChats = chatText !== null && (heldText === null || sameText(heldText, chatText));
  return { value, from: isChats ? chat!.from : null, changed: false, held: heldText, saved: savedText, chat: chatText, chatFrom: chat?.from ?? null, froms };
}
const HELD_OF_KIND: Record<BeoAiRequestKind, keyof ReviewHeld> = { special_request: "specialRequests", decoration: "decoration", activity: "activities" };

/** The chat's requests of one kind, joined one per line, with every line they came from. */
function requestsText(requests: BeoAiReview["proposal"]["details"]["requests"], kind: BeoAiRequestKind): { value: string; from: BeoAiFrom } | null {
  const lines = requests.filter((r) => r.kind === kind);
  if (lines.length === 0) return null;
  return { value: lines.map((r) => r.text).join("\n"), from: lines.reduce((a, r) => (laterLineWins(r.from, a) ? r.from : a), lines[0]!.from) };
}
const distinctFroms = (froms: BeoAiFrom[]): BeoAiFrom[] => {
  const out: BeoAiFrom[] = [];
  for (const f of froms) if (!out.some((o) => o.source === f.source)) out.push(f);
  return out;
};

/**
 * The review as it opens: the proposal, every field with its source. `fill`
 * is the free-text fill read beside it (its date, SCRUM-814, and the team the
 * message named), `bookedDate` the date the form holds, `held` what the
 * form holds of the rest and `saved` what the saved BEO holds of it — the
 * form's own when not given (SCRUM-827).
 */
export function initialReviewState(
  review: BeoAiReview,
  opts: { fill?: unknown; bookedDate?: string | null; held?: ReviewHeld; saved?: ReviewHeld } = {},
): BeoAiReviewState {
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
  const held = opts.held ?? NOTHING_HELD;
  // What the saved BEO holds; the form's live text when the caller gives no saved one.
  const saved = opts.saved ?? held;
  const d = p.details;
  const requestLine = (kind: BeoAiRequestKind) => {
    const field = HELD_OF_KIND[kind];
    return reviewText(held[field], requestsText(d.requests, kind), distinctFroms(d.requests.filter((r) => r.kind === kind).map((r) => r.from)), saved[field]);
  };
  const text = (field: keyof ReviewHeld, chat: { value: string; from: BeoAiFrom } | null) => reviewText(held[field], chat, undefined, saved[field]);
  const proposals = asRecord(asRecord(opts.fill)?.proposals);
  const teamProposals: ReviewTeamProposals = { partyHost: null, entertainmentHost: null, setupResponsible: null };
  for (const { field } of REVIEW_TEAM_FIELDS) {
    const t = asRecord(proposals?.[field]);
    if (t && typeof t.asked === "string") teamProposals[field] = t as unknown as ReviewTeamProposal;
  }
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
    details: {
      title: text("title", d.title),
      bookingName: text("bookingName", d.bookingName),
      locationText: text("locationText", d.locationText),
      specialRequests: requestLine("special_request"),
      activities: requestLine("activity"),
      decoration: requestLine("decoration"),
      setupReadyBy: text("setupReadyBy", d.setup.readyBy),
      setupResponsible: text("setupResponsible", d.setup.responsible),
      setupTasks: d.setup.tasks.map((t) => ({ key: key("task"), label: t.itemLabel, extra: t.notes ?? "", from: t.from, changed: false })),
      posName: text("posName", d.pos.name),
      posNotes: text("posNotes", d.pos.notes),
      posItems: d.pos.items.map((i) => ({ key: key("pos"), label: i.description, extra: i.type, from: i.from, changed: false })),
      timeline: d.timeline.map((t) => ({ key: key("step"), label: t.label, extra: t.time, from: t.from, changed: false })),
      team: { proposals: teamProposals, accepted: [] },
    },
  };
}

/** Of two sources for one group, the one its mark shows: the later line's, whoever wrote it (`laterLineWins`, SCRUM-826). */
function laterFrom(a: BeoAiFrom | null, b: BeoAiFrom): BeoAiFrom {
  if (!a) return b;
  return laterLineWins(b, a) ? b : a;
}

/** What Approve and create writes, in the words the review says it (SCRUM-827: everything, in one pass). */
export const APPROVAL_WRITES =
  "the event's name and details, the counts, the times, the date when ticked, the package, the kitchen plan, the bar, the entertainment, the setup plan, the POS box, the timeline's steps, the team you ticked and the deposit";

/**
 * SCRUM-843: the approval's answer as the review's result reads it — what it
 * could not write. The timeline's steps on a party with no start time yet
 * (SCRUM-827), and the deposit, kept as stored because it changed while the
 * review was open or would have gone below what the family paid through the chat.
 */
export interface ApproveAnswer {
  notWritten?: {
    timeline?: { message: string; steps: Array<{ time: string; label: string }> };
    deposit?: { reason?: string; message: string; amountThb?: number; date?: string | null };
  };
}

/** The result's words after an approval: what was saved, then each thing that was not, and why. */
export function approvalResultWords(answer: ApproveAnswer): string {
  const missing = answer.notWritten?.timeline;
  const kept = answer.notWritten?.deposit;
  // A deposit that was kept is not among what was saved.
  const saved = kept ? APPROVAL_WRITES.replace(", the team you ticked and the deposit", " and the team you ticked") : APPROVAL_WRITES;
  const steps = missing
    ? ` Not written: ${missing.steps.length === 1 ? "the timeline's step" : `the timeline's ${missing.steps.length} steps`} (${missing.steps.map((s) => `${s.time} ${s.label}`).join(", ")}) — ${missing.message}. Set the start time, then add them to the Timeline.`
    : "";
  const deposit = kept ? ` Not written: the deposit — ${kept.message}.` : "";
  return `Saved: ${saved}.${steps}${deposit}`;
}

/** The sources whose marks the form wears after an approval: not a step's, nor the deposit's, that was not written. */
export function writtenSourcesOf(sources: BeoAiApproveBody["sources"], answer: ApproveAnswer): BeoAiApproveBody["sources"] {
  const noSteps = !!answer.notWritten?.timeline;
  const noDeposit = !!answer.notWritten?.deposit;
  return sources.filter((s) => !(noSteps && s.field.startsWith("timeline:")) && !(noDeposit && s.field === "deposit"));
}

/** A field the reviewer set: their value, marked as changed here. */
export function edited<T>(field: Reviewed<T> | null, value: T): Reviewed<T> {
  return { value, from: field?.from ?? null, changed: true };
}

/** SCRUM-827: a text field of the rest the reviewer typed into: theirs now. */
export function editedText(field: ReviewText, value: string): ReviewText {
  return { ...field, value, changed: true };
}

/** SCRUM-827: "Use the chat's" — the chat's text in place of the held one, with the chat's mark. */
export function useChatText(field: ReviewText): ReviewText {
  return { ...field, value: field.chat ?? field.value, changed: false, from: field.chatFrom ?? field.from };
}

/** Whether a text field of the rest shows the chat's text beside the held one, to take with one press. */
export const chatOffered = (field: ReviewText): boolean =>
  field.held !== null && field.chat !== null && !sameText(field.held, field.chat) && !sameText(field.value, field.chat);

/**
 * The words the offer is made in, by where the offered text is from: the
 * chat's lines say "The chat says …"; the park's default (the app's own
 * naming rule, nobody's line) and a template are named as such — never
 * called the chat's words.
 */
export function chatOfferWords(field: Pick<ReviewText, "chat" | "chatFrom">): { line: string; button: string } {
  const chat = field.chat ?? "";
  switch (field.chatFrom?.source) {
    case "default":
      return { line: `The park's default is "${chat}"`, button: "Use the park's default" };
    case "template":
      return { line: `The template gives "${chat}"`, button: "Use the template's" };
    default:
      return { line: `The chat says "${chat}"`, button: "Use the chat's" };
  }
}

/** What the small mark beside a field says. */
export function sourceOf(field: { from: BeoAiFrom | null; changed: boolean } | null): BeoAiOrigin | "staff" | null {
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

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * SCRUM-827: the rest of the BEO as Approve and create sends it. A text field
 * is sent only when the reviewer leaves it different from what the SAVED BEO
 * holds: nothing typed is overwritten (the form's own text is what the field
 * starts at), text typed before the review and not yet saved is written as
 * it stands — the one Save, so the read-back after the approval does not
 * lose it — and a saved value is never written back over itself; a task,
 * line item or step is sent while it is still in its list; a team member
 * where ticked and matched.
 */
export function approveDetailsOf(
  state: BeoAiReviewState,
  note: (field: string, f: { from: BeoAiFrom | null; changed: boolean } | null) => void,
): NonNullable<BeoAiApproveBody["details"]> {
  const d = state.details;
  const out: NonNullable<BeoAiApproveBody["details"]> = {};
  const text = (field: keyof ReviewHeld, into: keyof NonNullable<BeoAiApproveBody["details"]>) => {
    const f = d[field];
    const value = f.value.trim();
    if (!value) return;
    if (into === "setupReadyBy" && !TIME.test(value)) return;
    // A value the saved BEO holds already is not written back over itself; its source is
    // still recorded when it is the chat's or the park's own (the mark the form wears
    // afterwards). Unsaved typed text differs from the saved value and is written.
    const saved = f.saved !== null && sameText(value, f.saved);
    if (!saved) (out as Record<string, unknown>)[into] = value;
    if (!saved || (f.from && !f.changed)) note(into, f);
  };
  text("title", "title");
  text("bookingName", "bookingName");
  text("locationText", "locationText");
  text("specialRequests", "specialRequests");
  text("activities", "activities");
  text("decoration", "decoration");
  text("setupReadyBy", "setupReadyBy");
  text("setupResponsible", "setupResponsible");
  text("posName", "posName");
  text("posNotes", "posNotes");
  const tasks = d.setupTasks.filter((t) => t.label.trim());
  if (tasks.length > 0) {
    out.setupTasks = tasks.map((t, i) => {
      note(`setupTask:${i}`, t);
      return { itemLabel: t.label.trim(), notes: t.extra.trim() || null };
    });
  }
  const items = d.posItems.filter((i) => i.label.trim());
  if (items.length > 0) {
    out.posItems = items.map((i, n) => {
      note(`posItem:${n}`, i);
      return { description: i.label.trim(), type: i.extra === "extra" ? "extra" : "included" };
    });
  }
  const steps = d.timeline.filter((s) => s.label.trim() && TIME.test(s.extra));
  if (steps.length > 0) {
    out.timeline = steps.map((s, i) => {
      note(`timeline:${i}`, s);
      return { time: s.extra, label: s.label.trim() };
    });
  }
  const team: NonNullable<NonNullable<BeoAiApproveBody["details"]>["team"]> = {};
  for (const { field } of REVIEW_TEAM_FIELDS) {
    const proposal = d.team.proposals[field];
    if (!proposal?.match || !d.team.accepted.includes(field)) continue;
    team[field] = { kind: proposal.match.kind, id: proposal.match.id, label: proposal.match.label };
    // The name is the message's: the team's confirmation named them.
    note(`team:${field}`, { from: { source: "team", at: null, line: null }, changed: false });
  }
  if (Object.keys(team).length > 0) out.team = team;
  return out;
}

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
    if (f && TIME.test(f.value)) {
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
        time: TIME.test(state.cake.value.time) ? state.cake.value.time : null,
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

  // SCRUM-827: the rest of the BEO, in the same pass.
  const details = approveDetailsOf(state, note);

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
    // SCRUM-843: the party's deposit as this review was read with, so one that moved since is kept.
    ...(review.oneDeposit ? { expectedDeposit: { amountThb: review.oneDeposit.amountThb, date: review.oneDeposit.date } } : {}),
    details,
    sources,
  };
}

/**
 * SCRUM-827: the sources the approval recorded, by the editor's field, for
 * the marks the form wears once the BEO opens filled: `team:partyHost` →
 * "team", and so on. "staff" is a value the reviewer changed.
 */
export type ApprovedMarks = Record<string, BeoAiOrigin | "staff">;
export function approvedMarksOf(sources: BeoAiApproveBody["sources"]): ApprovedMarks {
  const marks: ApprovedMarks = {};
  for (const s of sources) marks[s.field] = s.source;
  return marks;
}

/** The editor's sections, and the approved fields each one wears the "from the chat" chip for. */
export const APPROVED_SECTIONS: Record<string, (field: string) => boolean> = {
  "event-info": (f) => ["title", "childName", "numChildren", "numAdults", "startTime", "endTime", "eventDate", "bookingName", "locationText", "specialRequests", "activities", "decoration"].includes(f),
  "party-host": (f) => f.startsWith("team:partyHost") || f.startsWith("team:entertainmentHost"),
  "birthday-package": (f) => f === "package" || f.startsWith("addOn:") || f.startsWith("entertainment:"),
  "party-details": (f) => f.startsWith("pos") || f === "deposit",
  "setup-plan": (f) => f.startsWith("setup") || f === "team:setupResponsible",
  "kitchen-plan": (f) => f === "setMenu" || f === "cake" || f.startsWith("choice:") || f.startsWith("menu:"),
  timeline: (f) => f.startsWith("timeline:"),
};

/** The sections the approval filled, for the chip and for opening them. */
export function approvedSectionsOf(marks: ApprovedMarks): string[] {
  const fields = Object.keys(marks);
  return Object.entries(APPROVED_SECTIONS).filter(([, has]) => fields.some(has)).map(([section]) => section);
}
