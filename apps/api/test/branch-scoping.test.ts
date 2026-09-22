import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  branchHoliday,
  member,
  operator,
  role,
  roleAssignment,
  ticketPackage,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-248, 249, 250 — the park has two branches, and the code has to mean it.
 *
 * All three defects were ranked "nil reach" on the premise that one branch was
 * open, which stopped being true. Every case here drives a REAL route as a
 * branch manager of one branch aimed at the other, and then drives the same
 * route as an operator administrator, because a scoping fix that only refuses
 * is half a fix: the half that locks the estate's administrator out of their
 * own estate is the one that gets reverted in a hurry on a Saturday.
 *
 * The branches are built here rather than taken from the seed: what the seed
 * holds is being rewritten alongside this, and a scoping test that depends on
 * how many branches somebody seeded is a test that goes red for the wrong
 * reason.
 */

let ctx: TestContext;

/** Operator A — the park. Two branches, a manager at each. */
let operatorA: string;
let branchOne: string;
let branchTwo: string;
let adminCookie: string;
let mgrOne: { id: string; cookie: string };
let mgrTwo: { id: string; cookie: string };

/** Operator B — a different park entirely, with a catalogue of its own. */
let branchB: string;
let packageB: string;
let holidayB: string;
let memberB: string;

/** An account with one role at one scope, password set directly. */
async function makeManager(opts: {
  phone: string;
  password: string;
  operatorId: string;
  branchId: string;
}): Promise<string> {
  const [managerRole] = await ctx.db
    .select()
    .from(role)
    .where(eq(role.name, 'branch_manager'))
    .limit(1);
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId: opts.operatorId,
    phone: normalizePhone(opts.phone)!,
    passwordHash: await hash(opts.password),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: id,
    roleId: managerRole!.id,
    scopeType: 'branch',
    scopeId: opts.branchId,
  });
  return id;
}

/**
 * Sign in and put the session on the branch this person actually manages.
 *
 * The switch is deliberate and it is not decoration: `signIn` puts every
 * session on the operator's first active branch whatever the account's grants
 * say, so a manager of the second branch lands on the first one and is refused
 * everywhere until they move. That is its own defect, in `services/auth.ts`,
 * and it is not this slice's to fix — but a test that quietly relied on the
 * session already being right would hide it.
 */
async function signInAtBranch(
  phone: string,
  password: string,
  branchId: string,
): Promise<string> {
  const cookie = await signInAs(ctx.app, phone, password);
  const moved = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/branch',
    headers: { cookie },
    payload: { branchId },
  });
  expect(moved.statusCode).toBe(200);
  return cookie;
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const [opA] = await ctx.db.select().from(operator).limit(1);
  operatorA = opA!.id;
  const [seeded] = await ctx.db
    .select()
    .from(branch)
    .where(eq(branch.operatorId, operatorA))
    .limit(1);
  branchOne = seeded!.id;

  const second = await ctx.app.inject({
    method: 'POST',
    url: '/branches',
    headers: { cookie: adminCookie },
    payload: { name: 'Second Park', code: 'second-park', timezone: 'Asia/Bangkok' },
  });
  expect(second.statusCode).toBe(200);
  branchTwo = second.json().id as string;

  const oneId = await makeManager({
    phone: '+66900000301',
    password: 'mgrone1234',
    operatorId: operatorA,
    branchId: branchOne,
  });
  const twoId = await makeManager({
    phone: '+66900000302',
    password: 'mgrtwo1234',
    operatorId: operatorA,
    branchId: branchTwo,
  });
  mgrOne = { id: oneId, cookie: await signInAtBranch('+66900000301', 'mgrone1234', branchOne) };
  mgrTwo = { id: twoId, cookie: await signInAtBranch('+66900000302', 'mgrtwo1234', branchTwo) };

  // Operator B: another park, with the catalogue rows operator A's
  // administrator was able to rewrite.
  const [opB] = await ctx.db.insert(operator).values({ id: newId(), name: 'Other Park Co' }).returning();
  const [brB] = await ctx.db
    .insert(branch)
    .values({ id: newId(), operatorId: opB!.id, name: 'Other Park', code: 'other-park' })
    .returning();
  branchB = brB!.id;
  const [pkgB] = await ctx.db
    .insert(ticketPackage)
    .values({
      id: newId(),
      operatorId: opB!.id,
      branchId: branchB,
      name: 'Other Park 1 Hour',
      durationLabel: '1 Hour',
      hours: 1,
      prices: { tourist: { weekday: 50000, weekend: 60000 } },
    })
    .returning();
  packageB = pkgB!.id;
  const [holB] = await ctx.db
    .insert(branchHoliday)
    .values({
      id: newId(),
      branchId: branchB,
      name: 'Other Park Songkran',
      startsOn: '2027-04-13',
      endsOn: '2027-04-15',
    })
    .returning();
  holidayB = holB!.id;
  const [memB] = await ctx.db
    .insert(member)
    .values({ id: newId(), operatorId: opB!.id, phone: '+66811110000', nickname: 'OtherParkGuardian' })
    .returning();
  memberB = memB!.id;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('SCRUM-248 — a branch in the URL is loaded, not taken on trust', () => {
  it("refuses to rename another operator's ticket package, and leaves it alone", async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchB}/ticket-packages/${packageB}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Renamed By A' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Branch not found');

    const [row] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.id, packageB));
    expect(row!.name).toBe('Other Park 1 Hour');
  });

  it("refuses to archive another operator's ticket package", async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchB}/ticket-packages/${packageB}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);

    const [row] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.id, packageB));
    expect(row!.archivedAt).toBeNull();
    expect(row!.active).toBe(true);
  });

  it("refuses to delete another operator's holiday range", async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchB}/holidays/${holidayB}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);

    const rows = await ctx.db.select().from(branchHoliday).where(eq(branchHoliday.id, holidayB));
    expect(rows).toHaveLength(1);
  });

  it("files no audit row under one operator carrying another's branch id", async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.operatorId, operatorA), eq(auditLog.branchId, branchB)));
    expect(rows).toEqual([]);
  });

  it('still edits and archives a package at a branch the operator owns', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchTwo}/ticket-packages`,
      headers: { cookie: adminCookie },
      payload: {
        name: 'Second Park 1 Hour',
        durationLabel: '1 Hour',
        hours: 1,
        prices: { tourist: { weekday: 40000, weekend: 45000 } },
      },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchTwo}/ticket-packages/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Second Park 1 Hour (evening)' },
    });
    expect(renamed.statusCode).toBe(200);

    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchTwo}/ticket-packages/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(archived.statusCode).toBe(200);
  });

  it("lets each manager price their own branch and refuses them the other's", async () => {
    const own = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchTwo}/ticket-packages`,
      headers: { cookie: mgrTwo.cookie },
      payload: {
        name: 'Manager Two Package',
        durationLabel: '2 Hours',
        hours: 2,
        prices: { tourist: { weekday: 60000, weekend: 70000 } },
      },
    });
    expect(own.statusCode).toBe(200);

    const other = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchOne}/ticket-packages`,
      headers: { cookie: mgrTwo.cookie },
      payload: {
        name: 'Reaching Across',
        durationLabel: '2 Hours',
        hours: 2,
        prices: { tourist: { weekday: 60000, weekend: 70000 } },
      },
    });
    expect(other.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('SCRUM-249 — a list answers for the branches the caller holds', () => {
  it('GET /branches gives a manager their own branch and an administrator both', async () => {
    const mine = await ctx.app.inject({
      method: 'GET',
      url: '/branches',
      headers: { cookie: mgrTwo.cookie },
    });
    expect(mine.statusCode).toBe(200);
    const ids = (mine.json().branches as Array<{ id: string }>).map((b) => b.id);
    expect(ids).toEqual([branchTwo]);

    const all = await ctx.app.inject({
      method: 'GET',
      url: '/branches',
      headers: { cookie: adminCookie },
    });
    const allIds = (all.json().branches as Array<{ id: string }>).map((b) => b.id);
    expect(allIds).toContain(branchOne);
    expect(allIds).toContain(branchTwo);
  });

  it("GET /accounts hides the other branch's staff, and their phone numbers", async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: mgrTwo.cookie },
    });
    expect(res.statusCode).toBe(200);
    const accounts = res.json().accounts as Array<{ id: string; phone: string }>;
    const ids = accounts.map((a) => a.id);

    expect(ids).toContain(mgrTwo.id);
    expect(ids).not.toContain(mgrOne.id);
    // Not merely absent from the id list — absent from the payload entirely.
    expect(JSON.stringify(accounts)).not.toContain('66900000301');

    // An operator administrator is on every branch's list by the same rule the
    // station picker and the box's offline cache use (`atBranch`), so that a
    // manager can see who administers the estate above them. Asserted rather
    // than left to chance: it is a decision, and a reader should meet it here.
    const [admin] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);
    expect(ids).toContain(admin!.id);
  });

  it('GET /accounts still gives an operator administrator everybody', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().accounts as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(mgrOne.id);
    expect(ids).toContain(mgrTwo.id);
  });

  it("GET /accounts/:id/sessions refuses another branch's manager and answers for the administrator", async () => {
    const refused = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${mgrOne.id}/sessions`,
      headers: { cookie: mgrTwo.cookie },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
    expect(refused.body).not.toContain(branchOne);

    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${mgrOne.id}/sessions`,
      headers: { cookie: adminCookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json().sessions as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET /accounts/:id/sessions refuses an account whose roles the caller does not dominate', async () => {
    const [admin] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${admin!.id}/sessions`,
      headers: { cookie: mgrTwo.cookie },
    });
    // Visible on the list by `atBranch`, and still not somebody a branch
    // manager may take apart: dominance is the second of the two checks.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ROLE_NOT_DOMINATED');
  });

  it("GET /audit keeps each branch's trail to itself", async () => {
    // One real, audited act at each branch.
    for (const [branchId, cookie] of [
      [branchOne, mgrOne.cookie],
      [branchTwo, mgrTwo.cookie],
    ] as const) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/branches/${branchId}/holidays`,
        headers: { cookie },
        payload: { name: `Trail ${branchId}`, startsOn: '2027-01-01', endsOn: '2027-01-02' },
      });
      expect(res.statusCode).toBe(200);
    }

    const mine = await ctx.app.inject({
      method: 'GET',
      url: '/audit?action=branch_holiday.create&limit=200',
      headers: { cookie: mgrTwo.cookie },
    });
    expect(mine.statusCode).toBe(200);
    const branches = (mine.json().entries as Array<{ branchId: string }>).map((e) => e.branchId);
    expect(branches.length).toBeGreaterThan(0);
    expect(new Set(branches)).toEqual(new Set([branchTwo]));

    const all = await ctx.app.inject({
      method: 'GET',
      url: '/audit?action=branch_holiday.create&limit=200',
      headers: { cookie: adminCookie },
    });
    const allBranches = (all.json().entries as Array<{ branchId: string }>).map((e) => e.branchId);
    expect(allBranches).toContain(branchOne);
    expect(allBranches).toContain(branchTwo);
  });

  it("GET /audit refuses an explicit ask for another branch rather than answering it empty", async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/audit?branchId=${branchOne}`,
      headers: { cookie: mgrTwo.cookie },
    });
    expect(res.statusCode).toBe(403);

    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/audit?branchId=${branchOne}`,
      headers: { cookie: adminCookie },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('SCRUM-250 — a visit is written at the branch the body names', () => {
  it('refuses a manager opening a visit at the branch they do not hold', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie: mgrTwo.cookie },
      payload: { branchId: branchOne, visitDate: '2026-09-22' },
    });
    expect(res.statusCode).toBe(403);

    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'visit.create'));
    expect(rows.filter((r) => r.branchId === branchOne)).toEqual([]);
  });

  it('lets them open one at their own branch, and an administrator at either', async () => {
    const own = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie: mgrTwo.cookie },
      payload: { branchId: branchTwo, visitDate: '2026-09-22' },
    });
    expect(own.statusCode).toBe(200);

    const across = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie: adminCookie },
      payload: { branchId: branchOne, visitDate: '2026-09-22' },
    });
    expect(across.statusCode).toBe(200);
  });

  it("refuses a member belonging to another operator", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie: adminCookie },
      payload: { branchId: branchOne, memberId: memberB, visitDate: '2026-09-22' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Member not found');
  });

  it("refuses to read a visit at another manager's branch, and reads its own", async () => {
    const mine = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie: mgrOne.cookie },
      payload: { branchId: branchOne, visitDate: '2026-09-22' },
    });
    expect(mine.statusCode).toBe(200);
    const visitId = mine.json().id as string;

    const refused = await ctx.app.inject({
      method: 'GET',
      url: `/visits/${visitId}`,
      headers: { cookie: mgrTwo.cookie },
    });
    expect(refused.statusCode).toBe(403);

    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/visits/${visitId}`,
      headers: { cookie: mgrOne.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().visit.branchId).toBe(branchOne);
  });
});
