import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, box, branch, operator, role, roleAssignment, rolePermission, station } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let adminCookie: string, managerCookie: string, operatorCookie: string;
let operatorId: string, managerId: string, foreignOperatorId: string, editorRole: string;
const hours = { mon: { open: '10:00', close: '20:00' }, tue: null, fri: { open: '22:30', close: '02:00' } };

async function park(name: string, owner = operatorId) {
  const id = newId();
  await ctx.db.insert(branch).values({ id, operatorId: owner, code: `zz-test-620-${id}`, name: `ZZ TEST ${name}`, address: 'ZZ TEST original address', country: 'TH' });
  return id;
}
const patch = (id: string, body: Record<string, unknown>, cookie = adminCookie, key = newId()) =>
  ctx.app.inject({ method: 'PATCH', url: `/branches/${id}`, headers: { cookie, 'idempotency-key': key }, payload: body });
const stored = async (id: string) => (await ctx.db.select().from(branch).where(eq(branch.id, id)))[0]!;
const trail = (id: string) => ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'branch.update')));

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  operatorCookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [admin] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [manager] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  const [outside] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = admin!.operatorId; managerId = manager!.id; foreignOperatorId = outside!.operatorId;
  editorRole = newId();
  await ctx.db.insert(role).values({ id: editorRole, operatorId, name: 'ZZ TEST Organisation branch editor' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: editorRole, permission: 'admin:branch:update' });
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-620 independent Organisation review', () => {
  it('R1 [high] persists and reads the approved branch edit fields; fix: describe and store opening hours and business-day start on the owned branch route', async () => {
    const id = await park('Organisation editable park');
    const response = await patch(id, { openingHours: hours, businessDayStart: '04:30', address: 'ZZ TEST changed address' });
    expect(response.statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ openingHours: hours, businessDayStart: '04:30:00', address: 'ZZ TEST changed address', timezone: 'Asia/Bangkok', country: 'TH' });
    const listed = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: adminCookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().branches.find((row: { id: string }) => row.id === id)).toMatchObject({ openingHours: hours, businessDayStart: '04:30:00', address: 'ZZ TEST changed address' });
    expect(await trail(id)).toHaveLength(1);
  });

  it('R2 [high] preserves unknown hours, a closed day and overnight times; fix: keep nullable weekday hours rather than replace them with guessed defaults', async () => {
    const id = await park('Organisation hours states');
    for (const openingHours of [hours, {}, null]) {
      expect((await patch(id, { openingHours })).statusCode).toBe(200);
      expect((await stored(id)).openingHours).toEqual(openingHours);
    }
    expect((await stored(id)).businessDayStart).toBe('05:00:00');
  });

  it('R3 [critical] targets the named park rather than the seated one; fix: retain path-branch permission and operator ownership before updating', async () => {
    const own = await park('Organisation scoped edit'), sibling = await park('Organisation sibling'), foreign = await park('Organisation foreign', foreignOperatorId);
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: managerId, roleId: editorRole, scopeType: 'branch', scopeId: own });
    expect((await patch(own, { businessDayStart: '03:15' }, managerCookie)).statusCode).toBe(200);
    expect((await patch(sibling, { businessDayStart: '03:15' }, managerCookie)).statusCode).toBe(403);
    expect((await patch(foreign, { businessDayStart: '03:15' })).statusCode).toBe(404);
    expect((await stored(own)).businessDayStart).toBe('03:15:00');
    for (const id of [sibling, foreign]) { expect((await stored(id)).businessDayStart).toBe('05:00:00'); expect(await trail(id)).toHaveLength(0); }
  });

  it('R4 [high] changes the trading fields once under an exact retry; fix: retain idempotency and the branch audit in the same mutation', async () => {
    const id = await park('Organisation replay'), key = newId(), body = { openingHours: hours, businessDayStart: '06:20' };
    const first = await patch(id, body, adminCookie, key), replay = await patch(id, body, adminCookie, key);
    expect(first.statusCode).toBe(200); expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(first.json());
    expect(await trail(id)).toHaveLength(1);
    expect((await patch(id, { ...body, businessDayStart: '06:21' }, adminCookie, key)).statusCode).toBe(409);
    expect((await stored(id)).businessDayStart).toBe('06:20:00');
  });

  it('R5 [high] refuses malformed new fields before any change; fix: validate clocks and weekday keys without weakening the strict request schema', async () => {
    const id = await park('Organisation invalid input');
    for (const body of [{ businessDayStart: '25:00' }, { openingHours: { mon: { open: '10:00', close: '25:00' } } }, { openingHours: { monday: { open: '10:00', close: '20:00' } } }]) {
      expect((await patch(id, body)).statusCode).toBe(400);
    }
    expect(await stored(id)).toMatchObject({ openingHours: null, businessDayStart: '05:00:00' });
    expect(await trail(id)).toHaveLength(0);
  });

  it('R6 [critical] keeps operator administration platform-wide; fix: never turn an operator-read offer into authority or dispatch an invitation for a refused caller', async () => {
    const messages = ctx.smsLog.length;
    for (const request of [
      { method: 'GET' as const, url: '/operators' },
      { method: 'POST' as const, url: '/operators', payload: { name: 'ZZ TEST forbidden operator' } },
      { method: 'PATCH' as const, url: `/operators/${foreignOperatorId}`, payload: { name: 'ZZ TEST forbidden rename' } },
      { method: 'POST' as const, url: `/operators/${foreignOperatorId}/administrators`, payload: { name: 'ZZ TEST forbidden administrator', phone: '+66999620000' } },
    ]) expect((await ctx.app.inject({ ...request, headers: { cookie: operatorCookie } })).statusCode).toBe(403);
    expect(ctx.smsLog).toHaveLength(messages);
  });

  it('R7 [high] requires the exact branch name before archive; fix: compare confirmName with the current locked row before any write', async () => {
    const id = await park('Branch archive confirmation'), current = await stored(id);
    for (const body of [{ archived: true }, { archived: true, confirmName: current.name.toLowerCase() }]) {
      expect((await patch(id, body)).statusCode).toBe(400);
      expect((await stored(id)).archivedAt).toBeNull(); expect(await trail(id)).toHaveLength(0);
    }
  });

  it('R8 [high] requires the exact operator name before archive; fix: reject absent or different confirmation without changing the operator', async () => {
    const id = newId(), name = 'ZZ TEST Operator archive confirmation';
    await ctx.db.insert(operator).values({ id, name });
    for (const payload of [{ archived: true }, { archived: true, confirmName: name.toLowerCase() }]) {
      const response = await ctx.app.inject({ method: 'PATCH', url: `/operators/${id}`, headers: { cookie: adminCookie, 'idempotency-key': newId() }, payload });
      expect(response.statusCode).toBe(400);
      expect((await ctx.db.select().from(operator).where(eq(operator.id, id)))[0]!.archivedAt).toBeNull();
    }
  });

  it('R9 [critical] names only owned live fleet before refusing branch archive; fix: fence and lock the branch blockers and ignore archived history', async () => {
    const id = await park('Branch fleet blockers'), current = await stored(id), boxId = newId(), stationId = newId(), decoy = newId();
    await ctx.db.insert(box).values([
      { id: boxId, operatorId, branchId: id, name: 'ZZ TEST Owned live box', slot: 'zz-live' },
      { id: decoy, operatorId: foreignOperatorId, branchId: id, name: 'ZZ TEST Foreign operator decoy', slot: 'zz-foreign' },
    ]);
    await ctx.db.insert(station).values({ id: stationId, operatorId, branchId: id, name: 'ZZ TEST Owned live station' });
    const response = await patch(id, { archived: true, confirmName: current.name });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toEqual({ boxes: [{ id: boxId, name: 'ZZ TEST Owned live box' }], stations: [{ id: stationId, name: 'ZZ TEST Owned live station' }] });
    expect((await stored(id)).archivedAt).toBeNull(); expect(await trail(id)).toHaveLength(0);
    await ctx.db.update(box).set({ archivedAt: new Date() }).where(eq(box.id, boxId));
    await ctx.db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, stationId));
    expect((await patch(id, { archived: true, confirmName: current.name })).statusCode).toBe(200);
  });

  it('R10 [critical] refuses operator archive while its own live fleet remains; fix: lock and return exact operator-owned blockers before soft archive', async () => {
    const id = newId(), name = 'ZZ TEST Operator fleet blockers'; await ctx.db.insert(operator).values({ id, name });
    const parkId = await park('Operator fleet park', id), boxId = newId(), stationId = newId();
    await ctx.db.insert(box).values({ id: boxId, operatorId: id, branchId: parkId, name: 'ZZ TEST Operator live box', slot: 'zz-operator-live' });
    await ctx.db.insert(station).values({ id: stationId, operatorId: id, branchId: parkId, name: 'ZZ TEST Operator live station' });
    const response = await ctx.app.inject({ method: 'PATCH', url: `/operators/${id}`, headers: { cookie: adminCookie, 'idempotency-key': newId() }, payload: { archived: true, confirmName: name } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toEqual({ boxes: [{ id: boxId, name: 'ZZ TEST Operator live box' }], stations: [{ id: stationId, name: 'ZZ TEST Operator live station' }] });
    expect((await ctx.db.select().from(operator).where(eq(operator.id, id)))[0]!.archivedAt).toBeNull();
  });
});
