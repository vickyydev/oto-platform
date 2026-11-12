import { z } from "zod";
import { foldDishName, sameKitchenDishNames, type KitchenLineLike } from "./kitchenAdults";
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
  /**
   * SCRUM-903: the chat's own words for the value, as Book Date gives them —
   * the model's words for it when that line holds them, else the line itself
   * clipped to `BEO_AI_QUOTE_MAX` characters. Absent when no line of the chat
   * is known for the value (the park's default, a template, a line the model
   * did not name). Shown on the review and in Fetch from chat; never written
   * to the activity row or a log line, and never sent back by the approval
   * (its `sources` carry the source and the time only).
   */
  quote?: string;
}

/** SCRUM-903: the longest quote of the chat a value carries (Book Date's `BOOK_DATE_MAX_SAID_CHARS`). */
export const BEO_AI_QUOTE_MAX = 120;

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

/**
 * SCRUM-944 (Phase C): an item of the till's menu at the party's park, as the
 * fill reads it (SCRUM-905's door, `server/lib/tillMenu.ts`): food and drink
 * made at the kitchen or the bar, coded, on sale. Items made from a BEO for a
 * party (BEO only) are left out: another party's item is no dish of this one's.
 * Money is satang, as the till answers it.
 */
export interface BeoAiTillItem {
  code: string;
  name: string;
  category: string | null;
  station: "kitchen" | "bar";
  /** Satang: the till's weekday price, which a picked EXTRA takes (SCRUM-905). */
  priceSatang: number;
}

export interface BeoAiCatalogueView {
  packages: BeoAiPackage[];
  setMenus: BeoAiSetMenu[];
  entertainment: BeoAiEntertainment[];
  food: BeoAiFood[];
  /** SCRUM-944: the till's food and drink at the party's park; absent or empty when it was not read. */
  till?: BeoAiTillItem[];
}

/** SCRUM-944: the till's item a code names, when the till's menu was read and holds it. */
export function tillItemOf(catalogue: Pick<BeoAiCatalogueView, "till">, code: string | null | undefined): BeoAiTillItem | undefined {
  const key = code?.trim().toUpperCase();
  return key ? catalogue.till?.find((t) => t.code.trim().toUpperCase() === key) : undefined;
}

/**
 * SCRUM-944: the name a coded line is written by. A code several of the party's
 * set menu's options share keeps SCRUM-926's rule (`names`, the option shown or
 * named, else none); any other code the till sells is named by the till's own
 * name; one only a set menu names, by that name.
 */
export function codedLineNameOf(names: string[], till: Pick<BeoAiTillItem, "name"> | undefined, fallback: string | null): string | null {
  if (names.length > 1) return fallback;
  return till?.name ?? names[0] ?? fallback;
}

/**
 * The food the set menus know by till code: every set-menu dish with a code,
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
 * SCRUM-946: the names a till code carries FOR THIS PARTY: the ones its own
 * set menu gives the code, so the options of a code several options share are
 * that set menu's (CF-43 is Fried rice Veggie, Chicken or Shrimp, never also
 * another set menu's "Fried Rice"; CF-24 is "Margherita", never also
 * "Margherita Pizza"). A code the party's set menu does not name, or a party
 * with none, keeps every name the park group's set menus give it.
 */
export function foodNamesFor(
  catalogue: Pick<BeoAiCatalogueView, "food" | "setMenus">,
  code: string,
  setMenuId: string | null | undefined,
): string[] {
  const key = code.trim().toUpperCase();
  const menu = setMenuId ? catalogue.setMenus.find((m) => m.id === setMenuId) : undefined;
  const own = menu ? foodOfSetMenus([menu]).find((f) => f.code === key)?.names : undefined;
  return own && own.length > 0 ? own : (catalogue.food.find((f) => f.code.toUpperCase() === key)?.names ?? []);
}

// --- What the model proposed, checked ---------------------------------------------------

export interface BeoAiMenuLine {
  menu: BeoAiMenu;
  /** The message's own words. */
  itemName: string;
  quantity: number;
  /** The till's code, when the catalogue has the item; null on a line the menu does not have. */
  productCode: string | null;
  /**
   * The catalogue's name for that code ("Margherita"). SCRUM-926: null on a
   * line with a code when the code carries several options and the chat does
   * not say which: staff choose it in the review before approving.
   */
  matchedName: string | null;
  /** The catalogue has no such item: a free line, kept only when staff decide so. */
  notInMenu: boolean;
  /** Baht, as the chat names it; null when it names none. */
  chatPrice: number | null;
  /**
   * SCRUM-904: the chat's own note on this dish ("no cheese"), carried onto
   * the dish's line; absent when the chat gives none.
   */
  notes?: string;
  /**
   * SCRUM-958: an adults' line that IS a dish of the party's set menu (one of
   * its choice groups, by the id the set menu gives it): written on the
   * adults' own menu as that group's SET line, as the editor holds a set-menu
   * line, never an EXTRA and never charged. Its option is the one
   * `matchedName` names; none while nobody chose it (staff choose it in the
   * review before Approve, SCRUM-926's hold). Absent on every other line.
   */
  setMenuItemId?: string;
  /**
   * SCRUM-958: a total the chat gives for several of the dish ("2 Margherita
   * pizzas for 900"), in baht, with the count it was said for. Never written
   * as a price each (the owner's rule: a price is per item); the review names
   * it in the line's reason so staff can type a price if they want.
   */
  chatTotal?: { amount: number; quantity: number };
  from: BeoAiFrom;
}

/**
 * SCRUM-904: a value the conversation gives with its own words for it — the
 * party's date ("Saturday 28 November"), which the review shows beside the
 * booked one.
 */
export interface BeoAiSaid<T> extends BeoAiSourced<T> {
  said: string | null;
}

export interface BeoAiProposal {
  package: { templateId: string; said: string | null; chatPrice: number | null; from: BeoAiFrom } | null;
  addOns: Array<{ lineId: string; quantity: number; said: string | null; chatPrice: number | null; from: BeoAiFrom }>;
  setMenu: {
    templateId: string;
    from: BeoAiFrom;
    /** SCRUM-904: `notes`, the chat's note on that dish, carried onto its line of the set menu. */
    choices: Array<{ itemId: string; option: string; said: string | null; notes?: string; from: BeoAiFrom }>;
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
    /**
     * SCRUM-904: the time the chat gives the show or act (HH:MM): approved,
     * it is an Entertainment Act at that time as well as the selection.
     */
    time?: string;
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
    /**
     * SCRUM-904 — the rest of the event the conversation gives, each with its
     * line: the party's date (applied only when ticked, SCRUM-814), the age
     * the child turns, the family's WhatsApp number, when the kids' and the
     * adults' food is served and when the bar serves the drinks.
     */
    eventDate?: BeoAiSaid<string>;
    childAge?: BeoAiSourced<number>;
    whatsapp?: BeoAiSourced<string>;
    kidsFoodTime?: BeoAiSourced<string>;
    adultsFoodTime?: BeoAiSourced<string>;
    barServiceTime?: BeoAiSourced<string>;
  };
  /**
   * SCRUM-787: `mode` null is a cake the chat times or describes without saying who brings it ("not said").
   * SCRUM-904: how many cakes, whether the park's cake comes with the package and its price, only as the chat says them.
   */
  cake: {
    mode: BeoAiCakeMode | null;
    notes: string | null;
    time: string | null;
    quantity?: number;
    included?: boolean;
    /** Whole baht, as the chat names it. */
    price?: number;
    from: BeoAiFrom;
  } | null;
  deposit: { amount: number; paid: boolean; date: string | null; from: BeoAiFrom } | null;
  /** SCRUM-827: the rest of the BEO, proposed in the same pass. */
  details: BeoAiDetails;
  /**
   * SCRUM-958 (SCRUM-946's open point): the adults' lines the read folded
   * because they only repeat the kids' set menu ("the adults will eat the
   * same as the kids, the Margherita pizza for them too"): the set menu's
   * dish, and the line whose words said it, so the review and the toast say
   * so. Absent when none was folded (and from a server before this rule).
   */
  adultsFolded?: Array<{ dish: string; from: BeoAiFrom }>;
}

/**
 * SCRUM-827: a line of the chat that is a request of the family's or the team's, by the field it goes to.
 * SCRUM-904: an allergy is its own kind, kept in Special Requests and shown there FIRST (the
 * owner's decision of 12 November: no allergy field of its own).
 */
export const BEO_AI_REQUEST_KINDS = ["special_request", "decoration", "activity", "allergy"] as const;
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
    /** SCRUM-904: the setup plan's general notes, as the conversation gives them. */
    notes?: BeoAiSourced<string> | null;
  };
  pos: {
    name: BeoAiSourced<string> | null;
    notes: BeoAiSourced<string> | null;
    /** SCRUM-904: `price`, whole baht, only a price the chat names for the item. */
    items: Array<{ description: string; type: "included" | "extra"; price?: number; from: BeoAiFrom }>;
  };
  timeline: Array<{ time: string; label: string; from: BeoAiFrom }>;
  /**
   * SCRUM-904: the people the conversation names for the party host and the
   * entertainment host, with their lines: the server matches them to the
   * park's roster (the review's team), and they are assigned only when ticked.
   */
  hosts?: { partyHost?: BeoAiSourced<string>; entertainmentHost?: BeoAiSourced<string> };
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

/**
 * SCRUM-927: the mark Approve and create puts on each set-menu choice it
 * records (`selections[].recordedFrom`), so the Kitchen Plan can tell choices
 * read from the chat from the ones a parent sent through the menu link.
 */
export const CHOICE_FROM_CHAT = "chat";
/** SCRUM-927: what the Kitchen Plan says of set-menu choices read from the chat, in place of "Selections received". */
export const SET_MENU_CHOSEN_FROM_CHAT = "Chosen from the chat";

/**
 * SCRUM-927: whether the recorded set-menu choices all came from the chat (an
 * AI fill's approval) and none from a parent through the menu link: the
 * Kitchen Plan then does not say "Selections received".
 */
export function choicesFromChatOnly(selections: unknown): boolean {
  if (!Array.isArray(selections) || selections.length === 0) return false;
  return selections.every((s) => !!s && typeof s === "object" && (s as Record<string, unknown>).recordedFrom === CHOICE_FROM_CHAT);
}

/**
 * SCRUM-946: words asking for a dish on top of what the party has ("3 more",
 * "extra fries", "another pizza"), in the languages the park's chats are
 * written in.
 */
const MORE_OF_A_DISH = /(^|[^\p{L}])(more|extra|extras|additional|additionally|another|on top)([^\p{L}]|$)|เพิ่ม|อีก|дополнительн|ещё|еще/iu;
export const asksForMore = (words: string | null | undefined): boolean => !!words && MORE_OF_A_DISH.test(words);

/** SCRUM-946: an adults' line of a fill, as `adultsLinesRepeatKids` reads it. */
export interface AdultsFillLine {
  /** The name it is written by (the till's or the set menu's, else the chat's words). */
  itemName: string;
  quantity: number;
  /** A price of its own for each item (the chat's, or one staff entered); none when absent or 0. */
  price?: number | null;
  /** The chat's words for it and its note, for a word asking for more. */
  said?: string | null;
}

/**
 * SCRUM-946 (SCRUM-829's mirror, kept): whether a fill's adults' lines are the
 * kids' menu said again, so they fold away and "Different for adults" stays
 * off. Both must hold, line by line, never by the dish names alone:
 *   - with the set menu's lines (which the adults' list copies anyway) they
 *     name the kids' whole list and nothing else: a list leaving one of the
 *     kids' dishes out, or naming one of its own, is the adults' own;
 *   - each is that kids' dish repeated: a dish of the kids' list, at 1, at the
 *     adults' headcount or at that kids' line's count, with no price of its
 *     own and no word asking for more. "3 more Margherita pizzas for the
 *     adults", or one the chat prices, is the adults' own order.
 */
export function adultsLinesRepeatKids(kids: readonly KitchenLineLike[], adults: readonly AdultsFillLine[], adultsCount: number | null | undefined): boolean {
  if (adults.length === 0) return false;
  const setMenu = kids.filter((l) => l.source === "set_menu");
  if (!sameKitchenDishNames(kids, [...setMenu, ...adults.map((a) => ({ itemName: a.itemName }))])) return false;
  return adults.every((a) => {
    if (typeof a.price === "number" && a.price > 0) return false;
    if (asksForMore(a.said) || asksForMore(a.itemName)) return false;
    const name = foldDishName(a.itemName);
    const same = kids.filter((k) => foldDishName(k.itemName) === name);
    if (same.length === 0) return false;
    return a.quantity === 1 || (typeof adultsCount === "number" && a.quantity === adultsCount) || same.some((k) => (k.quantity ?? 1) === a.quantity);
  });
}

/** SCRUM-946: what the review and the toast say of adults' lines that only repeated the kids' menu. */
export const adultsFoldedWords = (n: number): string =>
  `The adults' ${n === 1 ? "line only repeats" : `${n} lines only repeat`} the kids' menu: the adults eat the kids' menu, and "Different for adults" stays off.`;

/**
 * SCRUM-958: the same, when the adults' menu is their own all the same (another
 * line of theirs turns "Different for adults" on): the folded dish is on it as
 * the copy of the kids' set menu, never as an extra.
 */
export const adultsFoldedOnOwnMenuWords = (n: number): string =>
  `The adults' ${n === 1 ? "line only repeats" : `${n} lines only repeat`} the kids' set menu: the adults' menu has ${n === 1 ? "it" : "them"} from the set menu, not as ${n === 1 ? "an extra" : "extras"}.`;

/**
 * SCRUM-958: the option of a set menu's choice group a name stands for — the
 * option as listed ("Chicken"), the till code's name for it ("Fried rice
 * (Chicken)", `foodOfSetMenus`), or the option a till code belongs to
 * (Margherita's own CF-24). Null when it is none of them: a name the set menu
 * does not hold is never written as its choice.
 */
export function setMenuOptionOf(
  group: Pick<Extract<BeoAiSetMenuItem, { type: "choice_group" }>, "label" | "options" | "optionProductCodes">,
  name: string | null | undefined,
  code?: string | null,
): string | null {
  const said = typeof name === "string" ? foldDishName(name) : "";
  if (said) {
    const exact = group.options.find((o) => foldDishName(o) === said || foldDishName(`${group.label} (${o})`) === said);
    if (exact) return exact;
    const bracket = /\(([^()]*)\)\s*$/.exec(said)?.[1]?.trim();
    const inBracket = bracket ? group.options.filter((o) => foldDishName(o) === bracket) : [];
    if (inBracket.length === 1) return inBracket[0]!;
  }
  const key = code?.trim().toUpperCase();
  if (key) {
    const owned = group.options.filter((o) => group.optionProductCodes[o]?.trim().toUpperCase() === key);
    if (owned.length === 1) return owned[0]!;
  }
  return null;
}

/** SCRUM-958: the words beside an adults' set-menu line in the review: what it is, and that it is not charged. */
export const adultsSetMenuLineWords = (groupLabel: string): string =>
  `The set menu's ${groupLabel}, on the adults' own menu: a SET line, not charged.`;

/**
 * SCRUM-958: the reason a line carries when the chat gives a total for several
 * of it ("2 Margherita pizzas for 900"): the chat's figure, and what is written
 * instead — the till's price for each, or none (a total is never a price each).
 */
export function chatTotalWords(total: { amount: number; quantity: number }, tillPriceBaht: number | null): string {
  const figure = `฿${total.amount.toLocaleString("en", { maximumFractionDigits: 2 })}`;
  return tillPriceBaht !== null
    ? `The chat says ${figure} for ${total.quantity}; the till's price is ฿${tillPriceBaht.toLocaleString("en", { maximumFractionDigits: 2 })} each.`
    : `The chat says ${figure} for ${total.quantity}; no price each is written: type one if you want.`;
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
   * SCRUM-903: null when no message of the team's confirms the party yet —
   * the conversation is read alone, Final Message to Parent stays empty and
   * the review says nothing is confirmed by the team yet.
   */
  ruling: BeoAiFrom | null;
  /**
   * SCRUM-903: the inbox conversation that was read, for the approval's
   * activity row when no ruling message names it (absent on a pasted message
   * and from a server before this rule).
   */
  conversationId?: string | null;
  /**
   * SCRUM-903: the park's time zone the conversation was read at, so each
   * value's line shows when it was written on the park's clock (absent from
   * a server before this rule: the device's own clock is used).
   */
  timeZone?: string;
  /**
   * SCRUM-904: the park's catalogue could not be read (a database error), so
   * the review matched to none: the header says so instead of calling the
   * catalogue empty. Absent when it was read.
   */
  catalogueUnread?: boolean;
  /**
   * SCRUM-944: whether the till's menu was read for the fill ("ok"), or why
   * not, in the till door's words: then dishes were matched to the set menus
   * only, as before, and nothing is called "no longer on the till". Absent
   * from a server before this rule.
   */
  tillMenu?: { status: "ok" | "not_linked" | "unconfigured" | "not_reachable"; message: string | null };
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
        // SCRUM-904: `notes`, the chat's note on the dish chosen, carried onto its line of the set menu.
        choices: z
          .array(z.object({ itemId: text(100), options: z.array(text(200)).min(1).max(20), notes: z.string().trim().min(1).max(1000).optional() }).strict())
          .max(50),
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
            /**
             * SCRUM-926: the catalogue's name of the option the review shows, sent when the
             * dish's till code carries several (the server writes it only when it is one of them).
             */
            option: z.string().trim().min(1).max(300).optional(),
            /**
             * SCRUM-946: the price written on the line, in baht FOR EACH ITEM (the owner's
             * ruling of 12 November: an EXTRA is charged at its entered price per item):
             * the chat's price for the dish as the review shows it. Absent: no price.
             */
            price: z.number().min(0).max(1_000_000).optional(),
            /**
             * SCRUM-958: an adults' line that is a choice group of the set menu this approval
             * writes: written as that group's SET line on the adults' own menu (its option is
             * `option`), never an EXTRA. Checked against the set menu again.
             */
            setMenuItemId: z.string().trim().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(100),
    /**
     * SCRUM-958: how many adults' lines the review showed as folded into the kids' set menu
     * (`BeoAiProposal.adultsFolded`, folded before the review): counted into the answer's
     * `adultsLinesFolded`, so the toast says it. A count, never the chat's words.
     */
    adultsFolded: z.number().int().min(1).max(100).optional(),
    entertainment: z
      .array(
        z
          .object({
            templateId: uuid.nullable(),
            name: text(300),
            quantity: qty,
            notes: z.string().max(1000).nullable(),
            /** SCRUM-904: the show's time the chat gives: an Entertainment Act at that time as well. */
            time: z.string().regex(TIME).optional(),
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
        /** SCRUM-904: the age the child turns, and the family's WhatsApp number as the reviewer left it. */
        kidTurningAge: z.number().int().min(0).max(120).optional(),
        whatsappPhoneRaw: z.string().trim().min(1).max(60).optional(),
      })
      .strict(),
    /**
     * SCRUM-904: when the kids' and the adults' food is served (the kitchen
     * plan's) and when the bar serves the drinks (the bar plan's), each only
     * where the chat gives it.
     */
    service: z
      .object({
        kidsFoodTime: z.string().regex(TIME).optional(),
        adultsFoodTime: z.string().regex(TIME).optional(),
        barServiceTime: z.string().regex(TIME).optional(),
      })
      .strict()
      .optional(),
    cake: z
      .object({
        /** SCRUM-787: null leaves the BEO's cake type as it is ("not said"); the time and notes are still written. */
        mode: z.enum(BEO_AI_CAKE_MODES).nullable(),
        notes: z.string().max(1000).nullable(),
        time: z.string().regex(TIME).nullable(),
        /** SCRUM-904: how many cakes, whether it comes with the package, its price in whole baht — only as the chat says them. */
        quantity: z.number().int().min(1).max(20).optional(),
        included: z.boolean().optional(),
        price: z.number().int().min(0).max(1_000_000).optional(),
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
        /** SCRUM-904: the setup plan's general notes. */
        setupNotes: text(4000).optional(),
        posName: text(300).optional(),
        posNotes: text(4000).optional(),
        /** SCRUM-904: `price`, whole baht, only a price the chat names for the item. */
        posItems: z
          .array(z.object({ description: text(500), type: z.enum(["included", "extra"]), price: z.number().int().min(0).max(100_000_000).optional() }).strict())
          .max(50)
          .optional(),
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

/**
 * SCRUM-926: which of the names a till code carries the chat means. A
 * set menu whose options share one code ("Fried rice" with Veggie, Chicken
 * and Pork all CF-43) names the code once per option; the chat's words
 * ("chicken fried rice") pick the option they name, by the words that tell
 * the names apart. A code with one name is that name. NULL when the code
 * carries several and the words name none of them, or two alike (a Thai or
 * a Russian chat, plain "fried rice"): the review then asks staff to choose
 * the option (`undecidedOptions`), and the first option is never written
 * for a family that did not name it. The review shows and the approval
 * writes this one name, so the two never differ.
 */
export function foodNameFor(names: string[], said: string | null | undefined): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (!said?.trim()) return null;
  const words = (t: string) => t.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const saidText = said.normalize("NFC").toLowerCase();
  const saidWords = words(said);
  const all = names.map(words);
  // A word is the chat's when one of its words starts with it; a word in a
  // script written without spaces (Thai) is the chat's when the words hold it.
  const holds = (w: string) => saidWords.some((s) => s.startsWith(w)) || (!/[a-z]/.test(w) && saidText.includes(w));
  let best = -1;
  let bestScore = 0;
  let tied = false;
  all.forEach((own, i) => {
    // The words this name has that not every other name has: "chicken" of "Fried rice (Chicken)".
    const telling = own.filter((w) => !all.every((other) => other.includes(w)));
    const score = telling.filter(holds).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
      tied = false;
    } else if (score > 0 && score === bestScore) {
      tied = true;
    }
  });
  return best >= 0 && !tied ? names[best]! : null;
}

/**
 * SCRUM-926: the catalogue's own name for an option, as the model (the
 * conversation read's `option`) or the reviewer gives it: one of the code's
 * names written as listed, or the option a name carries in its brackets
 * ("Chicken" is "Fried rice (Chicken)"). Null when it is none of them: a
 * name the catalogue does not hold is never written as the catalogue's.
 */
export function foodOptionNamed(names: string[], option: string | null | undefined): string | null {
  const said = option?.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!said) return null;
  const folded = (n: string) => n.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  const exact = names.find((n) => folded(n) === said);
  if (exact) return exact;
  const bracketed = names.filter((n) => /\(([^()]*)\)\s*$/.exec(folded(n))?.[1]?.trim() === said);
  return bracketed.length === 1 ? bracketed[0]! : null;
}

/**
 * SCRUM-926: the name the options of one till code share ("Fried rice" of
 * "Fried rice (Veggie)", "Fried rice (Chicken)"): what a line whose option
 * nobody chose is written as, never the first option. Null when the names
 * share no words.
 */
export function sharedFoodLabel(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  const bases = names.map((n) => n.replace(/\s*\([^()]*\)\s*$/, "").trim());
  if (bases.every((b) => b && b.toLowerCase() === bases[0]!.toLowerCase())) return bases[0]!;
  const split = names.map((n) => n.trim().split(/\s+/));
  const common: string[] = [];
  for (let i = 0; i < split[0]!.length; i++) {
    const w = split[0]![i]!;
    if (!split.every((s) => s[i]?.toLowerCase() === w.toLowerCase())) break;
    common.push(w);
  }
  const label = common.join(" ").replace(/[\s(,:;-]+$/, "").trim();
  return label || null;
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
