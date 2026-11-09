import { z } from "zod";

/**
 * THE BEO FILLED FROM THE WHOLE CONVERSATION, MATCHED TO THE PARK'S CATALOGUE
 * (SCRUM-815) — the shapes the server and the BEO editor share.
 *
 * The owner's decisions (10 November 2026): the BEO is filled automatically
 * from the conversation and shown in EDIT mode; staff approve it, and nothing
 * is created before they do. The family's values are the form's defaults; the
 * team's confirmation overrides them where it speaks; every filled field
 * says where it came from. Prices: the chat's price beside the catalogue's;
 * the catalogue's is never overwritten.
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
  cake: { mode: BeoAiCakeMode; notes: string | null; time: string | null; from: BeoAiFrom } | null;
  deposit: { amount: number; paid: boolean; date: string | null; from: BeoAiFrom } | null;
}

/** What the inbox fill answers beside the free-text fill when the park has a catalogue. */
export interface BeoAiReview {
  proposal: BeoAiProposal;
  catalogue: BeoAiCatalogueView;
  /** The ruling message, which Approve and create puts in Final Message to Parent while the form's is empty. */
  finalMessage: string | null;
  /** How many conversation lines were read, and whether older ones were left out. */
  transcript: { lines: number; cut: boolean };
  /** Sections the BEO already holds that approving replaces. */
  replaces: string[];
}

// --- Approve and create -----------------------------------------------------------------

const uuid = z.string().uuid();
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
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
        /** Final Message to Parent: the ruling message, only while the BEO's is empty. */
        internalStaffNotes: z.string().max(20_000).optional(),
      })
      .strict(),
    cake: z
      .object({
        mode: z.enum(BEO_AI_CAKE_MODES),
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
