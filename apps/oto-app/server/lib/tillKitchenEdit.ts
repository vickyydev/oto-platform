import { createHash } from "crypto";
import { z } from "zod";
import { and, eq, like } from "drizzle-orm";
import { activityLog, beoBarPlans, beoKitchenPlans, beoSetMenuSelections, beoSetMenuTemplates, coreEvents } from "@shared/schema";
import { adultsCopiesOf, adultsDifferOf, kitchenLinesOf, sameKitchenDish } from "@shared/kitchenAdults";

/**
 * A MANAGER CHANGES A PARTY'S KITCHEN PLAN ON THE TILL, AND THE BEO IS CHANGED
 * (SCRUM-907; the owner's decision 7 of 12 November: "Let it be edited with
 * right permission of admin or manager and update it in BEO as well").
 *
 * The till's party Edit form reads the kitchen plan from the till's plan view
 * (app migration 0050) and sends the platform what a manager changed; the
 * platform writes it here through the directory (`server/directory/
 * kitchenPlanRoutes.ts`), under the tenant-bound key it already writes a
 * party's edits with. This file is the change itself:
 *
 *   - `set`     a line's count and note, the line found by its own id in the
 *               kids', the adults' or the bar's list;
 *   - `remove`  an EXTRA line; a set-menu dish is not removed from the till
 *               (it comes back from the template), and is refused in words;
 *   - `add`     a food line on the kids' list (the BEO's "+ EXTRA" on its
 *               Additional Items) or a bar line, with the till item's name and
 *               code or a typed name; never a price;
 *   - `choose`  a set-menu choice within its group, an option of the
 *               template's own, on the line that holds it or as the line the
 *               parent's submit would make for an open group; the adults' own
 *               copy follows it, as the parent's submit keeps it (SCRUM-829),
 *               and a dish of the adults' own in the group (another option,
 *               SCRUM-958) stays as it is, never doubled by a copy;
 *               the dish keeps its count and takes the template's till code;
 *   - `cake`    the cake's time and note, when the BEO has a cake.
 *
 * ONE TILL LINE IS EVERY BEO LINE IT SHOWS. With "Different for adults" saved
 * on, the plan view shows a kids' line and each adults' line that is the same
 * dish (`sameKitchenDish`: name, count and till code) as ONE line, so `set`
 * and `remove` on that kids' line carry those adults' copies with it: a count
 * moves them, a note moves the ones that had the kids' note, a removal
 * removes them (as `choose` carries the adults' copy of a choice). On a BEO
 * whose adults eat the kids' list (the switch off; an adults' list from
 * before the switch repeating the kids'), a change of an adults' line makes
 * that list the adults' own — the switch written on, as the editor reads two
 * unequal lists — so it is never dropped; a change of the kids' list alone
 * writes the BEO Save's own form (the adults' list empty, the switch off).
 *
 * WRITTEN THROUGH THE BEO'S OWN SAVE (`kitchenPlanDbDataOf`, `writeKitchenPlanRow`
 * and the bar's two in beo-routes.ts), under the kitchen plan's lock, so every
 * rule of the plan holds: the adults' switch recorded as its readers resolve it,
 * a set-menu dish the template resolved never renamed but by a choice of its own
 * group, every count within 1 and 999,999 (SCRUM-906's bound).
 *
 * ONCE: the edit's id is kept on the BEO's activity row that says who changed
 * it ("Kitchen plan changed on the till by Noi (Manager)"), written in the same
 * transaction under the same lock; the same id again finds it and writes
 * nothing, and a different change under that id is refused.
 */

export const TILL_KITCHEN_EDIT_ACTIVITY = "beo_kitchen_plan_till_edit" as const;

const QTY_MAX = 999_999;
const LineId = z.string().trim().min(1).max(200);
const Qty = z.number().int().min(1).max(QTY_MAX);
const Note = z.string().max(500);
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");

export const tillKitchenChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), lineId: LineId, qty: Qty.optional(), note: Note.nullable().optional() }).strict(),
  z.object({ op: z.literal("remove"), lineId: LineId }).strict(),
  z
    .object({
      op: z.literal("add"),
      id: z.string().uuid(),
      list: z.enum(["food", "bar"]),
      name: z.string().trim().min(1).max(200),
      productCode: z.string().trim().min(1).max(64).nullable(),
      qty: Qty,
      note: Note.nullable().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("choose"),
      choiceGroup: z.string().trim().min(1).max(200),
      lineId: LineId.nullable(),
      option: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ op: z.literal("cake"), time: Clock.nullable().optional(), note: Note.nullable().optional() }).strict(),
]);
export type TillKitchenChange = z.infer<typeof tillKitchenChangeSchema>;

export const kitchenPlanEditBodySchema = z
  .object({
    id: z.string().uuid(),
    editedAt: z.string().datetime({ offset: true }),
    by: z.object({ name: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(100) }).strict(),
    changes: z.array(tillKitchenChangeSchema).min(1).max(100),
  })
  .strict();
export type KitchenPlanEditBody = z.infer<typeof kitchenPlanEditBodySchema>;

type Line = Record<string, unknown> & { id?: string; itemName?: string; quantity?: number; notes?: string; source?: string; groupId?: string; productCode?: string };
type TemplateItem = { id?: unknown; type?: unknown; label?: unknown; options?: unknown; allowMultiple?: unknown; qty?: unknown };

/** What the plan holds now, as its rows keep it. */
export interface KitchenState {
  kitchen: Record<string, any> | null;
  bar: { serviceTime: string | null; items: Line[] } | null;
  template: { name: string; items: TemplateItem[] } | null;
}

export type Refusal = { ok: false; status: 400 | 404 | 409; error: string; message: string };
const refuse = (status: 400 | 404 | 409, error: string, message: string): Refusal => ({ ok: false, status, error, message });

/** The plan as the change leaves it: the BEO Save's form for the kitchen and the bar, and what changed, in words. */
export type TillKitchenPlanned =
  | { ok: true; kitchen: Record<string, any> | null; bar: { serviceTime: string | null; items: Line[] } | null; said: string[] }
  | Refusal;

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const qtyOf = (l: Line): number => (typeof l.quantity === "number" && Number.isFinite(l.quantity) && l.quantity > 0 ? Math.round(l.quantity) : 1);
const nameOf = (l: Line): string => text(l.itemName).trim() || "a line";

/** A template's choice groups, as the BEO's set-menu block names them. */
export function choiceGroupsOf(items: readonly TemplateItem[]): { id: string; label: string; options: string[]; allowMultiple: boolean; qty: unknown }[] {
  return items
    .filter((i) => i.type === "choice_group" && typeof i.id === "string" && typeof i.label === "string")
    .map((i) => ({
      id: i.id as string,
      label: (i.label as string).trim(),
      options: Array.isArray(i.options) ? i.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()) : [],
      allowMultiple: i.allowMultiple === true,
      qty: i.qty,
    }));
}

/** A line of a group, as the BEO's set-menu block matches it: its groupId, or — saved before groupId — its note "(<group>)". */
const ofGroup = (l: Line, group: { id: string; label: string }): boolean =>
  l.source === "set_menu" && (text(l.groupId).trim() ? text(l.groupId).trim() === group.id : text(l.notes).trim() === `(${group.label})`);

/**
 * The change applied to the plan, or why not. Pure: what the rows hold in,
 * the BEO Save's form out, so the check can drive it line by line.
 */
export function planTillKitchenEdit(state: KitchenState, changes: readonly TillKitchenChange[]): TillKitchenPlanned {
  const kp: Record<string, any> = state.kitchen ? { ...state.kitchen } : {};
  const menus: Record<string, any> = kp.menus && typeof kp.menus === "object" && !Array.isArray(kp.menus) ? { ...kp.menus } : {};
  const adultsDiffer = adultsDifferOf(menus);
  // The plan view folds the adults' copies into the kids' line only with the switch SAVED on
  // (0048, 0050: `adultsDiffer` true), so only then is a kids' line on the till its copies too.
  const viewFoldsAdults = menus.adultsDiffer === true;
  const kids: Line[] = kitchenLinesOf(menus.kids).map((l) => ({ ...l })) as Line[];
  const adults: Line[] = kitchenLinesOf(menus.adults).map((l) => ({ ...l })) as Line[];
  const bar: Line[] = (state.bar?.items ?? []).filter((l) => l && typeof l === "object").map((l) => ({ ...l }));
  let kitchenTouched = false;
  let barTouched = false;
  // An adults' line changed while the adults eat the kids' list: the list becomes their own.
  let adultsChangedWhileOff = false;
  const said: string[] = [];
  /** The adults' lines the till shows as this kids' line: the same dish, the switch saved on. */
  const foldedCopiesOf = (kidsLine: Line): number[] =>
    viewFoldsAdults ? adults.flatMap((a, i) => (sameKitchenDish(a, kidsLine) ? [i] : [])) : [];

  const lists = (): { list: Line[]; place: "kids" | "adults" | "bar" }[] => [
    { list: kids, place: "kids" },
    { list: adults, place: "adults" },
    { list: bar, place: "bar" },
  ];
  const find = (lineId: string) => {
    for (const { list, place } of lists()) {
      const at = list.findIndex((l) => text(l.id).trim() === lineId.trim());
      if (at >= 0) return { list, place, at, line: list[at]! };
    }
    return null;
  };
  const touch = (place: "kids" | "adults" | "bar") => {
    if (place === "bar") barTouched = true;
    else kitchenTouched = true;
  };
  const gone = (lineId: string) =>
    refuse(409, "line_not_found", `A line of the kitchen plan was changed in the BEO since the till read it (${lineId}). Read the party again and make the change once more.`);
  const groups = choiceGroupsOf(state.template?.items ?? []);

  for (const change of changes) {
    if (change.op === "set") {
      const hit = find(change.lineId);
      if (!hit) return gone(change.lineId);
      const was = { qty: qtyOf(hit.line), note: text(hit.line.notes).trim() };
      const copies = hit.place === "kids" ? foldedCopiesOf(hit.line) : [];
      const setLine = (line: Line, withNote: boolean): Line => {
        const next: Line = { ...line };
        if (change.qty !== undefined) next.quantity = change.qty;
        if (withNote && change.note !== undefined) {
          // A line saved before groupId is matched to its group by its note "(<group>)": it takes its
          // group's id first, so a note of its own never loses it its group.
          const group = groups.find((g) => !text(next.groupId).trim() && ofGroup(next, g));
          if (group) next.groupId = group.id;
          next.notes = change.note ?? "";
        }
        return next;
      };
      const next = setLine(hit.line, true);
      hit.list[hit.at] = next;
      // The adults' copies the till showed as this line move with it; a note of the adults' own stays.
      for (const i of copies) adults[i] = setLine(adults[i]!, text(adults[i]!.notes).trim() === was.note);
      if (hit.place === "adults" && !adultsDiffer) adultsChangedWhileOff = true;
      touch(hit.place);
      const parts = [
        change.qty !== undefined && change.qty !== was.qty ? `×${was.qty} → ×${change.qty}` : null,
        change.note !== undefined && (change.note ?? "").trim() !== was.note ? `note "${(change.note ?? "").trim()}"` : null,
      ].filter((p): p is string => !!p);
      said.push(`${nameOf(next)}${parts.length ? ` ${parts.join(", ")}` : ""}${copies.length && parts.length ? " (the adults' too)" : ""}`);
      continue;
    }
    if (change.op === "remove") {
      const hit = find(change.lineId);
      if (!hit) return gone(change.lineId);
      if (hit.line.source === "set_menu") {
        return refuse(
          409,
          "set_menu_line",
          `${nameOf(hit.line)} is a dish of the party's set menu, so it is not removed from the till: change its choice or its count, or remove it in the BEO.`,
        );
      }
      // The adults' copies the till showed as this line go with it.
      const copies = hit.place === "kids" ? foldedCopiesOf(hit.line) : [];
      hit.list.splice(hit.at, 1);
      for (const i of [...copies].reverse()) adults.splice(i, 1);
      if (hit.place === "adults" && !adultsDiffer) adultsChangedWhileOff = true;
      touch(hit.place);
      said.push(`removed ${nameOf(hit.line)}${copies.length ? " (the adults' too)" : ""}`);
      continue;
    }
    if (change.op === "add") {
      const id = `till_${change.id}`;
      const list = change.list === "bar" ? bar : kids;
      if (list.some((l) => text(l.id) === id)) continue;
      const line: Line = {
        id,
        itemName: change.name.trim(),
        quantity: change.qty,
        notes: (change.note ?? "").trim(),
        included: false,
        price: 0,
        // As the BEO's own "+ EXTRA": an additional line beside a set menu, else an unbadged one (an EXTRA).
        ...(change.list === "food" && kp.setMenuEnabled ? { source: "additional" } : {}),
        ...(change.productCode ? { productCode: change.productCode.trim() } : {}),
      };
      list.push(line);
      touch(change.list === "bar" ? "bar" : "kids");
      said.push(`added ${line.itemName} ×${change.qty}${change.productCode ? ` (${change.productCode.trim()})` : ""}`);
      continue;
    }
    if (change.op === "choose") {
      if (!kp.setMenuEnabled || !state.template) {
        return refuse(409, "no_set_menu", "This party's BEO has no set menu, so there is no choice to change.");
      }
      const group = groups.find((g) => g.label.toLowerCase() === change.choiceGroup.trim().toLowerCase());
      if (!group) {
        return refuse(409, "choice_group_not_found", `The set menu "${state.template.name}" has no choice "${change.choiceGroup}" any more.`);
      }
      const option = group.options.find((o) => o.toLowerCase() === change.option.trim().toLowerCase());
      if (!option) {
        return refuse(400, "option_not_in_group", `"${change.option}" is not one of the choices for ${group.label}: ${group.options.join(", ")}.`);
      }
      // The list the BEO's set-menu block reads the set menu from: the kids' when it holds one, else the adults'.
      const bucket = kids.some((l) => l.source === "set_menu") || !adults.some((l) => l.source === "set_menu") ? kids : adults;
      if (change.lineId) {
        const at = bucket.findIndex((l) => text(l.id).trim() === change.lineId!.trim());
        if (at < 0) return gone(change.lineId);
        const was = bucket[at]!;
        if (!ofGroup(was, group)) {
          return refuse(409, "not_in_group", `${nameOf(was)} is not the ${group.label} choice of the set menu.`);
        }
        const oldName = text(was.itemName).trim();
        // The dish takes the option's name and keeps its count; its till code is the template's (no code on the line).
        const { productCode: _code, ...rest } = was;
        bucket[at] = { ...rest, itemName: option, groupId: group.id };
        // The adults' own copy follows it, as the parent's submit keeps it (SCRUM-829).
        if (bucket === kids && adultsDiffer) {
          for (let i = 0; i < adults.length; i += 1) {
            const a = adults[i]!;
            if (text(a.id) === `${text(was.id)}_adults` || (ofGroup(a, group) && text(a.itemName).trim() === oldName)) {
              const { productCode: _a, ...restA } = a;
              adults[i] = { ...restA, itemName: option, groupId: group.id };
            }
          }
        }
        touch(bucket === kids ? "kids" : "adults");
        said.push(`${group.label}: ${oldName || "—"} → ${option}`);
        continue;
      }
      // An open group no line holds: the line the parent's submit would make for it (server/lib/setMenuResolve.ts).
      if (bucket.some((l) => ofGroup(l, group))) {
        return refuse(409, "choice_already_made", `${group.label} was chosen in the BEO since the till read it. Read the party again and change the choice once more.`);
      }
      const portions = typeof group.qty === "number" && Number.isInteger(group.qty) && group.qty > 0 ? group.qty : 1;
      const line: Line = {
        id: `set_${group.id}_${option.replace(/\s+/g, "_")}`,
        itemName: option,
        quantity: portions,
        notes: `(${group.label})`,
        included: true,
        price: 0,
        source: "set_menu",
        groupId: group.id,
      };
      bucket.unshift(line);
      // SCRUM-958: no copy for the adults when their own list holds a dish of their own in this
      // group (an AI fill's "chicken fried rice for the adults"): it stays, never doubled.
      if (bucket === kids && adultsDiffer && !adults.some((a) => ofGroup(a, group))) adults.unshift(...adultsCopiesOf([line]));
      touch(bucket === kids ? "kids" : "adults");
      said.push(`${group.label}: ${option}`);
      continue;
    }
    // The cake: its time and its note, when the BEO has one.
    if (!kp.cakeMode || kp.cakeMode === "NONE") {
      return refuse(409, "no_cake", "The BEO says no cake for this party, so there is no cake time or note to change. Choose a cake in the BEO.");
    }
    const parts: string[] = [];
    if (change.time !== undefined) {
      parts.push(`time ${kp.cakeTime || "—"} → ${change.time ?? "—"}`);
      kp.cakeTime = change.time;
    }
    if (change.note !== undefined) {
      parts.push(`note "${(change.note ?? "").trim()}"`);
      kp.cakeNotes = (change.note ?? "").trim() || null;
    }
    kitchenTouched = true;
    said.push(`cake ${parts.join(", ")}`);
  }

  // The switch as the change leaves it: kept when it was on; turned on when an adults' line of a
  // list that repeated the kids' was changed and the two lists now differ (adultsDifferOf, on the
  // lists after the change), so the adults' change is written and never dropped.
  const differ = adultsDiffer || (adultsChangedWhileOff && adultsDifferOf({ kids, adults }));
  // A set-menu dish the template resolved is never renamed but by a choice of its own group:
  // `set` writes no name, and `choose` only an option the template names for that group.
  const kitchen = kitchenTouched
    ? {
        foodRequired: kp.foodRequired,
        cakeMode: kp.cakeMode,
        cakeNotes: kp.cakeNotes,
        cakeTime: kp.cakeTime,
        cakePrice: menus.cakePrice,
        cakeIncluded: menus.cakeIncluded,
        serviceSchedule: kp.serviceSchedule,
        setMenuEnabled: kp.setMenuEnabled,
        setMenuTemplateId: kp.setMenuTemplateId,
        menus: {
          kids,
          adults: differ ? adults : [],
          adultsDiffer: differ,
          kidsFoodTime: menus.kidsFoodTime,
          adultsFoodTime: menus.adultsFoodTime,
        },
      }
    : null;
  const barForm = barTouched ? { serviceTime: state.bar?.serviceTime ?? null, items: bar } : null;
  return { ok: true, kitchen, bar: barForm, said };
}

/** The change's fingerprint: the same id with another change is refused, never applied. */
export function tillKitchenEditHash(body: Pick<KitchenPlanEditBody, "changes" | "by">): string {
  return createHash("sha256").update(JSON.stringify({ by: body.by, changes: body.changes })).digest("hex");
}

export interface TillKitchenEditResult {
  edit: { id: string; eventId: string; changes: number };
  replayed: boolean;
}

export type TillKitchenEditOutcome = { ok: true; status: 200; body: TillKitchenEditResult; wrote: boolean } | Refusal;

/** The writers of the BEO's Save (beo-routes.ts), handed in so this file stays free of the routes module. */
export interface BeoSaveWriters {
  lockKitchenPlanMutation(tx: any, eventId: string): Promise<void>;
  kitchenPlanDbDataOf(kp: Record<string, any>): Record<string, any>;
  writeKitchenPlanRow(tx: any, eventId: string, data: Record<string, any>, setMenuSelectionSubmittedAt: unknown): Promise<void>;
  barPlanDbDataOf(bp: Record<string, any>): Record<string, any>;
  writeBarPlanRow(tx: any, eventId: string, data: Record<string, any>): Promise<void>;
}

/**
 * Apply one till edit to one party's BEO, once. The party is the key's park
 * group's (the route found it so); everything is read and written under the
 * kitchen plan's lock, the one the BEO's Save and the parent's submit take.
 */
export async function applyTillKitchenEdit(
  db: any,
  writers: BeoSaveWriters,
  event: { id: string; tenantId: string },
  body: KitchenPlanEditBody,
): Promise<TillKitchenEditOutcome> {
  const hash = tillKitchenEditHash(body);
  return db.transaction(async (tx: any): Promise<TillKitchenEditOutcome> => {
    await writers.lockKitchenPlanMutation(tx, event.id);
    const [seen] = await tx
      .select({ metadataJson: activityLog.metadataJson })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.tenantId, event.tenantId),
          eq(activityLog.activityType, TILL_KITCHEN_EDIT_ACTIVITY),
          like(activityLog.metadataJson, `%"tillEditId":"${body.id.toLowerCase()}"%`),
        ),
      )
      .limit(1);
    if (seen) {
      let held: { eventId?: unknown; requestHash?: unknown } = {};
      try {
        held = JSON.parse(seen.metadataJson ?? "{}");
      } catch {
        held = {};
      }
      if (held.eventId !== event.id || held.requestHash !== hash) {
        return refuse(409, "id_in_use", "That edit id already belongs to another change of the kitchen plan.");
      }
      return { ok: true, status: 200, body: { edit: { id: body.id, eventId: event.id, changes: body.changes.length }, replayed: true }, wrote: false };
    }

    const [ev] = await tx
      .select({ title: coreEvents.title, branchId: coreEvents.branchId })
      .from(coreEvents)
      .where(and(eq(coreEvents.id, event.id), eq(coreEvents.tenantId, event.tenantId)));
    if (!ev) return refuse(404, "event_not_found", "Event not found");
    const [kitchen] = await tx.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, event.id));
    const [bar] = await tx.select().from(beoBarPlans).where(eq(beoBarPlans.eventId, event.id));
    const [template] = kitchen?.setMenuTemplateId
      ? await tx
          .select({ name: beoSetMenuTemplates.name, items: beoSetMenuTemplates.items })
          .from(beoSetMenuTemplates)
          .where(and(eq(beoSetMenuTemplates.id, kitchen.setMenuTemplateId), eq(beoSetMenuTemplates.tenantId, event.tenantId)))
      : [];
    const planned = planTillKitchenEdit(
      {
        kitchen: kitchen ?? null,
        bar: bar ? { serviceTime: bar.serviceTime ?? null, items: kitchenLinesOf(bar.items) as Line[] } : null,
        template: template ? { name: template.name, items: Array.isArray(template.items) ? (template.items as TemplateItem[]) : [] } : null,
      },
      body.changes,
    );
    if (!planned.ok) return planned;

    if (planned.kitchen) {
      // The till's change is made on the plan as it stands under the lock: a set menu the parent
      // submitted is the plan's own here, never a stale form's (the Save's own check reads it so).
      const [selection] = await tx
        .select({ submittedAt: beoSetMenuSelections.submittedAt })
        .from(beoSetMenuSelections)
        .where(eq(beoSetMenuSelections.eventId, event.id));
      const submittedAt = selection?.submittedAt instanceof Date ? selection.submittedAt.toISOString() : null;
      await writers.writeKitchenPlanRow(tx, event.id, writers.kitchenPlanDbDataOf(planned.kitchen), submittedAt);
    }
    if (planned.bar) await writers.writeBarPlanRow(tx, event.id, writers.barPlanDbDataOf(planned.bar));

    await tx.insert(activityLog).values({
      tenantId: event.tenantId,
      branchId: ev.branchId,
      activityType: TILL_KITCHEN_EDIT_ACTIVITY,
      summaryText: `Kitchen plan of "${ev.title}" changed on the till by ${body.by.name} (${body.by.role}): ${planned.said.join("; ")}`.slice(0, 2000),
      metadataJson: JSON.stringify({
        tillEditId: body.id.toLowerCase(),
        eventId: event.id,
        requestHash: hash,
        editedAt: body.editedAt,
        by: body.by,
        changes: body.changes,
      }),
      createdBy: null,
    });
    return { ok: true, status: 200, body: { edit: { id: body.id, eventId: event.id, changes: body.changes.length }, replayed: false }, wrote: true };
  });
}
