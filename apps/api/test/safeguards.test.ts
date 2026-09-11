import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, member } from '@oto/db';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let reception: string;
let admin: string;
beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-15 — idempotency', () => {
  it('replaying the same request with the same key stores one record and identical responses', async () => {
    const payload = { phone: '+66611111222', nickname: 'IdemTest' };
    const headers = { cookie: reception, 'idempotency-key': 'idem-1' };
    const first = await ctx.app.inject({ method: 'POST', url: '/members', payload, headers });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/members', payload, headers });
    expect(second.statusCode).toBe(200);
    // Replay serves the stored response — semantically identical JSON (jsonb
    // storage does not preserve key order).
    expect(second.json()).toEqual(first.json());
    const rows = await ctx.db.select().from(member).where(eq(member.phone, '+66611111222'));
    expect(rows).toHaveLength(1);
  });

  it('the same key with a different body returns 409', async () => {
    const headers = { cookie: reception, 'idempotency-key': 'idem-1' };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      payload: { phone: '+66611111333', nickname: 'Different' },
      headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

describe('SCRUM-14 — audit coverage with before/after', () => {
  const rowsFor = (entityType: string, action: string) =>
    ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).then((r) =>
      r.filter((x) => x.entityType === entityType),
    );

  it('member creation is audited', async () => {
    const rows = await rowsFor('member', 'member.create');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.after).toBeTruthy();
  });

  it('account creation and role assignment are audited', async () => {
    const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: admin } });
    const branchId = branches.json().branches[0].id as string;
    await ctx.app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { cookie: admin },
      payload: {
        phone: '+66655554444',
        employeeName: 'Audit Target',
        roles: [{ roleName: 'staff', scopeType: 'branch', scopeId: branchId }],
      },
    });
    expect((await rowsFor('account', 'account.create')).length).toBeGreaterThan(0);

    const accounts = await ctx.app.inject({ method: 'GET', url: '/accounts?q=Audit%20Target', headers: { cookie: admin } });
    const acc = accounts.json().accounts[0];
    await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${acc.id}/role-assignments`,
      headers: { cookie: admin },
      payload: { roleName: 'reception', scopeType: 'branch', scopeId: branchId },
    });
    expect((await rowsFor('role_assignment', 'role_assignment.create')).length).toBeGreaterThan(0);
  });

  it('ticket package update is audited with before and after', async () => {
    const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: admin } });
    const branchId = branches.json().branches[0].id as string;
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie: admin },
    });
    const pkg = list.json().packages[0];
    await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/ticket-packages/${pkg.id}`,
      headers: { cookie: admin },
      payload: { description: 'Updated for audit test' },
    });
    const rows = await rowsFor('ticket_package', 'ticket_package.update');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.before).toBeTruthy();
    expect(rows[0]!.after).toBeTruthy();
  });

  it('GET /audit is filtered and permission-guarded', async () => {
    const denied = await ctx.app.inject({ method: 'GET', url: '/audit', headers: { cookie: reception } });
    expect(denied.statusCode).toBe(403);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/audit?entityType=member',
      headers: { cookie: admin },
    });
    expect(ok.statusCode).toBe(200);
    const entries = ok.json().entries as Array<{ entityType: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.entityType === 'member')).toBe(true);
  });
});
