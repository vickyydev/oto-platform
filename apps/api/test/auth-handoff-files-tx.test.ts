import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { account, auditLog, fileObject, handoffToken, verificationCode } from '@oto/db';
import {
  ADMIN,
  RECEPTION,
  CENTRAL_BRANCH_CODE,
  branchIdByCode,
  createTestContext,
  lastCode,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-296 — the three writes a plain transaction wrap would have WEAKENED.
 *
 * SCRUM-284 wrapped eight of ten mutating paths. These three were left, on
 * purpose, because each keeps something on the pool that must survive the
 * transaction beside it:
 *
 *  - the code-consume paths do their FAILURE bookkeeping — counting the wrong
 *    guess, invalidating every outstanding code once the budget is gone — on
 *    the handle they consume with. Wrap them whole and a wrong guess rolls its
 *    own counter back, and guessing a six-digit code becomes free.
 *  - the hand-off exchange spends its jti BEFORE the audience, origin and
 *    session checks. Wrap it whole and every rejection un-spends the token,
 *    which is the one thing single use exists to prevent.
 *  - `POST /files` is the plain one.
 *
 * So each is proved twice over: that the act is now all-or-nothing, and that
 * the thing which had to stay outside still does.
 *
 * THE FAILURE SHAPES, and why there are two. `whileFailing` raises on the
 * audit insert — enough to show a change written outside any transaction,
 * because the row lands and the operation does not. `whileFailingAtCommit`
 * raises at COMMIT, after everything the handler wrote, which is the only
 * shape that catches an audit row written on the POOL from inside a
 * transaction: with that bug the row is already committed and cannot be taken
 * back. Both are the shapes `leaks-and-trail.test.ts` established.
 */

const KID = 'k1';
const SECRET = 'handoff-test-secret-0123456789abcdef';
const POS_ORIGIN = 'https://pos.test';
const CONSOLE_ORIGIN = 'https://console.test';

/** Wrong guesses allowed per code, set low so the budget is reachable here. */
const MAX_ATTEMPTS = 3;

let ctx: TestContext;
let adminCookie: string;
let adminAccountId: string;
let centralBranch: string;

beforeAll(async () => {
  ctx = await createTestContext({
    // Storage is built from the defaults: signing is local arithmetic, so
    // `POST /files` reaches no bucket and these cases do not need one running.
    files: true,
    env: {
      HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
      HANDOFF_APP_ORIGINS: `pos=${POS_ORIGIN},console=${CONSOLE_ORIGIN}`,
      ALLOWED_ORIGINS: `${POS_ORIGIN},${CONSOLE_ORIGIN}`,
      CODE_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
    },
  });
  await ctx.db.execute(sql`
    create or replace function oto_test_fail() returns trigger as $fn$
    begin
      raise exception 'forced failure';
    end
    $fn$ language plpgsql;
  `);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: adminCookie } });
  adminAccountId = me.json().account.id as string;
  centralBranch = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/**
 * The schema a table lives in, asked of the database rather than written down
 * here: `packages/db` owns where these sit, and a trigger in a test is not the
 * place for a second copy of that decision to drift.
 */
async function qualified(table: string): Promise<string> {
  const result = await ctx.db.execute(
    sql`select table_schema from information_schema.tables
        where table_name = ${table}
          and table_schema not in ('pg_catalog', 'information_schema')
        limit 1`,
  );
  const row = (result as unknown as { rows: Array<{ table_schema: string }> }).rows[0];
  if (!row) throw new Error(`no table named ${table} in this database`);
  return `${row.table_schema}.${table}`;
}

/** Raise ON the audit insert: catches a change written outside any transaction. */
async function whileFailing(action: string, fn: () => Promise<void>): Promise<void> {
  const table = await qualified('audit_log');
  await ctx.db.execute(
    sql.raw(
      `create trigger oto_test_fail_trg after insert on ${table}
       for each row when (new.action = '${action}') execute function oto_test_fail();`,
    ),
  );
  try {
    await fn();
  } finally {
    await ctx.db.execute(sql.raw(`drop trigger oto_test_fail_trg on ${table};`));
  }
}

/**
 * Raise at COMMIT, after everything the handler wrote. The only shape that can
 * show a row cannot survive its own failure.
 */
async function whileFailingAtCommit(
  table: string,
  event: 'insert' | 'update',
  when: string,
  fn: () => Promise<void>,
): Promise<void> {
  const name = await qualified(table);
  await ctx.db.execute(
    sql.raw(
      `create constraint trigger oto_test_commit_fail_trg after ${event} on ${name}
       deferrable initially deferred
       for each row when (${when}) execute function oto_test_fail();`,
    ),
  );
  try {
    await fn();
  } finally {
    await ctx.db.execute(sql.raw(`drop trigger oto_test_commit_fail_trg on ${name};`));
  }
}

const countAudit = async (action: string): Promise<number> =>
  (await ctx.db.select().from(auditLog).where(eq(auditLog.action, action))).length;

const auditRows = (action: string, entityId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

// ---------------------------------------------------------------------------

describe('SCRUM-296 — registering a file (the plain one)', () => {
  const register = (contentType: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie: adminCookie },
      payload: { contentType, ownerEntityType: 'account', ownerEntityId: adminAccountId },
    });

  const filesFor = () =>
    ctx.db.select().from(fileObject).where(eq(fileObject.ownerEntityId, adminAccountId));

  it('registers nothing when the registration cannot be recorded', async () => {
    const before = (await filesFor()).length;

    await whileFailing('file.create', async () => {
      const res = await register('image/png');
      expect(res.statusCode).toBe(500);
    });

    expect(
      (await filesFor()).length,
      'a file_object row nothing in the trail accounts for is a photo on somebody’s account with no answer to who put it there',
    ).toBe(before);
    expect(await countAudit('file.create.failed')).toBeGreaterThan(0);
  });

  it('leaves no row in the trail for a file that rolled back at commit', async () => {
    const before = await countAudit('file.create');

    await whileFailingAtCommit(
      'file_object',
      'insert',
      `new.content_type = 'image/x-phantom'`,
      async () => {
        const res = await register('image/x-phantom');
        expect(res.statusCode).toBe(500);
      },
    );

    expect(
      (await filesFor()).filter((f) => f.contentType === 'image/x-phantom'),
      'the transaction rolled back, so there is no file',
    ).toEqual([]);
    expect(
      await countAudit('file.create'),
      'and nothing describing one — this is what an audit row written on the pool would leave behind',
    ).toBe(before);
  });

  it('still registers the file and its row together', async () => {
    const res = await register('image/png');
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;
    expect(res.json().uploadUrl).toContain('X-Amz-Signature');

    expect(await ctx.db.select().from(fileObject).where(eq(fileObject.id, id))).toHaveLength(1);
    expect(await auditRows('file.create', id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

/** Invite an account and return the phone and the code that was sent to it. */
async function invite(phone: string, name: string): Promise<{ phone: string; code: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/accounts',
    headers: { cookie: adminCookie },
    payload: {
      phone,
      employeeName: name,
      roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: centralBranch }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { phone, code: lastCode(ctx.smsLog) };
}

const completeSetup = (phone: string, code: string, password: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/auth/setup/complete',
    payload: { phone, code, password },
  });

const liveCodes = (accountId: string) =>
  ctx.db
    .select()
    .from(verificationCode)
    .where(
      and(eq(verificationCode.accountId, accountId), sql`${verificationCode.consumedAt} is null`),
    );

const accountIdFor = async (phone: string): Promise<string> => {
  const [row] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone));
  return row!.id;
};

describe('SCRUM-296 — finishing a setup', () => {
  it('does not burn the code when the setup fails at commit', async () => {
    const invited = await invite('+66955550001', 'Commit Failure');
    const accountId = await accountIdFor(invited.phone);

    await whileFailingAtCommit(
      'account',
      'update',
      `new.phone = '${invited.phone}'`,
      async () => {
        const res = await completeSetup(invited.phone, invited.code, 'firstshift123');
        expect(res.statusCode).toBe(500);
      },
    );

    // THE WINDOW THIS TICKET NAMES. On two statements the consume had already
    // committed: the code was spent, the password was not set, the account was
    // still invited, and nobody but an administrator could issue another.
    expect(
      await liveCodes(accountId),
      'the code was not spent by a setup that did not happen',
    ).toHaveLength(1);
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, accountId));
    expect(acc!.status).toBe('invited');
    expect(acc!.passwordHash).toBeNull();

    // And the same code, unchanged, still finishes the job.
    const again = await completeSetup(invited.phone, invited.code, 'firstshift123');
    expect(again.statusCode, again.body).toBe(200);
    const cookie = await signInAs(ctx.app, invited.phone, 'firstshift123');
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).statusCode).toBe(
      200,
    );
  });

  it('still counts a wrong code, and still invalidates the code once the budget is gone', async () => {
    const invited = await invite('+66955550002', 'Wrong Guesses');
    const accountId = await accountIdFor(invited.phone);
    const wrong = invited.code === '000000' ? '111111' : '000000';

    // THE BOOKKEEPING THAT HAD TO STAY OUT OF THE TRANSACTION. If the counter
    // were written where a refusal could roll it back, the fourth guess below
    // would be as cheap as the first and a six-digit code would cost an
    // attacker nothing but time.
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const res = await completeSetup(invited.phone, wrong, 'guessing12345');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Invalid code');
    }
    const spent = await completeSetup(invited.phone, wrong, 'guessing12345');
    expect(spent.statusCode).toBe(400);
    expect(spent.json().error.message).toMatch(/Too many wrong codes/);

    // The budget ran out, so every outstanding code went with it — including
    // the real one, which is the point: the attacker has to go back through
    // the per-phone rate limit to get another.
    expect(await liveCodes(accountId)).toHaveLength(0);
    const real = await completeSetup(invited.phone, invited.code, 'realcode12345');
    expect(real.statusCode).toBe(400);

    // Nothing was opened by any of that: a refused guess never reaches the
    // transaction, so there is no half-finished setup and no row claiming one.
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, accountId));
    expect(acc!.status).toBe('invited');
    expect(acc!.passwordHash).toBeNull();
    expect(await auditRows('auth.setup_complete', accountId)).toEqual([]);
  });
});

describe('SCRUM-296 — resetting a password', () => {
  it('leaves the old password, its sessions and the code alone when the reset fails at commit', async () => {
    const before = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const accountId = await accountIdFor(RECEPTION.phone);
    await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { phone: RECEPTION.phone },
    });
    const code = lastCode(ctx.smsLog);

    await whileFailingAtCommit('account', 'update', `new.phone = '${RECEPTION.phone}'`, async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/password-reset/complete',
        payload: { phone: RECEPTION.phone, code, password: 'halfwayreset123' },
      });
      expect(res.statusCode).toBe(500);
    });

    // A password changed with the sessions that knew the old one still open,
    // or a session killed for a password that was never written, are both
    // halves that should not exist on their own.
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: before } });
    expect(me.statusCode, 'the sessions were not ended by a reset that did not happen').toBe(200);
    await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect(await liveCodes(accountId)).toHaveLength(1);

    // And the whole act, done for real: the new password works, the code is
    // spent, and every session that knew the old one is gone.
    const done = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { phone: RECEPTION.phone, code, password: 'properreset123' },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: before } })).statusCode,
    ).toBe(401);
    await signInAs(ctx.app, RECEPTION.phone, 'properreset123');
    expect(await liveCodes(accountId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

interface IssuedBody {
  token: string;
  launchUrl: string;
}

async function mint(cookie: string, app = 'pos'): Promise<IssuedBody> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/auth/handoff',
    headers: { cookie },
    payload: { app },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as IssuedBody;
}

const exchange = (token: string, origin = POS_ORIGIN) =>
  ctx.app.inject({
    method: 'POST',
    url: '/auth/handoff/exchange',
    headers: { origin },
    payload: { token },
  });

/** The jti of a token we minted — read out of the payload, not trusted. */
const jtiOf = (token: string): string =>
  (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { jti: string })
    .jti;

const tokenRow = async (jti: string) => {
  const [row] = await ctx.db.select().from(handoffToken).where(eq(handoffToken.jti, jti));
  return row!;
};

describe('SCRUM-296 — the hand-off claim', () => {
  it('spends nothing when the claim fails at commit, and the token still works', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    const jti = jtiOf(issued.token);

    // The trigger fires on the SECOND of the claim's two writes — destroying
    // the sealed session. As two statements on the pool the first had already
    // committed by then: the token was spent, its sealed session was still
    // sitting in the row, and the browser got a 500. In one transaction
    // neither happens.
    await whileFailingAtCommit(
      'handoff_token',
      'update',
      'new.session_secret is null and old.session_secret is not null',
      async () => {
        const res = await exchange(issued.token);
        expect(res.statusCode).toBe(500);
        expect(res.headers['set-cookie']).toBeUndefined();
      },
    );

    const row = await tokenRow(jti);
    expect(row.consumedAt, 'a claim that rolled back spent nothing').toBeNull();
    expect(row.sessionSecret, 'and destroyed nothing').not.toBeNull();
    expect(await auditRows('auth.handoff_claim', jti), 'nor recorded a claim').toEqual([]);

    // Nothing happened, so the launcher's link is still good.
    const res = await exchange(issued.token);
    expect(res.statusCode, res.body).toBe(200);
    expect((await tokenRow(jti)).consumedAt).not.toBeNull();
  });

  it('records the claim with the jti, inside the operator it belongs to', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    const jti = jtiOf(issued.token);
    expect((await exchange(issued.token)).statusCode).toBe(200);

    const [claimed] = await auditRows('auth.handoff_claim', jti);
    expect(claimed, 'a credential being spent is an event').toBeTruthy();
    expect(claimed!.operatorId, 'filed inside its own tenant, or nobody there can read it').toBeTruthy();
    expect(claimed!.actorAccountId).toBe(adminAccountId);
    expect(JSON.stringify(claimed)).not.toContain(issued.token);
  });

  it('still spends a hand-off that is REFUSED, so it cannot be carried to the right door', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher, 'pos');
    const jti = jtiOf(issued.token);

    // The whole reason the claim is not wrapped around the checks below it.
    const refused = await exchange(issued.token, CONSOLE_ORIGIN);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.details.reason).toBe('origin');
    expect(refused.headers['set-cookie']).toBeUndefined();

    const row = await tokenRow(jti);
    expect(row.consumedAt, 'a rejection must never hand the token back').not.toBeNull();
    expect(row.sessionSecret).toBeNull();

    const replay = await exchange(issued.token, POS_ORIGIN);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.details.reason).toBe('replayed');
  });

  it('spends one whose session ended in flight, and that one cannot be replayed either', async () => {
    const launcher = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const issued = await mint(launcher);
    await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: launcher } });

    const refused = await exchange(issued.token);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.details.reason).toBe('revoked');

    const replay = await exchange(issued.token);
    expect(replay.json().error.details.reason).toBe('replayed');
  });
});
