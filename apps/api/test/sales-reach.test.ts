import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { account, session as sessionTable, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-297 — how wide the sales list is, and where that width comes from.
 *
 * `GET /sales` took the branch from the query or, failing that, from the
 * caller's own session, and checked the permission only if one of those
 * produced something. With neither, no branch check ran at all and the list
 * was filtered by operator alone — every park's takings.
 *
 * It did not leak, and the reason it did not is the problem: sign-in always
 * seats a branch (SCRUM-263), and a branch-scoped grant refuses a check made
 * with no branch, so the unseated case was answered by the guard rather than
 * by the route. Both of those are fixtures. The width of an answer has to come
 * from what the caller HOLDS — the rule `services/access-control.ts` states
 * and `GET /audit` and `GET /branches` already follow — because the seat is
 * something the caller moves for themselves with `PUT /me/session/branch`.
 *
 * So the session's branch is written to null directly here. That is the state
 * the route could not answer for, and the assertion is not merely that nothing
 * leaks: it is that the right rows come back, at the right park, from the
 * grants.
 */

let ctx: TestContext;
let adminCookie: string;
let managerCookie: string;
let centralBranch: string;
let chalongBranch: string;
let centralSale: string;
let chalongSale: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  centralBranch = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalongBranch = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  // One sale at each park, written by the operator's administrator — the only
  // caller who may sell at either.
  centralSale = await sell(centralBranch);
  chalongSale = await sell(chalongBranch);

  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A sale at one park, through the real route. */
async function sell(branchId: string): Promise<string> {
  const [till] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')))
    .limit(1);
  const [pkg] = await ctx.db
    .select({ id: ticketPackage.id })
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId))
    .limit(1);
  const id = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: adminCookie },
    payload: {
      id,
      branchId,
      stationId: till!.id,
      lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 1 }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

const list = async (cookie: string, query = ''): Promise<{ statusCode: number; ids: string[]; body: string }> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/sales${query}`, headers: { cookie } });
  const ids = res.statusCode === 200 ? (res.json().sales as Array<{ id: string }>).map((s) => s.id) : [];
  return { statusCode: res.statusCode, ids, body: res.body };
};

/**
 * Take the branch off every live session this account holds — the state
 * SCRUM-263 makes rare and nothing makes impossible: an operator-wide account
 * whose operator has no live branch is seated at none, and the seat is a
 * column, not a guarantee.
 */
async function unseat(phone: string): Promise<void> {
  const [acc] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone));
  await ctx.db
    .update(sessionTable)
    .set({ branchId: null })
    .where(and(eq(sessionTable.accountId, acc!.id), isNull(sessionTable.revokedAt)));
}

describe('SCRUM-297 — the sales list is as wide as the caller’s grants', () => {
  it('shows a seated manager their own park and not the other', async () => {
    const seen = await list(managerCookie);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.ids).toContain(centralSale);
    expect(seen.ids, 'the other park’s takings are not this manager’s business').not.toContain(
      chalongSale,
    );
  });

  it('answers an unseated manager from the grants, not from the empty seat', async () => {
    await unseat(BRANCH_MANAGER.phone);
    const seen = await list(managerCookie);

    // Before SCRUM-297 this was a 403: with no branch anywhere, the check was
    // made against no branch and a branch-scoped grant refused it. The answer
    // a manager is owed is their own park, and it is the grants that say which
    // park that is.
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.ids).toContain(centralSale);
    expect(
      seen.ids,
      'an unseated session must not widen the answer to the whole estate',
    ).not.toContain(chalongSale);
  });

  it('still shows the operator’s administrator every park, seated or not', async () => {
    const seated = await list(adminCookie, `?branchId=${chalongBranch}`);
    expect(seated.statusCode).toBe(200);
    expect(seated.ids).toContain(chalongSale);

    await unseat(ADMIN.phone);
    const all = await list(adminCookie);
    expect(all.statusCode, all.body).toBe(200);
    expect(all.ids).toContain(centralSale);
    expect(all.ids, 'an operator-wide grant reaches every park, and still does').toContain(
      chalongSale,
    );
  });

  it('still refuses a park named in the query that the caller does not hold', async () => {
    const refused = await list(managerCookie, `?branchId=${chalongBranch}`);
    expect(
      refused.statusCode,
      'asking for a branch you do not hold is refused, not silently emptied',
    ).toBe(403);
  });
});
