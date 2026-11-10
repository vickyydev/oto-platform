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
  laterLineWins,
  type BeoAiCatalogueView,
  type BeoAiFood,
  type BeoAiFrom,
  type BeoAiMenu,
  type BeoAiProposal,
  type BeoAiSetMenuItem,
  type BeoAiSource,
} from "@shared/beoAiFill";
import { BeoFillSchema, parkClockAt } from "./aiFill";
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
 * The till's F&B catalogue is not readable from this app: the food the fill
 * matches to is what the park's set menus name with a till product code
 * (SCRUM-803), and anything else is a free line marked `notInMenu`.
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
 * option, "Fried rice (Veggie)").
 */
export function foodOfSetMenus(setMenus: Array<{ items: BeoAiSetMenuItem[] }>): BeoAiFood[] {
  const byCode = new Map<string, string[]>();
  const add = (code: string | null, name: string) => {
    if (!code) return;
    const key = code.trim().toUpperCase();
    const names = byCode.get(key) ?? [];
    if (!names.includes(name)) names.push(name);
    byCode.set(key, names);
  };
  for (const menu of setMenus) {
    for (const item of menu.items) {
      if (item.type === "always_included") add(item.productCode, item.label);
      else {
        for (const opt of item.options) {
          const own = item.optionProductCodes[opt];
          if (own) add(own, opt);
          else if (item.productCode) add(item.productCode, `${item.label} (${opt})`);
        }
      }
    }
  }
  return [...byCode.entries()].map(([code, names]) => ({ code, names })).sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

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

/** No catalogue: the fill reads as SCRUM-660's did (a catalogue that could not be read is this). */
export const emptyCatalogue = (): BeoCatalogue => ({
  packages: [],
  setMenus: [],
  entertainment: [],
  food: [],
});

/** Whether there is anything to match a conversation to. */
export const catalogueIsEmpty = (c: BeoAiCatalogueView) =>
  c.packages.length === 0 && c.setMenus.length === 0 && c.entertainment.length === 0;

// --- The conversation, as the model reads it ------------------------------------------

/** One numbered line of the conversation the model read: who wrote it, when, and whether it is the ruling. */
export interface TranscriptRef {
  line: number;
  id: string;
  source: BeoAiSource;
  at: string;
  ruling: boolean;
}

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
 * out oldest first; `cut` says so.
 */
export function renderTranscript(
  lines: InboxTranscriptLine[],
  ruling: { id: string; body: string; at: string },
  timeZone: string,
): { text: string; refs: TranscriptRef[]; cut: boolean } {
  const all = lines.some((l) => l.id === ruling.id)
    ? [...lines]
    : [...lines, { id: ruling.id, author: "staff" as const, at: ruling.at, text: ruling.body }].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at),
      );
  const render = (l: InboxTranscriptLine, n: number) => {
    const who = l.author === "customer" ? "family" : "team";
    const mark = l.id === ruling.id ? `${who}, RULING` : who;
    const body = l.text.replace(/\r\n?/g, "\n").replace(/\n/g, "\n    ");
    return `#${n} [${mark}] ${localTimeOf(l.at, timeZone)}: ${body}`;
  };
  let kept = all;
  let cut = false;
  const size = (ls: InboxTranscriptLine[]) => ls.reduce((sum, l, i) => sum + render(l, i + 1).length + 1, 0);
  while (kept.length > 1 && size(kept) > TRANSCRIPT_TEXT_MAX) {
    const drop = kept.findIndex((l) => l.id !== ruling.id);
    if (drop < 0) break;
    kept = kept.filter((_, i) => i !== drop);
    cut = true;
  }
  const refs = kept.map((l, i) => ({
    line: i + 1,
    id: l.id,
    source: (l.author === "customer" ? "family" : "team") as BeoAiSource,
    at: l.at,
    ruling: l.id === ruling.id,
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
  };
}

/**
 * The rules for reading a whole conversation: which line wins, what the
 * family's values are, and that the conversation is read only into the
 * `catalogue` key (every entry names its line, so its source is known). The
 * form's own fields are read apart, from the ruling message alone, as before.
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
The new text is not one message: it is the whole conversation between the family and the park's team, oldest line first. Each line starts with its number, who wrote it ([family] is the customer, [team] is a person on the park's team) and its local time at the park. The line marked RULING is the team's final confirmation.
- The latest line wins, whoever wrote it: where two lines speak about the same thing, give the value of the later line, with that line's number. The team's confirmation (the RULING line, or another team line) wins over every family line BEFORE it; a family line AFTER the confirmation that corrects or declines something is the current value, given as the family's
- The family's values are the defaults: what the family asked for that no later line changes is still given, as the family's
- Answer ONLY the "catalogue" key described below and leave every other key of the structure above out: the form's other fields are read apart, from the RULING line alone`;

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
  "deposit": { "amount": 0, "paid": true, "date": "YYYY-MM-DD", "line": 0, "source": "team | family" }
}`;

/**
 * What the system prompt gains for a fill from the conversation with the
 * park's catalogue: the conversation's rules (when it is a conversation), the
 * catalogue, how to match it, and the `catalogue` key's format.
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
- Never invent an item, a quantity or a price, and never price or total anything: "chatPrice" is only a price the conversation itself names for that item, in baht as written; otherwise leave it out
- Keep the conversation's own wording and language in "said" and "itemName". Do not translate
- Every entry carries "line": the number of the conversation line it comes from (for what the team confirmed, the team's line), and "source": "team" when that line is the team's, "family" when it is the family's
- A deposit is "paid": true only when the conversation says it was received
- The cake's "mode" is NOT_SAID when the conversation gives a cake time or cake details but does not say whether the park or the family brings the cake: never guess it

Add this key at the top level of the JSON object, leaving out any entry the conversation does not speak to:
${BEO_CATALOGUE_OUTPUT_FORMAT}`
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
  menu: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : undefined), z.enum(BEO_AI_MENUS).optional()),
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
  })
  .partial();

/** SCRUM-816: what the form's read handed the catalogue (no conversation) answers: the form's fields and the catalogue section. */
export const BEO_FILL_WITH_CATALOGUE_SHAPE = BeoFillSchema.extend({ catalogue: BeoCatalogueAnswerShape.optional() });
/** SCRUM-816: what the conversation's read answers: the catalogue section alone. */
export const CATALOGUE_ONLY_SHAPE = z.object({ catalogue: BeoCatalogueAnswerShape.optional() });

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
 */
export function resolveCatalogueAnswer(
  raw: unknown,
  catalogue: BeoAiCatalogueView,
  refs: TranscriptRef[],
  /** The ruling message read alone (no conversation): every value is the team's. */
  fallback?: BeoAiFrom,
): BeoAiProposal {
  const answer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const allTeam = refs.length > 0 && refs.every((r) => r.source === "team");
  const fromOf = (entry: { line?: number; source?: BeoAiSource }): BeoAiFrom => {
    const known = entry.line ? refs.find((r) => r.line === entry.line) : undefined;
    if (known) return { source: known.source, at: known.at, line: known.line };
    if (fallback) return fallback;
    // A conversation holding only the team's lines (the ruling alone): the team's.
    if (allTeam) return refs.length === 1 ? { source: "team", at: refs[0]!.at, line: refs[0]!.line } : { source: "team", at: null, line: null };
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
  };
  const other = (text: string | undefined, chatPrice: number | undefined, from: BeoAiFrom) => {
    if (text) proposal.otherLines.push({ text, chatPrice: chatPrice ?? null, from });
  };

  // The package.
  const pkgAnswer = readOne(PackageAnswer, answer.package);
  const pkg = pkgAnswer?.templateId ? catalogue.packages.find((p) => p.id === pkgAnswer.templateId) : undefined;
  if (pkgAnswer && pkg) {
    proposal.package = { templateId: pkg.id, said: pkgAnswer.said ?? null, chatPrice: pkgAnswer.chatPrice ?? null, from: fromOf(pkgAnswer) };
  } else if (pkgAnswer) {
    other(pkgAnswer.said, pkgAnswer.chatPrice, fromOf(pkgAnswer));
  }

  // Add-ons: the chosen package's lines it does not include.
  for (const a of readMany(AddOnAnswer, answer.addOns)) {
    const line = pkg?.lines.find((l) => l.id === a.lineId && !l.included);
    if (line) {
      const quantity = a.quantity && a.quantity > 0 ? a.quantity : 1;
      const entry = { lineId: line.id, quantity, said: a.said ?? null, chatPrice: a.chatPrice ?? null, from: fromOf(a) };
      merge(proposal.addOns, entry, (x) => x.lineId === line.id);
    } else {
      other(a.said, a.chatPrice, fromOf(a));
    }
  }

  // The set menu: the one named, else the chosen package's own.
  const setAnswer = readOne(SetMenuAnswer.extend({ choices: z.unknown() }), answer.setMenu);
  const named = setAnswer?.templateId ? catalogue.setMenus.find((m) => m.id === setAnswer.templateId) : undefined;
  const fromPackage = !named && pkg?.setMenuTemplateId ? catalogue.setMenus.find((m) => m.id === pkg.setMenuTemplateId) : undefined;
  const menu = named ?? fromPackage;
  if (setAnswer && !menu) other(setAnswer.said, undefined, fromOf(setAnswer));
  if (menu) {
    const from = named && setAnswer ? fromOf(setAnswer) : proposal.package!.from;
    const chosen: Array<{ itemId: string; option: string; said: string | null; from: BeoAiFrom }> = [];
    for (const c of readMany(ChoiceAnswer, setAnswer?.choices)) {
      const group = menu.items.find((i) => i.id === c.itemId && i.type === "choice_group") as
        | Extract<BeoAiSetMenuItem, { type: "choice_group" }>
        | undefined;
      const option = group && c.option ? group.options.find((o) => fold(o) === fold(c.option!)) : undefined;
      const cFrom = fromOf(c);
      if (!group || !option) {
        // A choice the set menu does not list: a dish of its own, for staff to decide.
        const itemName = c.said ?? c.option;
        if (itemName) {
          proposal.menuLines.push({
            menu: "kids", itemName, quantity: 1, productCode: null, matchedName: null, notInMenu: true, chatPrice: null, from: cFrom,
          });
        }
        continue;
      }
      // A group of one choice holds one option (the later line's, whoever wrote it);
      // a group of several holds each option once, its source the same way.
      const entry = { itemId: group.id, option, said: c.said ?? null, from: cFrom };
      merge(chosen, entry, (x) => x.itemId === group.id && (!group.allowMultiple || x.option === option));
    }
    proposal.setMenu = { templateId: menu.id, from, choices: chosen };
  }

  // Dishes and drinks beyond the set menu.
  const codes = new Map(catalogue.food.map((f) => [f.code.toUpperCase(), f]));
  for (const m of readMany(MenuLineAnswer, answer.menuLines, 100)) {
    const food = m.productCode ? codes.get(m.productCode.trim().toUpperCase()) : undefined;
    const itemName = m.itemName ?? food?.names[0];
    if (!itemName) continue;
    const menu = (m.menu ?? "kids") as BeoAiMenu;
    const line = {
      menu,
      itemName,
      quantity: m.quantity ?? 1,
      productCode: food?.code ?? null,
      matchedName: food?.names[0] ?? null,
      notInMenu: !food,
      chatPrice: m.chatPrice ?? null,
      from: fromOf(m),
    };
    // A dish the menu codes is one line per list; one it lacks stays as the conversation said it.
    if (food) merge(proposal.menuLines, line, (x) => x.productCode === food.code && x.menu === menu);
    else proposal.menuLines.push(line);
  }

  // Entertainment: one line per entertainment the menu has; a free line as said.
  for (const e of readMany(EntertainmentAnswer, answer.entertainment, 30)) {
    const t = e.templateId ? catalogue.entertainment.find((x) => x.id === e.templateId) : undefined;
    const name = t?.name ?? e.said;
    if (!name) continue;
    const entry = {
      templateId: t?.id ?? null,
      name,
      said: e.said ?? null,
      quantity: e.quantity ?? 1,
      chatPrice: e.chatPrice ?? null,
      notInCatalogue: !t,
      from: fromOf(e),
    };
    if (t) merge(proposal.entertainment, entry, (x) => x.templateId === t.id);
    else proposal.entertainment.push(entry);
  }

  // The event's own fields.
  const ev = answer.event && typeof answer.event === "object" ? (answer.event as Record<string, unknown>) : {};
  const childName = readOne(SourcedText, ev.childName);
  if (childName?.value) proposal.event.childName = { value: childName.value, from: fromOf(childName) };
  for (const key of ["numChildren", "numAdults"] as const) {
    const v = readOne(SourcedCount, ev[key]);
    if (v && v.value !== undefined) proposal.event[key] = { value: v.value, from: fromOf(v) };
  }
  for (const key of ["startTime", "endTime"] as const) {
    const v = readOne(SourcedTime, ev[key]);
    if (v?.value) proposal.event[key] = { value: v.value, from: fromOf(v) };
  }

  // SCRUM-787: a cake the conversation times or describes without saying who brings it
  // is proposed with no type ("not said"): the BEO's cake type is left as it is.
  const cake = readOne(CakeAnswer, answer.cake);
  const cakeMode = cake?.mode && cake.mode !== "NOT_SAID" ? cake.mode : null;
  if (cake && (cakeMode || cake.time || cake.notes)) {
    proposal.cake = { mode: cakeMode, notes: cake.notes ?? null, time: cake.time ?? null, from: fromOf(cake) };
  }

  const deposit = readOne(DepositAnswer, answer.deposit);
  if (deposit && deposit.amount !== undefined && deposit.amount > 0) {
    proposal.deposit = { amount: Math.round(deposit.amount), paid: deposit.paid === true, date: deposit.date ?? null, from: fromOf(deposit) };
  }
  return proposal;
}
