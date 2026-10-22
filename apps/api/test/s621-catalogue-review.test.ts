import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, product, role, roleAssignment, rolePermission, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string, manager: string, outside: string;
let operatorId: string, outsideOperatorId: string, park: string, sibling: string;
const ticketBody = (name: string) => ({
  name: 'ZZ TEST ' + name, durationLabel: '2 hours', hours: 2,
  prices: { tourist: { weekday: 12345, weekend: 16789 } },
  adultRules: { tourist: { kind: 'set_price', price: { weekday: 4567, weekend: 6789 } } },
  creditRule: null, freebies: [], gateAccess: true, translations: { th: { name: 'ZZ TEST translated ticket' } },
});
function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, cookie = admin, key = newId()) {
  return ctx.app.inject({ method, url, headers: { cookie, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
}
const trail = (id: string, action: string) => ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));
const packagePath = (id = park) => '/branches/' + id + '/ticket-packages';
async function packages(id = park) {
  const response = await request('GET', packagePath(id));
  expect(response.statusCode).toBe(200);
  return response.json() as { packages: Array<{ id: string; name: string; [key: string]: unknown }> };
}
async function makeTicket(name: string, target = park) {
  const response = await request('POST', packagePath(target), ticketBody(name));
  expect(response.statusCode).toBe(200); return (response.json() as { id: string }).id;
}
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  outside = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  operatorId = (await request('GET', '/me')).json().account.operatorId as string;
  outsideOperatorId = (await request('GET', '/me', undefined, outside)).json().account.operatorId as string;
  park = (await request('GET', '/me', undefined, manager)).json().branch.id as string;
  sibling = newId();
  await ctx.db.insert(branch).values({ id: sibling, operatorId, code: 'zz-review-' + sibling, name: 'ZZ TEST Catalogue sibling' });
  const [caller] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  const scopedRole = newId();
  await ctx.db.insert(role).values({ id: scopedRole, operatorId, name: 'ZZ TEST Catalogue scoped reviewer' });
  await ctx.db.insert(rolePermission).values(
    ['admin:branch:update', 'catalog:package:read', 'catalog:package:create', 'catalog:package:update', 'catalog:menu:read', 'catalog:menu:manage'].map(permission => ({ id: newId(), roleId: scopedRole, permission })),
  );
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: caller!.id, roleId: scopedRole, scopeType: 'branch', scopeId: park });
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-621 independent catalogue review', () => {
  it('R1 [high] declares reconciliation operator-wide; fix: add the exact operator target while retaining the owned mirror service', () => {
    const route = ctx.app.routeRegistry.find(row => row.method === 'POST' && row.url === '/branches/oto-app/reconcile');
    expect(route?.config.permission).toBe('admin:branch:update');
    expect(route?.config.target).toEqual({ operator: true });
  });

  it('R2 [critical] a branch tier offer grants no operator-wide authority; fix: keep tier and reconciliation refusal before all writes', async () => {
    const before = await request('GET', '/tiers'), messages = ctx.smsLog.length;
    for (const [method, url, body] of [
      ['POST', '/tiers', { code: 'zz_scoped', name: 'ZZ TEST Refused scoped tier' }],
      ['PATCH', '/tiers/tourist', { name: 'ZZ TEST Refused rename' }],
      ['DELETE', '/tiers/tourist', undefined],
      ['POST', '/branches/oto-app/reconcile', undefined],
    ] as const) expect((await request(method, url, body, manager)).statusCode).toBe(403);
    expect((await request('GET', '/tiers')).json()).toEqual(before.json());
    expect(ctx.smsLog).toHaveLength(messages);
  });

  it('R3 [high] saves exact satang and package rules once under retry; fix: preserve canonical fields and transactional audit/idempotency', async () => {
    const body = ticketBody('Retry package'), key = newId(), url = packagePath();
    const first = await request('POST', url, body, manager, key), replay = await request('POST', url, body, manager, key);
    expect(first.statusCode).toBe(200); expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(first.json());
    const id = (first.json() as { id: string }).id;
    expect((await packages()).packages.find(row => row.id === id)).toMatchObject(body);
    expect(await trail(id, 'ticket_package.create')).toHaveLength(1);
    expect((await request('POST', url, { ...body, name: 'ZZ TEST Changed retry body' }, manager, key)).statusCode).toBe(409);
    const patchKey = newId(), patch = { prices: { tourist: { weekday: 23456, weekend: 27890 } } };
    for (let repeat = 0; repeat < 2; repeat++) expect((await request('PATCH', url + '/' + id, patch, manager, patchKey)).statusCode).toBe(200);
    expect((await packages()).packages.find(row => row.id === id)).toMatchObject({ ...body, ...patch });
    expect(await trail(id, 'ticket_package.update')).toHaveLength(1);
  });

  it('R4 [critical] foreign ticket ownership cannot hide behind an owned branch; fix: fence ticket reads and mutations by both operator and branch', async () => {
    const id = newId(), body = ticketBody('Foreign operator corruption');
    await ctx.db.insert(ticketPackage).values({ id, operatorId: outsideOperatorId, branchId: park, ...body });
    expect.soft((await packages()).packages.some(row => row.id === id)).toBe(false);
    expect.soft((await request('POST', packagePath(), { ...body, id })).statusCode).toBe(409);
    expect.soft((await request('PATCH', packagePath() + '/' + id, { name: 'ZZ TEST Must stay unchanged' })).statusCode).toBe(404);
    expect.soft((await request('DELETE', packagePath() + '/' + id)).statusCode).toBe(404);
    const [stored] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.id, id));
    expect.soft(stored).toMatchObject({ name: body.name, archivedAt: null });
    expect.soft(await trail(id, 'ticket_package.update')).toHaveLength(0);
    expect.soft(await trail(id, 'ticket_package.archive')).toHaveLength(0);
  });

  it('R5 [critical] a path park never authorizes another park package or add-on; fix: load the named row inside the actual operator/branch before editing', async () => {
    const ticket = await makeTicket('Sibling package', sibling);
    expect((await request('PATCH', packagePath() + '/' + ticket, { name: 'ZZ TEST Wrong path' }, manager)).statusCode).toBe(404);
    expect((await request('PATCH', packagePath(sibling) + '/' + ticket, { name: 'ZZ TEST Unreadable sibling' }, manager)).statusCode).toBe(403);
    const category = await request('POST', '/menu/categories', { code: 'ZZ-' + newId().replaceAll('-', '').slice(0, 20).toUpperCase(), name: 'ZZ TEST Add-on category', taxableCategory: 'addons' });
    expect(category.statusCode).toBe(200);
    const productPath = '/branches/' + sibling + '/menu/products';
    const created = await request('POST', productPath, { kind: 'addon', name: 'ZZ TEST Sibling add-on', categoryId: category.json().id as string, priceSatang: 1234, priceWeekendSatang: 2345 });
    expect(created.statusCode).toBe(200); const id = created.json().id as string;
    expect((await request('PATCH', '/branches/' + park + '/menu/products/' + id, { name: 'ZZ TEST Wrong add-on path' }, manager)).statusCode).toBe(404);
    expect((await request('PATCH', productPath + '/' + id, { name: 'ZZ TEST Foreign operator' }, outside)).statusCode).toBe(404);
    const [stored] = await ctx.db.select().from(product).where(eq(product.id, id));
    expect(stored).toMatchObject({ name: 'ZZ TEST Sibling add-on', priceSatang: 1234, priceWeekendSatang: 2345 });
    expect(await trail(id, 'menu_item.update')).toHaveLength(0);
  });

  it('R6 [high] an unused operator tier stays isolated and removable without changing defaults; fix: keep tenant code ownership and original baseline rules', async () => {
    const code = 'zz_' + newId().replaceAll('-', ''), before = (await request('GET', '/tiers')).json();
    expect((await request('POST', '/tiers', { code, name: 'ZZ TEST Owned unused tier', requiresVerification: true })).statusCode).toBe(200);
    expect((await request('PATCH', '/tiers/' + code, { name: 'ZZ TEST Foreign tier edit' }, outside)).statusCode).toBe(404);
    expect((await request('DELETE', '/tiers/' + code, undefined, outside)).statusCode).toBe(404);
    expect((await request('GET', '/tiers', undefined, outside)).json().tiers.some((row: { id: string }) => row.id === code)).toBe(false);
    expect((await request('DELETE', '/tiers/' + code)).statusCode).toBe(200);
    expect((await request('GET', '/tiers')).json()).toEqual(before);
  });
});
