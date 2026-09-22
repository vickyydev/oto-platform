import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  account,
  alert,
  auditLog,
  branch,
  child,
  employee,
  opsRun,
  operator,
  role,
  roleAssignment,
  session as sessionTable,
  staffToken,
  station,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  CENTRAL_BRANCH_CODE,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-280 … 284 — the leaks, and the trail.
 *
 * Five findings of the architecture conformance register, all of one shape:
 * a row reached by its id, with nothing in the predicate saying whose it is,
 * and a record of the act written where a rollback could not reach it.
 *
 * Every case here drives a REAL route — as the manager of the wrong park, as
 * the administrator of the wrong operator — and then reads the database back,
 * because a refusal that leaves the row changed is not a refusal. Each is
 * paired with the positive path, for the reason `branch-scoping.test.ts`
 * gives: a scoping fix that only refuses is the half that gets reverted in a
 * hurry on a Saturday.
 *
 * The two operators are built here rather than seeded. Operator B needs a
 * branch, an administrator and rows of its own, and nothing else — the leaks
 * are in predicates, so a foreign row is all it takes to show one.
 */

const keypair = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;

/** Operator A — the park, as the seed builds it: two branches, a manager at each. */
let operatorA: string;
let centralBranch: string;
let chalongBranch: string;
let chalongTill: string;
let chalongBox: string;
let adminCookie: string;
let adminAccountId: string;
let centralManager: { id: string; cookie: string };
let chalongManager: { id: string; cookie: string };

/** Operator B — a different park, with an administrator of its own. */
let operatorB: string;
let adminBCookie: string;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    payload: opts.payload as never,
  });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

const accountIdFor = async (phone: string): Promise<string> => {
  const [row] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone));
  return row!.id;
};

const branchIdFor = async (code: string): Promise<string> => {
  const [row] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.code, code));
  return row!.id;
};

const auditRows = (action: string, entityId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

const countAudit = async (action: string): Promise<number> =>
  (await ctx.db.select().from(auditLog).where(eq(auditLog.action, action))).length;

/**
 * Take a station, which is where a shift token is minted. The session is put
 * on the station's own branch first: `signIn` seats it from grants, and a
 * manager of one park must not be moved to the other to make a case pass.
 */
async function pickStation(cookie: string, stationId: string): Promise<{ jti: string }> {
  const res = await call('PUT', '/me/session/station', { cookie, payload: { stationId } });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const token = res.body.staffToken as { jti: string } | null;
  expect(token, 'this deployment has a staff-token key, so a pick mints one').toBeTruthy();
  return token!;
}

beforeAll(async () => {
  ctx = await createTestContext({
    // A key, so a station pick mints a real shift token; the jobs role, so the
    // retry route has something to run rather than answering 409.
    env: { STAFF_TOKEN_PRIVATE_KEY: PRIVATE_KEY, PROCESS_ROLES: 'api,jobs' },
  });
  await ctx.db.execute(sql`
    create or replace function oto_test_fail() returns trigger as $fn$
    begin
      raise exception 'forced failure';
    end
    $fn$ language plpgsql;
  `);

  const [opA] = await ctx.db.select().from(operator).limit(1);
  operatorA = opA!.id;
  centralBranch = await branchIdFor(CENTRAL_BRANCH_CODE);
  chalongBranch = await branchIdFor(CHALONG_BRANCH_CODE);

  const [till] = await ctx.db
    .select({ id: station.id, boxId: station.boxId })
    .from(station)
    .where(and(eq(station.branchId, chalongBranch), eq(station.kind, 'till')))
    .limit(1);
  chalongTill = till!.id;
  chalongBox = till!.boxId!;

  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  adminAccountId = await accountIdFor(ADMIN.phone);
  centralManager = {
    id: await accountIdFor(BRANCH_MANAGER.phone),
    cookie: await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password),
  };
  chalongManager = {
    id: await accountIdFor(CHALONG_MANAGER.phone),
    cookie: await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password),
  };

  // Operator B: one branch, one administrator, nothing else.
  const [opB] = await ctx.db.insert(operator).values({ id: newId(), name: 'Other Park Co' }).returning();
  operatorB = opB!.id;
  await ctx.db
    .insert(branch)
    .values({ id: newId(), operatorId: operatorB, name: 'Other Park', code: 'other-park' });
  const [operatorAdmin] = await ctx.db
    .select()
    .from(role)
    .where(eq(role.name, 'operator_admin'))
    .limit(1);
  const adminBId = newId();
  await ctx.db.insert(account).values({
    id: adminBId,
    operatorId: operatorB,
    phone: '+66900000801',
    passwordHash: await argonHash('otherpark1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: adminBId,
    roleId: operatorAdmin!.id,
    scopeType: 'operator',
    scopeId: operatorB,
  });
  adminBCookie = await signInAs(ctx.app, '+66900000801', 'otherpark1234');
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('SCRUM-280 — a shift token is listed and ended where it was minted', () => {
  let chalongJti: string;

  beforeAll(async () => {
    chalongJti = (await pickStation(chalongManager.cookie, chalongTill)).jti;
  });

  it('refuses the other park’s manager the list, and leaves the shift running', async () => {
    const res = await call('GET', `/accounts/${chalongManager.id}/staff-tokens`, {
      cookie: centralManager.cookie,
    });
    // Inside the operator, so the account's existence is not the secret — the
    // roles it holds are outside what this manager holds, and that is said.
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(chalongJti);

    const [row] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, chalongJti));
    expect(row!.revokedAt).toBeNull();
  });

  it('refuses the other park’s manager the revoke, and the token stays live', async () => {
    const res = await call('DELETE', `/staff-tokens/${chalongJti}`, {
      cookie: centralManager.cookie,
    });
    expect(res.statusCode).toBe(403);

    const [row] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, chalongJti));
    expect(row!.revokedAt, 'a refused revoke must not have revoked anything').toBeNull();
    expect(row!.revokedByAccountId).toBeNull();
  });

  it('does not confirm the token to another operator’s administrator at all', async () => {
    const listed = await call('GET', `/accounts/${chalongManager.id}/staff-tokens`, {
      cookie: adminBCookie,
    });
    expect(listed.statusCode).toBe(404);

    const ended = await call('DELETE', `/staff-tokens/${chalongJti}`, { cookie: adminBCookie });
    expect(ended.statusCode).toBe(404);

    const [row] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, chalongJti));
    expect(row!.revokedAt).toBeNull();
  });

  it('hides a token at another branch even when there is no role to dominate', async () => {
    /**
     * The case dominance cannot answer: a new hire with an account and no
     * roles yet. `assertDominatesAccount` walks an empty list and returns, so
     * what holds here is the branch reach on the tokens themselves — the third
     * check, and the one the register said was missing.
     */
    const hireId = newId();
    await ctx.db.insert(account).values({
      id: hireId,
      operatorId: operatorA,
      phone: '+66900000802',
      passwordHash: await argonHash('newhire1234'),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    const sessionId = newId();
    await ctx.db.insert(sessionTable).values({
      id: sessionId,
      accountId: hireId,
      tokenHash: randomUUID(),
      branchId: chalongBranch,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const jti = newId();
    await ctx.db.insert(staffToken).values({
      jti,
      operatorId: operatorA,
      branchId: chalongBranch,
      accountId: hireId,
      sessionId,
      stationId: chalongTill,
      boxId: chalongBox,
      kid: 'test-kid',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await call('GET', `/accounts/${hireId}/staff-tokens`, {
      cookie: centralManager.cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.tokens, 'the hire is at the other park, so there is nothing to show').toEqual([]);
  });

  it('still lists a manager their own shift, and the estate’s administrator everybody’s', async () => {
    const own = await pickStation(centralManager.cookie, await centralTill());
    const mine = await call('GET', `/accounts/${centralManager.id}/staff-tokens`, {
      cookie: centralManager.cookie,
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.body.tokens as Array<{ jti: string }>).map((t) => t.jti)).toContain(own.jti);

    const all = await call('GET', `/accounts/${chalongManager.id}/staff-tokens`, {
      cookie: adminCookie,
    });
    expect(all.statusCode).toBe(200);
    expect((all.body.tokens as Array<{ jti: string }>).map((t) => t.jti)).toContain(chalongJti);
  });

  it('ends the shift for the administrator who reaches that park, and records it', async () => {
    const res = await call('DELETE', `/staff-tokens/${chalongJti}`, { cookie: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.body.revoked).toBe(1);

    const [row] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, chalongJti));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedReason).toBe('admin');
    expect(row!.revokedByAccountId).toBe(adminAccountId);

    // SCRUM-282 — minting was always audited; ending somebody's shift was not.
    const [audited] = await auditRows('staff_token.revoke', chalongJti);
    expect(audited, 'an administrator ending a shift leaves a row').toBeTruthy();
    expect(audited!.branchId, 'filed at the park the token belonged to').toBe(chalongBranch);
    expect(audited!.actorAccountId).toBe(adminAccountId);
  });
});

async function centralTill(): Promise<string> {
  const [row] = await ctx.db
    .select({ id: station.id })
    .from(station)
    .where(
      and(
        eq(station.branchId, centralBranch),
        eq(station.kind, 'till'),
        eq(station.name, 'Reception Till 1'),
      ),
    )
    .limit(1);
  return row!.id;
}

// ---------------------------------------------------------------------------

describe('SCRUM-281 — an alert is taken, and a run read, inside one operator', () => {
  const openAlert = async (operatorId: string | null, key: string): Promise<string> => {
    const id = newId();
    await ctx.db.insert(alert).values({
      id,
      key,
      category: 'ops.missing',
      severity: 'warning',
      subject: key,
      summary: `${key} has not succeeded for an hour`,
      operatorId,
    });
    return id;
  };

  const failedRun = async (operatorId: string | null): Promise<string> => {
    const id = newId();
    await ctx.db.insert(opsRun).values({
      id,
      kind: 'job',
      name: 'job:housekeeping.handoff',
      outcome: 'failed',
      errorCode: 'TEST',
      errorMessage: 'the sweep fell over',
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 5,
      operatorId,
    });
    return id;
  };

  it('does not let one operator’s administrator take another’s alert', async () => {
    const id = await openAlert(operatorB, 'ops.missing:job:other-park');
    const res = await call('POST', `/ops/alerts/${id}/acknowledge`, { cookie: adminCookie });
    expect(res.statusCode).toBe(404);

    const [row] = await ctx.db.select().from(alert).where(eq(alert.id, id));
    expect(row!.status, 'a refused acknowledge must not have acknowledged anything').toBe('open');
    expect(row!.acknowledgedAt).toBeNull();
    expect(row!.acknowledgedByAccountId).toBeNull();
    expect(await auditRows('ops.alert_acknowledge', id)).toEqual([]);
  });

  it('does not let one operator’s administrator read another’s run', async () => {
    const id = await failedRun(operatorB);
    const res = await call('POST', `/ops/runs/${id}/retry`, { cookie: adminCookie });
    expect(res.statusCode).toBe(404);
    expect(await auditRows('ops.run_retry', id)).toEqual([]);
  });

  it('takes its own operator’s alert, and files the row under that operator', async () => {
    const id = await openAlert(operatorA, 'ops.missing:job:own-park');
    const res = await call('POST', `/ops/alerts/${id}/acknowledge`, { cookie: adminCookie });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db.select().from(alert).where(eq(alert.id, id));
    expect(row!.status).toBe('acknowledged');
    expect(row!.acknowledgedByAccountId).toBe(adminAccountId);

    const [audited] = await auditRows('ops.alert_acknowledge', id);
    expect(audited!.operatorId).toBe(operatorA);
  });

  it('runs its own operator’s sweep again, and audits who asked', async () => {
    const id = await failedRun(operatorA);
    const res = await call('POST', `/ops/runs/${id}/retry`, { cookie: adminCookie });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((await auditRows('ops.run_retry', id)).length).toBe(1);
  });

  it('still refuses a caller who holds no ops permission at all', async () => {
    const id = await openAlert(operatorA, 'ops.missing:job:refusal');
    // `branch_manager` carries `admin:health:read` and deliberately not
    // `admin:ops:manage`: reading the register is a manager's screen, acting
    // on the estate's alerts is not.
    const res = await call('POST', `/ops/alerts/${id}/acknowledge`, {
      cookie: centralManager.cookie,
    });
    expect(res.statusCode).toBe(403);
    const [row] = await ctx.db.select().from(alert).where(eq(alert.id, id));
    expect(row!.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------

/**
 * SCRUM-283 / SCRUM-284 — what survives a rollback.
 *
 * Two shapes of forced failure, and the difference between them is the whole
 * point. `whileFailing` raises ON the audit insert, which is enough to show a
 * write that was never in a transaction — the row lands, the operation does
 * not. `whileFailingAtCommit` raises at COMMIT, after everything the handler
 * wrote, which is the only way to catch an audit row written on the POOL from
 * inside a transaction: with the bug it is already committed and cannot be
 * taken back, and that is the phantom the register describes.
 */
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

async function whileFailingAtCommit(childName: string, fn: () => Promise<void>): Promise<void> {
  await ctx.db.execute(
    sql.raw(
      `create constraint trigger oto_test_commit_fail_trg after insert on crm.child
       deferrable initially deferred
       for each row when (new.name = '${childName}') execute function oto_test_fail();`,
    ),
  );
  try {
    await fn();
  } finally {
    await ctx.db.execute(sql`drop trigger oto_test_commit_fail_trg on crm.child;`);
  }
}

describe('SCRUM-283 — a child that rolls back takes its audit row with it', () => {
  it('writes no child.create row for a child that never existed', async () => {
    const created = await call('POST', '/members', {
      cookie: adminCookie,
      payload: { phone: '+66900000901', nickname: 'Phantom Guardian' },
    });
    expect(created.statusCode).toBe(200);
    const memberId = (created.body.member as { id: string }).id;

    const before = await countAudit('child.create');
    await whileFailingAtCommit('Phantom Child', async () => {
      const res = await call('POST', `/members/${memberId}/children`, {
        cookie: adminCookie,
        payload: { name: 'Phantom Child', allergies: 'peanuts' },
      });
      expect(res.statusCode).toBe(500);
    });

    const children = await ctx.db.select().from(child).where(eq(child.memberId, memberId));
    expect(children, 'the transaction rolled back, so there is no child').toEqual([]);
    expect(
      await countAudit('child.create'),
      'and no row in the trail describing one — this is the phantom SCRUM-283 names',
    ).toBe(before);
    // That it was attempted still survives: written after the rollback, on the
    // pool, which is where a failure row belongs.
    expect(await countAudit('child.create.failed')).toBeGreaterThan(0);
  });

  it('still commits the child and its audit row together on the happy path', async () => {
    const created = await call('POST', '/members', {
      cookie: adminCookie,
      payload: { phone: '+66900000902', nickname: 'Real Guardian' },
    });
    const memberId = (created.body.member as { id: string }).id;
    const res = await call('POST', `/members/${memberId}/children`, {
      cookie: adminCookie,
      payload: { name: 'Real Child', allergies: 'none' },
    });
    expect(res.statusCode).toBe(200);
    const childId = (res.body.child as { id: string }).id;

    expect(await ctx.db.select().from(child).where(eq(child.id, childId))).toHaveLength(1);
    expect(await auditRows('child.create', childId)).toHaveLength(1);
  });
});

describe('SCRUM-284 — sign-in, sign-out, lock and profile are one write each', () => {
  it('a sign-in that cannot be recorded seats nobody', async () => {
    const accountId = await accountIdFor(BRANCH_MANAGER.phone);
    const before = await ctx.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.accountId, accountId));

    await whileFailing('auth.sign_in', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/sign-in',
        payload: { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password },
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['set-cookie'], 'no cookie for a session that does not exist').toBeUndefined();
    });

    const after = await ctx.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.accountId, accountId));
    expect(after.length, 'the session row rolled back with its audit row').toBe(before.length);
    expect(await countAudit('auth.sign_in.failed')).toBeGreaterThan(0);
  });

  it('a sign-out that cannot be recorded leaves the session working', async () => {
    const cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    const jti = (await pickStation(cookie, await centralTill())).jti;

    await whileFailing('auth.sign_out', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } });
      expect(res.statusCode).toBe(500);
    });

    // The session, and the shift credential minted from it, are still exactly
    // as they were: a half-signed-out session is the state that locks somebody
    // out of a till mid-shift.
    const me = await call('GET', '/me', { cookie });
    expect(me.statusCode).toBe(200);
    const [token] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, jti));
    expect(token!.revokedAt).toBeNull();
  });

  it('a lock that cannot be recorded does not lock the till', async () => {
    const cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    await whileFailing('session.lock', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie } });
      expect(res.statusCode).toBe(500);
    });
    const me = await call('GET', '/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.body.sessionLocked, 'the lock rolled back, so the till is still open').toBe(false);
  });

  it('locks and unlocks for real, and each leaves its row', async () => {
    const cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    expect((await call('POST', '/auth/lock', { cookie })).statusCode).toBe(200);
    expect((await call('GET', '/me', { cookie })).body.sessionLocked).toBe(true);

    const unlocked = await call('POST', '/auth/unlock', {
      cookie,
      payload: { password: BRANCH_MANAGER.password },
    });
    expect(unlocked.statusCode).toBe(200);
    expect((await call('GET', '/me', { cookie })).body.sessionLocked).toBe(false);
    expect(await countAudit('session.lock')).toBeGreaterThan(0);
    expect(await countAudit('session.unlock')).toBeGreaterThan(0);
  });

  it('a profile edit that cannot be recorded is not applied', async () => {
    const [acc] = await ctx.db
      .select({ employeeId: account.employeeId })
      .from(account)
      .where(eq(account.id, adminAccountId));
    const [was] = await ctx.db.select().from(employee).where(eq(employee.id, acc!.employeeId!));

    await whileFailing('me.update', async () => {
      const res = await call('PATCH', '/me', {
        cookie: adminCookie,
        payload: { nickname: 'Unrecorded' },
      });
      expect(res.statusCode).toBe(500);
    });

    const [now] = await ctx.db.select().from(employee).where(eq(employee.id, acc!.employeeId!));
    expect(now!.nickname).toBe(was!.nickname);
  });
});

describe('SCRUM-282 — moving a session between parks leaves a row', () => {
  it('records the switch, with where it came from and where it went', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const seated = (await call('GET', '/me', { cookie })).body.branch as { id: string };

    const res = await call('PUT', '/me/session/branch', {
      cookie,
      payload: { branchId: chalongBranch },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'session.branch_switch'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row, 'SCRUM-264 made this a security boundary; this is the record it was crossed').toBeTruthy();
    expect((row!.after as { branchId: string }).branchId).toBe(chalongBranch);
    expect((row!.before as { branchId: string | null }).branchId).toBe(seated.id);
    expect(row!.actorAccountId).toBe(adminAccountId);
  });

  it('a switch that cannot be recorded does not move the session', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    await whileFailing('session.branch_switch', async () => {
      const res = await call('PUT', '/me/session/branch', {
        cookie,
        payload: { branchId: chalongBranch },
      });
      expect(res.statusCode).toBe(500);
    });
    const me = await call('GET', '/me', { cookie });
    expect((me.body.branch as { id: string }).id).toBe(centralBranch);
  });

  it('still refuses a branch the caller holds nothing at', async () => {
    const res = await call('PUT', '/me/session/branch', {
      cookie: centralManager.cookie,
      payload: { branchId: chalongBranch },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'OUT_OF_BRANCH_SCOPE' } });
  });
});
