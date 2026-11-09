/**
 * The park's real till catalogue, loaded onto one branch (2026-11-09).
 *
 * `seedRealCatalog(db, { operatorId, branchId, park })` converges a park's
 * branch on `buildParkCatalog(park)`: the operator-wide categories first, then
 * the park's products, then each product's inline modifier groups. It is keyed
 * on `code`, like `seed/menu.ts`, with one difference that is the point of it:
 * this is reference data, so an existing row whose name, description, price,
 * category, kind, prep override or sort order differs from the data IS updated
 * (a corrected price must reach the till). A second run with the same data
 * changes nothing. `active` is written on insert only, so a switch made later
 * in the Console is never argued with; a product of ours that has been archived
 * is left archived and reported, never re-created.
 *
 * Inline modifier groups and options are matched by name. One this loader
 * created (its own `modifier_group.*` audit rows, request id
 * `seed:real-catalog`) that the data no longer names is archived, so a renamed
 * group or option never leaves the old one live beside the new one; one the
 * loader never wrote (added in the Console) is left alone and reported.
 *
 * `retireDemo` archives (archived_at, active false) the demo products of THAT
 * branch whose codes `seed/menu.ts` writes — never a ticket package, never a
 * stock item, never a row of another branch or an operator-wide row, never a
 * code the runtime looks up by name or the price list names
 * (`DEMO_CODES_KEPT`), and never a product linked to stock (a live
 * `stock_item.product_id` or a `product.stock_item_id`) unless
 * `retireStockLinked` says so.
 *
 * `apply: false` writes nothing and returns the same report as a plan.
 * Every write is in one transaction and has its audit row, attributed to no
 * account and to the request id `seed:real-catalog`.
 */
import { newId } from '@oto/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../index';
import * as s from '../../schema/index';
import type { PrepStation, ProductKind, TaxableCategory } from '../../schema/catalog';
import { buildParkCatalog } from './catalog';
import { REAL_CATEGORIES } from './categories';
import { PARK_CODE_PREFIX, type GroupSeed, type NotSeeded, type Park, type ProductSeed } from './types';

export { buildParkCatalog, lineDescription, lineGroups, lineName, productCode } from './catalog';
export type { BuildOptions, ParkCatalog } from './catalog';
export { REAL_CATEGORIES } from './categories';
export { MENU_LINES, PRINTED_LINE_COUNTS } from './menu-lines';
export { CURRENT_POS_LINES, FREE_DRINK_LINES, PRINTED_SHOP_COUNTS, SHOP_LINES, SPECIAL_LINES } from './price-list';
export * from './types';

type Exec = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** The request id every audit row of this loader carries. */
export const REAL_CATALOG_REQUEST_ID = 'seed:real-catalog';

/** Every product code the demo seed writes (`seed/menu.ts`, plus its retired MR-SOCKS-M). */
export const DEMO_PRODUCT_CODES: readonly string[] = [
  'FB-NUGGETS', 'FB-FRIES', 'FB-PIZZA', 'FB-BURGER', 'FB-PADTHAI', 'FB-HOTDOG', 'FB-WATER',
  'FB-JUICE', 'FB-SODA', 'FB-LATTE', 'FB-SHAKE', 'FB-BEER', 'FB-WINE', 'FB-MOJITO',
  'FB-GINTONIC', 'FB-POPCORN', 'FB-ICECREAM', 'FB-COTTONCANDY', 'FB-FRUITCUP', 'FB-SLUSHIE',
  'MR-TSHIRT', 'MR-CAP', 'MR-SOCKS', 'MR-BOTTLE', 'MR-PLUSH', 'MR-STICKERS', 'MR-KEYRING',
  'MR-LANYARD', 'MR-SOCKS-M',
  'AO-SOCKS', 'AO-GRIPSOCKS', 'AO-LOCKER', 'AO-CUP', 'AO-GLOW',
];

/**
 * Demo codes `retireDemo` never archives, and why. Each is looked up BY CODE in
 * the running system, so archiving it would leave a door with nothing behind it.
 */
export const DEMO_CODES_KEPT: Readonly<Record<string, string>> = {
  'AO-SOCKS':
    'the price list names Socks (60); the socks counter, sale pricing, booking checkout and redemption look up this code',
  'AO-GRIPSOCKS': 'booking checkout maps the booking site add-on a-grip-socks to this code',
  'AO-LOCKER': 'booking checkout maps the booking site add-on a-locker to this code',
  'AO-CUP': 'booking checkout maps the booking site add-on a-cup to this code',
  'AO-GLOW': 'booking checkout maps the booking site add-on a-glow to this code',
};

export interface RealCatalogOptions {
  operatorId: string;
  branchId: string;
  park: Park;
  /** Archive this branch's demo products (see DEMO_CODES_KEPT for the exceptions). */
  retireDemo?: boolean;
  /**
   * With `retireDemo`: also archive demo products linked to stock. Off by
   * default, because an archived product leaves its stock items and their
   * barcodes (MR-SOCKS's sizes) pointing at a row the till no longer sells.
   */
  retireStockLinked?: boolean;
  /** Also write the Free Drinks Menu card's drinks (0 THB, inactive). See BuildOptions. */
  includeFreeDrinks?: boolean;
  /** False = report the plan and write nothing. Default true. */
  apply?: boolean;
  /** Tests: converge on these products instead of the built catalogue. */
  products?: ProductSeed[];
}

export interface RealCatalogReport {
  park: Park;
  applied: boolean;
  categories: { created: string[]; updated: string[]; unchanged: string[] };
  products: {
    inserted: string[];
    updated: string[];
    unchanged: string[];
    /** Ours, archived at this branch: left archived. */
    skippedArchived: string[];
    /** The code is live on ANOTHER branch: refused, nothing written for it. */
    conflicts: string[];
  };
  groups: {
    created: number;
    updated: number;
    unchanged: number;
    /** "CF-47 Choice": inline groups this loader created that the data no longer names; archived with their options. */
    archived: string[];
    /** "CF-42 Protein: chicken": options this loader wrote that the data no longer names; archived. */
    optionsArchived: string[];
    /** Groups and options on our products that the data does not name and this loader never wrote: left alone. */
    leftAlone: string[];
  };
  retire: { archived: string[]; kept: Array<{ code: string; reason: string }> };
  /** Demo products still live at this branch after the run. */
  demoLive: string[];
  /** Live products of this branch that are neither ours nor demo: never touched. */
  untouched: { codes: string[]; codeless: number };
  /** Live products of this branch with our park prefix that the data no longer has. */
  stale: string[];
  warnings: string[];
  notSeeded: NotSeeded[];
}

interface ProductWanted {
  name: string;
  description: string | null;
  categoryId: string | null;
  kind: ProductKind;
  priceSatang: number;
  priceWeekendSatang: number | null;
  prepStationOverride: PrepStation | null;
  sortOrder: number;
}

const PRODUCT_FIELDS: (keyof ProductWanted)[] = [
  'name',
  'description',
  'categoryId',
  'kind',
  'priceSatang',
  'priceWeekendSatang',
  'prepStationOverride',
  'sortOrder',
];

function changedFields<T extends object>(before: T, after: T, fields: (keyof T)[]): (keyof T)[] {
  return fields.filter((f) => before[f] !== after[f]);
}

function pick<T extends object>(row: T, fields: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) out[f] = row[f];
  return out;
}

export async function seedRealCatalog(db: Db, opts: RealCatalogOptions): Promise<RealCatalogReport> {
  if (opts.apply === false) return run(db, opts, false);
  return db.transaction((tx) => run(tx, opts, true));
}

async function run(db: Exec, opts: RealCatalogOptions, write: boolean): Promise<RealCatalogReport> {
  const { operatorId, branchId, park } = opts;
  const catalog = buildParkCatalog(park, { includeFreeDrinks: opts.includeFreeDrinks ?? false });
  const seeds = opts.products ?? catalog.products;
  const now = new Date();
  const report: RealCatalogReport = {
    park,
    applied: write,
    categories: { created: [], updated: [], unchanged: [] },
    products: { inserted: [], updated: [], unchanged: [], skippedArchived: [], conflicts: [] },
    groups: { created: 0, updated: 0, unchanged: 0, archived: [], optionsArchived: [], leftAlone: [] },
    retire: { archived: [], kept: [] },
    demoLive: [],
    untouched: { codes: [], codeless: 0 },
    stale: [],
    warnings: [],
    notSeeded: catalog.notSeeded,
  };

  const audit = async (row: {
    branchId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before: unknown;
    after: unknown;
  }) => {
    if (!write) return;
    await db.insert(s.auditLog).values({
      id: newId(),
      operatorId,
      branchId: row.branchId,
      actorAccountId: null,
      requestId: REAL_CATALOG_REQUEST_ID,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before ?? null,
      after: row.after ?? null,
    });
  };

  // --- Categories (operator-wide) --------------------------------------------
  const categoryCodes = REAL_CATEGORIES.map((c) => c.code);
  const liveCategories = await db
    .select()
    .from(s.productCategory)
    .where(
      and(
        eq(s.productCategory.operatorId, operatorId),
        isNull(s.productCategory.archivedAt),
        inArray(s.productCategory.code, categoryCodes),
      ),
    );
  const categoryIdByCode = new Map<string, string>();
  for (const c of REAL_CATEGORIES) {
    const wanted = {
      name: c.name,
      parentId: null as string | null,
      taxableCategory: c.taxable as TaxableCategory | null,
      defaultPrepStation: c.prep as PrepStation | null,
      sortOrder: c.sort,
    };
    const existing = liveCategories.find((row) => row.code === c.code);
    if (!existing) {
      const id = write ? newId() : `pending:${c.code}`;
      categoryIdByCode.set(c.code, id);
      report.categories.created.push(c.code);
      if (write) {
        await db.insert(s.productCategory).values({ id, operatorId, code: c.code, ...wanted });
        await audit({
          branchId: null,
          action: 'menu_category.create',
          entityType: 'product_category',
          entityId: id,
          before: null,
          after: { code: c.code, ...wanted },
        });
      }
      continue;
    }
    categoryIdByCode.set(c.code, existing.id);
    const fields = changedFields(existing, { ...existing, ...wanted }, [
      'name',
      'parentId',
      'taxableCategory',
      'defaultPrepStation',
      'sortOrder',
    ]);
    if (fields.length === 0) {
      report.categories.unchanged.push(c.code);
      continue;
    }
    report.categories.updated.push(c.code);
    if (write) {
      await db
        .update(s.productCategory)
        .set({ ...wanted, updatedAt: now })
        .where(eq(s.productCategory.id, existing.id));
      await audit({
        branchId: null,
        action: 'menu_category.update',
        entityType: 'product_category',
        entityId: existing.id,
        before: pick(existing, fields),
        after: pick({ ...existing, ...wanted }, fields),
      });
    }
  }

  // --- Products (this branch) -------------------------------------------------
  const seedCodes = seeds.map((p) => p.code);
  const existingProducts = seedCodes.length
    ? await db
        .select()
        .from(s.product)
        .where(and(eq(s.product.operatorId, operatorId), inArray(s.product.code, seedCodes)))
    : [];
  const liveByCode = new Map(
    existingProducts.filter((row) => !row.archivedAt && row.code).map((row) => [row.code!, row]),
  );
  const archivedHere = new Set(
    existingProducts
      .filter((row) => row.archivedAt && row.branchId === branchId && row.code)
      .map((row) => row.code!),
  );

  const productIdByCode = new Map<string, string>();
  const inserts: (typeof s.product.$inferInsert)[] = [];
  const insertAudits: Parameters<typeof audit>[0][] = [];
  for (const seed of seeds) {
    if (seed.categoryCode === null) {
      report.warnings.push(
        `${seed.code} has no category (no source names its tab): the till finds it only by search, and its prep ticket prints at the kitchen (the fallback) until one is set`,
      );
    }
    const wanted: ProductWanted = {
      name: seed.name,
      description: seed.description,
      categoryId: seed.categoryCode === null ? null : (categoryIdByCode.get(seed.categoryCode) ?? null),
      kind: seed.kind,
      priceSatang: seed.priceSatang,
      priceWeekendSatang: seed.priceWeekendSatang,
      prepStationOverride: seed.prepStationOverride,
      sortOrder: seed.sortOrder,
    };
    const live = liveByCode.get(seed.code);
    if (live) {
      if (live.branchId !== branchId) {
        report.products.conflicts.push(seed.code);
        continue;
      }
      productIdByCode.set(seed.code, live.id);
      const fields = changedFields(live as ProductWanted, wanted, PRODUCT_FIELDS);
      if (fields.length === 0) {
        report.products.unchanged.push(seed.code);
        continue;
      }
      report.products.updated.push(seed.code);
      if (write) {
        await db
          .update(s.product)
          .set({ ...pick(wanted, fields), updatedAt: now })
          .where(eq(s.product.id, live.id));
        await audit({
          branchId,
          action: 'menu_item.update',
          entityType: 'product',
          entityId: live.id,
          before: { code: seed.code, ...pick(live as ProductWanted, fields) },
          after: { code: seed.code, ...pick(wanted, fields) },
        });
      }
      continue;
    }
    if (archivedHere.has(seed.code)) {
      report.products.skippedArchived.push(seed.code);
      continue;
    }
    const id = write ? newId() : `pending:${seed.code}`;
    productIdByCode.set(seed.code, id);
    report.products.inserted.push(seed.code);
    const row = {
      id,
      operatorId,
      branchId,
      code: seed.code,
      ...wanted,
      active: seed.active,
    };
    inserts.push(row);
    insertAudits.push({
      branchId,
      action: 'menu_item.create',
      entityType: 'product',
      entityId: id,
      before: null,
      after: { code: seed.code, ...wanted, active: seed.active },
    });
  }
  if (write && inserts.length > 0) {
    await db.insert(s.product).values(inserts);
    for (const a of insertAudits) await audit(a);
  }

  // --- Inline modifier groups ---------------------------------------------------
  const knownIds = [...productIdByCode.values()].filter((id) => !id.startsWith('pending:'));
  const liveGroups = knownIds.length
    ? await db
        .select()
        .from(s.modifierGroup)
        .where(
          and(
            eq(s.modifierGroup.operatorId, operatorId),
            inArray(s.modifierGroup.productId, knownIds),
            isNull(s.modifierGroup.archivedAt),
          ),
        )
    : [];
  const liveOptions = liveGroups.length
    ? await db
        .select()
        .from(s.modifierOption)
        .where(
          and(
            inArray(
              s.modifierOption.modifierGroupId,
              liveGroups.map((g) => g.id),
            ),
            isNull(s.modifierOption.archivedAt),
          ),
        )
    : [];

  const history = await loaderGroupHistory(
    db,
    operatorId,
    liveGroups.map((g) => g.id),
  );

  for (const seed of seeds) {
    const productId = productIdByCode.get(seed.code);
    if (!productId) continue;
    // A group of this product the data no longer names: archived when this
    // loader created it (a rename in the data), left alone when it did not.
    const named = new Set(seed.groups.map((g) => g.name));
    for (const stale of liveGroups.filter((g) => g.productId === productId && !named.has(g.name))) {
      const label = `${seed.code} ${stale.name}`;
      if (!history.get(stale.id)?.created) {
        report.groups.leftAlone.push(label);
        continue;
      }
      report.groups.archived.push(label);
      const staleOptions = liveOptions.filter((o) => o.modifierGroupId === stale.id);
      if (write) {
        await db
          .update(s.modifierGroup)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(s.modifierGroup.id, stale.id));
        await db
          .update(s.modifierOption)
          .set({ archivedAt: now, updatedAt: now })
          .where(and(eq(s.modifierOption.modifierGroupId, stale.id), isNull(s.modifierOption.archivedAt)));
        await audit({
          branchId,
          action: 'modifier_group.archive',
          entityType: 'modifier_group',
          entityId: stale.id,
          before: {
            productCode: seed.code,
            name: stale.name,
            required: stale.required,
            selectionType: stale.selectionType,
            sortOrder: stale.sortOrder,
            options: staleOptions.map((o) => ({ name: o.name, priceSatang: o.priceSatang })),
          },
          after: null,
        });
      }
    }
    for (const [sortOrder, group] of seed.groups.entries()) {
      const existing = liveGroups.find((g) => g.productId === productId && g.name === group.name);
      if (!existing) {
        report.groups.created += 1;
        if (write) await createGroup(db, operatorId, productId, group, sortOrder, audit, branchId, seed.code);
        continue;
      }
      const options = liveOptions.filter((o) => o.modifierGroupId === existing.id);
      const changed = await convergeGroup(db, write, existing, options, group, sortOrder, now, {
        label: `${seed.code} ${group.name}`,
        written: history.get(existing.id)?.optionNames ?? new Set<string>(),
        archived: report.groups.optionsArchived,
        leftAlone: report.groups.leftAlone,
      });
      if (!changed) {
        report.groups.unchanged += 1;
        continue;
      }
      report.groups.updated += 1;
      await audit({
        branchId,
        action: 'modifier_group.update',
        entityType: 'modifier_group',
        entityId: existing.id,
        before: changed.before,
        after: { productCode: seed.code, ...changed.after },
      });
    }
  }

  // --- Demo retirement ------------------------------------------------------------
  const liveHere = await db
    .select({
      id: s.product.id,
      code: s.product.code,
      name: s.product.name,
      active: s.product.active,
      priceSatang: s.product.priceSatang,
      stockItemId: s.product.stockItemId,
    })
    .from(s.product)
    .where(and(eq(s.product.operatorId, operatorId), eq(s.product.branchId, branchId), isNull(s.product.archivedAt)));
  const ours = new Set(seedCodes);
  const archivedIds: string[] = [];
  if (opts.retireDemo) {
    const demo = new Set(DEMO_PRODUCT_CODES);
    const candidates = liveHere.filter((row) => row.code && demo.has(row.code) && !ours.has(row.code));
    // The stock items each candidate is linked to, both ways: a live
    // stock_item.product_id, and the product's own stock_item_id marker.
    const stockOf = new Map<string, Set<string>>();
    for (const row of candidates) {
      if (row.stockItemId) stockOf.set(row.id, new Set([row.stockItemId]));
    }
    const candidateIds = candidates.map((row) => row.id);
    if (candidateIds.length > 0) {
      const linked = await db
        .select({ id: s.stockItem.id, productId: s.stockItem.productId })
        .from(s.stockItem)
        .where(and(inArray(s.stockItem.productId, candidateIds), isNull(s.stockItem.archivedAt)));
      for (const link of linked) {
        const set = stockOf.get(link.productId!) ?? new Set<string>();
        set.add(link.id);
        stockOf.set(link.productId!, set);
      }
    }
    for (const row of candidates) {
      const code = row.code!;
      const kept = DEMO_CODES_KEPT[code];
      if (kept) {
        report.retire.kept.push({ code, reason: kept });
        continue;
      }
      const stockCount = stockOf.get(row.id)?.size ?? 0;
      if (stockCount > 0 && !opts.retireStockLinked) {
        report.retire.kept.push({
          code,
          reason: `stock-linked (${stockCount} stock item${stockCount === 1 ? '' : 's'}); --retire-stock-linked archives it`,
        });
        continue;
      }
      report.retire.archived.push(code);
      archivedIds.push(row.id);
      if (write) {
        await db
          .update(s.product)
          .set({ archivedAt: now, active: false, updatedAt: now })
          .where(eq(s.product.id, row.id));
        await audit({
          branchId,
          action: 'menu_item.archive',
          entityType: 'product',
          entityId: row.id,
          before: { code: row.code, name: row.name, active: row.active, priceSatang: row.priceSatang },
          after: null,
        });
      }
    }
    if (archivedIds.length > 0) {
      const codeOf = new Map(liveHere.map((r) => [r.id, r.code ?? '(no code)']));
      const discounts = await db
        .select({ code: s.discountDefinition.code, freeProductId: s.discountDefinition.freeProductId })
        .from(s.discountDefinition)
        .where(
          and(
            eq(s.discountDefinition.operatorId, operatorId),
            isNull(s.discountDefinition.archivedAt),
            inArray(s.discountDefinition.freeProductId, archivedIds),
          ),
        );
      for (const d of discounts) {
        report.warnings.push(`discount ${d.code} gives away ${codeOf.get(d.freeProductId!)}, which is archived`);
      }
      // Only with retireStockLinked: the stock items themselves are never touched.
      const stockIds = new Set<string>();
      const stockCodes: string[] = [];
      for (const id of archivedIds) {
        const linked = stockOf.get(id);
        if (!linked || linked.size === 0) continue;
        stockCodes.push(codeOf.get(id)!);
        for (const stockId of linked) stockIds.add(stockId);
      }
      if (stockIds.size > 0) {
        report.warnings.push(
          `${stockIds.size} stock items stay as they are, linked to archived ${stockCodes.sort().join(', ')}`,
        );
      }
    }
  }

  // --- What else is live here -------------------------------------------------------
  const prefix = `${PARK_CODE_PREFIX[park]}-`;
  const demoAll = new Set(DEMO_PRODUCT_CODES);
  for (const row of liveHere) {
    if (archivedIds.includes(row.id)) continue;
    if (!row.code) {
      report.untouched.codeless += 1;
      continue;
    }
    if (ours.has(row.code)) continue;
    if (row.code.startsWith(prefix)) report.stale.push(row.code);
    else if (demoAll.has(row.code)) report.demoLive.push(row.code);
    else report.untouched.codes.push(row.code);
  }
  report.demoLive.sort();
  report.untouched.codes.sort();
  report.stale.sort();
  return report;
}

async function createGroup(
  db: Exec,
  operatorId: string,
  productId: string,
  group: GroupSeed,
  sortOrder: number,
  audit: (row: {
    branchId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before: unknown;
    after: unknown;
  }) => Promise<void>,
  branchId: string,
  productCode: string,
): Promise<void> {
  const id = newId();
  const values = {
    id,
    operatorId,
    productId,
    name: group.name,
    required: group.required,
    selectionType: group.selectionType,
    minSelect: null,
    maxSelect: null,
    sortOrder,
  };
  await db.insert(s.modifierGroup).values(values);
  await db.insert(s.modifierOption).values(
    group.options.map((o, optionIndex) => ({
      id: newId(),
      operatorId,
      modifierGroupId: id,
      name: o.name,
      priceSatang: o.priceSatang,
      priceWeekendSatang: null,
      sortOrder: optionIndex,
    })),
  );
  await audit({
    branchId,
    action: 'modifier_group.create',
    entityType: 'modifier_group',
    entityId: id,
    before: null,
    after: {
      productCode,
      name: group.name,
      required: group.required,
      selectionType: group.selectionType,
      sortOrder,
      options: group.options,
    },
  });
}

/**
 * What this loader has written to each of these modifier groups, read back from
 * its own audit rows (request id `seed:real-catalog`): whether it created the
 * group, and every option name it wrote there (the create's `options`, and each
 * update's non-null `option:<name>` entry). A group or option missing from this
 * was added somewhere else, the Console most likely, and is never archived.
 */
async function loaderGroupHistory(
  db: Exec,
  operatorId: string,
  groupIds: string[],
): Promise<Map<string, { created: boolean; optionNames: Set<string> }>> {
  const out = new Map<string, { created: boolean; optionNames: Set<string> }>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ entityId: s.auditLog.entityId, action: s.auditLog.action, after: s.auditLog.after })
    .from(s.auditLog)
    .where(
      and(
        eq(s.auditLog.entityType, 'modifier_group'),
        inArray(s.auditLog.entityId, groupIds),
        eq(s.auditLog.operatorId, operatorId),
        eq(s.auditLog.requestId, REAL_CATALOG_REQUEST_ID),
        inArray(s.auditLog.action, ['modifier_group.create', 'modifier_group.update']),
      ),
    );
  for (const row of rows) {
    const entry = out.get(row.entityId) ?? { created: false, optionNames: new Set<string>() };
    out.set(row.entityId, entry);
    const after = (row.after ?? {}) as Record<string, unknown>;
    if (row.action === 'modifier_group.create') {
      entry.created = true;
      const options = Array.isArray(after.options) ? (after.options as Array<{ name?: unknown }>) : [];
      for (const o of options) if (typeof o.name === 'string') entry.optionNames.add(o.name);
      continue;
    }
    for (const [key, value] of Object.entries(after)) {
      if (key.startsWith('option:') && value !== null) entry.optionNames.add(key.slice('option:'.length));
    }
  }
  return out;
}

/**
 * Bring one live inline group and its live options to the data. An option the
 * data does not name is archived when this loader wrote it (`notes.written`: a
 * renamed or dropped option) and left alone when it did not (a park may have
 * added one in the Console). Returns null when nothing differs.
 */
async function convergeGroup(
  db: Exec,
  write: boolean,
  existing: typeof s.modifierGroup.$inferSelect,
  options: (typeof s.modifierOption.$inferSelect)[],
  group: GroupSeed,
  sortOrder: number,
  now: Date,
  notes: { label: string; written: ReadonlySet<string>; archived: string[]; leftAlone: string[] },
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const named = new Set(group.options.map((o) => o.name));
  for (const row of options) {
    if (named.has(row.name)) continue;
    if (!notes.written.has(row.name)) {
      notes.leftAlone.push(`${notes.label}: ${row.name}`);
      continue;
    }
    notes.archived.push(`${notes.label}: ${row.name}`);
    before[`option:${row.name}`] = { priceSatang: row.priceSatang, sortOrder: row.sortOrder };
    after[`option:${row.name}`] = null;
    if (write) {
      await db
        .update(s.modifierOption)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(s.modifierOption.id, row.id));
    }
  }
  const wantedGroup = {
    required: group.required,
    selectionType: group.selectionType,
    minSelect: null,
    maxSelect: null,
    sortOrder,
  };
  const groupFields = changedFields(existing, { ...existing, ...wantedGroup }, [
    'required',
    'selectionType',
    'minSelect',
    'maxSelect',
    'sortOrder',
  ]);
  if (groupFields.length > 0) {
    Object.assign(before, pick(existing, groupFields));
    Object.assign(after, pick({ ...existing, ...wantedGroup }, groupFields));
    if (write) {
      await db
        .update(s.modifierGroup)
        .set({ ...wantedGroup, updatedAt: now })
        .where(eq(s.modifierGroup.id, existing.id));
    }
  }
  for (const [optionIndex, option] of group.options.entries()) {
    const wanted = { priceSatang: option.priceSatang, priceWeekendSatang: null, sortOrder: optionIndex };
    const row = options.find((o) => o.name === option.name);
    if (!row) {
      before[`option:${option.name}`] = null;
      after[`option:${option.name}`] = wanted;
      if (write) {
        await db.insert(s.modifierOption).values({
          id: newId(),
          operatorId: existing.operatorId,
          modifierGroupId: existing.id,
          name: option.name,
          ...wanted,
        });
      }
      continue;
    }
    const fields = changedFields(row, { ...row, ...wanted }, ['priceSatang', 'priceWeekendSatang', 'sortOrder']);
    if (fields.length === 0) continue;
    before[`option:${option.name}`] = pick(row, fields);
    after[`option:${option.name}`] = pick({ ...row, ...wanted }, fields);
    if (write) {
      await db
        .update(s.modifierOption)
        .set({ ...wanted, updatedAt: now })
        .where(eq(s.modifierOption.id, row.id));
    }
  }
  return Object.keys(after).length > 0 ? { before, after } : null;
}
