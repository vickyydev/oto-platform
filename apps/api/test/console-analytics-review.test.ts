import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  account, branch, branchSourceSwitch, dailySummary, dirtyDate, hourlySummary,
  operator, role, roleAssignment, rolePermission,
} from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const path = '/console/analytics';
const changedAt = new Date('2026-10-26T12:00:00.000Z');
const markedAt = new Date('2026-10-26T13:00:00.000Z');
let ctx: TestContext;
let cookie: string;
let actorId: string, own: string, foreign: string;
let parkA: string, parkB: string, archived: string, otherPark: string;
let bothRole: string, consoleRole: string, analyticsRole: string;

interface FormulaRows {
  source: 'oto_pos' | 'pisell' | 'papaya';
  formulaVersion: number;
  dailyRows: number;
  hourlyRows: number;
  frozenDailyRows: number;
  provisionalDailyRows: number;
}
interface MetadataBranch {
  branchId: string;
  name: string;
  source: 'oto_pos' | 'pisell' | 'papaya';
  preference: 'oto_pos' | 'legacy' | 'both';
  switchedAt: string | null;
  formulaRows: FormulaRows[];
  dirtyDates: {
    total: number;
    byKind: { sales: number; hourly: number; booth: number; wallet: number };
    oldestBusinessDate: string | null;
    newestMarkedAt: string | null;
  };
}
interface Metadata {
  generatedAt: string;
  basis: 'stored-summary-metadata';
  branches: MetadataBranch[];
  omitted: string[];
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select({ id: account.id, operatorId: account.operatorId })
    .from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  foreign = newId(); parkA = newId(); parkB = newId(); archived = newId(); otherPark = newId();
  await ctx.db.insert(operator).values({ id: foreign, name: 'ZZ TEST 646 foreign operator' });
  await ctx.db.insert(branch).values([
    { id: parkA, operatorId: own, name: 'ZZ TEST 646 A', code: parkA },
    { id: parkB, operatorId: own, name: 'ZZ TEST 646 B', code: parkB },
    { id: archived, operatorId: own, name: 'ZZ TEST 646 archived', code: archived, archivedAt: changedAt },
    { id: otherPark, operatorId: foreign, name: 'ZZ TEST 646 foreign', code: otherPark },
  ]);
  bothRole = newId(); consoleRole = newId(); analyticsRole = newId();
  await ctx.db.insert(role).values([
    { id: bothRole, operatorId: own, name: 'ZZ TEST 646 both reads' },
    { id: consoleRole, operatorId: own, name: 'ZZ TEST 646 console read' },
    { id: analyticsRole, operatorId: own, name: 'ZZ TEST 646 native read' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: bothRole, permission: 'console:analytics:read' },
    { id: newId(), roleId: bothRole, permission: 'analytics:read' },
    { id: newId(), roleId: consoleRole, permission: 'console:analytics:read' },
    { id: newId(), roleId: analyticsRole, permission: 'analytics:read' },
  ]);
  await ctx.db.insert(branchSourceSwitch).values([
    { id: newId(), operatorId: own, branchId: parkA, source: 'pisell', preference: 'both', switchedAt: changedAt, actorAccountId: actorId },
    // Independent FK columns permit malformed lineage; a read must not join it into this operator.
    { id: newId(), operatorId: foreign, branchId: parkB, source: 'papaya', preference: 'legacy', switchedAt: changedAt },
  ]);
  const daily = (source: FormulaRows['source'], formulaVersion: number, businessDate: string,
    extra: Partial<typeof dailySummary.$inferInsert> = {}): typeof dailySummary.$inferInsert => ({
      id: newId(), operatorId: own, branchId: parkA, source, formulaVersion, businessDate,
      computedAt: changedAt, inputFingerprint: 'ZZ TEST 646 metadata', ...extra,
    });
  await ctx.db.insert(dailySummary).values([
    daily('oto_pos', 1, '2026-10-01', { provisional: true }),
    daily('oto_pos', 2, '2026-10-02'),
    daily('pisell', 30, '2026-10-01', { frozen: true }),
    daily('pisell', 30, '2026-10-02', { frozen: true }),
    daily('papaya', 21, '2026-10-01', { frozen: true }),
    daily('pisell', 99, '2026-10-03', { operatorId: foreign, frozen: true }),
    daily('oto_pos', 97, '2026-10-03', { branchId: otherPark }),
  ]);
  const hourly = (source: FormulaRows['source'], formulaVersion: number, businessDate: string, hour: number,
    extra: Partial<typeof hourlySummary.$inferInsert> = {}): typeof hourlySummary.$inferInsert => ({
      id: newId(), operatorId: own, branchId: parkA, source, formulaVersion, businessDate, hour,
      computedAt: changedAt, ...extra,
    });
  await ctx.db.insert(hourlySummary).values([
    hourly('oto_pos', 1, '2026-10-01', 1), hourly('oto_pos', 1, '2026-10-01', 2),
    hourly('oto_pos', 2, '2026-10-02', 1), hourly('pisell', 30, '2026-10-01', 1),
    hourly('pisell', 31, '2026-10-02', 1),
    hourly('oto_pos', 1, '2026-10-01', 3, { operatorId: foreign }),
    hourly('oto_pos', 98, '2026-10-01', 1, { branchId: otherPark }),
  ]);
  const dirty = (kind: typeof dirtyDate.$inferInsert.kind, businessDate: string,
    extra: Partial<typeof dirtyDate.$inferInsert> = {}): typeof dirtyDate.$inferInsert => ({
      id: newId(), operatorId: own, branchId: parkA, kind, businessDate,
      reason: 'ZZ TEST 646 queue row', markedAt, ...extra,
    });
  await ctx.db.insert(dirtyDate).values([
    dirty('sales', '2026-10-01', { markCount: 99 }),
    dirty('hourly', '2026-10-01', { claimedAt: markedAt, claimedBy: 'ZZ TEST 646 existing claim' }),
    dirty('booth', '2026-10-02'), dirty('wallet', '2024-01-01'),
    dirty('wallet', '2026-10-02', { operatorId: foreign }),
    dirty('sales', '2026-10-01', { branchId: otherPark }),
  ]);
}, 180_000);

afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

type Grant = { roleId: string; scopeType: 'operator' | 'branch' | 'department'; scopeId: string | null };
async function grants(rows: Grant[]) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  if (rows.length) await ctx.db.insert(roleAssignment).values(rows.map(row => ({ id: newId(), accountId: actorId, ...row })));
}
beforeEach(async () => grants([{ roleId: bothRole, scopeType: 'branch', scopeId: parkA }]));
const get = (query = '', authenticated = true) => ctx.app.inject({ method: 'GET', url: path + query,
  headers: authenticated ? { cookie } : {} });
async function read(query = ''): Promise<Metadata> {
  const response = await get(query);
  expect(response.statusCode).toBe(200);
  return response.json() as Metadata;
}
const formulaKey = (row: FormulaRows) => `${row.source}:${row.formulaVersion}`;
async function storedFingerprint() {
  const ids = [parkA, parkB, archived, otherPark];
  const rows = await Promise.all([
    ctx.db.select().from(branchSourceSwitch).where(inArray(branchSourceSwitch.branchId, ids)).orderBy(asc(branchSourceSwitch.id)),
    ctx.db.select().from(dailySummary).where(inArray(dailySummary.branchId, ids)).orderBy(asc(dailySummary.id)),
    ctx.db.select().from(hourlySummary).where(inArray(hourlySummary.branchId, ids)).orderBy(asc(hourlySummary.id)),
    ctx.db.select().from(dirtyDate).where(inArray(dirtyDate.branchId, ids)).orderBy(asc(dirtyDate.id)),
  ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

describe('SCRUM-646 native read-only Analytics metadata', () => {
  it('R1 high: the real Console read exists with an exact metadata-only envelope', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json() as Metadata;
    expect(Object.keys(body).sort()).toEqual(['basis', 'branches', 'generatedAt', 'omitted']);
    expect(body.basis).toBe('stored-summary-metadata');
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
    expect(body.branches.map(row => row.branchId)).toEqual([parkA]);
    expect(body.omitted).toEqual([]);
    expect(Object.keys(body.branches[0]!).sort()).toEqual([
      'branchId', 'dirtyDates', 'formulaRows', 'name', 'preference', 'source', 'switchedAt',
    ]);
  });

  it('R2 high: source and Radar preference stay separate and switchedAt remains the native edit timestamp', async () => {
    const body = await read(`?branches=${parkA}`);
    expect(body.branches[0]).toMatchObject({ branchId: parkA, source: 'pisell', preference: 'both', switchedAt: changedAt.toISOString() });
    expect(Object.keys(body.branches[0]!)).not.toContain('switchDate');
  });

  it('R3 high: actual retained daily/hourly formula groups include versions with only hourly rows', async () => {
    const body = await read(`?branches=${parkA}`);
    const rows = body.branches[0]!.formulaRows.sort((a, b) => formulaKey(a).localeCompare(formulaKey(b)));
    expect(rows).toEqual([
      { source: 'oto_pos', formulaVersion: 1, dailyRows: 1, hourlyRows: 2, frozenDailyRows: 0, provisionalDailyRows: 1 },
      { source: 'oto_pos', formulaVersion: 2, dailyRows: 1, hourlyRows: 1, frozenDailyRows: 0, provisionalDailyRows: 0 },
      { source: 'papaya', formulaVersion: 21, dailyRows: 1, hourlyRows: 0, frozenDailyRows: 1, provisionalDailyRows: 0 },
      { source: 'pisell', formulaVersion: 30, dailyRows: 2, hourlyRows: 1, frozenDailyRows: 2, provisionalDailyRows: 0 },
      { source: 'pisell', formulaVersion: 31, dailyRows: 0, hourlyRows: 1, frozenDailyRows: 0, provisionalDailyRows: 0 },
    ]);
  });

  it('R4 high: dirty depth counts native queue rows including claimed rows, not marks or recent dates only', async () => {
    const body = await read(`?branches=${parkA}`);
    expect(body.branches[0]!.dirtyDates).toEqual({
      total: 4, byKind: { sales: 1, hourly: 1, booth: 1, wallet: 1 },
      oldestBusinessDate: '2024-01-01', newestMarkedAt: markedAt.toISOString(),
    });
  });

  it('R5 high: operator and actual branch lineage fence every source, summary and queue row', async () => {
    await grants([{ roleId: bothRole, scopeType: 'operator', scopeId: own }]);
    const body = await read(`?branches=${parkA},${parkB}`);
    expect(body.branches.map(row => row.branchId)).toEqual([parkA, parkB]);
    expect(body.branches[0]!.formulaRows.some(row => row.formulaVersion >= 97)).toBe(false);
    expect(body.branches[1]).toEqual({ branchId: parkB, name: 'ZZ TEST 646 B', source: 'oto_pos', preference: 'oto_pos',
      switchedAt: null, formulaRows: [], dirtyDates: { total: 0, byKind: { sales: 0, hourly: 0, booth: 0, wallet: 0 },
        oldestBusinessDate: null, newestMarkedAt: null } });
  });

  it('R6 high: the selected set is the intersection of Console and native analytics reach', async () => {
    await grants([
      { roleId: consoleRole, scopeType: 'branch', scopeId: parkA },
      { roleId: analyticsRole, scopeType: 'branch', scopeId: parkB },
    ]);
    expect((await get(`?branches=${parkA},${parkB}`)).statusCode).toBe(403);
    await grants([
      { roleId: bothRole, scopeType: 'branch', scopeId: parkA },
      { roleId: consoleRole, scopeType: 'branch', scopeId: parkB },
    ]);
    const body = await read(`?branches=${parkB},${parkA},${parkA}`);
    expect(body.branches.map(row => row.branchId)).toEqual([parkA]);
    expect(body.omitted).toEqual([parkB]);
  });

  it('R7 high: either read permission alone, a department grant or foreign operator grant cannot widen access', async () => {
    for (const row of [
      { roleId: consoleRole, scopeType: 'operator' as const, scopeId: own },
      { roleId: analyticsRole, scopeType: 'operator' as const, scopeId: own },
      { roleId: bothRole, scopeType: 'department' as const, scopeId: newId() },
      { roleId: bothRole, scopeType: 'operator' as const, scopeId: foreign },
    ]) {
      await grants([row]);
      expect((await get(`?branches=${parkA}`)).statusCode).toBe(403);
    }
  });

  it('R8 high: explicit foreign and unknown branches retain 404 before any partial reply', async () => {
    for (const id of [otherPark, newId()]) expect((await get(`?branches=${parkA},${id}`)).statusCode).toBe(404);
  });

  it('R9 medium: default scope excludes archived parks and explicit own archived selection follows native source reads', async () => {
    await grants([parkA, archived].map(scopeId => ({ roleId: bothRole, scopeType: 'branch', scopeId })));
    expect((await read()).branches.map(row => row.branchId)).toEqual([parkA]);
    expect((await read(`?branches=${archived}`)).branches.map(row => row.branchId)).toEqual([archived]);
  });

  it('R10 high: anonymous and freshly revoked callers cannot reuse the previous read', async () => {
    expect((await get('', false)).statusCode).toBe(401);
    expect((await get()).statusCode).toBe(200);
    await grants([]);
    expect((await get()).statusCode).toBe(403);
  });

  it('R11 medium: unknown keys, malformed IDs and an overlarge branch filter are refused', async () => {
    for (const query of ['?from=2026-10-01', '?branches=bad', '?branches=',
      `?branches=${Array.from({ length: 51 }, () => newId()).join(',')}`]) {
      expect((await get(query)).statusCode).toBe(400);
    }
  });

  it('R12 high: successful reads leave source selection, summaries and claims byte-identical', async () => {
    const before = await storedFingerprint();
    await read(`?branches=${parkA}`);
    await read(`?branches=${parkA}`);
    expect(await storedFingerprint()).toBe(before);
  });

  it('R13 high: a database read failure remains unavailable rather than fabricated zero metadata', async () => {
    const failing = vi.spyOn(ctx.db, 'transaction').mockRejectedValueOnce(new Error('ZZ TEST 646 unavailable database read'));
    try { expect((await get()).statusCode).toBe(500); } finally { failing.mockRestore(); }
  });

  it('C1 native control: original source read retains its exact own source/preference and timestamp', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `/analytics/sources?branches=${parkA}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().branches[0]).toMatchObject({ branchId: parkA, source: 'pisell', preference: 'both',
      switchedAt: changedAt.toISOString(), actorAccountId: actorId });
  });

  it('C2 native control: original summary still serves frozen selected-source rows and native formula versions', async () => {
    const response = await ctx.app.inject({ method: 'GET',
      url: `/analytics/summary?branches=${parkA}&from=2026-10-01&to=2026-10-02&group=day`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.branches[0].source).toBe('pisell');
    expect(body.branches[0].rows.map((row: { formulaVersion: number }) => row.formulaVersion)).toEqual([30, 30]);
    expect(body.merged.map((row: { rolledDays: number }) => row.rolledDays)).toEqual([1, 1]);
  });

  it('C3 native control: original source endpoint still omits own unreadable parks and refuses foreign filters', async () => {
    const ownRead = await ctx.app.inject({ method: 'GET', url: `/analytics/sources?branches=${parkA},${parkB}`, headers: { cookie } });
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json().omitted).toEqual([parkB]);
    const foreignRead = await ctx.app.inject({ method: 'GET', url: `/analytics/sources?branches=${otherPark}`, headers: { cookie } });
    expect(foreignRead.statusCode).toBe(404);
  });

  it('C4 native control: source, formula and queue fixture lineage remains present before any new reader', async () => {
    const rows = await ctx.db.select({ id: dailySummary.id }).from(dailySummary)
      .where(and(eq(dailySummary.operatorId, foreign), eq(dailySummary.branchId, parkA)));
    expect(rows).toHaveLength(1);
    const claimed = await ctx.db.select({ claimedBy: dirtyDate.claimedBy, markCount: dirtyDate.markCount }).from(dirtyDate)
      .where(and(eq(dirtyDate.branchId, parkA), eq(dirtyDate.kind, 'hourly')));
    expect(claimed).toEqual([{ claimedBy: 'ZZ TEST 646 existing claim', markCount: 1 }]);
  });
});
