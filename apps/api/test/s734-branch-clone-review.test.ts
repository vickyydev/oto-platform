import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  benefitRoleTemplate, boothConfigVersion, boothLayout, boothPrize, boothSettings,
  branch, confirmationItem, discountDefinition, dropOffPricing, modifierGroup,
  modifierOption, paymentMethod, product, station, stockItem, stockLevel,
  stockLocation, stockMovement, stockUnit, supervisionPolicy,
} from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, CENTRAL_BRANCH_CODE, branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-734 adversarial review. HIGH: a copied branch must retain its safety
 * policy and stock tracking without pointing at another branch's shelves.
 * Fix by copying definitions and mapping every dependent identity together;
 * never copy quantities, revive retired target choices or mint booth drafts
 * without a target station and a published version.
 */
let ctx: TestContext;
let cookie: string;
let operatorId: string;
let centralId: string;
let ordinal = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  centralId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  operatorId = (await ctx.db.select().from(branch).where(eq(branch.id, centralId)))[0]!.operatorId;
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function emptyBranch() {
  const id = newId(); ordinal += 1;
  await ctx.db.insert(branch).values({ id, operatorId, name: `ZZ TEST SCRUM-734 branch ${ordinal}`, code: `Z734-${ordinal}`, timezone: 'Asia/Bangkok', country: 'TH' });
  return id;
}
const clone = (target: string, source: string) => ctx.app.inject({ method: 'POST', url: `/branches/${target}/clone`, headers: { cookie }, payload: { sourceBranchId: source } });
const preview = (target: string, source: string) => ctx.app.inject({ method: 'GET', url: `/branches/${target}/clone-preview?from=${source}`, headers: { cookie } });
const contents = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'operatorId', 'branchId', 'createdAt', 'updatedAt'].includes(key)));

async function sourceFixture() {
  const id = await emptyBranch();
  await ctx.db.insert(supervisionPolicy).values({
    id: newId(), operatorId, branchId: id,
    bands: [{ id: 'zz-young', label: 'ZZ TEST young', minAge: 0, maxAge: 6, requirement: 'nanny' }, { id: 'zz-older', label: 'ZZ TEST older', minAge: 7, maxAge: null, requirement: 'none' }],
    siblingWaiverEnabled: false, waivableRequirement: 'drop_off', guardianMinAge: 12,
    waiverStaffOnly: true, nannyRatioSoftMax: 4, photoRetentionDays: 21, nannyMatchText: 'ZZ TEST nanny',
  });
  await ctx.db.insert(confirmationItem).values([
    { id: newId(), operatorId, branchId: id, code: 'zz-a', text: 'ZZ TEST required confirmation', required: true, sortOrder: 2 },
    { id: newId(), operatorId, branchId: id, code: 'zz-b', text: 'ZZ TEST optional confirmation', required: false, sortOrder: 7 },
    { id: newId(), operatorId, branchId: id, code: 'zz-old', text: 'ZZ TEST retired confirmation', archivedAt: new Date() },
  ]);
  await ctx.db.insert(dropOffPricing).values({
    id: newId(), operatorId, branchId: id, oneTimeFeeWeekdaySatang: 12300, oneTimeFeeWeekendSatang: 23400,
    nannyHourlyWeekdaySatang: 34500, nannyHourlyWeekendSatang: 45600, extraHourWeekdaySatang: 6700,
    extraHourWeekendSatang: 7800, fullDayHours: 7, prepaidFoodUnused: 'forfeit',
  });
  const shelf = newId();
  await ctx.db.insert(stockLocation).values({ id: shelf, operatorId, branchId: id, name: 'ZZ TEST counter shelf', type: 'rotation', sellPoint: true });
  const cup = newId(), sizes = newId(), shared = newId(), barcoded = newId();
  await ctx.db.insert(product).values([
    { id: cup, operatorId, branchId: id, name: 'ZZ TEST cup', kind: 'menu', priceSatang: 100 },
    { id: sizes, operatorId, branchId: id, name: 'ZZ TEST sizes', kind: 'merch', priceSatang: 200, variants: [{ id: 's', label: 'S' }, { id: 'l', label: 'L' }] },
    { id: shared, operatorId, branchId: null, name: `ZZ TEST shared ${ordinal}`, kind: 'menu', priceSatang: 300 },
    { id: barcoded, operatorId, branchId: id, name: 'ZZ TEST printed barcode', kind: 'merch', priceSatang: 400, sku: `885734${String(ordinal).padStart(7, '0')}` },
  ]);
  const cupStock = newId(), small = newId(), large = newId(), loose = newId(), sharedStock = newId(), blockedStock = newId();
  const sizeGroup = newId();
  const base = { operatorId, branchId: id, unitCostSatang: 12, lowStockThreshold: 3, reorderPoint: 4, reorderQuantity: 12, leadTimeDays: 2, supplierName: 'ZZ TEST supplier', supplierContact: 'ZZ TEST contact', parByLocation: { [shelf]: 5 } };
  await ctx.db.insert(stockItem).values([
    { ...base, id: cupStock, name: 'ZZ TEST cup stock', productId: cup, payload: { groupId: newId(), itemSku: 'ZZ-CUP', photoUrl: '/zz-cup.png', showPhotoInPos: true } },
    { ...base, id: small, name: 'ZZ TEST size stock', productId: sizes, variantId: 's', variantLabel: 'S', payload: { groupId: sizeGroup, itemSku: 'ZZ-SIZE' } },
    { ...base, id: large, name: 'ZZ TEST size stock', productId: sizes, variantId: 'l', variantLabel: 'L', payload: { groupId: sizeGroup, itemSku: 'ZZ-SIZE' } },
    { ...base, id: loose, name: 'ZZ TEST loose stock', variantLabel: 'Each', payload: { groupId: newId() } },
    { ...base, id: sharedStock, name: 'ZZ TEST shared stock', productId: shared },
    { ...base, id: blockedStock, name: 'ZZ TEST barcode stock', productId: barcoded },
  ]);
  for (const [productId, stockItemId] of [[cup, cupStock], [sizes, small], [shared, sharedStock], [barcoded, blockedStock]]) {
    await ctx.db.update(product).set({ stockItemId }).where(eq(product.id, productId!));
  }
  await ctx.db.insert(stockUnit).values([cupStock, small, large].map(stockItemId => ({ id: newId(), operatorId, stockItemId, code: 'case', label: 'ZZ TEST case of 12', eaches: 12 })));
  // A source quantity must never become an opening quantity on the copy.
  await ctx.db.insert(stockLevel).values({ id: newId(), stockLocationId: shelf, stockItemId: cupStock, quantity: 17 });
  const group = newId();
  await ctx.db.insert(modifierGroup).values({ id: group, operatorId, productId: cup, name: 'ZZ TEST cup option' });
  await ctx.db.insert(modifierOption).values({ id: newId(), operatorId, modifierGroupId: group, name: 'ZZ TEST extra', priceSatang: 10 });
  await ctx.db.insert(discountDefinition).values({ id: newId(), operatorId, branchId: id, code: `ZZ734-${ordinal}`, label: 'ZZ TEST cup discount', kind: 'percent', valueBp: 1000, target: { kind: 'menuItems', menuItemIds: [cup] } });
  return { id, shelf, cup, sizes, shared, cupStock, small, large, loose, sizeGroup };
}

describe('SCRUM-734 branch configuration review', () => {
  it('HIGH: copies exact policy and price values, stock groups, packs and target-local links without a balance', async () => {
    const source = await sourceFixture(), target = await emptyBranch();
    const before = await ctx.db.select().from(stockItem).where(eq(stockItem.branchId, source.id));
    const proposed = await preview(target, source.id);
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().counts).toMatchObject({ supervisionPolicy: { created: 1 }, confirmationItems: { created: 2 }, dropOffPricing: { created: 1 }, stockItems: { created: 5, blocked: 1 }, stockUnits: { created: 3 } });
    const result = await clone(target, source.id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().counts).toEqual(proposed.json().counts);
    const [sourcePolicy] = await ctx.db.select().from(supervisionPolicy).where(eq(supervisionPolicy.branchId, source.id));
    const [targetPolicy] = await ctx.db.select().from(supervisionPolicy).where(eq(supervisionPolicy.branchId, target));
    expect(contents(targetPolicy!)).toEqual(contents(sourcePolicy!)); expect(targetPolicy!.id).not.toBe(sourcePolicy!.id);
    const [sourcePrices] = await ctx.db.select().from(dropOffPricing).where(eq(dropOffPricing.branchId, source.id));
    const [targetPrices] = await ctx.db.select().from(dropOffPricing).where(eq(dropOffPricing.branchId, target));
    expect(contents(targetPrices!)).toEqual(contents(sourcePrices!)); expect(targetPrices!.id).not.toBe(sourcePrices!.id);
    const confirmations = await ctx.db.select().from(confirmationItem).where(eq(confirmationItem.branchId, target));
    expect(confirmations.map(r => [r.code, r.text, r.required, r.sortOrder])).toEqual([
      ['zz-a', 'ZZ TEST required confirmation', true, 2], ['zz-b', 'ZZ TEST optional confirmation', false, 7],
    ]);
    const [shelf] = await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, target));
    const items = await ctx.db.select().from(stockItem).where(eq(stockItem.branchId, target));
    expect(items).toHaveLength(5);
    const sourceIds = new Set(before.map(r => r.id));
    for (const item of items) {
      expect(sourceIds.has(item.id)).toBe(false); expect(item.parByLocation).toEqual({ [shelf!.id]: 5 });
      expect(item).toMatchObject({ unitCostSatang: 12, lowStockThreshold: 3, reorderPoint: 4, reorderQuantity: 12, leadTimeDays: 2, supplierName: 'ZZ TEST supplier', supplierContact: 'ZZ TEST contact' });
    }
    const copiedSizes = items.filter(r => r.name === 'ZZ TEST size stock');
    expect(copiedSizes).toHaveLength(2);
    const groups = copiedSizes.map(r => (r.payload as { groupId: string }).groupId);
    expect(new Set(groups).size).toBe(1); expect(groups[0]).not.toBe(source.sizeGroup);
    const copiedProducts = await ctx.db.select().from(product).where(eq(product.branchId, target));
    const cup = copiedProducts.find(r => r.name === 'ZZ TEST cup')!;
    expect(cup.stockItemId).toBe(items.find(r => r.productId === cup.id)!.id);
    expect(items.find(r => r.name === 'ZZ TEST shared stock')!.productId).toBe(source.shared);
    const packs = await ctx.db.select().from(stockUnit).where(inArray(stockUnit.stockItemId, items.map(r => r.id)));
    expect(packs).toHaveLength(3); expect(packs.every(r => r.eaches === 12 && r.label === 'ZZ TEST case of 12')).toBe(true);
    expect(await ctx.db.select().from(stockLevel).where(eq(stockLevel.stockLocationId, shelf!.id))).toEqual([]);
    expect(await ctx.db.select().from(stockMovement).where(eq(stockMovement.branchId, target))).toEqual([]);
    expect(await ctx.db.select().from(stockItem).where(eq(stockItem.branchId, source.id))).toEqual(before);
    const repeated = await clone(target, source.id);
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.json().created).toBe(0);
    expect(await ctx.db.select().from(stockItem).where(eq(stockItem.branchId, target))).toEqual(items);
  });

  it('HIGH: keeps existing policy, prices and retired confirmations instead of overwriting or reviving them', async () => {
    const source = await sourceFixture(), target = await emptyBranch();
    const first = await clone(target, source.id); expect(first.statusCode, first.body).toBe(200);
    await ctx.db.update(supervisionPolicy).set({ guardianMinAge: 16, nannyRatioSoftMax: 8 }).where(eq(supervisionPolicy.branchId, target));
    await ctx.db.update(dropOffPricing).set({ oneTimeFeeWeekdaySatang: 999, prepaidFoodUnused: 'refund' }).where(eq(dropOffPricing.branchId, target));
    await ctx.db.update(confirmationItem).set({ archivedAt: new Date(), text: 'ZZ TEST locally retired wording' }).where(and(eq(confirmationItem.branchId, target), eq(confirmationItem.code, 'zz-a')));
    const snapshot = await ctx.db.select().from(confirmationItem).where(eq(confirmationItem.branchId, target));
    const repeated = await clone(target, source.id); expect(repeated.statusCode).toBe(200); expect(repeated.json().created).toBe(0);
    expect((await ctx.db.select().from(supervisionPolicy).where(eq(supervisionPolicy.branchId, target)))[0]).toMatchObject({ guardianMinAge: 16, nannyRatioSoftMax: 8 });
    expect((await ctx.db.select().from(dropOffPricing).where(eq(dropOffPricing.branchId, target)))[0]).toMatchObject({ oneTimeFeeWeekdaySatang: 999, prepaidFoodUnused: 'refund' });
    expect(await ctx.db.select().from(confirmationItem).where(eq(confirmationItem.branchId, target))).toEqual(snapshot);
  });

  it('HIGH: a retired target shelf blocks tracked products and their dependent rows instead of making them untracked', async () => {
    const source = await sourceFixture(), target = await emptyBranch();
    await ctx.db.insert(stockLocation).values({ id: newId(), operatorId, branchId: target, name: 'zz test counter shelf', type: 'rotation', archivedAt: new Date() });
    const result = await clone(target, source.id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().plan.products.blocked.some((r: { name: string }) => r.name === 'ZZ TEST cup')).toBe(true);
    expect(result.json().counts.stockItems.created).toBe(0);
    expect(result.json().counts.modifierGroups.created).toBe(0);
    expect(result.json().counts.discountCodes.blocked).toBe(1);
    expect(await ctx.db.select().from(product).where(eq(product.branchId, target))).toEqual([]);
    expect(await ctx.db.select().from(stockItem).where(eq(stockItem.branchId, target))).toEqual([]);
  });

  it('MEDIUM: keeps an existing target product without stock and never silently attaches the source stock to it', async () => {
    const source = await sourceFixture(), target = await emptyBranch(), existingId = newId();
    await ctx.db.insert(product).values({ id: existingId, operatorId, branchId: target, name: 'ZZ TEST cup', kind: 'menu', priceSatang: 777 });
    const before = await ctx.db.select().from(product).where(eq(product.id, existingId));
    const result = await clone(target, source.id); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().plan.stockItems.blocked.some((r: { reason: string }) => /inventory choice/.test(r.reason))).toBe(true);
    expect(await ctx.db.select().from(product).where(eq(product.id, existingId))).toEqual(before);
    expect(await ctx.db.select().from(stockItem).where(eq(stockItem.productId, existingId))).toEqual([]);
  });

  it('MEDIUM: stockroom matching uses the same case-insensitive name as its unique index', async () => {
    const source = await sourceFixture(), target = await emptyBranch(), shelf = newId();
    await ctx.db.insert(stockLocation).values({ id: shelf, operatorId, branchId: target, name: 'zz test counter shelf', type: 'rotation', sellPoint: true });
    const before = await ctx.db.select().from(stockLocation).where(eq(stockLocation.id, shelf));
    const result = await clone(target, source.id);
    // The original FINDING returned 409; the existing shelf now keeps its
    // identity and every copied minimum points at that target shelf.
    console.info(JSON.stringify({ check: 'stockroom-case', status: result.statusCode }));
    expect(result.statusCode).toBe(200);
    expect(result.json().counts.stockLocations.created).toBe(0);
    expect(await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, target))).toEqual(before);
    const items = await ctx.db.select().from(stockItem).where(eq(stockItem.branchId, target));
    expect(items).toHaveLength(5);
    expect(items.every(row => JSON.stringify(row.parByLocation) === JSON.stringify({ [shelf]: 5 }))).toBe(true);
  });

  it('HIGH: a failed stock insert rolls the whole configuration copy back', async () => {
    const source = await sourceFixture(), target = await emptyBranch();
    await ctx.db.execute(sql.raw(`CREATE FUNCTION pos.zz734_refuse_stock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.branch_id = '${target}'::uuid THEN RAISE EXCEPTION 'ZZ TEST refused stock insert'; END IF; RETURN NEW; END $$; CREATE TRIGGER zz734_refuse_stock BEFORE INSERT ON pos.stock_item FOR EACH ROW EXECUTE FUNCTION pos.zz734_refuse_stock();`));
    try {
      const result = await clone(target, source.id); expect(result.statusCode).toBe(500);
      expect(await ctx.db.select().from(product).where(eq(product.branchId, target))).toEqual([]);
      expect(await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, target))).toEqual([]);
      expect(await ctx.db.select().from(supervisionPolicy).where(eq(supervisionPolicy.branchId, target))).toEqual([]);
      expect(await ctx.db.select().from(confirmationItem).where(eq(confirmationItem.branchId, target))).toEqual([]);
      expect(await ctx.db.select().from(dropOffPricing).where(eq(dropOffPricing.branchId, target))).toEqual([]);
    } finally { await ctx.db.execute(sql.raw('DROP TRIGGER zz734_refuse_stock ON pos.stock_item; DROP FUNCTION pos.zz734_refuse_stock();')); }
  });

  it('HIGH: creates no station-bound booth draft or version and duplicates no shared operator configuration', async () => {
    const target = await emptyBranch();
    const before = {
      settings: await ctx.db.select().from(boothSettings), prizes: await ctx.db.select().from(boothPrize), versions: await ctx.db.select().from(boothConfigVersion),
      layouts: await ctx.db.select().from(boothLayout), methods: await ctx.db.select().from(paymentMethod), benefits: await ctx.db.select().from(benefitRoleTemplate),
    };
    expect(before.settings.length).toBeGreaterThan(0); expect(before.versions.length).toBeGreaterThan(0);
    const result = await clone(target, centralId); expect(result.statusCode, result.body).toBe(200);
    expect(await ctx.db.select().from(station).where(eq(station.branchId, target))).toEqual([]);
    expect({ settings: await ctx.db.select().from(boothSettings), prizes: await ctx.db.select().from(boothPrize), versions: await ctx.db.select().from(boothConfigVersion), layouts: await ctx.db.select().from(boothLayout), methods: await ctx.db.select().from(paymentMethod), benefits: await ctx.db.select().from(benefitRoleTemplate) }).toEqual(before);
    const proposed = await preview(target, centralId);
    expect(proposed.json().shared).toEqual(expect.arrayContaining(['payment methods', 'staff benefit role templates', 'wheel layouts']));
    expect(proposed.json().shared).not.toContain('stock items');
  });
});
