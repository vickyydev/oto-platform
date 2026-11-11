import { z } from "zod";
import type { OneDeposit } from "./partyDeposit";

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
 *
 * SCRUM-827 (11 November 2026): ONE pass. The proposal carries the rest of
 * the BEO too (`BeoAiDetails`: the title from the app's own rule, the
 * ruling's booking name, location, setup plan and POS box, the chat's
 * requests and timed steps with their lines), the approval body takes it,
 * and the second preview that used to open after the approval is gone. A
 * value's origin may now be the park's default or a template (`BeoAiOrigin`)
 * beside the team's and the family's lines; "from the chat" is the chip a
 * filled section wears on the form.
 */

/** Who said it: the team (the ruling confirmation or another team line), or the family. */
export type BeoAiSource = "team" | "family";

/**
 * SCRUM-827: where a value the chat did not give came from — the park's own
 * rule ("default": the event's name from the child and the date, as the app
 * names events), or a template of the park's ("template"). Never written on
 * a value the chat gave: a chat value is the team's or the family's line.
 */
export type BeoAiOrigin = BeoAiSource | "default" | "template";

/** Where a proposed value came from: who, when (the message's time), and which line of the conversation. */
export interface BeoAiFrom {
  source: BeoAiOrigin;
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
  /** SCRUM-827: the rest of the BEO, proposed in the same pass. */
  details: BeoAiDetails;
}

/** SCRUM-827: a line of the chat that is a request of the family's or the team's, by the field it goes to. */
export const BEO_AI_REQUEST_KINDS = ["special_request", "decoration", "activity"] as const;
export type BeoAiRequestKind = (typeof BEO_AI_REQUEST_KINDS)[number];

/**
 * SCRUM-827 — THE REST OF THE BEO, PROPOSED IN THE SAME PASS. Until now the
 * review proposed the catalogue sections and the counts, and the fields below
 * opened in a second preview after the approval. Now every one is proposed
 * here, each with where it came from:
 *   - the title: the app's own rule for naming a party (the child and the
 *     age, as Book Date and the Events form name it) — the park's default,
 *     never "from the chat";
 *   - the booking name, the location, the setup plan's ready-by and who, the
 *     POS box's name, notes and line items: the team's confirmation (the
 *     ruling message), read as SCRUM-660 read it;
 *   - the requests (special requests, decoration wishes, activities) and the
 *     timeline's steps: the chat's own lines, each with its line's author,
 *     the latest line winning where one is repeated (SCRUM-826's rule).
 * A value the model merely carried forward from the form is not proposed: the
 * BEO holds it already, and it is nobody's line.
 */
export interface BeoAiDetails {
  title: BeoAiSourced<string> | null;
  bookingName: BeoAiSourced<string> | null;
  locationText: BeoAiSourced<string> | null;
  requests: Array<{ kind: BeoAiRequestKind; text: string; from: BeoAiFrom }>;
  setup: {
    readyBy: BeoAiSourced<string> | null;
    responsible: BeoAiSourced<string> | null;
    tasks: Array<{ itemLabel: string; notes: string | null; from: BeoAiFrom }>;
  };
  pos: {
    name: BeoAiSourced<string> | null;
    notes: BeoAiSourced<string> | null;
    items: Array<{ description: string; type: "included" | "extra"; from: BeoAiFrom }>;
  };
  timeline: Array<{ time: string; label: string; from: BeoAiFrom }>;
}

/** No details at all: the shape every proposal starts from. */
export const emptyBeoAiDetails = (): BeoAiDetails => ({
  title: null,
  bookingName: null,
  locationText: null,
  requests: [],
  setup: { readyBy: null, responsible: null, tasks: [] },
  pos: { name: null, notes: null, items: [] },
  timeline: [],
});

/**
 * SCRUM-827: the party's name as the app names one — "Mali's 6th Birthday",
 * "Mali's Birthday" — the rule the inbox's Book Date and the Events form
 * share. Null with no child's name: nothing is proposed, never a made-up name.
 */
export function beoEventTitleOf(childName: string | null | undefined, kidTurningAge: number | null | undefined): string | null {
  const child = childName?.trim();
  if (!child) return null;
  const n = typeof kidTurningAge === "number" && Number.isInteger(kidTurningAge) && kidTurningAge >= 1 ? kidTurningAge : null;
  if (n === null) return `${child}'s Birthday`;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${child}'s ${n}${suffix} Birthday`;
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
  /**
   * SCRUM-843: the party's one deposit (SCRUM-813) as it stood when this
   * review was read. "Approve and create" sends it back (`expectedDeposit`),
   * so a deposit that moved while the review was open (the family paid
   * through the chat) is kept. Absent from a server before this rule.
   */
  oneDeposit?: OneDeposit;
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

/**
 * Who a value is from, for the activity row: the chat's team or family, the
 * park's default or a template (SCRUM-827), or the reviewer who changed it.
 */
export const BEO_AI_RECORDED_SOURCES = ["team", "family", "default", "template", "staff"] as const;

/** SCRUM-827: a team member the review proposes to assign, as the park's roster names them. */
const teamMember = z.object({ kind: z.enum(["employee", "department"]), id: z.string().trim().min(1).max(64), label: text(200) }).strict();

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
    /**
     * SCRUM-843: the party's one deposit as the review was read with
     * (`BeoAiReview.oneDeposit`), in whole baht. A received deposit is written
     * under the Save's rule (server/lib/depositSaveGuard.ts): one that moved
     * since stays as stored; a page from before this rule sends none, and may
     * not lower a deposit.
     */
    expectedDeposit: z
      .object({ amountThb: z.number().int().min(0).max(100_000_000), date: z.string().regex(DAY).nullable() })
      .strict()
      .optional(),
    /**
     * SCRUM-827: the rest of the BEO, as the reviewer left it, written in the
     * same pass: a field left out is not written (the BEO keeps its own);
     * tasks, line items and timeline steps are added to what the BEO holds.
     */
    details: z
      .object({
        title: text(300).optional(),
        bookingName: text(200).optional(),
        locationText: text(300).optional(),
        specialRequests: text(4000).optional(),
        activities: text(4000).optional(),
        decoration: text(4000).optional(),
        setupReadyBy: z.string().regex(TIME).optional(),
        setupResponsible: text(200).optional(),
        setupTasks: z.array(z.object({ itemLabel: text(300), notes: z.string().max(1000).nullable() }).strict()).max(50).optional(),
        posName: text(300).optional(),
        posNotes: text(4000).optional(),
        posItems: z.array(z.object({ description: text(500), type: z.enum(["included", "extra"]) }).strict()).max(50).optional(),
        timeline: z.array(z.object({ time: z.string().regex(TIME), label: text(300) }).strict()).max(60).optional(),
        /** The park's people the reviewer ticked to assign; each checked against the park group's roster again. */
        team: z
          .object({
            partyHost: teamMember.optional(),
            entertainmentHost: teamMember.optional(),
            setupResponsible: teamMember.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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
export function beoAiSourceLabel(source: BeoAiOrigin | "staff"): string {
  switch (source) {
    case "team":
      return "from the team";
    case "family":
      return "from the family";
    case "default":
      return "the park's default";
    case "template":
      return "from a template";
    default:
      return "changed here";
  }
}

/** SCRUM-827: the one chip a section wears once the chat filled it. */
export const BEO_AI_FROM_THE_CHAT = "from the chat";

/** Whole baht from satang, for showing the catalogue's price beside the chat's. */
export function bahtOfSatang(satang: number | null | undefined): number | null {
  return typeof satang === "number" ? Math.round(satang) / 100 : null;
}
