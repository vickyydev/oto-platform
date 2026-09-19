import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { and, eq } from 'drizzle-orm';
import {
  account,
  branch,
  branchHoliday,
  branchTaxConfig,
  child,
  department,
  employee,
  member,
  memberTierVerification,
  operator,
  product,
  productCategory,
  role,
  roleAssignment,
  rolePermission,
  station,
  ticketPackage,
  tier,
} from '@oto/db';
import { seed } from '@oto/db/seed';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * S2-01b — the seed is the `platform:sync` step, so it runs against databases
 * that are already seeded. The test context seeds once; every case here runs
 * it a second time.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function counts(): Promise<Record<string, number>> {
  const size = async (rows: Promise<unknown[]>) => (await rows).length;
  return {
    operator: await size(ctx.db.select().from(operator)),
    branch: await size(ctx.db.select().from(branch)),
    department: await size(ctx.db.select().from(department)),
    employee: await size(ctx.db.select().from(employee)),
    account: await size(ctx.db.select().from(account)),
    role: await size(ctx.db.select().from(role)),
    rolePermission: await size(ctx.db.select().from(rolePermission)),
    roleAssignment: await size(ctx.db.select().from(roleAssignment)),
    tier: await size(ctx.db.select().from(tier)),
    member: await size(ctx.db.select().from(member)),
    memberTierVerification: await size(ctx.db.select().from(memberTierVerification)),
    child: await size(ctx.db.select().from(child)),
    ticketPackage: await size(ctx.db.select().from(ticketPackage)),
    branchHoliday: await size(ctx.db.select().from(branchHoliday)),
    branchTaxConfig: await size(ctx.db.select().from(branchTaxConfig)),
    productCategory: await size(ctx.db.select().from(productCategory)),
    product: await size(ctx.db.select().from(product)),
    station: await size(ctx.db.select().from(station)),
  };
}

const receptionRoleId = async () => {
  const [row] = await ctx.db.select().from(role).where(eq(role.name, 'reception')).limit(1);
  return row!.id;
};

describe('platform sync (S2-01b)', () => {
  it('runs a second time without failing or duplicating a row', async () => {
    const before = await counts();
    await seed(ctx.db);
    expect(await counts()).toEqual(before);
  });

  it('restores a permission a bundle carries but the database has lost', async () => {
    const roleId = await receptionRoleId();
    await ctx.db
      .delete(rolePermission)
      .where(and(eq(rolePermission.roleId, roleId), eq(rolePermission.permission, 'pos:sale:create')));

    await seed(ctx.db);

    const rows = await ctx.db.select().from(rolePermission).where(eq(rolePermission.roleId, roleId));
    expect(rows.map((r) => r.permission)).toContain('pos:sale:create');
  });

  it('withdraws a permission the bundle no longer carries', async () => {
    const roleId = await receptionRoleId();
    await ctx.db
      .insert(rolePermission)
      .values({ id: newId(), roleId, permission: 'pos:nonsense:do' });

    await seed(ctx.db);

    const rows = await ctx.db.select().from(rolePermission).where(eq(rolePermission.roleId, roleId));
    expect(rows.map((r) => r.permission)).not.toContain('pos:nonsense:do');
  });

  it('marks the seeded roles as system roles the platform owns', async () => {
    const rows = await ctx.db.select().from(role);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.isSystem && r.operatorId === null)).toBe(true);
  });

  it('leaves the dev accounts and demo families alone', async () => {
    const [before] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, '+66900000002'))
      .limit(1);

    await seed(ctx.db);

    const [after] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, '+66900000002'))
      .limit(1);
    expect(after!.id).toBe(before!.id);
    expect(after!.passwordHash).toBe(before!.passwordHash);

    const [mali] = await ctx.db.select().from(member).where(eq(member.nickname, 'Mali')).limit(1);
    const kids = await ctx.db.select().from(child).where(eq(child.memberId, mali!.id));
    expect(kids).toHaveLength(2);
  });
});
