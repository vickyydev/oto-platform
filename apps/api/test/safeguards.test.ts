import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, idempotencyKey, member } from '@oto/db';
import { newId } from '@oto/shared';
import { purgeExpiredIdempotencyKeys, type IdempotencyClaim } from '../src/plugins/idempotency';
import { withTx } from '../src/services/tx';
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
  it.each(['later', 'nested'] as const)('a %s transaction under one claim cannot replace its public answer (SCRUM-387)', async (position) => {
    const [actor] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone));
    const claim: IdempotencyClaim = { key: `answer-${newId()}`, accountId: actor!.id };
    await ctx.db.insert(idempotencyKey).values({
      key: claim.key, accountId: claim.accountId, requestHash: 'scrum-387',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const operation = { idempotency: claim };
    const answer = { sale: { id: newId() }, finalised: true };
    const queueCommand = () => withTx(ctx.db, operation, 'test.command', async () => ({ commandId: newId() }));
    await withTx(ctx.db, operation, 'test.sale', async () => {
      if (position === 'nested') await queueCommand();
      return answer;
    });
    if (position === 'later') await queueCommand();
    const [stored] = await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, claim.key));
    expect(stored!.statusCode).toBe(200);
    expect(stored!.responseBody).toEqual(answer);
    expect(claim.stored).toBe(true);
  });

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

  // S2-01b — the race Sprint 1 could lose: read-then-write let two retries
  // both decide they were first. The claim is one statement now.
  it('two identical requests sent at once produce one member and one winner', async () => {
    const payload = { phone: '+66611114444', nickname: 'RaceTest' };
    const headers = { cookie: reception, 'idempotency-key': 'idem-race' };
    const [a, b] = await Promise.all([
      ctx.app.inject({ method: 'POST', url: '/members', payload, headers }),
      ctx.app.inject({ method: 'POST', url: '/members', payload, headers }),
    ]);

    const rows = await ctx.db.select().from(member).where(eq(member.phone, '+66611114444'));
    expect(rows).toHaveLength(1);

    const codes = [a.statusCode, b.statusCode].sort();
    // One did the work. The other either replayed the stored response or was
    // told the original is still running — never a second member.
    expect(codes[0]).toBe(200);
    expect([200, 409]).toContain(codes[1]);
    const loser = [a, b].find((r) => r.statusCode === 409);
    if (loser) {
      expect(loser.json().error.code).toBe('IDEMPOTENCY_IN_FLIGHT');
      expect(loser.headers['retry-after']).toBe('1');
    }
  });

  it('a 5xx releases the key so a real retry runs', async () => {
    const headers = { cookie: admin, 'idempotency-key': 'idem-after-500' };
    // Force the failure inside the create, exactly as transactions.test.ts does.
    await ctx.db.execute(sql`
      create or replace function oto_idem_fail() returns trigger as $fn$
      begin raise exception 'forced'; end $fn$ language plpgsql;
    `);
    await ctx.db.execute(
      sql.raw(`create trigger oto_idem_fail_trg after insert on core.audit_log
               for each row when (new.action = 'member.create') execute function oto_idem_fail();`),
    );
    const payload = { phone: '+66611115555', nickname: 'AfterFailure' };
    const failed = await ctx.app.inject({ method: 'POST', url: '/members', payload, headers });
    expect(failed.statusCode).toBe(500);
    await ctx.db.execute(sql`drop trigger oto_idem_fail_trg on core.audit_log;`);

    // The same key again does the work rather than replaying the failure.
    const retried = await ctx.app.inject({ method: 'POST', url: '/members', payload, headers });
    expect(retried.statusCode).toBe(200);
    const rows = await ctx.db.select().from(member).where(eq(member.phone, '+66611115555'));
    expect(rows).toHaveLength(1);
  });

  it('a client-minted id makes a retry return the row that exists', async () => {
    const id = newId();
    const payload = { id, phone: '+66611116666', nickname: 'ClientId' };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      payload,
      headers: { cookie: reception },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().member.id).toBe(id);

    // No idempotency key this time — the id alone is enough.
    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      payload,
      headers: { cookie: reception },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['x-oto-replay']).toBe('true');
    expect(retry.json().member.id).toBe(id);
    const rows = await ctx.db.select().from(member).where(eq(member.phone, '+66611116666'));
    expect(rows).toHaveLength(1);
  });

  it('expired keys are purged', async () => {
    await ctx.db
      .update(idempotencyKey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(idempotencyKey.key, 'idem-1'));
    const purged = await purgeExpiredIdempotencyKeys(ctx.db);
    expect(purged).toBeGreaterThan(0);
    const left = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, 'idem-1'));
    expect(left).toHaveLength(0);
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
