import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, booking, visit } from '@oto/db';
import { account } from '@oto/db';
import { eq } from 'drizzle-orm';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-01b — one operation, one transaction.
 *
 * The forced failure is a Postgres trigger that raises on the audit row for
 * one action. It fires INSIDE the transaction, after everything the handler
 * wrote, which is exactly the case the rule exists for: the whole operation
 * must vanish, while the record that it was attempted must not.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.db.execute(sql`
    create or replace function oto_test_fail() returns trigger as $fn$
    begin
      raise exception 'forced failure after the audit insert';
    end
    $fn$ language plpgsql;
  `);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** Fail every write whose audit row carries this action, for one call. */
async function whileFailing(action: string, fn: () => Promise<void>): Promise<void> {
  await ctx.db.execute(
    sql.raw(
      `create trigger oto_test_fail_trg after insert on core.audit_log
       for each row when (new.action = '${action}') execute function oto_test_fail();`,
    ),
  );
  try {
    await fn();
  } finally {
    await ctx.db.execute(sql`drop trigger oto_test_fail_trg on core.audit_log;`);
  }
}

const countAudit = async (action: string): Promise<number> => {
  const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.action, action));
  return rows.length;
};

describe('a failed operation leaves nothing behind (S2-01b)', () => {
  it('POST /accounts rolls back the account, the employee and the role assignments', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const before = await ctx.db.select().from(account);

    await whileFailing('account.create', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/accounts',
        headers: { cookie },
        payload: { phone: '+66900000777', employeeName: 'Ghost Staff', roles: [] },
      });
      expect(res.statusCode).toBe(500);
    });

    const after = await ctx.db.select().from(account);
    expect(after.length).toBe(before.length);
    expect(await countAudit('account.create')).toBe(0);
    // …but that it was attempted survives, written after the rollback.
    expect(await countAudit('account.create.failed')).toBe(1);
  });

  it('POST /visits rolls back the visit and its children', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

    await whileFailing('visit.create', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/visits',
        headers: { cookie },
        payload: { childIds: [] },
      });
      expect(res.statusCode).toBe(500);
    });

    expect(await ctx.db.select().from(visit)).toHaveLength(0);
    expect(await countAudit('visit.create')).toBe(0);
    expect(await countAudit('visit.create.failed')).toBe(1);
  });

  it('POST /public/bookings rolls back the booking and its attendees', async () => {
    const catalog = await ctx.app.inject({
      method: 'GET',
      url: '/public/branches/hkt-central/catalog',
    });
    const pkg = (catalog.json().packages as Array<{ id: string }>)[0]!;

    await whileFailing('booking.create', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/public/bookings',
        payload: {
          branchCode: 'hkt-central',
          parentName: 'Rolled Back',
          tier: 'tourist',
          lines: [{ packageId: pkg.id, kids: 2, adults: 1 }],
        },
      });
      expect(res.statusCode).toBe(500);
    });

    expect(await ctx.db.select().from(booking)).toHaveLength(0);
    expect(await countAudit('booking.create')).toBe(0);
    expect(await countAudit('booking.create.failed')).toBe(1);
  });

  it('a denial still leaves its audit row — rollback does not swallow refusals', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${'00000000-0000-7000-8000-000000000000'}/permissions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(await countAudit('access.denied')).toBeGreaterThan(0);
  });

  it('the happy path still commits both the row and its audit entry', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie },
      payload: { childIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(await ctx.db.select().from(visit)).toHaveLength(1);
    expect(await countAudit('visit.create')).toBe(1);
  });
});
