import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  beoSetMenuTemplates,
  birthdayPackageTemplates,
  entertainmentPackageTemplates,
  packageLineItemTemplates,
} from "@shared/schema";
import {
  BEO_AI_CAKE_MODES,
  BEO_AI_MENUS,
  BEO_AI_QUOTE_MAX,
  BEO_AI_REQUEST_KINDS,
  asksForMore,
  beoEventTitleOf,
  emptyBeoAiDetails,
  foodNameFor,
  foodNamesFor,
  foodOfSetMenus,
  foodOptionNamed,
  codedLineNameOf,
  setMenuOptionOf,
  tillItemOf,
  laterLineWins,
  type BeoAiCatalogueView,
  type BeoAiDetails,
  type BeoAiFood,
  type BeoAiFrom,
  type BeoAiMenu,
  type BeoAiProposal,
  type BeoAiRequestKind,
  type BeoAiSetMenuItem,
  type BeoAiSource,
  type BeoAiSourced,
} from "@shared/beoAiFill";
import { BeoFillSchema, parkClockAt, type BeoFill } from "./aiFill";
import type { InboxTranscriptLine } from "./inboxConfirmation";
import type { DbExecutor } from "./packageSnapshot";

/**
 * THE BEO FILLED FROM THE WHOLE CONVERSATION AND MATCHED TO THE CATALOGUE
 * (SCRUM-815), the server's half.
 *
 * Create BEO's AI Fill used to read one message (the team's final
 * confirmation) and answer free text: a package's name, menu lines by name,
 * activities as a sentence. That read stays as it was (the form's own fields,
 * from the ruling message alone). Beside it, with the park's catalogue
 * (`loadBeoCatalogue`), the model reads the conversation (the platform's
 * `transcript`, the ruling message marked in it) and answers only a
 * `catalogue` section: the package, set menu and choices, add-ons,
 * entertainment and extra menu lines BY ID, the counts, times, cake and
 * deposit, each with the line it came from. `resolveCatalogueAnswer` checks
 * every id against the catalogue the model was handed (an id it does not hold
 * is a free line in the message's own words), and the source of every value
 * is the transcript's — the line's author — never the model's say-so.
 *
 * The food the fill matches to is what the park's set menus name with a till
 * product code (SCRUM-803) and, SCRUM-944 (Phase C), the party's park's till
 * menu itself (`catalogue.till`, read through SCRUM-905's door,
 * server/lib/beoFillTillMenu.ts): a code is accepted only when one of the two
 * holds it, and anything else is a free line marked `notInMenu`.
 */

/**
 * The park's catalogue for one party: what the review shows and the model is
 * handed. The park's clock is SCRUM-814's (`AiRouteDeps.parkPlace`), read once
 * per fill, not here.
 */
export type BeoCatalogue = BeoAiCatalogueView;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** A set menu's items as the review and the model read them; an item off its shape is left out. */
function setMenuItemsOf(items: unknown): BeoAiSetMenuItem[] {
  if (!Array.isArray(items)) return [];
  const out: BeoAiSetMenuItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = str(item.id);
    const label = str(item.label);
    if (!id || !label) continue;
    if (item.type === "always_included") {
      out.push({ id, type: "always_included", label, productCode: str(item.productCode), qty: int(item.qty) });
    } else if (item.type === "choice_group" && Array.isArray(item.options)) {
      const options = item.options.filter((o): o is string => typeof o === "string" && o.trim() !== "");
      const codes: Record<string, string | null> = {};
      const given = item.optionProductCodes && typeof item.optionProductCodes === "object" ? (item.optionProductCodes as Record<string, unknown>) : {};
      for (const opt of options) codes[opt] = str(given[opt]);
      out.push({
        id,
        type: "choice_group",
        label,
        options,
        allowMultiple: item.allowMultiple === true,
        productCode: str(item.productCode),
        optionProductCodes: codes,
        qty: int(item.qty),
      });
    }
  }
  return out;
}

/**
 * The food the catalogue knows by till code: every set-menu dish with a code,
 * under the names the menus give it ("Margherita"; a group's own code with an
 * option, "Fried rice (Veggie)"). SCRUM-946: the rule is shared/beoAiFill.ts's,
 * so the review reads a code's names for the party's own set menu the same way.
 */
export { foodOfSetMenus };

/**
 * The catalogue for a party at `branchId`: the park group's active packages
 * sold at that park or at any park, their lines; its active set menus and
 * entertainment menu; the food those set menus code.
 */
export async function loadBeoCatalogue(db: DbExecutor, input: { tenantId: string; branchId: string | null }): Promise<BeoCatalogue> {
  const packages = await db
    .select()
    .from(birthdayPackageTemplates)
    .where(
      and(
        eq(birthdayPackageTemplates.tenantId, input.tenantId),
        eq(birthdayPackageTemplates.isActive, true),
        input.branchId
          ? or(isNull(birthdayPackageTemplates.branchId), eq(birthdayPackageTemplates.branchId, input.branchId))
          : isNull(birthdayPackageTemplates.branchId),
      ),
    )
    .orderBy(asc(birthdayPackageTemplates.sortOrder), asc(birthdayPackageTemplates.name));
  const lines = packages.length
    ? await db
        .select()
        .from(packageLineItemTemplates)
        .where(inArray(packageLineItemTemplates.packageTemplateId, packages.map((p) => p.id)))
        .orderBy(asc(packageLineItemTemplates.sortOrder))
    : [];
  const menus = await db
    .select()
    .from(beoSetMenuTemplates)
    .where(and(eq(beoSetMenuTemplates.tenantId, input.tenantId), eq(beoSetMenuTemplates.isActive, true)))
    .orderBy(asc(beoSetMenuTemplates.createdAt));
  const entertainment = await db
    .select()
    .from(entertainmentPackageTemplates)
    .where(and(eq(entertainmentPackageTemplates.tenantId, input.tenantId), eq(entertainmentPackageTemplates.isActive, true)))
    .orderBy(asc(entertainmentPackageTemplates.sortOrder), asc(entertainmentPackageTemplates.name));
  const setMenus = menus.map((m) => ({ id: m.id, name: m.name, items: setMenuItemsOf(m.items) }));
  return {
    packages: packages.map((p) => ({
      id: p.id,
      name: p.name,
      kidsIncluded: p.kidsIncluded,
      adultsIncluded: p.adultsIncluded,
      hours: p.hours,
      priceWeekday: p.priceWeekday,
      priceWeekend: p.priceWeekend,
      basePrice: p.basePrice,
      setMenuTemplateId: p.setMenuTemplateId,
      lines: lines
        .filter((l) => l.packageTemplateId === p.id)
        .map((l) => ({
          id: l.id,
          label: l.label,
          category: l.category,
          included: l.included,
          qtyDefault: l.qtyDefault,
          unitLabel: l.unitLabel,
          unitPrice: l.defaultUnitPrice,
          priceIsFrom: l.priceIsFrom,
        })),
    })),
    setMenus,
    entertainment: entertainment.map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      durationMinutes: e.durationMinutes,
      price: e.defaultPrice,
      unit: e.unit,
      priceIsFrom: e.priceIsFrom,
    })),
    food: foodOfSetMenus(setMenus),
  };
}

/**
 * No catalogue (a catalogue that could not be read is this). SCRUM-903: the
 * conversation is still read against it; every item the chat names is then a
 * line the catalogue lacks, for staff to keep or leave out.
 */
export const emptyCatalogue = (): BeoCatalogue => ({
  packages: [],
  setMenus: [],
  entertainment: [],
  food: [],
});

// --- The conversation, as the model reads it ------------------------------------------

/** One numbered line of the conversation the model read: who wrote it, when, and whether it is the ruling. */
export interface TranscriptRef {
  line: number;
  id: string;
  source: BeoAiSource;
  at: string;
  ruling: boolean;
  /**
   * SCRUM-903: the line as it was written, for the chat's words a value
   * carries (`quoteOf`). Server only: never sent to the screen whole, never
   * written to the activity row or a log line.
   */
  text?: string;
}

const foldQuote = (t: string) => t.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const clipQuote = (t: string) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length <= BEO_AI_QUOTE_MAX ? one : `${one.slice(0, BEO_AI_QUOTE_MAX - 1).trimEnd()}…`;
};

/**
 * SCRUM-903 — the chat's words for a value, by Book Date's rule
 * (packages/assistant/src/book-date.ts `readBookDateProposal`): the model's
 * own words for it when the line really holds them, else the line itself,
 * each clipped to `BEO_AI_QUOTE_MAX` characters. Null with no line.
 */
export function quoteOf(
  words: string | null | undefined,
  lineText: string | null | undefined,
  /**
   * SCRUM-904: the value itself ("Party Room", 15, "11:00", 3000), to find
   * in a line too long to quote whole when the model's words are not in it.
   */
  hints: ReadonlyArray<string | number | null | undefined> = [],
): string | null {
  if (!lineText || !lineText.trim()) return null;
  const said = words?.trim();
  if (said && foldQuote(lineText).includes(foldQuote(said))) return clipQuote(said);
  const one = lineText.replace(/\s+/g, " ").trim();
  if (one.length <= BEO_AI_QUOTE_MAX) return one;
  // SCRUM-904: a long line (a team's whole confirmation) is quoted around the value's own words,
  // not by its first characters, which can stop before the words that matter.
  // SCRUM-927: and by the words that matter themselves — the sentence that says it, or, in a
  // sentence too long to quote, its clause — never the characters on either side of them.
  const found = findInLine(one, [said, ...hints]);
  return found ? wordsThatMatter(one, found.start, found.end) : clipQuote(one);
}

/**
 * SCRUM-927 (the 12 November proof quoted "…can't reach me, please call my
 * husband on …. We will transfer the 3,000 baht deposit tomorrow. (ZZ TEST)"
 * for the deposit): the sentence of a long line that holds [start, end); in a
 * sentence too long to quote whole, the clause holding it (between commas or
 * semicolons) when it says enough; else the part around it, as before.
 */
function wordsThatMatter(line: string, start: number, end: number): string {
  let from = 0;
  for (const m of line.slice(0, start).matchAll(/[.!?](?:\s+|$)/g)) from = (m.index ?? 0) + m[0].length;
  const stop = /[.!?](?=\s|$)/.exec(line.slice(end));
  const to = stop ? end + stop.index + 1 : line.length;
  const sentence = line.slice(from, to).trim();
  if (sentence && sentence.length <= BEO_AI_QUOTE_MAX) return sentence;
  let clauseFrom = from;
  for (const m of line.slice(from, start).matchAll(/[,;]\s*/g)) clauseFrom = from + (m.index ?? 0) + m[0].length;
  const clauseStop = /[,;]/.exec(line.slice(end, to));
  const clause = line.slice(clauseFrom, clauseStop ? end + clauseStop.index : to).trim();
  if (clause.length >= 12 && clause.length <= BEO_AI_QUOTE_MAX) return clause;
  return quoteAround(line, start, end);
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where in the line a value is written: its words, a number however grouped, a time however written. */
function findInLine(line: string, hints: ReadonlyArray<string | number | null | undefined>): { start: number; end: number } | null {
  const at = (re: RegExp) => {
    const m = re.exec(line);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  };
  for (const hint of hints) {
    if (hint === null || hint === undefined) continue;
    const text = String(hint).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
    if (time) {
      const h = Number(time[1]);
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const mm = time[2]!;
      const hours = [...new Set([String(h), String(h).padStart(2, "0"), String(h12)])].join("|");
      const found =
        at(new RegExp(`(?<!\\d)(?:${hours})[:.]${mm}(?!\\d)`)) ??
        (mm === "00" ? at(new RegExp(`(?<!\\d)(?:${hours})\\s*(?:am|pm|a\\.m\\.|p\\.m\\.|h\\b|o'clock)`, "i")) : null);
      if (found) return found;
      continue;
    }
    if (/^\d+$/.test(text)) {
      // 3000 as "3,000", "3 000" or "3.000".
      const found = at(new RegExp(`(?<!\\d)${text.split("").map(escapeRe).join("[,.\\s]?")}(?!\\d)`));
      if (found) return found;
      continue;
    }
    const whole = at(new RegExp(escapeRe(text).replace(/ /g, "\\s+"), "iu"));
    if (whole) return whole;
  }
  // None is written whole: the longest word of them the line holds (words the model put in other words).
  for (const hint of hints) {
    if (typeof hint !== "string") continue;
    const words = hint.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length);
    for (const w of words) {
      const found = at(new RegExp(escapeRe(w), "iu"));
      if (found) return found;
    }
  }
  return null;
}

/** The part of a long line around [start, end), at most `BEO_AI_QUOTE_MAX` characters, "…" where it is cut. */
function quoteAround(line: string, start: number, end: number): string {
  const room = BEO_AI_QUOTE_MAX - 2;
  if (end - start >= room) return `${start > 0 ? "…" : ""}${line.slice(start, start + room - 1).trimEnd()}…`;
  let from = Math.max(0, start - Math.floor((room - (end - start)) / 2));
  let to = Math.min(line.length, from + room);
  from = Math.max(0, to - room);
  // Whole words at both ends where one is near.
  if (from > 0) {
    const space = line.indexOf(" ", from);
    if (space >= 0 && space < start && space - from <= 15) from = space + 1;
  }
  if (to < line.length) {
    const space = line.lastIndexOf(" ", to);
    if (space > end && to - space <= 15) to = space;
  }
  return `${from > 0 ? "…" : ""}${line.slice(from, to).trim()}${to < line.length ? "…" : ""}`;
}

/** `from` with the chat's words for the value, when its line is known. */
const withQuote = (
  from: BeoAiFrom,
  words: string | null | undefined,
  lineText: string | null | undefined,
  hints?: ReadonlyArray<string | number | null | undefined>,
): BeoAiFrom => {
  const quote = quoteOf(words, lineText, hints);
  return quote ? { ...from, quote } : from;
};

/** The longest conversation handed to the model at once; older lines go first (the ruling never). */
export const TRANSCRIPT_TEXT_MAX = 40_000;

/** "2026-11-05 14:30", the park's own clock (SCRUM-814's `parkClockAt`). */
function localTimeOf(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const clock = parkClockAt(at, timeZone);
  return `${clock.date} ${clock.time}`;
}

/**
 * The conversation as the model reads it, oldest first, one numbered line per
 * message ("#3 [family] 2026-11-05 14:02: ..."), the ruling message marked
 * RULING; and what each number stands for, so a value's source is the line's
 * author whatever the model says. A ruling message the bounds left out is put
 * back in its place. Lines beyond `TRANSCRIPT_TEXT_MAX` characters are left
 * out oldest first; `cut` says so. SCRUM-903: with no ruling message (no team
 * message confirms the party yet) no line is marked, and the conversation is
 * read as it stands.
 */
export function renderTranscript(
  lines: InboxTranscriptLine[],
  ruling: { id: string; body: string; at: string } | null,
  timeZone: string,
): { text: string; refs: TranscriptRef[]; cut: boolean } {
  const isRuling = (l: InboxTranscriptLine) => ruling !== null && l.id === ruling.id;
  const all = !ruling || lines.some((l) => l.id === ruling.id)
    ? [...lines]
    : [...lines, { id: ruling.id, author: "staff" as const, at: ruling.at, text: ruling.body }].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at),
      );
  const render = (l: InboxTranscriptLine, n: number) => {
    const who = l.author === "customer" ? "family" : "team";
    const mark = isRuling(l) ? `${who}, RULING` : who;
    const body = l.text.replace(/\r\n?/g, "\n").replace(/\n/g, "\n    ");
    return `#${n} [${mark}] ${localTimeOf(l.at, timeZone)}: ${body}`;
  };
  let kept = all;
  let cut = false;
  const size = (ls: InboxTranscriptLine[]) => ls.reduce((sum, l, i) => sum + render(l, i + 1).length + 1, 0);
  while (kept.length > 1 && size(kept) > TRANSCRIPT_TEXT_MAX) {
    const drop = kept.findIndex((l) => !isRuling(l));
    if (drop < 0) break;
    kept = kept.filter((_, i) => i !== drop);
    cut = true;
  }
  const refs = kept.map((l, i) => ({
    line: i + 1,
    id: l.id,
    source: (l.author === "customer" ? "family" : "team") as BeoAiSource,
    at: l.at,
    ruling: isRuling(l),
    text: l.text,
  }));
  return { text: kept.map((l, i) => render(l, i + 1)).join("\n"), refs, cut };
}

// --- The prompt's catalogue part --------------------------------------------------------

const baht = (satang: number | null | undefined) => (typeof satang === "number" ? Math.round(satang) / 100 : null);

/** The catalogue as the model is handed it: ids, names, limits, codes; money in baht. */
export function catalogueForModel(c: BeoAiCatalogueView): unknown {
  return {
    packages: c.packages.map((p) => ({
      id: p.id,
      name: p.name,
      kidsIncluded: p.kidsIncluded,
      adultsIncluded: p.adultsIncluded,
      hours: p.hours,
      priceWeekday: baht(p.priceWeekday ?? p.basePrice),
      priceWeekend: baht(p.priceWeekend ?? p.basePrice),
      setMenuId: p.setMenuTemplateId,
      lines: p.lines.map((l) => ({
        id: l.id,
        label: l.label,
        included: l.included,
        ...(l.included ? {} : { price: baht(l.unitPrice), ...(l.priceIsFrom ? { priceIsFrom: true } : {}), ...(l.unitLabel ? { per: l.unitLabel } : {}) }),
      })),
    })),
    setMenus: c.setMenus.map((m) => ({
      id: m.id,
      name: m.name,
      items: m.items.map((i) =>
        i.type === "always_included"
          ? { id: i.id, type: i.type, label: i.label, ...(i.productCode ? { productCode: i.productCode } : {}) }
          : {
              id: i.id,
              type: i.type,
              label: i.label,
              options: i.options,
              allowMultiple: i.allowMultiple,
              ...(i.productCode ? { productCode: i.productCode } : {}),
              ...(Object.values(i.optionProductCodes).some(Boolean) ? { optionProductCodes: i.optionProductCodes } : {}),
            },
      ),
    })),
    entertainment: c.entertainment.map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      minutes: e.durationMinutes,
      price: baht(e.price),
      ...(e.unit ? { per: e.unit } : {}),
      ...(e.priceIsFrom ? { priceIsFrom: true } : {}),
    })),
    food: c.food,
    // SCRUM-944: the till's food and drink, as a table to keep the prompt small (about 140 items
    // at a park): its code, name, category and station; no prices, which the model does not need.
    ...(c.till && c.till.length > 0
      ? { tillMenu: { columns: ["code", "name", "category", "station"], items: c.till.map((t) => [t.code, t.name, t.category ?? "", t.station]) } }
      : {}),
  };
}

/**
 * SCRUM-944: how a dish or drink is matched to the till's menu, added to the
 * catalogue's rules only when the till's menu is handed over (a park whose
 * till was not read reads the rules of before, word for word).
 */
export const BEO_TILL_MENU_RULES = `
- "tillMenu" is every dish and drink the park's till sells: each row is its code, name, category and station ("kitchen" or "bar"). A dish or drink the conversation names beyond what the set menu gives is a menu line whose "productCode" is the code of the item it is, from "food" or from "tillMenu", matched by what the conversation means whatever language it is in ("a Coke" is the till's Coke). Only a code listed there, never one you make up; with no item that fits, null and "notInMenu": true. A dish the set menu already gives (one it always includes, or a choice made) is a menu line only when the conversation asks for more of it ("extra fries", "2 more pizzas"). A drink made at the bar ("station": "bar") is a "bar" line`;

/**
 * The rules for reading a whole conversation: which line wins, what the
 * family's values are, and that the conversation is read only into the
 * `catalogue` key (every entry names its line, so its source is known).
 *
 * SCRUM-904 (Phase B): the whole form is read from the conversation into
 * that key (`BEO_CONVERSATION_FORM_RULES`, below the catalogue's format), so
 * the review proposes every field with the chat's words for it even when no
 * message of the team's confirms the party yet; the ruling message's own read
 * (the free-text fill) only fills what the conversation's read leaves out.
 * The rules no longer say a RULING line always exists: with none, no line is
 * marked and the conversation is read as it stands (SCRUM-903).
 *
 * SCRUM-826: ONE rule for which line wins, the same `laterLineWins` applies
 * in code wherever the model names the same thing twice — the latest line,
 * whoever wrote it. The earlier wording said both "the team's confirmation
 * wins" and "a later line wins", which contradict when the family corrects
 * something after the confirmation, and the model read it either way from
 * one press to the next.
 */
export const BEO_CONVERSATION_RULES = `

THE CONVERSATION
The new text is not one message: it is the whole conversation between the family and the park's team, oldest line first. Each line starts with its number, who wrote it ([family] is the customer, [team] is a person on the park's team) and its local time at the park. A line marked RULING is the team's final confirmation. The team may not have confirmed the party yet: then no line is marked RULING, and the conversation is read as it stands.
- The latest line wins, whoever wrote it: where two lines speak about the same thing, give the value of the later line, with that line's number. The team's confirmation (the RULING line when there is one, or another team line) wins over every family line BEFORE it; a family line AFTER the confirmation that corrects or declines something is the current value, given as the family's
- The family's values are the defaults: what the family asked for that no later line changes is still given, as the family's
- Answer ONLY the "catalogue" key described below and leave every other key of the structure above out: the whole form is read from the conversation into that key, every value with the number of its line`;

/**
 * SCRUM-904: the keys the rest of the form adds inside `catalogue`, in the
 * conversation's read (`BEO_CONVERSATION_FORM_RULES`).
 */
export const BEO_CONVERSATION_OUTPUT_FORMAT = `"event": {
    "bookingName": { "value": "the name the booking is under", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "locationText": { "value": "the room or area", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "eventDate": { "value": "YYYY-MM-DD", "said": "the conversation's words for the date", "line": 0, "source": "team | family" },
    "childAge": { "value": 0, "said": "the conversation's words", "line": 0, "source": "team | family" },
    "whatsapp": { "value": "the number as written", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "kidsFoodTime": { "value": "HH:MM", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "adultsFoodTime": { "value": "HH:MM", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "barServiceTime": { "value": "HH:MM", "said": "the conversation's words", "line": 0, "source": "team | family" }
  },
  "setup": {
    "readyBy": { "value": "HH:MM", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "responsible": { "value": "a name or a role, as written", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "notes": { "value": "the conversation's words", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "tasks": [ { "label": "the conversation's words for the task", "notes": "the conversation's words", "line": 0, "source": "team | family" } ]
  },
  "pos": {
    "name": { "value": "the package or bill name", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "notes": { "value": "the conversation's words", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "items": [ { "description": "the conversation's words for the item", "type": "included | extra", "price": 0, "line": 0, "source": "team | family" } ]
  },
  "team": {
    "partyHost": { "value": "a name, as written", "said": "the conversation's words", "line": 0, "source": "team | family" },
    "entertainmentHost": { "value": "a name, as written", "said": "the conversation's words", "line": 0, "source": "team | family" }
  },
  "cake": { "quantity": 1, "included": true, "price": 0 },
  "menuLines": [ { "notes": "the conversation's note on that dish", "option": "the catalogue's own name for the dish when its food code carries several names" } ],
  "setMenu": { "choices": [ { "notes": "the conversation's note on that dish" } ] },
  "entertainment": [ { "time": "HH:MM" } ],
  "requests": [ { "kind": "allergy" } ]`;

/**
 * SCRUM-904 (Phase B) — the rest of the form, read from the conversation
 * into the same `catalogue` key: every field the BEO holds, each with the
 * chat's own words (`said`) and its line, so the review proposes it with
 * its reason as Book Date does. Only in the conversation's read: a park
 * group's SAVED advice and output format replace the built-in ones, and this
 * block reaches the model either way.
 */
export const BEO_CONVERSATION_FORM_RULES = `

THE REST OF THE FORM, FROM THE CONVERSATION
Read every field of the form below from the conversation too, from the family's lines and the team's alike, whatever the format at the top of this prompt says. Each value carries "said", the conversation's own words for it exactly as written (never translated), with "line" and "source" as above. Leave out every key the conversation does not speak to: never a default, a usual time, a guess or a price the conversation does not name.
- "event.bookingName": the name the booking is under (a parent's or a company's name), as written
- "event.locationText": the room or the area of the park the party is in
- "event.eventDate": the party's date as YYYY-MM-DD. A day and month with no year is its next occurrence on or after the day its line was written; a weekday alone is the next such day after it. Never the date of a deposit, a payment or a call
- "event.childAge": the age the child turns at this party, a whole number
- "event.whatsapp": a phone number the conversation writes out for reaching the family on WhatsApp, its digits exactly as written; never a number of the park's
- "event.kidsFoodTime" and "event.adultsFoodTime": when the kids' and the adults' food is served, HH:MM; "event.barServiceTime": when the drinks are served, HH:MM
- "setup": "readyBy", the time the room must be ready, HH:MM; "responsible", a person or a role the conversation names for the setup, as written, without a role word or "the" before it; "notes", what the conversation says about the setup that is not a task; "tasks", each setup task ("a balloon arch", "a long table for 12") with its notes
- "pos": the party's bill on the park's till. "name", the package or bill name the conversation gives it; "items", each item the bill includes or charges ("type": "included" or "extra"; "price" only a price the conversation names for it, in baht); "notes", what the conversation says of the bill or the payment
- "team": "partyHost" and "entertainmentHost", a person the conversation names for that role, as written, without a role word or "the" before it. Never one you choose
- "cake": "quantity", how many cakes, only when the conversation says; "included", true when the conversation says the cake comes with the package and false when it is charged on its own; "price", only a price the conversation names for the cake, in baht
- A note the conversation gives about one dish ("no cheese on the pizza", "cut into squares") is that dish's "notes", on its "menuLines" entry or on its set-menu choice, in the conversation's own words: not a request
- A "menuLines" entry whose food code carries several "names" in "food" (the options of one dish, such as "Fried rice (Veggie)", "Fried rice (Chicken)") names the one the conversation means as its "option", exactly as "food" lists it, whatever language the conversation is in. Leave "option" out when the conversation does not say which: staff choose it
- An allergy or a food intolerance (nuts, gluten, lactose, seafood) is a "requests" entry of the kind "allergy", one for each, in the conversation's own words; it is not given again as a "special_request"
- A show or an act the conversation gives a time for ("the bubble show at 15:00") keeps its "entertainment" entry with that time as its "time", HH:MM, and is not given again as a "timeline" step

Add these keys inside "catalogue", beside the ones above (the "event", "cake", "menuLines", "setMenu" choices, "entertainment" and "requests" entries take the keys shown here as well as their own):
${BEO_CONVERSATION_OUTPUT_FORMAT}`;

/** The format of the `catalogue` key the model adds to its answer. */
export const BEO_CATALOGUE_OUTPUT_FORMAT = `"catalogue": {
  "package": { "templateId": "a package id, or null", "said": "the conversation's words for it", "chatPrice": 0, "line": 0, "source": "team | family" },
  "addOns": [ { "lineId": "an add-on line id of the chosen package, or null", "said": "the conversation's words", "quantity": 1, "chatPrice": 0, "line": 0, "source": "team | family" } ],
  "setMenu": { "templateId": "a set menu id, or null", "said": "the conversation's words", "line": 0, "source": "team | family",
    "choices": [ { "itemId": "a choice group id of that set menu", "option": "one of its options, exactly as listed", "said": "the conversation's words", "line": 0, "source": "team | family" } ] },
  "menuLines": [ { "productCode": "a food code, or null", "itemName": "the conversation's words", "menu": "kids | adults | bar", "quantity": 1, "notInMenu": false, "chatPrice": 0, "line": 0, "source": "team | family" } ],
  "entertainment": [ { "templateId": "an entertainment id, or null", "said": "the conversation's words", "quantity": 1, "chatPrice": 0, "line": 0, "source": "team | family" } ],
  "event": {
    "childName": { "value": "the child's name", "line": 0, "source": "team | family" },
    "numChildren": { "value": 0, "line": 0, "source": "team | family" },
    "numAdults": { "value": 0, "line": 0, "source": "team | family" },
    "startTime": { "value": "HH:MM", "line": 0, "source": "team | family" },
    "endTime": { "value": "HH:MM", "line": 0, "source": "team | family" }
  },
  "cake": { "mode": "INTERNAL | EXTERNAL | NONE | NOT_SAID", "notes": "the conversation's words", "time": "HH:MM", "line": 0, "source": "team | family" },
  "deposit": { "amount": 0, "paid": true, "date": "YYYY-MM-DD", "line": 0, "source": "team | family" },
  "requests": [ { "kind": "special_request | decoration | activity", "text": "the conversation's words", "line": 0, "source": "team | family" } ],
  "timeline": [ { "time": "HH:MM", "label": "the conversation's words for what happens then", "line": 0, "source": "team | family" } ]
}`;

/**
 * What the system prompt gains for a fill from the conversation with the
 * park's catalogue: the conversation's rules (when it is a conversation), the
 * catalogue, how to match it, and the `catalogue` key's format. SCRUM-904: a
 * conversation's read is asked the rest of the form too, after the format.
 */
export function beoCatalogueSystemBlock(catalogue: BeoAiCatalogueView, opts: { conversation: boolean }): string {
  return (
    (opts.conversation ? BEO_CONVERSATION_RULES : "") +
    `

THE PARK'S CATALOGUE
The packages (with their included lines and add-ons), set menus (with their choice groups and the till's food codes), entertainment and food the park sells at this party's park, as JSON. Money in it is baht.
${JSON.stringify(catalogueForModel(catalogue))}

Matching to the catalogue:
- Name a package, an add-on, a set menu, a set-menu choice and an entertainment line only by an id from this catalogue. When nothing in it fits, give null for the id and keep the conversation's own words in "said" or "itemName": staff decide
- An add-on is one of the chosen package's lines whose "included" is false; a line the package includes is not an add-on
- A set-menu choice names a choice group ("itemId") of the chosen set menu and one of its "options", written exactly as listed there
- A dish or drink beyond the set menu is a menu line: "productCode" is the code from "food" it is, else null with "notInMenu": true. "menu" is "kids", "adults" or "bar" (drinks)
- The adults eat what the kids eat unless the conversation says otherwise: a dish is "kids" even when the whole party eats it, and no "adults" line is given. When the conversation says the adults' food differs, the "adults" lines are everything the adults eat — a dish they share with the kids given again as an "adults" line, in the adults' own count when the conversation gives one — and nothing the adults do not get: "nuggets for the kids, pasta for the adults" gives one "adults" line, the pasta; "nuggets for everyone, and a cheese platter for the adults" gives two, the nuggets and the cheese platter
- Never invent an item, a quantity or a price, and never price or total anything: "chatPrice" is only a price the conversation itself names for that item, in baht as written; otherwise leave it out
- A menu line's "chatPrice" is the price of ONE of the item ("2 more pizzas at 450 each" is 450): when the conversation gives only a total for several ("2 pizzas for 900"), leave "chatPrice" out
- Keep the conversation's own wording and language in "said" and "itemName". Do not translate
- Every entry carries "line": the number of the conversation line it comes from (for what the team confirmed, the team's line), and "source": "team" when that line is the team's, "family" when it is the family's
- A deposit is "paid": true only when the conversation says it was received
- The cake's "mode" is NOT_SAID when the conversation gives a cake time or cake details but does not say whether the park or the family brings the cake: never guess it
- "requests": each wish or instruction the conversation gives beyond the catalogue, one entry each, in the conversation's own words — "special_request" for a request or a need (an allergy, a quiet corner, a surprise), "decoration" for a decoration wish (a theme, colours, balloons), "activity" for something planned that is not an entertainment line (games, a treasure hunt). A wish repeated or changed later is one entry, the later line's; a wish the team declined is left out
- "timeline": each step the conversation gives a clock time for (the cake, a show, the food, the end), with that time as HH:MM and the conversation's words for it. Never invent a time or a step${catalogue.till && catalogue.till.length > 0 ? BEO_TILL_MENU_RULES : ""}

Add this key at the top level of the JSON object, leaving out any entry the conversation does not speak to:
${BEO_CATALOGUE_OUTPUT_FORMAT}` +
    (opts.conversation ? BEO_CONVERSATION_FORM_RULES : "")
  );
}

// --- Reading the model's catalogue answer ------------------------------------------------

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const optStr = (max: number) =>
  z.preprocess((v) => (blank(v) ? undefined : typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : v), z.string().max(max).optional());
const optInt = (min: number) =>
  z.preprocess(
    (v) => (blank(v) ? undefined : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
    z.number().int().min(min).max(100_000).optional(),
  );
/** Baht as the chat names it: 1500, "1,500", "1500฿". */
const optBaht = z.preprocess((v) => {
  if (blank(v)) return undefined;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s฿]|THB|บาท|руб|бат/gi, "");
    return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : v;
  }
  return v;
}, z.number().min(0).max(100_000_000).optional());
const optSource = z.preprocess((v) => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return s === "team" || s === "staff" ? "team" : s === "family" || s === "customer" ? "family" : undefined;
}, z.enum(["team", "family"]).optional());
const optTime = z.preprocess((v) => {
  if (typeof v !== "string") return undefined;
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(v);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : undefined;
}, z.string().optional()).describe("a time as HH:MM on the 24-hour clock");
const optDay = z.preprocess((v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined), z.string().optional()).describe("a date as YYYY-MM-DD");
const ref = { line: optInt(1).describe("a whole number: the number of the conversation line it comes from"), source: optSource };
// The descriptions below are what the prompt's "fields the app requires" block says of each key (SCRUM-816).
const said = optStr(500).describe("the conversation's own words for it, exactly as written");
const chatPrice = optBaht.describe("a number in baht: only a price the conversation itself names for it");
const catalogueId = (what: string, max = 100) => optStr(max).describe(`${what}, or null when nothing in it fits`);

const PackageAnswer = z.object({ templateId: catalogueId("a package id from the park's catalogue"), said, chatPrice, ...ref });
const AddOnAnswer = z.object({
  lineId: catalogueId('an add-on line id of the chosen package (one of its lines whose "included" is false)'),
  said,
  quantity: optInt(0),
  chatPrice,
  ...ref,
});
/** The set menu as named; its `choices` are read apart, each leniently. */
const SetMenuAnswer = z.object({ templateId: catalogueId("a set menu id from the park's catalogue"), said, ...ref });
const ChoiceAnswer = z.object({
  itemId: optStr(100).describe("a choice group id of the chosen set menu"),
  option: optStr(300).describe("one of that choice group's options, written exactly as listed"),
  said,
  ...ref,
});
const MenuLineAnswer = z.object({
  productCode: catalogueId('a food code from the catalogue\'s "food"', 64),
  itemName: optStr(300).describe("the conversation's own words for the dish or drink"),
  menu: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : undefined), z.enum(BEO_AI_MENUS).optional()).describe(
    // SCRUM-829: the adults eat the kids' menu unless the conversation says otherwise.
    'one of "kids", "adults", "bar": "kids" for every dish the party eats, "adults" for each dish the adults eat when the conversation says their food differs from the kids\', "bar" for a drink',
  ),
  quantity: optInt(1),
  notInMenu: z.preprocess((v) => (typeof v === "boolean" ? v : undefined), z.boolean().optional()).describe(
    "true or false: true when no food code fits",
  ),
  chatPrice,
  ...ref,
});
const EntertainmentAnswer = z.object({ templateId: catalogueId("an entertainment id from the park's catalogue"), said, quantity: optInt(1), chatPrice, ...ref });
const SourcedText = z.object({ value: optStr(200), ...ref });
const SourcedCount = z.object({ value: optInt(0), ...ref });
const SourcedTime = z.object({ value: optTime, ...ref });
const CakeAnswer = z.object({
  // SCRUM-787: NOT_SAID (who brings the cake is not said) is read as no type at all.
  mode: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : undefined),
    z.enum(["INTERNAL", "EXTERNAL", "NONE", "NOT_SAID"] as const satisfies readonly [...typeof BEO_AI_CAKE_MODES, "NOT_SAID"]).optional(),
  ),
  notes: optStr(1000).describe("the conversation's own words for the cake"),
  time: optTime,
  ...ref,
});
const DepositAnswer = z.object({
  amount: optBaht.describe("an amount in baht, as a number"),
  paid: z.preprocess((v) => (typeof v === "boolean" ? v : undefined), z.boolean().optional()).describe(
    "true or false: true only when the conversation says it was received",
  ),
  date: optDay,
  ...ref,
});
// SCRUM-827: the chat's requests and timed steps, each with its line.
const RequestAnswer = z.object({
  kind: z
    .preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : undefined), z.enum(BEO_AI_REQUEST_KINDS).optional())
    .describe('one of "special_request", "decoration", "activity"'),
  text: optStr(1000).describe("the conversation's own words for the wish or instruction"),
  ...ref,
});
const TimelineAnswer = z.object({
  time: optTime,
  label: optStr(300).describe("the conversation's own words for what happens at that time"),
  ...ref,
});

/**
 * SCRUM-816: the `catalogue` section as `resolveCatalogueAnswer` reads it,
 * built from the very entry schemas it reads each piece with. It reads nothing
 * itself (each piece is read apart, leniently, so one entry off its shape is
 * left out, never fatal): it is what the prompt's "fields the app requires"
 * block names, so a park group's saved output format can never leave a key of
 * it out.
 */
export const BeoCatalogueAnswerShape = z
  .object({
    package: PackageAnswer,
    addOns: z.array(AddOnAnswer),
    setMenu: SetMenuAnswer.extend({ choices: z.array(ChoiceAnswer).optional() }),
    menuLines: z.array(MenuLineAnswer),
    entertainment: z.array(EntertainmentAnswer),
    event: z
      .object({ childName: SourcedText, numChildren: SourcedCount, numAdults: SourcedCount, startTime: SourcedTime, endTime: SourcedTime })
      .partial(),
    cake: CakeAnswer,
    deposit: DepositAnswer,
    requests: z.array(RequestAnswer),
    timeline: z.array(TimelineAnswer),
  })
  .partial();

/** SCRUM-816: what the form's read handed the catalogue (no conversation) answers: the form's fields and the catalogue section. */
export const BEO_FILL_WITH_CATALOGUE_SHAPE = BeoFillSchema.extend({ catalogue: BeoCatalogueAnswerShape.optional() });
/** SCRUM-816: what the conversation's read answers: the catalogue section alone. */
export const CATALOGUE_ONLY_SHAPE = z.object({ catalogue: BeoCatalogueAnswerShape.optional() });

// --- SCRUM-904: the rest of the form, read from the conversation into the same section ----------

/** A value with the conversation's own words for it, and its line. */
const saidWords = optStr(500).describe("the conversation's own words for it, exactly as written");
const SaidText = (max: number, what: string) => z.object({ value: optStr(max).describe(what), said: saidWords, ...ref });
const SaidTime = z.object({ value: optTime, said: saidWords, ...ref });
const SaidDay = z.object({ value: optDay, said: saidWords, ...ref });
const SaidCount = z.object({ value: optInt(0).describe("a whole number"), said: saidWords, ...ref });
const SetupTaskAnswer = z.object({
  label: optStr(300).describe("the conversation's own words for the setup task"),
  notes: optStr(1000).describe("the conversation's own words"),
  ...ref,
});
const PosItemAnswer = z.object({
  description: optStr(500).describe("the conversation's own words for the item"),
  type: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : undefined), z.enum(["included", "extra"]).optional()).describe('one of "included", "extra"'),
  price: optBaht.describe("a number in baht: only a price the conversation itself names for it"),
  ...ref,
});
const dishNotes = optStr(1000).describe("the conversation's own note on that dish, exactly as written");
// SCRUM-904: the entries the rest of the form adds keys to, read whole: a plain entry schema would
// strip the dish's note and the show's time before the resolver sees them.
const ChoiceWithNotes = ChoiceAnswer.extend({ notes: dishNotes });
// SCRUM-926: the option of a dish whose code several options share, as the catalogue's "food" names it.
const MenuLineWithNotes = MenuLineAnswer.extend({
  notes: dishNotes,
  option: optStr(300).describe('one of that food code\'s "names", exactly as listed, when it carries several; left out when the conversation does not say which'),
});
const EntertainmentWithTime = EntertainmentAnswer.extend({ time: optTime });

/**
 * SCRUM-904: what the conversation's read answers — the catalogue section,
 * and in it the rest of the form (`BEO_CONVERSATION_FORM_RULES`): the event's
 * other fields, the setup plan, the POS box, the hosts, the cake's quantity
 * and price, each dish's note, each show's time and the allergies. Read
 * leniently, entry by entry, as the catalogue's own keys are.
 */
export const BeoConversationAnswerShape = BeoCatalogueAnswerShape.extend({
  menuLines: z.array(MenuLineWithNotes),
  setMenu: SetMenuAnswer.extend({ choices: z.array(ChoiceWithNotes).optional() }),
  entertainment: z.array(EntertainmentWithTime),
  event: z
    .object({
      childName: SourcedText,
      numChildren: SourcedCount,
      numAdults: SourcedCount,
      startTime: SourcedTime,
      endTime: SourcedTime,
      bookingName: SaidText(200, "the name the booking is under, as written"),
      locationText: SaidText(300, "the room or area of the park, as written"),
      eventDate: SaidDay,
      childAge: SaidCount,
      whatsapp: SaidText(60, "the phone number as written"),
      kidsFoodTime: SaidTime,
      adultsFoodTime: SaidTime,
      barServiceTime: SaidTime,
    })
    .partial(),
  cake: CakeAnswer.extend({
    quantity: optInt(1).describe("a whole number: how many cakes"),
    included: z.preprocess((v) => (typeof v === "boolean" ? v : undefined), z.boolean().optional()).describe(
      "true or false: true when the cake comes with the package",
    ),
    price: optBaht.describe("a number in baht: only a price the conversation itself names for the cake"),
  }),
  requests: z.array(
    RequestAnswer.extend({
      kind: z
        .preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : undefined), z.enum(BEO_AI_REQUEST_KINDS).optional())
        .describe('one of "special_request", "decoration", "activity", "allergy"'),
    }),
  ),
  setup: z
    .object({
      readyBy: SaidTime,
      responsible: SaidText(200, "a name or a role as written, without a role word or \"the\" before it"),
      notes: SaidText(4000, "the conversation's own words"),
      tasks: z.array(SetupTaskAnswer),
    })
    .partial(),
  pos: z
    .object({
      name: SaidText(300, "the package or bill name, as written"),
      notes: SaidText(4000, "the conversation's own words"),
      items: z.array(PosItemAnswer),
    })
    .partial(),
  team: z
    .object({
      partyHost: SaidText(200, "a person only as the conversation names them, without a role word or \"the\" before it; never one you choose"),
      entertainmentHost: SaidText(200, "a person only as the conversation names them, without a role word or \"the\" before it; never one you choose"),
    })
    .partial(),
}).partial();
/** SCRUM-904: what the conversation's read answers: the catalogue section, the rest of the form in it. */
export const CONVERSATION_SHAPE = z.object({ catalogue: BeoConversationAnswerShape.optional() });

/** One entry read leniently: an entry off its shape is left out, never fatal to the fill. */
function readOne<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
function readMany<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, max = 60): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).map((r) => readOne(schema, r)).filter((r): r is T => r !== null);
}

const fold = (s: string) => s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The model's `catalogue` section, checked against the catalogue it was
 * handed: ids it does not hold, options a group does not list and codes the
 * food list lacks become free lines in the conversation's own words. Every
 * value's source is the author of the line it names, never the model's own
 * `source`: the ruling message's when it was read alone (`fallback`); in a
 * conversation, a line we do not hold (or none) is the family's — a default
 * for staff to check — unless every line read is the team's. The same item
 * named twice (an add-on, a set-menu choice, a dish, an entertainment) is one
 * entry: the later line's, whoever wrote it (`laterLineWins`, SCRUM-826 —
 * the rule the prompt states). The event's counts and times, the cake and
 * the deposit are one entry each: the model gives the line that rules them
 * under the same rule, and its author is the source.
 *
 * SCRUM-903: every value whose line is known carries the chat's words for it
 * (`from.quote`, `quoteOf`): the model's own words for the value — the
 * `said`, the dish's or the wish's words, the step's label, the cake's notes
 * — when that line holds them, else the line itself; the counts, the times,
 * the child and the deposit, which have no words of their own, the line.
 * The catalogue may be empty: every item is then a line the catalogue lacks,
 * for staff to keep or leave out.
 */
export function resolveCatalogueAnswer(
  raw: unknown,
  catalogue: BeoAiCatalogueView,
  refs: TranscriptRef[],
  /** The ruling message read alone (no conversation): every value is the team's. */
  fallback?: BeoAiFrom,
  /** SCRUM-903: that ruling message's text, for the chat's words a value carries. */
  fallbackText?: string,
): BeoAiProposal {
  const answer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const allTeam = refs.length > 0 && refs.every((r) => r.source === "team");
  /** SCRUM-904: the text of the line a value names (the ruling message read alone: its text). */
  const lineTextOf = (entry: { line?: number }): string | null =>
    (entry.line ? refs.find((r) => r.line === entry.line)?.text : undefined) ?? (refs.length === 0 ? fallbackText ?? null : null);
  // SCRUM-904: `hints`, the value itself, for a line too long to quote whole (`quoteOf`).
  const fromOf = (entry: { line?: number; source?: BeoAiSource }, words?: string | null, ...hints: Array<string | number | null | undefined>): BeoAiFrom => {
    const known = entry.line ? refs.find((r) => r.line === entry.line) : undefined;
    if (known) return withQuote({ source: known.source, at: known.at, line: known.line }, words, known.text, hints);
    // The ruling message read alone: its words for the value when it holds them, else the message.
    if (fallback) return fallbackText ? withQuote({ source: fallback.source, at: fallback.at, line: fallback.line }, words, fallbackText, hints) : fallback;
    // A conversation holding only the team's lines (the ruling alone): the team's.
    if (allTeam) {
      return refs.length === 1
        ? withQuote({ source: "team", at: refs[0]!.at, line: refs[0]!.line }, words, refs[0]!.text, hints)
        : { source: "team", at: null, line: null };
    }
    return { source: "family", at: null, line: null };
  };
  /** Puts `entry` in `list`, or in place of the same item there when its line is the later. */
  const merge = <T extends { from: BeoAiFrom }>(list: T[], entry: T, same: (x: T) => boolean) => {
    const at = list.findIndex(same);
    if (at < 0) list.push(entry);
    else if (laterLineWins(entry.from, list[at]!.from)) list[at] = entry;
  };
  const proposal: BeoAiProposal = {
    package: null,
    addOns: [],
    setMenu: null,
    menuLines: [],
    entertainment: [],
    otherLines: [],
    event: {},
    cake: null,
    deposit: null,
    details: emptyBeoAiDetails(),
  };
  const other = (text: string | undefined, chatPrice: number | undefined, from: BeoAiFrom) => {
    if (text) proposal.otherLines.push({ text, chatPrice: chatPrice ?? null, from });
  };

  // The package.
  const pkgAnswer = readOne(PackageAnswer, answer.package);
  const pkg = pkgAnswer?.templateId ? catalogue.packages.find((p) => p.id === pkgAnswer.templateId) : undefined;
  if (pkgAnswer && pkg) {
    proposal.package = { templateId: pkg.id, said: pkgAnswer.said ?? null, chatPrice: pkgAnswer.chatPrice ?? null, from: fromOf(pkgAnswer, pkgAnswer.said) };
  } else if (pkgAnswer) {
    other(pkgAnswer.said, pkgAnswer.chatPrice, fromOf(pkgAnswer, pkgAnswer.said));
  }

  // Add-ons: the chosen package's lines it does not include.
  for (const a of readMany(AddOnAnswer, answer.addOns)) {
    const line = pkg?.lines.find((l) => l.id === a.lineId && !l.included);
    if (line) {
      const quantity = a.quantity && a.quantity > 0 ? a.quantity : 1;
      const entry = { lineId: line.id, quantity, said: a.said ?? null, chatPrice: a.chatPrice ?? null, from: fromOf(a, a.said) };
      merge(proposal.addOns, entry, (x) => x.lineId === line.id);
    } else {
      other(a.said, a.chatPrice, fromOf(a, a.said));
    }
  }

  // The set menu: the one named, else the chosen package's own.
  const setAnswer = readOne(SetMenuAnswer.extend({ choices: z.unknown() }), answer.setMenu);
  const named = setAnswer?.templateId ? catalogue.setMenus.find((m) => m.id === setAnswer.templateId) : undefined;
  const fromPackage = !named && pkg?.setMenuTemplateId ? catalogue.setMenus.find((m) => m.id === pkg.setMenuTemplateId) : undefined;
  const menu = named ?? fromPackage;
  if (setAnswer && !menu) {
    other(setAnswer.said, undefined, fromOf(setAnswer, setAnswer.said));
    // SCRUM-903: the choices of a set menu the catalogue lacks (with an empty catalogue, every
    // one) are dishes of their own for staff to keep or leave out, as an unlisted option is:
    // never dropped unseen.
    for (const c of readMany(ChoiceWithNotes, setAnswer.choices)) {
      const itemName = c.said ?? c.option;
      if (!itemName) continue;
      proposal.menuLines.push({
        menu: "kids", itemName, quantity: 1, productCode: null, matchedName: null, notInMenu: true, chatPrice: null,
        ...(c.notes ? { notes: c.notes } : {}), from: fromOf(c, itemName),
      });
    }
  }
  // SCRUM-958: set-menu choices whose only words in the chat are said for the adults.
  const adultsChoices: Array<{ group: Extract<BeoAiSetMenuItem, { type: "choice_group" }>; option: string; said: string | null; notes?: string; from: BeoAiFrom }> = [];
  if (menu) {
    const from = named && setAnswer ? fromOf(setAnswer, setAnswer.said) : proposal.package!.from;
    const chosen: Array<{ itemId: string; option: string; said: string | null; notes?: string; from: BeoAiFrom }> = [];
    for (const c of readMany(ChoiceWithNotes, setAnswer?.choices)) {
      const group = menu.items.find((i) => i.id === c.itemId && i.type === "choice_group") as
        | Extract<BeoAiSetMenuItem, { type: "choice_group" }>
        | undefined;
      const option = group && c.option ? group.options.find((o) => fold(o) === fold(c.option!)) : undefined;
      const cFrom = fromOf(c, c.said ?? c.option);
      // SCRUM-958 (the 12 November proof, thread A: "And chicken fried rice for the adults."):
      // a choice the chat says only for the adults never chooses for the kids. It is the adults'
      // own dish of the set menu (an adults' SET line, below); the kids' group stays unchosen.
      if (group && option && saidForTheAdults(c.said, lineTextOf(c))) {
        adultsChoices.push({ group, option, said: c.said ?? null, ...(c.notes ? { notes: c.notes } : {}), from: cFrom });
        continue;
      }
      if (!group || !option) {
        // A choice the set menu does not list: a dish of its own, for staff to decide.
        const itemName = c.said ?? c.option;
        if (itemName) {
          proposal.menuLines.push({
            menu: "kids", itemName, quantity: 1, productCode: null, matchedName: null, notInMenu: true, chatPrice: null,
            ...(c.notes ? { notes: c.notes } : {}), from: cFrom,
          });
        }
        continue;
      }
      // A group of one choice holds one option (the later line's, whoever wrote it);
      // a group of several holds each option once, its source the same way.
      // SCRUM-904: the chat's note on the dish rides with it.
      const entry = { itemId: group.id, option, said: c.said ?? null, ...(c.notes ? { notes: c.notes } : {}), from: cFrom };
      merge(chosen, entry, (x) => x.itemId === group.id && (!group.allowMultiple || x.option === option));
    }
    proposal.setMenu = { templateId: menu.id, from, choices: chosen };
  }

  // Dishes and drinks beyond the set menu.
  const codes = new Map(catalogue.food.map((f) => [f.code.toUpperCase(), f]));
  // SCRUM-946: a code's names are the party's own set menu's (the one proposed), never another's.
  const partyMenuId = proposal.setMenu?.templateId ?? null;
  for (const m of readMany(MenuLineWithNotes, answer.menuLines, 100)) {
    const food = m.productCode ? codes.get(m.productCode.trim().toUpperCase()) : undefined;
    // SCRUM-944: a code the till's menu holds is accepted as well, never one it lacks (a code the
    // model made up is a line the menu lacks, as before).
    const till = tillItemOf(catalogue, m.productCode);
    const names = food ? foodNamesFor(catalogue, food.code, partyMenuId) : [];
    const itemName = m.itemName ?? names[0] ?? till?.name;
    if (!itemName) continue;
    // SCRUM-944: a drink made at the bar goes to the bar plan, a dish to the kids' or the adults' list.
    // SCRUM-958: a dish whose words in the chat are said only for the adults is never the kids'.
    const asked = (m.menu ?? "kids") as BeoAiMenu;
    const said: BeoAiMenu = asked === "kids" && saidForTheAdults(m.itemName, lineTextOf(m)) ? "adults" : asked;
    const menu: BeoAiMenu = till ? (till.station === "bar" ? "bar" : said === "bar" ? "kids" : said) : said;
    // SCRUM-926: of the names one code carries (a set menu's options sharing it), the option the
    // read names when it is one of them, else the one the chat's words name; none (null) when
    // neither says which: staff choose it in the review, never the first option. SCRUM-944: any
    // other code the till sells is named by the till's own name.
    const shared = food ? foodOptionNamed(names, m.option) ?? foodNameFor(names, m.itemName) : null;
    const matchedName = food || till ? codedLineNameOf(names, till, shared) : null;
    const code = food?.code ?? till?.code ?? null;
    // SCRUM-946 (the lane's reviews): the chat's price is written as the price for each item, so a
    // total the chat gives for several ("2 pizzas for 900") is not one. SCRUM-958: the total is
    // kept beside the line, for its reason in the review; never a price each.
    const total = m.chatPrice !== undefined && chatPriceIsTotal(lineTextOf(m), m.chatPrice, m.quantity ?? 1);
    const line: BeoAiProposal["menuLines"][number] = {
      menu,
      itemName,
      quantity: m.quantity ?? 1,
      productCode: code,
      matchedName,
      notInMenu: !code,
      chatPrice: m.chatPrice !== undefined && !total ? m.chatPrice : null,
      ...(total ? { chatTotal: { amount: m.chatPrice!, quantity: m.quantity ?? 1 } } : {}),
      // SCRUM-904: the chat's note on the dish ("no cheese") rides on its line.
      ...(m.notes ? { notes: m.notes } : {}),
      from: fromOf(m, m.itemName),
    };
    // A dish the menu codes is one line per list (per option, when options share the code; a
    // line whose option is not said, by its words); one it lacks stays as the conversation said it.
    if (code) {
      merge(proposal.menuLines, line, (x) =>
        x.productCode === code && x.menu === menu && (matchedName ? x.matchedName === matchedName : x.matchedName === null && fold(x.itemName) === fold(itemName)),
      );
    }
    // SCRUM-904: the same dish the menu lacks named twice is one line too, the later line's.
    else merge(proposal.menuLines, line, (x) => x.productCode === null && x.menu === menu && fold(x.itemName) === fold(itemName));
  }
  // SCRUM-958: each choice said only for the adults, as the adults' line of that set-menu dish
  // with its option, written as a SET line on their own menu (one line per group and option; an
  // adults' line the read gave for the same dish is the same line, the later line's).
  for (const a of adultsChoices) {
    const code = a.group.optionProductCodes[a.option] ?? a.group.productCode ?? null;
    const names = code ? foodNamesFor(catalogue, code, partyMenuId) : [];
    const matchedName = names.find((n) => setMenuOptionOf(a.group, n) === a.option) ?? a.option;
    const line: BeoAiProposal["menuLines"][number] = {
      menu: "adults",
      itemName: a.said ?? a.option,
      quantity: 1,
      productCode: code,
      matchedName,
      notInMenu: false,
      chatPrice: null,
      setMenuItemId: a.group.id,
      ...(a.notes ? { notes: a.notes } : {}),
      from: a.from,
    };
    merge(proposal.menuLines, line, (x) =>
      x.menu === "adults" &&
      (x.setMenuItemId === a.group.id
        ? x.matchedName === matchedName
        : !!code && !!x.productCode && x.productCode.toUpperCase() === code.toUpperCase() && (x.matchedName === null || x.matchedName === matchedName)),
    );
  }
  // Entertainment: one line per entertainment the menu has; a free line as said.
  for (const e of readMany(EntertainmentWithTime, answer.entertainment, 30)) {
    const t = e.templateId ? catalogue.entertainment.find((x) => x.id === e.templateId) : undefined;
    const name = t?.name ?? e.said;
    if (!name) continue;
    // SCRUM-904: the show's time, when the chat gives one: the Entertainment Act's time.
    const time = e.time;
    const entry = {
      templateId: t?.id ?? null,
      name,
      said: e.said ?? null,
      quantity: e.quantity ?? 1,
      chatPrice: e.chatPrice ?? null,
      notInCatalogue: !t,
      ...(time ? { time } : {}),
      from: fromOf(e, e.said),
    };
    if (t) merge(proposal.entertainment, entry, (x) => x.templateId === t.id);
    else proposal.entertainment.push(entry);
  }

  // The event's own fields.
  const ev = answer.event && typeof answer.event === "object" ? (answer.event as Record<string, unknown>) : {};
  const childName = readOne(SourcedText, ev.childName);
  if (childName?.value) proposal.event.childName = { value: childName.value, from: fromOf(childName, null, childName.value) };
  for (const key of ["numChildren", "numAdults"] as const) {
    const v = readOne(SourcedCount, ev[key]);
    // SCRUM-904: the count's own words in a long line ("15 kids"), else the number.
    const words = key === "numChildren" ? ["kid", "child"] : ["adult"];
    if (v && v.value !== undefined) proposal.event[key] = { value: v.value, from: fromOf(v, null, ...words.map((w) => `${v.value} ${w}`), v.value) };
  }
  for (const key of ["startTime", "endTime"] as const) {
    const v = readOne(SourcedTime, ev[key]);
    if (v?.value) proposal.event[key] = { value: v.value, from: fromOf(v, null, v.value) };
  }
  // SCRUM-904: the rest of the event the conversation gives, each with the chat's words for it.
  const date = readOne(SaidDay, ev.eventDate);
  if (date?.value && isCalendarDay(date.value)) {
    proposal.event.eventDate = { value: date.value, said: date.said ?? null, from: fromOf(date, date.said) };
  }
  const age = readOne(SaidCount, ev.childAge);
  if (age && age.value !== undefined && age.value <= 120) proposal.event.childAge = { value: age.value, from: fromOf(age, age.said, age.value) };
  // A number the chat writes out: its digits are in the line it names, never one the model made up.
  const phone = readOne(SaidText(60, ""), ev.whatsapp);
  if (phone?.value && phoneInLine(phone.value, lineTextOf(phone))) proposal.event.whatsapp = { value: phone.value, from: fromOf(phone, phone.said ?? phone.value) };
  for (const key of ["kidsFoodTime", "adultsFoodTime", "barServiceTime"] as const) {
    const v = readOne(SaidTime, ev[key]);
    if (v?.value) proposal.event[key] = { value: v.value, from: fromOf(v, v.said, v.value) };
  }

  // SCRUM-904: a kids' dish that is a set-menu choice already is that choice, not a second line
  // (its note joins the choice) — only when it is the same order: no price of its own, and one of
  // it or one for each child. More of the dish, or a priced one, is an extra dish line of its own,
  // kept with its quantity and price.
  // SCRUM-946 (the lane's reviews): and a dish the set menu always includes is that dish, for the
  // kids and for the adults (whose own list copies the set menu's lines), as is an adults' line of
  // a choice made: with the till's codes (SCRUM-944) such a line would be an EXTRA at the till's
  // price, charging the family for what the set menu gives. Only the same order again: no price of
  // its own, at 1, the list's headcount or the set menu's own portions, and no word asking for
  // more ("extra fries", "дополнительно картошка фри" stay lines of their own), read in the chat's
  // own words (a line whose words are not held stays a line, as before). Its note, which no
  // set-menu line of these keeps, goes to Special requests with the dish's name, never dropped.
  if (proposal.setMenu && menu) {
    const choices = proposal.setMenu.choices;
    const kids = proposal.event.numChildren?.value ?? null;
    const adultsN = proposal.event.numAdults?.value ?? null;
    const group = (c: (typeof choices)[number]) =>
      menu.items.find((i) => i.id === c.itemId && i.type === "choice_group") as Extract<BeoAiSetMenuItem, { type: "choice_group" }> | undefined;
    const included = menu.items.filter((i): i is Extract<BeoAiSetMenuItem, { type: "always_included" }> => i.type === "always_included");
    const lineText = (from: BeoAiFrom): string | null =>
      (from.line ? refs.find((r) => r.line === from.line)?.text : undefined) ?? (refs.length === 0 ? fallbackText ?? null : null);
    const named = (l: (typeof proposal.menuLines)[number], name: string | null | undefined) =>
      !!name && (fold(name) === fold(l.itemName) || (!!l.matchedName && fold(name) === fold(l.matchedName)));
    const choiceOf = (l: (typeof proposal.menuLines)[number]) =>
      choices.find((c) => {
        const g = group(c);
        const code = g?.optionProductCodes[c.option] ?? null;
        if (code && l.productCode && code.toUpperCase() === l.productCode.toUpperCase()) return true;
        // SCRUM-926: options sharing the group's code are told apart by name ("Fried rice (Chicken)").
        return [c.option, c.said, g ? `${g.label} (${c.option})` : null].some((n) => named(l, n));
      });
    const noteToRequests = (l: (typeof proposal.menuLines)[number], dish: string) => {
      if (!l.notes) return;
      const text = `${dish}${l.menu === "adults" ? " (adults)" : ""}: ${l.notes}`;
      if (!proposal.details.requests.some((r) => fold(r.text) === fold(text))) proposal.details.requests.push({ kind: "special_request", text, from: l.from });
    };
    /**
     * SCRUM-958: the set menu's choice group a line is a dish of — by its till code (an option's
     * own, or the group's that its options share) or by the name of an option — with the option
     * the line names (null while it names none).
     */
    const setMenuDishOf = (l: (typeof proposal.menuLines)[number]) => {
      const code = l.productCode?.trim().toUpperCase() ?? "";
      for (const g of menu.items) {
        if (g.type !== "choice_group") continue;
        const ownCode = !!code && g.options.some((o) => g.optionProductCodes[o]?.trim().toUpperCase() === code);
        if (ownCode || (!!code && g.productCode?.trim().toUpperCase() === code)) {
          return { group: g, option: setMenuOptionOf(g, l.matchedName, l.productCode) };
        }
        const byName = g.options.find((o) => [o, `${g.label} (${o})`, `${o} ${g.label}`].some((n) => named(l, n)));
        if (byName) return { group: g, option: byName };
      }
      return undefined;
    };
    // SCRUM-958 (SCRUM-946's open point): an adults' line folded into the kids' set menu is kept
    // (the dish and the line that said it), so the review and the toast say so.
    const folded: NonNullable<BeoAiProposal["adultsFolded"]> = [];
    proposal.menuLines = proposal.menuLines.filter((l) => {
      // SCRUM-958: a line the chat gives a total for names a price too: its own order.
      if (l.menu === "bar" || l.chatPrice !== null || l.chatTotal) return true;
      const count = l.menu === "kids" ? kids : adultsN;
      const sameOrder = l.quantity === 1 || (count !== null && l.quantity === count);
      if (l.menu === "kids" && sameOrder) {
        const same = choiceOf(l);
        if (same) {
          if (l.notes && !same.notes) same.notes = l.notes;
          return false;
        }
      }
      // Only on the chat's own words: a line whose words cannot be read stays a line, as before.
      const text = lineText(l.from);
      if (text === null || moreAsked(l.itemName, text)) return true;
      const item = included.find((i) => (!!i.productCode && !!l.productCode && i.productCode.toUpperCase() === l.productCode.toUpperCase()) || named(l, i.label));
      if (item && (sameOrder || l.quantity === (item.qty ?? 1))) {
        noteToRequests(l, item.label);
        if (l.menu === "adults") folded.push({ dish: item.label, from: l.from });
        return false;
      }
      const chosen = l.menu === "adults" && sameOrder ? choiceOf(l) : undefined;
      if (chosen) {
        noteToRequests(l, chosen.option);
        folded.push({ dish: chosen.option, from: l.from });
        return false;
      }
      // SCRUM-958 (thread B: "fried rice for the adults please"): an adults' line of a dish the
      // set menu's choice groups give, in the table's own order, with no price and no word asking
      // for more, is the adults' SET line of that dish, never a charged EXTRA: the same reading as
      // a choice said for the adults. Its option, when the chat names none, waits for staff.
      if (l.menu === "adults" && sameOrder && !l.setMenuItemId) {
        const dish = setMenuDishOf(l);
        if (dish) {
          l.setMenuItemId = dish.group.id;
          if (l.notInMenu) {
            l.notInMenu = false;
            l.matchedName = dish.option;
          }
        }
      }
      return true;
    });
    if (folded.length > 0) proposal.adultsFolded = folded;
    // SCRUM-958 (the lane's reviews: "For the adults chicken fried rice and shrimp fried rice"
    // wrote both uncharged): the set menu gives the adults one dish of a group of one choice, as
    // it gives the kids. One SET line per such group, the later line's (as the kids' choice is);
    // another option the chat names for them is an order of its own: an EXTRA, at its till or
    // chat price.
    for (const g of menu.items) {
      if (g.type !== "choice_group" || g.allowMultiple) continue;
      const set = proposal.menuLines.filter((l) => l.menu === "adults" && l.setMenuItemId === g.id);
      if (set.length < 2) continue;
      const kept = set.reduce((was, l) => (laterLineWins(l.from, was.from) ? l : was));
      for (const l of set) {
        if (l === kept) continue;
        delete l.setMenuItemId;
        // An extra line of the dish carries its till code (the option's own, else the group's).
        if (!l.productCode) {
          const option = setMenuOptionOf(g, l.matchedName);
          l.productCode = (option ? g.optionProductCodes[option] : undefined) ?? g.productCode ?? null;
          if (!l.productCode) l.notInMenu = true;
        }
      }
    }
  }

  // SCRUM-787: a cake the conversation times or describes without saying who brings it
  // is proposed with no type ("not said"): the BEO's cake type is left as it is.
  const cake = readOne(CakeAnswer, answer.cake);
  const cakeMode = cake?.mode && cake.mode !== "NOT_SAID" ? cake.mode : null;
  // SCRUM-904: how many cakes, whether it comes with the package and its price — only as the chat says them.
  const cakeMore = readOne(z.object({ quantity: optInt(1), included: z.preprocess((v) => (typeof v === "boolean" ? v : undefined), z.boolean().optional()), price: optBaht }), answer.cake);
  const cakeQuantity = cakeMore?.quantity !== undefined && cakeMore.quantity <= 20 ? cakeMore.quantity : undefined;
  const cakePrice = cakeMore?.price !== undefined ? Math.round(cakeMore.price) : undefined;
  // SCRUM-946: "In the package" is ticked only when the chat or the package says so, never by
  // default (the proof's confirmed party: "the park's cake at 15:00" came back included). The
  // model's `true` stands when the cake's line speaks of the package or of the cake being
  // included or free; the park's cake is the package's when the chosen package includes a cake.
  const cakeLine = cake ? lineTextOf(cake) ?? "" : "";
  const packageHasCake = !!pkg?.lines.some((l) => l.included && CAKE_WORDS.test(l.label));
  const cakeIncluded =
    cakeMore?.included === true
      ? (cakeSaidIncluded(cakeLine) || packageHasCake ? true : undefined)
      : cakeMore?.included === false
        ? false
        : cakeMode === "INTERNAL" && packageHasCake
          ? true
          : undefined;
  if (cake && (cakeMode || cake.time || cake.notes || cakeQuantity !== undefined || cakeIncluded !== undefined || cakePrice !== undefined)) {
    proposal.cake = {
      mode: cakeMode,
      notes: cake.notes ?? null,
      time: cake.time ?? null,
      ...(cakeQuantity !== undefined ? { quantity: cakeQuantity } : {}),
      ...(cakeIncluded !== undefined ? { included: cakeIncluded } : {}),
      ...(cakePrice !== undefined ? { price: cakePrice } : {}),
      from: fromOf(cake, cake.notes, cake.time),
    };
  }

  const deposit = readOne(DepositAnswer, answer.deposit);
  if (deposit && deposit.amount !== undefined && deposit.amount > 0) {
    proposal.deposit = { amount: Math.round(deposit.amount), paid: deposit.paid === true, date: deposit.date ?? null, from: fromOf(deposit, null, Math.round(deposit.amount)) };
  }

  // SCRUM-827: the chat's requests, one entry each; the same words again are the later line's.
  // SCRUM-904: an allergy is its own kind (kept in Special Requests, shown first).
  for (const r of readMany(RequestAnswer, answer.requests, 60)) {
    if (!r.text) continue;
    // SCRUM-946: a show the entertainment carries (approved, an Entertainment Act) is not Activities' text too.
    if ((r.kind ?? "special_request") === "activity" && namesOnlyShows(r.text, proposal.entertainment)) continue;
    const entry = { kind: (r.kind ?? "special_request") as BeoAiRequestKind, text: r.text, from: fromOf(r, r.text) };
    merge(proposal.details.requests, entry, (x) => x.kind === entry.kind && fold(x.text) === fold(entry.text));
  }
  // SCRUM-904: the rest of the form the conversation gives — the booking name, the location,
  // the setup plan, the POS box and the hosts — each with the chat's words for it.
  const sourced = (v: { value?: string; said?: string; line?: number; source?: BeoAiSource } | null): BeoAiSourced<string> | null =>
    v?.value ? { value: v.value, from: fromOf(v, v.said ?? v.value, v.value) } : null;
  const bookingName = sourced(readOne(SaidText(200, ""), ev.bookingName));
  if (bookingName) proposal.details.bookingName = bookingName;
  const locationText = sourced(readOne(SaidText(300, ""), ev.locationText));
  if (locationText) proposal.details.locationText = locationText;
  const setup = answer.setup && typeof answer.setup === "object" ? (answer.setup as Record<string, unknown>) : {};
  const readyBy = readOne(SaidTime, setup.readyBy);
  if (readyBy?.value) proposal.details.setup.readyBy = { value: readyBy.value, from: fromOf(readyBy, readyBy.said, readyBy.value) };
  const responsible = sourced(readOne(SaidText(200, ""), setup.responsible));
  if (responsible) proposal.details.setup.responsible = responsible;
  const setupNotes = sourced(readOne(SaidText(4000, ""), setup.notes));
  if (setupNotes) proposal.details.setup.notes = setupNotes;
  for (const t of readMany(SetupTaskAnswer, setup.tasks, 50)) {
    if (!t.label) continue;
    const entry = { itemLabel: t.label, notes: t.notes ?? null, from: fromOf(t, t.label) };
    merge(proposal.details.setup.tasks, entry, (x) => fold(x.itemLabel) === fold(entry.itemLabel));
  }
  const pos = answer.pos && typeof answer.pos === "object" ? (answer.pos as Record<string, unknown>) : {};
  const posName = sourced(readOne(SaidText(300, ""), pos.name));
  if (posName) proposal.details.pos.name = posName;
  const posNotes = sourced(readOne(SaidText(4000, ""), pos.notes));
  if (posNotes) proposal.details.pos.notes = posNotes;
  for (const i of readMany(PosItemAnswer, pos.items, 50)) {
    if (!i.description) continue;
    const entry = {
      description: i.description,
      type: i.type === "extra" ? ("extra" as const) : ("included" as const),
      ...(i.price !== undefined ? { price: Math.round(i.price) } : {}),
      from: fromOf(i, i.description),
    };
    merge(proposal.details.pos.items, entry, (x) => fold(x.description) === fold(entry.description));
  }
  const team = answer.team && typeof answer.team === "object" ? (answer.team as Record<string, unknown>) : {};
  const partyHost = sourced(readOne(SaidText(200, ""), team.partyHost));
  const entertainmentHost = sourced(readOne(SaidText(200, ""), team.entertainmentHost));
  if (partyHost || entertainmentHost) {
    proposal.details.hosts = { ...(partyHost ? { partyHost } : {}), ...(entertainmentHost ? { entertainmentHost } : {}) };
  }

  // The chat's timed steps, one per step, in clock order.
  // SCRUM-904: a show the entertainment carries at the same time is that act, not a second step
  // (and the drinks at the bar's time are the bar's service): `timedElsewhere`. SCRUM-946: read
  // after the setup plan, so a setup task (which the Timeline places itself) is not a step again.
  for (const t of readMany(TimelineAnswer, answer.timeline, 60)) {
    if (!t.time || !t.label) continue;
    if (timedElsewhere({ time: t.time, label: t.label }, proposal)) continue;
    const entry = { time: t.time, label: t.label, from: fromOf(t, t.label, t.time) };
    merge(proposal.details.timeline, entry, (x) => fold(x.label) === fold(entry.label));
  }
  proposal.details.timeline.sort((a, b) => a.time.localeCompare(b.time));
  return proposal;
}

/** Words for the drinks or the bar, in the languages the park's chats are written in. */
const DRINKS_WORDS = /(^|[^\p{L}])(drinks?|bar|beverages?)([^\p{L}]|$)|เครื่องดื่ม|напит/iu;

/**
 * SCRUM-904: a timeline step the approval already puts on the Timeline
 * another way, so it is not proposed as a step of its own as well: a show the
 * proposal times (the same time, and the show's name or the chat's words for
 * it in the step's label, or the other way round), which approval writes as
 * an Entertainment Act at that time; and the drinks or the bar at the bar's
 * service time, which approval writes as the bar plan's service time. The
 * Timeline makes its own step of each (`generateTimelineFromBeo`), and a
 * step of the chat's beside it would be the same moment twice.
 */
export function timedElsewhere(
  step: { time: string; label: string },
  proposal: Pick<BeoAiProposal, "entertainment" | "event"> & Partial<Pick<BeoAiProposal, "cake" | "details">>,
): boolean {
  const label = fold(step.label);
  if (!label) return false;
  const show = proposal.entertainment.some(
    (e) => e.time === step.time && [e.name, e.said].some((n) => !!n && (fold(n).includes(label) || label.includes(fold(n)))),
  );
  if (show) return true;
  if (proposal.event.barServiceTime?.value === step.time && DRINKS_WORDS.test(step.label)) return true;
  // SCRUM-946 (the 12 November proof): the Timeline makes its own steps of these too.
  // The party's start ("party starts", "from 14:00") beside the automatic Guests arrive, and its
  // end ("party ends", "to 16:30"): a step that says nothing but that, at that time.
  if (proposal.event.startTime?.value === step.time && saysOnly(step.label, START_WORDS)) return true;
  if (proposal.event.endTime?.value === step.time && saysOnly(step.label, END_WORDS)) return true;
  // SCRUM-941: the cake, which approval writes with its time, so the Timeline's Cake moment is
  // the one cake line at the cake's time ("16:00 cakes" beside it is the same moment twice).
  const cake = proposal.cake;
  if (cake?.time && cake.mode !== "NONE" && CAKE_WORDS.test(step.label)) return true;
  // A setup task, which the Timeline places before the start itself, and the setup's ready-by.
  // The lane's reviews: only a step before the party (at or before its start, or at the setup's
  // ready-by) whose words hold the whole task's: "15:30 Games" beside the task "Set up the games
  // corner" is a moment of the party, kept.
  const setup = proposal.details?.setup;
  const start = proposal.event.startTime?.value ?? null;
  const beforeParty = (!!start && step.time <= start) || setup?.readyBy?.value === step.time;
  if (beforeParty && setup?.tasks.some((t) => { const task = fold(t.itemLabel); return !!task && label.includes(task); })) return true;
  return setup?.readyBy?.value === step.time && SETUP_WORDS.test(step.label);
}

/** SCRUM-946: the words that only join a show's name to its time ("Bubble show at 14:00"). */
const SHOW_FILLER = new Set(["at", "the", "a", "an", "show", "shows", "and", "with", "please", "also", "for", "from", "time", "h", "pm", "am", "ตอน", "เวลา", "โชว์", "в", "шоу"]);
/**
 * SCRUM-946 (the 12 November proof: "Bubble show at 14:00" was written into
 * Activities beside the Bubble show's Entertainment Act): whether an
 * activity's words name a show the proposal's entertainment carries and
 * nothing else of their own — its name or the chat's words for it, its time
 * and joining words aside. An activity with words of its own ("a treasure
 * hunt", or a show beside one) stays.
 */
export function namesOnlyShows(text: string, entertainment: BeoAiProposal["entertainment"]): boolean {
  let rest = ` ${fold(text)} `;
  let named = false;
  for (const e of entertainment) {
    for (const n of [e.name, e.said]) {
      const show = n ? fold(n) : "";
      if (show && rest.includes(show)) {
        rest = rest.split(show).join(" ");
        named = true;
      }
    }
  }
  if (!named) return false;
  return rest.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).every((w) => /^\d+$/.test(w) || SHOW_FILLER.has(w));
}

/** SCRUM-946: words saying a thing comes with the package, is included or free. */
const INCLUDED_WORDS = /includ|package|free|no charge|ฟรี|รวม|แพ็ก|แพค|включ|пакет|бесплатн/giu;
const CAKE_AT = /cakes?|เค้ก|торт/giu;
/**
 * SCRUM-946: whether a line says the cake comes with the package (is included,
 * is free): such words within a few words of the cake, in the same sentence.
 * A long confirmation naming the "Birthday package" far from "the park's cake
 * at 15:00" does not say so.
 */
export function cakeSaidIncluded(line: string): boolean {
  for (const sentence of line.split(/[.!?\n]+/)) {
    const cakes = [...sentence.matchAll(CAKE_AT)].map((m) => m.index ?? 0);
    if (cakes.length === 0) continue;
    const words = [...sentence.matchAll(INCLUDED_WORDS)].map((m) => m.index ?? 0);
    if (words.some((w) => cakes.some((c) => Math.abs(w - c) <= 40))) return true;
  }
  return false;
}
/**
 * SCRUM-946 (the lane's reviews): whether the chat asks for more of a dish —
 * in its words for it, or beside them in the same clause of its line ("Margherita
 * pizza, extra fries", "дополнительно картошка фри", "เพิ่มเฟรนช์ฟรายส์"). "With
 * the fries please" on a set menu that includes them asks for none.
 */
export function moreAsked(itemName: string, text: string | null): boolean {
  if (asksForMore(itemName)) return true;
  const name = fold(itemName);
  if (!text || !name) return false;
  const line = fold(text);
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const before = line.slice(Math.max(0, at - 30), at).split(/[,.;:!?\n]/).pop() ?? "";
    const after = line.slice(at + name.length, at + name.length + 15).split(/[,.;:!?\n]/)[0] ?? "";
    if (asksForMore(before) || asksForMore(after)) return true;
  }
  return false;
}
/**
 * SCRUM-958: words naming the adults, in the languages the park's chats are
 * written in. "Parents" only as whom a dish is for ("for the parents", "для
 * родителей"): the family writing is usually the parents ("The parents would
 * like the Hawaiian pizza" chooses for the kids).
 */
const ADULT_WORDS = /(^|[^\p{L}])(adults?|grown[- ]?ups?)([^\p{L}]|$)|(^|[^\p{L}])for (the )?parents([^\p{L}]|$)|ผู้ใหญ่|взросл|для родителей/iu;
/** SCRUM-958: words naming the kids. */
const KID_WORDS = /(^|[^\p{L}])(kids?|kiddies|child|children|little ones)([^\p{L}]|$)|เด็ก|дет[иейяскм]|ребён|ребен/iu;
/**
 * SCRUM-958: what ends the part of a line that says one thing: a stop, a
 * comma, a joining word. Never a colon: "Adults: chicken fried rice" is one
 * part, its label naming whom it is for.
 */
const PART_BREAK = /[.,;!?\n]|(?:^|\s)(?:and|but|while|whereas|plus)(?=\s)|(?:^|\s)(?:и|а|но)(?=\s)|และ|ส่วน|แต่/giu;
/** SCRUM-958: what ends a sentence, back to which a part's label is read. */
const HARD_STOP = /[.;!?\n]/g;
/** SCRUM-958: the words naming the kids or the adults, each whole, to take out of a phrase. */
const AUDIENCE_WORDS =
  /(?<!\p{L})(?:adults?|grown[- ]?ups?|parents|kids?|kiddies|children|child|little ones)(?!\p{L})|ผู้ใหญ่|เด็ก|(?<!\p{L})(?:взросл|дет|ребён|ребен|родител)\p{L}*/giu;
/** SCRUM-958: the words that only join whom a dish is for ("and the kids too", "и детям"). */
const AUDIENCE_FILLER = new Set(["the", "for", "all", "both", "too", "also", "as", "well", "our", "of", "them", "their", "to", "please", "s", "для", "всех", "всем", "тоже", "также", "обоих", "пожалуйста"]);
const THAI_FILLER = /ทั้งหมด|ทั้ง|ด้วย|สำหรับ|ค่ะ|ครับ|นะ|ทุกคน/gu;
/** SCRUM-958: whether a phrase names the kids or the adults and nothing else ("the kids", "both adults"). */
function onlyAudience(text: string): boolean {
  const rest = text.replace(AUDIENCE_WORDS, " ");
  if (rest === text) return false;
  return rest
    .replace(THAI_FILLER, " ")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)
    .every((w) => AUDIENCE_FILLER.has(w) || /^\d+$/.test(w));
}
/**
 * SCRUM-958 (the lane's reviews): a headcount ("12 kids and 8 adults", "12
 * детей", "เด็ก 12 คน") says how many come, never whom a dish is for. Kept
 * only when the words give the dish to them: "for the 10 adults", "для 8
 * взрослых", "สำหรับผู้ใหญ่ 8 ท่าน".
 */
const HEADCOUNTS = [
  /(?<!\p{L})(for\s+the\s+)?\d+\s*(?:adults?|grown[- ]?ups?|parents|kids?|kiddies|children|child|little ones)(?!\p{L})/giu,
  /(?<!\p{L})(для\s+)?\d+\s*(?:взросл|дет|ребён|ребен|родител)\p{L}*/giu,
  /(สำหรับ\s*)?(?:(?:เด็ก|ผู้ใหญ่)\s*\d+\s*(?:คน|ท่าน)?|\d+\s*(?:คน\s*)?(?:เด็ก|ผู้ใหญ่))/gu,
];
const withoutHeadcounts = (text: string) => HEADCOUNTS.reduce((t, re) => t.replace(re, (m: string, giving?: string) => (giving ? m : " ")), text);
/** SCRUM-958: whom a phrase names: the adults, the kids, both or neither (a headcount names nobody). */
const audienceOf = (text: string) => {
  const words = withoutHeadcounts(text);
  return { adults: ADULT_WORDS.test(words), kids: KID_WORDS.test(words) };
};
/**
 * SCRUM-958 (the 12 November proof, thread A: "And chicken fried rice for the
 * adults."): whether the chat says a set-menu choice only for the adults. The
 * chat's words for it name the adults and not the kids; or, when they name
 * nobody, the part of their line that holds them (up to a stop, a comma or a
 * joining word: "Veggie fried rice for the kids and chicken fried rice for the
 * adults" is two parts) does. A joining word between whom a dish is for only
 * joins them ("for the adults and the kids", "for both adults and kids": both
 * named). A part naming nobody after a label of its sentence ("Adults: pizza,
 * chicken fried rice") is the label's. Words that name nobody anywhere
 * ("chicken fried rice") are the set menu's choice, as before.
 */
export function saidForTheAdults(said: string | null | undefined, lineText: string | null | undefined): boolean {
  const words = said?.trim() ?? "";
  if (!words) return false;
  const named = audienceOf(words);
  if (named.adults || named.kids) return named.adults && !named.kids;
  if (!lineText) return false;
  const line = fold(lineText);
  const at = line.indexOf(fold(words));
  if (at < 0) return false;
  const end = at + fold(words).length;
  // The line's breaks, but a joining word with only whom a dish is for on one side of it.
  const raw = [...line.matchAll(PART_BREAK)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, joining: !/^[.,;!?\n]$/.test(m[0]) }));
  const breaks = raw.filter((b, i) => {
    if (!b.joining) return true;
    const before = line.slice(i > 0 ? raw[i - 1]!.end : 0, b.start);
    const after = line.slice(b.end, i + 1 < raw.length ? raw[i + 1]!.start : line.length);
    return !onlyAudience(before) && !onlyAudience(after);
  });
  const from = breaks.filter((b) => b.end <= at).at(-1)?.end ?? 0;
  const to = breaks.find((b) => b.start >= end)?.start ?? line.length;
  const part = audienceOf(line.slice(from, to));
  if (part.adults || part.kids) return part.adults && !part.kids;
  // A part naming nobody: the label of its sentence before it, when there is one.
  const sentence = [...line.slice(0, from).matchAll(HARD_STOP)].at(-1);
  const lead = line.slice(sentence ? (sentence.index ?? 0) + 1 : 0, from);
  const colon = Math.max(lead.lastIndexOf(":"), lead.lastIndexOf(" - "), lead.lastIndexOf(" – "));
  if (colon < 0) return false;
  const label = audienceOf(lead.slice(0, colon));
  return label.adults && !label.kids;
}
/** SCRUM-946: words saying a price is for one item ("450 each", "по 450", "ถาดละ 450"). */
const PER_ITEM_WORDS = /(^|[^\p{L}])(each|per|apiece|a piece|ea)([^\p{L}]|$)|\/\s*(pc|pcs|piece|each)|ละ|ต่อ|за штуку|за шт|кажд|по\s*$/iu;
/** SCRUM-946: words saying a price is the total for several ("for 900", "900 in total", "всего 900"). */
const TOTAL_WORDS = /(^|[^\p{L}])(total|in all|altogether|together|for (both|all|the two|the three|them|everything))([^\p{L}]|$)|รวม|ทั้งหมด|всего|итого|вместе|за все|за обе|за оба/iu;
/**
 * SCRUM-946 (the lane's reviews): whether a line names a price as the total
 * for several of an item ("2 extra pizzas for 900 baht", "900 for both"),
 * not the price of one: written as the price for each item, the till would
 * charge it times the quantity. A price said for each ("at 450 each", "по
 * 450"), for one ("an extra pizza for 450"), or with nothing either way ("2
 * more at 450", the owner's ruling of 12 November), is the price of one.
 */
export function chatPriceIsTotal(text: string | null, price: number, quantity: number): boolean {
  if (!text || !(quantity > 1) || !(price > 0)) return false;
  // The figure as the chat writes it, its thousands apart ("1,800", "1 800").
  const line = text.normalize("NFC").toLowerCase().replace(/(\d)[,\s.](?=\d{3}(?!\d))/g, "$1");
  const figure = String(price).replace(/\.0+$/, "");
  const clauseBefore = (t: string) => t.split(/[,.;!?\n]/).pop() ?? "";
  const clauseAfter = (t: string) => t.split(/[,.;!?\n]/)[0] ?? "";
  // "for 900" is a total only after the count itself ("2 pizzas for 900"), never after one item.
  const count = new RegExp(`(^|[^0-9])${quantity}(?![0-9])|(^|[^\\p{L}])(${COUNT_WORDS[quantity] ?? "(?!)"})([^\\p{L}]|$)`, "iu");
  for (const m of line.matchAll(new RegExp(`(^|[^0-9])(${figure.replace(".", "[.]")})(?![0-9])`, "g"))) {
    const at = (m.index ?? 0) + m[1]!.length;
    const before = clauseBefore(line.slice(Math.max(0, at - 60), at));
    const after = clauseAfter(line.slice(at + figure.length, at + figure.length + 25));
    if (PER_ITEM_WORDS.test(before) || PER_ITEM_WORDS.test(after)) continue;
    if ((/(^|[^\p{L}])(for|за)\s*(฿|thb|baht|бат\p{L}*)?\s*$/iu.test(before) && count.test(before)) || TOTAL_WORDS.test(before) || TOTAL_WORDS.test(after)) return true;
  }
  return false;
}
/** SCRUM-946: a count written out, 2 to 10, in the languages the park's chats are written in. */
const COUNT_WORDS: Record<number, string> = {
  2: "two|both|два|две|สอง", 3: "three|три|สาม", 4: "four|четыре|สี่", 5: "five|пять|ห้า", 6: "six|шесть|หก",
  7: "seven|семь|เจ็ด", 8: "eight|восемь|แปด", 9: "nine|девять|เก้า", 10: "ten|десять|สิบ",
};
/** SCRUM-941: words for the cake, in the languages the park's chats are written in. */
const CAKE_WORDS = /(^|[^\p{L}])cakes?([^\p{L}]|$)|เค้ก|торт/iu;
/** SCRUM-946: words for getting the room ready. */
const SETUP_WORDS = /(^|[^\p{L}])(set ?up|ready|decorat\p{L}*)([^\p{L}]|$)|เตรียม|จัดห้อง|подготов|готов/iu;
/** SCRUM-946: the words a step that only marks the party's start or end is made of (and its time). */
const START_WORDS = new Set([
  "party", "the", "guests", "guest", "kids", "children", "everyone", "arrive", "arrives", "arrival", "arriving", "start", "starts", "starting",
  "begin", "begins", "beginning", "from", "at", "of", "birthday", "time", "open", "opens", "doors", "h", "pm", "am",
  "เริ่ม", "เริ่มงาน", "งาน", "เวลา", "начало", "начинается", "праздник", "вечеринка", "гости", "приходят", "с", "в",
]);
const END_WORDS = new Set([
  "party", "the", "guests", "kids", "children", "everyone", "end", "ends", "ending", "finish", "finishes", "finished", "over", "close",
  "closes", "until", "till", "to", "at", "of", "birthday", "time", "leave", "leaves", "goodbye", "bye", "h", "pm", "am",
  "เลิก", "จบ", "จบงาน", "เลิกงาน", "งาน", "เวลา", "สิ้นสุด", "конец", "заканчивается", "праздник", "вечеринка", "до", "в",
]);
/** Whether a label holds only these words and numbers (its time): "party starts", "from 14:00". */
function saysOnly(label: string, words: ReadonlySet<string>): boolean {
  const parts = label.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return parts.length > 0 && parts.every((w) => /^\d+$/.test(w) || words.has(w));
}

/** A real calendar day, YYYY-MM-DD. */
function isCalendarDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * SCRUM-904: a phone number the chat writes out, as the line holds it: 6 to
 * 15 digits, every one of them written in that line in that order (spaces,
 * dashes, dots, brackets and a leading + aside). A number the line does not
 * hold is the model's, never proposed.
 */
export function phoneInLine(value: string, lineText: string | null): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15 || !/^\+?[\d\s().\-]+$/.test(value.trim())) return false;
  return !!lineText && lineText.replace(/\D/g, "").includes(digits);
}

// --- SCRUM-827: the rest of the BEO from the form's own read ------------------------------

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const heldText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** The same words, case and spacing aside. */
const sameText = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && fold(a) === fold(b);

/**
 * SCRUM-904 (Phase B): the conversation's read now gives the rest of the form
 * itself (`resolveCatalogueAnswer`), each value with its line and words; what
 * it gives stands, and the form's own read below only fills what it leaves
 * out (a booking name, a location, the setup plan's ready-by and who, the POS
 * box's name and notes, tasks and line items it does not hold). A task or
 * line item the BEO already holds is not proposed again.
 *
 * The rest of the BEO the form's own read gives (the ruling message, read
 * alone with the form as its baseline), put on the proposal with its source:
 * the booking name, the location, the setup plan and the POS box are the
 * ruling's (`from`); the title is the app's own rule from the child's name and
 * the age the chat gave (else the form's name and the age the event holds) —
 * marked as the park's default, the rule's own value, never as the chat's
 * words — and only for a birthday (the event's type, else
 * the form's; as apps/api's Book Date names only birthdays so): a camp or a
 * corporate event is not named after a child's birthday. A value equal to
 * what the form already holds is the form's, carried forward by the model,
 * and is not proposed. The requests
 * and the timeline the conversation's read gave stand; what the form's read
 * gives of them (its special requests, decoration, activities and timeline)
 * joins only where the conversation's read holds no such words, so a park
 * group whose saved format never asked for them still fills them, and a
 * sentence the ruling repeats is not proposed twice.
 */
export function detailsFromFill(
  proposal: BeoAiProposal,
  fill: BeoFill,
  input: {
    existingData: unknown;
    from: BeoAiFrom;
    event: { childName?: string | null; kidTurningAge?: number | null; eventType?: string | null } | null;
    /**
     * SCRUM-904: the ruling message's text: each value read from it quotes its own words there
     * (or the part of a long message around them), not the message's first characters.
     */
    rulingText?: string | null;
  },
): BeoAiDetails {
  const existing = asRecord(input.existingData);
  const formEvent = asRecord(existing.event);
  const formSetup = asRecord(existing.setupPlan);
  const formPos = asRecord(existing.partyDetails);
  const bare: BeoAiFrom = { source: input.from.source, at: input.from.at, line: input.from.line };
  const fromFor = (value: string): BeoAiFrom => (input.rulingText ? withQuote(bare, value, input.rulingText, [value]) : input.from);
  const details: BeoAiDetails = { ...proposal.details, setup: { ...proposal.details.setup }, pos: { ...proposal.details.pos } };
  const sourced = (value: string | undefined, held: unknown) => (value && !sameText(value, heldText(held)) ? { value, from: fromFor(value) } : null);

  const child = proposal.event.childName?.value ?? fill.event?.childName ?? heldText(formEvent.childName) ?? input.event?.childName ?? null;
  const kind = input.event?.eventType ?? heldText(formEvent.eventType);
  // SCRUM-904: the age the chat gives first, as the child's name is, so the title and the Age row
  // the approval writes never disagree; else the age the event holds.
  const age = proposal.event.childAge?.value ?? input.event?.kidTurningAge ?? null;
  const title = kind === "birthday" ? beoEventTitleOf(child, age) : null;
  details.title = title ? { value: title, from: { source: "default", at: null, line: null } } : null;
  details.bookingName = proposal.details.bookingName ?? sourced(fill.event?.bookingName, formEvent.bookingName);
  details.locationText = proposal.details.locationText ?? sourced(fill.event?.locationText, formEvent.locationText);
  details.setup.readyBy = proposal.details.setup.readyBy ?? sourced(fill.setupPlan?.readyBy, formSetup.readyBy);
  details.setup.responsible = proposal.details.setup.responsible ?? sourced(fill.setupPlan?.responsible, formSetup.responsible);
  details.pos.name = proposal.details.pos.name ?? sourced(fill.partyDetails?.packageName, formPos.packageName);
  details.pos.notes = proposal.details.pos.notes ?? sourced(fill.partyDetails?.notes, formPos.notes);

  const heldTasks = (Array.isArray(formSetup.simplifiedTasks) ? formSetup.simplifiedTasks : []).map((t) => heldText(asRecord(t).itemLabel));
  details.setup.tasks = proposal.details.setup.tasks.filter((t) => !heldTasks.some((h) => sameText(h, t.itemLabel)));
  for (const t of fill.setupPlan?.simplifiedTasks ?? []) {
    if (heldTasks.some((h) => sameText(h, t.itemLabel)) || details.setup.tasks.some((x) => sameText(x.itemLabel, t.itemLabel))) continue;
    details.setup.tasks.push({ itemLabel: t.itemLabel, notes: t.notes ?? null, from: fromFor(t.itemLabel) });
  }
  const heldItems = (Array.isArray(formPos.items) ? formPos.items : []).map((i) => heldText(asRecord(i).description));
  details.pos.items = proposal.details.pos.items.filter((i) => !heldItems.some((h) => sameText(h, i.description)));
  for (const i of fill.partyDetails?.items ?? []) {
    if (heldItems.some((h) => sameText(h, i.description)) || details.pos.items.some((x) => sameText(x.description, i.description))) continue;
    // SCRUM-904: a price only when the message names one for the item.
    const price = typeof i.price === "number" && i.price > 0 ? { price: Math.round(i.price) } : {};
    details.pos.items.push({ description: i.description, type: i.type === "extra" ? "extra" : "included", ...price, from: fromFor(i.description) });
  }

  // The ruling's own request fields, only where the conversation's read holds no such words.
  const covered = (text: string) => details.requests.some((r) => fold(r.text).includes(fold(text)) || fold(text).includes(fold(r.text)));
  details.requests = [...proposal.details.requests];
  for (const [kind, value, held] of [
    ["special_request", fill.event?.specialRequests, formEvent.specialRequests],
    ["decoration", fill.event?.decoration, formEvent.decoration],
    ["activity", fill.event?.activities, formEvent.activities],
  ] as const) {
    if (!value || sameText(value, heldText(held)) || covered(value)) continue;
    // SCRUM-946: the ruling's activities that only name a show the review carries are that show's act.
    if (kind === "activity" && namesOnlyShows(value, proposal.entertainment)) continue;
    details.requests.push({ kind, text: value, from: fromFor(value) });
  }
  details.timeline = [...proposal.details.timeline];
  if (details.timeline.length === 0) {
    for (const t of fill.timeline ?? []) {
      if (details.timeline.some((x) => sameText(x.label, t.label))) continue;
      // SCRUM-904: a show the conversation times, or the drinks at the bar's time, is not a step twice.
      // SCRUM-946: nor the party's start or end, the cake, or a setup task (the ruling's own too).
      const timed = (key: "startTime" | "endTime") => {
        const v = proposal.event[key]?.value ?? (typeof fill.event?.[key] === "string" ? fill.event[key] : undefined);
        return v ? { [key]: { value: v, from: input.from } } : {};
      };
      if (timedElsewhere(t, { ...proposal, details, event: { ...proposal.event, ...timed("startTime"), ...timed("endTime") } })) continue;
      details.timeline.push({ time: t.time, label: t.label, from: fromFor(t.label) });
    }
    details.timeline.sort((a, b) => a.time.localeCompare(b.time));
  }
  return details;
}
