import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, otoappUsers, partySlipPrint, product, productCategory } from '@oto/db';
import {
  PARTY_MENU_CATEGORY_CODE,
  PartyMenuProductAnswerSchema,
  businessDate,
  newId,
  parseDayStart,
  type PartySlipDocument,
} from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { readPartyPlan } from '../src/services/party-plan';
import { partyMenuCode, partyMenuProductId } from '../src/services/party-menu';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
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
 * SCRUM-828 — A NEW MENU ITEM ADDED FROM THE BEO, the platform's door.
 *
 * The OTO App's server, with its provisioning key, asks for an item its BEO
 * form added that the till's catalogue does not have yet; the platform makes it
 * a BEO-only product in the operator's "Party menu" category and answers its
 * code. Held here, against a real database with the OTO App's own tables built
 * by its migrations (0046 included):
 *
 *   - the door is the key's: no key or a wrong one is 401 before the body is
 *     read, the operator comes from the key, another operator's branch is
 *     not found, and an Idempotency-Key is required;
 *   - the category is made once and found again; each product is BEO-only,
 *     priced or free, its prep station the BEO's, its code `PARTY-` and eight
 *     hex digits, unique; both writes are audited, with the platform account
 *     of the app user who pressed as their actor and the app user's id kept;
 *   - the same key and body answer the same product (nothing new written); the
 *     same key with another body is refused 409;
 *   - the till's catalogue read leaves it out, the Console's read shows it
 *     marked, and a Console edit can turn the flag off and on;
 *   - a BEO line carrying its code reaches the party's plan through the OTO
 *     App's view, and its slips print it at the product's own station.
 */

const KEY = 'zz-test-private-party-menu-key-828';
const OTHER_KEY = 'zz-test-other-operator-party-menu-key-828';
const URL = '/otoapp/party-menu/products';

let ctx: TestContext;
let operatorId: string;
let otherOperatorId: string;
let central: string;
let otherBranch: string;
let reception: string;
let admin: string;
/** The OTO App user who presses, stamped with the reception account, in a park group of this operator. */
let presser: string;
let presserAccountId: string;
/** An OTO App user of the same park group with no suite sign-in yet. */
let unstamped: string;
/** That park group, and its park: the app's branch anchored to Central Floresta (one app branch per platform branch). */
let appTenant: string;
let appPark: string;

const body = (over: Record<string, unknown> = {}) => ({
  branchId: central,
  name: 'ZZ TEST unicorn cake',
  station: 'kitchen',
  priceSatang: null,
  free: true,
  source: { eventId: newId(), lineLabel: 'ZZ TEST unicorn cake' },
  actorAppUserId: presser,
  ...over,
});

const door = (payload: unknown, opts: { key?: string | null; idem?: string | null } = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: URL,
    headers: {
      ...(opts.key === null ? {} : { authorization: `Bearer ${opts.key ?? KEY}` }),
      ...(opts.idem === null ? {} : { 'idempotency-key': opts.idem ?? newId() }),
    },
    payload: payload as Record<string, unknown>,
  });

const tillMenu = async (cookie: string, query = '') => {
  const res = await ctx.app.inject({ method: 'GET', url: `/branches/${central}/menu${query}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { products: Array<{ id: string; code: string | null; beoOnly: boolean }> };
};

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  otherOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  otherBranch = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(KEY)},${otherOperatorId}:${otoAppProvisionKeyDigest(OTHER_KEY)}`;
  await ctx.restart();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  // The OTO App's people, in a park group anchored to Central Floresta.
  const [receptionAccount] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
  presserAccountId = receptionAccount!.id;
  const tenant = newId();
  const park = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${tenant}, 'ZZ TEST 828', ${`zz-828-${tenant}`})`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${park}, ${tenant}, 'ZZ TEST 828 park', 'Phuket', ${central})`);
  appTenant = tenant;
  appPark = park;
  const appUser = async (platformUserId: string | null) => {
    const id = newId();
    await ctx.db.insert(otoappUsers).values({
      id,
      email: `zz-828-${id}@example.test`,
      password: 'not-a-real-hash',
      fullName: 'ZZ TEST 828 staff',
      role: 'staff',
      isActive: true,
      mustChangePassword: false,
      platformUserId,
    });
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values (${newId()}, ${tenant}, ${id}, ${park}, 'selected_branches')`,
    );
    return id;
  };
  presser = await appUser(presserAccountId);
  unstamped = await appUser(null);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the code generator', () => {
  it('is PARTY- and the id’s last eight hex digits, upper case; twelve when asked; the same id, the same code', () => {
    const id = '01970f3a-1b2c-7d4e-9f00-a1b2c3d4e5f6';
    expect(partyMenuCode(id)).toBe('PARTY-C3D4E5F6');
    expect(partyMenuCode(id, 12)).toBe('PARTY-A1B2C3D4E5F6');
    expect(partyMenuCode(id.toUpperCase())).toBe('PARTY-C3D4E5F6');
    expect(partyMenuCode(id)).toBe(partyMenuCode(id));
    // A code the menu's own rule accepts (A-Z, 0-9, hyphen; 2 to 32 characters).
    expect(partyMenuCode(id, 12)).toMatch(/^[A-Z0-9_-]{2,32}$/);
  });

  it('refuses what is not an id, and a length outside 4 to 12', () => {
    expect(() => partyMenuCode('not-a-uuid')).toThrow();
    expect(() => partyMenuCode(newId(), 3)).toThrow();
    expect(() => partyMenuCode(newId(), 13)).toThrow();
  });

  it('a key names one product per operator: the same key, the same id; another key or operator, another', () => {
    const key = newId();
    const a = partyMenuProductId('01970f3a-1b2c-7d4e-9f00-a1b2c3d4e5f6', key);
    expect(a).toBe(partyMenuProductId('01970f3a-1b2c-7d4e-9f00-a1b2c3d4e5f6', key));
    expect(a).not.toBe(partyMenuProductId('01970f3a-1b2c-7d4e-9f00-a1b2c3d4e5f6', newId()));
    expect(a).not.toBe(partyMenuProductId('01970f3a-1b2c-7d4e-9f00-000000000001', key));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('two thousand products’ codes are two thousand codes', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => partyMenuCode(partyMenuProductId(newId(), newId()))));
    expect(codes.size).toBe(2000);
  });
});

describe('the door is the OTO App server’s, by its key', () => {
  it('no key, or a key this platform does not hold: 401 before the body is read, and nothing written', async () => {
    const before = await ctx.db.select({ id: product.id }).from(product);
    const none = await door({ nonsense: true }, { key: null });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('OTOAPP_PROVISION_UNAUTHORIZED');
    const wrong = await door(body(), { key: 'zz-not-a-key' });
    expect(wrong.statusCode).toBe(401);
    const route = ctx.app.routeRegistry.find((r) => r.method === 'POST' && r.url === URL);
    expect(route?.config.credential).toBe('otoapp-provision');
    expect(route?.config.public).not.toBe(true);
    expect(await ctx.db.select({ id: product.id }).from(product)).toHaveLength(before.length);
  });

  it('a session alone is no key: the till’s staff cannot call it', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: URL, headers: { cookie: admin, 'idempotency-key': newId() }, payload: body() });
    expect(res.statusCode).toBe(401);
  });

  it('asks for an Idempotency-Key', async () => {
    const res = await door(body(), { idem: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('An Idempotency-Key is required');
  });

  it('the operator is the key’s: another operator’s branch is not found, and nothing is made', async () => {
    const res = await door(body({ branchId: otherBranch }));
    expect(res.statusCode).toBe(404);
    const theirs = await door(body({ branchId: otherBranch }), { key: OTHER_KEY });
    expect(theirs.statusCode, theirs.body).toBe(200);
    const [row] = await ctx.db.select().from(product).where(eq(product.id, theirs.json().productId));
    expect(row).toMatchObject({ operatorId: otherOperatorId, branchId: otherBranch, beoOnly: true });
  });

  it('a price or the free tick, not both and not neither: 400, nothing made', async () => {
    const before = await ctx.db.select({ id: product.id }).from(product);
    const neither = await door(body({ free: false, priceSatang: null }));
    expect(neither.statusCode).toBe(400);
    expect(neither.json().error.message).toMatch(/Give the item a price/);
    const zero = await door(body({ free: false, priceSatang: 0 }));
    expect(zero.statusCode).toBe(400);
    const both = await door(body({ free: true, priceSatang: 45_000 }));
    expect(both.statusCode).toBe(400);
    expect(both.json().error.message).toMatch(/has no price/);
    const station = await door(body({ station: 'none' }));
    expect(station.statusCode).toBe(400);
    expect(await ctx.db.select({ id: product.id }).from(product)).toHaveLength(before.length);
  });
});

describe('what it makes', () => {
  let cake: { productId: string; code: string; categoryId: string };
  let tea: { productId: string; code: string; categoryId: string };

  it('a free kitchen item: the Party menu category made once, a BEO-only product priced 0 at the kitchen, a PARTY- code, audited', async () => {
    const key = newId();
    const res = await door(body(), { idem: key });
    expect(res.statusCode, res.body).toBe(200);
    const answer = PartyMenuProductAnswerSchema.parse(res.json());
    expect(answer.replayed).toBe(false);
    expect(answer.code).toMatch(/^PARTY-[0-9A-F]{8}$/);
    expect(answer.productId).toBe(partyMenuProductId(operatorId, key));
    cake = answer;

    const [row] = await ctx.db.select().from(product).where(eq(product.id, answer.productId));
    expect(row).toMatchObject({
      operatorId,
      branchId: central,
      categoryId: answer.categoryId,
      kind: 'menu',
      code: answer.code,
      name: 'ZZ TEST unicorn cake',
      priceSatang: 0,
      prepStationOverride: 'kitchen',
      beoOnly: true,
      active: true,
      archivedAt: null,
    });
    const [category] = await ctx.db.select().from(productCategory).where(eq(productCategory.id, answer.categoryId));
    expect(category).toMatchObject({
      operatorId,
      code: PARTY_MENU_CATEGORY_CODE,
      name: 'Party menu',
      parentId: null,
      taxableCategory: 'fnb',
      archivedAt: null,
    });

    const made = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'party_menu_product.create'), eq(auditLog.entityId, answer.productId)));
    expect(made).toHaveLength(1);
    // Who pressed: the platform account stamped on the app user, and the app user's id beside it.
    expect(made[0]).toMatchObject({ operatorId, branchId: central, actorAccountId: presserAccountId, entityType: 'product', actionId: key });
    expect(made[0]!.after).toMatchObject({
      code: answer.code,
      beoOnly: true,
      free: true,
      via: 'otoapp_provision_key',
      actorAppUserId: presser,
    });
    const categoryMade = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'menu_category.create'), eq(auditLog.entityId, answer.categoryId)));
    expect(categoryMade).toHaveLength(1);
    expect(categoryMade[0]).toMatchObject({ actorAccountId: presserAccountId });
    expect(categoryMade[0]!.after).toMatchObject({ actorAppUserId: presser });
  });

  it('somebody with no suite sign-in may add an item too: no platform actor, their app user id kept', async () => {
    const res = await door(body({ name: 'ZZ TEST lemonade', actorAppUserId: unstamped }));
    expect(res.statusCode, res.body).toBe(200);
    const [made] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'party_menu_product.create'), eq(auditLog.entityId, res.json().productId)));
    expect(made).toMatchObject({ actorAccountId: null });
    expect(made!.after).toMatchObject({ actorAppUserId: unstamped });
  });

  it('who pressed is asked for: a body without it is 400, and nothing is made', async () => {
    const before = await ctx.db.select({ id: product.id }).from(product);
    const without: Record<string, unknown> = body();
    delete without.actorAppUserId;
    const res = await door(without);
    expect(res.statusCode).toBe(400);
    expect(await ctx.db.select({ id: product.id }).from(product)).toHaveLength(before.length);
  });

  it('a priced bar item: the same category, never a second one; its own code; the price and the bar station kept', async () => {
    const res = await door(body({ name: 'ZZ TEST bubble tea', station: 'bar', free: false, priceSatang: 12_500 }));
    expect(res.statusCode, res.body).toBe(200);
    tea = PartyMenuProductAnswerSchema.parse(res.json());
    expect(tea.categoryId).toBe(cake.categoryId);
    expect(tea.code).not.toBe(cake.code);
    const [row] = await ctx.db.select().from(product).where(eq(product.id, tea.productId));
    expect(row).toMatchObject({ priceSatang: 12_500, prepStationOverride: 'bar', beoOnly: true, name: 'ZZ TEST bubble tea' });
    const categories = await ctx.db
      .select()
      .from(productCategory)
      .where(
        and(
          eq(productCategory.operatorId, operatorId),
          eq(productCategory.code, PARTY_MENU_CATEGORY_CODE),
          isNull(productCategory.archivedAt),
        ),
      );
    expect(categories).toHaveLength(1);
  });

  it('a code another live product already carries is not taken: the longer code instead', async () => {
    const key = newId();
    const id = partyMenuProductId(operatorId, key);
    const [anyCategory] = await ctx.db.select({ id: productCategory.id }).from(productCategory).where(eq(productCategory.id, cake.categoryId));
    await ctx.db.insert(product).values({
      id: newId(), operatorId, branchId: central, categoryId: anyCategory!.id, kind: 'menu', code: partyMenuCode(id), name: 'ZZ TEST squatter', priceSatang: 100,
    });
    const res = await door(body({ name: 'ZZ TEST second cake' }), { idem: key });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().code).toBe(partyMenuCode(id, 12));
  });

  it('the same key and body again: the same product, replayed, and nothing new written', async () => {
    const key = newId();
    const sent = body({ name: 'ZZ TEST rainbow jelly' });
    const first = await door(sent, { idem: key });
    expect(first.statusCode, first.body).toBe(200);
    const productsBefore = await ctx.db.select({ id: product.id }).from(product);
    const auditBefore = await ctx.db.select({ id: auditLog.id }).from(auditLog);
    const again = await door(sent, { idem: key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ ...first.json(), replayed: true });
    // Who pressed is not part of the request: a colleague's retry of the press is the same press.
    const colleague = await door({ ...sent, actorAppUserId: unstamped }, { idem: key });
    expect(colleague.statusCode, colleague.body).toBe(200);
    expect(colleague.json()).toEqual({ ...first.json(), replayed: true });
    expect(await ctx.db.select({ id: product.id }).from(product)).toHaveLength(productsBefore.length);
    expect((await ctx.db.select({ id: auditLog.id }).from(auditLog)).length).toBe(auditBefore.length);
  });

  it('two presses of the same key at once make one product', async () => {
    const key = newId();
    const sent = body({ name: 'ZZ TEST twin cake' });
    const [a, b] = await Promise.all([door(sent, { idem: key }), door(sent, { idem: key })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().productId).toBe(b.json().productId);
    expect([a.json().replayed, b.json().replayed].sort()).toEqual([false, true]);
    expect(await ctx.db.select().from(product).where(eq(product.id, a.json().productId))).toHaveLength(1);
  });

  it('the same key with another body: 409, and the product made under it is untouched', async () => {
    const key = newId();
    const first = await door(body({ name: 'ZZ TEST mango pudding' }), { idem: key });
    expect(first.statusCode).toBe(200);
    const [before] = await ctx.db.select().from(product).where(eq(product.id, first.json().productId));
    const other = await door(body({ name: 'ZZ TEST something else' }), { idem: key });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
    const [after] = await ctx.db.select().from(product).where(eq(product.id, first.json().productId));
    expect(after).toEqual(before);
  });

  it('the till’s catalogue leaves it out; the Console’s read shows it marked; the Console can turn the flag off and on', async () => {
    const till = await tillMenu(reception);
    expect(till.products.some((p) => p.id === cake.productId || p.id === tea.productId)).toBe(false);
    expect(till.products.every((p) => p.beoOnly === false)).toBe(true);

    const consoleRead = await tillMenu(admin, '?includeBeoOnly=true');
    expect(consoleRead.products.find((p) => p.id === cake.productId)).toMatchObject({ code: cake.code, beoOnly: true });
    expect(consoleRead.products.find((p) => p.id === tea.productId)).toMatchObject({ code: tea.code, beoOnly: true });

    const flip = (beoOnly: boolean) =>
      ctx.app.inject({
        method: 'PATCH',
        url: `/branches/${central}/menu/products/${cake.productId}`,
        headers: { cookie: admin, 'idempotency-key': newId() },
        payload: { beoOnly },
      });
    expect((await flip(false)).statusCode).toBe(200);
    expect((await tillMenu(reception)).products.find((p) => p.id === cake.productId)).toMatchObject({ beoOnly: false });
    expect((await flip(true)).statusCode).toBe(200);
    expect((await tillMenu(reception)).products.some((p) => p.id === cake.productId)).toBe(false);
    // Reception may read the menu but not turn the flag.
    const refused = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${central}/menu/products/${cake.productId}`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { beoOnly: false },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('a BEO line carrying its code reaches the party’s plan, and the slips print each item at its own station', async () => {
    const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
    const today = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
    const tenant = appTenant;
    const appBranch = appPark;
    const eventId = newId();
    await ctx.db.execute(sql`
      insert into otoapp.core_events (
        id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
        num_children, num_adults, location_text, status, created_at, updated_at)
      values (
        ${eventId}, ${tenant}, ${appBranch}, 'birthday', 'ZZ TEST BEO 828', ${today}, '13:00', '16:00',
        10, 4, 'Party room 1', 'upcoming', now() at time zone 'UTC', now() at time zone 'UTC')`);
    await ctx.db.execute(sql`
      insert into otoapp.beo_package_snapshots (id, event_id, package_name, base_price, slips_time)
      values (${newId()}, ${eventId}, 'ZZ TEST package', 1690000, '11:00'::time)`);
    // The kitchen plan as the BEO's "New item" writes it: a typed line with no
    // code (the kitchen's by name, and not a till line), and the two new items.
    const menus = {
      kidsFoodTime: '14:00',
      kids: [
        { id: 'menu_typed', itemName: 'ZZ TEST typed dish', quantity: 2, notes: '', included: false, price: 0 },
        { id: `party_${newId()}`, itemName: 'ZZ TEST unicorn cake', quantity: 1, notes: '', included: true, price: 0, productCode: cake.code },
      ],
      adults: [
        { id: `party_${newId()}`, itemName: 'ZZ TEST bubble tea', quantity: 4, notes: 'no ice', included: false, price: 125, productCode: tea.code },
      ],
    };
    await ctx.db.execute(sql`
      insert into otoapp.beo_kitchen_plans (id, event_id, set_menu_enabled, menus, kitchen_ready_offset_minutes)
      values (${newId()}, ${eventId}, false, ${JSON.stringify(menus)}::jsonb, 20)`);

    const read = await readPartyPlan(ctx.db, { branchId: central, eventId });
    expect(read.status).toBe('ready');
    expect(read.plan!.setMenu).toEqual([
      { productCode: cake.code, name: 'ZZ TEST unicorn cake', qty: 1, choiceGroup: null, chosenOption: null, note: null },
      { productCode: tea.code, name: 'ZZ TEST bubble tea', qty: 4, choiceGroup: null, chosenOption: null, note: 'no ice' },
    ]);

    const printed = await ctx.app.inject({
      method: 'POST',
      url: `/parties/${eventId}/slips/print`,
      headers: { cookie: reception },
      payload: { branchId: central },
    });
    expect(printed.statusCode, printed.body).toBe(200);
    const slips = await ctx.db.select().from(partySlipPrint).where(eq(partySlipPrint.eventId, eventId));
    const lines = (station: string) => (slips.find((s) => s.station === station)?.document as PartySlipDocument | null)?.lines;
    expect(lines('kitchen')).toEqual([{ qty: 1, name: 'ZZ TEST unicorn cake' }]);
    expect(lines('bar')).toEqual([{ qty: 4, name: 'ZZ TEST bubble tea', note: 'no ice' }]);
  });
});
