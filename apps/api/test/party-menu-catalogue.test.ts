import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, product, productCategory } from '@oto/db';
import { PartyMenuCatalogueAnswerSchema, newId, type PartyMenuCatalogueItem } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-905 — THE TILL'S FOOD AND DRINK FOR THE BEO, the platform's door.
 *
 * The OTO App's server asks `GET /otoapp/party-menu/catalogue?branchId=` with
 * its provisioning key, and its kitchen and bar plan pickers offer what is
 * answered. Held here against a real database:
 *
 *   - the door is the key's: no key, a key this platform does not hold, or a
 *     till session alone is 401; the operator is the key's, so another
 *     operator's branch is 404, and so is an archived branch;
 *   - it answers the branch's live food and drink: the branch's own items and
 *     the operator-wide ones, each with its code, name, category (and its
 *     parent), station, weekday and weekend price in satang and its BEO-only
 *     flag; in the menu's own order;
 *   - and leaves out an archived item, one withdrawn from sale, one with no
 *     code, merch, a ticket add-on, an item made at no station, another
 *     branch's item and another operator's;
 *   - it writes nothing.
 */

const KEY = 'zz-test-private-party-menu-catalogue-key-905';
const OTHER_KEY = 'zz-test-other-operator-catalogue-key-905';
const URL = '/otoapp/party-menu/catalogue';

let ctx: TestContext;
let operatorId: string;
let otherOperatorId: string;
let central: string;
let chalong: string;
let otherBranch: string;
let reception: string;

/** Every code this file makes starts with this, so the seed's own menu never muddles an answer. */
const RUN = `ZZ905-${newId().slice(-6).toUpperCase()}`;

const ask = (branchId: string, key: string | null = KEY, extra: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'GET',
    url: `${URL}?branchId=${branchId}`,
    headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...extra },
  });

async function ours(branchId: string): Promise<PartyMenuCatalogueItem[]> {
  const res = await ask(branchId);
  expect(res.statusCode, res.body).toBe(200);
  const answer = PartyMenuCatalogueAnswerSchema.parse(res.json());
  expect(answer.branchId).toBe(branchId);
  return answer.items.filter((i) => i.code.startsWith(RUN));
}

async function category(o: {
  operator?: string;
  name: string;
  parentId?: string | null;
  station?: 'kitchen' | 'bar' | 'none' | null;
  sortOrder: number;
}): Promise<string> {
  const id = newId();
  await ctx.db.insert(productCategory).values({
    id,
    operatorId: o.operator ?? operatorId,
    name: `${RUN} ${o.name}`,
    parentId: o.parentId ?? null,
    taxableCategory: o.parentId ? null : 'fnb',
    defaultPrepStation: o.station ?? null,
    sortOrder: o.sortOrder,
  });
  return id;
}

async function item(o: {
  operator?: string;
  branchId: string | null;
  categoryId: string;
  code: string | null;
  name: string;
  priceSatang?: number;
  priceWeekendSatang?: number | null;
  station?: 'kitchen' | 'bar' | 'none' | null;
  kind?: 'menu' | 'merch' | 'addon';
  active?: boolean;
  archived?: boolean;
  beoOnly?: boolean;
  sortOrder?: number;
}): Promise<void> {
  await ctx.db.insert(product).values({
    id: newId(),
    operatorId: o.operator ?? operatorId,
    branchId: o.branchId,
    categoryId: o.categoryId,
    kind: o.kind ?? 'menu',
    code: o.code === null ? null : `${RUN}-${o.code}`,
    name: `ZZ TEST ${o.name}`,
    priceSatang: o.priceSatang ?? 0,
    priceWeekendSatang: o.priceWeekendSatang ?? null,
    prepStationOverride: o.station ?? null,
    active: o.active ?? true,
    beoOnly: o.beoOnly ?? false,
    sortOrder: o.sortOrder ?? 0,
    archivedAt: o.archived ? new Date() : null,
  });
}

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ env });
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  otherOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  otherBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(KEY)},${otherOperatorId}:${otoAppProvisionKeyDigest(OTHER_KEY)}`;
  await ctx.restart();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  // The menu: Food (kitchen) with a Pizza sub-category, Drinks (bar), and Merch (no station).
  const food = await category({ name: 'Food', station: 'kitchen', sortOrder: 1 });
  const pizza = await category({ name: 'Pizza', parentId: food, sortOrder: 2 });
  const sides = await category({ name: 'Sides', parentId: food, sortOrder: 1 });
  const drinks = await category({ name: 'Drinks', station: 'bar', sortOrder: 2 });
  const merch = await category({ name: 'Merch', station: 'none', sortOrder: 3 });
  const theirs = await category({ operator: otherOperatorId, name: 'Their food', station: 'kitchen', sortOrder: 0 });

  // Answered:
  await item({ branchId: central, categoryId: pizza, code: 'PIZ-M', name: 'Margherita', priceSatang: 29_000, sortOrder: 1 });
  await item({ branchId: central, categoryId: pizza, code: 'PIZ-H', name: 'Hawaiian', priceSatang: 31_000, priceWeekendSatang: 35_000, sortOrder: 2 });
  await item({ branchId: central, categoryId: sides, code: 'FRIES', name: 'French fries', priceSatang: 12_000 });
  await item({ branchId: null, categoryId: drinks, code: 'JUICE', name: 'Kids juice Apple', priceSatang: 9_000 });
  // A dish in the Drinks tab that the kitchen makes, by its own station.
  await item({ branchId: central, categoryId: drinks, code: 'SMOOTH', name: 'Smoothie bowl', priceSatang: 15_000, station: 'kitchen', sortOrder: 5 });
  await item({ branchId: central, categoryId: food, code: 'BEO', name: 'unicorn cake', priceSatang: 0, beoOnly: true, sortOrder: 9 });
  // Left out:
  await item({ branchId: central, categoryId: pizza, code: 'GONE', name: 'Archived pizza', archived: true });
  await item({ branchId: central, categoryId: pizza, code: 'OFF', name: 'Withdrawn pizza', active: false });
  await item({ branchId: central, categoryId: pizza, code: null, name: 'Uncoded pizza' });
  await item({ branchId: central, categoryId: merch, code: 'SOCKS', name: 'Grip socks', kind: 'merch', priceSatang: 5_000 });
  await item({ branchId: central, categoryId: food, code: 'ADDON', name: 'Ticket add-on', kind: 'addon', priceSatang: 5_000 });
  await item({ branchId: central, categoryId: food, code: 'NOSTATION', name: 'Pre-packed snack', station: 'none', priceSatang: 4_000 });
  await item({ branchId: chalong, categoryId: pizza, code: 'CHALONG', name: 'Chalong pizza', priceSatang: 30_000 });
  await item({ operator: otherOperatorId, branchId: otherBranch, categoryId: theirs, code: 'THEIRS', name: 'Their pizza', priceSatang: 30_000 });
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the door is the OTO App server’s, by its key', () => {
  it('no key, a key this platform does not hold, or a till session alone: 401, and the route says so', async () => {
    expect((await ask(central, null)).statusCode).toBe(401);
    expect((await ask(central, 'zz-not-a-key')).statusCode).toBe(401);
    expect((await ask(central, null, { cookie: reception })).statusCode).toBe(401);
    // Refused as no key before the query is validated: an anonymous probe learns nothing of the shape.
    expect((await ctx.app.inject({ method: 'GET', url: `${URL}?branchId=not-a-uuid` })).statusCode).toBe(401);
    const route = ctx.app.routeRegistry.find((r) => r.method === 'GET' && r.url === URL);
    expect(route?.config.credential).toBe('otoapp-provision');
    expect(route?.config.public).not.toBe(true);
    expect(route?.config.permission).toBeUndefined();
  });

  it('the operator is the key’s: another operator’s branch, an archived branch or no branch at all is 404; a branch that is no uuid is 400', async () => {
    const theirs = await ask(otherBranch);
    expect(theirs.statusCode, theirs.body).toBe(404);
    expect(theirs.json().error.message).toBe('Branch not found');
    // The other operator's key reads its own branch, and none of this operator's.
    const own = await ask(otherBranch, OTHER_KEY);
    expect(own.statusCode, own.body).toBe(200);
    expect(PartyMenuCatalogueAnswerSchema.parse(own.json()).items.map((i) => i.code)).toContain(`${RUN}-THEIRS`);
    expect((await ask(central, OTHER_KEY)).statusCode).toBe(404);
    expect((await ask(newId())).statusCode).toBe(404);
    expect((await ask('not-a-uuid')).statusCode).toBe(400);

    const archived = newId();
    await ctx.db.insert(branch).values({
      id: archived,
      operatorId,
      name: 'ZZ TEST 905 closed park',
      code: `zz-905-${archived.slice(-6)}`,
      timezone: 'Asia/Bangkok',
      archivedAt: new Date(),
    });
    expect((await ask(archived)).statusCode).toBe(404);
  });
});

describe('the branch’s live food and drink', () => {
  it('the branch’s own items and the operator-wide ones, each with code, name, category, station, prices and the BEO-only flag, in the menu’s order', async () => {
    const items = await ours(central);
    expect(items).toEqual([
      // Food's own item, then Food › Sides before Food › Pizza (the sub-categories' own order),
      // then Drinks; within a category the item's place, then its name.
      { code: `${RUN}-BEO`, name: 'ZZ TEST unicorn cake', category: `${RUN} Food`, parentCategory: null, station: 'kitchen', priceSatang: 0, priceWeekendSatang: 0, beoOnly: true },
      { code: `${RUN}-FRIES`, name: 'ZZ TEST French fries', category: `${RUN} Sides`, parentCategory: `${RUN} Food`, station: 'kitchen', priceSatang: 12_000, priceWeekendSatang: 12_000, beoOnly: false },
      { code: `${RUN}-PIZ-M`, name: 'ZZ TEST Margherita', category: `${RUN} Pizza`, parentCategory: `${RUN} Food`, station: 'kitchen', priceSatang: 29_000, priceWeekendSatang: 29_000, beoOnly: false },
      { code: `${RUN}-PIZ-H`, name: 'ZZ TEST Hawaiian', category: `${RUN} Pizza`, parentCategory: `${RUN} Food`, station: 'kitchen', priceSatang: 31_000, priceWeekendSatang: 35_000, beoOnly: false },
      { code: `${RUN}-JUICE`, name: 'ZZ TEST Kids juice Apple', category: `${RUN} Drinks`, parentCategory: null, station: 'bar', priceSatang: 9_000, priceWeekendSatang: 9_000, beoOnly: false },
      { code: `${RUN}-SMOOTH`, name: 'ZZ TEST Smoothie bowl', category: `${RUN} Drinks`, parentCategory: null, station: 'kitchen', priceSatang: 15_000, priceWeekendSatang: 15_000, beoOnly: false },
    ]);
  });

  it('leaves out the archived, the withdrawn, the uncoded, merch, add-ons, no-station items, another branch’s and another operator’s', async () => {
    const codes = (await ours(central)).map((i) => i.code);
    for (const out of ['GONE', 'OFF', 'SOCKS', 'ADDON', 'NOSTATION', 'CHALONG', 'THEIRS']) {
      expect(codes, out).not.toContain(`${RUN}-${out}`);
    }
    const whole = PartyMenuCatalogueAnswerSchema.parse((await ask(central)).json()).items;
    expect(whole.some((i) => i.name === 'ZZ TEST Uncoded pizza')).toBe(false);
    expect(whole.every((i) => i.code.trim() !== '' && (i.station === 'kitchen' || i.station === 'bar'))).toBe(true);
    // Chalong reads its own pizza and the operator-wide juice, never Central's.
    const atChalong = (await ours(chalong)).map((i) => i.code);
    expect(atChalong).toEqual([`${RUN}-CHALONG`, `${RUN}-JUICE`]);
  });

  it('an item archived after it was answered is left out of the next read: its code is no longer live', async () => {
    expect((await ours(central)).map((i) => i.code)).toContain(`${RUN}-PIZ-H`);
    await ctx.db.update(product).set({ archivedAt: new Date() }).where(eq(product.code, `${RUN}-PIZ-H`));
    expect((await ours(central)).map((i) => i.code)).not.toContain(`${RUN}-PIZ-H`);
  });

  it('writes nothing: the menu reads the same twice', async () => {
    const first = await ours(central);
    const second = await ours(central);
    expect(second).toEqual(first);
  });
});
