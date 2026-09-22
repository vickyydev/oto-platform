import { generateKeyPairSync } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  employee,
  role,
  roleAssignment,
  session as sessionTable,
  staffToken,
  station,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-263 and SCRUM-264 — the session, and the station it stands at.
 *
 * Both defects were found by driving two live branches, and both are about the
 * same value: the branch on the session. It is not a fact about the caller —
 * `PUT /me/session/branch` writes it — so sign-in seating a person by it was a
 * lockout, and the station picker filtering by it was a door.
 *
 * Every case here drives the real routes as reception at one park aimed at the
 * other, as a branch manager of each, and as the operator administrator, who
 * has to go on moving freely: a scoping fix that only refuses is half a fix.
 */

/**
 * This deployment can mint a shift token, and that is deliberate.
 *
 * The run behind SCRUM-264 could not prove whether the till it took came with
 * an offline credential: the api it drove had no signing key set, and minting
 * is skipped without one, so "no token was minted" would have been true there
 * whatever the fix did. Staging has a key. With one here, the refusal below
 * asserts something: the pick mints inside its own transaction, so a pick that
 * is refused leaves no credential the other park's box would verify offline.
 */
const keypair = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let centralId: string;
let chalongId: string;
/** `Reception Till 1` at each park — the seed gives both parks one. */
let centralTillId: string;
let chalongTillId: string;
let chalongTillAccessScope: string;

const call = async (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const res = await ctx.app.inject({
    method,
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { statusCode: res.statusCode, body: body as Record<string, unknown> };
};

const errorCode = (res: { statusCode: number; body: Record<string, unknown> }): string =>
  (res.body as { error?: { code?: string } }).error?.code ?? `(no error, ${res.statusCode})`;

const branchCodeOf = (me: Record<string, unknown>): string | null =>
  (me.branch as { code?: string } | null)?.code ?? null;

/** An active account with a password, an employee record and chosen grants. */
async function makeAccount(opts: {
  phone: string;
  password: string;
  operatorId: string;
  /** Where the person turns up for work. */
  employeeBranchId?: string;
  grants: Array<{ roleName: string; branchId: string }>;
}): Promise<string> {
  const e164 = normalizePhone(opts.phone)!;
  let employeeId: string | null = null;
  if (opts.employeeBranchId) {
    employeeId = newId();
    await ctx.db.insert(employee).values({
      id: employeeId,
      operatorId: opts.operatorId,
      name: `Staff ${e164.slice(-4)}`,
      branchId: opts.employeeBranchId,
      phone: e164,
    });
  }
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId: opts.operatorId,
    employeeId,
    phone: e164,
    passwordHash: await hash(opts.password),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  for (const g of opts.grants) {
    const [r] = await ctx.db.select().from(role).where(eq(role.name, g.roleName)).limit(1);
    await ctx.db.insert(roleAssignment).values({
      id: newId(),
      accountId: id,
      roleId: r!.id,
      scopeType: 'branch',
      scopeId: g.branchId,
    });
  }
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: PRIVATE_KEY } });
  const branches = await ctx.db.select().from(branch);
  centralId = branches.find((b) => b.code === CENTRAL_BRANCH_CODE)!.id;
  chalongId = branches.find((b) => b.code === CHALONG_BRANCH_CODE)!.id;

  const tills = await ctx.db
    .select()
    .from(station)
    .where(eq(station.name, 'Reception Till 1'));
  centralTillId = tills.find((s) => s.branchId === centralId)!.id;
  const chalongTill = tills.find((s) => s.branchId === chalongId)!;
  chalongTillId = chalongTill.id;
  chalongTillAccessScope = chalongTill.accessScope;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('SCRUM-263 — sign-in seats a person where they hold something', () => {
  it("seats Robinson Chalong's manager at Robinson Chalong, not at the first branch", async () => {
    const cookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const me = await call('GET', '/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(branchCodeOf(me.body)).toBe(CHALONG_BRANCH_CODE);
  });

  it('and the routes that fall back to the session branch answer her at once', async () => {
    const cookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    // SCRUM-263 found seven of these at 403 before the seat was computed from
    // grants. She switched nothing here: this is the session sign-in gave her.
    for (const url of ['/branches', '/sales', '/accounts', '/audit', '/me/stations']) {
      const res = await call('GET', url, { cookie });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }
    const branches = await call('GET', '/branches', { cookie });
    expect((branches.body.branches as Array<{ code: string }>).map((b) => b.code)).toEqual([
      CHALONG_BRANCH_CODE,
    ]);
    const stations = await call('GET', '/me/stations', { cookie });
    expect((stations.body.stations as Array<{ id: string }>).map((s) => s.id)).toEqual([
      chalongTillId,
    ]);
  });

  it("seats Central Floresta's manager and its reception at Central Floresta", async () => {
    for (const who of [BRANCH_MANAGER, RECEPTION]) {
      const cookie = await signInAs(ctx.app, who.phone, who.password);
      const me = await call('GET', '/me', { cookie });
      expect(branchCodeOf(me.body)).toBe(CENTRAL_BRANCH_CODE);
    }
  });

  it("seats the operator administrator at the operator's first branch, as before", async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const me = await call('GET', '/me', { cookie });
    expect(branchCodeOf(me.body)).toBe(CENTRAL_BRANCH_CODE);
  });

  it('prefers the branch a person works at when their grants cover both', async () => {
    await makeAccount({
      phone: '+66900000401',
      password: 'bothparks1234',
      operatorId: (await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1))[0]!
        .operatorId,
      employeeBranchId: chalongId,
      grants: [
        { roleName: 'reception', branchId: centralId },
        { roleName: 'reception', branchId: chalongId },
      ],
    });
    const cookie = await signInAs(ctx.app, '+66900000401', 'bothparks1234');
    const me = await call('GET', '/me', { cookie });
    // Central is the operator's first branch and is in reach; the employee
    // record is what decides between them.
    expect(branchCodeOf(me.body)).toBe(CHALONG_BRANCH_CODE);
  });

  it('falls back to a branch in reach when the employee record points somewhere they hold nothing', async () => {
    const [central] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
    await makeAccount({
      phone: '+66900000402',
      password: 'movedpark1234',
      operatorId: central!.operatorId,
      employeeBranchId: centralId,
      grants: [{ roleName: 'reception', branchId: chalongId }],
    });
    const cookie = await signInAs(ctx.app, '+66900000402', 'movedpark1234');
    const me = await call('GET', '/me', { cookie });
    expect(branchCodeOf(me.body)).toBe(CHALONG_BRANCH_CODE);
  });

  it('refuses an account that holds nothing anywhere, with the reason and no session', async () => {
    const [central] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
    const id = await makeAccount({
      phone: '+66900000403',
      password: 'noroles1234',
      operatorId: central!.operatorId,
      employeeBranchId: chalongId,
      grants: [],
    });

    const res = await call('POST', '/auth/sign-in', {
      payload: { phone: '+66900000403', password: 'noroles1234' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('NO_BRANCH_ACCESS');

    // Not seated at a branch they cannot use: not seated at all.
    const sessions = await ctx.db.select().from(sessionTable).where(eq(sessionTable.accountId, id));
    expect(sessions).toEqual([]);

    const refusals = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorAccountId, id), eq(auditLog.action, 'auth.sign_in_failed')));
    expect(refusals).toHaveLength(1);
    expect((refusals[0]!.after as { reason?: string }).reason).toBe('no_branch_access');
  });
});

// ---------------------------------------------------------------------------

describe('SCRUM-264 — the chain that took the other park’s till', () => {
  it('refuses reception a session branch they hold nothing at, and leaves the session where it was', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const moved = await call('PUT', '/me/session/branch', {
      cookie,
      payload: { branchId: chalongId },
    });
    expect(moved.statusCode).toBe(403);
    expect(errorCode(moved)).toBe('OUT_OF_BRANCH_SCOPE');

    const me = await call('GET', '/me', { cookie });
    expect(branchCodeOf(me.body)).toBe(CENTRAL_BRANCH_CODE);
  });

  it("refuses a branch manager the other park's branch too", async () => {
    const cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    const moved = await call('PUT', '/me/session/branch', {
      cookie,
      payload: { branchId: chalongId },
    });
    expect(moved.statusCode).toBe(403);
  });

  it('lets the operator administrator move to either park and back', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    expect((await call('PUT', '/me/session/branch', { cookie, payload: { branchId: chalongId } })).statusCode).toBe(200);
    expect(branchCodeOf((await call('GET', '/me', { cookie })).body)).toBe(CHALONG_BRANCH_CODE);
    expect((await call('PUT', '/me/session/branch', { cookie, payload: { branchId: centralId } })).statusCode).toBe(200);
    expect(branchCodeOf((await call('GET', '/me', { cookie })).body)).toBe(CENTRAL_BRANCH_CODE);
  });

  it("refuses reception the other park's till by id, though its access scope admits all staff", async () => {
    // The scope is SCRUM-264's point: `all_staff` means all staff OF THAT
    // BRANCH, so the refusal has to come from the grant and not from the list.
    expect(chalongTillAccessScope).toBe('all_staff');

    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const picked = await call('PUT', '/me/session/station', {
      cookie,
      payload: { stationId: chalongTillId },
    });
    expect(picked.statusCode).toBe(403);
    expect(errorCode(picked)).toBe('STATION_OTHER_BRANCH');

    const [som] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, RECEPTION.phone))
      .limit(1);
    // Nothing on the session, and — the half SCRUM-264 could not test — no
    // credential for a till at the other park.
    const [session] = await ctx.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.accountId, som!.id))
      .limit(1);
    expect(session!.stationId).not.toBe(chalongTillId);
    const minted = await ctx.db
      .select()
      .from(staffToken)
      .where(and(eq(staffToken.accountId, som!.id), eq(staffToken.stationId, chalongTillId)));
    expect(minted).toEqual([]);

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'session.station_pick'), eq(auditLog.entityId, chalongTillId)));
    expect(rows.filter((r) => r.actorAccountId === som!.id)).toEqual([]);
  });

  it('refuses the lease on a station it could not take', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const lease = await call('POST', `/stations/${chalongTillId}/lease`, {
      cookie,
      payload: { holder: 'tab-1', takeover: false },
    });
    expect(lease.statusCode).toBe(403);
  });

  it('answers an empty picker for a session seated at a branch the caller does not hold', async () => {
    // Exactly the state every live session is in on the day this ships: the
    // branch was written by the old sign-in, and nothing re-checked it.
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const [som] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, RECEPTION.phone))
      .limit(1);
    await ctx.db
      .update(sessionTable)
      .set({ branchId: chalongId })
      .where(eq(sessionTable.accountId, som!.id));

    const stations = await call('GET', '/me/stations', { cookie });
    expect(stations.statusCode).toBe(200);
    expect(stations.body.stations).toEqual([]);

    const picked = await call('PUT', '/me/session/station', {
      cookie,
      payload: { stationId: chalongTillId },
    });
    expect(picked.statusCode).toBe(403);
    expect(errorCode(picked)).toBe('STATION_OTHER_BRANCH');

    await ctx.db
      .update(sessionTable)
      .set({ branchId: centralId })
      .where(eq(sessionTable.accountId, som!.id));
  });

  it('still lets each park take its own till: reception at Central, the manager at Chalong', async () => {
    const som = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const mine = await call('PUT', '/me/session/station', {
      cookie: som,
      payload: { stationId: centralTillId },
    });
    expect(mine.statusCode).toBe(200);

    const dao = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const hers = await call('PUT', '/me/session/station', {
      cookie: dao,
      payload: { stationId: chalongTillId },
    });
    expect(hers.statusCode).toBe(200);
    expect((hers.body.station as { branchId: string }).branchId).toBe(chalongId);
    // The token IS minted for the person who holds the branch — which is what
    // makes its absence above a finding rather than a deployment without a key.
    expect((hers.body.staffToken as { token?: string } | null)?.token).toBeTruthy();
    // And the document behind it opens for the person standing there.
    expect((await call('GET', `/stations/${chalongTillId}/session`, { cookie: dao })).statusCode).toBe(200);
  });

  it('lets the operator administrator switch branch and work a station at either park', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    expect((await call('PUT', '/me/session/branch', { cookie, payload: { branchId: chalongId } })).statusCode).toBe(200);
    const stations = await call('GET', '/me/stations', { cookie });
    expect((stations.body.stations as Array<{ id: string }>).map((s) => s.id)).toContain(chalongTillId);
    expect(
      (await call('PUT', '/me/session/station', { cookie, payload: { stationId: chalongTillId } }))
        .statusCode,
    ).toBe(200);
  });

  it('takes the station away from a holder whose grant is withdrawn mid-shift', async () => {
    const [central] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
    const id = await makeAccount({
      phone: '+66900000404',
      password: 'chalongdesk1234',
      operatorId: central!.operatorId,
      employeeBranchId: chalongId,
      grants: [{ roleName: 'reception', branchId: chalongId }],
    });
    const cookie = await signInAs(ctx.app, '+66900000404', 'chalongdesk1234');
    expect(
      (await call('PUT', '/me/session/station', { cookie, payload: { stationId: chalongTillId } }))
        .statusCode,
    ).toBe(200);
    expect((await call('GET', `/stations/${chalongTillId}/session`, { cookie })).statusCode).toBe(200);

    // Moved to the other park: the assignment goes, the session does not.
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, id));

    const after = await call('GET', `/stations/${chalongTillId}/session`, { cookie });
    expect(after.statusCode).toBe(403);
    expect(errorCode(after)).toBe('STATION_OTHER_BRANCH');
  });
});
