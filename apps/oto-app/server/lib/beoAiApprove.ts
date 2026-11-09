import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  beoBarPlans,
  beoEntertainmentSelections,
  beoEventBilling,
  beoKitchenPlans,
  beoPackageSnapshots,
  beoSetMenuSelections,
  birthdayPackageTemplates,
  coreEvents,
  entertainmentPackageTemplates,
} from "@shared/schema";
import type { BeoAiApproveBody, BeoAiSetMenuChoices, BeoAiSetMenuItem } from "@shared/beoAiFill";
import type { db as appDb } from "../db";
import type { ActivityLogInput } from "../storage";
import { loadBeoCatalogue, type BeoCatalogue } from "./beoCatalogueFill";
import { applyPackageSnapshot, type DbExecutor } from "./packageSnapshot";
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
 *   - the deposit, where the chat names one: in billing, and where the BEO
 *     itself reads it (Party Details' prepayment and its date: the editor,
 *     the day-of view, the view-only page and the PDF);
 *   - one `beo_ai_fill` activity row naming the sources and the catalogue
 *     items matched (never the chat's words).
 * A section the reviewed BEO says nothing about is left as it is; one it
 * speaks to is replaced (the review said which). Prices are the catalogue's:
 * the chat's own prices are shown beside them in the review and never
 * written over them. Every id is checked again against the park's catalogue:
 * one it does not hold refuses the whole approval, and nothing is written.
 */

export interface ApproveEvent {
  id: string;
  tenantId: string;
  branchId: string | null;
  title: string;
}

export type ApproveOutcome =
  | { ok: true; written: Record<string, number | boolean> }
  | { ok: false; status: 400; message: string };

type KitchenLine = Record<string, unknown> & { source?: string };

const asLines = (v: unknown): KitchenLine[] => (Array.isArray(v) ? (v as KitchenLine[]) : []);
const asCollection = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const minutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h! * 60 + m!;
};

/** Why the reviewed BEO cannot be written as it is, in one line; null when it can. */
export function refuseApproval(body: BeoAiApproveBody, catalogue: BeoCatalogue, current: { startTime: string | null; endTime: string | null }): string | null {
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
  const codes = new Set(catalogue.food.map((f) => f.code.toUpperCase()));
  if (body.menuLines.some((l) => l.productCode && !codes.has(l.productCode.toUpperCase()))) {
    return "A menu line names a product code the set menus do not have.";
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
  if ((billing?.paid ?? 0) > 0 || (billing?.required ?? 0) > 0 || prepayment > 0) held.push("deposit");
  return held;
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

/** A selection row's choices, as the parent link stores them; an entry off its shape is left out. */
function storedChoices(raw: unknown): SetMenuChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    const entry = asCollection(s);
    const options = Array.isArray(entry.chosenOptions) ? entry.chosenOptions.filter((o): o is string => typeof o === "string") : [];
    return typeof entry.groupId === "string" && options.length > 0 ? [{ groupId: entry.groupId, chosenOptions: options }] : [];
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
  },
): Promise<ApproveOutcome> {
  const { event, body } = input;
  const catalogue = await loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId });
  const [current] = await db
    .select({ startTime: coreEvents.startTime, endTime: coreEvents.endTime })
    .from(coreEvents)
    .where(and(eq(coreEvents.id, event.id), eq(coreEvents.tenantId, event.tenantId)));
  const refused = refuseApproval(body, catalogue, { startTime: current?.startTime ?? null, endTime: current?.endTime ?? null });
  if (refused) return { ok: false, status: 400, message: refused };

  const food = new Map(catalogue.food.map((f) => [f.code.toUpperCase(), f]));
  const written: Record<string, number | boolean> = {};
  const matches: Array<Record<string, unknown>> = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`);
    const [ev] = await tx.select().from(coreEvents).where(and(eq(coreEvents.id, event.id), eq(coreEvents.tenantId, event.tenantId)));

    // The event's own fields.
    const eventUpdates: Partial<typeof coreEvents.$inferInsert> = {};
    for (const key of ["childName", "numChildren", "numAdults", "startTime", "endTime", "eventDate"] as const) {
      const v = body.event[key];
      if (v !== undefined) (eventUpdates as Record<string, unknown>)[key] = v;
    }
    if (body.event.internalStaffNotes && !(ev?.internalStaffNotes ?? "").trim()) {
      eventUpdates.internalStaffNotes = body.event.internalStaffNotes;
    }
    if (body.otherLines.length > 0) {
      const had = (ev?.specialRequests ?? "").trim();
      const add = body.otherLines.filter((l) => !had.includes(l));
      if (add.length > 0) eventUpdates.specialRequests = [had, ...add].filter(Boolean).join("\n");
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
    const kitchenLines = body.menuLines.filter((l) => l.menu !== "bar");
    if (body.setMenu || kitchenLines.length > 0 || body.cake) {
      const [plan] = await tx.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, event.id));
      const menus = asCollection(plan?.menus);
      let kids = asLines(menus.kids);
      let adults = asLines(menus.adults);
      const setMenuEnabled = body.setMenu ? true : (plan?.setMenuEnabled ?? false);
      const setMenuTemplateId = body.setMenu ? body.setMenu.templateId : (plan?.setMenuTemplateId ?? null);
      if (body.setMenu) {
        const menu = catalogue.setMenus.find((m) => m.id === body.setMenu!.templateId)!;
        const approved = body.setMenu.choices.map((c) => ({ groupId: c.itemId, chosenOptions: c.options }));
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
        const resolved = resolveSetMenuLines(menu.items, selections);
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
        const matched = l.productCode ? food.get(l.productCode.toUpperCase()) : undefined;
        if (matched) matches.push({ kind: "menu", code: matched.code, name: matched.names[0] });
        return {
          id: `ai_${randomUUID()}`,
          itemName: matched ? matched.names[0] : l.itemName,
          quantity: l.quantity,
          notes: [matched ? matched.code : "Not in the menu", l.notes?.trim() || null].filter(Boolean).join(" · "),
          included: false,
          price: 0,
          ...(setMenuEnabled ? { source: "additional" } : {}),
        };
      };
      const kidsExtra = kitchenLines.filter((l) => l.menu === "kids").map(lineOf);
      const adultsExtra = kitchenLines.filter((l) => l.menu === "adults").map(lineOf);
      if (kidsExtra.length > 0) kids = [...kids.filter((l) => l.source === "set_menu"), ...kidsExtra];
      if (adultsExtra.length > 0) adults = [...adults.filter((l) => l.source === "set_menu"), ...adultsExtra];
      written.kitchenLines = kidsExtra.length + adultsExtra.length;
      written.freeKitchenLines = kitchenLines.filter((l) => !l.productCode).length;

      const nextMenus = { ...menus, kids, adults };
      const values = {
        setMenuEnabled,
        setMenuTemplateId,
        menus: nextMenus,
        simplifiedMenus: { kids, adults },
        ...(body.cake ? { cakeMode: body.cake.mode, cakeNotes: body.cake.notes, cakeTime: body.cake.time } : {}),
        updatedAt: input.now,
      };
      if (plan) await tx.update(beoKitchenPlans).set(values).where(eq(beoKitchenPlans.id, plan.id));
      else await tx.insert(beoKitchenPlans).values({ eventId: event.id, ...values });
      if (body.cake) written.cake = true;
    }

    // The bar plan's lines.
    const barLines = body.menuLines.filter((l) => l.menu === "bar");
    if (barLines.length > 0) {
      const items = barLines.map((l) => {
        const matched = l.productCode ? food.get(l.productCode.toUpperCase()) : undefined;
        if (matched) matches.push({ kind: "bar", code: matched.code, name: matched.names[0] });
        return {
          id: `ai_${randomUUID()}`,
          itemName: matched ? matched.names[0] : l.itemName,
          quantity: l.quantity,
          notes: [matched ? matched.code : null, l.notes?.trim() || null].filter(Boolean).join(" · "),
          included: false,
          price: 0,
        };
      });
      const [bar] = await tx.select({ id: beoBarPlans.id }).from(beoBarPlans).where(eq(beoBarPlans.eventId, event.id));
      if (bar) await tx.update(beoBarPlans).set({ items, updatedAt: input.now }).where(eq(beoBarPlans.id, bar.id));
      else await tx.insert(beoBarPlans).values({ eventId: event.id, items });
      written.barLines = items.length;
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
    }

    // The deposit, where the chat names one: billing's columns, and Party Details'
    // prepayment and its date, which the BEO's editor, badge, outstanding balance,
    // day-of view, view-only page and PDF read. Party Details' other keys are kept.
    if (body.deposit) {
      const d = body.deposit;
      const [billing] = await tx.select({ id: beoEventBilling.id, addOns: beoEventBilling.addOns }).from(beoEventBilling).where(eq(beoEventBilling.eventId, event.id));
      const addOns = asCollection(billing?.addOns);
      const partyDetails = asCollection(addOns.partyDetails);
      const nextAddOns = d.paid
        ? { ...addOns, partyDetails: { ...partyDetails, prepaymentReceived: d.amount, ...(d.date ? { depositDate: d.date } : {}) } }
        : null;
      const values = {
        ...(d.paid
          ? { depositPaid: true, depositPaidAmount: d.amount, depositPaidAt: d.date ? new Date(`${d.date}T00:00:00.000Z`) : null }
          : { depositRequired: true, depositAmount: d.amount }),
        ...(nextAddOns ? { addOns: nextAddOns } : {}),
        updatedAt: input.now,
      };
      if (billing) await tx.update(beoEventBilling).set(values).where(eq(beoEventBilling.id, billing.id));
      else await tx.insert(beoEventBilling).values({ eventId: event.id, ...values });
      written.deposit = true;
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
        }),
      },
      tx,
    );
  });

  return { ok: true, written };
}
