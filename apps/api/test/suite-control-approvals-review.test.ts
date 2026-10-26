import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { account, auditLog, operator, role, roleAssignment, rolePermission, setting, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpContext, Tx } from '../src/services/tx';
import { withTx } from '../src/services/tx';
import { audit } from '../src/services/audit';
import { assertNotLastOperatorAdmin } from '../src/services/access-control';
import { createTestContext, teardownAll, type TestContext } from './helpers';

type Operation = {
  schemaVersion: 1; action: 'kill_switch.set'; key: string; targetApp: 'booth';
  scopeType: 'operator'; scopeId: string; operatorId: string; expectedRevision: number;
  value: boolean; expiresAt: string; reason: string;
};
type View = {
  id: string; state: 'pending' | 'approved' | 'consumed' | 'expired'; payloadSha256: string;
  operatorId: string | null; requesterAccountId: string; approverAccountId: string | null;
  operation: Operation; createdAt: string; requestExpiresAt: string;
};
type Service = {
  requestSuiteControlApproval(db: Db, ctx: OpContext, operation: Operation): Promise<View>;
  approveSuiteControlApproval(db: Db, ctx: OpContext, input: { id: string; expectedPayloadSha256: string }): Promise<View>;
  expireSuiteControlApproval(db: Db, ctx: OpContext, input: { id: string }): Promise<View>;
  consumeSuiteControlApproval<T>(tx: Tx, ctx: OpContext, input: { id: string; expectedPayloadSha256: string }, effect: (tx: Tx, operation: Operation) => Promise<T>): Promise<{ approval: View; result: T } | { approval: View }>;
};
let ctx: TestContext;
let api: Service | null = null;
const own = newId(), other = newId(), requester = newId(), approver = newId(), outsider = newId(), lookalike = newId();
const permission = 'console:release:kill_switch';
let platformRole: string, customRole: string, localRole: string;
const actor = (id: string): OpContext => ({ actorAccountId: id, operatorId: id === requester ? own : other, branchId: null, requestId: 'ZZ-TEST-643-' + newId() });
const intent = (): Operation => ({ schemaVersion: 1, action: 'kill_switch.set', key: 'booth.enabled', targetApp: 'booth',
  scopeType: 'operator', scopeId: own, operatorId: own, expectedRevision: 0, value: false,
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), reason: 'ZZ TEST 643 reviewed control change' });
function service() {
  expect(api, 'the native durable approval contract must exist before a dangerous action can be approved').not.toBeNull();
  return api!;
}
const bound = (r: View) => ({ id: r.id, expectedPayloadSha256: r.payloadSha256 });
async function state(id: string) {
  return (await ctx.db.execute<{ state: string; approver_account_id: string | null; operator_id: string | null }>(
    // Safe IDs only; no authentication or raw request payload is selected.
    sql`select state, approver_account_id, operator_id from core.suite_control_approval where id = ${id}`)).rows[0];
}
async function effectCount(id: string) {
  return (await ctx.db.select().from(setting).where(and(eq(setting.operatorId, own), eq(setting.key, 'ZZ TEST approval ' + id)))).length;
}
async function consume(r: View, id = requester) {
  return ctx.db.transaction(tx => service().consumeSuiteControlApproval(tx, actor(id), bound(r), async (effectTx, operation) => {
    expect(effectTx === tx).toBe(true); expect(operation).toEqual(r.operation);
    await effectTx.insert(setting).values({ operatorId: own, key: 'ZZ TEST approval ' + r.id, value: { syntheticEffect: true } });
    return { changed: true };
  }));
}
async function approved() {
  const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
  await service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r));
  return r;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  const modulePath = '../src/services/suite-control-approvals';
  // The initial RED is an explicit absent contract assertion, not a top-level module/setup crash.
  try { api = await import(modulePath) as Service; } catch { api = null; }
  await ctx.db.insert(operator).values([{ id: own, name: 'ZZ TEST 643 approval owner' }, { id: other, name: 'ZZ TEST 643 approving operator' }]);
  await ctx.db.insert(account).values([requester, approver, outsider, lookalike].map((id, n) => ({
    id, operatorId: n === 0 ? own : other, phone: 'ZZ TEST 643 approver ' + n, status: 'active' as const, mustChangePassword: false,
  })));
  const [pa] = await ctx.db.select().from(role).where(and(isNull(role.operatorId), eq(role.name, 'platform_admin'), eq(role.isSystem, true)));
  platformRole = pa!.id; customRole = newId(); localRole = newId();
  await ctx.db.insert(role).values([{ id: customRole, name: 'ZZ TEST 643 custom global', operatorId: other },
    { id: localRole, name: 'platform_admin', operatorId: other, isSystem: false }]);
  await ctx.db.insert(rolePermission).values([platformRole, customRole, localRole].map(roleId => ({ id: newId(), roleId, permission }))).onConflictDoNothing();
}, 180_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  await ctx.db.update(operator).set({ archivedAt: null }).where(inArray(operator.id, [own, other]));
  await ctx.db.update(account).set({ status: 'active', mustChangePassword: false }).where(inArray(account.id, [requester, approver, outsider, lookalike]));
  await ctx.db.delete(roleAssignment).where(inArray(roleAssignment.accountId, [requester, approver, outsider, lookalike]));
  await ctx.db.insert(roleAssignment).values([requester, approver, outsider].map(accountId => ({ id: newId(), accountId, roleId: platformRole, scopeType: 'operator' as const, scopeId: null })));
});

describe('SCRUM-643 native durable two-admin approval foundation', () => {
  it('R1 control: native fixture has distinct active admins in two operators', async () => {
    expect((await ctx.db.select({ id: account.id }).from(account).where(inArray(account.id, [requester, approver]))).length).toBe(2);
    expect(requester === approver).toBe(false);
  });

  it('R2 high: request and second-admin approval bind one immutable operation, ten-minute deadline and audit pair', async () => {
    const original = intent(), r = await service().requestSuiteControlApproval(ctx.db, actor(requester), original);
    original.value = true; original.reason = 'ZZ TEST changed caller object';
    expect(r.state).toBe('pending'); expect(r.operation.value).toBe(false);
    expect(Date.parse(r.requestExpiresAt) - Date.parse(r.createdAt)).toBe(600_000);
    expect(r.requesterAccountId).toBe(requester); expect(r.operatorId).toBe(own);
    const a = await service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r));
    expect(a.state).toBe('approved'); expect(a.approverAccountId).toBe(approver); expect(a.operation).toEqual(r.operation);
    const rows = await ctx.db.select({ action: auditLog.action, actor: auditLog.actorAccountId, owner: auditLog.operatorId }).from(auditLog).where(eq(auditLog.entityId, r.id));
    expect(rows).toContainEqual({ action: 'suite_control.approval_requested', actor: requester, owner: own });
    expect(rows).toContainEqual({ action: 'suite_control.approval_approved', actor: approver, owner: own });
    const pair = await ctx.db.select({ action: auditLog.action, after: auditLog.after }).from(auditLog)
      .where(and(eq(auditLog.entityId, r.id), inArray(auditLog.action, ['suite_control.approval_requested', 'suite_control.approval_approved'])));
    expect(pair).toContainEqual({ action: 'suite_control.approval_requested', after: expect.objectContaining({
      targetApp: r.operation.targetApp, reason: r.operation.reason, requesterAccountId: requester, approverAccountId: null,
    }) });
    expect(pair).toContainEqual({ action: 'suite_control.approval_approved', after: expect.objectContaining({
      targetApp: r.operation.targetApp, reason: r.operation.reason, requesterAccountId: requester, approverAccountId: approver,
    }) });
  });

  it('R3 critical: self-approval and a changed payload hash refuse without effect or approval transition', async () => {
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    await expect(service().approveSuiteControlApproval(ctx.db, actor(requester), bound(r))).rejects.toMatchObject({ statusCode: 403 });
    await expect(service().approveSuiteControlApproval(ctx.db, actor(approver), { id: r.id, expectedPayloadSha256: '0'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
    expect((await state(r.id))?.state).toBe('pending'); expect(await effectCount(r.id)).toBe(0);
  });

  it('R4 critical: custom global, operator-local platform_admin and branch assignments cannot substitute for the real platform role', async () => {
    for (const [roleId, scopeType, scopeId] of [[customRole, 'operator', null], [localRole, 'operator', null], [platformRole, 'branch', own]] as const) {
      await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, lookalike));
      await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: lookalike, roleId, scopeType, scopeId });
      await expect(service().requestSuiteControlApproval(ctx.db, actor(lookalike), intent())).rejects.toMatchObject({ statusCode: 403 });
    }
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    await expect(service().approveSuiteControlApproval(ctx.db, actor(lookalike), bound(r))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('R5 critical: requester grant revocation after request blocks approval, including soft withdrawal', async () => {
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.accountId, requester));
    await expect(service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r))).rejects.toMatchObject({ statusCode: 403 });
    expect((await state(r.id))?.state).toBe('pending');
  });

  it('R6 critical: requester or approver revoked after approval cannot be consumed through stale supplied authority', async () => {
    for (const id of [requester, approver]) {
      const r = await approved();
      await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.accountId, id));
      await expect(consume(r)).rejects.toMatchObject({ statusCode: 403 });
      expect((await state(r.id))?.state).toBe('approved'); expect(await effectCount(r.id)).toBe(0);
      await ctx.db.update(roleAssignment).set({ archivedAt: null }).where(eq(roleAssignment.accountId, id));
    }
  });

  it('R7 high: inactive/temp-password accounts and archived home operators do not create dangerous requests', async () => {
    for (const update of [{ status: 'inactive' as const }, { mustChangePassword: true }]) {
      await ctx.db.update(account).set(update).where(eq(account.id, requester));
      await expect(service().requestSuiteControlApproval(ctx.db, actor(requester), intent())).rejects.toMatchObject({ statusCode: 403 });
      await ctx.db.update(account).set({ status: 'active', mustChangePassword: false }).where(eq(account.id, requester));
    }
    await ctx.db.update(operator).set({ archivedAt: new Date() }).where(eq(operator.id, own));
    await expect(service().requestSuiteControlApproval(ctx.db, actor(requester), intent())).rejects.toMatchObject({ statusCode: 403 });
  });

  it('R8 high: deadline expiry returns a committed expired outcome and owner-preserving expiry audit, without effects', async () => {
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(r.requestExpiresAt));
    try {
      const expired = await service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r));
      expect(expired.state).toBe('expired'); expect((await state(r.id))?.state).toBe('expired');
      expect(await effectCount(r.id)).toBe(0);
      const rows = await ctx.db.select({ owner: auditLog.operatorId }).from(auditLog).where(and(eq(auditLog.entityId, r.id), eq(auditLog.action, 'suite_control.approval_expired')));
      expect(rows).toEqual([{ owner: own }]);
    } finally { vi.useRealTimers(); }
  });

  it('R9 critical: approval cannot activate an intended switch whose own expiry has already passed', async () => {
    const op = intent(); op.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), op);
    await service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(op.expiresAt));
    try { await expect(consume(r)).rejects.toMatchObject({ statusCode: 409 }); expect(await effectCount(r.id)).toBe(0); }
    finally { vi.useRealTimers(); }
  });

  it('R10 critical: concurrent consumes invoke one effect, and consumed replay never invokes a second', async () => {
    const r = await approved();
    const outcomes = await Promise.allSettled([consume(r), consume(r)]);
    expect(outcomes.filter(o => o.status === 'fulfilled').length).toBe(1);
    expect(outcomes.filter(o => o.status === 'rejected').length).toBe(1);
    expect((await state(r.id))?.state).toBe('consumed'); expect(await effectCount(r.id)).toBe(1);
    await expect(consume(r)).rejects.toMatchObject({ statusCode: 409 }); expect(await effectCount(r.id)).toBe(1);
  });

  it('R11 critical: effect failure and caller rollback leave approval reusable and roll back effect plus consumed audit', async () => {
    for (const outerFailure of [false, true]) {
      const r = await approved();
      await expect(ctx.db.transaction(async tx => {
        await service().consumeSuiteControlApproval(tx, actor(requester), bound(r), async effectTx => {
          await effectTx.insert(setting).values({ operatorId: own, key: 'ZZ TEST approval ' + r.id, value: { syntheticEffect: true } });
          if (!outerFailure) throw Error('ZZ_TEST_EFFECT_FAILURE');
          return { changed: true };
        });
        throw Error('ZZ_TEST_CALLER_ROLLBACK');
      })).rejects.toThrow();
      expect((await state(r.id))?.state).toBe('approved'); expect(await effectCount(r.id)).toBe(0);
      expect((await ctx.db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, r.id), eq(auditLog.action, 'suite_control.approval_consumed')))).length).toBe(0);
    }
  });

  it('R12 high: approval audit failure rolls the approval transition back', async () => {
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    const original = audit.record.bind(audit);
    vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
      if (entry.action === 'suite_control.approval_approved') throw Error('ZZ_TEST_AUDIT_FAILURE');
      return original(tx, entry);
    });
    try { await expect(service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r))).rejects.toThrow(); expect((await state(r.id))?.state).toBe('pending'); }
    finally { vi.restoreAllMocks(); }
  });

  it('R13 critical: stored operation mutation cannot reuse the original reviewed payload hash', async () => {
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    await ctx.db.execute(sql`update core.suite_control_approval set operation = jsonb_set(operation, '{value}', 'true'::jsonb) where id = ${r.id}`);
    await expect(service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r))).rejects.toMatchObject({ statusCode: 409 });
    expect((await state(r.id))?.state).toBe('pending'); expect(await effectCount(r.id)).toBe(0);
  });

  it('R14 high: an unrelated third platform admin cannot consume the two reviewed actors\' request', async () => {
    const r = await approved();
    await expect(consume(r, outsider)).rejects.toMatchObject({ statusCode: 403 });
    expect((await state(r.id))?.state).toBe('approved'); expect(await effectCount(r.id)).toBe(0);
  });

  it('R15 high: native grant removal commits while concurrent approval observes revocation without an audit-FK deadlock', async () => {
    // Exact native critical-section order from DELETE /accounts/:id/role-assignments/:assignmentId.
    // Fix: approval account locks must permit the deletion audit's actor foreign-key check.
    const native = readFileSync(new URL('../src/routes/accounts.ts', import.meta.url), 'utf8');
    const deleteAt = native.indexOf('await tx.delete(roleAssignment).where(eq(roleAssignment.id, req.params.assignmentId))');
    expect(deleteAt > 0 && native.indexOf("action: 'role_assignment.delete'", deleteAt) > deleteAt).toBe(true);
    const survivor = newId();
    await ctx.db.insert(account).values({ id: survivor, operatorId: own, phone: 'ZZ TEST 643 surviving home admin', status: 'active' });
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: survivor, roleId: platformRole, scopeType: 'operator', scopeId: null });
    const r = await service().requestSuiteControlApproval(ctx.db, actor(requester), intent());
    const [assignment] = await ctx.db.select().from(roleAssignment).where(and(eq(roleAssignment.accountId, requester), eq(roleAssignment.roleId, platformRole)));
    let releaseAudit!: () => void, signalDeleted!: (ready: boolean) => void;
    const auditHeld = new Promise<void>(resolve => { releaseAudit = resolve; });
    const deleted = new Promise<boolean>(resolve => { signalDeleted = resolve; });
    let deleterPid = 0;
    const outcome = (error: unknown) => {
      const e = error as { statusCode?: number; code?: string; cause?: { code?: string } };
      return { ok: false as const, statusCode: e.statusCode ?? null, pgCode: e.cause?.code ?? e.code ?? null };
    };
    const deletion = withTx(ctx.db, actor(requester), 'role_assignment.delete', async tx => {
      deleterPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${own}, 633))`);
      await assertNotLastOperatorAdmin(tx as Db, own, { accountId: requester, assignmentId: assignment!.id });
      await tx.delete(roleAssignment).where(eq(roleAssignment.id, assignment!.id));
      signalDeleted(true);
      await auditHeld;
      await audit.record(tx, { actorAccountId: requester, operatorId: own, action: 'role_assignment.delete',
        entityType: 'role_assignment', entityId: assignment!.id, before: assignment });
      return { ok: true as const };
    }).catch(error => { signalDeleted(false); return outcome(error); });
    let approval: Promise<{ ok: true } | ReturnType<typeof outcome>> | undefined;
    try {
      expect(await deleted).toBe(true);
      approval = service().approveSuiteControlApproval(ctx.db, actor(approver), bound(r))
        .then(() => ({ ok: true as const }), outcome);
      const deadline = performance.now() + 5000;
      let waiting = false;
      while (performance.now() < deadline) {
        const result = await ctx.db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity a join pg_locks l on l.pid = a.pid
          where a.datname = current_database() and a.wait_event_type = 'Lock' and not l.granted
            and ${deleterPid} = any(pg_blocking_pids(a.pid)) and position('role_assignment' in a.query) > 0
        ) as waiting`);
        if (result.rows[0]!.waiting) { waiting = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(waiting, 'approval reached the actual deleted-grant lock before releasing the native audit').toBe(true);
    } finally {
      releaseAudit();
      // Settle both operations even if the barrier assertion fails; no native transaction is abandoned.
      const [removed, checked] = await Promise.all([deletion, approval ?? Promise.resolve({ ok: false as const })]);
      expect(removed).toEqual({ ok: true });
      expect(checked).toMatchObject({ ok: false, statusCode: 403 });
    }
    expect((await state(r.id))?.state).toBe('pending'); expect(await effectCount(r.id)).toBe(0);
    expect((await ctx.db.select({ id: roleAssignment.id }).from(roleAssignment).where(eq(roleAssignment.id, assignment!.id))).length).toBe(0);
  }, 20_000);
});
