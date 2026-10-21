import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { schema } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-606 — the guard is asked about the right thing.
 *
 *   - A menu item is changed through the branch in its path, so an item of
 *     another park is not found there (it used to be updated: the guard checked
 *     the path's branch and the loader never compared the item's).
 *   - A setting the whole operator shares — a tier, a tender, a menu category,
 *     a discount — needs the permission at OPERATOR scope. It used to fall back
 *     to the session's branch, so a manager's grant at one park passed.
 *   - A voucher's product at one park is checked at that park.
 */

let ctx: TestContext;
let operatorId: string;
let central: string;
let chalong: string;
let admin: string;
let manager: string;
let chalongManager: string;
let chalongBooth: string;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const call = (method: Method, url: string, cookie: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);

  // An operator's own role carrying the booth permission, held at Chalong only.
  const roleId = newId();
  await ctx.db.insert(schema.role).values({ id: roleId, operatorId, name: 'Booth keeper (606)' });
  await ctx.db.insert(schema.rolePermission).values({ id: newId(), roleId, permission: 'admin:booth:manage' });
  const accountId = newId();
  await ctx.db.insert(schema.account).values({
    id: accountId,
    operatorId,
    phone: '+66900000606',
    status: 'active',
    passwordHash: await hash('booth1234'),
  });
  await ctx.db
    .insert(schema.roleAssignment)
    .values({ id: newId(), accountId, roleId, scopeType: 'branch', scopeId: chalong });
  chalongBooth = await signInAs(ctx.app, '+66900000606', 'booth1234');
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

async function categoryId(): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.productCategory.id })
    .from(schema.productCategory)
    .where(and(eq(schema.productCategory.operatorId, operatorId), isNull(schema.productCategory.archivedAt)))
    .limit(1);
  return row!.id;
}

async function itemAt(branchId: string | null, name: string): Promise<string> {
  const id = newId();
  await ctx.db.insert(schema.product).values({
    id,
    operatorId,
    branchId,
    categoryId: await categoryId(),
    name,
    priceSatang: 100_00,
  });
  return id;
}

describe('a menu item is changed at the branch in its path (SCRUM-606)', () => {
  it('an item of another park is not found through this park’s path, for the manager or the administrator', async () => {
    const chalongItem = await itemAt(chalong, 'Chalong only (606)');
    for (const cookie of [manager, admin]) {
      const patch = await call('PATCH', `/branches/${central}/menu/products/${chalongItem}`, cookie, {
        name: 'Moved by the wrong park',
      });
      expect(patch.statusCode, patch.body).toBe(404);
      const del = await call('DELETE', `/branches/${central}/menu/products/${chalongItem}`, cookie);
      expect(del.statusCode, del.body).toBe(404);
    }
    const [row] = await ctx.db.select().from(schema.product).where(eq(schema.product.id, chalongItem));
    expect(row!.name).toBe('Chalong only (606)');
    expect(row!.archivedAt).toBeNull();
  });

  it('its own park still changes it', async () => {
    const chalongItem = await itemAt(chalong, 'Chalong renamed (606)');
    const res = await call('PATCH', `/branches/${chalong}/menu/products/${chalongItem}`, chalongManager, {
      name: 'Renamed at Chalong',
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('an item on every park’s menu is changed at operator scope only', async () => {
    const shared = await itemAt(null, 'Every park (606)');
    const refused = await call('PATCH', `/branches/${central}/menu/products/${shared}`, manager, {
      name: 'One park decided',
    });
    expect(refused.statusCode, refused.body).toBe(403);
    const ok = await call('PATCH', `/branches/${central}/menu/products/${shared}`, admin, { name: 'Operator decided' });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('operator-wide settings need the permission at operator scope (SCRUM-606)', () => {
  const writes: Array<[Method, string, object]> = [
    ['POST', '/tiers', { code: 'mgr606', name: 'Manager tier', requiresVerification: false, sortOrder: 9 }],
    ['POST', '/payment-methods', { code: 'mgr606', label: 'Manager tender', kind: 'cash' }],
    ['POST', '/menu/discounts', { code: 'MGR606', label: 'Manager discount', kind: 'percent', valueBp: 1000, stackable: true }],
    ['POST', '/menu/categories', { code: 'MGR606', name: 'Manager category', taxableCategory: 'fnb', sortOrder: 9 }],
  ];

  it.each(writes)('a branch-scoped manager is refused %s %s', async (method, url, payload) => {
    const res = await call(method, url, manager, payload);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it.each(writes)('the operator administrator still does %s %s', async (method, url, payload) => {
    const res = await call(method, url, admin, payload);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a tier edit and a tender edit are refused to the manager too', async () => {
    expect((await call('PATCH', '/tiers/mgr606', manager, { name: 'Renamed' })).statusCode).toBe(403);
    expect((await call('PATCH', '/payment-methods/mgr606', manager, { label: 'Renamed' })).statusCode).toBe(403);
  });

  it('the manager still reads them', async () => {
    expect((await call('GET', '/tiers', manager)).statusCode).toBe(200);
    expect((await call('GET', '/payment-methods', manager)).statusCode).toBe(200);
    expect((await call('GET', '/menu/discounts', manager)).statusCode).toBe(200);
  });
});

describe('a voucher’s product at one park is checked at that park (SCRUM-606)', () => {
  it('a grant at Chalong does not reach Central’s link, from a Chalong seat', async () => {
    const unknown = newId();
    const there = await call('PUT', `/voucher-definitions/${unknown}/park-products/${central}`, chalongBooth, {
      productId: null,
    });
    expect(there.statusCode, there.body).toBe(403);
    // At its own park the guard lets it through, and the handler answers for the definition.
    const here = await call('PUT', `/voucher-definitions/${unknown}/park-products/${chalong}`, chalongBooth, {
      productId: null,
    });
    expect(here.statusCode, here.body).toBe(404);
  });

  it('nor does it change a voucher definition every park shares', async () => {
    const unknown = newId();
    const res = await call('DELETE', `/voucher-definitions/${unknown}`, chalongBooth);
    expect(res.statusCode, res.body).toBe(403);
    // The operator administrator passes the guard, and the handler answers for the row.
    expect((await call('DELETE', `/voucher-definitions/${unknown}`, admin)).statusCode).toBe(404);
  });
});
