import { z } from "zod";

/**
 * THE BEO FILLED FROM THE WHOLE CONVERSATION, MATCHED TO THE PARK'S CATALOGUE
 * (SCRUM-815) — the shapes the server and the BEO editor share.
 *
 * The owner's decisions (10 November 2026): the BEO is filled automatically
 * from the conversation and shown in EDIT mode; staff approve it, and nothing
 * is created before they do. The family's values are the form's defaults; the
 * latest line wins where two lines speak about the same thing, whoever wrote
 * it (`laterLineWins`, SCRUM-826): the team's confirmation overrides the
 * family's earlier lines, and a family line after it that corrects it is the
 * current value. Every filled field says where it came from. Prices: the
 * chat's price beside the catalogue's; the catalogue's is never overwritten.
 *
 *   - `BeoAiCatalogueView` — the park's catalogue as the review shows it: the
 *     packages (with their included lines and add-ons), the set menus (their
 *     items, choice groups and till product codes), the entertainment menu.
 *     Money is SATANG, as the template tables store it.
 *   - `BeoAiProposal` — what the model proposed, every id checked against
 *     that catalogue (an id it does not hold became a free line in the
 *     message's own words), every field with its source.
 *   - `BeoAiApproveBodySchema` — what "Approve and create" sends: the BEO as
 *     the reviewer left it. The server checks every id again.
 */

/** Who said it: the team (the ruling confirmation or another team line), or the family. */
export type BeoAiSource = "team" | "family";

/** Where a proposed value came from: who, when (the message's time), and which line of the conversation. */
export interface BeoAiFrom {
  source: BeoAiSource;
  at: string | null;
  line: number | null;
}

export interface BeoAiSourced<T> {
  value: T;
  from: BeoAiFrom;
}

/**
 * SCRUM-826 — the one rule for which of two readings of the same thing wins,
 * the same the conversation prompt states: the LATER line wins, whoever wrote
 * it. The team's confirmation wins over the family's earlier lines; a family
 * line after it that corrects it is the current value. On the same line (or
 * neither naming one) the team's wins, else the reading given last.
 */
export function laterLineWins(next: BeoAiFrom, was: BeoAiFrom): boolean {
  const nextLine = next.line ?? 0;
  const wasLine = was.line ?? 0;
  if (nextLine !== wasLine) return nextLine > wasLine;
  if (next.source !== was.source) return next.source === "team";
  return true;
}

/** Which kitchen list (or the bar) a food or drink line goes to. */
export const BEO_AI_MENUS = ["kids", "adults", "bar"] as const;
export type BeoAiMenu = (typeof BEO_AI_MENUS)[number];

export const BEO_AI_CAKE_MODES = ["INTERNAL", "EXTERNAL", "NONE"] as const;
export type BeoAiCakeMode = (typeof BEO_AI_CAKE_MODES)[number];

// --- The catalogue, as the review shows it --------------------------------------------

export interface BeoAiPackageLine {
  id: string;
  label: string;
  category: string;
  included: boolean;
  qtyDefault: number;
  unitLabel: string | null;
  /** Satang. */
  unitPrice: number;
  priceIsFrom: boolean;
}

export interface BeoAiPackage {
  id: string;
  name: string;
  kidsIncluded: number | null;
  adultsIncluded: number | null;
  hours: number | null;
  /** Satang; null falls back to `basePrice`. */
  priceWeekday: number | null;
  priceWeekend: number | null;
  basePrice: number;
  setMenuTemplateId: string | null;
  lines: BeoAiPackageLine[];
}

export type BeoAiSetMenuItem =
  | { id: string; type: "always_included"; label: string; productCode: string | null; qty: number | null }
  | {
      id: string;
      type: "choice_group";
      label: string;
      options: string[];
      allowMultiple: boolean;
      productCode: string | null;
      optionProductCodes: Record<string, string | null>;
      qty: number | null;
    };

export interface BeoAiSetMenu {
  id: string;
  name: string;
  items: BeoAiSetMenuItem[];
}

export interface BeoAiEntertainment {
  id: string;
  name: string;
  category: string | null;
  durationMinutes: number | null;
  /** Satang. */
  price: number;
  unit: string | null;
  priceIsFrom: boolean;
}

/** A dish or drink the till sells, as the set menus name it (code and the names the menus give it). */
export interface BeoAiFood {
  code: string;
  names: string[];
}

export interface BeoAiCatalogueView {
  packages: BeoAiPackage[];
  setMenus: BeoAiSetMenu[];
  entertainment: BeoAiEntertainment[];
  food: BeoAiFood[];
}

// --- What the model proposed, checked ---------------------------------------------------

export interface BeoAiMenuLine {
  menu: BeoAiMenu;
  /** The message's own words. */
  itemName: string;
  quantity: number;
  /** The till's code, when the catalogue has the item; null on a line the menu does not have. */
  productCode: string | null;
  /** The catalogue's name for that code ("Margherita"). */
  matchedName: string | null;
  /** The catalogue has no such item: a free line, kept only when staff decide so. */
  notInMenu: boolean;
  /** Baht, as the chat names it; null when it names none. */
  chatPrice: number | null;
  from: BeoAiFrom;
}

export interface BeoAiProposal {
  package: { templateId: string; said: string | null; chatPrice: number | null; from: BeoAiFrom } | null;
  addOns: Array<{ lineId: string; quantity: number; said: string | null; chatPrice: number | null; from: BeoAiFrom }>;
  setMenu: {
    templateId: string;
    from: BeoAiFrom;
    choices: Array<{ itemId: string; option: string; said: string | null; from: BeoAiFrom }>;
  } | null;
  menuLines: BeoAiMenuLine[];
  entertainment: Array<{
    /** Null on a line the entertainment menu does not have (a free line). */
    templateId: string | null;
    /** The catalogue's name, or the message's words on a free line. */
    name: string;
    said: string | null;
    quantity: number;
    chatPrice: number | null;
    notInCatalogue: boolean;
    from: BeoAiFrom;
  }>;
  /** A package, set menu or add-on the catalogue does not have, in the message's words. */
  otherLines: Array<{ text: string; chatPrice: number | null; from: BeoAiFrom }>;
  event: {
    childName?: BeoAiSourced<string>;
    numChildren?: BeoAiSourced<number>;
    numAdults?: BeoAiSourced<number>;
    startTime?: BeoAiSourced<string>;
    endTime?: BeoAiSourced<string>;
  };
  /** SCRUM-787: `mode` null is a cake the chat times or describes without saying who brings it ("not said"). */
  cake: { mode: BeoAiCakeMode | null; notes: string | null; time: string | null; from: BeoAiFrom } | null;
  deposit: { amount: number; paid: boolean; date: string | null; from: BeoAiFrom } | null;
}

/** A set menu's choices as the parent link records them: each group's chosen options. */
export interface BeoAiSetMenuChoices {
  templateId: string;
  choices: Array<{ itemId: string; options: string[] }>;
}

/** What the inbox fill (or a pasted message's, SCRUM-818) answers beside the free-text fill when the park has a catalogue. */
export interface BeoAiReview {
  /**
   * What was read: the inbox's conversation (Create BEO), or a message pasted
   * into AI Fill (SCRUM-818), read as a one-line conversation, the team's.
   */
  origin: "inbox" | "pasted";
  proposal: BeoAiProposal;
  catalogue: BeoAiCatalogueView;
  /** The ruling message, which Approve and create puts in Final Message to Parent while the form's is empty. */
  finalMessage: string | null;
  /**
   * The ruling message's place in what was read: the team's. The form's own
   * fields (the free-text fill, its date among them) are read from it alone.
   */
  ruling: BeoAiFrom;
  /** How many conversation lines were read, and whether older ones were left out. */
  transcript: { lines: number; cut: boolean };
  /** Sections the BEO already holds that approving replaces. */
  replaces: string[];
  /**
   * The set-menu choices already recorded as received (the family through the
   * parent link, or an earlier approval): a group the review leaves unchosen
   * on that same set menu keeps its choice when approved.
   */
  parentSelection: BeoAiSetMenuChoices | null;
}

// --- Approve and create -----------------------------------------------------------------

const uuid = z.string().uuid();
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day, YYYY-MM-DD. */
const calendarDay = z
  .string()
  .regex(DAY)
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  });
const text = (max: number) => z.string().trim().min(1).max(max);
const qty = z.number().int().min(1).max(1000);

/** Who a value is from, for the activity row: the chat's team or family, or the reviewer who changed it. */
export const BEO_AI_RECORDED_SOURCES = ["team", "family", "staff"] as const;

export const BeoAiApproveBodySchema = z
  .object({
    /** The inbox conversation and ruling message the proposal was read from, for the activity row. */
    conversationId: uuid.nullish(),
    messageId: uuid.nullish(),
    package: z
      .object({
        templateId: uuid,
        addOns: z.array(z.object({ lineId: uuid, quantity: z.number().int().min(0).max(1000) }).strict()).max(50),
      })
      .strict()
      .nullable(),
    setMenu: z
      .object({
        templateId: uuid,
        choices: z.array(z.object({ itemId: text(100), options: z.array(text(200)).min(1).max(20) }).strict()).max(50),
      })
      .strict()
      .nullable(),
    menuLines: z
      .array(
        z
          .object({
            menu: z.enum(BEO_AI_MENUS),
            itemName: text(300),
            quantity: qty,
            productCode: z.string().trim().min(1).max(64).nullable(),
            notes: z.string().max(1000).nullable(),
          })
          .strict(),
      )
      .max(100),
    entertainment: z
      .array(
        z
          .object({
            templateId: uuid.nullable(),
            name: text(300),
            quantity: qty,
            notes: z.string().max(1000).nullable(),
          })
          .strict(),
      )
      .max(30),
    otherLines: z.array(text(500)).max(30),
    event: z
      .object({
        childName: text(200).optional(),
        numChildren: z.number().int().min(0).max(100_000).optional(),
        numAdults: z.number().int().min(0).max(100_000).optional(),
        startTime: z.string().regex(TIME).optional(),
        endTime: z.string().regex(TIME).optional(),
        /**
         * SCRUM-814: the party's date the confirmation names, sent only when it
         * differs from the booked one and the reviewer ticked it.
         */
        eventDate: calendarDay.optional(),
        /** Final Message to Parent: the ruling message, only while the BEO's is empty. */
        internalStaffNotes: z.string().max(20_000).optional(),
      })
      .strict(),
    cake: z
      .object({
        /** SCRUM-787: null leaves the BEO's cake type as it is ("not said"); the time and notes are still written. */
        mode: z.enum(BEO_AI_CAKE_MODES).nullable(),
        notes: z.string().max(1000).nullable(),
        time: z.string().regex(TIME).nullable(),
      })
      .strict()
      .nullable(),
    deposit: z
      .object({
        /** Whole baht, as the chat names it. */
        amount: z.number().int().min(0).max(100_000_000),
        paid: z.boolean(),
        date: z.string().regex(DAY).nullable(),
      })
      .strict()
      .nullable(),
    /** Where each approved field came from: the chat's team or family, or "staff" where the reviewer changed it. */
    sources: z
      .array(
        z
          .object({
            field: text(100),
            source: z.enum(BEO_AI_RECORDED_SOURCES),
            at: z.string().max(40).nullable(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
export type BeoAiApproveBody = z.infer<typeof BeoAiApproveBodySchema>;

/** "พิซซ่ามาร์การิต้า → Margherita (CF-24)": the message's words, then the catalogue's item. */
export function beoAiMatchLabel(said: string, matchedName: string | null, code: string | null): string {
  if (!matchedName && !code) return said;
  const target = matchedName && code ? `${matchedName} (${code})` : (matchedName ?? code!);
  return said.trim() && said.trim() !== matchedName ? `${said.trim()} → ${target}` : target;
}

/** The small mark beside a filled field. */
export function beoAiSourceLabel(source: BeoAiSource | "staff"): string {
  return source === "team" ? "from the team" : source === "family" ? "from the family" : "changed here";
}

/** Whole baht from satang, for showing the catalogue's price beside the chat's. */
export function bahtOfSatang(satang: number | null | undefined): number | null {
  return typeof satang === "number" ? Math.round(satang) / 100 : null;
}
