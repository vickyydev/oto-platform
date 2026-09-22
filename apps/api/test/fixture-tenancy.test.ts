import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { account, box, branch, operator, station } from '@oto/db';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  boxBySlot,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-289 — the fixture carries two operators, and keeps carrying them.
 *
 * Row-scoped tenancy is the platform's oldest decision. Until the seed grew a
 * second operator, nothing in this suite could tell a query that filters by
 * operator from a query that filters by nothing, because both returned the
 * same rows — and four cross-operator holes reached staging through that gap,
 * two of them security (SCRUM-280, SCRUM-281). Nine test files built a tenant
 * by hand for one assertion each; the other thirty-five encoded "one operator,
 * nil reach" as the premise without ever saying so.
 *
 * So the second operator is now in the default context, and this file is what
 * stops it quietly going away again. Everything else in the suite benefits
 * from it passively — every route test runs with a foreign row present whether
 * its author thought about tenancy or not — and passive benefits are the kind
 * that disappear without anybody noticing.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the default fixture is multi-tenant (SCRUM-289)', () => {
  it('seeds two operators, and the second one is a tenant rather than a row', async () => {
    const operators = await ctx.db.select().from(operator);
    expect(operators.map((o) => o.name).sort()).toEqual(
      [OTO_OPERATOR_NAME, SECOND_OPERATOR_NAME].sort(),
    );

    // A tenant is not a name: it is somewhere to trade, somebody to sign in
    // and something to sign in at. Without all three the foreign rows this
    // suite leans on cannot be reached through any route.
    const second = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    const [theirBranch] = await ctx.db.select().from(branch).where(eq(branch.operatorId, second));
    expect(theirBranch?.code).toBe(SECOND_OPERATOR_BRANCH_CODE);
    expect(
      await ctx.db.select().from(account).where(eq(account.operatorId, second)),
    ).toHaveLength(1);
    expect(
      await ctx.db.select().from(station).where(eq(station.operatorId, second)),
    ).toHaveLength(1);
    expect(await ctx.db.select().from(box).where(eq(box.operatorId, second))).toHaveLength(1);
  });

  it('keeps the trap it exists to reproduce: one slot, two operators', async () => {
    // `box_slot_unique` is keyed on (branch, slot), so `virtual-1` is a
    // perfectly legal name in both tenants — and ten places in this suite used
    // to look a box up by that slot alone. Five broke the day this row
    // appeared; the other five were passing on whichever row Postgres returned
    // first, which is the same bug wearing a green tick. If the second
    // operator's box were ever given a slot of its own the collision would
    // stop being reproduced and the habit would grow back, so it is asserted
    // here rather than left to the seed.
    const rows = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.operatorId)).size).toBeGreaterThanOrEqual(2);

    const ours = await boxBySlot(ctx.db, 'virtual-1');
    expect(ours.operatorId).toBe(await operatorIdByName(ctx.db, OTO_OPERATOR_NAME));
  });

  it('the second operator signs in and sees its own branch and nothing of the park', async () => {
    const cookie = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/branches',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const codes = res.json<{ branches: Array<{ code: string }> }>().branches.map((b) => b.code);
    expect(codes).toEqual([SECOND_OPERATOR_BRANCH_CODE]);
    expect(codes).not.toContain(CENTRAL_BRANCH_CODE);
    expect(codes).not.toContain(CHALONG_BRANCH_CODE);
  });

  it('the park’s administrator sees the park’s branches and not the second operator’s', async () => {
    // The other direction, because a tenancy assertion in one direction only
    // is satisfied by a route that returns nothing to anybody.
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const codes = res.json<{ branches: Array<{ code: string }> }>().branches.map((b) => b.code);
    expect(codes.sort()).toEqual([CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE].sort());
  });

  it('the seeded phone numbers are unique across the platform, not only per operator', async () => {
    /**
     * `account.phone` is unique per OPERATOR, so the same number in two
     * tenants is legal — and sign-in would then be a coin toss.
     * `findAccountByPhone` in `services/auth.ts` searches on the phone alone
     * when the caller has not said which operator it means, and takes the
     * first row. The fixture must never be the thing that makes that
     * ambiguous, or every sign-in in this suite becomes order-dependent.
     */
    const rows = await ctx.db.select({ phone: account.phone }).from(account);
    expect(new Set(rows.map((r) => r.phone)).size).toBe(rows.length);
  });
});
