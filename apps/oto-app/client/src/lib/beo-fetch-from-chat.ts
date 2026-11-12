import { beoAiMatchLabel, foodNamesFor, laterLineWins, type BeoAiFrom, type BeoAiMenu, type BeoAiRequestKind, type BeoAiReview, type BeoAiSourced } from "@shared/beoAiFill";
import { aiFillDateLine, dayLabel } from "./beo-ai-date";
import { AI_FILL_CAKE_TYPE } from "./beo-ai-preview";
import { depositOpensPaid, namesPhone, requestLineText, requestsOfField, reviewDateLine, samePhone, thb, tillMatchOf, type ApprovedMarks } from "./beo-ai-review";

/**
 * "FETCH FROM CHAT" ON THE BEO FORM (SCRUM-826) — the diff and the memory.
 *
 * The BEO was filled from the conversation when it was created (SCRUM-815)
 * and the form has been edited since; the chat has moved on too. The owner's
 * rule: a Fetch warns first, reads the conversation again, and LISTS every
 * change it brings — the field, what the form holds now and what the chat
 * says — each accepted or declined; nothing typed is overwritten silently, a
 * declined field is not offered again until the chat has a new line, and
 * what is accepted lands in the form as any edit does, unsaved until Save.
 *
 * The read is the existing fill path (`POST …/beo/ai-fill/inbox`, with
 * `purpose: "fetch"`): the free-text fill of the ruling message with the form
 * as its baseline, and, with the park's catalogue, the catalogue proposal read
 * from the WHOLE conversation with each value's source. The diff takes the
 * counts, the times, the child, the cake and the deposit from that proposal
 * (the whole chat as it is now: the latest line wins, whoever wrote it —
 * `laterLineWins`) and the rest of the form's own text
 * fields from the fill; those are the fields the form types, and the only
 * ones a fetch applies. The title is the one exception: the fill's own
 * `event.title` is the model's guess and is never offered (SCRUM-827); the
 * title a fetch offers is the park's default the proposal carries — the
 * app's own naming rule from the child and the age — marked as such. The catalogue section — the package and its add-ons,
 * the set menu and its choices, the food lines, the entertainment, a line the
 * catalogue lacks — is what Create BEO's review and approval write: a fetch
 * LISTS what the chat says there against what the BEO holds
 * (`fetchCatalogueChangesOf`), to read, and applies none of it, so the list
 * is every change the chat brings and "reads the same" is true when said.
 * Pure, so the app's check holds it.
 *
 * SCRUM-903: the fill runs with no message of the team's confirming the
 * party yet; the conversation's read is then the only one (`review.ruling`
 * null, nothing in the fill), and the special requests, activities and
 * decoration a fetch offers are the conversation's own requests, each with
 * its line. Every change's `from` carries the chat's words for it, shown
 * under the row.
 */

/**
 * What the form holds now, in the fields a fetch knows. SCRUM-904: the
 * fields the conversation's read gives since Phase B are optional, so a
 * caller from before it holds nothing there.
 */
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
  /** SCRUM-904: the family's WhatsApp number, the age the child turns, the setup plan's notes. */
  whatsappPhoneRaw?: string;
  kidTurningAge?: number | null;
  setupNotes?: string;
  /** SCRUM-904: how many cakes, "included" or "extra" (the cake's INCL/EXTRA), its price in baht. */
  cakeQuantity?: number | null;
  cakeIncluded?: "included" | "extra" | "";
  cakePrice?: number;
  /** SCRUM-904: when the kids' and the adults' food is served, and when the bar serves the drinks. */
  kidsFoodTime?: string;
  adultsFoodTime?: string;
  barServiceTime?: string;
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
  /**
   * SCRUM-946: a line of the chat's added under what a text field holds (a
   * request, a note), offered on its own so each can be accepted alone: the
   * line, and the text it is added under. The lines accepted for one field are
   * added together (`applyFetchChanges`).
   */
  line?: string;
  base?: string;
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
  kidTurningAge: "Age",
  bookingName: "Booking name",
  whatsappPhoneRaw: "WhatsApp",
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
  setupNotes: "Setup notes",
  cakeMode: "Cake",
  cakeNotes: "Cake notes",
  cakeTime: "Cake time",
  cakeQuantity: "Cakes",
  cakeIncluded: "Cake in the package",
  cakePrice: "Cake price",
  kidsFoodTime: "Kids' food",
  adultsFoodTime: "Adults' food",
  barServiceTime: "Bar service",
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
/** SCRUM-904: whether typed text already holds a line, case and spacing aside (an allergy's line with or without its "Allergy: "). */
const foldText = (t: string) => t.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
/**
 * SCRUM-946: the words a line says, in order, case and punctuation aside (a
 * Thai word keeps its marks), with the lead-in words before what it says left
 * out: "Allergy: Important: she is allergic to peanuts" says "she is allergic
 * to peanuts".
 */
const LEAD_IN = new Set(["allergy", "allergies", "important", "note", "notes", "nb", "please", "pls", "also", "and", "ps", "fyi", "btw", "attention", "reminder", "สำคัญ", "หมายเหตุ", "важно", "внимание", "также", "примечание"]);
const wordsOf = (t: string): string[] => t.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
export function saidWordsOf(line: string): string[] {
  const words = wordsOf(line);
  let at = 0;
  while (at < words.length - 1 && LEAD_IN.has(words[at]!)) at += 1;
  return words.slice(at);
}
/**
 * SCRUM-946: whether typed text already says a line — the line's words (its
 * lead-in aside) stand in the text in that order, whatever the case, the
 * punctuation or the lead-in either is written with (the 12 November proof:
 * "Allergy: Important: she is allergic to peanuts" was offered beside
 * "Allergy: she is allergic to peanuts").
 */
export function saysAlready(held: string, line: string): boolean {
  const said = saidWordsOf(line).join(" ");
  if (!said) return true;
  return ` ${wordsOf(held).join(" ")} `.includes(` ${said} `);
}
const holds = saysAlready;
const CAKE_INCLUDED: Record<"included" | "extra", string> = { included: "In the package", extra: "Extra" };
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
  // SCRUM-903: a review read with no ruling message has none (null); its fill holds nothing.
  const ruling = answer.review ? answer.review.ruling : TEAM;
  const changes: FetchChange[] = [];
  const offer = (field: FetchField, was: string, now: string, value: string | number, from: BeoAiFrom | null, said: string | null = null) =>
    changes.push({ field, label: FETCH_LABELS[field], was, now, value, from, said });

  // The form's text fields, from the fill (the ruling message, the form as its baseline).
  const text = (field: Extract<FetchField, "bookingName" | "locationText" | "specialRequests" | "activities" | "decoration">, read: unknown, from = ruling) => {
    const value = str(read);
    if (value && !sameText(form[field], value)) offer(field, shownText(form[field]), value, value, from);
  };
  /**
   * SCRUM-904: the conversation's own lines for a text field the form may
   * already hold words in: offered BESIDE what is typed — the typed text
   * stays, the chat's lines it lacks are added under it — never in its
   * place; nothing when the form holds every line already.
   */
  const beside = (field: Extract<FetchField, "specialRequests" | "activities" | "decoration" | "setupNotes" | "packageNotes">, lines: Array<{ text: string; from: BeoAiFrom }>) => {
    const held = (form[field] ?? "").trim();
    // SCRUM-946: by what is said, never twice (two lines of the chat saying one thing are one).
    const missing: typeof lines = [];
    for (const l of lines) if (!holds(held, l.text) && !missing.some((m) => saysAlready(m.text, l.text))) missing.push(l);
    if (missing.length === 0) return;
    // A line that already holds every typed word (a read with the form as its baseline) stands in
    // the typed text's place, so the typed text is neither lost nor written twice.
    const container = held ? missing.find((l) => foldText(l.text).includes(foldText(held))) : undefined;
    if (container) {
      const value = [container.text, ...missing.filter((l) => l !== container).map((l) => l.text)].join("\n");
      offer(field, shownText(held), value, value, missing.reduce((a, l) => (laterLineWins(l.from, a) ? l.from : a), missing[0]!.from));
      return;
    }
    // SCRUM-946: each new line on its own, so one can be accepted without another.
    for (const l of missing) {
      const value = [held, l.text].filter(Boolean).join("\n");
      changes.push({ field, label: FETCH_LABELS[field], was: shownText(held), now: value, value, from: l.from, said: null, line: l.text, base: held });
    }
  };
  // SCRUM-903: with no ruling message, the conversation's own requests of a kind, one per line (SCRUM-904: allergies first).
  // SCRUM-946: a line writing out the WhatsApp number the form holds (or the chat's, offered as
  // the WhatsApp row) is that number, never a Special requests line as well.
  const phones = [form.whatsappPhoneRaw, proposal?.event.whatsapp?.value];
  const requests = (kind: Exclude<BeoAiRequestKind, "allergy">) =>
    requestsOfField((proposal?.details.requests ?? []).filter((r) => !namesPhone(r.text, phones)), kind).map((r) => ({ text: requestLineText(r), from: r.from }));
  // SCRUM-904: the rest of the form the conversation's read gives (the ruling's read only where it gives nothing).
  const detail = (chat: BeoAiSourced<string> | null | undefined, read: unknown): { value: string | null; from: BeoAiFrom | null } =>
    chat ? { value: str(chat.value), from: chat.from } : { value: str(read), from: ruling };
  // SCRUM-827: the title is never the model's own (`event.title` is its guess): the one a
  // fetch offers is the park's default the proposal carries — the app's naming rule from the
  // child and the age — and only where it differs from the form, marked as the default.
  const title = proposal?.details.title ?? null;
  if (title && !sameText(form.title, title.value)) offer("title", shownText(form.title), title.value, title.value, title.from);
  const bookingName = detail(proposal?.details.bookingName, event.bookingName);
  text("bookingName", bookingName.value, bookingName.from);
  // SCRUM-904: the family's WhatsApp number when the chat gives another than the form's.
  const phone = proposal?.event.whatsapp;
  if (phone && !samePhone(form.whatsappPhoneRaw ?? "", phone.value)) {
    offer("whatsappPhoneRaw", shownText(form.whatsappPhoneRaw ?? ""), phone.value, phone.value, phone.from);
  }
  const location = detail(proposal?.details.locationText, event.locationText);
  text("locationText", location.value, location.from);
  for (const [field, kind] of [
    ["specialRequests", "special_request"],
    ["activities", "activity"],
    ["decoration", "decoration"],
  ] as const) {
    // SCRUM-904: the conversation's lines beside what is typed, never over it.
    if (answer.review && !ruling) beside(field, requests(kind));
    else text(field, event[field]);
  }
  // SCRUM-904: the age the child turns.
  const age = proposal?.event.childAge;
  if (age && age.value !== (form.kidTurningAge ?? null)) {
    offer("kidTurningAge", typeof form.kidTurningAge === "number" ? String(form.kidTurningAge) : NONE, String(age.value), age.value, age.from);
  }

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
  // SCRUM-904: the conversation's own date first (its words and its line), the ruling's read for a gap.
  const date: (ReturnType<typeof aiFillDateLine> & { from?: BeoAiFrom | null }) | null = answer.review
    ? reviewDateLine(answer.review, answer.fill, form.eventDate || null)
    : aiFillDateLine(answer.fill, form.eventDate || null);
  const dateFrom = date?.from !== undefined ? date.from : ruling;
  if (date?.differs) offer("eventDate", date.booked ? dayLabel(date.booked) : NONE, dayLabel(date.read), date.read, dateFrom, date.readText);

  // The setup plan's fields.
  const readyBy = detail(proposal?.details.setup.readyBy, setup.readyBy);
  if (readyBy.value && !sameText(form.setupReadyBy, readyBy.value)) offer("setupReadyBy", shownText(form.setupReadyBy), readyBy.value, readyBy.value, readyBy.from);
  const responsible = detail(proposal?.details.setup.responsible, setup.responsible);
  if (responsible.value && !sameText(form.setupResponsible, responsible.value)) {
    offer("setupResponsible", shownText(form.setupResponsible), responsible.value, responsible.value, responsible.from);
  }
  // SCRUM-904: the setup plan's notes, beside what is typed.
  const setupNotes = proposal?.details.setup.notes;
  if (setupNotes) beside("setupNotes", [{ text: setupNotes.value, from: setupNotes.from }]);

  // The cake: whose it is only when the chat says so, its notes and its time.
  // The whole conversation's reading leaves the cake out when the chat does
  // not speak to it and gives no type (SCRUM-787's "not said") when it times
  // or describes a cake without saying whose: neither moves the form's cake.
  // It says NONE only when the family or the team said there is no cake, and
  // that is offered as "No cake" over a cake the form holds, with whose line
  // said it (its words are no cake notes, and a declined cake has no time).
  // The fill alone (no catalogue) reads NONE as AI Fill does: nothing to apply.
  const cake = proposal?.cake
    ? { mode: proposal.cake.mode, notes: str(proposal.cake.notes), time: time(proposal.cake.time), from: proposal.cake.from }
    : { mode: str(kitchen.cakeMode)?.toUpperCase() ?? null, notes: str(kitchen.cakeNotes), time: time(kitchen.cakeTime), from: ruling };
  const cakeDeclined = !!proposal?.cake && proposal.cake.mode === "NONE";
  if (cakeDeclined) {
    if (form.cakeMode === "INTERNAL" || form.cakeMode === "EXTERNAL") offer("cakeMode", cakeLabel(form.cakeMode), cakeLabel("NONE"), "NONE", cake.from);
  } else {
    if ((cake.mode === "INTERNAL" || cake.mode === "EXTERNAL") && cake.mode !== form.cakeMode) {
      offer("cakeMode", cakeLabel(form.cakeMode), cakeLabel(cake.mode), cake.mode, cake.from);
    }
    if (cake.notes && !sameText(form.cakeNotes, cake.notes)) offer("cakeNotes", shownText(form.cakeNotes), cake.notes, cake.notes, cake.from);
    if (cake.time && cake.time !== form.cakeTime) offer("cakeTime", shownText(form.cakeTime), cake.time, cake.time, cake.from);
    // SCRUM-904: how many cakes, whether it comes with the package and its price, only as the chat says them.
    const more = proposal?.cake;
    if (more?.quantity !== undefined && more.quantity !== (form.cakeQuantity ?? null)) {
      offer("cakeQuantity", typeof form.cakeQuantity === "number" ? String(form.cakeQuantity) : NONE, String(more.quantity), more.quantity, more.from);
    }
    if (more?.included !== undefined) {
      const now = more.included ? "included" : "extra";
      if (now !== (form.cakeIncluded || "")) offer("cakeIncluded", form.cakeIncluded ? CAKE_INCLUDED[form.cakeIncluded] : NONE, CAKE_INCLUDED[now], now, more.from);
    }
    if (more?.price !== undefined && more.price !== (form.cakePrice ?? 0)) {
      offer("cakePrice", form.cakePrice ? thb(form.cakePrice) : NONE, thb(more.price), more.price, more.from);
    }
  }
  // SCRUM-904: when the kids' and the adults' food is served, and when the bar serves the drinks.
  for (const field of ["kidsFoodTime", "adultsFoodTime", "barServiceTime"] as const) {
    const read = proposal?.event[field];
    const value = read ? time(read.value) : null;
    if (read && value && value !== (form[field] ?? "")) offer(field, shownText(form[field] ?? ""), value, value, read.from);
  }

  // Party Details: the POS package's name, the deposit and its day, the notes.
  const packageName = detail(proposal?.details.pos.name, party.packageName);
  if (packageName.value && !sameText(form.packageName, packageName.value)) {
    offer("packageName", shownText(form.packageName), packageName.value, packageName.value, packageName.from);
  }
  // The deposit the form holds is the one RECEIVED. The whole chat's reading
  // says whether it was: a deposit only asked for ("please transfer 5,000")
  // is billing's deposit required, which this fetch does not cover, so it
  // offers nothing — never the asked-for amount as received.
  // SCRUM-904: with no team confirmation, a deposit only the family says was paid is read as
  // asked (the review's rule, SCRUM-903): never offered as received.
  const deposit = proposal?.deposit
    ? proposal.deposit.paid && depositOpensPaid(answer.review!)
      ? { amount: proposal.deposit.amount, date: day(proposal.deposit.date), from: proposal.deposit.from }
      : { amount: null, date: null, from: proposal.deposit.from }
    : { amount: num(party.prepaymentReceived), date: day(party.depositDate), from: ruling };
  if (deposit.amount !== null && deposit.amount > 0 && deposit.amount !== form.prepaymentReceived) {
    offer("prepaymentReceived", form.prepaymentReceived > 0 ? thb(form.prepaymentReceived) : NONE, thb(deposit.amount), deposit.amount, deposit.from);
  }
  if (deposit.date && deposit.date !== form.depositDate) {
    offer("depositDate", form.depositDate ? dayLabel(form.depositDate) : NONE, dayLabel(deposit.date), deposit.date, deposit.from);
  }
  // SCRUM-904: the conversation's notes on the bill (it never sees the form) go BESIDE what is
  // typed, never in its place; the ruling message's own read, with the form as its baseline, is
  // offered as before only where the proposal holds none.
  const posNotes = proposal?.details.pos.notes;
  if (posNotes?.value.trim()) {
    beside("packageNotes", [{ text: posNotes.value.trim(), from: posNotes.from }]);
  } else {
    const notes = { value: str(party.notes), from: ruling };
    if (notes.value && !sameText(form.packageNotes, notes.value)) offer("packageNotes", shownText(form.packageNotes), notes.value, notes.value, notes.from);
  }

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
    // SCRUM-926: a code several options share ("Fried rice" Veggie, Chicken, Pork) is the same dish only by its name too.
    // SCRUM-946: the names the party's own set menu gives the code.
    const shared = !!l.productCode && foodNamesFor(cat, l.productCode, p.setMenu?.templateId ?? null).length > 1;
    const line = held.menuLines.find(
      (h) =>
        (l.productCode && h.productCode && h.productCode.toUpperCase() === l.productCode.toUpperCase() && (!shared || sameName(h.itemName, name))) ||
        sameName(h.itemName, name) ||
        sameName(h.itemName, l.itemName),
    );
    if (line && line.quantity === l.quantity) continue;
    // SCRUM-904: the chat's note on the dish rides with it.
    // SCRUM-944: a dish or drink the till sells, as the review shows it: the chat's words, the till's
    // item and code, and the till's price.
    const till = l.notInMenu ? null : tillMatchOf(review, l.productCode);
    const said = till ? `${withQty(beoAiMatchLabel(l.itemName, name, l.productCode), l.quantity)} · Till ${thb(till.price)}` : withQty(name, l.quantity);
    const now = said + (l.notInMenu ? " (not on the menu)" : "") + (l.notes ? ` — ${l.notes}` : "");
    list("food", MENU_LABEL[l.menu], line ? withQty(line.itemName, line.quantity) : NONE, now, l.from);
  }

  for (const e of p.entertainment) {
    if (held.entertainment.some((h) => (e.templateId && h.templateId === e.templateId) || sameName(h.name, e.name))) continue;
    // SCRUM-904: a show the chat times, with its time.
    list("entertainment", "Entertainment", NONE, withQty(e.name, e.quantity) + (e.notInCatalogue ? " (not on the menu)" : "") + (e.time ? ` at ${e.time}` : ""), e.from);
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

/**
 * A change's identity for the memory and the list: its FIELD. A fetch offers
 * each field at most once, and a declined field is held back whatever value
 * the chat gives it next (the proof of 11 November: "Adults → 6" declined,
 * "Adults → 5" slipped through), until the chat has a new line.
 */
export const changeKey = (change: Pick<FetchChange, "field" | "line">): string =>
  change.line !== undefined ? `${change.field}:${saidWordsOf(change.line).join(" ")}` : change.field;

/**
 * The fields declined on a fetch, held until the chat changes (its newest line
 * moves). SCRUM-946: a line added under a text field is held on its own
 * (`changeKey`: the field and the line's words).
 */
export interface DeclinedChanges {
  chatMark: string | null;
  fields: readonly string[];
}
export const NO_DECLINED: DeclinedChanges = { chatMark: null, fields: [] };

/** The changes to offer: the fields declined on the same chat are held back, and counted. */
export function offeredChanges(changes: FetchChange[], declined: DeclinedChanges, chatMark: string | null): { offered: FetchChange[]; held: number } {
  if (declined.fields.length === 0 || declined.chatMark !== chatMark) return { offered: changes, held: 0 };
  const offered = changes.filter((c) => !declined.fields.includes(changeKey(c)));
  return { offered, held: changes.length - offered.length };
}

/**
 * The memory after a fetch: the declined fields added to the same chat's (a
 * new chat's — the newest line moved — start on their own, so every field
 * held before is offered again), and a field accepted this time let go.
 */
export function rememberDeclined(declined: DeclinedChanges, chatMark: string | null, refused: FetchChange[], accepted: FetchChange[] = []): DeclinedChanges {
  const kept = declined.chatMark === chatMark ? declined.fields : [];
  const taken = new Set(accepted.map(changeKey));
  const fields = [...new Set([...kept, ...refused.map(changeKey)])].filter((f) => !taken.has(f));
  return { chatMark, fields };
}

/** The accepted changes as a patch of the form. */
export function applyFetchChanges(accepted: FetchChange[]): Partial<FetchFormValues> {
  const patch: Record<string, string | number> = {};
  // SCRUM-946: the lines accepted for one field, added together under what it holds.
  const lines = new Map<FetchField, { base: string; lines: string[] }>();
  for (const c of accepted) {
    if (c.line === undefined) {
      patch[c.field] = c.value;
      continue;
    }
    const held = lines.get(c.field) ?? { base: c.base ?? "", lines: [] };
    held.lines.push(c.line);
    lines.set(c.field, held);
  }
  for (const [field, { base, lines: added }] of lines) patch[field] = [base, ...added].filter(Boolean).join("\n");
  return patch as Partial<FetchFormValues>;
}

/**
 * SCRUM-827: the mark the form wears on a field a fetch re-filled — keyed as
 * the approval's sources key the editor's marks (`ApprovedMarks`): the cake's
 * three fields share the kitchen plan's one mark, the deposit and its day the
 * POS box's, the POS package its name's.
 */
export const FETCH_MARK_KEYS: Record<FetchField, string> = {
  title: "title",
  childName: "childName",
  bookingName: "bookingName",
  numChildren: "numChildren",
  numAdults: "numAdults",
  startTime: "startTime",
  endTime: "endTime",
  eventDate: "eventDate",
  locationText: "locationText",
  specialRequests: "specialRequests",
  activities: "activities",
  decoration: "decoration",
  setupReadyBy: "setupReadyBy",
  setupResponsible: "setupResponsible",
  setupNotes: "setupNotes",
  cakeMode: "cake",
  cakeNotes: "cake",
  cakeTime: "cake",
  cakeQuantity: "cake",
  cakeIncluded: "cake",
  cakePrice: "cake",
  kidTurningAge: "kidTurningAge",
  whatsappPhoneRaw: "whatsapp",
  kidsFoodTime: "kidsFoodTime",
  adultsFoodTime: "adultsFoodTime",
  barServiceTime: "barServiceTime",
  packageName: "posName",
  prepaymentReceived: "deposit",
  depositDate: "deposit",
  packageNotes: "posNotes",
};

/**
 * The marks the accepted changes put on the form: each field's is the line it
 * now came from (the mark of before — another line's, or the park's default —
 * would say where the value no longer came from).
 */
export function fetchedMarksOf(accepted: FetchChange[]): ApprovedMarks {
  const marks: ApprovedMarks = {};
  for (const c of accepted) marks[FETCH_MARK_KEYS[c.field]] = c.from?.source ?? "staff";
  return marks;
}

/** "3 changes from the chat", "1 change from the chat". */
export const changesCount = (n: number) => `${n} change${n === 1 ? "" : "s"} from the chat`;

/** The words under a fetch that brings nothing new, with what the memory held back. */
export function nothingNewLine(held: number): string {
  if (held === 0) return "The chat reads the same as the form.";
  return `The chat reads the same as the form. ${held} change${held === 1 ? "" : "s"} you declined earlier ${held === 1 ? "is" : "are"} not offered again until the chat changes.`;
}
