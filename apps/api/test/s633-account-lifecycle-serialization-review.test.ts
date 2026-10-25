import { hash } from '@node-rs/argon2';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, operator, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import type { Tx } from '../src/services/tx';
import { createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let sequence = 0;
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};

beforeAll(async () => { ctx = await createTestContext(); }, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function twoAdministrators() {
  const operatorId = newId(), branchId = newId();
  await ctx.db.insert(operator).values({ id: operatorId, name: 'ZZ TEST 633 lifecycle race' });
  await ctx.db.insert(branch).values({ id: branchId, operatorId, name: 'ZZ TEST 633 race park', code: `zz-test-${branchId}` });
  const [adminRole] = await ctx.db.select().from(role).where(and(isNull(role.operatorId), eq(role.name, 'operator_admin')));
  const actors = [];
  for (let n = 0; n < 2; n += 1) {
    const id = newId(), assignmentId = newId(), password = newId();
    const phone = `+668634${String(++sequence).padStart(5, '0')}`;
    await ctx.db.insert(account).values({ id, operatorId, phone, status: 'active', passwordHash: await hash(password), phoneVerifiedAt: new Date() });
    await ctx.db.insert(roleAssignment).values({ id: assignmentId, accountId: id, roleId: adminRole!.id, scopeType: 'operator', scopeId: operatorId });
    actors.push({ id, assignmentId, cookie: await signInAs(ctx.app, phone, password) });
  }
  return { operatorId, actors: actors as [typeof actors[number], typeof actors[number]] };
}

/** Force both real requests to reach a database lock before either may commit. */
async function whileHeld<T>(lock: (tx: Tx) => Promise<unknown>, work: () => Promise<T>, waiting = 2): Promise<T> {
  const held = gate(), finish = gate();
  const holder = ctx.db.transaction(async tx => {
    await lock(tx);
    held.release();
    await finish.ready;
  });
  await held.ready;
  const running = Promise.resolve().then(work);
  try {
    await expect.poll(async () => {
      const result = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n
        from pg_stat_activity where datname=current_database() and application_name='oto-test-api'
        and pid<>pg_backend_pid() and wait_event_type='Lock'`);
      return result.rows[0]!.n;
    }, { timeout: 10_000, interval: 20 }).toBe(waiting);
  } finally {
    finish.release();
    await holder;
    await running;
  }
  return running;
}

const disable = (actor: { id: string; cookie: string }) => ctx.app.inject({
  method: 'PATCH', url: `/accounts/${actor.id}`, headers: { cookie: actor.cookie, 'idempotency-key': newId() }, payload: { status: 'inactive' },
});

async function survivingAdministrators(operatorId: string) {
  return ctx.db.selectDistinct({ id: account.id }).from(account)
    .innerJoin(roleAssignment, eq(roleAssignment.accountId, account.id))
    .innerJoin(rolePermission, eq(rolePermission.roleId, roleAssignment.roleId))
    .where(and(eq(account.operatorId, operatorId), eq(account.status, 'active'),
      eq(roleAssignment.scopeType, 'operator'), eq(roleAssignment.scopeId, operatorId), eq(rolePermission.permission, 'admin:role:assign')));
}

describe('SCRUM-633 account lifecycle serialization', () => {
  it('P1 concurrent self-deactivations cannot both consume the last active administrator', async () => {
    const fixture = await twoAdministrators();
    expect(await survivingAdministrators(fixture.operatorId)).toHaveLength(2);
    const responses = await whileHeld(
      tx => tx.execute(sql`select id from core.account where id in (${fixture.actors[0].id}, ${fixture.actors[1].id}) for no key update`),
      () => Promise.all(fixture.actors.map(actor => disable(actor))),
    );
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    expect(await survivingAdministrators(fixture.operatorId)).toHaveLength(1);
    const writes = await ctx.db.select().from(auditLog).where(and(eq(auditLog.operatorId, fixture.operatorId), eq(auditLog.action, 'account.update')));
    expect(writes).toHaveLength(1);
  });

  it('P1 removing one administrator grant and disabling the other share the same last-administrator boundary', async () => {
    const fixture = await twoAdministrators(), [left, right] = fixture.actors;
    const responses = await whileHeld(async tx => {
      await tx.execute(sql`select id from core.role_assignment where id=${left.assignmentId} for update`);
      await tx.execute(sql`select id from core.account where id=${right.id} for no key update`);
    }, () => Promise.all([
      ctx.app.inject({ method: 'DELETE', url: `/accounts/${left.id}/role-assignments/${left.assignmentId}`, headers: { cookie: left.cookie, 'idempotency-key': newId() } }),
      disable(right),
    ]));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    expect(await survivingAdministrators(fixture.operatorId)).toHaveLength(1);
    const writes = await ctx.db.select().from(auditLog).where(and(eq(auditLog.operatorId, fixture.operatorId), inArray(auditLog.action, ['account.update', 'role_assignment.delete'])));
    expect(writes).toHaveLength(1);
  });

  it('an activation waits for the operator lifecycle boundary before changing the account', async () => {
    const fixture = await twoAdministrators(), [left, right] = fixture.actors;
    await ctx.db.update(account).set({ status: 'inactive' }).where(eq(account.id, right.id));
    const response = await whileHeld(
      tx => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${fixture.operatorId}, 633))`),
      async () => ctx.app.inject({ method: 'PATCH', url: `/accounts/${right.id}`, headers: { cookie: left.cookie, 'idempotency-key': newId() }, payload: { status: 'active' } }),
      1,
    );
    expect(response.statusCode).toBe(200);
    expect((await ctx.db.select().from(account).where(eq(account.id, right.id)))[0]!.status).toBe('active');
  });
});
