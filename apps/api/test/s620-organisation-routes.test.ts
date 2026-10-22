import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, otoappBranches } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let actorId: string;
let tenantId: string;

const patch = (id: string, payload: Record<string, unknown>, key = newId()) =>
  ctx.app.inject({ method: 'PATCH', url: `/branches/${id}`, headers: { cookie, 'idempotency-key': key }, payload });
const stored = async (id: string) => (await ctx.db.select().from(branch).where(eq(branch.id, id)))[0]!;
const trail = (id: string, action = 'branch.update') => ctx.db.select().from(auditLog)
  .where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));
async function park(name: string, openingHours: unknown = null) {
  const id = newId();
  await ctx.db.insert(branch).values({ id, operatorId, name: `ZZ TEST ${name}`, code: `zz-test-620-${id}`, openingHours });
  return id;
}
async function listed(id: string) {
  const response = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { branches: Array<Record<string, unknown> & { id: string }> }).branches.find(row => row.id === id)!;
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select({ id: account.id, operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  operatorId = actor!.operatorId;
  actorId = actor!.id;
  tenantId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id,name,slug) values (${tenantId},'ZZ TEST Organisation mirror',${`zz-test-${tenantId}`})`);
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-620 Organisation route contracts', () => {
  it('reads legacy raw hours and preserves them when an unrelated branch field changes', async () => {
    for (const openingHours of ['ZZ TEST legacy hours', [{ unexpected: true }], { mon: { open: 'legacy', close: 'value' } }]) {
      const id = await park('Legacy hours', openingHours);
      expect(await listed(id)).toMatchObject({ openingHours, address: null });
      const response = await patch(id, { name: 'ZZ TEST Corrected name', address: 'ZZ TEST own address' });
      expect(response.statusCode).toBe(200);
      expect((await stored(id)).openingHours).toEqual(openingHours);
      expect(await listed(id)).toMatchObject({ openingHours, name: 'ZZ TEST Corrected name', address: 'ZZ TEST own address' });
    }
  });

  it('keeps equal-time and overnight weekly hours and preserves explicit business-day seconds', async () => {
    const id = await park('Trading clock');
    const openingHours = { mon: { open: '00:00', close: '00:00' }, wed: null, sat: { open: '22:30', close: '02:00' } };
    expect((await patch(id, { openingHours, businessDayStart: '04:30:15' })).statusCode).toBe(200);
    expect(await listed(id)).toMatchObject({ openingHours, businessDayStart: '04:30:15' });
    expect((await patch(id, { country: 'TH' })).statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ openingHours, businessDayStart: '04:30:15', country: 'TH' });
  });

  it('changes a mapped app name through the existing seam and leaves other mirror fields alone', async () => {
    const id = await park('Mapped park');
    const appId = `zz-test-620-${newId()}`;
    await ctx.db.execute(sql`insert into otoapp.branches (id,tenant_id,name,address,core_branch_id,core_sync_status)
      values (${appId},${tenantId},'ZZ TEST Mapped park','ZZ TEST app address',${id},'SUCCESS')`);
    const renamed = await patch(id, { name: 'ZZ TEST Mapped park renamed' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ ok: true, otoApp: { appBranchId: appId, appBranchName: 'ZZ TEST Mapped park renamed' } });
    const [before] = await ctx.db.select().from(otoappBranches).where(eq(otoappBranches.id, appId));
    expect(before!.name).toBe('ZZ TEST Mapped park renamed');
    const changed = await patch(id, { timezone: 'UTC', address: 'ZZ TEST new core address', openingHours: null, businessDayStart: '06:00' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true, otoApp: null });
    const [after] = await ctx.db.select().from(otoappBranches).where(eq(otoappBranches.id, appId));
    expect(after).toEqual(before);
    expect(await trail(appId, 'branch.oto_app_rename')).toHaveLength(1);
    expect(await trail(id)).toHaveLength(2);
  });

  it('describes branch creation and client-ID replay without inventing a second app mapping', async () => {
    const id = newId();
    const payload = { id, name: 'ZZ TEST Organisation created branch', code: `zz-test-620-${id}` };
    const send = () => ctx.app.inject({ method: 'POST', url: '/branches', headers: { cookie, 'idempotency-key': newId() }, payload });
    const created = await send();
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id, otoApp: { appBranchId: expect.any(String), mappedBy: 'created', reason: null } });
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual({ id, otoApp: null });
    expect(await trail(id, 'branch.create')).toHaveLength(1);
  });

  it('preserves an administrator invitation response with no codeSent field on client-ID replay', async () => {
    const id = newId();
    const made = await ctx.app.inject({ method: 'POST', url: '/operators', headers: { cookie, 'idempotency-key': newId() }, payload: { id, name: 'ZZ TEST Organisation operator' } });
    expect(made.statusCode).toBe(200);
    expect(made.json()).toEqual({ id });
    const accountId = newId();
    const payload = { id: accountId, name: 'ZZ TEST Organisation administrator', phone: '+66999620101' };
    const messages = ctx.smsLog.length;
    const send = () => ctx.app.inject({ method: 'POST', url: `/operators/${id}/administrators`, headers: { cookie, 'idempotency-key': newId() }, payload });
    const invited = await send();
    expect(invited.statusCode).toBe(200);
    expect(invited.json()).toEqual({ accountId, codeSent: true });
    expect(ctx.smsLog).toHaveLength(messages + 1);
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual({ accountId });
    expect(ctx.smsLog).toHaveLength(messages + 1);
  });

  it('records the three platform operator acts under that operator and actor once, even on exact retries', async () => {
    const id = newId(), name = 'ZZ TEST Operator audit original', renamed = 'ZZ TEST Operator audit renamed';
    const messages = ctx.smsLog.length;
    for (const request of [
      { method: 'POST' as const, url: '/operators', payload: { id, name } },
      { method: 'PATCH' as const, url: `/operators/${id}`, payload: { name: renamed } },
      { method: 'PATCH' as const, url: `/operators/${id}`, payload: { archived: true, confirmName: renamed } },
    ]) {
      const headers = { cookie, 'idempotency-key': newId() };
      const first = await ctx.app.inject({ ...request, headers });
      const retry = await ctx.app.inject({ ...request, headers });
      expect(first.statusCode).toBe(200);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
    }
    const rows = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'operator'), eq(auditLog.entityId, id))).orderBy(asc(auditLog.createdAt));
    expect(rows.map(row => row.action)).toEqual(['operator.create', 'operator.update', 'operator.update']);
    expect(rows.every(row => row.actorAccountId === actorId && row.operatorId === id && row.branchId === null)).toBe(true);
    expect(rows[0]!.after).toMatchObject({ name });
    expect(rows[1]!.before).toMatchObject({ name });
    expect(rows[1]!.after).toMatchObject({ name: renamed, archivedAt: null });
    expect(rows[2]!.before).toMatchObject({ name: renamed, archivedAt: null });
    expect((rows[2]!.after as { archivedAt: unknown }).archivedAt).not.toBeNull();
    expect(ctx.smsLog).toHaveLength(messages);
  });

  it('describes unused holiday CRUD and keeps its count and branch boundary', async () => {
    const id = await park('Holiday park');
    const other = await park('Other holiday park');
    const base = `/branches/${id}/holidays`;
    const created = await ctx.app.inject({ method: 'POST', url: base, headers: { cookie, 'idempotency-key': newId() }, payload: { name: 'ZZ TEST Future holiday', startsOn: '2037-04-13', endsOn: '2037-04-15' } });
    expect(created.statusCode).toBe(200);
    const holiday = created.json() as { id: string };
    const list = await ctx.app.inject({ method: 'GET', url: base, headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ holidays: [{ ...holiday, name: 'ZZ TEST Future holiday', startsOn: '2037-04-13', endsOn: '2037-04-15', pricedSales: 0 }] });
    const wrong = await ctx.app.inject({ method: 'PATCH', url: `/branches/${other}/holidays/${holiday.id}`, headers: { cookie, 'idempotency-key': newId() }, payload: { name: 'ZZ TEST Wrong branch' } });
    expect(wrong.statusCode).toBe(404);
    const changed = await ctx.app.inject({ method: 'PATCH', url: `${base}/${holiday.id}`, headers: { cookie, 'idempotency-key': newId() }, payload: { name: 'ZZ TEST Corrected holiday' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true });
    const removed = await ctx.app.inject({ method: 'DELETE', url: `${base}/${holiday.id}`, headers: { cookie, 'idempotency-key': newId() } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
  });
});
