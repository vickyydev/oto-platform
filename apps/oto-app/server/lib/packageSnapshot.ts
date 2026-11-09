import { asc, eq, sql } from "drizzle-orm";
import {
  beoKitchenPlans,
  beoPackageSnapshotItems,
  beoPackageSnapshots,
  packageLineItemTemplates,
  type BeoPackageSnapshot,
  type BeoPackageSnapshotItem,
  type BirthdayPackageTemplate,
} from "@shared/schema";
import type { db as appDb } from "../db";

/**
 * APPLYING A BIRTHDAY PACKAGE TO A PARTY: the BEO's package module
 * (`POST /api/beo/events/:eventId/package-snapshot`) and the BEO AI Fill's
 * approval (SCRUM-815) apply a package the same way, here.
 *
 * The party's snapshot is replaced by a copy of the template as it is now —
 * its name, prices, limits and slip time (SCRUM-803) and every line, included
 * and add-on — so the party keeps the prices it was sold at. An add-on starts
 * at the template's default quantity (the catalogue's add-ons start at 0: a
 * party has bought none) unless the caller names how many were bought. The
 * package's own set menu becomes the party's unless the kitchen plan already
 * names one, under the kitchen plan's own lock, as every other writer.
 */

/** The fields a package template copies onto a party's snapshot when it is applied (SCRUM-803). */
export const SNAPSHOT_COPIED_FIELDS = [
  "kidsIncluded",
  "adultsIncluded",
  "socksIncluded",
  "hours",
  "priceWeekday",
  "priceWeekend",
  "extraChildWeekday",
  "extraChildWeekend",
  "extraAdultWeekday",
  "extraAdultWeekend",
  "slipsTime",
] as const;

/** The database or a transaction on it (as server/storage.ts names it). */
export type DbExecutor = typeof appDb | Parameters<Parameters<typeof appDb.transaction>[0]>[0];

export async function applyPackageSnapshot(
  tx: DbExecutor,
  input: {
    eventId: string;
    template: BirthdayPackageTemplate;
    /** How many of an add-on were bought, by the template line's id; a line not named keeps its default. */
    quantities?: ReadonlyMap<string, number>;
  },
): Promise<{ snapshot: BeoPackageSnapshot; items: BeoPackageSnapshotItem[]; setMenuTemplateId: string | null }> {
  const { eventId, template } = input;
  const templateItems = await tx.select().from(packageLineItemTemplates)
    .where(eq(packageLineItemTemplates.packageTemplateId, template.id))
    .orderBy(asc(packageLineItemTemplates.sortOrder));

  const [existingSnapshot] = await tx.select().from(beoPackageSnapshots)
    .where(eq(beoPackageSnapshots.eventId, eventId));
  if (existingSnapshot) {
    await tx.delete(beoPackageSnapshotItems)
      .where(eq(beoPackageSnapshotItems.snapshotId, existingSnapshot.id));
    await tx.delete(beoPackageSnapshots)
      .where(eq(beoPackageSnapshots.id, existingSnapshot.id));
  }

  const [snapshot] = await tx.insert(beoPackageSnapshots).values({
    eventId,
    templateId: template.id,
    templateNameAtApply: template.name,
    templateUpdatedAtAtApply: template.updatedAt,
    packageName: template.name,
    basePrice: template.basePrice,
    includedSummary: template.includedSummary,
    excludedSummary: template.excludedSummary,
    ...(Object.fromEntries(SNAPSHOT_COPIED_FIELDS.map((field) => [field, template[field]])) as Pick<
      typeof template,
      (typeof SNAPSHOT_COPIED_FIELDS)[number]
    >),
  }).returning();

  // The package's own set menu becomes the party's, unless the BEO's kitchen
  // plan already names one (the set menu is chosen there; this only starts it).
  if (template.setMenuTemplateId) {
    const setMenuTemplateId = template.setMenuTemplateId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`);
    const [kitchenPlan] = await tx.select({ id: beoKitchenPlans.id, setMenuTemplateId: beoKitchenPlans.setMenuTemplateId })
      .from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, eventId));
    if (!kitchenPlan) {
      await tx.insert(beoKitchenPlans).values({ eventId, setMenuEnabled: true, setMenuTemplateId });
    } else if (!kitchenPlan.setMenuTemplateId) {
      await tx.update(beoKitchenPlans)
        .set({ setMenuEnabled: true, setMenuTemplateId, updatedAt: new Date() })
        .where(eq(beoKitchenPlans.id, kitchenPlan.id));
    }
  }

  let items: BeoPackageSnapshotItem[] = [];
  if (templateItems.length > 0) {
    items = await tx.insert(beoPackageSnapshotItems).values(
      templateItems.map((item) => ({
        snapshotId: snapshot.id,
        sourceTemplateLineItemId: item.id,
        category: item.category,
        label: item.label,
        description: item.description,
        qty: input.quantities?.get(item.id) ?? item.qtyDefault,
        unitLabel: item.unitLabel,
        included: item.included,
        unitPrice: item.defaultUnitPrice,
        billable: item.billableByDefault,
        sortOrder: item.sortOrder,
      }))
    ).returning();
  }

  return { snapshot, items, setMenuTemplateId: template.setMenuTemplateId };
}
