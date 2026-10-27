import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account, auditLog, branch, branchSourceSwitch, dailySummary, dirtyDate, operator, role, roleAssignment, rolePermission, type Db,
} from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-646, Q27 Stage 1 — the Console's sources panel, exactly to the ruling:
 * the model as it is (one whole-branch source; `switched_at` is the edit time),
 * a truthful read-only preview, the existing audited switch, and a re-run that
 * only marks our own POS days for the jobs process. No storage, summary,
 * formula or frozen-day rule changes; nothing unfreezes.
 */

let ctx: TestContext;
let db: Db;
let cookie: string;
let actorId: string, own: string, foreign: string;
let parkPos: string, parkLegacy: string, foreignPark: string;
let readRole: string, manageRole: string, rerunRole: string;
const editedAt = new Date('2026-10-20T08:00:00.000Z');
const legacyOld = new Date('2026-09-10T01:00:00.000Z');
const legacyNew = new Date('2026-09-12T01:00:00.000Z');
const notFrozenNewest = new Date('2026-10-01T01:00:00.000Z');

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  db = ctx.db;
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await db.select({ id: account.id, operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  foreign = newId(); parkPos = newId(); parkLegacy = newId(); foreignPark = newId();
  await db.insert(operator).values({ id: foreign, name: 'ZZ TEST 646S foreign operator' });
  await db.insert(branch).values([
    { id: parkPos, operatorId: own, name: 'ZZ TEST 646S POS park', code: parkPos },
    { id: parkLegacy, operatorId: own, name: 'ZZ TEST 646S legacy park', code: parkLegacy },
    { id: foreignPark, operatorId: foreign, name: 'ZZ TEST 646S foreign', code: foreignPark },
  ]);
  await db.insert(branchSourceSwitch).values({
    id: newId(), operatorId: own, branchId: parkLegacy, source: 'pisell', preference: 'legacy', switchedAt: editedAt, actorAccountId: actorId,
  });
  const day = (branchId: string, source: 'oto_pos' | 'pisell' | 'papaya', businessDate: string, computedAt: Date, frozen: boolean): typeof dailySummary.$inferInsert => ({
    id: newId(), operatorId: own, branchId, source, formulaVersion: source === 'oto_pos' ? 1 : source === 'pisell' ? 30 : 21,
    businessDate, computedAt, inputFingerprint: 'ZZ TEST 646S', frozen,
  });
  await db.insert(dailySummary).values([
    // The POS park's own days, one of them frozen.
    day(parkPos, 'oto_pos', '2026-09-01', legacyOld, false),
    day(parkPos, 'oto_pos', '2026-09-02', legacyOld, false),
    day(parkPos, 'oto_pos', '2026-09-05', legacyOld, true),
    // Pisell history at the POS park: three frozen days and one stray unfrozen row that is never served.
    day(parkPos, 'pisell', '2026-09-01', legacyOld, true),
    day(parkPos, 'pisell', '2026-09-02', legacyOld, true),
    day(parkPos, 'pisell', '2026-09-03', legacyNew, true),
    day(parkPos, 'pisell', '2026-09-04', notFrozenNewest, false),
    // The legacy park's frozen days.
    day(parkLegacy, 'pisell', '2026-09-01', legacyOld, true),
  ]);
  readRole = newId(); manageRole = newId(); rerunRole = newId();
  await db.insert(role).values([
    { id: readRole, operatorId: own, name: 'ZZ TEST 646S reader' },
    { id: manageRole, operatorId: own, name: 'ZZ TEST 646S source manager' },
    { id: rerunRole, operatorId: own, name: 'ZZ TEST 646S re-runner' },
  ]);
  const reads = ['console:analytics:read', 'analytics:read'] as const;
  await db.insert(rolePermission).values([
    ...reads.map(permission => ({ id: newId(), roleId: readRole, permission })),
    ...[...reads, 'console:analytics:manage_source' as const].map(permission => ({ id: newId(), roleId: manageRole, permission })),
    ...[...reads, 'console:analytics:rerun' as const].map(permission => ({ id: newId(), roleId: rerunRole, permission })),
  ]);
}, 300_000);

afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function grants(roleIds: string[], scope: { scopeType: 'operator' | 'branch'; scopeId: string } = { scopeType: 'operator', scopeId: '' }) {
  await db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  const scopeId = scope.scopeType === 'operator' ? own : scope.scopeId;
  if (roleIds.length) await db.insert(roleAssignment).values(roleIds.map(roleId => ({ id: newId(), accountId: actorId, roleId, scopeType: scope.scopeType, scopeId })));
}
beforeEach(async () => grants([readRole, manageRole, rerunRole]));

const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });
const write = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown>, key: string | null = newId()) => ctx.app.inject({
  method, url, payload, headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
});
const audits = (action: string, entityId: string) => db.select().from(auditLog)
  .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId))).orderBy(asc(auditLog.createdAt));
const marks = (branchId: string) => db.select().from(dirtyDate)
  .where(and(eq(dirtyDate.branchId, branchId), eq(dirtyDate.kind, 'sales'))).orderBy(asc(dirtyDate.businessDate));
async function storedFingerprint() {
  const ids = [parkPos, parkLegacy];
  const rows = await Promise.all([
    db.select().from(branchSourceSwitch).where(inArray(branchSourceSwitch.branchId, ids)).orderBy(asc(branchSourceSwitch.id)),
    db.select().from(dailySummary).where(inArray(dailySummary.branchId, ids)).orderBy(asc(dailySummary.id)),
    db.select().from(dirtyDate).where(inArray(dirtyDate.branchId, ids)).orderBy(asc(dirtyDate.id)),
  ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

describe('SCRUM-646 Q27 Stage 1 — sources read', () => {
  it('S1 high: shows each park\'s whole-branch source and Radar preference, with the switch time named as an edit', async () => {
    const response = await get(`/console/analytics/sources?branches=${parkLegacy},${parkPos}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json();
    expect(body.basis).toBe('whole-branch-switch');
    const legacy = body.branches.find((row: { branchId: string }) => row.branchId === parkLegacy);
    expect(legacy).toMatchObject({ source: 'pisell', preference: 'legacy', lastEditedAt: editedAt.toISOString(),
      lastEditedBy: actorId, mayManageSource: true, mayRerun: true });
    expect(Object.keys(legacy)).not.toContain('switchedAt');
    const pos = body.branches.find((row: { branchId: string }) => row.branchId === parkPos);
    expect(pos).toMatchObject({ source: 'oto_pos', preference: 'oto_pos', lastEditedAt: null });
    expect(JSON.stringify(body)).not.toMatch(/effective|cutover/i);
  });

  it('S2 high: the Analytics read door holds — no grant 403, foreign park 404, write doors reported per park', async () => {
    await grants([]);
    expect((await get('/console/analytics/sources')).statusCode).toBe(403);
    await grants([readRole]);
    expect((await get(`/console/analytics/sources?branches=${foreignPark}`)).statusCode).toBe(404);
    const body = (await get(`/console/analytics/sources?branches=${parkPos}`)).json();
    expect(body.branches[0]).toMatchObject({ mayManageSource: false, mayRerun: false });
  });
});

describe('SCRUM-646 Q27 Stage 1 — read-only preview', () => {
  const preview = (query: string) => get(`/console/analytics/sources/preview?${query}`);

  it('P1 high: a legacy source counts its frozen days only, with their newest write, and the rest as empty', async () => {
    const response = await preview(`branchId=${parkPos}&source=pisell&from=2026-09-01&to=2026-09-05`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      branchId: parkPos, currentSource: 'oto_pos', proposedSource: 'pisell', effect: 'whole-branch',
      from: '2026-09-01', to: '2026-09-05', days: 5, servedDays: 3, emptyDays: 2,
      firstServedDate: '2026-09-01', lastServedDate: '2026-09-03', newestWrittenAt: legacyNew.toISOString(),
    });
  });

  it('P2 high: our own source counts every stored POS day, frozen or not', async () => {
    const body = (await preview(`branchId=${parkLegacy}&source=oto_pos&from=2026-09-01&to=2026-09-05`)).json();
    expect(body).toMatchObject({ currentSource: 'pisell', proposedSource: 'oto_pos', servedDays: 0, emptyDays: 5, newestWrittenAt: null });
    const pos = (await preview(`branchId=${parkPos}&source=oto_pos&from=2026-09-01&to=2026-09-05`)).json();
    expect(pos).toMatchObject({ servedDays: 3, emptyDays: 2, unchanged: true });
  });

  it('P3 high: the preview never claims a date splice and writes nothing', async () => {
    const before = await storedFingerprint();
    const auditRows = (await db.select({ id: auditLog.id }).from(auditLog)).length;
    const body = (await preview(`branchId=${parkPos}&source=papaya`)).json();
    expect((await db.select({ id: auditLog.id }).from(auditLog)).length).toBe(auditRows);
    expect(JSON.stringify(body)).not.toMatch(/effectiveFrom|cutover|splice"/i);
    expect(body.days).toBe(30);
    expect(await storedFingerprint()).toBe(before);
  });

  it('P4 high: refuses a foreign park, an unknown source, a reversed or overlong range, and a caller without the read door', async () => {
    expect((await preview(`branchId=${foreignPark}&source=pisell`)).statusCode).toBe(404);
    expect((await preview(`branchId=${parkPos}&source=legacy`)).statusCode).toBe(400);
    expect((await preview(`branchId=${parkPos}&source=pisell&from=2026-09-05&to=2026-09-01`)).statusCode).toBe(400);
    expect((await preview(`branchId=${parkPos}&source=pisell&from=2024-01-01&to=2026-09-01`)).statusCode).toBe(400);
    await grants([]);
    expect((await preview(`branchId=${parkPos}&source=pisell`)).statusCode).toBe(403);
  });
});

describe('SCRUM-646 Q27 Stage 1 — the switch', () => {
  const url = () => `/console/analytics/sources/${parkPos}`;

  it('W1 high: switches through the existing audited service and answers the edit time', async () => {
    const response = await write('PUT', url(), { source: 'papaya', preference: 'both' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ branchId: parkPos, source: 'papaya', preference: 'both', changed: true, lastEditedBy: actorId });
    const [stored] = await db.select().from(branchSourceSwitch).where(eq(branchSourceSwitch.branchId, parkPos));
    expect(stored).toMatchObject({ source: 'papaya', preference: 'both', actorAccountId: actorId });
    expect(response.json().lastEditedAt).toBe(stored!.switchedAt.toISOString());
    expect(await audits('analytics.branch_source.switch', parkPos)).toHaveLength(1);
  });

  it('W2 high: the same switch again changes and records nothing; a replayed key answers the same', async () => {
    const before = (await audits('analytics.branch_source.switch', parkPos)).length;
    const key = newId();
    const first = await write('PUT', url(), { source: 'papaya', preference: 'both' }, key);
    expect(first.json()).toMatchObject({ changed: false });
    const replay = await write('PUT', url(), { source: 'papaya', preference: 'both' }, key);
    expect(replay.body).toBe(first.body);
    expect(await audits('analytics.branch_source.switch', parkPos)).toHaveLength(before);
    await write('PUT', url(), { source: 'oto_pos', preference: 'oto_pos' });
  });

  it('W3 high: refused without console:analytics:manage_source, without a key, and for a foreign park', async () => {
    const before = await storedFingerprint();
    await grants([readRole]);
    expect((await write('PUT', url(), { source: 'pisell', preference: 'legacy' })).statusCode).toBe(403);
    await grants([manageRole]);
    expect((await write('PUT', url(), { source: 'pisell', preference: 'legacy' }, null)).statusCode).toBe(400);
    expect((await write('PUT', `/console/analytics/sources/${foreignPark}`, { source: 'pisell', preference: 'legacy' })).statusCode).toBe(404);
    expect(await storedFingerprint()).toBe(before);
  });
});

describe('SCRUM-646 Q27 Stage 1 — re-run marks our own days only', () => {
  const rerun = (body: Record<string, unknown>, key: string | null = newId()) => write('POST', '/console/analytics/rerun', body, key);

  it('R1 high: marks each day of the range for the jobs process, audits the request and writes no summary', async () => {
    const summaries = await db.select().from(dailySummary).where(eq(dailySummary.branchId, parkPos)).orderBy(asc(dailySummary.id));
    const response = await rerun({ branchId: parkPos, from: '2026-09-01', to: '2026-09-03' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ branchId: parkPos, from: '2026-09-01', to: '2026-09-03', days: 3, kind: 'sales' });
    const queued = await marks(parkPos);
    expect(queued.map(row => row.businessDate)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(queued.every(row => row.reason === 'console:rerun' && row.claimedAt === null)).toBe(true);
    const [row] = await audits('analytics.rerun.request', parkPos);
    expect(row).toMatchObject({ actorAccountId: actorId, branchId: parkPos });
    expect(row!.after).toMatchObject({ from: '2026-09-01', to: '2026-09-03', days: 3, kind: 'sales' });
    expect(await db.select().from(dailySummary).where(eq(dailySummary.branchId, parkPos)).orderBy(asc(dailySummary.id))).toEqual(summaries);
  });

  it('R2 high: a replayed key repeats nothing', async () => {
    const key = newId();
    const first = await rerun({ branchId: parkPos, from: '2026-09-06', to: '2026-09-06' }, key);
    expect(first.statusCode, first.body).toBe(200);
    const counts = (await marks(parkPos)).map(row => row.markCount);
    const auditCount = (await audits('analytics.rerun.request', parkPos)).length;
    const replay = await rerun({ branchId: parkPos, from: '2026-09-06', to: '2026-09-06' }, key);
    expect(replay.body).toBe(first.body);
    expect((await marks(parkPos)).map(row => row.markCount)).toEqual(counts);
    expect(await audits('analytics.rerun.request', parkPos)).toHaveLength(auditCount);
  });

  it('R3 high: a park serving a legacy source is refused with the honest explanation and nothing marked', async () => {
    const before = await storedFingerprint();
    const response = await rerun({ branchId: parkLegacy, from: '2026-09-01', to: '2026-09-02' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ANALYTICS_RERUN_LEGACY_SOURCE');
    expect(response.json().error.message).toMatch(/our own records/);
    expect(response.json().error.message).toMatch(/never regenerate/);
    expect(await storedFingerprint()).toBe(before);
    expect(await audits('analytics.rerun.request', parkLegacy)).toHaveLength(0);
  });

  it('R4 high: frozen days of the serving source are refused the same way', async () => {
    const before = await storedFingerprint();
    const response = await rerun({ branchId: parkPos, from: '2026-09-04', to: '2026-09-05' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'ANALYTICS_RERUN_FROZEN_DAYS', details: { frozenDates: ['2026-09-05'] } });
    expect(response.json().error.message).toMatch(/our own records/);
    expect(await storedFingerprint()).toBe(before);
  });

  it('R5 high: the range is bounded, ordered and not in the future', async () => {
    const tooLong = await rerun({ branchId: parkPos, from: '2026-01-01', to: '2026-04-03' });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toMatch(/92 days/);
    expect((await rerun({ branchId: parkPos, from: '2026-09-03', to: '2026-09-01' })).statusCode).toBe(400);
    expect((await rerun({ branchId: parkPos, from: '2099-01-01', to: '2099-01-02' })).statusCode).toBe(400);
  });

  it('R6 high: refused without console:analytics:rerun, without a key, or for a foreign park', async () => {
    const before = await storedFingerprint();
    await grants([manageRole]);
    expect((await rerun({ branchId: parkPos, from: '2026-09-07', to: '2026-09-07' })).statusCode).toBe(403);
    await grants([rerunRole]);
    expect((await rerun({ branchId: parkPos, from: '2026-09-07', to: '2026-09-07' }, null)).statusCode).toBe(400);
    expect((await rerun({ branchId: foreignPark, from: '2026-09-07', to: '2026-09-07' })).statusCode).toBe(404);
    expect(await storedFingerprint()).toBe(before);
  });
});
