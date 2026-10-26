import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { account, appRegistry, box, branch, deployEvent, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import { suiteAppsOf } from '../src/services/suite-controls';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
let actorId: string, own: string, platformRole: string, readRole: string, unrelatedRole: string;
const now = new Date('2026-10-27T01:00:00.000Z');
beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  platformRole = (await ctx.db.select().from(role).where(isNull(role.operatorId))).find(row => row.name === 'platform_admin')!.id;
  readRole = newId(); unrelatedRole = newId();
  await ctx.db.insert(role).values([
    { id: readRole, operatorId: own, name: 'ZZ TEST suite reader' },
    { id: unrelatedRole, operatorId: own, name: 'ZZ TEST unrelated suite role' },
  ]);
  await ctx.db.insert(rolePermission).values(['console:app_registry:read', 'console:release:read'].map(permission => ({
    id: newId(), roleId: readRole, permission,
  })));
  await ctx.db.insert(appRegistry).values([
    { key: 'console' as const, tileState: 'open' as const, sortOrder: 2 },
    { key: 'pos' as const, tileState: 'coming_soon' as const, sortOrder: 1 },
    { key: 'radar' as const, tileState: 'hidden' as const, sortOrder: 3, archivedAt: now },
  ].map(row => ({
    id: newId(), name: `ZZ TEST ${row.key}`, purpose: 'ZZ TEST directory purpose',
    originUrls: { staging: 'https://example.test', invalid: 'https://example.test/?credential=ZZ_TEST_SENTINEL' },
    schemaName: 'core', owningService: 'ZZ TEST api', versionSource: 'APP_CHANGE_ID',
    requiredPermission: `app:${row.key}:access`, ...row,
  })));
  await ctx.db.insert(deployEvent).values([
    { id: newId(), app: 'console', status: 'live', version: null, commit: null, actorAccountId: null, ciGreen: null, deployedAt: null, createdAt: now },
    { id: newId(), app: 'pos', status: 'failed', version: 'ZZ TEST version', commit: 'ZZ TEST commit', actorAccountId: actorId, ciGreen: false, deployedAt: null, createdAt: new Date(now.getTime() - 1000) },
    { id: newId(), app: 'radar', status: 'live', createdAt: new Date(now.getTime() + 1000) },
  ]);
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });
async function grant(roleId: string, scopeType: 'operator' | 'branch', scopeId: string | null) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: actorId, roleId, scopeType, scopeId });
}
beforeEach(async () => { await grant(platformRole, 'operator', null); });
const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

describe('SCRUM-643 suite controls read contract', () => {
  for (const [url, collection] of [['/console/apps', 'apps'], ['/console/releases', 'deployments']] as const) {
    it(`R1 high: ${url} refuses an anonymous read before returning platform metadata`, async () => {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    });
    it(`R2 high: ${url} returns its typed current records to the administrator`, async () => {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const body = response.json();
      expect(Array.isArray(body[collection])).toBe(true);
      expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
    });
  }
  it('R3 high: permission and operator scope remain independent gates for both reads', async () => {
    for (const url of ['/console/apps', '/console/releases']) {
      await grant(unrelatedRole, 'operator', own); expect((await get(url)).statusCode).toBe(403);
      await grant(readRole, 'branch', newId()); expect((await get(url)).statusCode).toBe(403);
      await grant(readRole, 'operator', own); expect((await get(url)).statusCode).toBe(200);
    }
  });
  it('R4 high: registry reads exclude archived apps and unsafe URL material', async () => {
    const response = await get('/console/apps'); expect(response.statusCode).toBe(200);
    const body = response.json(); expect(body.apps.map((row: { key: string }) => row.key)).toEqual(['pos', 'console']);
    expect(body.apps.every((row: { origins: object }) => JSON.stringify(row.origins) === JSON.stringify({ staging: 'https://example.test' }))).toBe(true);
    expect(response.body).not.toContain('ZZ_TEST_SENTINEL');
  });
  it('R5 high: maintenance expires at the exact boundary and restores the saved state without a read write', async () => {
    await ctx.db.update(appRegistry).set({ tileState: 'maintenance', maintenanceMessage: 'ZZ TEST brief maintenance',
      maintenanceExpiresAt: now, maintenanceRestoreState: 'hidden' }).where(eq(appRegistry.key, 'console'));
    const before = await ctx.db.select().from(appRegistry).where(eq(appRegistry.key, 'console'));
    const active = (await suiteAppsOf(ctx.db, new Date(now.getTime() - 1))).apps.find(row => row.key === 'console')!;
    expect(active.effectiveState).toBe('maintenance'); expect(active.maintenance?.message).toBe('ZZ TEST brief maintenance');
    const expired = (await suiteAppsOf(ctx.db, now)).apps.find(row => row.key === 'console')!;
    expect(expired.effectiveState).toBe('hidden'); expect(expired.maintenance).toBeNull(); expect(expired.storedState).toBe('maintenance');
    expect(await ctx.db.select().from(appRegistry).where(eq(appRegistry.key, 'console'))).toEqual(before);
  });
  it('R6 high: release history preserves unknown facts, stable pagination and app filtering', async () => {
    const response = await get('/console/releases?limit=1'); expect(response.statusCode).toBe(200);
    const first = response.json(); expect(first.total).toBe(2); expect(first.deployments).toHaveLength(1);
    expect(first.deployments[0]).toMatchObject({ app: 'console', version: null, commit: null, actorAccountId: null, ciGreen: null, deployedAt: null });
    const next = (await get('/console/releases?limit=1&offset=1')).json(); expect(next.deployments[0].app).toBe('pos');
    const filtered = (await get('/console/releases?app=pos')).json(); expect(filtered.total).toBe(1); expect(filtered.deployments[0].ciGreen).toBe(false);
    expect((await get('/console/releases?app=unknown')).statusCode).toBe(400);
    expect((await get('/console/releases?limit=1000')).statusCode).toBe(400);
  });
  it('R7 high: agent release facts require operator read scope and fence both box and branch ownership', async () => {
    const url = '/console/releases/agents';
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const branches = await ctx.db.select().from(branch).where(isNull(branch.archivedAt));
    const ownBranch = branches.find(row => row.operatorId === own)!;
    const otherBranch = branches.find(row => row.operatorId !== own)!;
    const ids = [newId(), newId(), newId(), newId()];
    await ctx.db.insert(box).values([
      { id: ids[0]!, operatorId: own, branchId: ownBranch.id, name: 'ZZ TEST old release', slot: ids[0]!, agentVersion: '0.0.0' },
      { id: ids[1]!, operatorId: own, branchId: ownBranch.id, name: 'ZZ TEST unknown release', slot: ids[1]!, agentVersion: null, lastStatus: { agentVersion: '' } },
      { id: ids[2]!, operatorId: otherBranch.operatorId, branchId: otherBranch.id, name: 'ZZ TEST other release', slot: ids[2]!, agentVersion: '0.0.0' },
      { id: ids[3]!, operatorId: own, branchId: otherBranch.id, name: 'ZZ TEST mismatched release', slot: ids[3]!, agentVersion: '0.0.0' },
    ]);
    await grant(readRole, 'branch', ownBranch.id); expect((await get(url)).statusCode).toBe(403);
    await grant(readRole, 'operator', own);
    const response = await get(url + '?limit=100'); expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json(); expect(body.operatorId).toBe(own);
    expect(body.minimumSupportedVersion).toBeTruthy();
    expect(body.agents.find((row: { id: string }) => row.id === ids[0])).toMatchObject({ agentVersion: '0.0.0', belowMinimum: true });
    expect(body.agents.find((row: { id: string }) => row.id === ids[1])).toMatchObject({ agentVersion: null, belowMinimum: null, lastHeartbeatAt: null });
    expect(body.agents.some((row: { id: string }) => ids.slice(2).includes(row.id))).toBe(false);
    expect(response.body).not.toMatch(/secretHash|claimCodeHash|syncPublicKey/);
    const page = (await get(url + '?limit=1')).json(); expect(page.agents).toHaveLength(1); expect(page.total).toBe(body.total);
    expect((await get(url + '?limit=1000')).statusCode).toBe(400);
  });
});
