import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account, branch, convergeSettingRegistry, operator, role, roleAssignment, rolePermission, setting,
  settingRegistry, SETTING_CATALOGUE,
} from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-646 Configuration index entries, after the catalogue converged.
 * Each entry is filtered by the owning page's own authority, navigation comes
 * from code rather than the stored row, an unsupported key offers nothing,
 * and only an explicit known document reports a real change time.
 */
interface Entry {
  id: string; key: string; label: string; appOwner: string; editableHere: boolean; requiredPermission: string;
  url: string | null; openInApp: { app: string; path: string } | null; supported: boolean;
  scope: 'operator' | 'branch'; branchIds: string[]; lastChangedAt: string | null;
  lastChangedAvailability: 'available' | 'not-recorded' | 'unsupported';
}
interface Index { generatedAt: string; operatorId: string; branches: { id: string; name: string }[]; selectedBranchId: string | null; entries: Entry[] }

let ctx: TestContext;
let cookie: string;
let actorId: string, own: string, foreign: string;
let parkA: string, parkB: string, archived: string, otherPark: string;
let indexRole: string, taxRole: string, tendersRole: string, templatesRole: string;
const unsupported = newId(), malformed = newId();

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select({ id: account.id, operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  foreign = newId(); parkA = newId(); parkB = newId(); archived = newId(); otherPark = newId();
  await ctx.db.insert(operator).values({ id: foreign, name: 'ZZ TEST 646 config foreign operator' });
  await ctx.db.insert(branch).values([
    { id: parkA, operatorId: own, name: 'ZZ TEST 646 config A', code: parkA },
    { id: parkB, operatorId: own, name: 'ZZ TEST 646 config B', code: parkB },
    { id: archived, operatorId: own, name: 'ZZ TEST 646 config archived', code: archived, archivedAt: new Date() },
    { id: otherPark, operatorId: foreign, name: 'ZZ TEST 646 config foreign', code: otherPark },
  ]);
  indexRole = newId(); taxRole = newId(); tendersRole = newId(); templatesRole = newId();
  await ctx.db.insert(role).values([
    { id: indexRole, operatorId: own, name: 'ZZ TEST 646 config index' },
    { id: taxRole, operatorId: own, name: 'ZZ TEST 646 config tax' },
    { id: tendersRole, operatorId: own, name: 'ZZ TEST 646 config tenders' },
    { id: templatesRole, operatorId: own, name: 'ZZ TEST 646 config templates' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: indexRole, permission: 'console:config:read' },
    { id: newId(), roleId: taxRole, permission: 'catalog:tax:manage' },
    { id: newId(), roleId: tendersRole, permission: 'catalog:menu:manage' },
    { id: newId(), roleId: templatesRole, permission: 'inbox:template:manage' },
  ]);
  await convergeSettingRegistry(ctx.db);
  await ctx.db.insert(settingRegistry).values([
    // Stored navigation must never be trusted, even on a row the code does not know.
    { id: unsupported, key: 'zz_test_646_unknown', label: 'ZZ TEST unknown', appOwner: 'radar',
      owningPageUrl: 'https://example.invalid/steal', editableHere: true, requiredPermission: 'catalog:menu:manage',
      lastChangedAt: new Date('2026-10-01T00:00:00.000Z') },
    { id: malformed, key: 'zz_test_646_malformed', label: 'ZZ TEST malformed', appOwner: 'platform',
      requiredPermission: 'not:a:permission' },
  ]);
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

type Grant = { roleId: string; scopeType: 'operator' | 'branch'; scopeId: string };
async function grants(rows: Grant[]) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  if (rows.length) await ctx.db.insert(roleAssignment).values(rows.map(row => ({ id: newId(), accountId: actorId, ...row })));
}
beforeEach(async () => grants([
  { roleId: indexRole, scopeType: 'branch', scopeId: parkA },
  { roleId: taxRole, scopeType: 'branch', scopeId: parkA },
]));
const get = (query = '') => ctx.app.inject({ method: 'GET', url: '/console/configuration' + query, headers: { cookie } });
async function read(query = ''): Promise<Index> {
  const response = await get(query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Index;
}
const keys = (body: Index) => body.entries.map(entry => entry.key).sort();
async function registryFingerprint() {
  const rows = await ctx.db.select().from(settingRegistry).orderBy(asc(settingRegistry.id));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

describe('SCRUM-646 Configuration index entries', () => {
  it('a branch-held page appears for that park only, with its fixed door and an honest unsupported change time', async () => {
    const body = await read();
    expect(body.branches).toEqual([{ id: parkA, name: 'ZZ TEST 646 config A' }]);
    expect(body.selectedBranchId).toBeNull();
    expect(body.entries).toHaveLength(1);
    const [tax] = body.entries;
    const stored = (await ctx.db.select().from(settingRegistry).where(eq(settingRegistry.key, 'branch_tax')))[0]!;
    expect(tax).toEqual({
      id: stored.id, key: 'branch_tax', label: 'Tax', appOwner: 'platform', editableHere: true,
      requiredPermission: 'catalog:tax:manage', url: '/catalogue/tax', openInApp: null, supported: true,
      scope: 'branch', branchIds: [parkA], lastChangedAt: null, lastChangedAvailability: 'unsupported',
    });
  });

  it('branch entries are narrowed to the parks the index itself reaches', async () => {
    await grants([
      { roleId: indexRole, scopeType: 'branch', scopeId: parkA },
      { roleId: taxRole, scopeType: 'operator', scopeId: own },
    ]);
    expect((await read()).entries.find(entry => entry.key === 'branch_tax')!.branchIds).toEqual([parkA]);
    await grants([
      { roleId: indexRole, scopeType: 'operator', scopeId: own },
      { roleId: taxRole, scopeType: 'branch', scopeId: parkB },
    ]);
    const body = await read();
    const listed = body.branches.map(park => park.id);
    expect(listed).toEqual(expect.arrayContaining([parkA, parkB]));
    expect(listed).not.toContain(archived);
    expect(listed).not.toContain(otherPark);
    expect(body.entries.find(entry => entry.key === 'branch_tax')!.branchIds).toEqual([parkB]);
    expect((await read(`?branchId=${parkA}`)).entries).toEqual([]);
    const selected = await read(`?branchId=${parkB}`);
    expect(selected.selectedBranchId).toBe(parkB);
    expect(selected.entries.map(entry => [entry.key, entry.branchIds])).toEqual([['branch_tax', [parkB]]]);
  });

  it('a selected park is never widened: own unreachable 403, foreign, unknown and archived 404', async () => {
    expect((await get(`?branchId=${parkB}`)).statusCode).toBe(403);
    for (const id of [otherPark, newId(), archived]) expect((await get(`?branchId=${id}`)).statusCode).toBe(404);
  });

  it('operator-only pages need an operator-wide native grant; a park grant does not stand in', async () => {
    await grants([
      { roleId: indexRole, scopeType: 'branch', scopeId: parkA },
      { roleId: tendersRole, scopeType: 'branch', scopeId: parkA },
    ]);
    expect(keys(await read())).toEqual([]);
    await grants([
      { roleId: indexRole, scopeType: 'branch', scopeId: parkA },
      { roleId: tendersRole, scopeType: 'operator', scopeId: own },
    ]);
    const body = await read();
    // The unknown stored row names an operator-wide permission held here, so it is listed without any door.
    expect(keys(body)).toEqual(['tenders', 'zz_test_646_unknown']);
    expect(body.entries.find(entry => entry.key === 'tenders')).toMatchObject({ scope: 'operator', branchIds: [], url: '/catalogue/tenders' });
    expect(body.entries.find(entry => entry.key === 'zz_test_646_unknown')).toEqual({
      id: unsupported, key: 'zz_test_646_unknown', label: 'ZZ TEST unknown', appOwner: 'radar', editableHere: false,
      requiredPermission: 'catalog:menu:manage', url: null, openInApp: null, supported: false, scope: 'operator',
      branchIds: [], lastChangedAt: null, lastChangedAvailability: 'unsupported',
    });
    expect(body.entries.some(entry => entry.key === 'zz_test_646_malformed')).toBe(false);
  });

  it('an app-owned setting keeps its app door and is never editable here', async () => {
    await grants([
      { roleId: indexRole, scopeType: 'branch', scopeId: parkA },
      { roleId: templatesRole, scopeType: 'branch', scopeId: parkB },
    ]);
    expect((await read()).entries).toEqual([expect.objectContaining({
      key: 'inbox_templates', appOwner: 'inbox', editableHere: false, url: null,
      openInApp: { app: 'inbox', path: '/?settings=templates' }, supported: true, scope: 'operator', branchIds: [],
    })]);
  });

  it('only the assistant settings document reports a real change time, and only once it exists', async () => {
    await grants([{ roleId: indexRole, scopeType: 'operator', scopeId: own }]);
    const adminRole = newId();
    await ctx.db.insert(role).values({ id: adminRole, operatorId: own, name: 'ZZ TEST 646 config assistant' });
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId: adminRole, permission: 'inbox:ai:manage' });
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: actorId, roleId: adminRole, scopeType: 'operator', scopeId: own });
    const assistant = async () => (await read()).entries.find(entry => entry.key === 'assistant_settings')!;
    expect(await assistant()).toMatchObject({ lastChangedAt: null, lastChangedAvailability: 'not-recorded' });
    const changed = new Date('2026-10-20T08:30:00.000Z');
    await ctx.db.insert(setting).values({ operatorId: own, key: 'assistant_settings', value: {}, updatedAt: changed });
    expect(await assistant()).toMatchObject({ lastChangedAt: changed.toISOString(), lastChangedAvailability: 'available' });
  });

  it('index access alone lists nothing, and reads never write the catalogue', async () => {
    await grants([{ roleId: indexRole, scopeType: 'branch', scopeId: parkA }]);
    const before = await registryFingerprint();
    expect((await read()).entries).toEqual([]);
    await read(`?branchId=${parkA}`);
    expect(await registryFingerprint()).toBe(before);
    expect((await ctx.db.select().from(settingRegistry)).length).toBe(SETTING_CATALOGUE.length + 2);
  });
});
