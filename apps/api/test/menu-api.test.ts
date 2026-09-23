import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, product, productModifierGroup } from '@oto/db';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-232 / SCRUM-204 — the menu has a backend.
 *
 * Every assertion here drives the real routes. Before this the menu screens
 * ran on a store in the browser and said so on the panel; there was no write
 * path to `product` anywhere in the api.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let outsider: string;
let branchId: string;
let otherBranchId: string;
/** Every item needs a category; the cases that are not about categories use this. */
let defaultCategoryId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  outsider = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  otherBranchId = await branchIdByCode(
    ctx.db,
    SECOND_OPERATOR_BRANCH_CODE,
    SECOND_OPERATOR_NAME,
  );

  const base = await call('POST', '/menu/categories', {
    cookie: admin,
    payload: { code: 'T-BASE', name: 'Base', taxableCategory: 'fnb', sortOrder: 20 },
  });
  defaultCategoryId = base.body.id as unknown as string;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
) => {
  const res = await ctx.app.inject({
    method,
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, never> };
};

const makeCategory = async (payload: Record<string, unknown>, cookie = admin) =>
  call('POST', '/menu/categories', { cookie, payload });

const makeItem = async (payload: Record<string, unknown>, cookie = admin) =>
  // An item belongs to a category, so a payload that says nothing about one
  // gets the shared fixture rather than repeating it on every case below.
  call('POST', `/branches/${branchId}/menu/products`, {
    cookie,
    payload: { categoryId: defaultCategoryId, ...payload },
  });

describe('categories are operator-wide and two levels deep', () => {
  let foodId: string;

  it('creates a top-level category and a sub-category under it', async () => {
    const food = await makeCategory({
      code: 'T-FOOD',
      name: 'Food',
      taxableCategory: 'fnb',
      defaultPrepStation: 'kitchen',
      sortOrder: 0,
    });
    expect(food.statusCode).toBe(200);
    foodId = food.body.id as unknown as string;

    const mains = await makeCategory({
      code: 'T-FOOD-MAINS',
      name: 'Mains',
      parentId: foodId,
      sortOrder: 0,
    });
    expect(mains.statusCode).toBe(200);
  });

  it('refuses a third level, which is the prototype’s own rule', async () => {
    const mains = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const sub = (mains.body.categories as unknown as Array<{ id: string; code: string }>).find(
      (c) => c.code === 'T-FOOD-MAINS',
    )!;
    const third = await makeCategory({
      code: 'T-DEEPER',
      name: 'Deeper still',
      parentId: sub.id,
      sortOrder: 0,
    });
    expect(third.statusCode).toBe(400);
    expect(String((third.body.error as unknown as { message: string }).message)).toContain(
      'two levels deep',
    );
  });

  it('refuses a top-level category with no taxable area', async () => {
    const res = await makeCategory({ code: 'T-NOTAX', name: 'No tax', sortOrder: 1 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a second live category on the same code', async () => {
    const res = await makeCategory({
      code: 'T-FOOD',
      name: 'Food again',
      taxableCategory: 'fnb',
      sortOrder: 9,
    });
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { code: string }).code).toBe('CATEGORY_CODE_IN_USE');
  });

  it('refuses to withdraw a category that still holds items', async () => {
    const item = await makeItem({
      code: 'T-SOUP',
      name: 'Soup',
      categoryId: foodId,
      priceSatang: 12000,
    });
    expect(item.statusCode).toBe(200);
    const res = await call('DELETE', `/menu/categories/${foodId}`, { cookie: admin });
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { code: string }).code).toBe('CATEGORY_IN_USE');
  });
});

describe('items are branch-owned, priced in satang, and withdrawn rather than deleted', () => {
  let drinksId: string;
  let latteId: string;

  beforeAll(async () => {
    const drinks = await makeCategory({
      code: 'T-DRINKS',
      name: 'Drinks',
      taxableCategory: 'fnb',
      defaultPrepStation: 'bar',
      sortOrder: 2,
    });
    drinksId = drinks.body.id as unknown as string;
  });

  it('creates an item and resolves its station and taxable area from the category', async () => {
    const created = await makeItem({
      code: 'T-LATTE',
      name: 'Iced Latte',
      categoryId: drinksId,
      priceSatang: 9500,
      costSatang: 3000,
      translations: { th: { name: 'ลาเต้เย็น' } },
    });
    expect(created.statusCode).toBe(200);
    latteId = created.body.id as unknown as string;

    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const item = (
      menu.body.products as unknown as Array<{
        id: string;
        priceSatang: number;
        effectiveWeekendSatang: number;
        effectivePrepStation: string;
        effectiveTaxCategory: string;
        translations: { th?: { name?: string } };
      }>
    ).find((i) => i.id === latteId)!;
    expect(item.priceSatang).toBe(9500);
    // Null weekend means the same as weekday — the prototype's wwp() default.
    expect(item.effectiveWeekendSatang).toBe(9500);
    expect(item.effectivePrepStation).toBe('bar');
    expect(item.effectiveTaxCategory).toBe('fnb');
    expect(item.translations.th?.name).toBe('ลาเต้เย็น');
  });

  it('a sub-category inherits the station its parent sets', async () => {
    const coffee = await makeCategory({
      code: 'T-DRINKS-COFFEE',
      name: 'Coffee',
      parentId: drinksId,
      sortOrder: 0,
    });
    const espresso = await makeItem({
      code: 'T-ESPRESSO',
      name: 'Espresso',
      categoryId: coffee.body.id as unknown as string,
      priceSatang: 7000,
    });
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const item = (
      menu.body.products as unknown as Array<{ id: string; effectivePrepStation: string }>
    ).find((i) => i.id === (espresso.body.id as unknown as string))!;
    expect(item.effectivePrepStation).toBe('bar');
  });

  it('an item override beats the category', async () => {
    await call('PATCH', `/branches/${branchId}/menu/products/${latteId}`, {
      cookie: admin,
      payload: { prepStationOverride: 'none', taxCategoryOverride: 'merch' },
    });
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const item = (
      menu.body.products as unknown as Array<{
        id: string;
        effectivePrepStation: string;
        effectiveTaxCategory: string;
      }>
    ).find((i) => i.id === latteId)!;
    expect(item.effectivePrepStation).toBe('none');
    expect(item.effectiveTaxCategory).toBe('merch');
  });

  it('withdrawing leaves the row readable by the orders that sold it', async () => {
    const res = await call('DELETE', `/branches/${branchId}/menu/products/${latteId}`, {
      cookie: admin,
    });
    expect(res.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(product).where(eq(product.id, latteId));
    expect(row?.archivedAt).toBeTruthy();
    expect(row?.active).toBe(false);

    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    expect(
      (menu.body.products as unknown as Array<{ id: string }>).some((i) => i.id === latteId),
    ).toBe(false);
    const withArchived = await call(
      'GET',
      `/branches/${branchId}/menu?includeArchived=true`,
      { cookie: admin },
    );
    expect(
      (withArchived.body.products as unknown as Array<{ id: string }>).some((i) => i.id === latteId),
    ).toBe(true);
  });

  it('frees the code for the item that replaces it', async () => {
    const again = await makeItem({
      code: 'T-LATTE',
      name: 'Iced Latte (new recipe)',
      categoryId: drinksId,
      priceSatang: 10500,
    });
    expect(again.statusCode).toBe(200);
  });

  it('refuses a negative price at the edge of the API', async () => {
    const res = await makeItem({ code: 'T-BAD', name: 'Bad', priceSatang: -1 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an item with no category, because it would be on no tab', async () => {
    // The import has always required one ("A category is required on a new
    // item"); the form used to accept an item that then appeared nowhere.
    const res = await call('POST', `/branches/${branchId}/menu/products`, {
      cookie: admin,
      payload: { code: 'T-NOWHERE', name: 'Nowhere', priceSatang: 1000 },
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body.error as unknown as { message: string }).message)).toContain('tab');
    const rows = await ctx.db.select().from(product).where(eq(product.code, 'T-NOWHERE'));
    expect(rows).toHaveLength(0);
  });

  it('refuses emptying an existing item out of its category', async () => {
    const made = await makeItem({ code: 'T-STAYS', name: 'Stays put', priceSatang: 1000 });
    const res = await call(
      'PATCH',
      `/branches/${branchId}/menu/products/${made.body.id as unknown as string}`,
      { cookie: admin, payload: { categoryId: null } },
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('the shared modifier library', () => {
  let groupId: string;
  let sodaId: string;

  it('creates a library group with its priced options', async () => {
    const res = await call('POST', '/menu/modifier-groups', {
      cookie: admin,
      payload: {
        name: 'Test ice level',
        required: true,
        selectionType: 'single',
        sortOrder: 0,
        options: [
          { name: 'Normal ice', priceSatang: 0, sortOrder: 0 },
          { name: 'Less ice', priceSatang: 0, sortOrder: 1 },
          { name: 'No ice', priceSatang: 0, sortOrder: 2 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    groupId = res.body.id as unknown as string;
  });

  it('refuses a minimum or maximum on a single-choice group', async () => {
    const res = await call('POST', '/menu/modifier-groups', {
      cookie: admin,
      payload: { name: 'One only', selectionType: 'single', maxSelect: 2, sortOrder: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('links a group to an item and reads it back in order', async () => {
    const item = await makeItem({
      code: 'T-SODA',
      name: 'Soft Drink',
      priceSatang: 4500,
      modifierGroupIds: [groupId],
    });
    sodaId = item.body.id as unknown as string;
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const row = (
      menu.body.products as unknown as Array<{ id: string; linkedModifierGroupIds: string[] }>
    ).find((i) => i.id === sodaId)!;
    expect(row.linkedModifierGroupIds).toEqual([groupId]);

    const group = (
      menu.body.modifierGroups as unknown as Array<{
        id: string;
        productId: string | null;
        name: string;
        options: Array<{ name: string }>;
      }>
    ).find((g) => g.id === groupId)!;
    // A library group carries no product of its own; that is what makes it shared.
    expect(group.productId).toBeNull();
    expect(group.name).toBe('Test ice level');
    expect(group.options.map((o) => o.name)).toEqual(['Normal ice', 'Less ice', 'No ice']);
  });

  it('changes only the links, with no other field in the body', async () => {
    // Found by the gate: a body carrying only `modifierGroupIds` answered 500
    // ("No values to set") because the UPDATE's SET was empty. That is exactly
    // what the item form's linked-groups editor sends.
    const res = await call('PATCH', `/branches/${branchId}/menu/products/${sodaId}`, {
      cookie: admin,
      payload: { modifierGroupIds: [] },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const row = (
      menu.body.products as unknown as Array<{ id: string; linkedModifierGroupIds: string[] }>
    ).find((i) => i.id === sodaId)!;
    expect(row.linkedModifierGroupIds).toEqual([]);
    // Put the link back for the tests that follow.
    const back = await call('PATCH', `/branches/${branchId}/menu/products/${sodaId}`, {
      cookie: admin,
      payload: { modifierGroupIds: [groupId] },
    });
    expect(back.statusCode).toBe(200);
  });

  it('withdrawing a group takes every item’s link to it, and leaves the rest', async () => {
    const made = await call('POST', '/menu/modifier-groups', {
      cookie: admin,
      payload: {
        name: 'Test sugar level',
        selectionType: 'single',
        sortOrder: 1,
        options: [{ name: 'No sugar', priceSatang: 0, sortOrder: 0 }],
      },
    });
    const sugarId = made.body.id as unknown as string;
    const item = await makeItem({
      code: 'T-TEA',
      name: 'Iced Tea',
      priceSatang: 5000,
      modifierGroupIds: [sugarId],
    });
    const teaId = item.body.id as unknown as string;
    expect(
      await ctx.db
        .select()
        .from(productModifierGroup)
        .where(eq(productModifierGroup.modifierGroupId, sugarId)),
    ).toHaveLength(1);

    const res = await call('DELETE', `/menu/modifier-groups/${sugarId}`, { cookie: admin });
    expect(res.statusCode).toBe(200);

    // The links go with the group. They used to stay: the route handed a GROUP
    // id to a delete keyed on `product_id`, which matched nothing at all.
    expect(
      await ctx.db
        .select()
        .from(productModifierGroup)
        .where(eq(productModifierGroup.modifierGroupId, sugarId)),
    ).toHaveLength(0);

    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const products = menu.body.products as unknown as Array<{
      id: string;
      linkedModifierGroupIds: string[];
    }>;
    expect(products.find((i) => i.id === teaId)!.linkedModifierGroupIds).toEqual([]);
    // And only that group's links: the soft drink still asks about ice.
    expect(products.find((i) => i.id === sodaId)!.linkedModifierGroupIds).toEqual([groupId]);
  });
});

describe('the tax-override picker sees a sub-category’s inherited area', () => {
  it('returns the row’s own column and the effective one beside it', async () => {
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const categories = menu.body.categories as unknown as Array<{ id: string; code: string }>;
    const parentId = categories.find((c) => c.code === 'T-FOOD')!.id;
    const subId = categories.find((c) => c.code === 'T-FOOD-MAINS')!.id;

    const res = await call('GET', '/product-categories', { cookie: admin });
    expect(res.statusCode).toBe(200);
    const rows = res.body.categories as unknown as Array<{
      id: string;
      taxableCategory: string | null;
      effectiveTaxableCategory: string | null;
    }>;

    const parent = rows.find((c) => c.id === parentId)!;
    expect(parent.taxableCategory).toBe('fnb');
    expect(parent.effectiveTaxableCategory).toBe('fnb');

    const sub = rows.find((c) => c.id === subId)!;
    // The raw column is untouched — null still means "inherits" to anything
    // that writes it back.
    expect(sub.taxableCategory).toBeNull();
    // And the picker no longer shows a blank where the answer is Food's.
    expect(sub.effectiveTaxableCategory).toBe('fnb');
  });
});

describe('discount codes are definitions, and the sale ledger keeps the redemptions', () => {
  it('creates a percentage code and refuses one with no percentage', async () => {
    const ok = await call('POST', '/menu/discounts', {
      cookie: admin,
      payload: { code: 'T-STAFF10', label: 'Staff Discount', kind: 'percent', valueBp: 1000, stackable: true },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await call('POST', '/menu/discounts', {
      cookie: admin,
      payload: { code: 'T-BROKEN', label: 'Broken', kind: 'percent' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('who may do what', () => {
  it('reception reads the menu and cannot change it', async () => {
    const read = await call('GET', `/branches/${branchId}/menu`, { cookie: reception });
    expect(read.statusCode).toBe(200);

    const write = await call('POST', '/menu/categories', {
      cookie: reception,
      payload: { code: 'T-NOPE', name: 'Nope', taxableCategory: 'fnb', sortOrder: 0 },
    });
    expect(write.statusCode).toBe(403);
  });

  it('reception cannot download the workbook, which carries the cost column', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/menu/export.xlsx`,
      headers: { cookie: reception },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reception cannot import', async () => {
    const res = await call('POST', `/branches/${branchId}/menu/import/preview`, {
      cookie: reception,
      payload: { filename: 'x.xlsx', contentBase64: 'UEs=' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a branch manager manages and imports', async () => {
    const res = await call('POST', '/menu/categories', {
      cookie: manager,
      payload: { code: 'T-MGR', name: 'Manager made this', taxableCategory: 'fnb', defaultPrepStation: 'none', sortOrder: 8 },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('another operator’s administrator reaches none of it (SCRUM-290)', () => {
  it('cannot read this branch’s menu', async () => {
    const res = await call('GET', `/branches/${branchId}/menu`, { cookie: outsider });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('cannot create an item on it', async () => {
    const res = await call('POST', `/branches/${branchId}/menu/products`, {
      cookie: outsider,
      payload: { code: 'T-FOREIGN', name: 'Foreign', priceSatang: 100 },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('cannot edit a category of ours by its id', async () => {
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const category = (menu.body.categories as unknown as Array<{ id: string }>)[0]!;
    const res = await call('PATCH', `/menu/categories/${category.id}`, {
      cookie: outsider,
      payload: { name: 'Renamed by the wrong operator' },
    });
    expect(res.statusCode).toBe(404);

    const after = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const still = (after.body.categories as unknown as Array<{ id: string; name: string }>).find(
      (c) => c.id === category.id,
    )!;
    expect(still.name).not.toBe('Renamed by the wrong operator');
  });

  it('sees its own empty menu on its own branch', async () => {
    const res = await call('GET', `/branches/${otherBranchId}/menu`, { cookie: outsider });
    expect(res.statusCode).toBe(200);
    expect(res.body.products as unknown as unknown[]).toEqual([]);
  });
});

describe('every change is on the record', () => {
  it('writes an audit row carrying before and after', async () => {
    const created = await makeItem({
      code: 'T-AUDIT',
      name: 'Audited',
      priceSatang: 5000,
    });
    const id = created.body.id as unknown as string;
    await call('PATCH', `/branches/${branchId}/menu/products/${id}`, {
      cookie: admin,
      payload: { priceSatang: 5500 },
    });

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'product'), eq(auditLog.entityId, id)));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('menu_item.create');
    expect(actions).toContain('menu_item.update');
    const update = rows.find((r) => r.action === 'menu_item.update')!;
    expect((update.before as { priceSatang: number }).priceSatang).toBe(5000);
    expect((update.after as { priceSatang: number }).priceSatang).toBe(5500);
  });

  it('replaying a create with the same idempotency key makes one item', async () => {
    const payload = {
      code: 'T-ONCE',
      name: 'Only once',
      priceSatang: 4200,
      categoryId: defaultCategoryId,
    };
    const key = 'menu-item-once';
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/menu/products`,
      headers: { cookie: admin, 'idempotency-key': key },
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/menu/products`,
      headers: { cookie: admin, 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const rows = await ctx.db
      .select()
      .from(product)
      .where(and(eq(product.code, 'T-ONCE')));
    expect(rows).toHaveLength(1);
  });
});

/**
 * The grip socks the seed carries, with their sizes (S2-09b).
 *
 * The acceptance line reads "scanning the seeded barcode 8850000000017 adds
 * Grip socks M to the shop cart", and the resolver's own file proves the
 * resolving. What is pinned here is the other half of that sentence: that a
 * database nobody has typed into already has the socks in three sizes with the
 * barcode on the M — the owner's decision of 2026-09-24, which made the size a
 * property of the item. Until then the seed carried a second product, "Grip
 * socks M" (`MR-SOCKS-M`), because a product had nowhere to put a size.
 */
describe('the seed carries the grip socks in three sizes, with the barcode on the M', () => {
  const BARCODE = '8850000000017';

  interface MenuProduct {
    id: string;
    kind: string;
    code: string | null;
    name: string;
    sku: string | null;
    variants: Array<{ id: string; label: string; sku?: string; barcode?: string }>;
    categoryId: string | null;
    priceSatang: number;
    archivedAt: string | null;
  }

  it('is one live merch row, in a shop category, with S, M and L', async () => {
    const res = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    expect(res.statusCode).toBe(200);
    const products = res.body.products as unknown as MenuProduct[];

    const socks = products.find((p) => p.code === 'MR-SOCKS')!;
    expect(socks.name).toBe('Grip Socks');
    expect(socks.kind).toBe('merch');
    expect(socks.priceSatang).toBe(12000);
    expect(socks.archivedAt).toBeNull();
    // The whole item keeps the prototype's stock-keeping code; the barcode is
    // the M's, and only the M's.
    expect(socks.sku).toBe('OTO-SOCK');
    expect(socks.variants).toEqual([
      { id: 's', label: 'S' },
      { id: 'm', label: 'M', barcode: BARCODE },
      { id: 'l', label: 'L' },
    ]);

    // No product answers to the barcode whole any more, and the separate
    // "Grip socks M" row is no longer seeded.
    expect(products.filter((p) => p.sku === BARCODE)).toEqual([]);
    expect(products.find((p) => p.code === 'MR-SOCKS-M')).toBeUndefined();

    // Every other seeded item comes in one size.
    expect(
      products.filter((p) => p.variants.length > 0 && p.code?.startsWith('MR-')).map((p) => p.code),
    ).toEqual(['MR-SOCKS']);

    const categories = res.body.categories as unknown as Array<{
      id: string;
      taxableCategory: string | null;
    }>;
    expect(categories.find((c) => c.id === socks.categoryId)?.taxableCategory).toBe('merch');
  });

  it('refuses a new item that would answer to the M’s barcode, and names who has it', async () => {
    const res = await makeItem({
      code: 'T-SAME-BARCODE',
      name: 'Someone else’s socks',
      kind: 'merch',
      priceSatang: 12000,
      sku: BARCODE,
    });
    expect(res.statusCode).toBe(409);
    // What the Merch panel's toast is made of: the barcode and the size that
    // already holds it. A barcode is printed on a tag in the shop; naming it
    // leaks nothing, and not naming it leaves staff hunting for it.
    expect(res.body.error as unknown as Record<string, unknown>).toMatchObject({
      code: 'BARCODE_IN_USE',
      message: `The barcode ${BARCODE} is already on "Grip Socks — M" — a barcode can name only one thing`,
      details: { barcode: BARCODE, variantId: 'm' },
    });
  });
});

/**
 * An item's sizes through the Merch panel's routes (S2-09b).
 *
 * `pos.product.variants` is jsonb and the database checks only that it is a
 * list. Every other rule is the route's, and each is refused here in the words
 * the panel's toast will show.
 */
describe('an item’s sizes', () => {
  type Size = { id: string; label: string; sku?: string; barcode?: string };
  let apparelId: string;

  beforeAll(async () => {
    const apparel = await makeCategory({
      code: 'T-APPAREL',
      name: 'Test apparel',
      taxableCategory: 'merch',
      defaultPrepStation: 'none',
      sortOrder: 30,
    });
    apparelId = apparel.body.id as unknown as string;
  });

  const makeMerch = (code: string, extra: Record<string, unknown> = {}) =>
    makeItem({
      code,
      name: `Tee ${code}`,
      kind: 'merch',
      priceSatang: 30000,
      categoryId: apparelId,
      ...extra,
    });

  const patch = (id: string, payload: Record<string, unknown>) =>
    call('PATCH', `/branches/${branchId}/menu/products/${id}`, { cookie: admin, payload });

  const sizesOf = async (id: string): Promise<Size[]> => {
    const res = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const products = res.body.products as unknown as Array<{ id: string; variants: Size[] }>;
    return products.find((p) => p.id === id)!.variants;
  };

  it('saves S, M and L with a barcode on one, and reads them back in order', async () => {
    const created = await makeMerch('T-TEE-1', {
      variants: [
        { id: 's', label: 'S' },
        { id: 'm', label: ' M ', barcode: '8851234567895' },
        { id: 'l', label: 'L', barcode: null, sku: null },
      ],
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id as unknown as string;
    // Trimmed, and a null barcode or code is left off the stored size.
    expect(await sizesOf(id)).toEqual([
      { id: 's', label: 'S' },
      { id: 'm', label: 'M', barcode: '8851234567895' },
      { id: 'l', label: 'L' },
    ]);
  });

  it('replaces the whole list on an edit, leaves it alone when the edit names none, and [] takes them away', async () => {
    const created = await makeMerch('T-TEE-2', { variants: [{ id: 's', label: 'S' }] });
    const id = created.body.id as unknown as string;

    const renamed = await patch(id, {
      variants: [
        { id: 's', label: 'Small' },
        { id: 'xl', label: 'XL' },
      ],
    });
    expect(renamed.statusCode).toBe(200);
    expect(await sizesOf(id)).toEqual([
      { id: 's', label: 'Small' },
      { id: 'xl', label: 'XL' },
    ]);

    // A price edit from a form that knows nothing of sizes keeps them.
    expect((await patch(id, { priceSatang: 31000 })).statusCode).toBe(200);
    expect(await sizesOf(id)).toHaveLength(2);

    expect((await patch(id, { variants: [] })).statusCode).toBe(200);
    expect(await sizesOf(id)).toEqual([]);
  });

  it.each([
    [
      'two sizes with one id',
      [
        { id: 'm', label: 'M' },
        { id: 'm', label: 'Medium' },
      ],
      'Two sizes of "Tee T-TEE-BAD" have the id "m" — each size needs its own',
    ],
    [
      'two sizes with one label, whatever its case',
      [
        { id: 'm', label: 'M' },
        { id: 'm2', label: 'm' },
      ],
      '"Tee T-TEE-BAD" has two sizes called "m"',
    ],
    [
      'a barcode no scanner could read',
      [{ id: 'm', label: 'M', barcode: '885-ABC' }],
      'The barcode on size "M" is not one a scanner can read — a barcode is 8 to 14 digits',
    ],
    [
      'one barcode on two sizes',
      [
        { id: 'm', label: 'M', barcode: '8851111111118' },
        { id: 'l', label: 'L', barcode: '8851111111118' },
      ],
      'Sizes "M" and "L" of "Tee T-TEE-BAD" carry the same barcode, 8851111111118',
    ],
  ])('refuses %s, in a sentence', async (_what, variants, message) => {
    const res = await makeMerch('T-TEE-BAD', { variants });
    expect(res.statusCode).toBe(400);
    expect((res.body.error as unknown as { message: string }).message).toBe(message);
  });

  it('refuses a size whose barcode is the item’s own', async () => {
    const res = await makeMerch('T-TEE-OWN', {
      sku: '8852222222222',
      variants: [{ id: 'm', label: 'M', barcode: '8852222222222' }],
    });
    expect(res.statusCode).toBe(400);
    expect((res.body.error as unknown as { message: string }).message).toBe(
      `8852222222222 is both "Tee T-TEE-OWN"'s own barcode and size "M"'s — a scan has to name one of them`,
    );
  });

  it('refuses a size with no label, or an id the till could not carry', async () => {
    expect((await makeMerch('T-TEE-EMPTY', { variants: [{ id: 'm', label: '   ' }] })).statusCode).toBe(400);
    expect((await makeMerch('T-TEE-ID', { variants: [{ id: 'Size M!', label: 'M' }] })).statusCode).toBe(400);
  });

  /**
   * THE COLLISION — the rule the owner named: a size's barcode is unique across
   * the operator's live items and sizes. Its plant removes the check in
   * `assertBarcodesFree`; this test then goes red, because the second item is
   * saved with a barcode the first one's size already answers to.
   */
  it('PLANT — refuses a size barcode another item’s size already carries, and names that size', async () => {
    const first = await makeMerch('T-TEE-A', {
      variants: [{ id: 'm', label: 'M', barcode: '8853333333338' }],
    });
    expect(first.statusCode).toBe(200);

    const second = await makeMerch('T-TEE-B', {
      variants: [{ id: 'l', label: 'L', barcode: '8853333333338' }],
    });
    expect(second.statusCode).toBe(409);
    expect(second.body.error as unknown as Record<string, unknown>).toMatchObject({
      code: 'BARCODE_IN_USE',
      message:
        'The barcode 8853333333338 is already on "Tee T-TEE-A — M" — a barcode can name only one thing',
      details: { barcode: '8853333333338', productId: first.body.id, variantId: 'm' },
    });
    // Nothing was written: the refusal came before the insert.
    const rows = await ctx.db.select().from(product).where(eq(product.code, 'T-TEE-B'));
    expect(rows).toEqual([]);
  });

  it('refuses a size barcode that is another item’s own barcode', async () => {
    await makeMerch('T-TEE-C', { sku: '8854444444445' });
    const res = await makeMerch('T-TEE-D', {
      variants: [{ id: 's', label: 'S', barcode: '8854444444445' }],
    });
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { message: string }).message).toBe(
      'The barcode 8854444444445 is already on "Tee T-TEE-C" — a barcode can name only one thing',
    );
  });

  it('refuses an item’s own barcode when another item’s size already carries it, on an edit too', async () => {
    await makeMerch('T-TEE-E', { variants: [{ id: 'm', label: 'M', barcode: '8855555555552' }] });
    const other = await makeMerch('T-TEE-F');
    const res = await patch(other.body.id as unknown as string, { sku: '8855555555552' });
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { code: string }).code).toBe('BARCODE_IN_USE');
  });

  /**
   * The one barcode collision these routes leave to the database, as the header
   * of `services/product-variants.ts` says: two live items with the same OWN
   * code. `assertBarcodesFree` compares sizes with items and items with sizes,
   * never one item's own code with another's — `product_sku_unique` refuses
   * that pair, on a create and on an edit alike.
   */
  it('refuses a second live item on the same own barcode, and names the constraint', async () => {
    const holder = await makeMerch('T-TEE-SKU-1', { sku: '8858888888883' });
    expect(holder.statusCode).toBe(200);

    const second = await makeMerch('T-TEE-SKU-2', { sku: '8858888888883' });
    expect(second.statusCode).toBe(409);
    // What the Merch panel's toast is made of: a code, a sentence about the
    // value, and the constraint — never the item already holding it.
    expect(second.body.error as unknown as Record<string, unknown>).toMatchObject({
      code: 'DUPLICATE',
      message: 'That value is already taken',
      details: { constraint: 'product_sku_unique' },
    });
    expect(await ctx.db.select().from(product).where(eq(product.code, 'T-TEE-SKU-2'))).toEqual([]);

    // An edit that moves another item onto the same code meets the same rule.
    const other = await makeMerch('T-TEE-SKU-3', { sku: '8858888888890' });
    expect(other.statusCode).toBe(200);
    const moved = await patch(other.body.id as unknown as string, { sku: '8858888888883' });
    expect(moved.statusCode).toBe(409);
    expect(moved.body.error as unknown as Record<string, unknown>).toMatchObject({
      code: 'DUPLICATE',
      message: 'That value is already taken',
      details: { constraint: 'product_sku_unique' },
    });
  });

  it('lets an item keep its own sizes on an edit — its barcodes do not collide with themselves', async () => {
    const created = await makeMerch('T-TEE-G', {
      variants: [{ id: 'm', label: 'M', barcode: '8856666666669' }],
    });
    const id = created.body.id as unknown as string;
    const res = await patch(id, {
      variants: [
        { id: 'm', label: 'Medium', barcode: '8856666666669' },
        { id: 'l', label: 'L' },
      ],
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  });

  it('frees a barcode when the item holding it is withdrawn', async () => {
    const holder = await makeMerch('T-TEE-H', {
      variants: [{ id: 'm', label: 'M', barcode: '8857777777776' }],
    });
    const blocked = await makeMerch('T-TEE-I', {
      variants: [{ id: 'm', label: 'M', barcode: '8857777777776' }],
    });
    expect(blocked.statusCode).toBe(409);

    const withdrawn = await call(
      'DELETE',
      `/branches/${branchId}/menu/products/${holder.body.id as unknown as string}`,
      { cookie: admin },
    );
    expect(withdrawn.statusCode).toBe(200);
    const again = await makeMerch('T-TEE-I', {
      variants: [{ id: 'm', label: 'M', barcode: '8857777777776' }],
    });
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
  });

  it('puts the sizes on the audit row, before and after', async () => {
    const created = await makeMerch('T-TEE-J', { variants: [{ id: 's', label: 'S' }] });
    const id = created.body.id as unknown as string;
    await patch(id, {
      variants: [
        { id: 's', label: 'S' },
        { id: 'm', label: 'M' },
      ],
    });
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'product'), eq(auditLog.entityId, id)));
    const update = rows.find((r) => r.action === 'menu_item.update')!;
    expect((update.before as { variants: Size[] }).variants).toEqual([{ id: 's', label: 'S' }]);
    expect((update.after as { variants: Size[] }).variants).toEqual([
      { id: 's', label: 'S' },
      { id: 'm', label: 'M' },
    ]);
  });
});
