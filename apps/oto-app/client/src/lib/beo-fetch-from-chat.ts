import type { BeoAiFrom, BeoAiMenu, BeoAiReview } from "@shared/beoAiFill";
import { aiFillDateLine, dayLabel } from "./beo-ai-date";
import { AI_FILL_CAKE_TYPE } from "./beo-ai-preview";
import { thb } from "./beo-ai-review";

/**
 * "FETCH FROM CHAT" ON THE BEO FORM (SCRUM-826) — the diff and the memory.
 *
 * The BEO was filled from the conversation when it was created (SCRUM-815)
 * and the form has been edited since; the chat has moved on too. The owner's
 * rule: a Fetch warns first, reads the conversation again, and LISTS every
 * change it brings — the field, what the form holds now and what the chat
 * says — each accepted or declined; nothing typed is overwritten silently, a
 * declined change is not offered again until the chat changes, and what is
 * accepted lands in the form as any edit does, unsaved until Save.
 *
 * The read is the existing fill path (`POST …/beo/ai-fill/inbox`, with
 * `purpose: "fetch"`): the free-text fill of the ruling message with the form
 * as its baseline, and, with the park's catalogue, the catalogue proposal read
 * from the WHOLE conversation with each value's source. The diff takes the
 * counts, the times, the child, the cake and the deposit from that proposal
 * (the whole chat, a later line winning) and the rest of the form's own text
 * fields from the fill; those are the fields the form types, and the only
 * ones a fetch applies. The catalogue section — the package and its add-ons,
 * the set menu and its choices, the food lines, the entertainment, a line the
 * catalogue lacks — is what Create BEO's review and approval write: a fetch
 * LISTS what the chat says there against what the BEO holds
 * (`fetchCatalogueChangesOf`), to read, and applies none of it, so the list
 * is every change the chat brings and "reads the same" is true when said.
 * Pure, so the app's check holds it.
 */

/** What the form holds now, in the fields a fetch knows. */
export interface FetchFormValues {
  title: string;
  childName: string;
  bookingName: string;
  numChildren: number | null;
  numAdults: number | null;
  startTime: string;
  endTime: string;
  /** `YYYY-MM-DD`, or empty. */
  eventDate: string;
  locationText: string;
  specialRequests: string;
  activities: string;
  decoration: string;
  setupReadyBy: string;
  setupResponsible: string;
  /** The editor's cake type: INTERNAL, EXTERNAL or NONE. */
  cakeMode: string;
  cakeNotes: string;
  cakeTime: string;
  /** Baht. */
  prepaymentReceived: number;
  depositDate: string;
  packageName: string;
  packageNotes: string;
}
export type FetchField = keyof FetchFormValues;

/** One change the chat brings: the field, both values as shown, the value to put in the form, and whose line. */
export interface FetchChange {
  field: FetchField;
  label: string;
  /** The form's value now, as a person reads it ("—" when it holds none). */
  was: string;
  /** The chat's value, as a person reads it. */
  now: string;
  /** What accepting puts in the form. */
  value: string | number;
  from: BeoAiFrom | null;
  /** The chat's own words, where the read gives them (the date). */
  said: string | null;
}

/**
 * The catalogue section the BEO holds — the applied package (its snapshot)
 * and the labels of its lines, the kitchen plan's set menu, the kitchen
 * plan's and the bar's lines, the entertainment selections — read by the
 * editor when the chat is, so the fetch can list what the chat says there.
 */
export interface FetchHeldCatalogue {
  /** The applied package, by its template and name; null when none. */
  package: { templateId: string | null; name: string } | null;
  /** The applied package's lines' labels, its add-ons among them. */
  packageItems: string[];
  setMenuTemplateId: string | null;
  /** The kitchen plan's and the bar's lines; a set menu's chosen option carries its group's id. */
  menuLines: Array<{ itemName: string; quantity: number; productCode: string | null; groupId: string | null }>;
  entertainment: Array<{ templateId: string | null; name: string }>;
}

/** What the fill answered, as the dialog reads it. */
export interface FetchAnswer {
  fill: unknown;
  review: BeoAiReview | null;
  /** The chat's newest line when it was read; the declined memory is keyed by it. */
  chatMark: string | null;
  /** The catalogue section as the BEO holds it at the read. */
  held: FetchHeldCatalogue;
}

/**
 * A change the chat brings to the catalogue section, listed to read: the
 * fetch applies none of these (the package, set menu, food and entertainment
 * are chosen in their own sections, or through AI Fill's review).
 */
export interface FetchCatalogueChange {
  section: "package" | "addOn" | "setMenu" | "choice" | "food" | "entertainment" | "other";
  label: string;
  /** What the BEO holds, as a person reads it ("—" when nothing). */
  was: string;
  /** What the chat says. */
  now: string;
  from: BeoAiFrom | null;
}

export const FETCH_LABELS: Record<FetchField, string> = {
  eventDate: "Date",
  title: "Title",
  childName: "Child",
  bookingName: "Booking name",
  numChildren: "Children",
  numAdults: "Adults",
  startTime: "Start time",
  endTime: "End time",
  locationText: "Location",
  specialRequests: "Special requests",
  activities: "Activities",
  decoration: "Decoration",
  setupReadyBy: "Setup ready by",
  setupResponsible: "Setup who",
  cakeMode: "Cake",
  cakeNotes: "Cake notes",
  cakeTime: "Cake time",
  packageName: "POS package",
  prepaymentReceived: "Deposit",
  depositDate: "Deposit date",
  packageNotes: "POS notes",
};
/** The rows in the form's own order. */
const FIELD_ORDER = Object.keys(FETCH_LABELS) as FetchField[];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NONE = "—";

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*\d[\d,]*(\.\d+)?\s*$/.test(v)) return Number(v.replace(/,/g, ""));
  return null;
};
const time = (v: unknown): string | null => {
  const t = str(v)?.replace(".", ":") ?? null;
  return t && TIME.test(t) ? t : null;
};
const day = (v: unknown): string | null => {
  const d = str(v);
  return d && DAY.test(d) ? d : null;
};
const sameText = (a: string, b: string) => a.normalize("NFC").trim() === b.normalize("NFC").trim();
const shownText = (v: string) => (v.trim() ? v.trim() : NONE);
const cakeLabel = (mode: string) => (mode in AI_FILL_CAKE_TYPE ? AI_FILL_CAKE_TYPE[mode as keyof typeof AI_FILL_CAKE_TYPE] : mode || NONE);

/** The ruling message read alone is the team's confirmation. */
const TEAM: BeoAiFrom = { source: "team", at: null, line: null };

/**
 * Every change the fetch's answer brings against the form: a value the chat
 * gives that the form does not hold (a field it leaves empty, or holds
 * differently). A value the chat does not give changes nothing, and a field
 * is never offered emptied.
 */
export function fetchChangesOf(answer: Pick<FetchAnswer, "fill" | "review">, form: FetchFormValues): FetchChange[] {
  const fill = asRecord(answer.fill);
  const event = asRecord(fill.event);
  const setup = asRecord(fill.setupPlan);
  const kitchen = asRecord(fill.kitchenPlan);
  const party = asRecord(fill.partyDetails);
  const proposal = answer.review?.proposal ?? null;
  const ruling = answer.review?.ruling ?? TEAM;
  const changes: FetchChange[] = [];
  const offer = (field: FetchField, was: string, now: string, value: string | number, from: BeoAiFrom | null, said: string | null = null) =>
    changes.push({ field, label: FETCH_LABELS[field], was, now, value, from, said });

  // The form's text fields, from the fill (the ruling message, the form as its baseline).
  const text = (field: Extract<FetchField, "title" | "bookingName" | "locationText" | "specialRequests" | "activities" | "decoration">, read: unknown) => {
    const value = str(read);
    if (value && !sameText(form[field], value)) offer(field, shownText(form[field]), value, value, ruling);
  };
  text("title", event.title);
  text("bookingName", event.bookingName);
  text("locationText", event.locationText);
  text("specialRequests", event.specialRequests);
  text("activities", event.activities);
  text("decoration", event.decoration);

  // The child, the counts and the times: the whole conversation's reading where there is one.
  const childName = proposal?.event.childName ? { value: proposal.event.childName.value, from: proposal.event.childName.from } : { value: str(event.childName), from: ruling };
  if (childName.value && !sameText(form.childName, childName.value)) offer("childName", shownText(form.childName), childName.value, childName.value, childName.from);
  for (const field of ["numChildren", "numAdults"] as const) {
    const read = proposal?.event[field] ? { value: proposal.event[field]!.value, from: proposal.event[field]!.from } : { value: num(event[field]), from: ruling };
    if (read.value !== null && Number.isInteger(read.value) && read.value >= 0 && read.value !== form[field]) {
      offer(field, form[field] === null ? NONE : String(form[field]), String(read.value), read.value, read.from);
    }
  }
  for (const field of ["startTime", "endTime"] as const) {
    const read = proposal?.event[field] ? { value: time(proposal.event[field]!.value), from: proposal.event[field]!.from } : { value: time(event[field]), from: ruling };
    if (read.value && read.value !== form[field]) offer(field, shownText(form[field]), read.value, read.value, read.from);
  }

  // The date: as SCRUM-814 has it, never applied silently — here one row to accept.
  const date = aiFillDateLine(answer.fill, form.eventDate || null);
  if (date?.differs) offer("eventDate", date.booked ? dayLabel(date.booked) : NONE, dayLabel(date.read), date.read, ruling, date.readText);

  // The setup plan's two fields.
  const readyBy = str(setup.readyBy);
  if (readyBy && !sameText(form.setupReadyBy, readyBy)) offer("setupReadyBy", shownText(form.setupReadyBy), readyBy, readyBy, ruling);
  const responsible = str(setup.responsible);
  if (responsible && !sameText(form.setupResponsible, responsible)) offer("setupResponsible", shownText(form.setupResponsible), responsible, responsible, ruling);

  // The cake: whose it is only when the chat says so (never "no cake" over a cake the form holds), its notes and its time.
  const cake = proposal?.cake
    ? { mode: proposal.cake.mode, notes: str(proposal.cake.notes), time: time(proposal.cake.time), from: proposal.cake.from }
    : { mode: str(kitchen.cakeMode)?.toUpperCase() ?? null, notes: str(kitchen.cakeNotes), time: time(kitchen.cakeTime), from: ruling };
  if ((cake.mode === "INTERNAL" || cake.mode === "EXTERNAL") && cake.mode !== form.cakeMode) {
    offer("cakeMode", cakeLabel(form.cakeMode), cakeLabel(cake.mode), cake.mode, cake.from);
  }
  if (cake.notes && !sameText(form.cakeNotes, cake.notes)) offer("cakeNotes", shownText(form.cakeNotes), cake.notes, cake.notes, cake.from);
  if (cake.time && cake.time !== form.cakeTime) offer("cakeTime", shownText(form.cakeTime), cake.time, cake.time, cake.from);

  // Party Details: the POS package's name, the deposit and its day, the notes.
  const packageName = str(party.packageName);
  if (packageName && !sameText(form.packageName, packageName)) offer("packageName", shownText(form.packageName), packageName, packageName, ruling);
  // The deposit the form holds is the one RECEIVED. The whole chat's reading
  // says whether it was: a deposit only asked for ("please transfer 5,000")
  // is billing's deposit required, which this fetch does not cover, so it
  // offers nothing — never the asked-for amount as received.
  const deposit = proposal?.deposit
    ? proposal.deposit.paid
      ? { amount: proposal.deposit.amount, date: day(proposal.deposit.date), from: proposal.deposit.from }
      : { amount: null, date: null, from: proposal.deposit.from }
    : { amount: num(party.prepaymentReceived), date: day(party.depositDate), from: ruling };
  if (deposit.amount !== null && deposit.amount > 0 && deposit.amount !== form.prepaymentReceived) {
    offer("prepaymentReceived", form.prepaymentReceived > 0 ? thb(form.prepaymentReceived) : NONE, thb(deposit.amount), deposit.amount, deposit.from);
  }
  if (deposit.date && deposit.date !== form.depositDate) {
    offer("depositDate", form.depositDate ? dayLabel(form.depositDate) : NONE, dayLabel(deposit.date), deposit.date, deposit.from);
  }
  const notes = str(party.notes);
  if (notes && !sameText(form.packageNotes, notes)) offer("packageNotes", shownText(form.packageNotes), notes, notes, ruling);

  return changes.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
}

const sameName = (a: string, b: string) => a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase();
const withQty = (name: string, quantity: number) => (quantity > 1 ? `${name} × ${quantity}` : name);
const MENU_LABEL: Record<BeoAiMenu, string> = { kids: "Kids menu", adults: "Adults menu", bar: "Bar" };

/**
 * Every change the chat brings to the catalogue section, against what the
 * BEO holds: a package other than the applied one, an add-on its lines lack,
 * another set menu or a choice not chosen, a food or drink line the lists
 * lack (or hold at another quantity), entertainment not selected, and a line
 * the catalogue lacks that Special Requests does not carry (the approval
 * keeps those there). Listed to read; nothing here is applied by a fetch.
 */
export function fetchCatalogueChangesOf(review: BeoAiReview | null, held: FetchHeldCatalogue, form: Pick<FetchFormValues, "specialRequests">): FetchCatalogueChange[] {
  if (!review) return [];
  const p = review.proposal;
  const cat = review.catalogue;
  const changes: FetchCatalogueChange[] = [];
  const list = (section: FetchCatalogueChange["section"], label: string, was: string, now: string, from: BeoAiFrom | null) =>
    changes.push({ section, label, was, now, from });
  const known = (names: string[], name: string) => names.some((n) => sameName(n, name));

  if (p.package) {
    const pkg = cat.packages.find((x) => x.id === p.package!.templateId);
    const name = pkg?.name ?? p.package.said ?? "another package";
    const applied = held.package && (held.package.templateId === p.package.templateId || sameName(held.package.name, name));
    if (!applied) list("package", "Package", held.package?.name ?? NONE, name, p.package.from);
    for (const a of p.addOns) {
      const label = pkg?.lines.find((l) => l.id === a.lineId)?.label ?? a.said;
      if (a.quantity > 0 && label && !known(held.packageItems, label)) list("addOn", "Add-on", NONE, withQty(label, a.quantity), a.from);
    }
  }

  if (p.setMenu) {
    const menu = cat.setMenus.find((m) => m.id === p.setMenu!.templateId);
    if (held.setMenuTemplateId !== p.setMenu.templateId) {
      const was = held.setMenuTemplateId ? (cat.setMenus.find((m) => m.id === held.setMenuTemplateId)?.name ?? "another set menu") : NONE;
      list("setMenu", "Set menu", was, menu?.name ?? "another set menu", p.setMenu.from);
    }
    for (const c of p.setMenu.choices) {
      const chosen = held.menuLines.filter((l) => l.groupId === c.itemId).map((l) => l.itemName);
      if (known(chosen, c.option)) continue;
      const group = menu?.items.find((i) => i.id === c.itemId);
      list("choice", group ? `Set menu · ${group.label}` : "Set menu choice", chosen.length > 0 ? chosen.join(", ") : NONE, c.option, c.from);
    }
  }

  for (const l of p.menuLines) {
    const name = l.matchedName ?? l.itemName;
    const line = held.menuLines.find(
      (h) => (l.productCode && h.productCode && h.productCode.toUpperCase() === l.productCode.toUpperCase()) || sameName(h.itemName, name) || sameName(h.itemName, l.itemName),
    );
    if (line && line.quantity === l.quantity) continue;
    const now = withQty(name, l.quantity) + (l.notInMenu ? " (not on the menu)" : "");
    list("food", MENU_LABEL[l.menu], line ? withQty(line.itemName, line.quantity) : NONE, now, l.from);
  }

  for (const e of p.entertainment) {
    if (held.entertainment.some((h) => (e.templateId && h.templateId === e.templateId) || sameName(h.name, e.name))) continue;
    list("entertainment", "Entertainment", NONE, withQty(e.name, e.quantity) + (e.notInCatalogue ? " (not on the menu)" : ""), e.from);
  }

  for (const o of p.otherLines) {
    if (!form.specialRequests.normalize("NFC").toLowerCase().includes(o.text.normalize("NFC").trim().toLowerCase())) list("other", "Also asked", NONE, o.text, o.from);
  }

  return changes;
}

/** "2 changes to the package, menu or entertainment", "1 change to the package, menu or entertainment". */
export const catalogueChangesCount = (n: number) => `${n} change${n === 1 ? "" : "s"} to the package, menu or entertainment`;

/** The standing line under the catalogue changes: what a fetch does with them. */
export const CATALOGUE_CHANGES_LINE =
  "Listed to read, not applied here: the package, set menu, food and entertainment are chosen in their own sections, or by pasting the line into AI Fill.";

/** A change's identity for the memory: the field and the value the chat gives it. */
export const changeKey = (change: Pick<FetchChange, "field" | "value">): string => `${change.field}=${String(change.value)}`;

/** The changes declined on a fetch, held until the chat changes (its newest line moves). */
export interface DeclinedChanges {
  chatMark: string | null;
  keys: readonly string[];
}
export const NO_DECLINED: DeclinedChanges = { chatMark: null, keys: [] };

/** The changes to offer: those declined on the same chat are held back, and counted. */
export function offeredChanges(changes: FetchChange[], declined: DeclinedChanges, chatMark: string | null): { offered: FetchChange[]; held: number } {
  if (declined.keys.length === 0 || declined.chatMark !== chatMark) return { offered: changes, held: 0 };
  const offered = changes.filter((c) => !declined.keys.includes(changeKey(c)));
  return { offered, held: changes.length - offered.length };
}

/** The memory after a fetch: the declined changes added to the same chat's, or a new chat's on their own. */
export function rememberDeclined(declined: DeclinedChanges, chatMark: string | null, changes: FetchChange[]): DeclinedChanges {
  const keys = changes.map(changeKey);
  if (declined.chatMark === chatMark) return { chatMark, keys: [...new Set([...declined.keys, ...keys])] };
  return { chatMark, keys };
}

/** The accepted changes as a patch of the form. */
export function applyFetchChanges(accepted: FetchChange[]): Partial<FetchFormValues> {
  const patch: Record<string, string | number> = {};
  for (const c of accepted) patch[c.field] = c.value;
  return patch as Partial<FetchFormValues>;
}

/** "3 changes from the chat", "1 change from the chat". */
export const changesCount = (n: number) => `${n} change${n === 1 ? "" : "s"} from the chat`;

/** The words under a fetch that brings nothing new, with what the memory held back. */
export function nothingNewLine(held: number): string {
  if (held === 0) return "The chat reads the same as the form.";
  return `The chat reads the same as the form. ${held} change${held === 1 ? "" : "s"} you declined earlier ${held === 1 ? "is" : "are"} not offered again until the chat changes.`;
}
