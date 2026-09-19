import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  employee,
  idempotencyKey,
  roleAssignment,
  verificationCode,
} from '@oto/db';
import { AppError } from '../src/lib/errors';
import type { SmsSender } from '../src/services/sms';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * B3 — commit first, send second.
 *
 * Creating a staff account used to send the setup SMS from inside the
 * transaction that created it. With Twilio that is up to about thirty-one
 * seconds of an open transaction against an
 * `idle_in_transaction_session_timeout` of thirty, so a slow provider took
 * the whole account down with it — after the code had already reached the
 * phone. These tests pin the two halves of the fix: the code row commits with
 * the account, and the send happens outside the transaction and cannot undo
 * it.
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;
/** The capturing sender the harness installs; restored after every case. */
let capturing: SmsSender;

beforeAll(async () => {
  ctx = await createTestContext();
  capturing = ctx.app.sms;
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
  branchId = branches.json().branches[0].id;
});
afterEach(() => {
  useSender(capturing);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

function useSender(sender: SmsSender): void {
  (ctx.app as { sms: SmsSender }).sms = sender;
}

/** What a provider outage looks like from the route: the adapter's own 502. */
const failing: SmsSender = {
  async send() {
    throw new AppError(502, 'SMS_DELIVERY_FAILED', 'Could not send the SMS — try again in a moment');
  },
};

/**
 * Records, for each send, whether the row was already committed when the SMS
 * went out. The query runs on another pool connection, so a row still inside
 * an open transaction is invisible to it — `[true]` is therefore exactly one
 * SMS, sent after the commit, and the old code would produce `[false]`.
 */
function watchingSender(phone: string): { sender: SmsSender; committedAtSend: boolean[] } {
  const committedAtSend: boolean[] = [];
  const sender: SmsSender = {
    async send() {
      const rows = await ctx.db.select().from(account).where(eq(account.phone, phone));
      committedAtSend.push(rows.length === 1);
    },
  };
  return { sender, committedAtSend };
}

const auditRows = (action: string) =>
  ctx.db.select().from(auditLog).where(eq(auditLog.action, action));

describe('POST /accounts — the setup code commits, then goes out', () => {
  const phone = '+66900001111';

  it('creates the account, employee, grant, code row and audit row, and sends after the commit', async () => {
    const { sender, committedAtSend } = watchingSender(phone);
    useSender(sender);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { cookie },
      payload: {
        phone,
        employeeName: 'Committed Staffer',
        roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: branchId }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().codeSent).toBe(true);
    expect(res.json().warning).toBeUndefined();
    const id = res.json().id as string;

    const accounts = await ctx.db.select().from(account).where(eq(account.id, id));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.status).toBe('invited');
    expect(
      await ctx.db.select().from(employee).where(eq(employee.id, accounts[0]!.employeeId!)),
    ).toHaveLength(1);
    expect(
      await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, id)),
    ).toHaveLength(1);
    const codes = await ctx.db
      .select()
      .from(verificationCode)
      .where(eq(verificationCode.accountId, id));
    expect(codes).toHaveLength(1);
    expect(codes[0]!.purpose).toBe('setup');
    expect((await auditRows('account.create')).some((r) => r.entityId === id)).toBe(true);

    // The point of the ticket: one SMS, and it left after the commit.
    expect(committedAtSend).toEqual([true]);
  });
});

describe('POST /accounts — the send fails after the commit', () => {
  const phone = '+66900002222';
  let id: string;

  it('keeps the account and answers that the code did not go out', async () => {
    useSender(failing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { cookie },
      payload: { phone, employeeName: 'Undelivered Staffer', roles: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().codeSent).toBe(false);
    expect(res.json().warning.code).toBe('SMS_DELIVERY_FAILED');
    // The way forward is named, and it is one that already exists.
    expect(res.json().warning.message).toMatch(/Set up account|temporary password/);
    id = res.json().id as string;
  });

  it('does not roll the account back — employee, grant and code row all survive', async () => {
    const accounts = await ctx.db.select().from(account).where(eq(account.id, id));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.status).toBe('invited');
    expect(
      await ctx.db.select().from(employee).where(eq(employee.id, accounts[0]!.employeeId!)),
    ).toHaveLength(1);
    // The code is real and unconsumed: the staff member can ask for another
    // one from the sign-in screen, and this one still works until it expires.
    const codes = await ctx.db
      .select()
      .from(verificationCode)
      .where(eq(verificationCode.accountId, id));
    expect(codes).toHaveLength(1);
    expect(codes[0]!.consumedAt).toBeNull();

    expect((await auditRows('account.create')).some((r) => r.entityId === id)).toBe(true);
    // A failed send is not a failed operation.
    expect(await auditRows('account.create.failed')).toHaveLength(0);
  });

  it('the invited account can still finish setup with a fresh code', async () => {
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/auth/setup/start',
      payload: { phone },
    });
    expect(start.statusCode).toBe(200);
    expect(ctx.smsLog[ctx.smsLog.length - 1]).toContain('setup code');
  });

  it('answers 200, so the idempotency claim survives and a retry replays', async () => {
    useSender(failing);
    const headers = { cookie, 'idempotency-key': 'accounts-sms-down' };
    const payload = { phone: '+66900003333', employeeName: 'Retried Staffer', roles: [] };

    const first = await ctx.app.inject({ method: 'POST', url: '/accounts', payload, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().codeSent).toBe(false);

    // Had the failed send been answered with a 5xx, the plugin would have
    // released the key here: the retry would re-run the create, find the
    // phone taken and answer 409 — with no code sent either time.
    const retry = await ctx.app.inject({ method: 'POST', url: '/accounts', payload, headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['x-oto-replay']).toBe('true');
    // The replay is the committed answer. `codeSent` described one attempt at
    // delivery, not the record of the account, and is deliberately not in it.
    expect(retry.json()).toEqual({ id: first.json().id, status: 'invited' });
    expect(
      await ctx.db.select().from(account).where(eq(account.phone, '+66900003333')),
    ).toHaveLength(1);
  });
});

describe('the code never leaves the SMS', () => {
  it('is in no response body, no audit row and no stored idempotent response', async () => {
    const phone = '+66900004444';
    const headers = { cookie, 'idempotency-key': 'accounts-code-leak' };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/accounts',
      headers,
      payload: { phone, employeeName: 'Leak Check', roles: [] },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;

    const sent = ctx.smsLog[ctx.smsLog.length - 1]!;
    const code = sent.match(/(\d{6})/)![1]!;

    expect(res.body).not.toContain(code);
    const created = (await auditRows('account.create')).find((r) => r.entityId === id)!;
    expect(JSON.stringify(created)).not.toContain(code);
    const [claim] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, 'accounts-code-leak'));
    expect(JSON.stringify(claim!.responseBody)).not.toContain(code);
  });
});

describe('POST /operators/:id/administrators', () => {
  let operatorId: string;

  beforeAll(async () => {
    const op = await ctx.app.inject({
      method: 'POST',
      url: '/operators',
      headers: { cookie },
      payload: { name: 'Sent After Commit Co' },
    });
    operatorId = op.json().id as string;
  });

  it("sends the administrator's code after the commit", async () => {
    const phone = '+66900005555';
    const { sender, committedAtSend } = watchingSender(phone);
    useSender(sender);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/operators/${operatorId}/administrators`,
      headers: { cookie },
      payload: { phone, name: 'Committed Admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().codeSent).toBe(true);
    expect(committedAtSend).toEqual([true]);
    const accountId = res.json().accountId as string;
    expect(
      await ctx.db.select().from(verificationCode).where(eq(verificationCode.accountId, accountId)),
    ).toHaveLength(1);
  });

  it('keeps the administrator when the send fails, and says so', async () => {
    const phone = '+66900006666';
    useSender(failing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/operators/${operatorId}/administrators`,
      headers: { cookie },
      payload: { phone, name: 'Undelivered Admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().codeSent).toBe(false);
    expect(res.json().warning.code).toBe('SMS_DELIVERY_FAILED');

    const accountId = res.json().accountId as string;
    expect(await ctx.db.select().from(account).where(eq(account.id, accountId))).toHaveLength(1);
    expect(
      await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, accountId)),
    ).toHaveLength(1);
    expect(
      await ctx.db.select().from(verificationCode).where(eq(verificationCode.accountId, accountId)),
    ).toHaveLength(1);
    expect(await auditRows('operator.assign_admin.failed')).toHaveLength(0);
  });
});
