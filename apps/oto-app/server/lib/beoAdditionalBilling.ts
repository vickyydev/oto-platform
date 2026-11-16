import { beoBillingFingerprint, billingSyncAfterAttempt } from "@shared/beoBillingSource";
import { beoKitchenChargesOf } from "@shared/beoExtras";
import { eq, sql } from "drizzle-orm";
import { beoBarPlans, beoEventBilling, beoKitchenPlans } from "@shared/schema";
import { db } from "../db";
import { suiteProvisionConfig } from "./suiteSignIn";

type Line = Record<string, unknown>;
const rows = (value: unknown): Line[] => Array.isArray(value) ? value.filter((line) => line && typeof line === "object") : [];
const object = (value: unknown): Line => value && typeof value === "object" ? value as Line : {};
export type AdditionalBillingResult = { status: "synced" | "plan_only" | "pending"; message: string };

/** The plan is durable first; unresolved cross-service work stays visible and retries on the same Save. */
export async function syncApprovedBeoAdditions(eventId: string, userId: string): Promise<AdditionalBillingResult> {
  const read = async () => {
    const [kitchen] = await db.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId));
    const [bar] = await db.select().from(beoBarPlans).where(eq(beoBarPlans.eventId, eventId));
    const menus = object(kitchen?.menus);
    const kids = rows(menus.kids);
    const adults = menus.adultsDiffer === true ? rows(menus.adults) : [];
    const asExtra = (line: Line) => ({ itemName: String(line.itemName ?? ""), quantity: Number(line.quantity) || 1, productCode: typeof line.productCode === "string" ? line.productCode : null });
    const charges = beoKitchenChargesOf(kids.map(asExtra), adults.map(asExtra), menus.adultsDiffer === true, { till: { known: false, byCode: new Map() }, partyDate: null });
    return { kitchen, bar, menus, lines: [...kids.map((line): Line => ({ ...line, billingArea: "food" })), ...adults.filter((_, index) => charges.adults[index]?.kind !== "with_kids").map((line): Line => ({ ...line, billingArea: "food" })), ...rows(bar?.items).map((line): Line => ({ ...line, billingArea: "bar" }))].filter((line) => line.chargeApproved === true && line.source !== "set_menu" && typeof line.id === "string" && typeof line.itemName === "string" && line.itemName.trim()) };
  };
  const initial = await read();
  const finish = async (result: AdditionalBillingResult): Promise<AdditionalBillingResult> => {
    const held = JSON.stringify(result);
    await db.insert(beoEventBilling).values({ eventId, addOns: { additionalBilling: result } }).onConflictDoUpdate({ target: beoEventBilling.eventId,
      set: { addOns: sql`jsonb_set(COALESCE(${beoEventBilling.addOns}, '{}'::jsonb), '{additionalBilling}', ${held}::jsonb)` } });
    return result;
  };
  if (initial.lines.length === 0) {
    const [billing] = await db.select({ addOns: beoEventBilling.addOns }).from(beoEventBilling).where(eq(beoEventBilling.eventId, eventId));
    const existing = object(object(billing?.addOns).additionalBilling);
    if (existing.status === "pending" && typeof existing.message === "string") return { status: "pending", message: existing.message };
    return { status: "plan_only", message: "No newly approved priced additions." };
  }
  const fingerprint = new Map(initial.lines.map((line) => [String(line.id), beoBillingFingerprint(line, line.billingArea as "food" | "bar")]));
  const mark = async (status: string) => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`);
    const [kitchen] = await tx.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId));
    const [bar] = await tx.select().from(beoBarPlans).where(eq(beoBarPlans.eventId, eventId));
    const menus = object(kitchen?.menus);
    let unchanged = true;
    const seen = new Set<string>();
    const update = (held: unknown, area: "food" | "bar") => rows(held).map((line) => {
      const expected = fingerprint.get(String(line.id));
      if (!expected) return line;
      seen.add(String(line.id));
      if (expected !== beoBillingFingerprint(line, area)) unchanged = false;
      return { ...line, billingSync: billingSyncAfterAttempt(line, area, expected, status) };
    });
    if (kitchen) await tx.update(beoKitchenPlans).set({ menus: { ...menus, kids: update(menus.kids, "food"), adults: update(menus.adults, "food") } }).where(eq(beoKitchenPlans.id, kitchen.id));
    if (bar) await tx.update(beoBarPlans).set({ items: update(bar.items, "bar") }).where(eq(beoBarPlans.id, bar.id));
    return unchanged && seen.size === fingerprint.size;
  });
  const sameBefore = await mark("pending");
  await finish({ status: "pending", message: "New approved items are waiting for the till to confirm their additional bill. Save again to retry the same source lines." });
  const config = suiteProvisionConfig();
  const pending = (message: string) => finish({ status: "pending", message: `${message} The plan is saved; additional billing needs resolution. Save again to retry without duplicating a charge.` });
  if (!sameBefore) return pending("The plan changed while its additional bill was prepared.");
  if (!config) return pending("The till connection is not configured.");
  try {
    const response = await fetch(`${config.apiUrl}/otoapp/parties/${encodeURIComponent(eventId)}/beo-additions`, { method: "POST", headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(10_000), body: JSON.stringify({ actorAppUserId: userId, lines: initial.lines.map((line) => ({ lineId: line.id, productCode: typeof line.productCode === "string" && line.productCode.trim() ? line.productCode.trim() : null, area: line.billingArea, name: line.itemName, quantity: typeof line.quantity === "number" && line.quantity > 0 ? Math.floor(line.quantity) : 1, unitSatang: typeof line.price === "number" && line.price > 0 ? Math.round(line.price * 100) : null, included: line.included === true })) }) });
    const answer = await response.json().catch(() => null) as { status?: string; error?: { message?: string } } | null;
    if (!response.ok || (answer?.status !== "synced" && answer?.status !== "plan_only")) return pending(answer?.error?.message ?? "The till did not confirm the additional bill.");
    if (!(await mark(answer.status))) return pending("The plan changed while the till processed its earlier saved items. Review that bill before changing a charged line.");
    return finish({ status: answer.status, message: answer.status === "synced" ? "New approved items are linked to the party's additional bill; the original paid receipt is unchanged." : "Items remain in the plan until the main party is settled." });
  } catch {
    return pending("The till did not answer.");
  }
}
