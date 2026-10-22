import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, box, branch, operator, role, roleAssignment, station } from '@oto/db';
import { newId } from '@oto/shared';
import { hash } from '@node-rs/argon2';
import { setTimeout as delay } from 'node:timers/promises';
import { createBox, createStation } from '../src/services/fleet';
import {
  assertArchiveAllowed, lockActiveOrganisation, lockBranchForArchive, lockOperatorForArchive,
} from '../src/services/organisation-archive';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
let actorId: string;
let operatorId: string;
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};
async function park() {
  const id = newId();
  const name = `ZZ TEST Archive race ${id}`;
  await ctx.db.insert(branch).values({ id, operatorId, name, code: `zz-test-${id}` });
  return { id, name };
}
async function blockedParent() {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const result = await ctx.db.execute<{ waiting: boolean }>(sql`select exists (
      select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where a.datname=current_database() and not l.granted and a.pid<>pg_backend_pid()
    ) as waiting`);
    if (result.rows[0]?.waiting) return;
    await delay(20);
  }
  throw new Error('Expected the isolated organisation operation to wait for its parent lock');
}
const writes = (id: string, action: string) => ctx.db.select({ id: auditLog.id }).from(auditLog)
  .where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await ctx.db.select({ id: account.id, operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id;
  operatorId = actor!.operatorId;
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-620 organisation parent locking', () => {
  it('waits for an in-flight box creation and then refuses to archive its branch', async () => {
    const target = await park();
    const held = gate(), finish = gate(), boxId = newId();
    const creator = ctx.db.transaction(async tx => {
      await lockActiveOrganisation(tx, operatorId, target.id);
      await tx.insert(box).values({ id: boxId, operatorId, branchId: target.id, name: 'ZZ TEST In-flight box', slot: `zz-test-${boxId}` });
      held.release();
      await finish.ready;
    });
    await held.ready;
    const retiring = ctx.app.inject({ method: 'PATCH', url: `/branches/${target.id}`, headers: { cookie, 'idempotency-key': newId() }, payload: { archived: true, confirmName: target.name } });
    try { await blockedParent(); } finally { finish.release(); }
    await creator;
    const response = await retiring;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'BRANCH_HAS_LIVE_FLEET', details: { boxes: [{ id: boxId, name: 'ZZ TEST In-flight box' }], stations: [] } } });
    const [row] = await ctx.db.select().from(branch).where(eq(branch.id, target.id));
    expect(row!.archivedAt).toBeNull();
    expect(await writes(target.id, 'branch.update')).toHaveLength(0);
  });

  it('rejects a stale box create after the branch archive it waited for commits', async () => {
    const target = await park();
    const held = gate(), finish = gate(), boxId = newId();
    const retiring = ctx.db.transaction(async tx => {
      const current = await lockBranchForArchive(tx, operatorId, target.id);
      await assertArchiveAllowed(tx, { operatorId, branchId: target.id, name: current.name, confirmName: target.name });
      await tx.update(branch).set({ archivedAt: new Date() }).where(eq(branch.id, target.id));
      held.release();
      await finish.ready;
    });
    await held.ready;
    const creation = createBox(ctx.db, { actorAccountId: actorId, operatorId }, { accountId: actorId, operatorId }, target.id,
      { id: boxId, name: 'ZZ TEST Stale box', slot: `zz-test-${boxId}`, role: 'counter' })
      .then(() => ({ accepted: true, code: '' }), (error: unknown) => ({ accepted: false, code: (error as { code?: string }).code }));
    try { await blockedParent(); } finally { finish.release(); }
    await retiring;
    expect(await creation).toEqual({ accepted: false, code: 'BRANCH_NOT_FOUND' });
    expect(await ctx.db.select({ id: box.id }).from(box).where(eq(box.id, boxId))).toHaveLength(0);
    expect(await writes(boxId, 'box.create')).toHaveLength(0);
  });

  it('does not add a station to a legacy archived branch after its active-box validation', async () => {
    const target = await park(), boxId = newId(), stationId = newId();
    // Older archive behavior allowed active historical equipment to remain.
    await ctx.db.insert(box).values({ id: boxId, operatorId, branchId: target.id, name: 'ZZ TEST Legacy active box', slot: `zz-test-${boxId}` });
    await ctx.db.update(branch).set({ archivedAt: new Date() }).where(eq(branch.id, target.id));
    const result = await createStation(ctx.db, { actorAccountId: actorId, operatorId }, { accountId: actorId, operatorId }, target.id,
      { id: stationId, name: 'ZZ TEST Stale station', kind: 'till', boxId, capabilities: [], accessScope: 'all_staff', devices: [], staffAccountIds: [] })
      .then(() => ({ accepted: true, code: '' }), (error: unknown) => ({ accepted: false, code: (error as { code?: string }).code }));
    expect(result).toEqual({ accepted: false, code: 'BRANCH_NOT_FOUND' });
    expect(await ctx.db.select({ id: station.id }).from(station).where(eq(station.id, stationId))).toHaveLength(0);
    expect(await writes(stationId, 'station.create')).toHaveLength(0);
  });

  it('refuses an already-authenticated branch create after its operator archive commits', async () => {
    const ownerId = newId(), loginId = newId(), branchId = newId();
    const name = 'ZZ TEST Archive race operator';
    await ctx.db.insert(operator).values({ id: ownerId, name });
    await ctx.db.insert(account).values({ id: loginId, operatorId: ownerId, phone: '+66999620102', status: 'active', passwordHash: await hash(ADMIN.password) });
    const [adminRole] = await ctx.db.select({ id: role.id }).from(role).where(and(eq(role.name, 'operator_admin'), isNull(role.operatorId)));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: loginId, roleId: adminRole!.id, scopeType: 'operator', scopeId: ownerId });
    const actorCookie = await signInAs(ctx.app, '+66999620102', ADMIN.password);
    const held = gate(), finish = gate();
    const retiring = ctx.db.transaction(async tx => {
      const current = await lockOperatorForArchive(tx, ownerId);
      await assertArchiveAllowed(tx, { operatorId: ownerId, name: current.name, confirmName: name });
      await tx.update(operator).set({ archivedAt: new Date() }).where(eq(operator.id, ownerId));
      held.release();
      await finish.ready;
    });
    await held.ready;
    const creation = ctx.app.inject({ method: 'POST', url: '/branches', headers: { cookie: actorCookie, 'idempotency-key': newId() }, payload: { id: branchId, name: 'ZZ TEST Stale new branch', code: `zz-test-${branchId}` } });
    try { await blockedParent(); } finally { finish.release(); }
    await retiring;
    const response = await creation;
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'OPERATOR_NOT_FOUND' } });
    expect(await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.id, branchId))).toHaveLength(0);
    expect(await writes(branchId, 'branch.create')).toHaveLength(0);
  });
});
