import { randomInt, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  account, auditLog, branch, operator, product, productCategory, role, roleAssignment, rolePermission, taxOverride,
} from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import { createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-680 house review. Medium: an override must not store another park
 * group's reference or turn an unknown reference into an internal failure.
 * Prescribed fix: resolve category ownership and the native own-or-shared
 * product scope inside the write transaction before INSERT. No tax rule changes.
 */
describe('Tax override reference ownership (SCRUM-680)', () => {
  let ctx: TestContext | undefined, cookie: string | undefined;
  const own = newId(), foreign = newId(), park = newId(), sibling = newId(), foreignPark = newId();
  const caller = newId(), roleId = newId(), manageGrantId = newId();
  const categoryId = newId(), foreignCategoryId = newId();
  const ownProductId = newId(), sharedProductId = newId(), siblingProductId = newId(), foreignProductId = newId();
  const url = `/branches/${park}/tax-overrides`;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.db.insert(operator).values([
      { id: own, name: 'ZZ TEST 680 own operator' }, { id: foreign, name: 'ZZ TEST 680 foreign operator' },
    ]);
    await ctx.db.insert(branch).values([
      { id: park, operatorId: own, name: 'ZZ TEST 680 park', code: 'zz-680-' + park },
      { id: sibling, operatorId: own, name: 'ZZ TEST 680 sibling park', code: 'zz-680-' + sibling },
      { id: foreignPark, operatorId: foreign, name: 'ZZ TEST 680 foreign park', code: 'zz-680-' + foreignPark },
    ]);
    const phone = '+6698' + randomInt(1_000_000, 9_999_999), password = randomUUID();
    await ctx.db.insert(account).values({ id: caller, operatorId: own, phone,
      passwordHash: await hash(password), status: 'active', phoneVerifiedAt: new Date() });
    await ctx.db.insert(role).values({ id: roleId, operatorId: own, name: 'ZZ TEST 680 tax reviewer' });
    await ctx.db.insert(rolePermission).values([
      { id: newId(), roleId, permission: 'catalog:tax:read' },
      { id: manageGrantId, roleId, permission: 'catalog:tax:manage' },
    ]);
    await ctx.db.insert(roleAssignment).values({ id: newId(), roleId, accountId: caller, scopeType: 'operator', scopeId: own });
    await ctx.db.insert(productCategory).values([
      { id: categoryId, operatorId: own, name: 'ZZ TEST 680 own category', taxableCategory: 'fnb' },
      { id: foreignCategoryId, operatorId: foreign, name: 'ZZ TEST 680 foreign category', taxableCategory: 'fnb' },
    ]);
    await ctx.db.insert(product).values([
      { id: ownProductId, operatorId: own, branchId: park, categoryId, name: 'ZZ TEST 680 own product' },
      { id: sharedProductId, operatorId: own, branchId: null, categoryId, name: 'ZZ TEST 680 shared product' },
      { id: siblingProductId, operatorId: own, branchId: sibling, categoryId, name: 'ZZ TEST 680 sibling product' },
      { id: foreignProductId, operatorId: foreign, branchId: foreignPark, categoryId: foreignCategoryId, name: 'ZZ TEST 680 foreign product' },
    ]);
    cookie = await signInAs(ctx.app, phone, password);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    try {
      if (ctx && cookie) {
        expect((await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } })).statusCode).toBe(200);
        expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).statusCode).toBe(401);
      }
    } finally { try { await ctx?.close(); } finally { await teardownAll(); } }
  });

  const save = (body: object, key = newId(), target = url) => ctx!.app.inject({
    method: 'POST', url: target, headers: { cookie: cookie!, 'idempotency-key': key }, payload: body,
  });
  const stored = (id: string) => ctx!.db.select().from(taxOverride).where(eq(taxOverride.id, id));
  const successfulAudit = (id: string) => ctx!.db.select().from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'tax_override.create')));

  it('CONTROL: own operator category persists the exact override and one native audit', async () => {
    const id = newId(), body = { id, categoryId, vatRateBp: 700, serviceChargeBp: 500 };
    const response = await save(body);
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ id });
    expect(await stored(id)).toMatchObject([{ id, branchId: park, categoryId, productId: null, vatRateBp: 700, serviceChargeBp: 500 }]);
    expect(await successfulAudit(id)).toMatchObject([{ actorAccountId: caller, operatorId: own, branchId: park, after: bodyWithoutId(body) }]);
  });

  it.each([
    ['own branch product', ownProductId], ['operator-shared product with no branch', sharedProductId],
  ])('CONTROL: %s remains a valid reference', async (_label, productId) => {
    const id = newId(), response = await save({ id, productId, vatRateBp: 0 });
    expect(response.statusCode).toBe(200);
    expect(await stored(id)).toMatchObject([{ id, branchId: park, categoryId: null, productId, vatRateBp: 0 }]);
    expect(await successfulAudit(id)).toHaveLength(1);
  });

  it.each([
    ['foreign operator category', { categoryId: foreignCategoryId }, 'Category not found'],
    ['missing category', { categoryId: newId() }, 'Category not found'],
    ['foreign operator product', { productId: foreignProductId }, 'Product not found'],
    ['missing product', { productId: newId() }, 'Product not found'],
    ['sibling branch product', { productId: siblingProductId }, 'Product not found'],
  ] as const)('R1 medium: %s is a clear not-found refusal with no row or success audit', async (_label, reference, message) => {
    const id = newId(), response = await save({ id, ...reference, vatRateBp: 700 });
    expect.soft(response.statusCode).toBe(404);
    expect.soft(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message } });
    expect.soft(await stored(id)).toEqual([]);
    expect(await successfulAudit(id)).toEqual([]);
  });

  it('CONTROL: both own references preserve existing category/product override fields', async () => {
    const id = newId(), response = await save({ id, categoryId, productId: ownProductId, serviceChargeBp: 0 });
    expect(response.statusCode).toBe(200);
    expect(await stored(id)).toMatchObject([{ categoryId, productId: ownProductId, vatRateBp: null, serviceChargeBp: 0 }]);
  });

  it('R2 medium: a valid category cannot hide a foreign product in the same write', async () => {
    const id = newId(), response = await save({ id, categoryId, productId: foreignProductId, vatRateBp: 700 });
    expect.soft(response.statusCode).toBe(404);
    expect.soft(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
    expect.soft(await stored(id)).toEqual([]);
    expect(await successfulAudit(id)).toEqual([]);
  });

  it('CONTROL: header and client-id retries preserve one row/audit and the original body-id replay rule', async () => {
    const id = newId(), key = newId(), body = { id, categoryId, vatRateBp: 700 };
    const first = await save(body, key), retry = await save(body, key);
    expect(first.statusCode).toBe(200); expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    // Native client IDs identify an existing record; a fresh header key does not replace its fields.
    const named = await save({ id, productId: foreignProductId, vatRateBp: 999 });
    expect(named.statusCode).toBe(200); expect(named.headers['x-oto-replay']).toBe('true');
    expect(named.json()).toEqual({ id });
    expect(await stored(id)).toMatchObject([{ categoryId, productId: null, vatRateBp: 700 }]);
    expect(await successfulAudit(id)).toHaveLength(1);
    const elsewhere = await save({ id, categoryId }, newId(), `/branches/${sibling}/tax-overrides`);
    expect(elsewhere.statusCode).toBe(409); expect(elsewhere.json().error.code).toBe('ID_IN_USE');
  });

  it('CONTROL: withdrawn write permission refuses fresh and cached requests while reads remain available', async () => {
    const id = newId(), key = newId(), body = { id, categoryId, vatRateBp: 700 };
    expect((await save(body, key)).statusCode).toBe(200);
    await ctx!.db.delete(rolePermission).where(eq(rolePermission.id, manageGrantId));
    try {
      expect((await save(body, key)).statusCode).toBe(403);
      const refusedId = newId();
      expect((await save({ id: refusedId, categoryId })).statusCode).toBe(403);
      expect(await stored(refusedId)).toEqual([]); expect(await successfulAudit(refusedId)).toEqual([]);
      expect((await ctx!.app.inject({ method: 'GET', url, headers: { cookie: cookie! } })).statusCode).toBe(200);
      expect(await successfulAudit(id)).toHaveLength(1);
    } finally { await ctx!.db.insert(rolePermission).values({ id: manageGrantId, roleId, permission: 'catalog:tax:manage' }); }
  });

  it('CONTROL: audit failure rolls the insert back and a genuine same-key retry can succeed', async () => {
    const id = newId(), key = newId(), body = { id, categoryId, productId: ownProductId, vatRateBp: 700 };
    const original = audit.record.bind(audit);
    const failure = vi.spyOn(audit, 'record').mockImplementation(async (exec, event) => {
      if (event.action === 'tax_override.create') throw new Error('ZZ TEST 680 audit failure');
      return original(exec, event);
    });
    const response = await save(body, key);
    expect(response.statusCode).toBe(500);
    expect(await stored(id)).toEqual([]); expect(await successfulAudit(id)).toEqual([]);
    failure.mockRestore();
    expect((await save(body, key)).statusCode).toBe(200);
    expect(await stored(id)).toHaveLength(1); expect(await successfulAudit(id)).toHaveLength(1);
  });

  it('CONTROL: native tax bounds reject malformed values before a write', async () => {
    const id = newId(), response = await save({ id, categoryId, vatRateBp: -1 });
    expect(response.statusCode).toBe(400);
    expect(await stored(id)).toEqual([]); expect(await successfulAudit(id)).toEqual([]);
  });

  it('CONTROL: malformed path/body retain native 400 even when write permission was withdrawn', async () => {
    await ctx!.db.delete(rolePermission).where(eq(rolePermission.id, manageGrantId));
    try {
      expect((await save({ categoryId }, newId(), '/branches/not-a-uuid/tax-overrides')).statusCode).toBe(400);
      const id = newId();
      expect((await save({ id, categoryId, vatRateBp: -1 })).statusCode).toBe(400);
      expect(await stored(id)).toEqual([]); expect(await successfulAudit(id)).toEqual([]);
    } finally { await ctx!.db.insert(rolePermission).values({ id: manageGrantId, roleId, permission: 'catalog:tax:manage' }); }
  });

  it('R3 medium: the native create response contract declares its lossless UUID answer', () => {
    type Document = { paths: Record<string, { post?: { responses?: Record<string,
      { content?: Record<string, { schema?: unknown }> }> } }> };
    const doc = ctx!.app.swagger() as Document;
    const response = doc.paths['/branches/{branchId}/tax-overrides']?.post?.responses?.['200'];
    expect(response?.content?.['application/json']?.schema).toMatchObject({
      type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } },
    });
  });
});

function bodyWithoutId<T extends { id: string }>(body: T): Omit<T, 'id'> {
  const { id: _id, ...fields } = body;
  return fields;
}
