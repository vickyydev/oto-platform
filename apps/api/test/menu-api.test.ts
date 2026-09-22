import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, product } from '@oto/db';
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
  call('POST', `/branches/${branchId}/menu/products`, { cookie, payload });

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
});

describe('the shared modifier library', () => {
  let groupId: string;

  it('creates a library group with its priced options', async () => {
    const res = await call('POST', '/menu/modifier-groups', {
      cookie: admin,
      payload: {
        name: 'Ice level',
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
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const row = (
      menu.body.products as unknown as Array<{ id: string; linkedModifierGroupIds: string[] }>
    ).find((i) => i.id === (item.body.id as unknown as string))!;
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
    expect(group.name).toBe('Ice level');
    expect(group.options.map((o) => o.name)).toEqual(['Normal ice', 'Less ice', 'No ice']);
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
    const payload = { code: 'T-ONCE', name: 'Only once', priceSatang: 4200 };
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
