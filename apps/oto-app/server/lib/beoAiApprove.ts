import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  beoBarPlans,
  beoEntertainmentItems,
  beoEntertainmentSelections,
  beoEventBilling,
  beoKitchenPlans,
  beoPackageSnapshots,
  beoPartyHostAssignments,
  beoSetMenuSelections,
  beoSetupPlans,
  beoTimelineItems,
  birthdayPackageTemplates,
  coreEvents,
  departments,
  employees,
  entertainmentPackageTemplates,
} from "@shared/schema";
import { adultsLinesRepeatKids, CHOICE_FROM_CHAT, codedLineNameOf, foodNameFor, foodNamesFor, foodOptionNamed, setMenuOptionOf, sharedFoodLabel, tillItemOf, type BeoAiApproveBody, type BeoAiTillItem, type BeoAiSetMenuChoices, type BeoAiSetMenuItem } from "@shared/beoAiFill";
import { adultsCopiesOf, adultsDifferOf } from "@shared/kitchenAdults";
import { depositNotApprovedWords, type DepositSaveReason } from "@shared/partyDeposit";
import type { db as appDb } from "../db";
import { normalizeThaiPhone, validatePhoneInput } from "../phone-utils";
import type { ActivityLogInput } from "../storage";
import { loadBeoCatalogue, type BeoCatalogue } from "./beoCatalogueFill";
import { tillItemsForFill } from "./beoFillTillMenu";
import type { TillMenuItem } from "@shared/tillMenu";
import { applyPackageSnapshot, type DbExecutor } from "./packageSnapshot";
import { decideDepositSave, expectedDepositOf, lowersDeliberately, noDepositDay, type GatewayFloor } from "./depositSaveGuard";
import { currentDeposit, writePartyDeposit, type PartyDeposit } from "./partyDeposit";
import { resolveSetMenuLines, type SetMenuChoice } from "./setMenuResolve";

/**
 * "APPROVE AND CREATE" (SCRUM-815): the BEO the AI Fill proposed from the
 * conversation, as the reviewer left it, written at once.
 *
 * Nothing is written before this: the fill only proposes. Here, in ONE
 * transaction under the kitchen plan's own lock (the lock every BEO writer
 * takes), every section the reviewed BEO speaks to is written the way the
 * BEO's own routes write it:
 *   - the event's counts, times and child's name, and its date only where
 *     the reviewer ticked the one the confirmation names (SCRUM-814); Final
 *     Message to Parent (the ruling message) only while the BEO's is empty;
 *     lines the catalogue lacks that the reviewer kept, added to Special
 *     Requests;
 *   - the package, applied as the package module applies it
 *     (`applyPackageSnapshot`), with the add-on quantities bought;
 *   - the kitchen plan: the set menu and its choices (the lines the parent
 *     link would write, and the selection recorded as received), the extra
 *     dishes, the cake. On a set menu whose choices are already recorded as
 *     received (the family's parent link, or an earlier approval), a group the
 *     review leaves unchosen keeps its choice and the family's link keeps
 *     working; a new set menu resets the link, as Reset Selections does;
 *   - the bar plan's lines; the entertainment selections, from the
 *     entertainment menu at its prices;
 *   - the deposit, where the chat names one: in billing, where the BEO
 *     itself reads it (Party Details' prepayment and its date: the editor,
 *     the day-of view, the view-only page and the PDF) and, received, the
 *     event's own Prepayment the till reads (SCRUM-813's one deposit). A
 *     received deposit follows the Save's rule (SCRUM-843, below); one the
 *     chat only ASKS for is billing's deposit required, never money received;
 *   - SCRUM-827, the rest of the BEO in the same pass (`body.details`): the
 *     event's title, booking name, location, special requests, activities
 *     and decoration; the setup plan's ready-by, who and tasks; the POS box's
 *     name, notes and line items (Party Details); the chat's timed steps as
 *     the timeline's own lines; the party host, the entertainment host and
 *     the setup's who, where the reviewer ticked a person of the park. A
 *     text field is written as the reviewer left it; tasks, line items and
 *     timeline steps are added to what the BEO holds, never replacing it;
 *   - one `beo_ai_fill` activity row naming the sources and the catalogue
 *     items matched (never the chat's words).
 * A section the reviewed BEO says nothing about is left as it is; one it
 * speaks to is replaced (the review said which). Prices are the catalogue's:
 * the chat's own prices are shown beside them in the review and never
 * written over them; SCRUM-946: a dish or drink line beyond the set menu is an
 * EXTRA, written with the price the review shows for each item (the chat's),
 * which is what the till charges it at. Every id is checked again against the park's catalogue:
 * one it does not hold refuses the whole approval, and nothing is written.
 *
 * SCRUM-843 — THE DEPOSIT FOLLOWS THE SAVE'S RULE (server/lib/depositSaveGuard.ts).
 * A review read before the family paid through the chat and approved after
 * wrote the chat's figure over the paid deposit. Now the review carries the
 * party's one deposit as it was read (`BeoAiReview.oneDeposit`), the approval
 * sends it back (`expectedDeposit`), and the received deposit is read, decided
 * (`decideDepositSave`) and written while the event's row is held FOR UPDATE,
 * as the platform's gateway fact holds it: a deposit that moved since the
 * review was read stays as stored; an approval that names no `expectedDeposit`
 * (a page from before this rule) may raise a deposit and may not lower it; a
 * deliberate lowering goes only down to what the family paid through the chat,
 * and not at all when the platform cannot be asked. Everything else in the
 * approval is written, and the answer says the deposit was kept
 * (`notWritten.deposit`), as it says a timeline step with no place. An
 * approval that names the amount the party already holds and no day (the chat
 * gave none) names the stored deposit: its day is kept, and there is nothing
 * to say.
 */

/**
 * SCRUM-926: the catalogue's name a dish line is written as: the option the
 * review showed (`option`, written only when it is one of the code's names),
 * else the one the chat's words name; with neither (a page from before this
 * rule, or a code whose options nobody chose), the name the options share
 * ("Fried rice"), never the first option. Null when the names share nothing:
 * the line keeps its own words and its code. Always a catalogue name, so the
 * activity row never holds the chat's words.
 */
export function catalogueNameOf(names: string[], line: { itemName: string; option?: string }): string | null {
  return foodOptionNamed(names, line.option) ?? foodNameFor(names, line.itemName) ?? sharedFoodLabel(names);
}

export interface ApproveEvent {
  id: string;
  tenantId: string;
  branchId: string | null;
  title: string;
}

/**
 * SCRUM-827 review: what the approval could not write, and why, so the review
 * can say so instead of dropping it in silence. The timeline holds a step as
 * minutes from the party's start (`beo_timeline_items.offset_from_start_minutes`):
 * a party with no start time yet has no place for the chat's timed steps.
 */
export interface NotWritten {
  timeline?: { reason: "no_start_time"; message: string; steps: Array<{ time: string; label: string }> };
  /**
   * SCRUM-843: the received deposit the approval carried was not written; the
   * deposit as it stays, and why, in the words the review's result reads after
   * "Not written: the deposit — ".
   */
  deposit?: { reason: DepositSaveReason; message: string; amountThb: number; date: string | null };
}

export type ApproveOutcome =
  | { ok: true; written: Record<string, number | boolean>; notWritten: NotWritten }
  | { ok: false; status: 400; message: string };

type KitchenLine = Record<string, unknown> & { source?: string };

const asLines = (v: unknown): KitchenLine[] => (Array.isArray(v) ? (v as KitchenLine[]) : []);
const asCollection = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const minutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h! * 60 + m!;
};
/**
 * SCRUM-927: a WhatsApp number's stored columns, by the app's own phone rule
 * (server/phone-utils.ts): the international form (a Thai number without its
 * +66 takes it) and whether it parsed; one the rule cannot read keeps no
 * international form and says why, as an event saved with such a number does.
 */
export function whatsappColumnsOf(raw: string): Pick<typeof coreEvents.$inferInsert, "whatsappPhoneE164" | "whatsappParseValid" | "whatsappParseError"> {
  const checked = validatePhoneInput(raw);
  if (!checked.valid) return { whatsappPhoneE164: null, whatsappParseValid: false, whatsappParseError: checked.error ?? "The number could not be read" };
  return { whatsappPhoneE164: normalizeThaiPhone(raw), whatsappParseValid: true, whatsappParseError: null };
}

/**
 * SCRUM-946: the price a dish or drink line is written with, in baht for each item (a BEO line
 * keeps baht; the till charges an EXTRA at it times the quantity, SCRUM-906): the one the review
 * sent, to the satang; none (0, as the form's own new line) when it sent none.
 */
const priceOf = (l: { price?: number }): number => (typeof l.price === "number" && Number.isFinite(l.price) && l.price > 0 ? Math.round(l.price * 100) / 100 : 0);
/** The same words, case and spacing aside (SCRUM-827: a task, a line item or a step the BEO already holds). */
const fold = (s: unknown) => (typeof s === "string" ? s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ") : "");

/** SCRUM-827: the people the reviewer ticked, as the park group's roster holds them; null names what is not there. */
type TeamRow = { kind: "employee" | "department"; id: string; label: string };
type ApprovedTeam = NonNullable<NonNullable<BeoAiApproveBody["details"]>["team"]>;
async function checkTeam(db: DbExecutor, tenantId: string, team: ApprovedTeam | undefined): Promise<string | null> {
  const members = Object.values(team ?? {}).filter((m): m is TeamRow => !!m);
  for (const m of members) {
    if (m.kind === "employee") {
      const [row] = await db.select({ id: employees.id }).from(employees)
        .where(and(eq(employees.id, m.id), eq(employees.tenantId, tenantId), eq(employees.employmentState, "ACTIVE")));
      if (!row) return "A team member is not one of this park group's people. Choose them again in the review.";
    } else {
      const [row] = await db.select({ id: departments.id }).from(departments)
        .where(and(eq(departments.id, m.id), eq(departments.tenantId, tenantId), eq(departments.isActive, true)));
      if (!row) return "A department is not one of this park group's. Choose it again in the review.";
    }
  }
  if (team?.partyHost && team.partyHost.kind !== "employee") return "The party host is a person, not a department.";
  if (team?.entertainmentHost && team.entertainmentHost.kind !== "employee") return "The entertainment host is a person, not a department.";
  return null;
}

type ChoiceGroup = Extract<BeoAiSetMenuItem, { type: "choice_group" }>;

/** SCRUM-958: a choice group of the set menu the approval writes, by its id. */
function setMenuGroupOf(body: BeoAiApproveBody, catalogue: BeoCatalogue, itemId: string): ChoiceGroup | undefined {
  const menu = body.setMenu ? catalogue.setMenus.find((m) => m.id === body.setMenu!.templateId) : undefined;
  return menu?.items.find((i): i is ChoiceGroup => i.id === itemId && i.type === "choice_group");
}

/**
 * SCRUM-958 — THE ADULTS' SET LINE OF A SET-MENU DISH. "Chicken fried rice for
 * the adults" is the set menu's Fried rice for the adults, not the kids' choice
 * and not a charged EXTRA: the line the adults' own menu holds when staff turn
 * "Different for adults" on and change that dish there (shared/kitchenAdults.ts,
 * SCRUM-829), which is the line the set menu resolves for the group and option
 * (`resolveSetMenuLines`, the parent link's and the approval's own shape: SET,
 * its group's id, "(Fried rice)" as its mark, no price), as the adults' copy
 * (`adultsCopiesOf`'s id). The chat's note on the dish rides on it. Null when
 * the line names no group of the set menu written, or no option of it.
 */
function adultsSetLineOf(body: BeoAiApproveBody, catalogue: BeoCatalogue, l: BeoAiApproveBody["menuLines"][number]): KitchenLine | null {
  if (!l.setMenuItemId || l.menu !== "adults" || !body.setMenu) return null;
  const group = setMenuGroupOf(body, catalogue, l.setMenuItemId);
  const option = group ? setMenuOptionOf(group, l.option ?? null, l.productCode) : null;
  if (!group || !option) return null;
  const menu = catalogue.setMenus.find((m) => m.id === body.setMenu!.templateId)!;
  const [line] = adultsCopiesOf(resolveSetMenuLines(menu.items, [{ groupId: group.id, chosenOptions: [option] }]).filter((r) => r.groupId === group.id));
  if (!line) return null;
  const notes = l.notes?.trim();
  return notes ? { ...line, notes: [line.notes, notes].filter(Boolean).join(" · ") } : { ...line };
}

/** Why the reviewed BEO cannot be written as it is, in one line; null when it can. */
export function refuseApproval(
  body: BeoAiApproveBody,
  catalogue: BeoCatalogue,
  current: { startTime: string | null; endTime: string | null },
  /**
   * SCRUM-944: the till's menu as read now, for a code no set menu has: null when it could not
   * be read (such a code cannot be checked, so it is not written), undefined when not asked.
   */
  till?: BeoAiTillItem[] | null,
): string | null {
  if (body.package) {
    const pkg = catalogue.packages.find((p) => p.id === body.package!.templateId);
    if (!pkg) return "The package is not one this park sells. Choose it again in the review.";
    for (const a of body.package.addOns) {
      if (!pkg.lines.some((l) => l.id === a.lineId && !l.included)) return "An add-on is not one of the package's add-ons. Choose it again in the review.";
    }
  }
  if (body.setMenu) {
    const menu = catalogue.setMenus.find((m) => m.id === body.setMenu!.templateId);
    if (!menu) return "The set menu is not one of this park group's set menus. Choose it again in the review.";
    for (const c of body.setMenu.choices) {
      const group = menu.items.find((i) => i.id === c.itemId && i.type === "choice_group") as Extract<BeoAiSetMenuItem, { type: "choice_group" }> | undefined;
      if (!group) return "A set-menu choice is not one of the set menu's choices. Choose it again in the review.";
      if (c.options.some((o) => !group.options.includes(o))) return `"${group.label}" has no such option. Choose it again in the review.`;
      if (!group.allowMultiple && c.options.length > 1) return `"${group.label}" takes one choice.`;
    }
    if (new Set(body.setMenu.choices.map((c) => c.itemId)).size !== body.setMenu.choices.length) return "A set-menu choice is given twice.";
  }
  // SCRUM-958: an adults' SET line names a choice group of the set menu this approval writes, and
  // one of its options.
  for (const l of body.menuLines) {
    if (!l.setMenuItemId) continue;
    if (l.menu !== "adults") return "A set-menu line is the adults' only. Open the review again.";
    if (!adultsSetLineOf(body, catalogue, l)) {
      const group = setMenuGroupOf(body, catalogue, l.setMenuItemId);
      return group
        ? `Choose the adults' option of "${group.label}" in the review.`
        : "An adults' set-menu line is not one of the set menu's dishes. Open the review again.";
    }
  }
  const codes = new Set(catalogue.food.map((f) => f.code.toUpperCase()));
  const offMenus = body.menuLines.filter((l) => l.productCode && !codes.has(l.productCode.toUpperCase()));
  if (offMenus.length > 0) {
    // SCRUM-944: a code the till sells is a dish of the party's too, checked against the till's menu again.
    if (till === undefined) return "A menu line names a product code the set menus do not have.";
    if (till === null) return "The till's menu could not be read just now to check a dish's till code. Try Approve and create again in a moment.";
    if (offMenus.some((l) => !tillItemOf({ till }, l.productCode))) return "A menu line names a till code the till's menu does not have. Open the review again.";
  }
  if (body.entertainment.some((e) => e.templateId && !catalogue.entertainment.some((t) => t.id === e.templateId))) {
    return "An entertainment line is not on this park group's entertainment menu. Choose it again in the review.";
  }
  const start = body.event.startTime ?? current.startTime;
  const end = body.event.endTime ?? current.endTime;
  if (start && end && /^\d{1,2}:\d{2}/.test(start) && /^\d{1,2}:\d{2}/.test(end) && minutes(end.slice(0, 5)) <= minutes(start.slice(0, 5))) {
    return "End time must be after start time";
  }
  return null;
}

/**
 * The sections the BEO already holds that an approval would replace, as the
 * review names them before anything is pressed.
 */
export async function sectionsHeld(db: DbExecutor, eventId: string): Promise<string[]> {
  const held: string[] = [];
  const [snapshot] = await db.select({ id: beoPackageSnapshots.id }).from(beoPackageSnapshots).where(eq(beoPackageSnapshots.eventId, eventId));
  if (snapshot) held.push("package");
  const [plan] = await db.select({ menus: beoKitchenPlans.menus, setMenuTemplateId: beoKitchenPlans.setMenuTemplateId })
    .from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId));
  const menus = asCollection(plan?.menus);
  if (plan && (plan.setMenuTemplateId || asLines(menus.kids).length > 0 || asLines(menus.adults).length > 0)) held.push("kitchen plan");
  const [bar] = await db.select({ items: beoBarPlans.items }).from(beoBarPlans).where(eq(beoBarPlans.eventId, eventId));
  if (asLines(bar?.items).length > 0) held.push("bar plan");
  const [ent] = await db.select({ id: beoEntertainmentSelections.id }).from(beoEntertainmentSelections).where(eq(beoEntertainmentSelections.eventId, eventId)).limit(1);
  if (ent) held.push("entertainment");
  const [billing] = await db
    .select({ paid: beoEventBilling.depositPaidAmount, required: beoEventBilling.depositAmount, addOns: beoEventBilling.addOns })
    .from(beoEventBilling).where(eq(beoEventBilling.eventId, eventId));
  const prepayment = Number(asCollection(asCollection(billing?.addOns).partyDetails).prepaymentReceived) || 0;
  // SCRUM-843: and the event's own Prepayment, where a deposit paid through the chat lands on a
  // party the BEO was never saved on (no billing row): the party's one deposit, wherever it is kept.
  const one = (await depositHeld(db, eventId)).amountThb;
  if ((billing?.paid ?? 0) > 0 || (billing?.required ?? 0) > 0 || prepayment > 0 || one > 0) held.push("deposit");
  return held;
}

/**
 * SCRUM-843: the party's one deposit (SCRUM-813) as the app reads it now, in
 * the order every reader reads it (`currentDeposit`): what a review is read
 * with, and what an approval's deposit is decided against.
 */
export async function depositHeld(db: DbExecutor, eventId: string): Promise<PartyDeposit> {
  const [billing] = await db
    .select({
      depositPaid: beoEventBilling.depositPaid,
      depositPaidAmount: beoEventBilling.depositPaidAmount,
      depositPaidAt: beoEventBilling.depositPaidAt,
      addOns: beoEventBilling.addOns,
    })
    .from(beoEventBilling).where(eq(beoEventBilling.eventId, eventId));
  const [event] = await db
    .select({ prepaymentAmount: coreEvents.prepaymentAmount, prepaymentDate: coreEvents.prepaymentDate })
    .from(coreEvents).where(eq(coreEvents.id, eventId));
  return noDepositDay(currentDeposit(billing, event));
}

/** The set-menu choices recorded as received (the parent link, or an earlier approval); null while none are. */
export async function parentSelectionOf(db: DbExecutor, eventId: string): Promise<BeoAiSetMenuChoices | null> {
  const [sel] = await db
    .select({ templateId: beoSetMenuSelections.templateId, isSubmitted: beoSetMenuSelections.isSubmitted, selections: beoSetMenuSelections.selections })
    .from(beoSetMenuSelections)
    .where(eq(beoSetMenuSelections.eventId, eventId));
  if (!sel?.isSubmitted) return null;
  return { templateId: sel.templateId, choices: storedChoices(sel.selections).map((s) => ({ itemId: s.groupId, options: s.chosenOptions })) };
}

/**
 * A selection row's choices, as the parent link stores them; an entry off its shape is left out.
 * SCRUM-927: a choice an approval recorded from the chat keeps its mark (`recordedFrom`).
 */
function storedChoices(raw: unknown): Array<SetMenuChoice & { recordedFrom?: typeof CHOICE_FROM_CHAT }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    const entry = asCollection(s);
    const options = Array.isArray(entry.chosenOptions) ? entry.chosenOptions.filter((o): o is string => typeof o === "string") : [];
    const mark = entry.recordedFrom === CHOICE_FROM_CHAT ? { recordedFrom: CHOICE_FROM_CHAT as typeof CHOICE_FROM_CHAT } : {};
    return typeof entry.groupId === "string" && options.length > 0 ? [{ groupId: entry.groupId, chosenOptions: options, ...mark }] : [];
  });
}

export async function approveBeoAiFill(
  db: typeof appDb,
  input: {
    event: ApproveEvent;
    userId: string | null;
    body: BeoAiApproveBody;
    now: Date;
    recordActivity: (entry: ActivityLogInput, executor: DbExecutor) => Promise<unknown>;
    /**
     * SCRUM-843: what the family paid through the chat for this party, as the
     * platform holds it. Asked only when the approval deliberately lowers a
     * received deposit, and before the event's row is held; with nobody to
     * ask, such a lowering is not written.
     */
    gatewayFloor?: () => Promise<GatewayFloor>;
    /**
     * SCRUM-944: the party's park's till menu (held a minute), or null when it cannot be read:
     * asked only when a line carries a till code, to check it and to name the line by the till.
     */
    tillMenu?: () => Promise<TillMenuItem[] | null>;
  },
): Promise<ApproveOutcome> {
  const { event, body } = input;
  const catalogue = await loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId });
  // SCRUM-944: the till's menu, when a line carries a code (asked before anything is held).
  const till: BeoAiTillItem[] | null | undefined =
    input.tillMenu && body.menuLines.some((l) => l.productCode) ? await input.tillMenu().then((items) => (items ? tillItemsForFill(items) : null)) : undefined;
  const [current] = await db
    .select({ startTime: coreEvents.startTime, endTime: coreEvents.endTime })
    .from(coreEvents)
    .where(and(eq(coreEvents.id, event.id), eq(coreEvents.tenantId, event.tenantId)));
  const refused = refuseApproval(body, catalogue, { startTime: current?.startTime ?? null, endTime: current?.endTime ?? null }, till);
  if (refused) return { ok: false, status: 400, message: refused };
  // SCRUM-827: the people ticked for the team are the park group's, checked again here.
  const teamRefused = await checkTeam(db, event.tenantId, body.details?.team);
  if (teamRefused) return { ok: false, status: 400, message: teamRefused };

  // SCRUM-843: the received deposit the approval names, and the deposit its review was read
  // with. What the family paid through the chat is asked of the platform only when the approval
  // deliberately lowers the deposit, and before the event's row is held (as the BEO's Save asks).
  const depositSaid = body.deposit?.paid ? noDepositDay({ amountThb: body.deposit.amount, date: body.deposit.date }) : null;
  const depositExpected = expectedDepositOf(body.expectedDeposit);
  const depositFloor: GatewayFloor | undefined =
    depositSaid && input.gatewayFloor && lowersDeliberately(await depositHeld(db, event.id), depositSaid, depositExpected)
      ? await input.gatewayFloor()
      : undefined;

  const food = new Map(catalogue.food.map((f) => [f.code.toUpperCase(), f]));
  /**
   * SCRUM-944: a line's till code and the name it is written by. A code the set menus have: the
   * option the review showed when the party's set menu shares the code among options (SCRUM-926,
   * never the first), else the till's own name when the till sells it, else the set menu's. A
   * code only the till has: the till's name. No code: the line's own words.
   */
  const codedLine = (l: BeoAiApproveBody["menuLines"][number], setMenuId: string | null): { code: string | null; name: string | null } => {
    const matched = l.productCode ? food.get(l.productCode.toUpperCase()) : undefined;
    const onTill = till ? tillItemOf({ till }, l.productCode) : undefined;
    if (matched) {
      const names = foodNamesFor(catalogue, matched.code, setMenuId);
      return { code: onTill?.code ?? matched.code, name: codedLineNameOf(names, onTill, catalogueNameOf(names, l)) };
    }
    return onTill ? { code: onTill.code, name: onTill.name } : { code: null, name: null };
  };
  /**
   * SCRUM-946: a line's price of its own (the chat's, or one staff entered): the price it is
   * written with, unless that is the till's weekday price for its code, which a coded line opens with.
   */
  const ownPriceOf = (l: BeoAiApproveBody["menuLines"][number]): number => {
    const price = priceOf(l);
    const onTill = till && l.productCode ? tillItemOf({ till }, l.productCode) : undefined;
    return onTill && Math.round(price * 100) === onTill.priceSatang ? 0 : price;
  };
  const written: Record<string, number | boolean> = {};
  const notWritten: NotWritten = {};
  const matches: Array<Record<string, unknown>> = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`);
    // SCRUM-843: the event's row is held from here to the commit, as the platform's gateway fact
    // and the BEO's Save hold it, so the deposit decided below is the deposit that is stored.
    const [ev] = await tx.select().from(coreEvents).where(and(eq(coreEvents.id, event.id), eq(coreEvents.tenantId, event.tenantId))).for("update");

    // The event's own fields. SCRUM-904: the age the child turns and the family's WhatsApp number
    // too, the number as the BEO's own Save writes it (the raw text the form shows).
    const eventUpdates: Partial<typeof coreEvents.$inferInsert> = {};
    for (const key of ["childName", "numChildren", "numAdults", "startTime", "endTime", "eventDate", "kidTurningAge", "whatsappPhoneRaw"] as const) {
      const v = body.event[key];
      if (v !== undefined) (eventUpdates as Record<string, unknown>)[key] = v;
    }
    // SCRUM-927: another WhatsApp number is written with its stored international form too, so
    // the links that use it reach the new number.
    if (body.event.whatsappPhoneRaw !== undefined) Object.assign(eventUpdates, whatsappColumnsOf(body.event.whatsappPhoneRaw));
    if (body.event.internalStaffNotes && !(ev?.internalStaffNotes ?? "").trim()) {
      eventUpdates.internalStaffNotes = body.event.internalStaffNotes;
    }
    // SCRUM-827: the rest of the event's own fields, as the reviewer left them.
    const details = body.details;
    for (const key of ["title", "bookingName", "locationText", "activities", "decoration"] as const) {
      const v = details?.[key];
      if (v !== undefined) (eventUpdates as Record<string, unknown>)[key] = v;
    }
    const requests = details?.specialRequests !== undefined ? details.specialRequests : (ev?.specialRequests ?? "").trim();
    if (details?.specialRequests !== undefined) eventUpdates.specialRequests = requests;
    if (body.otherLines.length > 0) {
      const add = body.otherLines.filter((l) => !requests.includes(l));
      if (add.length > 0) eventUpdates.specialRequests = [requests, ...add].filter(Boolean).join("\n");
      written.otherLines = add.length;
    }
    if (Object.keys(eventUpdates).length > 0) {
      await tx.update(coreEvents)
        .set({ ...eventUpdates, updatedAt: input.now, updatedByUserId: input.userId })
        .where(and(eq(coreEvents.id, event.id), eq(coreEvents.tenantId, event.tenantId)));
      written.event = true;
      if (eventUpdates.eventDate) written.eventDate = true;
    }

    // The package, with the add-ons bought.
    if (body.package) {
      const [template] = await tx.select().from(birthdayPackageTemplates)
        .where(and(eq(birthdayPackageTemplates.id, body.package.templateId), eq(birthdayPackageTemplates.tenantId, event.tenantId)));
      const quantities = new Map(body.package.addOns.map((a) => [a.lineId, a.quantity]));
      await applyPackageSnapshot(tx, { eventId: event.id, template: template!, quantities });
      written.package = true;
      written.addOns = body.package.addOns.filter((a) => a.quantity > 0).length;
      matches.push({ kind: "package", id: template!.id, name: template!.name });
      const pkg = catalogue.packages.find((p) => p.id === template!.id)!;
      for (const a of body.package.addOns) {
        const line = pkg.lines.find((l) => l.id === a.lineId)!;
        matches.push({ kind: "addOn", id: line.id, name: line.label, quantity: a.quantity });
      }
    }

    // The kitchen plan: the set menu and its choices, the extra dishes, the cake.
    // SCRUM-904: and when the kids' and the adults' food is served.
    const kitchenLines = body.menuLines.filter((l) => l.menu !== "bar");
    const service = body.service ?? {};
    if (body.setMenu || kitchenLines.length > 0 || body.cake || service.kidsFoodTime || service.adultsFoodTime) {
      const [plan] = await tx.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, event.id));
      const menus = asCollection(plan?.menus);
      let kids = asLines(menus.kids);
      let adults = asLines(menus.adults);
      const setMenuEnabled = body.setMenu ? true : (plan?.setMenuEnabled ?? false);
      const setMenuTemplateId = body.setMenu ? body.setMenu.templateId : (plan?.setMenuTemplateId ?? null);
      if (body.setMenu) {
        const menu = catalogue.setMenus.find((m) => m.id === body.setMenu!.templateId)!;
        // SCRUM-927: marked as read from the chat, so the Kitchen Plan does not call them a parent's.
        const approved = body.setMenu.choices.map((c) => ({ groupId: c.itemId, chosenOptions: c.options, recordedFrom: CHOICE_FROM_CHAT }));
        const [had] = await tx
          .select({ id: beoSetMenuSelections.id, templateId: beoSetMenuSelections.templateId, isSubmitted: beoSetMenuSelections.isSubmitted, selections: beoSetMenuSelections.selections })
          .from(beoSetMenuSelections)
          .where(eq(beoSetMenuSelections.eventId, event.id));
        const sameMenu = had?.templateId === menu.id;
        // On a set menu whose choices are already recorded as received, a group
        // the review leaves unchosen keeps its recorded choice.
        const kept = sameMenu && had?.isSubmitted ? storedChoices(had.selections).filter((s) => !approved.some((a) => a.groupId === s.groupId)) : [];
        const selections = [...kept, ...approved];
        // The set menu's lines: what it always includes, and every group's choice.
        // SCRUM-904: the chat's note on a dish chosen rides on that dish's line.
        const resolved = resolveSetMenuLines(menu.items, selections).map((line) => {
          const said = body.setMenu!.choices.find((c) => c.itemId === line.groupId && c.notes && c.options.includes(line.itemName));
          return said ? { ...line, notes: [line.notes, said.notes!.trim()].filter(Boolean).join(" · ") } : line;
        });
        kids = [...resolved, ...kids.filter((l) => l.source !== "set_menu")];
        adults = adults.filter((l) => l.source !== "set_menu");
        written.setMenu = true;
        written.choices = approved.length;
        if (kept.length > 0) written.parentChoicesKept = kept.length;
        matches.push({ kind: "setMenu", id: menu.id, name: menu.name });
        for (const c of body.setMenu.choices) {
          const group = menu.items.find((i) => i.id === c.itemId) as Extract<BeoAiSetMenuItem, { type: "choice_group" }>;
          for (const option of c.options) {
            matches.push({ kind: "choice", itemId: c.itemId, option, code: group.optionProductCodes[option] ?? group.productCode ?? null });
          }
        }
        if (approved.length > 0) {
          // The choices are recorded as received, as the parent link records them
          // (the link the family holds keeps working on the same set menu);
          // Reset Selections opens the link again for the family.
          const values = { templateId: menu.id, isSubmitted: true, submittedAt: input.now, selections, updatedAt: input.now };
          if (had && sameMenu) await tx.update(beoSetMenuSelections).set(values).where(eq(beoSetMenuSelections.id, had.id));
          else if (had) await tx.update(beoSetMenuSelections).set({ ...values, token: randomBytes(24).toString("hex") }).where(eq(beoSetMenuSelections.id, had.id));
          else await tx.insert(beoSetMenuSelections).values({ eventId: event.id, token: randomBytes(24).toString("hex"), ...values });
        } else if (had && !sameMenu) {
          // Another set menu and no choices yet: the link starts again for it, as Reset Selections does.
          await tx
            .update(beoSetMenuSelections)
            .set({ templateId: menu.id, isSubmitted: false, submittedAt: null, selections: null, token: randomBytes(24).toString("hex"), updatedAt: input.now })
            .where(eq(beoSetMenuSelections.id, had.id));
          written.selectionReset = true;
        }
      }
      const lineOf = (l: BeoAiApproveBody["menuLines"][number]): KitchenLine => {
        // SCRUM-926: the option the review showed when options share one code (never the first).
        // SCRUM-946: among the names the party's own set menu gives the code.
        const coded = codedLine(l, setMenuTemplateId);
        if (coded.code) matches.push({ kind: "menu", code: coded.code, name: coded.name });
        return {
          id: `ai_${randomUUID()}`,
          itemName: coded.name ?? l.itemName,
          quantity: l.quantity,
          // SCRUM-944: the till's code is the line's own product code, as a line picked from the
          // till's menu holds it (SCRUM-905), never in its note; a line no menu codes says so.
          notes: [coded.code ? null : "Not in the menu", l.notes?.trim() || null].filter(Boolean).join(" · "),
          included: false,
          // SCRUM-946: an EXTRA, at the price the review shows for each item (the chat's, or the
          // till's weekday price as the picker writes it), else none.
          price: priceOf(l),
          ...(setMenuEnabled ? { source: "additional" } : {}),
          ...(coded.code ? { productCode: coded.code } : {}),
        };
      };
      const kidsSaid = kitchenLines.filter((l) => l.menu === "kids");
      // SCRUM-958: the adults' SET lines of set-menu dishes are not EXTRAs (written below).
      const adultsSaidLines = kitchenLines.filter((l) => l.menu === "adults" && !l.setMenuItemId);
      const kidsExtra = kidsSaid.map(lineOf);
      const adultsExtra = adultsSaidLines.map(lineOf);
      if (kidsExtra.length > 0) kids = [...kids.filter((l) => l.source === "set_menu"), ...kidsExtra];
      // SCRUM-958: an adults' SET line of the group and option the kids' set menu already holds is
      // the kids' menu repeated (folded, as SCRUM-829's mirror); any other is the adults' own.
      const adultsSet = kitchenLines.flatMap((l) => {
        const line = l.setMenuItemId ? adultsSetLineOf(body, catalogue, l) : null;
        return line ? [line] : [];
      });
      const adultsSetOwn = adultsSet.filter(
        (a) => !kids.some((k) => k.source === "set_menu" && k.groupId === a.groupId && fold(k.itemName) === fold(a.itemName)),
      );
      for (const a of adultsSetOwn) {
        const group = setMenuGroupOf(body, catalogue, String(a.groupId));
        matches.push({ kind: "adultsChoice", itemId: a.groupId, option: a.itemName, code: group?.optionProductCodes[String(a.itemName)] ?? group?.productCode ?? null });
      }

      // SCRUM-829: the adults eat the kids' menu unless the chat said otherwise. The review's
      // "adults" lines are everything the adults eat beyond the set menu (the prompts ask for
      // the whole of it when it differs), so they are the adults' own list and the BEO opens
      // with "Different for adults" on; with none, the switch stays as the BEO holds it,
      // recorded as its readers resolve it (shared/kitchenAdults.ts). While the adults' list
      // is their own, the set menu's lines in it are copies of the kids' — the parent's choice
      // as it now stands — so a choice made or changed here never leaves the adults' set menu
      // stale or missing. "Adults" lines that only name the kids' dishes again (a model told
      // "the adults eat the same" still marking them, as the free-text fill did) are the kids'
      // list in other words: they are not the adults' own, and the switch stays as the BEO holds it.
      // SCRUM-946: decided line by line, never by the dish names alone (`adultsLinesRepeatKids`):
      // compared by names, an extra order of a dish the set menu already has ("3 more Margherita
      // pizzas for the adults", one the chat prices) read as the kids' menu repeated and was
      // dropped while the review showed it. A line is the kids' dish repeated only at 1, the
      // adults' headcount or that kids' line's count, with no price of its own (the till's price
      // a coded line opens with is not one) and no word asking for more; and, as SCRUM-829 has it,
      // only when with the set menu's copies they name the kids' whole list and nothing else.
      const adultsCount = body.event.numAdults ?? ev?.numAdults ?? null;
      const adultsRepeat = adultsLinesRepeatKids(
        kids,
        adultsSaidLines.map((l, i) => ({
          itemName: typeof adultsExtra[i]?.itemName === "string" ? (adultsExtra[i]!.itemName as string) : l.itemName,
          quantity: l.quantity,
          price: ownPriceOf(l),
          said: [l.itemName, l.notes].filter(Boolean).join(" "),
        })),
        adultsCount,
      );
      const adultsSaid = adultsExtra.length > 0 && !adultsRepeat;
      // SCRUM-958: an adults' SET line of their own makes the adults' menu theirs, as staff turning
      // "Different for adults" on to change that dish do.
      const adultsOwn = adultsSaid || adultsSetOwn.length > 0 || adultsDifferOf(menus);
      // What was written, counted as written: an adults' line folded into the kids' menu is not.
      const adultsWritten = adultsOwn ? adultsSaidLines : [];
      written.kitchenLines = kidsExtra.length + adultsWritten.length + adultsSetOwn.length;
      written.freeKitchenLines = [...kidsSaid, ...adultsWritten].filter((l) => !l.productCode).length;
      if (adultsSetOwn.length > 0) written.adultsSetLines = adultsSetOwn.length;
      // SCRUM-958: and the lines the review showed folded before it (`adultsFolded`, a count).
      const folded = adultsExtra.length - adultsWritten.length + (adultsSet.length - adultsSetOwn.length) + (body.adultsFolded ?? 0);
      if (folded > 0) {
        written.adultsLinesFolded = folded;
        if (adultsOwn) written.adultsMenuOwn = true;
      }
      if (!adultsOwn) {
        adults = [];
      } else {
        if (adultsExtra.length > 0) adults = [...adults.filter((l) => l.source === "set_menu"), ...adultsExtra];
        if (body.setMenu || adultsExtra.length > 0 || adultsSetOwn.length > 0) {
          // SCRUM-958: the kids' set menu copied for the adults, but for a group the adults have a
          // dish of their own in: their SET line stands in its place (both choices stand).
          const ownGroups = new Set(adultsSetOwn.map((l) => l.groupId));
          adults = [
            ...adultsCopiesOf(kids.filter((l) => l.source === "set_menu" && !ownGroups.has(l.groupId))),
            ...adultsSetOwn,
            ...adults.filter((l) => l.source !== "set_menu"),
          ];
        }
      }
      // SCRUM-904: the food's times, and whether the cake comes with the package and its price, where the menus keep them.
      const nextMenus = {
        ...menus,
        kids,
        adults,
        adultsDiffer: adultsOwn,
        ...(service.kidsFoodTime ? { kidsFoodTime: service.kidsFoodTime } : {}),
        ...(service.adultsFoodTime ? { adultsFoodTime: service.adultsFoodTime } : {}),
        ...(body.cake?.included !== undefined ? { cakeIncluded: body.cake.included } : {}),
        // SCRUM-946: a cake the review writes without a word of the package, on a plan that never
        // said, is not ticked "In the package" (the form reads a missing key as INCL): the review
        // showed it unticked. A plan that holds staff's own tick keeps it.
        ...(body.cake && body.cake.included === undefined && body.cake.mode !== "NONE" && typeof menus.cakeIncluded !== "boolean" ? { cakeIncluded: false } : {}),
        ...(body.cake?.price !== undefined ? { cakePrice: body.cake.price } : {}),
      };
      const values = {
        setMenuEnabled,
        setMenuTemplateId,
        menus: nextMenus,
        simplifiedMenus: { kids, adults },
        // SCRUM-787: a cake whose type the chat does not say keeps the BEO's own type.
        ...(body.cake ? { ...(body.cake.mode ? { cakeMode: body.cake.mode } : {}), cakeNotes: body.cake.notes, cakeTime: body.cake.time } : {}),
        // SCRUM-904: how many cakes, only where the chat says so.
        ...(body.cake?.quantity !== undefined ? { cakeQuantity: body.cake.quantity } : {}),
        updatedAt: input.now,
      };
      if (plan) await tx.update(beoKitchenPlans).set(values).where(eq(beoKitchenPlans.id, plan.id));
      else await tx.insert(beoKitchenPlans).values({ eventId: event.id, ...values });
      if (body.cake) written.cake = true;
      if (service.kidsFoodTime || service.adultsFoodTime) written.foodTimes = true;
    }

    // The bar plan's lines.
    const barLines = body.menuLines.filter((l) => l.menu === "bar");
    // SCRUM-904: when the bar serves the drinks, alone: the bar's lines stay as they are.
    if (barLines.length === 0 && service.barServiceTime) {
      const [bar] = await tx.select({ id: beoBarPlans.id }).from(beoBarPlans).where(eq(beoBarPlans.eventId, event.id));
      if (bar) await tx.update(beoBarPlans).set({ serviceTime: service.barServiceTime, updatedAt: input.now }).where(eq(beoBarPlans.id, bar.id));
      else await tx.insert(beoBarPlans).values({ eventId: event.id, items: [], serviceTime: service.barServiceTime });
      written.barServiceTime = true;
    }
    if (barLines.length > 0) {
      const items = barLines.map((l) => {
        const coded = codedLine(l, body.setMenu?.templateId ?? null);
        if (coded.code) matches.push({ kind: "bar", code: coded.code, name: coded.name });
        return {
          id: `ai_${randomUUID()}`,
          itemName: coded.name ?? l.itemName,
          quantity: l.quantity,
          // SCRUM-944: the drink's till code on the line itself, as a drink picked from the till's menu.
          notes: l.notes?.trim() || "",
          included: false,
          price: priceOf(l),
          ...(coded.code ? { productCode: coded.code } : {}),
        };
      });
      const [bar] = await tx.select({ id: beoBarPlans.id }).from(beoBarPlans).where(eq(beoBarPlans.eventId, event.id));
      const serviceTime = service.barServiceTime ? { serviceTime: service.barServiceTime } : {};
      if (bar) await tx.update(beoBarPlans).set({ items, ...serviceTime, updatedAt: input.now }).where(eq(beoBarPlans.id, bar.id));
      else await tx.insert(beoBarPlans).values({ eventId: event.id, items, ...serviceTime });
      written.barLines = items.length;
      if (service.barServiceTime) written.barServiceTime = true;
    }

    // Entertainment, from the entertainment menu at its own prices.
    if (body.entertainment.length > 0) {
      await tx.delete(beoEntertainmentSelections).where(eq(beoEntertainmentSelections.eventId, event.id));
      let sortOrder = 0;
      for (const e of body.entertainment) {
        const quantityNote = e.quantity > 1 ? `Quantity ${e.quantity}` : null;
        if (e.templateId) {
          const [t] = await tx.select().from(entertainmentPackageTemplates)
            .where(and(eq(entertainmentPackageTemplates.id, e.templateId), eq(entertainmentPackageTemplates.tenantId, event.tenantId)));
          await tx.insert(beoEntertainmentSelections).values({
            eventId: event.id,
            templateId: t!.id,
            templateNameAtApply: t!.name,
            templateUpdatedAtAtApply: t!.updatedAt,
            name: t!.name,
            description: t!.description,
            durationMinutes: t!.durationMinutes,
            price: t!.defaultPrice,
            billable: t!.billableByDefault,
            notes: [quantityNote, e.notes?.trim() || null].filter(Boolean).join(" · ") || null,
            sortOrder: sortOrder++,
          });
          matches.push({ kind: "entertainment", id: t!.id, name: t!.name, quantity: e.quantity });
        } else {
          await tx.insert(beoEntertainmentSelections).values({
            eventId: event.id,
            name: e.name,
            price: 0,
            billable: true,
            notes: ["Not in the entertainment menu", quantityNote, e.notes?.trim() || null].filter(Boolean).join(" · "),
            sortOrder: sortOrder++,
          });
        }
      }
      written.entertainment = body.entertainment.length;

      // SCRUM-904: every show approved is an Entertainment Act as well (the BEO's Entertainment
      // Acts, where the form shows it), at the time the chat gives it, which puts it on the
      // Timeline; with no time the act waits for one ("no time"), as an act added by hand does.
      // An act the BEO holds by the same name is not added again: it keeps its own time, and
      // one with no time yet takes the chat's.
      const acts = await tx
        .select({ id: beoEntertainmentItems.id, customName: beoEntertainmentItems.customName, startTime: beoEntertainmentItems.startTime })
        .from(beoEntertainmentItems)
        .where(eq(beoEntertainmentItems.eventId, event.id));
      let actOrder = acts.length;
      let added = 0;
      for (const e of body.entertainment) {
        const name = e.templateId ? (catalogue.entertainment.find((t) => t.id === e.templateId)?.name ?? e.name) : e.name;
        const held = acts.find((a) => fold(a.customName) === fold(name));
        if (held) {
          if (!held.startTime && e.time) {
            await tx.update(beoEntertainmentItems).set({ startTime: e.time, updatedAt: input.now }).where(eq(beoEntertainmentItems.id, held.id));
            held.startTime = e.time;
            added += 1;
          }
          continue;
        }
        await tx.insert(beoEntertainmentItems).values({ eventId: event.id, tenantId: event.tenantId, customName: name, startTime: e.time ?? null, sortOrder: actOrder++ });
        acts.push({ id: "", customName: name, startTime: e.time ?? null });
        added += 1;
      }
      if (added > 0) written.entertainmentActs = added;
    }

    // SCRUM-827: the setup plan — ready-by, who (a person or a department of the park when
    // ticked, else the words as typed), and the tasks added to the ones the BEO holds.
    const team = details?.team;
    const who = team?.setupResponsible;
    if (
      details?.setupReadyBy !== undefined ||
      details?.setupResponsible !== undefined ||
      details?.setupNotes !== undefined ||
      who ||
      (details?.setupTasks?.length ?? 0) > 0
    ) {
      const [plan] = await tx.select().from(beoSetupPlans).where(eq(beoSetupPlans.eventId, event.id));
      const stored = plan?.setupTasks;
      const was = stored && typeof stored === "object" && !Array.isArray(stored) ? asCollection(stored) : {};
      const held = Array.isArray(stored) ? asLines(stored) : asLines(was.simplifiedTasks);
      const added = (details?.setupTasks ?? [])
        .filter((t) => !held.some((h) => fold(h.itemLabel) === fold(t.itemLabel)))
        .map((t) => ({ id: `task_${randomUUID()}`, itemLabel: t.itemLabel, notes: t.notes ?? "" }));
      const setupTasks = {
        ...was,
        readyBy: details?.setupReadyBy ?? (typeof was.readyBy === "string" ? was.readyBy : ""),
        responsible: who ? who.label : (details?.setupResponsible ?? (typeof was.responsible === "string" ? was.responsible : "")),
        responsibleId: who ? who.id : details?.setupResponsible !== undefined ? null : (was.responsibleId ?? null),
        responsibleType: who ? who.kind : details?.setupResponsible !== undefined ? null : (was.responsibleType ?? null),
        simplifiedTasks: [...held, ...added],
      };
      // SCRUM-904: the setup plan's notes, as the reviewer left them (the BEO keeps its own when none is sent).
      const values = { setupRequired: true, setupTasks, ...(details?.setupNotes !== undefined ? { setupNotes: details.setupNotes } : {}), updatedAt: input.now };
      if (plan) await tx.update(beoSetupPlans).set(values).where(eq(beoSetupPlans.id, plan.id));
      else await tx.insert(beoSetupPlans).values({ eventId: event.id, ...values });
      written.setup = true;
      written.setupTasks = added.length;
    }

    // SCRUM-827: the party host and the entertainment host, where a person of the park was ticked.
    if (team?.partyHost || team?.entertainmentHost) {
      const [host] = await tx.select({ id: beoPartyHostAssignments.id }).from(beoPartyHostAssignments).where(eq(beoPartyHostAssignments.eventId, event.id));
      const values = {
        ...(team.partyHost
          ? { assignedEmployeeId: team.partyHost.id, assignedUserId: null, assignedRoleId: null, assignmentMode: "INDIVIDUAL" as const }
          : {}),
        ...(team.entertainmentHost ? { backupEmployeeId: team.entertainmentHost.id, backupUserId: null } : {}),
        updatedAt: input.now,
      };
      if (host) await tx.update(beoPartyHostAssignments).set(values).where(eq(beoPartyHostAssignments.id, host.id));
      else await tx.insert(beoPartyHostAssignments).values({ eventId: event.id, ...values });
    }
    const teamWritten = Object.entries(team ?? {}).filter(([, m]) => m);
    if (teamWritten.length > 0) {
      written.team = teamWritten.length;
      for (const [field, m] of teamWritten) matches.push({ kind: "team", field, memberKind: m!.kind, id: m!.id });
    }

    // SCRUM-827: the POS box (Party Details): its name and notes as left, its line items added.
    if (details?.posName !== undefined || details?.posNotes !== undefined || (details?.posItems?.length ?? 0) > 0) {
      const [billing] = await tx.select({ id: beoEventBilling.id, addOns: beoEventBilling.addOns }).from(beoEventBilling).where(eq(beoEventBilling.eventId, event.id));
      const addOns = asCollection(billing?.addOns);
      const pos = asCollection(addOns.partyDetails);
      const heldItems = asLines(pos.items);
      const addedItems = (details?.posItems ?? [])
        .filter((i) => !heldItems.some((h) => fold(h.description) === fold(i.description)))
        // SCRUM-904: the price the chat names for the item, else none (0, as the form's own new line).
        .map((i) => ({ id: `pi_${randomUUID()}`, description: i.description, type: i.type, price: i.price ?? 0, notes: "" }));
      const partyDetails = {
        ...pos,
        ...(details?.posName !== undefined ? { packageName: details.posName } : {}),
        ...(details?.posNotes !== undefined ? { notes: details.posNotes } : {}),
        items: [...heldItems, ...addedItems],
      };
      const values = { addOns: { ...addOns, partyDetails }, updatedAt: input.now };
      if (billing) await tx.update(beoEventBilling).set(values).where(eq(beoEventBilling.id, billing.id));
      else await tx.insert(beoEventBilling).values({ eventId: event.id, ...values });
      written.pos = true;
      written.posItems = addedItems.length;
    }

    // SCRUM-827: the chat's timed steps as the timeline's own lines (never twice), beside the
    // steps the BEO generates from itself after this transaction (the auto items).
    if ((details?.timeline?.length ?? 0) > 0) {
      const start = body.event.startTime ?? ev?.startTime ?? null;
      const held = await tx.select({ label: beoTimelineItems.label }).from(beoTimelineItems).where(eq(beoTimelineItems.eventId, event.id));
      const steps = (details?.timeline ?? []).filter((t) => !held.some((h) => fold(h.label) === fold(t.label)));
      if (start && /^\d{1,2}:\d{2}/.test(start)) {
        let sortOrder = held.length;
        for (const step of steps) {
          await tx.insert(beoTimelineItems).values({
            eventId: event.id,
            label: step.label,
            offsetFromStartMinutes: minutes(step.time) - minutes(start.slice(0, 5)),
            assignedToType: "PARTY_HOST",
            isSystemGenerated: false,
            sortOrder: ++sortOrder,
          });
        }
        written.timelineLines = steps.length;
      } else {
        // A step is held as minutes from the start; with no start time yet, a step's own clock
        // time has no place. Said in the answer (SCRUM-827 review), never dropped in silence.
        written.timelineLines = 0;
        if (steps.length > 0) {
          notWritten.timeline = { reason: "no_start_time", message: "the party has no start time yet", steps: steps.map((s) => ({ time: s.time, label: s.label })) };
        }
      }
    }

    // The deposit, where the chat names one. Received, it is the party's one
    // deposit (SCRUM-813, server/lib/partyDeposit.ts): billing's deposit paid,
    // Party Details' prepayment and its date (which the BEO's editor, badge,
    // outstanding balance, day-of view, view-only page and PDF read; its other
    // keys kept) and the event's own Prepayment (which the till and the Events
    // page read). Asked and not yet received, it is billing's deposit required:
    // an amount REQUESTED, which none of the paid deposit's three places takes.
    //
    // SCRUM-843: a received deposit is decided as a Save's is, against the
    // deposit stored now (the event's row is held): one that moved since the
    // review was read, or that this approval would lower below what the family
    // paid through the chat, stays as stored and the answer says so.
    if (body.deposit) {
      const d = body.deposit;
      if (depositSaid) {
        const [billing] = await tx
          .select({
            depositPaid: beoEventBilling.depositPaid,
            depositPaidAmount: beoEventBilling.depositPaidAmount,
            depositPaidAt: beoEventBilling.depositPaidAt,
            addOns: beoEventBilling.addOns,
          })
          .from(beoEventBilling).where(eq(beoEventBilling.eventId, event.id));
        const was = noDepositDay(currentDeposit(billing, ev));
        // The stored amount with no day of the chat's own is the stored deposit, day and all.
        const said = depositSaid.date === null && depositSaid.amountThb === was.amountThb ? was : depositSaid;
        const decision = decideDepositSave({ was, said, expected: depositExpected, floor: depositFloor });
        if (decision.note) {
          const kept = decision.note;
          notWritten.deposit = {
            reason: kept.reason,
            message: depositNotApprovedWords(kept.reason, kept.amountThb, depositFloor?.known ? depositFloor.amountThb : 0),
            amountThb: kept.amountThb,
            date: kept.date,
          };
        } else {
          // The approval's own figure: new, or the one the party already holds (written to every place, as before).
          await writePartyDeposit(tx, { eventId: event.id, deposit: said, now: input.now, userId: input.userId });
          written.deposit = true;
        }
      } else {
        const [billing] = await tx.select({ id: beoEventBilling.id }).from(beoEventBilling).where(eq(beoEventBilling.eventId, event.id));
        const values = { depositRequired: true, depositAmount: d.amount, updatedAt: input.now };
        if (billing) await tx.update(beoEventBilling).set(values).where(eq(beoEventBilling.id, billing.id));
        else await tx.insert(beoEventBilling).values({ eventId: event.id, ...values });
        written.deposit = true;
      }
    }

    await input.recordActivity(
      {
        tenantId: event.tenantId,
        branchId: event.branchId,
        activityType: "beo_ai_fill",
        createdBy: input.userId,
        summaryText: `AI Fill approved for the BEO of "${event.title}"`,
        metadataJson: JSON.stringify({
          eventId: event.id,
          step: "approved",
          source: body.conversationId ? "inbox" : "pasted",
          ...(body.conversationId ? { inboxConversationId: body.conversationId, inboxMessageId: body.messageId ?? null } : {}),
          sources: body.sources,
          matches,
          written,
          // What could not be written, counted: never the chat's words.
          ...(notWritten.timeline || notWritten.deposit
            ? {
                notWritten: {
                  ...(notWritten.timeline ? { timeline: { reason: notWritten.timeline.reason, steps: notWritten.timeline.steps.length } } : {}),
                  // SCRUM-843: that the deposit was kept, and why; never an amount.
                  ...(notWritten.deposit ? { deposit: { reason: notWritten.deposit.reason } } : {}),
                },
              }
            : {}),
        }),
      },
      tx,
    );
  });

  return { ok: true, written, notWritten };
}
