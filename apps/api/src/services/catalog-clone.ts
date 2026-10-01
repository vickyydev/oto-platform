import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  branchHoliday,
  branchTaxConfig,
  discountDefinition,
  modifierGroup,
  modifierOption,
  printTemplate,
  product,
  productModifierGroup,
  sale,
  stockLocation,
  taxOverride,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * BRANCH CATALOGUE CLONE (SCRUM-204, R-03 / proposal §6.4).
 *
 * Opening a second park means typing the first one's catalogue in again. This
 * copies it: the branch-owned rows of one branch become fresh rows on another,
 * in one transaction, once — there is no later sync, and after the copy the two
 * branches are independent, which is what the admin panel has promised in words
 * since SCRUM-240 and done only in browser memory.
 *
 * THE LINE THIS FILE IS ABOUT: **branch-owned is copied, operator-wide is
 * referenced.** A ticket package, a holiday, a tax configuration, a print
 * template, a branch-pinned item and a stockroom each carry `branch_id` and are
 * one park's own, so each is copied with a fresh id. A product category, the
 * shared modifier library, a tier, a stock item and an operator-wide discount
 * carry no branch at all: they are ALREADY the target branch's, because they
 * belong to the operator that owns both. Copying those would not give the new
 * park its own category list — it would give the operator two categories called
 * "F&B" and a menu screen that cannot say which is which.
 *
 * WHAT IS NOT COPIED, AND WHY — read this before adding to the list:
 *
 *   - **Sales, bands, bookings, members, vouchers.** Facts, not configuration.
 *     A branch's trading history is not something another branch can be given.
 *   - **Stock levels** (`pos.stock_level`). What is on the shelf is a count,
 *     not a definition, and the ticket excludes it by name (S2-14b owns it).
 *     The stockroom it is counted in IS copied.
 *   - **Supervision policy, payment methods, staff benefit templates.** Named
 *     in the ticket's paragraph, and they have no table on the platform yet:
 *     they live in the POS catalogue store only, against SCRUM-210, SCRUM-206
 *     and SCRUM-218 (`MOCK_MUTATOR_TICKETS` in `CatalogStoreContext.tsx`).
 *     There is nothing here to copy until those land, and this file needs three
 *     more entities on the day they do.
 *   - **Booth settings and prizes** (`pos.booth_settings`, `pos.booth_prize`).
 *     Branch-owned, but not in the ticket's list, and a box reads them through
 *     `booth_config_version` — a copy that inserted the rows without minting
 *     the version a box syncs against would ship a television a configuration
 *     nothing describes. That belongs to the booth slice.
 *   - **Boxes, stations, devices.** The panel's old wording says "devices,
 *     etc."; a device is hardware standing in a mall, and copying its row would
 *     invent a printer nobody has plugged in.
 *
 * WHAT CANNOT BE COPIED EVEN THOUGH IT IS BRANCH-OWNED. A product's `code` and
 * `sku`, and a discount's `code`, are unique **per operator**, not per branch
 * (`product_code_unique`, `product_sku_unique`, `discount_definition_code_unique`
 * in `packages/db/src/schema/catalog.ts`). One operator therefore cannot hold
 * the same coded item twice, and an item pinned to the source branch has no
 * second row available to it at the target. That does not fail the clone and it
 * is not hidden either: every such row is reported BLOCKED, with the reason, in
 * the preview and in the audit row. Widening those three indexes to include
 * `branch_id` is what would unblock them, and that is a migration this slice
 * does not own.
 */

export const CLONE_ENTITIES = [
  'ticketPackages',
  'holidays',
  'taxConfig',
  'products',
  'modifierGroups',
  'modifierOptions',
  'modifierLinks',
  'discountCodes',
  'taxOverrides',
  'printTemplates',
  'stockLocations',
] as const;

export type CloneEntity = (typeof CLONE_ENTITIES)[number];

/** What the preview says about one entity, by that entity's natural key. */
export interface CloneEntityPlan {
  /** Keys that would be created in the target. */
  create: string[];
  /** Keys the target already carries — a second clone creates none of these. */
  exists: string[];
  /**
   * Rows that cannot be created at all, each with the reason.
   *
   * The field is `name` and not `key`, which reads better and is also load
   * bearing: `plugins/idempotency.ts` refuses to store any response carrying a
   * field whose name ends in `key`, so a clone answered under an
   * `Idempotency-Key` would never be replayable and a retry would re-run the
   * whole copy.
   */
  blocked: Array<{ name: string; reason: string }>;
}

export type ClonePlan = Record<CloneEntity, CloneEntityPlan>;

export interface CloneCounts {
  created: number;
  existing: number;
  blocked: number;
}

function emptyPlan(): ClonePlan {
  const plan = {} as ClonePlan;
  for (const entity of CLONE_ENTITIES) plan[entity] = { create: [], exists: [], blocked: [] };
  return plan;
}

/** The per-entity counts the audit row and the panel both read. */
export function countsOf(plan: ClonePlan): Record<CloneEntity, CloneCounts> {
  const counts = {} as Record<CloneEntity, CloneCounts>;
  for (const entity of CLONE_ENTITIES) {
    counts[entity] = {
      created: plan[entity].create.length,
      existing: plan[entity].exists.length,
      blocked: plan[entity].blocked.length,
    };
  }
  return counts;
}

/** Everything a clone would insert, already addressed to the target branch. */
interface CloneWrites {
  ticketPackages: Array<typeof ticketPackage.$inferInsert>;
  holidays: Array<typeof branchHoliday.$inferInsert>;
  taxConfig: Array<typeof branchTaxConfig.$inferInsert>;
  products: Array<typeof product.$inferInsert>;
  modifierGroups: Array<typeof modifierGroup.$inferInsert>;
  modifierOptions: Array<typeof modifierOption.$inferInsert>;
  modifierLinks: Array<typeof productModifierGroup.$inferInsert>;
  discountCodes: Array<typeof discountDefinition.$inferInsert>;
  taxOverrides: Array<typeof taxOverride.$inferInsert>;
  printTemplates: Array<typeof printTemplate.$inferInsert>;
  stockLocations: Array<typeof stockLocation.$inferInsert>;
}

export interface CloneScope {
  operatorId: string;
  sourceBranchId: string;
  targetBranchId: string;
}

const OPERATOR_UNIQUE_CODE =
  'a product code and a barcode name one product for the whole operator (product_code_unique / product_sku_unique), so the same coded item cannot exist twice under one operator';

const OPERATOR_UNIQUE_DISCOUNT =
  'a discount code names one definition for the whole operator (discount_definition_code_unique), so the same code cannot exist twice under one operator';

/**
 * Read both branches and work out, row by row, what a clone would do.
 *
 * Returns the plan the preview shows AND the rows the clone inserts, out of one
 * read of the same snapshot — so what was promised and what is written cannot
 * drift apart. The clone re-plans inside its own transaction rather than
 * trusting the answer a preview gave minutes ago.
 */
export async function planBranchClone(
  exec: Exec,
  scope: CloneScope,
): Promise<{ plan: ClonePlan; writes: CloneWrites }> {
  const { operatorId, sourceBranchId, targetBranchId } = scope;
  const plan = emptyPlan();
  const writes: CloneWrites = {
    ticketPackages: [],
    holidays: [],
    taxConfig: [],
    products: [],
    modifierGroups: [],
    modifierOptions: [],
    modifierLinks: [],
    discountCodes: [],
    taxOverrides: [],
    printTemplates: [],
    stockLocations: [],
  };

  // --- Ticket packages ------------------------------------------------------
  // Key: the name, because `ticket_package_name_unique` is (branch, name) and
  // is NOT partial — the note on that index says an archived package holds its
  // name for ever — so an archived row at the target still counts as taken.
  {
    const sourceRows = await exec
      .select()
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, sourceBranchId), isNull(ticketPackage.archivedAt)));
    const targetRows = await exec
      .select({ name: ticketPackage.name })
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, targetBranchId));
    const taken = new Set(targetRows.map((r) => r.name));
    for (const row of sourceRows) {
      if (taken.has(row.name)) {
        plan.ticketPackages.exists.push(row.name);
        continue;
      }
      plan.ticketPackages.create.push(row.name);
      const { id: _id, branchId: _branchId, createdAt: _c, updatedAt: _u, ...rest } = row;
      writes.ticketPackages.push({ ...rest, id: newId(), operatorId, branchId: targetBranchId });
    }
  }

  // --- Holidays -------------------------------------------------------------
  // Key: name + the two dates. `branch_holiday` carries no unique index, so
  // this match is the only thing between a second clone and a second Loy
  // Krathong on the same calendar.
  {
    const sourceRows = await exec
      .select()
      .from(branchHoliday)
      .where(and(eq(branchHoliday.branchId, sourceBranchId), isNull(branchHoliday.archivedAt)));
    const targetRows = await exec
      .select()
      .from(branchHoliday)
      .where(and(eq(branchHoliday.branchId, targetBranchId), isNull(branchHoliday.archivedAt)));
    const key = (r: { name: string; startsOn: string; endsOn: string }) =>
      `${r.name} (${r.startsOn} → ${r.endsOn})`;
    const taken = new Set(targetRows.map(key));
    for (const row of sourceRows) {
      if (taken.has(key(row))) {
        plan.holidays.exists.push(key(row));
        continue;
      }
      plan.holidays.create.push(key(row));
      const { id: _id, branchId: _branchId, createdAt: _c, updatedAt: _u, ...rest } = row;
      writes.holidays.push({ ...rest, id: newId(), branchId: targetBranchId });
    }
  }

  // --- Tax configuration ----------------------------------------------------
  // One row per branch (`branch_tax_config_unique`), so the natural key is its
  // presence. Never overwritten: a target that already totals its sales one way
  // does not have that changed by a copy from somewhere else.
  {
    const [sourceRow] = await exec
      .select()
      .from(branchTaxConfig)
      .where(eq(branchTaxConfig.branchId, sourceBranchId))
      .limit(1);
    const [targetRow] = await exec
      .select({ id: branchTaxConfig.id })
      .from(branchTaxConfig)
      .where(eq(branchTaxConfig.branchId, targetBranchId))
      .limit(1);
    if (sourceRow) {
      if (targetRow) {
        plan.taxConfig.exists.push('tax configuration');
      } else {
        plan.taxConfig.create.push('tax configuration');
        writes.taxConfig.push({ id: newId(), branchId: targetBranchId, config: sourceRow.config });
      }
    }
  }

  // --- Items ----------------------------------------------------------------
  //
  // Only rows PINNED to the source branch. A product with a null `branch_id` is
  // already sold at every branch of the operator, the target included, so
  // copying one would invent a second row for something the target can already
  // see (`readMenu`'s branch scope: `branch_id = :branch or branch_id is null`).
  const sourceProducts = await exec
    .select()
    .from(product)
    .where(and(eq(product.branchId, sourceBranchId), isNull(product.archivedAt)));
  const targetProducts = await exec
    .select({ id: product.id, name: product.name, kind: product.kind })
    .from(product)
    .where(and(eq(product.branchId, targetBranchId), isNull(product.archivedAt)));

  /** Source product id → the id it has at the target (copied, or matched). */
  const productIdAtTarget = new Map<string, string>();
  /** The source ids that are actually being COPIED — their children travel too. */
  const copiedProductIds = new Set<string>();
  {
    const nameKey = (p: { kind: string; name: string }) => `${p.kind} ${p.name}`;
    const targetByName = new Map(targetProducts.map((p) => [nameKey(p), p.id]));
    for (const row of sourceProducts) {
      const label = row.code ? `${row.name} (${row.code})` : row.name;
      // The operator-unique keys. See the header: a schema limit, reported
      // rather than worked around — dropping the code would leave the copy
      // unscannable and un-reimportable, and changing it would invent data.
      // A barcode on one of the item's sizes is the same kind of key (S2-09b):
      // the Merch panel refuses a second live holder of one across the
      // operator, and a copy would be exactly that.
      if (row.code !== null || row.sku !== null || row.variants.some((v) => !!v.barcode)) {
        plan.products.blocked.push({ name: label, reason: OPERATOR_UNIQUE_CODE });
        continue;
      }
      const match = targetByName.get(nameKey(row));
      if (match) {
        plan.products.exists.push(label);
        productIdAtTarget.set(row.id, match);
        continue;
      }
      const id = newId();
      productIdAtTarget.set(row.id, id);
      copiedProductIds.add(row.id);
      plan.products.create.push(label);
      const { id: _id, branchId: _branchId, createdAt: _c, updatedAt: _u, ...rest } = row;
      // S2-14b: a stock link is the source branch's shelf; the copy starts untracked.
      writes.products.push({ ...rest, stockItemId: null, id, operatorId, branchId: targetBranchId });
    }
  }

  // --- The copied items' modifiers ------------------------------------------
  // An INLINE group (`modifier_group.product_id` set) is that item's own
  // question and travels with the copy. The LIBRARY (`product_id` null) is
  // operator-wide and is referenced by id, never copied: two libraries called
  // "Ice level" would be a trap rather than a clone — and
  // `modifier_group_library_name_unique` refuses the second one anyway.
  if (copiedProductIds.size > 0) {
    const copied = [...copiedProductIds];
    const inline = await exec
      .select()
      .from(modifierGroup)
      .where(
        and(
          eq(modifierGroup.operatorId, operatorId),
          isNull(modifierGroup.archivedAt),
          inArray(modifierGroup.productId, copied),
        ),
      );
    const groupIdAtTarget = new Map<string, string>();
    for (const g of inline) {
      const id = newId();
      groupIdAtTarget.set(g.id, id);
      plan.modifierGroups.create.push(g.name);
      const { id: _id, productId: _productId, createdAt: _c, updatedAt: _u, ...rest } = g;
      // `productId` is non-null on every row the predicate above returned.
      const ownerId = productIdAtTarget.get(g.productId as string) as string;
      writes.modifierGroups.push({ ...rest, id, operatorId, productId: ownerId });
    }

    if (inline.length > 0) {
      const options = await exec
        .select()
        .from(modifierOption)
        .where(
          and(
            isNull(modifierOption.archivedAt),
            inArray(
              modifierOption.modifierGroupId,
              inline.map((g) => g.id),
            ),
          ),
        );
      for (const o of options) {
        const groupId = groupIdAtTarget.get(o.modifierGroupId);
        if (!groupId) continue;
        plan.modifierOptions.create.push(o.name);
        const { id: _id, modifierGroupId: _groupId, createdAt: _c, updatedAt: _u, ...rest } = o;
        writes.modifierOptions.push({ ...rest, id: newId(), operatorId, modifierGroupId: groupId });
      }
    }

    // The links into the shared library: the SAME group id, on the new item.
    const links = await exec
      .select()
      .from(productModifierGroup)
      .where(
        and(
          eq(productModifierGroup.operatorId, operatorId),
          inArray(productModifierGroup.productId, copied),
        ),
      );
    for (const link of links) {
      const ownerId = productIdAtTarget.get(link.productId) as string;
      plan.modifierLinks.create.push(link.modifierGroupId);
      writes.modifierLinks.push({
        operatorId,
        productId: ownerId,
        modifierGroupId: link.modifierGroupId,
        sortOrder: link.sortOrder,
      });
    }
  }

  // --- Discount codes -------------------------------------------------------
  // Only the BRANCH-SCOPED ones are the source branch's to give: `branch_id`
  // null means every branch of the operator, which already includes the target.
  {
    const sourceRows = await exec
      .select({ code: discountDefinition.code })
      .from(discountDefinition)
      .where(
        and(
          eq(discountDefinition.branchId, sourceBranchId),
          isNull(discountDefinition.archivedAt),
        ),
      );
    for (const row of sourceRows) {
      plan.discountCodes.blocked.push({ name: row.code, reason: OPERATOR_UNIQUE_DISCOUNT });
    }
  }

  // --- Tax overrides --------------------------------------------------------
  // Category ids are operator-wide and carry over untouched. A PRODUCT override
  // has to follow its item: copied when the item was, and blocked when the item
  // could not be — an override pointing at the source branch's row would
  // silently price the other park's item.
  {
    const sourceRows = await exec
      .select()
      .from(taxOverride)
      .where(eq(taxOverride.branchId, sourceBranchId));
    const targetRows = await exec
      .select({ categoryId: taxOverride.categoryId, productId: taxOverride.productId })
      .from(taxOverride)
      .where(eq(taxOverride.branchId, targetBranchId));
    const key = (categoryId: string | null, productId: string | null) =>
      `${categoryId ?? '-'}/${productId ?? '-'}`;
    const taken = new Set(targetRows.map((r) => key(r.categoryId, r.productId)));
    for (const row of sourceRows) {
      const mapped = row.productId === null ? null : (productIdAtTarget.get(row.productId) ?? null);
      if (row.productId !== null && mapped === null) {
        plan.taxOverrides.blocked.push({
          name: key(row.categoryId, row.productId),
          reason: 'the item it overrides could not be copied',
        });
        continue;
      }
      const k = key(row.categoryId, mapped);
      if (taken.has(k)) {
        plan.taxOverrides.exists.push(k);
        continue;
      }
      plan.taxOverrides.create.push(k);
      writes.taxOverrides.push({
        id: newId(),
        branchId: targetBranchId,
        categoryId: row.categoryId,
        productId: mapped,
        vatRateBp: row.vatRateBp,
        serviceChargeBp: row.serviceChargeBp,
      });
    }
  }

  // --- Print templates ------------------------------------------------------
  // Key: the TYPE, not the name. `print_template_branch_type_unique` is
  // (branch, type) and `catalogStore.getPrintTemplate` takes the first row of a
  // type, so a second "receipt" under another name would be invisible and
  // editing it would change nothing. The copy starts at version 1: a box syncs
  // on that number, and carrying the source's would claim an edit history the
  // target has not had.
  {
    const sourceRows = await exec
      .select()
      .from(printTemplate)
      .where(and(eq(printTemplate.branchId, sourceBranchId), isNull(printTemplate.archivedAt)));
    const targetRows = await exec
      .select({ type: printTemplate.type })
      .from(printTemplate)
      .where(and(eq(printTemplate.branchId, targetBranchId), isNull(printTemplate.archivedAt)));
    const taken = new Set<string>(targetRows.map((r) => r.type));
    for (const row of sourceRows) {
      if (taken.has(row.type)) {
        plan.printTemplates.exists.push(row.type);
        continue;
      }
      plan.printTemplates.create.push(row.type);
      const {
        id: _id,
        branchId: _branchId,
        version: _version,
        createdAt: _c,
        updatedAt: _u,
        ...rest
      } = row;
      writes.printTemplates.push({
        ...rest,
        id: newId(),
        operatorId,
        branchId: targetBranchId,
        version: 1,
      });
    }
  }

  // --- Stockrooms -----------------------------------------------------------
  // The definitions, not the counts: `stock_level` is what is on the shelf and
  // is nobody else's to copy (the ticket excludes it; S2-14b owns it).
  {
    const sourceRows = await exec
      .select()
      .from(stockLocation)
      .where(and(eq(stockLocation.branchId, sourceBranchId), isNull(stockLocation.archivedAt)));
    const targetRows = await exec
      .select({ name: stockLocation.name, sellPoint: stockLocation.sellPoint, archivedAt: stockLocation.archivedAt })
      .from(stockLocation)
      .where(eq(stockLocation.branchId, targetBranchId));
    const taken = new Set(targetRows.map((r) => r.name));
    // One sell point per branch (`stock_location_sell_point_unique`): a target
    // that already has one keeps it, and the copies come across as storage.
    let targetHasSellPoint = targetRows.some((r) => r.sellPoint && !r.archivedAt);
    for (const row of sourceRows) {
      if (taken.has(row.name)) {
        plan.stockLocations.exists.push(row.name);
        continue;
      }
      plan.stockLocations.create.push(row.name);
      writes.stockLocations.push({
        id: newId(),
        operatorId,
        branchId: targetBranchId,
        name: row.name,
        // S2-14b: the place's kind and whether it is the sell point come with it.
        type: row.type,
        sellPoint: row.sellPoint && row.active && !targetHasSellPoint,
        active: row.active,
      });
      if (row.sellPoint && row.active) targetHasSellPoint = true;
    }
  }

  return { plan, writes };
}

/** Has this branch ever traded? One row is enough to refuse. */
export async function branchHasSales(exec: Exec, branchId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: sale.id })
    .from(sale)
    .where(eq(sale.branchId, branchId))
    .limit(1);
  return row !== undefined;
}

export function branchHasSalesError(branchName: string) {
  return errors.conflict(
    'BRANCH_HAS_SALES',
    `${branchName} has already taken sales, so its catalogue cannot be filled from another branch: every receipt it has printed answers to the prices and tax rules it sold under, and a second set of packages beside those would leave nobody able to say which one priced a given sale. Build its catalogue up on the Catalogue screens instead.`,
    { branch: branchName },
  );
}

/**
 * Operator-wide rows a cloned item points AT rather than copies — said out loud
 * on the preview so nobody reads a short create list as a broken clone.
 */
export const SHARED_WITH_THE_OPERATOR = [
  'product categories',
  'the shared modifier library and its options',
  'customer tiers',
  'stock items',
  'voucher definitions',
  'discount codes that apply to every branch',
];

export interface ClonePreview {
  sourceBranch: { id: string; name: string };
  targetBranch: { id: string; name: string };
  /** True when the target has traded — the clone would be refused. */
  targetHasSales: boolean;
  plan: ClonePlan;
  counts: Record<CloneEntity, CloneCounts>;
  shared: string[];
}

/** What the preview dialog reads. No writes, no transaction. */
export async function previewBranchClone(
  exec: Exec,
  scope: CloneScope,
  names: { source: string; target: string },
): Promise<ClonePreview> {
  const { plan } = await planBranchClone(exec, scope);
  return {
    sourceBranch: { id: scope.sourceBranchId, name: names.source },
    targetBranch: { id: scope.targetBranchId, name: names.target },
    targetHasSales: await branchHasSales(exec, scope.targetBranchId),
    plan,
    counts: countsOf(plan),
    shared: SHARED_WITH_THE_OPERATOR,
  };
}

export interface CloneResult {
  sourceBranchId: string;
  targetBranchId: string;
  counts: Record<CloneEntity, CloneCounts>;
  plan: ClonePlan;
  /** Total rows written. Zero on a second run, which is the point of the keys. */
  created: number;
}

/**
 * Copy the source branch's catalogue into the target. All of it or none of it:
 * the caller runs this inside `withTx`, and the audit row goes in with it.
 */
export async function cloneBranchCatalog(
  tx: Tx,
  ctx: { actorAccountId: string | null; operatorId: string; requestId?: string | null },
  scope: CloneScope,
  names: { source: string; target: string },
): Promise<CloneResult> {
  // Re-read and re-plan inside the transaction. The preview the panel showed
  // was a separate request and may be minutes old; this is the snapshot the
  // insert is actually made from, and the sales check is asked again here so
  // that a sale rung up between preview and clone still refuses it.
  if (await branchHasSales(tx, scope.targetBranchId)) throw branchHasSalesError(names.target);

  const { plan, writes } = await planBranchClone(tx, scope);

  if (writes.ticketPackages.length) await tx.insert(ticketPackage).values(writes.ticketPackages);
  if (writes.holidays.length) await tx.insert(branchHoliday).values(writes.holidays);
  if (writes.taxConfig.length) await tx.insert(branchTaxConfig).values(writes.taxConfig);
  if (writes.products.length) await tx.insert(product).values(writes.products);
  if (writes.modifierGroups.length) await tx.insert(modifierGroup).values(writes.modifierGroups);
  if (writes.modifierOptions.length) await tx.insert(modifierOption).values(writes.modifierOptions);
  if (writes.modifierLinks.length) {
    await tx.insert(productModifierGroup).values(writes.modifierLinks);
  }
  if (writes.discountCodes.length) await tx.insert(discountDefinition).values(writes.discountCodes);
  if (writes.taxOverrides.length) await tx.insert(taxOverride).values(writes.taxOverrides);
  if (writes.printTemplates.length) await tx.insert(printTemplate).values(writes.printTemplates);
  if (writes.stockLocations.length) await tx.insert(stockLocation).values(writes.stockLocations);

  const counts = countsOf(plan);
  const created = Object.values(counts).reduce((sum, c) => sum + c.created, 0);

  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId,
    operatorId: ctx.operatorId,
    branchId: scope.targetBranchId,
    action: 'catalog.clone',
    entityType: 'branch',
    entityId: scope.targetBranchId,
    after: {
      sourceBranchId: scope.sourceBranchId,
      sourceBranchName: names.source,
      targetBranchName: names.target,
      created,
      counts,
      blocked: Object.fromEntries(
        CLONE_ENTITIES.filter((e) => plan[e].blocked.length > 0).map((e) => [e, plan[e].blocked]),
      ),
      shared: SHARED_WITH_THE_OPERATOR,
    },
    requestId: ctx.requestId ?? null,
  });

  return {
    sourceBranchId: scope.sourceBranchId,
    targetBranchId: scope.targetBranchId,
    counts,
    plan,
    created,
  };
}
