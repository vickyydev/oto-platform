import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  beoSetMenuTemplates,
  birthdayPackageTemplates,
  branches,
  entertainmentPackageTemplates,
  packageLineItemTemplates,
} from "@shared/schema";
import {
  BEO_AI_CAKE_MODES,
  BEO_AI_MENUS,
  type BeoAiCatalogueView,
  type BeoAiFood,
  type BeoAiFrom,
  type BeoAiMenu,
  type BeoAiProposal,
  type BeoAiSetMenuItem,
  type BeoAiSource,
} from "@shared/beoAiFill";
import type { InboxTranscriptLine } from "./inboxConfirmation";
import type { DbExecutor } from "./packageSnapshot";

/**
 * THE BEO FILLED FROM THE WHOLE CONVERSATION AND MATCHED TO THE CATALOGUE
 * (SCRUM-815), the server's half.
 *
 * Create BEO's AI Fill used to read one message (the team's final
 * confirmation) and answer free text: a package's name, menu lines by name,
 * activities as a sentence. Now it reads the conversation (the platform's
 * `transcript`, the ruling message named in it) and the park's catalogue
 * (`loadBeoCatalogue`), and the model also answers a `catalogue` section:
 * the package, set menu and choices, add-ons, entertainment and extra menu
 * lines BY ID, the counts, times, cake and deposit, each with the line it
 * came from. `resolveCatalogueAnswer` checks every id against the catalogue
 * the model was handed (an id it does not hold is a free line in the
 * message's own words), and the source of every value is the transcript's —
 * the line's author — never the model's say-so where the line is known.
 *
 * The till's F&B catalogue is not readable from this app: the food the fill
 * matches to is what the park's set menus name with a till product code
 * (SCRUM-803), and anything else is a free line marked `notInMenu`.
 */

/** The park's catalogue for one party: what the review shows and the model is handed. */
export interface BeoCatalogue extends BeoAiCatalogueView {
  /** The party's park: the transcript's times are its local times. */
  place: { name: string | null; timeZone: string };
}

/** The parks' zone when a park names none: every branch is in Bangkok today. */
const PARKS_ZONE = "Asia/Bangkok";

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
  let place: BeoCatalogue["place"] = { name: null, timeZone: PARKS_ZONE };
  if (input.branchId) {
    const [branch] = await db
      .select({ name: branches.name, timeZone: branches.timezone })
      .from(branches)
      .where(and(eq(branches.id, input.branchId), eq(branches.tenantId, input.tenantId)));
    if (branch) place = { name: branch.name, timeZone: branch.timeZone || PARKS_ZONE };
  }
  const setMenus = menus.map((m) => ({ id: m.id, name: m.name, items: setMenuItemsOf(m.items) }));
  return {
    place,
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
  place: { name: null, timeZone: PARKS_ZONE },
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

/** "2026-11-05 14:30", the park's own clock, read field by field. */
function localTimeOf(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  };
  try {
    return read(timeZone);
  } catch {
    return read(PARKS_ZONE);
  }
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

/** The rules for reading a whole conversation: who wins, and what the family's values are. */
export const BEO_CONVERSATION_RULES = `

THE CONVERSATION
The new text is not one message: it is the whole conversation between the family and the park's team, oldest line first. Each line starts with its number, who wrote it ([family] is the customer, [team] is a person on the park's team) and its local time at the park. The line marked RULING is the team's final confirmation.
- The team's confirmation wins: where the RULING line (or another team line confirming or changing what the family asked) and a family line speak about the same thing, use the team's value
- The family's values are the defaults: what the family asked for that no team line confirms or changes is still filled, as the family's
- A later line correcting an earlier one wins
- Fill the form's own fields from the whole conversation by the same rules`;

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
  "cake": { "mode": "INTERNAL | EXTERNAL | NONE", "notes": "the conversation's words", "time": "HH:MM", "line": 0, "source": "team | family" },
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
}, z.string().optional());
const optDay = z.preprocess((v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined), z.string().optional());
const ref = { line: optInt(1), source: optSource };

const PackageAnswer = z.object({ templateId: optStr(100), said: optStr(500), chatPrice: optBaht, ...ref });
const AddOnAnswer = z.object({ lineId: optStr(100), said: optStr(500), quantity: optInt(0), chatPrice: optBaht, ...ref });
const ChoiceAnswer = z.object({ itemId: optStr(100), option: optStr(300), said: optStr(500), ...ref });
const MenuLineAnswer = z.object({
  productCode: optStr(64),
  itemName: optStr(300),
  menu: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : undefined), z.enum(BEO_AI_MENUS).optional()),
  quantity: optInt(1),
  notInMenu: z.preprocess((v) => (typeof v === "boolean" ? v : undefined), z.boolean().optional()),
  chatPrice: optBaht,
  ...ref,
});
const EntertainmentAnswer = z.object({ templateId: optStr(100), said: optStr(500), quantity: optInt(1), chatPrice: optBaht, ...ref });
const SourcedText = z.object({ value: optStr(200), ...ref });
const SourcedCount = z.object({ value: optInt(0), ...ref });
const SourcedTime = z.object({ value: optTime, ...ref });
const CakeAnswer = z.object({
  mode: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : undefined), z.enum(BEO_AI_CAKE_MODES).optional()),
  notes: optStr(1000),
  time: optTime,
  ...ref,
});
const DepositAnswer = z.object({
  amount: optBaht,
  paid: z.preprocess((v) => (typeof v === "boolean" ? v : undefined), z.boolean().optional()),
  date: optDay,
  ...ref,
});

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
 * food list lacks become free lines in the conversation's own words; every
 * value's source is the author of the line it names (the ruling message's,
 * when it was read alone; the model's own `source` only where it named no
 * line we hold; neither, the family's — a default for staff to check).
 */
export function resolveCatalogueAnswer(
  raw: unknown,
  catalogue: BeoAiCatalogueView,
  refs: TranscriptRef[],
  /** The ruling message read alone (no conversation): every value is the team's. */
  fallback?: BeoAiFrom,
): BeoAiProposal {
  const answer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fromOf = (entry: { line?: number; source?: BeoAiSource }): BeoAiFrom => {
    const known = entry.line ? refs.find((r) => r.line === entry.line) : undefined;
    if (known) return { source: known.source, at: known.at, line: known.line };
    if (fallback) return fallback;
    return { source: entry.source ?? "family", at: null, line: null };
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
      const twice = proposal.addOns.find((x) => x.lineId === line.id);
      if (twice) twice.quantity = Math.max(twice.quantity, quantity);
      else proposal.addOns.push({ lineId: line.id, quantity, said: a.said ?? null, chatPrice: a.chatPrice ?? null, from: fromOf(a) });
    } else {
      other(a.said, a.chatPrice, fromOf(a));
    }
  }

  // The set menu: the one named, else the chosen package's own.
  const setAnswer = readOne(PackageAnswer.extend({ choices: z.unknown() }), answer.setMenu);
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
      const same = chosen.findIndex((x) => x.itemId === group.id);
      const entry = { itemId: group.id, option, said: c.said ?? null, from: cFrom };
      if (same < 0 || group.allowMultiple) {
        if (!chosen.some((x) => x.itemId === group.id && x.option === option)) chosen.push(entry);
      } else {
        // One choice in the group: the team's wins over the family's, else the later line.
        const was = chosen[same]!;
        const teamWins = cFrom.source === "team" && was.from.source === "family";
        const familyLoses = cFrom.source === "family" && was.from.source === "team";
        if (teamWins || (!familyLoses && (cFrom.line ?? 0) >= (was.from.line ?? 0))) chosen[same] = entry;
      }
    }
    proposal.setMenu = { templateId: menu.id, from, choices: chosen };
  }

  // Dishes and drinks beyond the set menu.
  const codes = new Map(catalogue.food.map((f) => [f.code.toUpperCase(), f]));
  for (const m of readMany(MenuLineAnswer, answer.menuLines, 100)) {
    const food = m.productCode ? codes.get(m.productCode.trim().toUpperCase()) : undefined;
    const itemName = m.itemName ?? food?.names[0];
    if (!itemName) continue;
    proposal.menuLines.push({
      menu: (m.menu ?? "kids") as BeoAiMenu,
      itemName,
      quantity: m.quantity ?? 1,
      productCode: food?.code ?? null,
      matchedName: food?.names[0] ?? null,
      notInMenu: !food,
      chatPrice: m.chatPrice ?? null,
      from: fromOf(m),
    });
  }

  // Entertainment.
  for (const e of readMany(EntertainmentAnswer, answer.entertainment, 30)) {
    const t = e.templateId ? catalogue.entertainment.find((x) => x.id === e.templateId) : undefined;
    const name = t?.name ?? e.said;
    if (!name) continue;
    proposal.entertainment.push({
      templateId: t?.id ?? null,
      name,
      said: e.said ?? null,
      quantity: e.quantity ?? 1,
      chatPrice: e.chatPrice ?? null,
      notInCatalogue: !t,
      from: fromOf(e),
    });
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

  const cake = readOne(CakeAnswer, answer.cake);
  if (cake?.mode) proposal.cake = { mode: cake.mode, notes: cake.notes ?? null, time: cake.time ?? null, from: fromOf(cake) };

  const deposit = readOne(DepositAnswer, answer.deposit);
  if (deposit && deposit.amount !== undefined && deposit.amount > 0) {
    proposal.deposit = { amount: Math.round(deposit.amount), paid: deposit.paid === true, date: deposit.date ?? null, from: fromOf(deposit) };
  }
  return proposal;
}
