import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { seedMenu } from '../src/seed/menu';
import { seedStock } from '../src/seed/stock';
import {
  buildParkCatalog,
  DEMO_CODES_KEPT,
  REAL_CATALOG_REQUEST_ID,
  REAL_CATEGORIES,
  seedRealCatalog,
} from '../src/seed/real-catalog/index';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * The real catalogue loader (2026-11-09) against a real database: a dry run
 * writes nothing, the first run writes the park's catalogue, the second changes
 * nothing, a corrected price reaches the row, one park never touches the other,
 * and the demo retirement archives only that branch's demo products.
 */

let db: Db;
let close: () => Promise<void>;
let operatorId: string;
let central: string;
let chalong: string;
let otherOperator: string;
let otherBranch: string;

async function branch(op: string, code: string): Promise<string> {
  const id = newId();
  await db.insert(s.branch).values({ id, operatorId: op, name: code, code, timezone: 'Asia/Bangkok' });
  return id;
}

/** Every product of a branch exactly as stored, updated_at included. */
async function productsOf(branchId: string) {
  return db.select().from(s.product).where(eq(s.product.branchId, branchId)).orderBy(asc(s.product.id));
}

async function groupsOf(productIds: string[]) {
  if (productIds.length === 0) return { groups: [], options: [] };
  const groups = await db.select().from(s.modifierGroup).where(inArray(s.modifierGroup.productId, productIds)).orderBy(asc(s.modifierGroup.id));
  const options = groups.length
    ? await db.select().from(s.modifierOption).where(inArray(s.modifierOption.modifierGroupId, groups.map((g) => g.id))).orderBy(asc(s.modifierOption.id))
    : [];
  return { groups, options };
}

/** A product's live inline groups, in order, each with its live option names in order. */
async function liveGroupsOf(code: string) {
  const [row] = await db.select().from(s.product).where(and(eq(s.product.code, code), isNull(s.product.archivedAt)));
  const groups = await db
    .select()
    .from(s.modifierGroup)
    .where(and(eq(s.modifierGroup.productId, row!.id), isNull(s.modifierGroup.archivedAt)))
    .orderBy(asc(s.modifierGroup.sortOrder));
  const out: Array<{ name: string; required: boolean; options: string[] }> = [];
  for (const g of groups) {
    const options = await db
      .select()
      .from(s.modifierOption)
      .where(and(eq(s.modifierOption.modifierGroupId, g.id), isNull(s.modifierOption.archivedAt)))
      .orderBy(asc(s.modifierOption.sortOrder));
    out.push({ name: g.name, required: g.required, options: options.map((o) => o.name) });
  }
  return out;
}

/** The demo products `seedStock` links to stock at Central (AO-* are kept for their own reason). */
const STOCK_LINKED_DEMO = [
  'FB-SLUSHIE', 'FB-WATER', 'MR-BOTTLE', 'MR-CAP', 'MR-KEYRING',
  'MR-LANYARD', 'MR-PLUSH', 'MR-SOCKS', 'MR-STICKERS', 'MR-TSHIRT',
];

async function count(table: 'product' | 'product_category' | 'audit_log' | 'ticket_package' | 'stock_item'): Promise<number> {
  const schemaName = table === 'audit_log' ? 'core' : 'pos';
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${schemaName}.${table}`));
  return r.rows[0]!.n;
}

beforeAll(async () => {
  const { url, drop } = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  db = drizzle(pool, { schema }) as Db;
  close = async () => {
    await pool.end();
    await drop();
  };
  operatorId = newId();
  await db.insert(s.operator).values({ id: operatorId, name: 'OTO' });
  central = await branch(operatorId, 'hkt-central');
  chalong = await branch(operatorId, 'robinson-chalong');
  otherOperator = newId();
  await db.insert(s.operator).values({ id: otherOperator, name: 'Second Operator' });
  otherBranch = await branch(otherOperator, 'second-operator-1');
  // Staging's shape: the demo menu and its stock at Central, a ticket package
  // at each park, nothing on the second operator but its own demo menu.
  await seedMenu(db, { operatorId, branchId: central });
  await seedStock(db, { operatorId, branchId: central });
  await seedMenu(db, { operatorId: otherOperator, branchId: otherBranch });
  for (const branchId of [central, chalong]) {
    await db.insert(s.ticketPackage).values({
      id: newId(),
      operatorId,
      branchId,
      name: '1 Hour Play',
      durationLabel: '1 Hour',
      hours: 1,
      prices: { tourist: { weekday: 69000, weekend: 69000 } },
    });
  }
}, 240_000);

afterAll(async () => {
  await close?.();
  await stopTestServer();
});

describe('seedRealCatalog', () => {
  const catalog = buildParkCatalog('central');

  it('writes nothing on a dry run, and plans the whole catalogue', async () => {
    const before = await Promise.all([count('product'), count('product_category'), count('audit_log')]);
    const plan = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', apply: false, retireDemo: true });
    expect(await Promise.all([count('product'), count('product_category'), count('audit_log')])).toEqual(before);
    expect(plan.applied).toBe(false);
    expect(plan.categories.created).toHaveLength(REAL_CATEGORIES.length);
    expect(plan.products.inserted).toHaveLength(catalog.products.length);
    expect(plan.products.updated).toEqual([]);
    expect(plan.retire.archived.length).toBeGreaterThan(0);
  });

  it('writes the park catalogue on the first run, with an audit row for each write', async () => {
    const auditBefore = await count('audit_log');
    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(r.categories.created).toHaveLength(27);
    expect(r.products.inserted).toHaveLength(catalog.products.length);
    const groupCount = catalog.products.reduce((n, p) => n + p.groups.length, 0);
    expect(r.groups.created).toBe(groupCount);
    expect(r.products.conflicts).toEqual([]);

    const margherita = await db.select().from(s.product).where(and(eq(s.product.code, 'CF-24'), isNull(s.product.archivedAt)));
    expect(margherita).toHaveLength(1);
    expect(margherita[0]).toMatchObject({ branchId: central, name: 'Margherita', priceSatang: 40000, priceWeekendSatang: null, kind: 'menu', active: true });
    const [pizza] = await db.select().from(s.productCategory).where(eq(s.productCategory.id, margherita[0]!.categoryId!));
    expect(pizza).toMatchObject({ code: 'CAT-PIZZA', name: 'Pizza', taxableCategory: 'fnb', defaultPrepStation: 'kitchen', parentId: null });

    const audits = await db.select().from(s.auditLog).where(eq(s.auditLog.requestId, REAL_CATALOG_REQUEST_ID));
    expect(audits).toHaveLength(27 + catalog.products.length + groupCount);
    expect(await count('audit_log')).toBe(auditBefore + audits.length);
  });

  it('changes nothing on a second run', async () => {
    const products = await productsOf(central);
    const mods = await groupsOf(products.map((p) => p.id));
    const cats = await db.select().from(s.productCategory).orderBy(asc(s.productCategory.id));
    const audits = await count('audit_log');

    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(r.categories.created).toEqual([]);
    expect(r.categories.updated).toEqual([]);
    expect(r.products.inserted).toEqual([]);
    expect(r.products.updated).toEqual([]);
    expect(r.products.unchanged).toHaveLength(catalog.products.length);
    expect(r.groups).toMatchObject({ created: 0, updated: 0 });

    expect(await productsOf(central)).toEqual(products);
    expect(await groupsOf(products.map((p) => p.id))).toEqual(mods);
    expect(await db.select().from(s.productCategory).orderBy(asc(s.productCategory.id))).toEqual(cats);
    expect(await count('audit_log')).toBe(audits);
  });

  it('puts a price changed by hand back to the data, option prices included', async () => {
    await db.update(s.product).set({ priceSatang: 100, name: 'Margarita' }).where(eq(s.product.code, 'CF-24'));
    const [krapao] = await db.select().from(s.product).where(eq(s.product.code, 'CF-41'));
    const [addOn] = await db.select().from(s.modifierGroup).where(and(eq(s.modifierGroup.productId, krapao!.id), eq(s.modifierGroup.name, 'Add on')));
    await db.update(s.modifierOption).set({ priceSatang: 1 }).where(eq(s.modifierOption.modifierGroupId, addOn!.id));

    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(r.products.updated).toEqual(['CF-24']);
    expect(r.groups.updated).toBe(1);
    const [row] = await db.select().from(s.product).where(eq(s.product.code, 'CF-24'));
    expect(row).toMatchObject({ priceSatang: 40000, name: 'Margherita' });
    const [option] = await db.select().from(s.modifierOption).where(eq(s.modifierOption.modifierGroupId, addOn!.id));
    expect(option).toMatchObject({ name: 'Fried egg', priceSatang: 5000 });
  });

  it('carries a corrected price in the data to the row', async () => {
    const corrected = catalog.products.map((p) => (p.code === 'CF-24' ? { ...p, priceSatang: 41000 } : p));
    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', products: corrected });
    expect(r.products.updated).toEqual(['CF-24']);
    expect((await db.select().from(s.product).where(eq(s.product.code, 'CF-24')))[0]!.priceSatang).toBe(41000);
    const back = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(back.products.updated).toEqual(['CF-24']);
    expect((await db.select().from(s.product).where(eq(s.product.code, 'CF-24')))[0]!.priceSatang).toBe(40000);
  });

  it('leaves an archived item of ours archived, and keeps a Console switch of active', async () => {
    const now = new Date();
    await db.update(s.product).set({ archivedAt: now }).where(eq(s.product.code, 'CF-71'));
    await db.update(s.product).set({ active: false }).where(eq(s.product.code, 'CF-56'));
    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(r.products.skippedArchived).toEqual(['CF-71']);
    expect(r.products.inserted).toEqual([]);
    expect(r.products.updated).toEqual([]);
    const beer = await db.select().from(s.product).where(eq(s.product.code, 'CF-71'));
    expect(beer).toHaveLength(1);
    expect((await db.select().from(s.product).where(eq(s.product.code, 'CF-56')))[0]!.active).toBe(false);
    await db.update(s.product).set({ archivedAt: null }).where(eq(s.product.code, 'CF-71'));
    await db.update(s.product).set({ active: true }).where(eq(s.product.code, 'CF-56'));
  });

  it('archives a group of ours the data renames, instead of leaving it live beside the new one', async () => {
    const renamed = catalog.products.map((p) =>
      p.code === 'CF-47' ? { ...p, groups: p.groups.map((g) => ({ ...g, name: 'Meat' })) } : p,
    );
    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', products: renamed });
    expect(r.groups).toMatchObject({ created: 1, updated: 0, archived: ['CF-47 Choice'], optionsArchived: [], leftAlone: [] });
    expect(await liveGroupsOf('CF-47')).toEqual([{ name: 'Meat', required: true, options: ['Pork', 'Beef'] }]);

    const [gyoza] = await db.select().from(s.product).where(eq(s.product.code, 'CF-47'));
    const [old] = await db
      .select()
      .from(s.modifierGroup)
      .where(and(eq(s.modifierGroup.productId, gyoza!.id), eq(s.modifierGroup.name, 'Choice')));
    expect(old!.archivedAt).not.toBeNull();
    const oldOptions = await db.select().from(s.modifierOption).where(eq(s.modifierOption.modifierGroupId, old!.id));
    expect(oldOptions.every((o) => o.archivedAt !== null)).toBe(true);
    const [archiveAudit] = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entityId, old!.id), eq(s.auditLog.action, 'modifier_group.archive')));
    expect(archiveAudit).toMatchObject({ requestId: REAL_CATALOG_REQUEST_ID, actorAccountId: null, after: null });

    const back = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(back.groups).toMatchObject({ created: 1, updated: 0, archived: ['CF-47 Meat'], optionsArchived: [] });
    expect(await liveGroupsOf('CF-47')).toEqual([{ name: 'Choice', required: true, options: ['Pork', 'Beef'] }]);
    const again = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(again.groups).toMatchObject({ created: 0, updated: 0, archived: [], optionsArchived: [], leftAlone: [] });
  });

  it('archives an option of ours the data renames, and keeps the order', async () => {
    const renamed = catalog.products.map((p) =>
      p.code === 'CF-42'
        ? {
            ...p,
            groups: p.groups.map((g) => ({
              ...g,
              options: g.options.map((o) => (o.name === 'chicken' ? { ...o, name: 'Chicken' } : o)),
            })),
          }
        : p,
    );
    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', products: renamed });
    expect(r.groups).toMatchObject({
      created: 0,
      updated: 1,
      archived: [],
      optionsArchived: ['CF-42 Protein: chicken'],
      leftAlone: [],
    });
    expect(await liveGroupsOf('CF-42')).toEqual([{ name: 'Protein', required: true, options: ['Vegetarian', 'Chicken', 'shrimp'] }]);

    const back = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(back.groups).toMatchObject({ created: 0, updated: 1, optionsArchived: ['CF-42 Protein: Chicken'] });
    expect(await liveGroupsOf('CF-42')).toEqual([{ name: 'Protein', required: true, options: ['Vegetarian', 'chicken', 'shrimp'] }]);
    const again = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(again.groups).toMatchObject({ created: 0, updated: 0, archived: [], optionsArchived: [] });
  });

  it('leaves a group or an option added in the Console alone, and says so', async () => {
    const [gyoza] = await db.select().from(s.product).where(and(eq(s.product.code, 'CF-47'), isNull(s.product.archivedAt)));
    const spiceId = newId();
    await db.insert(s.modifierGroup).values({
      id: spiceId,
      operatorId,
      productId: gyoza!.id,
      name: 'Spice',
      required: false,
      selectionType: 'single',
      sortOrder: 5,
    });
    const hotId = newId();
    await db.insert(s.modifierOption).values({ id: hotId, operatorId, modifierGroupId: spiceId, name: 'Hot', priceSatang: 0, sortOrder: 0 });
    const [padThai] = await db.select().from(s.product).where(and(eq(s.product.code, 'CF-42'), isNull(s.product.archivedAt)));
    const [protein] = await db
      .select()
      .from(s.modifierGroup)
      .where(and(eq(s.modifierGroup.productId, padThai!.id), eq(s.modifierGroup.name, 'Protein'), isNull(s.modifierGroup.archivedAt)));
    const tofuId = newId();
    await db.insert(s.modifierOption).values({ id: tofuId, operatorId, modifierGroupId: protein!.id, name: 'Tofu', priceSatang: 0, sortOrder: 3 });

    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central' });
    expect(r.groups).toMatchObject({ created: 0, updated: 0, archived: [], optionsArchived: [] });
    expect([...r.groups.leftAlone].sort()).toEqual(['CF-42 Protein: Tofu', 'CF-47 Spice']);
    const [spice] = await db.select().from(s.modifierGroup).where(eq(s.modifierGroup.id, spiceId));
    expect(spice!.archivedAt).toBeNull();
    const [tofu] = await db.select().from(s.modifierOption).where(eq(s.modifierOption.id, tofuId));
    expect(tofu!.archivedAt).toBeNull();

    // Back to the data's own state for the tests after this one.
    const now = new Date();
    await db.update(s.modifierOption).set({ archivedAt: now }).where(inArray(s.modifierOption.id, [hotId, tofuId]));
    await db.update(s.modifierGroup).set({ archivedAt: now }).where(eq(s.modifierGroup.id, spiceId));
  });

  it('loads Chalong without touching Central, and shares the categories', async () => {
    const centralBefore = await productsOf(central);
    const r = await seedRealCatalog(db, { operatorId, branchId: chalong, park: 'chalong' });
    expect(r.categories.created).toEqual([]);
    expect(r.categories.unchanged).toHaveLength(27);
    expect(r.products.inserted).toHaveLength(buildParkCatalog('chalong').products.length);
    expect(await productsOf(central)).toEqual(centralBefore);
    const [margherita] = await db.select().from(s.product).where(eq(s.product.code, 'RC-23'));
    expect(margherita).toMatchObject({ branchId: chalong, name: 'Margherita', priceSatang: 40000 });
    const again = await seedRealCatalog(db, { operatorId, branchId: chalong, park: 'chalong' });
    expect(again.products.inserted).toEqual([]);
    expect(again.products.updated).toEqual([]);
  });

  it('retires only this branch\'s demo products, never what the system looks up by code', async () => {
    const packages = await db.select().from(s.ticketPackage).orderBy(asc(s.ticketPackage.id));
    const stock = await db.select().from(s.stockItem).orderBy(asc(s.stockItem.id));
    const chalongBefore = await productsOf(chalong);
    const otherBefore = await productsOf(otherBranch);

    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', retireDemo: true });
    expect(r.products.inserted).toEqual([]);
    expect(r.products.updated).toEqual([]);
    expect(r.retire.kept.map((k) => k.code).sort()).toEqual([...Object.keys(DEMO_CODES_KEPT), ...STOCK_LINKED_DEMO].sort());
    for (const k of r.retire.kept.filter((x) => STOCK_LINKED_DEMO.includes(x.code))) {
      expect(k.reason).toMatch(/^stock-linked \(\d+ stock items?\)/);
    }
    // The shop's grip socks in S, M and L, the seed's one barcode among them.
    expect(r.retire.kept.find((k) => k.code === 'MR-SOCKS')!.reason).toMatch(/^stock-linked \(3 stock items\)/);
    expect(r.retire.archived).toContain('FB-NUGGETS');
    expect(r.retire.archived).not.toContain('MR-TSHIRT');
    expect(r.retire.archived).not.toContain('AO-SOCKS');
    expect(r.retire.archived).toHaveLength(18);
    expect(r.warnings.some((w) => w.includes('ICECREAM'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('stock items stay'))).toBe(false);

    const live = await db.select({ code: s.product.code }).from(s.product).where(and(eq(s.product.branchId, central), isNull(s.product.archivedAt)));
    const liveCodes = live.map((x) => x.code!);
    for (const code of Object.keys(DEMO_CODES_KEPT)) expect(liveCodes).toContain(code);
    expect(liveCodes.filter((c) => c.startsWith('FB-') || c.startsWith('MR-')).sort()).toEqual(STOCK_LINKED_DEMO);
    const archivedNugget = await db.select().from(s.product).where(eq(s.product.code, 'FB-NUGGETS'));
    expect(archivedNugget.find((x) => x.branchId === central)).toMatchObject({ active: false });

    expect(await db.select().from(s.ticketPackage).orderBy(asc(s.ticketPackage.id))).toEqual(packages);
    expect(await db.select().from(s.stockItem).orderBy(asc(s.stockItem.id))).toEqual(stock);
    expect(await productsOf(chalong)).toEqual(chalongBefore);
    expect(await productsOf(otherBranch)).toEqual(otherBefore);

    const again = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', retireDemo: true });
    expect(again.retire.archived).toEqual([]);
  });

  it('archives the stock-linked demo products only when told to, and never touches their stock', async () => {
    const stock = await db.select().from(s.stockItem).orderBy(asc(s.stockItem.id));
    const plan = await seedRealCatalog(db, {
      operatorId,
      branchId: central,
      park: 'central',
      retireDemo: true,
      retireStockLinked: true,
      apply: false,
    });
    expect([...plan.retire.archived].sort()).toEqual(STOCK_LINKED_DEMO);

    const r = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', retireDemo: true, retireStockLinked: true });
    expect([...r.retire.archived].sort()).toEqual(STOCK_LINKED_DEMO);
    expect(r.retire.kept.map((k) => k.code).sort()).toEqual(Object.keys(DEMO_CODES_KEPT).sort());
    expect(r.warnings).toContain(`14 stock items stay as they are, linked to archived ${STOCK_LINKED_DEMO.join(', ')}`);
    expect(await db.select().from(s.stockItem).orderBy(asc(s.stockItem.id))).toEqual(stock);

    const again = await seedRealCatalog(db, { operatorId, branchId: central, park: 'central', retireDemo: true, retireStockLinked: true });
    expect(again.retire.archived).toEqual([]);
  });
});
