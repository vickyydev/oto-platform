import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import { account, branch, role, roleAssignment, rolePermission, SETTING_CATALOGUE } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-646 house review. High: index metadata must not reveal another
 * operator, bypass a native page permission, expose values or seed on read.
 * Prescribed fix: scope the index and every fixed native door independently.
 * No provider, app handoff, source switch or setting write is dispatched.
 */
let ctx: TestContext;
let admin: string, denied: string, operatorId: string;
const ownBranch = newId(), archivedBranch = newId();
const read = (cookie = admin, query = '') => ctx.app.inject({
  method: 'GET', url: '/console/configuration' + query, headers: cookie ? { cookie } : {},
});
async function routeReady() {
  const response = await read();
  // Before every new-table fixture: RED must be native HTTP, not a missing import/table setup crash.
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [owner] = await ctx.db.select({ operatorId: account.operatorId }).from(account)
    .where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  operatorId = owner!.operatorId;
  await ctx.db.insert(branch).values([
    { id: ownBranch, operatorId, name: 'ZZ TEST 646 branch', code: 'zz-test-646' },
    { id: archivedBranch, operatorId, name: 'ZZ TEST 646 archived', code: 'zz-test-646-archived', archivedAt: new Date() },
  ]);
  const accountId = newId(), roleId = newId(), phone = normalizePhone('+66900001646')!;
  const password = randomBytes(24).toString('hex');
  await ctx.db.insert(account).values({ id: accountId, operatorId, phone, passwordHash: await hash(password),
    status: 'active', mustChangePassword: false, phoneVerifiedAt: new Date() });
  await ctx.db.insert(role).values({ id: roleId, operatorId, name: 'ZZ TEST 646 no configuration read' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'pos:print:read' });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId, roleId, scopeType: 'operator', scopeId: operatorId });
  denied = await signInAs(ctx.app, phone, password);
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

describe('Console configuration native read contract', () => {
  it('CONTROL: the native application is running without a provider action', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(ctx.smsLog).toHaveLength(0);
  });
  it('R1 high: a signed-out read is refused before any catalogue data', async () => {
    expect((await read('')).statusCode).toBe(401);
  });
  it('R2 high: an existing native page grant alone does not grant index access', async () => {
    expect((await read(denied)).statusCode).toBe(403);
  });
  it('R3 high: the read answers the synced catalogue and never writes a row', async () => {
    // Since SCRUM-643 landed the Q27 wiring, platform sync converges the
    // code-owned catalogue, so an authorized read answers those rows — but
    // the read itself still seeds nothing: the count is the catalogue's,
    // before and after, across repeated reads.
    const body = await routeReady();
    expect(body).toMatchObject({ operatorId, selectedBranchId: null });
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.entries.length).toBeGreaterThan(0);
    for (const entry of body.entries) expect(entry.supported).toBe(true);
    const before = await ctx.db.execute<{ count: number }>(
      // No setting values are read by this diagnostic.
      sql`select count(*)::int as count from core.setting_registry`,
    );
    await routeReady();
    const after = await ctx.db.execute<{ count: number }>(sql`select count(*)::int as count from core.setting_registry`);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toEqual([{ count: SETTING_CATALOGUE.length }]);
  });
  it('R4 high: an explicit live own branch is selected without borrowing the session seat', async () => {
    const response = await read(admin, `?branchId=${ownBranch}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ operatorId, selectedBranchId: ownBranch });
  });
  it('R5 high: an archived own branch is refused instead of widening the answer', async () => {
    expect((await read(admin, `?branchId=${archivedBranch}`)).statusCode).toBe(404);
  });
  it('R6 medium: unknown query fields and malformed branch identity are rejected', async () => {
    expect((await read(admin, '?value=ZZ_TEST_NOT_A_SETTING_VALUE')).statusCode).toBe(400);
    expect((await read(admin, '?branchId=ZZ_TEST_NOT_UUID')).statusCode).toBe(400);
  });
});
