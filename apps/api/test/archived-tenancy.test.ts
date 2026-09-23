import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { account, auditLog, operator } from '@oto/db';
import {
  ADMIN,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { _resetThrottle } from '../src/services/auth';

/**
 * SCRUM-253 — ARCHIVING HAS TO STOP SOMETHING.
 *
 * `archived_at` on an operator and on a branch was written by the person who
 * retired them and then read by pickers and by nothing else. Sign-in went on
 * working for an archived operator; a session seated at an archived branch
 * went on trading for as long as its cookie lasted; and a fresh role
 * assignment naming the archived branch was accepted, so access could be
 * handed out at a park that had been closed.
 *
 * Deactivating an ACCOUNT was already enforced properly — `loadAuth` refuses
 * the next request — so this is that same rule applied one and two levels up,
 * and the cases below are written to say so: the seated session dies at its
 * next call, exactly as a deactivated colleague's does.
 *
 * Driven through the real routes on the two-operator fixture, because both
 * halves have to hold at once: what is archived stops, and what is not
 * archived carries on trading. A change that only refused would be the half
 * that gets reverted on a Saturday.
 */

let ctx: TestContext;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
): Promise<{ statusCode: number; body: Record<string, unknown>; raw: string }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  return {
    statusCode: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
    raw: res.body,
  };
}

const signInAttempt = (phone: string, password: string) =>
  call('POST', '/auth/sign-in', { payload: { phone, password } });

const accountIdFor = async (phone: string): Promise<string> => {
  const [row] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone));
  return row!.id;
};

/** The newest refusal recorded against this phone's account. */
const lastSignInFailure = async (accountId: string) => {
  const [row] = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'auth.sign_in_failed'), eq(auditLog.entityId, accountId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
};

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('an archived operator stops trading (SCRUM-253)', () => {
  let operatorB: string;
  let adminBId: string;
  let adminBCookie: string;
  let platformCookie: string;

  it('signs the second operator’s administrator in while the operator is live', async () => {
    operatorB = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    adminBId = await accountIdFor(SECOND_OPERATOR_ADMIN.phone);
    platformCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    adminBCookie = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const me = await call('GET', '/me', { cookie: adminBCookie });
    expect(me.statusCode).toBe(200);
  });

  it('archives it through the platform route', async () => {
    const archived = await call('PATCH', `/operators/${operatorB}`, {
      cookie: platformCookie,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(operator).where(eq(operator.id, operatorB)).limit(1);
    expect(row!.archivedAt).not.toBeNull();
  });

  it('refuses its administrator’s sign-in with the wrong-password answer, byte for byte', async () => {
    await _resetThrottle(ctx.db);
    const refused = await signInAttempt(
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    expect(refused.statusCode).toBe(401);

    /**
     * SCRUM-251's rule, which this refusal had to be written into rather than
     * beside: every phone that does not get in is answered identically, so
     * that the sign-in screen cannot be used to sort a list of numbers. "This
     * number belongs to a park that has been closed" is precisely the kind of
     * sentence that rule exists to stop, so the comparison is against the
     * other two refusals and it is on the raw bytes.
     */
    const wrongPassword = await signInAttempt(RECEPTION.phone, 'not-the-password');
    const noSuchAccount = await signInAttempt('+66900000404', 'anything-at-all');
    expect(refused.statusCode).toBe(wrongPassword.statusCode);
    expect(refused.raw).toBe(wrongPassword.raw);
    expect(refused.raw).toBe(noSuchAccount.raw);
    await _resetThrottle(ctx.db);
  });

  it('writes the reason where only we can read it', async () => {
    // The answer says nothing; the trail says everything. This is what a
    // manager's "it just says wrong password" is diagnosed from.
    const row = await lastSignInFailure(adminBId);
    expect(row).not.toBeNull();
    expect((row!.after as { reason?: string }).reason).toBe('operator_archived');
    expect(row!.operatorId).toBe(operatorB);
  });

  it('kills the session that was already open, at its very next request', async () => {
    // The same treatment a deactivated account gets, one level up.
    const me = await call('GET', '/me', { cookie: adminBCookie });
    expect(me.statusCode).toBe(401);
    expect((me.body.error as { code?: string }).code).toBe('UNAUTHORIZED');
  });

  it('leaves the other operator signing in and trading', async () => {
    const stillIn = await signInAttempt(ADMIN.phone, ADMIN.password);
    expect(stillIn.statusCode).toBe(200);
    const branches = await call('GET', '/branches', { cookie: platformCookie });
    expect(branches.statusCode).toBe(200);
    expect((branches.body.branches as unknown[]).length).toBeGreaterThan(0);
  });

  it('lets its administrator back in once the operator is brought back', async () => {
    // Archiving is reversible, so the refusal has to be too — otherwise the
    // first mistaken archive is permanent and nobody dares press it.
    const back = await call('PATCH', `/operators/${operatorB}`, {
      cookie: platformCookie,
      payload: { archived: false },
    });
    expect(back.statusCode).toBe(200);
    await _resetThrottle(ctx.db);
    const again = await signInAttempt(
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    expect(again.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('an archived branch stops trading (SCRUM-253)', () => {
  let centralId: string;
  let chalongId: string;
  let adminCookie: string;
  let chalongCookie: string;
  let receptionAccountId: string;

  it('has both parks open, with a manager seated at each', async () => {
    centralId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
    chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
    receptionAccountId = await accountIdFor(RECEPTION.phone);
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    chalongCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);

    const seated = await call('GET', '/me', { cookie: chalongCookie });
    expect(seated.statusCode).toBe(200);
    expect((seated.body.branch as { id?: string }).id).toBe(chalongId);

    // The operator-wide administrator can move there while it is open …
    const moved = await call('PUT', '/me/session/branch', {
      cookie: adminCookie,
      payload: { branchId: chalongId },
    });
    expect(moved.statusCode).toBe(200);
    // … and back, before anything is archived: their session has to survive
    // the archiving below for the "the other park still trades" case to mean
    // anything.
    const backToCentral = await call('PUT', '/me/session/branch', {
      cookie: adminCookie,
      payload: { branchId: centralId },
    });
    expect(backToCentral.statusCode).toBe(200);
  });

  it('accepts a role assignment at the branch while it is open', async () => {
    const granted = await call('POST', `/accounts/${receptionAccountId}/role-assignments`, {
      cookie: adminCookie,
      payload: { roleName: 'reception', scopeType: 'branch', scopeId: chalongId },
    });
    expect(granted.statusCode).toBe(200);
    // Taken straight back off: what is being pinned is that the grant was
    // possible, not that reception ends up working at both parks.
    const removed = await call(
      'DELETE',
      `/accounts/${receptionAccountId}/role-assignments/${granted.body.id as string}`,
      { cookie: adminCookie },
    );
    expect(removed.statusCode).toBe(200);
  });

  it('archives the branch', async () => {
    const archived = await call('PATCH', `/branches/${chalongId}`, {
      cookie: adminCookie,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
  });

  it('kills the session seated there, at its very next request', async () => {
    const me = await call('GET', '/me', { cookie: chalongCookie });
    expect(me.statusCode).toBe(401);
    expect((me.body.error as { code?: string }).code).toBe('UNAUTHORIZED');
  });

  it('will not seat a new session there either, and says why', async () => {
    /**
     * `seatBranch` only ever considers live branches, so the manager whose
     * every grant is at the archived park now reaches none — and is told so
     * plainly rather than being seated somewhere they hold nothing. This is a
     * 403 with its own code and not the one-answer 401 above, because by this
     * point the password was right: nothing about the account is being
     * disclosed that the person holding it does not already know.
     */
    await _resetThrottle(ctx.db);
    const refused = await signInAttempt(CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    expect(refused.statusCode).toBe(403);
    expect((refused.body.error as { code?: string }).code).toBe('NO_BRANCH_ACCESS');
  });

  it('refuses a new role assignment naming it', async () => {
    const granted = await call('POST', `/accounts/${receptionAccountId}/role-assignments`, {
      cookie: adminCookie,
      payload: { roleName: 'reception', scopeType: 'branch', scopeId: chalongId },
    });
    expect(granted.statusCode).toBe(409);
    expect((granted.body.error as { code?: string }).code).toBe('SCOPE_ARCHIVED');
  });

  it('refuses a session moving to it', async () => {
    const moved = await call('PUT', '/me/session/branch', {
      cookie: adminCookie,
      payload: { branchId: chalongId },
    });
    expect(moved.statusCode).toBe(404);
  });

  it('leaves the other park trading, which is the half that matters', async () => {
    const me = await call('GET', '/me', { cookie: adminCookie });
    expect(me.statusCode).toBe(200);
    expect((me.body.branch as { id?: string }).id).toBe(centralId);

    const receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const lookup = await call('GET', '/members/lookup?phone=0812345678', {
      cookie: receptionCookie,
    });
    expect([200, 404]).toContain(lookup.statusCode);

    const granted = await call('POST', `/accounts/${receptionAccountId}/role-assignments`, {
      cookie: adminCookie,
      payload: { roleName: 'staff', scopeType: 'branch', scopeId: centralId },
    });
    expect(granted.statusCode).toBe(200);
  });
});
