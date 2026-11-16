import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beoBarPlans, beoEntertainmentSelections, beoKitchenPlans, beoPackageSnapshots, beoSetMenuSelections, coreEvents } from "@shared/schema";
import type { BeoAiCurrentLine } from "@shared/beoAiFill";
import type { DbExecutor } from "./packageSnapshot";

const lines = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((line) => line && typeof line === "object") : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
/** Stable across JSONB key order and database row order. No raw snapshot is returned or logged. */
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, held]) => [key, stable(held)]));
  return value;
}

/** Current saved structured plan, read again under the BEO write lock on approval. */
export async function beoReviewState(db: DbExecutor, eventId: string, lock = false): Promise<{ version: string; lines: BeoAiCurrentLine[] }> {
  const queries = [
    db.select().from(coreEvents).where(eq(coreEvents.id, eventId)),
    db.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId)),
    db.select().from(beoBarPlans).where(eq(beoBarPlans.eventId, eventId)),
    db.select().from(beoPackageSnapshots).where(eq(beoPackageSnapshots.eventId, eventId)),
    db.select().from(beoEntertainmentSelections).where(eq(beoEntertainmentSelections.eventId, eventId)),
    db.select().from(beoSetMenuSelections).where(eq(beoSetMenuSelections.eventId, eventId)),
  ] as const;
  const [event, kitchen, bar, packages, entertainment, selections] = await Promise.all([
    lock ? queries[0].for("update") : queries[0], lock ? queries[1].for("update") : queries[1],
    lock ? queries[2].for("update") : queries[2], lock ? queries[3].for("update") : queries[3],
    lock ? queries[4].for("update") : queries[4], lock ? queries[5].for("update") : queries[5],
  ]);
  const ordered = (rows: unknown[]) => [...rows].sort((a, b) => String(object(a).id).localeCompare(String(object(b).id)));
  // Deposit facts have their own concurrent-save guard; every other event field is protected here.
  const protectedEvent = event.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["prepaymentAmount", "prepaymentDate", "depositDate", "updatedAt", "updatedByUserId"].includes(key))));
  const snapshot = [protectedEvent, kitchen, bar, packages, ordered(entertainment), ordered(selections)];
  const version = createHash("sha256").update(JSON.stringify(stable(snapshot))).digest("hex");
  const menus = object(kitchen[0]?.menus);
  const shown: BeoAiCurrentLine[] = [];
  for (const [section, held] of [["Kids kitchen", menus.kids], ["Adults kitchen", menus.adults], ["Bar", bar[0]?.items]] as const) {
    for (const line of lines(held)) {
      const name = typeof line.itemName === "string" ? line.itemName.trim() : "";
      if (!name) continue;
      shown.push({ section, name, quantity: Number(line.quantity) > 0 ? Number(line.quantity) : 1,
        ...(typeof line.price === "number" && line.price > 0 ? { price: line.price } : {}),
        included: line.included === true || line.source === "set_menu" });
    }
  }
  for (const row of entertainment) shown.push({ section: "Entertainment", name: row.name, quantity: 1, included: !!row.templateId && row.price === 0, ...(typeof row.price === "number" && row.price > 0 ? { price: row.price / 100 } : {}) });
  return { version, lines: shown };
}
