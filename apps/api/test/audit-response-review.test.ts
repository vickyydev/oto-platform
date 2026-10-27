import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { account, auditLog, employee, operator, role, roleAssignment, rolePermission } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

type Entry = {
  id: string; action: string; entityType: string; entityId: string; actorAccountId: string | null;
  actorName: string | null; branchId: string | null; requestId: string | null;
  before: unknown; after: unknown; createdAt: string;
  app: string | null; targetApp: string | null; category: string | null;
};
type Page = { entries: Entry[]; masked: boolean; nextCursor: string | null; total?: number };
// SCRUM-644 (Q25) adds three nullable labels, additively: app, targetApp and category.
const entryKeys = ['id', 'action', 'entityType', 'entityId', 'actorAccountId', 'actorName', 'branchId', 'requestId', 'before', 'after', 'createdAt',
  'app', 'targetApp', 'category'].sort();
const action = 'zz.test.644.response', foreign = newId(), actor = newId(), actorEmployee = newId(), sourceEvent = newId();
const values: unknown[] = [null, false, 0, 'ZZ TEST primitive', [1, false, { label: 'ZZ TEST nested' }],
  { label: 'ZZ TEST object', nested: [{ name: 'ZZ TEST private name', enabled: false }], empty: null }];
const ids = values.map(() => newId());
const stamp = new Date('2026-10-27T00:00:00.000Z');
let ctx: TestContext, admin: string, reader: string, owner: string;

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [home] = await ctx.db.select({ operatorId: account.operatorId }).from(account)
    .where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  owner = home!.operatorId;
  await ctx.db.insert(operator).values({ id: foreign, name: 'ZZ TEST 644 foreign operator' });
  await ctx.db.insert(employee).values({ id: actorEmployee, operatorId: owner, name: 'ZZ TEST 644 audit actor' });
  await ctx.db.insert(account).values({ id: actor, operatorId: owner, employeeId: actorEmployee, phone: 'ZZ TEST 644 audit actor' });
  const readerId = newId(), readerRole = newId(), phone = normalizePhone('+66900000644')!;
  const password = randomBytes(24).toString('hex');
  await ctx.db.insert(account).values({ id: readerId, operatorId: owner, phone,
    passwordHash: await hash(password), phoneVerifiedAt: new Date(), status: 'active', mustChangePassword: false });
  await ctx.db.insert(role).values({ id: readerRole, operatorId: owner, name: 'ZZ TEST 644 audit read only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: readerRole, permission: 'admin:audit:read' });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: readerId, roleId: readerRole, scopeType: 'operator', scopeId: owner });
  reader = await signInAs(ctx.app, phone, password);
  await ctx.db.insert(auditLog).values(values.map((value, i) => ({ id: ids[i]!, operatorId: owner,
    actorAccountId: i === 0 ? null : actor, action, entityType: 'ZZ TEST audit response', entityId: 'ZZ TEST 644 ' + i,
    requestId: i === 0 ? null : 'ZZ-TEST-644-' + i, before: value, after: value, createdAt: stamp,
    homeOperatorId: owner, effectiveOperatorId: foreign, actionId: 'ZZ TEST retained action', sourceEventId: sourceEvent })));
  await ctx.db.insert(auditLog).values({ id: newId(), operatorId: foreign, action,
    entityType: 'ZZ TEST foreign response', entityId: 'ZZ TEST foreign', before: { label: 'ZZ TEST foreign' } });
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function read(cookie: string, query = '') {
  const response = await ctx.app.inject({ method: 'GET', url: '/audit?action=' + action + query, headers: { cookie } });
  expect(response.statusCode, 'the native audit read succeeds without printing credentials or private bodies').toBe(200);
  return response.json() as Page;
}

describe('SCRUM-644 native audit response contract', () => {
  it('R1 high: the actual registered GET publishes a 200 JSON schema for every existing response field', async () => {
    const document = ctx.app.swagger() as { paths?: Record<string, { get?: { responses?: Record<string, {
      content?: Record<string, { schema?: { required?: string[]; properties?: Record<string, {
        items?: { required?: string[]; properties?: Record<string, unknown> };
      }> } }>;
    }> } }> };
    const route = document.paths?.['/audit/']?.get ?? document.paths?.['/audit']?.get;
    const schema = route?.responses?.['200']?.content?.['application/json']?.schema;
    expect(schema, 'the native route must declare its real response rather than leave the client untyped').toBeDefined();
    expect(schema?.required?.slice().sort()).toEqual(['entries', 'masked', 'nextCursor']);
    expect(schema?.properties?.entries?.items?.required?.slice().sort()).toEqual(entryKeys);
    expect(Object.keys(schema?.properties?.entries?.items?.properties ?? {}).sort()).toEqual(entryKeys);
  });

  it('R2 high: real HTTP preserves every current entry field, scalar/array/nested JSON and nullable actor metadata', async () => {
    const body = await read(admin);
    expect(Object.keys(body).sort()).toEqual(['entries', 'masked', 'nextCursor']);
    expect(body.masked).toBe(false); expect(body.nextCursor).toBeNull(); expect(body.entries).toHaveLength(values.length);
    for (const [i, id] of ids.entries()) {
      const entry = body.entries.find(e => e.id === id)!;
      expect(Object.keys(entry).sort()).toEqual(entryKeys);
      expect(entry).toEqual({ id, action, entityType: 'ZZ TEST audit response', entityId: 'ZZ TEST 644 ' + i,
        actorAccountId: i === 0 ? null : actor, actorName: i === 0 ? null : 'ZZ TEST 644 audit actor', branchId: null,
        requestId: i === 0 ? null : 'ZZ-TEST-644-' + i, before: values[i], after: values[i], createdAt: stamp.toISOString(),
        app: null, targetApp: null, category: null });
    }
    // Stored home/effective attribution and event pointers are not existing public entry fields.
    const [stored] = await ctx.db.select({ home: auditLog.homeOperatorId, effective: auditLog.effectiveOperatorId,
      actionId: auditLog.actionId, source: auditLog.sourceEventId }).from(auditLog).where(eq(auditLog.id, ids[0]!));
    expect(stored).toEqual({ home: owner, effective: foreign, actionId: 'ZZ TEST retained action', source: sourceEvent });
  });

  it('R3 critical: schema addition preserves native masking and excludes the other operator without inventing export/filter behavior', async () => {
    const body = await read(reader);
    expect(body.masked).toBe(true); expect(body.entries.map(e => e.id).sort()).toEqual([...ids].sort());
    for (const [i, id] of ids.entries()) {
      const entry = body.entries.find(e => e.id === id)!;
      const expected = i === values.length - 1
        ? { label: 'ZZ TEST object', nested: [{ name: '[redacted]', enabled: false }], empty: null } : values[i];
      expect(entry.before).toEqual(expected); expect(entry.after).toEqual(expected);
    }
    expect(ctx.smsLog).toHaveLength(0);
  });

  it('R4 high: count remains optional and the native keyset page/total semantics survive serialization', async () => {
    const first = await read(admin, '&count=true&limit=2');
    expect(first.total).toBe(values.length); expect(first.entries).toHaveLength(2); expect(typeof first.nextCursor).toBe('string');
    const second = await read(admin, '&count=true&limit=2&cursor=' + encodeURIComponent(first.nextCursor!));
    expect(second.total).toBe(values.length); expect(second.entries).toHaveLength(2);
    expect(second.entries.some(e => first.entries.some(previous => previous.id === e.id))).toBe(false);
    expect((await read(admin)).total).toBeUndefined();
  });
});
