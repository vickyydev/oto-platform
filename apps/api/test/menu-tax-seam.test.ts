import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { branch, product, productCategory, saleLine, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * The seam between the MENU and the SALE LEDGER: which taxable area an item's
 * money lands in.
 *
 * The menu states it in two places at once. A top-level category names a
 * taxable area; a SUB-category leaves the column null to INHERIT its parent's —
 * the prototype's own rule (`lib/menu.ts:68-78`), what migration 0015 made the
 * column nullable for, and how the seeded Coffee-under-Drinks is built.
 *
 * `services/sale.ts` used to read `product_category.taxable_category` off one
 * leftJoin and take it raw, so every item filed under a sub-category answered
 * null and its money was recorded against the add-ons area rather than F&B —
 * while the comment over that line promised "the catalogue's answer wins; the
 * till's is used when there is none". This file builds that menu through the
 * real menu routes, sells it through the real `/sales` route, and reads the row
 * that lands in Postgres: the tax report and the Sale detail view both read
 * that column, and neither would have said anything was wrong.
 */

let ctx: TestContext;
let admin: string;
let reception: string;
let branchId: string;
let stationId: string;
let packageId: string;
/** In a sub-category that states no taxable area of its own — the defect. */
let latteId: string;
/** Directly under a top-level category that does state one — the control. */
let popcornId: string;
let coffeeCategoryId: string;

const call = async (
  method: 'GET' | 'POST',
  url: string,
  opts: { cookie: string; payload?: unknown },
) => {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: opts.cookie },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, never> };
};

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = stations[0]!.id;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  packageId = packages.find((p) => p.name === '2 Hours Play')!.id;

  // Drinks states `fnb`; Coffee under it states nothing and inherits.
  const drinks = await call('POST', '/menu/categories', {
    cookie: admin,
    payload: {
      code: 'TX-DRINKS',
      name: 'Tax Drinks',
      taxableCategory: 'fnb',
      defaultPrepStation: 'bar',
      sortOrder: 40,
    },
  });
  expect(drinks.statusCode).toBe(200);
  const coffee = await call('POST', '/menu/categories', {
    cookie: admin,
    payload: {
      code: 'TX-COFFEE',
      name: 'Tax Coffee',
      parentId: drinks.body.id as unknown as string,
      sortOrder: 0,
    },
  });
  expect(coffee.statusCode).toBe(200);
  coffeeCategoryId = coffee.body.id as unknown as string;

  const latte = await call('POST', `/branches/${branchId}/menu/products`, {
    cookie: admin,
    payload: {
      code: 'TX-LATTE',
      name: 'Iced Latte',
      categoryId: coffeeCategoryId,
      priceSatang: 9500,
    },
  });
  expect(latte.statusCode).toBe(200);
  latteId = latte.body.id as unknown as string;

  const popcorn = await call('POST', `/branches/${branchId}/menu/products`, {
    cookie: admin,
    payload: {
      code: 'TX-POPCORN',
      name: 'Popcorn',
      categoryId: drinks.body.id as unknown as string,
      priceSatang: 6000,
    },
  });
  expect(popcorn.statusCode).toBe(200);
  popcornId = popcorn.body.id as unknown as string;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('an item in a sub-category inherits its parent’s taxable area', () => {
  it('is set up the way the defect needs: nothing on the item or its own category', async () => {
    const [item] = await ctx.db.select().from(product).where(eq(product.id, latteId));
    // No override on the item, or the walk would never be reached.
    expect(item!.taxCategoryOverride).toBeNull();

    const [own] = await ctx.db
      .select()
      .from(productCategory)
      .where(eq(productCategory.id, coffeeCategoryId));
    // Null here means "inherit", not "no area" — that is the whole defect.
    expect(own!.taxableCategory).toBeNull();

    const [parent] = await ctx.db
      .select()
      .from(productCategory)
      .where(eq(productCategory.id, own!.parentId!));
    expect(parent!.taxableCategory).toBe('fnb');
  });

  it('reads back as fnb on the menu, which is the answer the sale has to match', async () => {
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie: admin });
    const row = (
      menu.body.products as unknown as Array<{ id: string; effectiveTaxCategory: string }>
    ).find((i) => i.id === latteId)!;
    expect(row.effectiveTaxCategory).toBe('fnb');
  });

  it('records the parent’s area on the sale line, not the add-ons default', async () => {
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        id: saleId,
        stationId,
        lines: [
          {
            id: newId(),
            packageId,
            kids: 1,
            adults: 0,
            // Sold as an add-on on the ticket line: the path that read the
            // column raw. The till names no tax category, so the only answer
            // available is the catalogue's.
            addOns: [{ id: latteId, name: 'Iced Latte', unitSatang: 9500, quantity: 1 }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const latteLine = lines.find((l) => l.productId === latteId);
    expect(latteLine).toBeDefined();
    // Drinks says fnb; Coffee inherits it; the ledger has to agree.
    expect(latteLine!.taxableCategory).toBe('fnb');
    expect(latteLine!.revenueCategory).toBe('fnb');
    // And the platform's price, not the till's — rule 1 is untouched by this.
    expect(latteLine!.unitSatang).toBe(9500);
  });

  it('leaves a top-level category’s own area, and an unpriced add-on, exactly where they were', async () => {
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        id: saleId,
        stationId,
        lines: [
          {
            id: newId(),
            packageId,
            kids: 1,
            adults: 0,
            addOns: [
              { id: popcornId, name: 'Popcorn', unitSatang: 6000, quantity: 1 },
              // A prototype id that resolves to no platform row: the till's
              // snapshot still stands, and its money still lands in add-ons.
              { id: 'a-locker', name: 'Locker Rental', unitSatang: 5000, quantity: 1 },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.find((l) => l.productId === popcornId)!.taxableCategory).toBe('fnb');
    expect(lines.find((l) => l.componentKey === 'a-locker')!.taxableCategory).toBe('addons');
    // The admission is untouched by any of it.
    expect(lines.find((l) => l.kind === 'kids')!.taxableCategory).toBe('tickets');
  });
});
