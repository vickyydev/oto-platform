import { and, eq, inArray, isNull } from 'drizzle-orm';
import { isProductBarcode } from '@oto/box-agent';
import {
  branch,
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
 * CODES ARE UNIQUE PER OPERATOR, SO A COPY CARRIES THE TARGET'S OWN (SCRUM-345).
 * A product's `code` and `sku`, and a discount's `code`, are unique **per
 * operator** (`product_code_unique`, `product_sku_unique`,
 * `discount_definition_code_unique` in `packages/db/src/schema/catalog.ts`), so
 * the copy cannot hold the source row's code as it is. It gets the code with the
 * target branch's own code on the end — `FB-NUGGETS` cloned to Robinson Chalong
 * is `FB-NUGGETS-ROBINSON-CHALONG` — which keeps every code naming one row and
 * tells anyone reading it which park's row it is. The preview names each change
 * (`FB-NUGGETS → FB-NUGGETS-ROBINSON-CHALONG`). A branch-scoped discount code
 * travels the same way, with the items and packages it points at mapped to the
 * target's own rows.
 *
 * WHAT STILL CANNOT BE COPIED: a real BARCODE — an `sku` shaped like one
 * (`isProductBarcode`), or one on a size. That string is printed on a label the
 * scanner reads, so it cannot be renamed, and it names one live item across the
 * operator; a second holder is exactly what the Merch panel refuses. Such an
 * item is reported BLOCKED, with the reason, in the preview and in the audit
 * row. So is a renamed code that would run past 32 characters or is already
 * held, and a discount that points at something the clone could not map.
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

const OPERATOR_UNIQUE_BARCODE =
  'a barcode names one product for the whole operator (product_sku_unique, and the same rule for a size’s barcode), and a printed barcode cannot be renamed for the copy';

/** The longest code the catalogue screens accept (`CodeSchema` in `@oto/shared`). */
const MAX_CODE_LENGTH = 32;

/** `robinson-chalong` → `ROBINSON-CHALONG`: the target park's part of a cloned code. */
export function cloneCodeSuffix(branchCode: string): string {
  return branchCode
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The code a copied row carries at the target: the source's, with the target's suffix. */
export function clonedCode(code: string, suffix: string): string {
  return suffix ? `${code}-${suffix}` : code;
}

/**
 * A discount's `target` with every branch-owned id it names swapped for the
 * target branch's own. Undefined when one of them has no row there.
 */
function mapDiscountTarget(
  target: unknown,
  productHere: (id: string) => string | null,
  packageHere: (id: string) => string | null,
): unknown {
  if (target === null || target === undefined) return null;
  const t = target as { kind?: string; addOnId?: string; menuItemIds?: string[]; ticketTypeId?: string };
  if (t.kind === 'addOn' && t.addOnId) {
    const id = productHere(t.addOnId);
    return id === null ? undefined : { ...t, addOnId: id };
  }
  if (t.kind === 'menuItems') {
    const ids = (t.menuItemIds ?? []).map(productHere);
    return ids.some((id) => id === null) ? undefined : { ...t, menuItemIds: ids };
  }
  if (t.kind === 'ticketType' && t.ticketTypeId) {
    const id = packageHere(t.ticketTypeId);
    return id === null ? undefined : { ...t, ticketTypeId: id };
  }
  return target;
}

/** Why a renamed code cannot be used, or null when it can. Pairs each code with the set it must not be in. */
function codeBlockReason(codes: (string | null)[], held: Set<string>[]): string | null {
  for (const [i, code] of codes.entries()) {
    if (code === null) continue;
    if (code.length > MAX_CODE_LENGTH) {
      return `its code with this branch's suffix (${code}) would be longer than ${MAX_CODE_LENGTH} characters — give it a shorter code first`;
    }
    if (held[i]?.has(code)) return `the code it would carry here (${code}) is already held by another row of this operator`;
  }
  return null;
}

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
  const [targetBranch] = await exec
    .select({ code: branch.code })
    .from(branch)
    .where(eq(branch.id, targetBranchId))
    .limit(1);
  const suffix = cloneCodeSuffix(targetBranch?.code ?? '');
  /** Source package id → its id at the target (copied, or matched by name). */
  const packageIdAtTarget = new Map<string, string>();

  // --- Ticket packages ------------------------------------------------------
  // Key: the name, because `ticket_package_name_unique` is (branch, name). The
  // index ignores archived rows since SCRUM-273, but an archived row at the
  // target still counts as taken HERE on purpose: a package the target park
  // archived is one it chose not to sell, and a clone does not put it back.
  {
    const sourceRows = await exec
      .select()
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, sourceBranchId), isNull(ticketPackage.archivedAt)));
    const targetRows = await exec
      .select({ id: ticketPackage.id, name: ticketPackage.name, archivedAt: ticketPackage.archivedAt })
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, targetBranchId));
    // A live row wins over an archived one of the same name (live rows last).
    const taken = new Map(
      [...targetRows].sort((a, b) => Number(!a.archivedAt) - Number(!b.archivedAt)).map((r) => [r.name, r]),
    );
    for (const row of sourceRows) {
      const existing = taken.get(row.name);
      if (existing) {
        plan.ticketPackages.exists.push(row.name);
        // A package the target archived is not one a copied discount may point at.
        if (!existing.archivedAt) packageIdAtTarget.set(row.id, existing.id);
        continue;
      }
      plan.ticketPackages.create.push(row.name);
      const { id: _id, branchId: _branchId, createdAt: _c, updatedAt: _u, ...rest } = row;
      const id = newId();
      packageIdAtTarget.set(row.id, id);
      writes.ticketPackages.push({ ...rest, id, operatorId, branchId: targetBranchId });
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
    // Every live code and sku the operator holds, so a renamed one is checked
    // here rather than refused by the index in the middle of the insert.
    const live = await exec
      .select({ code: product.code, sku: product.sku })
      .from(product)
      .where(and(eq(product.operatorId, operatorId), isNull(product.archivedAt)));
    const codesHeld = new Set(live.flatMap((r) => (r.code ? [r.code] : [])));
    const skusHeld = new Set(live.flatMap((r) => (r.sku ? [r.sku] : [])));
    for (const row of sourceProducts) {
      const label = row.code ? `${row.name} (${row.code})` : row.name;
      const match = targetByName.get(nameKey(row));
      if (match) {
        plan.products.exists.push(label);
        productIdAtTarget.set(row.id, match);
        continue;
      }
      // A real barcode is printed on a label and names one live item across
      // the operator (S2-09b): it cannot be renamed for the copy. See the header.
      if ((row.sku !== null && isProductBarcode(row.sku)) || row.variants.some((v) => !!v.barcode)) {
        plan.products.blocked.push({ name: label, reason: OPERATOR_UNIQUE_BARCODE });
        continue;
      }
      // SCRUM-345 — the code and a non-barcode sku carry the target's suffix.
      const code = row.code === null ? null : clonedCode(row.code, suffix);
      const sku = row.sku === null ? null : clonedCode(row.sku, suffix);
      const blocked = codeBlockReason([code, sku], [codesHeld, skusHeld]);
      if (blocked) {
        plan.products.blocked.push({ name: label, reason: blocked });
        continue;
      }
      if (code !== null) codesHeld.add(code);
      if (sku !== null) skusHeld.add(sku);
      const id = newId();
      productIdAtTarget.set(row.id, id);
      copiedProductIds.add(row.id);
      plan.products.create.push(row.code ? `${row.name} (${row.code} → ${code})` : label);
      const { id: _id, branchId: _branchId, createdAt: _c, updatedAt: _u, ...rest } = row;
      // S2-14b: a stock link is the source branch's shelf; the copy starts untracked.
      writes.products.push({ ...rest, code, sku, stockItemId: null, id, operatorId, branchId: targetBranchId });
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
  //
  // SCRUM-345: the copy carries the code with the target's suffix (see the
  // header), and what it points at is mapped to the target's own rows — a
  // branch-pinned item or package the clone copied or matched. An operator-wide
  // item needs no mapping. Anything it points at that has no row at the target
  // blocks it, as an override pointing at the source's row would.
  {
    const sourceRows = await exec
      .select()
      .from(discountDefinition)
      .where(
        and(
          eq(discountDefinition.branchId, sourceBranchId),
          isNull(discountDefinition.archivedAt),
        ),
      );
    const liveCodes = await exec
      .select({ code: discountDefinition.code, branchId: discountDefinition.branchId })
      .from(discountDefinition)
      .where(and(eq(discountDefinition.operatorId, operatorId), isNull(discountDefinition.archivedAt)));
    const codesHeld = new Set(liveCodes.map((r) => r.code));
    const atTarget = new Set(liveCodes.filter((r) => r.branchId === targetBranchId).map((r) => r.code));
    // The products the source's discounts name that no map above covers: kept
    // only when they belong to every branch.
    const named = new Set<string>();
    for (const row of sourceRows) {
      if (row.freeProductId) named.add(row.freeProductId);
      const t = row.target as { kind?: string; addOnId?: string; menuItemIds?: string[] } | null;
      if (t?.kind === 'addOn' && t.addOnId) named.add(t.addOnId);
      if (t?.kind === 'menuItems') for (const id of t.menuItemIds ?? []) named.add(id);
    }
    // An add-on can be named by a slug rather than a product id; a slug is no
    // branch's row and travels as it is.
    const isRowId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const unmapped = [...named].filter((id) => isRowId(id) && !productIdAtTarget.has(id));
    const operatorWide = new Set(
      unmapped.length === 0
        ? []
        : (
            await exec
              .select({ id: product.id })
              .from(product)
              .where(
                and(
                  eq(product.operatorId, operatorId),
                  inArray(product.id, unmapped),
                  isNull(product.branchId),
                  isNull(product.archivedAt),
                ),
              )
          ).map((r) => r.id),
    );
    const productHere = (id: string): string | null =>
      productIdAtTarget.get(id) ?? (operatorWide.has(id) || !isRowId(id) ? id : null);

    for (const row of sourceRows) {
      const code = clonedCode(row.code, suffix);
      if (atTarget.has(code)) {
        plan.discountCodes.exists.push(code);
        continue;
      }
      const blocked = codeBlockReason([code], [codesHeld]);
      if (blocked) {
        plan.discountCodes.blocked.push({ name: row.code, reason: blocked });
        continue;
      }
      const freeProductId = row.freeProductId === null ? null : productHere(row.freeProductId);
      const target = mapDiscountTarget(row.target, productHere, (id) => packageIdAtTarget.get(id) ?? null);
      if ((row.freeProductId !== null && freeProductId === null) || target === undefined) {
        plan.discountCodes.blocked.push({
          name: row.code,
          reason: 'it points at an item or ticket package that could not be copied to this branch',
        });
        continue;
      }
      codesHeld.add(code);
      plan.discountCodes.create.push(`${row.code} → ${code}`);
      const { id: _id, branchId: _branchId, createdAt: _c, updatedAt: _u, ...rest } = row;
      writes.discountCodes.push({
        ...rest,
        id: newId(),
        operatorId,
        branchId: targetBranchId,
        code,
        freeProductId,
        target,
      });
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
