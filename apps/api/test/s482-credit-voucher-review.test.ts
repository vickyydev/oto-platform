import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  idempotencyKey,
  printJob,
  station,
  voucher,
  voucherDefinition,
} from '@oto/db';
import { VOUCHER_CREDIT_MESSAGES, newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { _resetThrottle, setPassword } from '../src/services/auth';
import { withoutCredentials } from '../src/plugins/idempotency';

/**
 * SCRUM-482 — A CREDIT VOUCHER IS A MANAGER'S; RECEPTION ASKS AND A MANAGER
 * APPROVES ON THE SPOT (the owner's rulings of 18 and 19 November; plan
 * docs/progress/plans/consistency/RULINGS_BUILD_PLAN_2026-11-18.md part A).
 *
 * Through the real routes, with real sessions standing at real tills:
 *
 *   - the permission: branch managers and administrators, not reception;
 *   - the picker marks a credit type "needs a manager" for reception only;
 *   - reception is refused a credit voucher with no approval, and still
 *     issues every other kind as before;
 *   - a manager signed in at the till issues one alone, named on the record;
 *   - on the spot: the right approval prints and is recorded (voucher, audit,
 *     ledger, download); a wrong password, an unknown phone, the asker's own
 *     phone, a manager of another park, a temporary password and an inactive
 *     account are each refused in plain words, and nothing is minted;
 *   - the phone is throttled with sign-in's own bucket;
 *   - the side door: a credit type is never saved with a fixed code, and the
 *     shared code of one saved before is a manager's at the till;
 *   - THE PASSWORD is never logged, stored, echoed or hashed into the replay
 *     store, on the success path or any refusal.
 */

let ctx: TestContext;
const logLines: string[] = [];
let till: string; // reception at T1
let managerTill: string; // the branch manager at T2
let admin: string;
let operatorId: string;
let hktId: string;
let t1: typeof station.$inferSelect;
let receptionId: string;
let managerId: string;
let chalongManagerId: string;

const b = (baht: number): number => Math.round(baht * 100);

async function pick(cookie: string, stationId: string): Promise<void> {
  const res = await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId } });
  if (res.statusCode !== 200) throw new Error(`station pick failed (${res.statusCode}): ${res.body}`);
}

async function define(values: Partial<typeof voucherDefinition.$inferInsert>): Promise<string> {
  const id = newId();
  await ctx.db.insert(voucherDefinition).values({
    id,
    operatorId,
    code: `s482-${id}`,
    nameEn: 'ZZ TEST ฿1 credit',
    kind: 'wallet_credit',
    valueType: 'amount',
    valueSatang: b(1),
    ...values,
  } as typeof voucherDefinition.$inferInsert);
  return id;
}

const issue = (cookie: string, payload: Record<string, unknown>, key?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/vouchers/issue',
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  });

const minted = async (definitionId: string) =>
  ctx.db.select().from(voucher).where(eq(voucher.voucherDefinitionId, definitionId));

const accountIdOf = async (phone: string): Promise<string> => {
  const [row] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone));
  return row!.id;
};

const refusalsOf = async (definitionId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, definitionId), eq(auditLog.action, 'voucher.credit_approval_refused')));

beforeAll(async () => {
  ctx = await createTestContext({
    logCapture: { stream: { write: (line) => void logLines.push(line) }, level: 'trace' },
  });
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  hktId = hkt!.id;
  operatorId = hkt!.operatorId;
  const stations = await ctx.db.select().from(station).where(eq(station.branchId, hktId));
  t1 = stations.find((s) => s.codePrefix === 'T1')!;
  const t2 = stations.find((s) => s.codePrefix === 'T2')!;
  receptionId = await accountIdOf(RECEPTION.phone);
  managerId = await accountIdOf(BRANCH_MANAGER.phone);
  chalongManagerId = await accountIdOf(CHALONG_MANAGER.phone);
  till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(till, t1.id);
  managerTill = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  await pick(managerTill, t2.id);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
}, 180_000);

afterEach(async () => {
  await _resetThrottle(ctx.db);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the picker names a credit voucher "needs a manager" for reception only', () => {
  it('reception sees the credit type marked and the discount not; the manager sees neither marked', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit picker' });
    const discount = await define({ nameEn: 'ZZ TEST discount picker', kind: 'discount', valueSatang: b(50) });
    const listed = async (cookie: string) => {
      const res = await ctx.app.inject({ method: 'GET', url: '/vouchers/issuable', headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      const all = res.json().definitions as Array<{ id: string; needsManager: boolean }>;
      return Object.fromEntries(all.filter((d) => d.id === credit || d.id === discount).map((d) => [d.id, d.needsManager]));
    };
    expect(await listed(till)).toEqual({ [credit]: true, [discount]: false });
    expect(await listed(managerTill)).toEqual({ [credit]: false, [discount]: false });
  });
});

describe('reception is refused a credit voucher without a manager, and issues every other kind as before', () => {
  it('no approval: 403 in the counter’s words, nothing minted; a discount still prints', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit refused' });
    const refused = await issue(till, { definitionId: credit });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({
      code: 'VOUCHER_CREDIT_NEEDS_MANAGER',
      message: 'A credit voucher needs a manager’s approval.',
    });
    expect(await minted(credit)).toEqual([]);

    const discount = await define({ nameEn: 'ZZ TEST discount ok', kind: 'discount', valueSatang: b(50) });
    const ok = await issue(till, { definitionId: discount });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await minted(discount);
    expect(row).toMatchObject({ issuedByAccountId: receptionId, approvedByAccountId: null });
  });

  it('an approval sent with any other kind is not consulted: a wrong password still issues a discount, with no approver', async () => {
    const discount = await define({ nameEn: 'ZZ TEST discount ignores approval', kind: 'discount', valueSatang: b(50) });
    const ok = await issue(till, { definitionId: discount, approval: { phone: BRANCH_MANAGER.phone, password: 'not-the-password' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await minted(discount))[0]).toMatchObject({ approvedByAccountId: null });
    expect(await refusalsOf(discount)).toEqual([]);
  });
});

describe('a manager signed in at the till issues a credit voucher alone, named on the record', () => {
  it('issued and printed with no second person: the manager is the issuer and there is no approver', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit by the manager' });
    const res = await issue(managerTill, { definitionId: credit });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await minted(credit);
    expect(row).toMatchObject({ issuedByAccountId: managerId, approvedByAccountId: null, source: 'manual' });
    const [audited] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, row!.id), eq(auditLog.action, 'voucher.issue')));
    expect(audited!.actorAccountId).toBe(managerId);
    expect(audited!.after).toMatchObject({ approvedByAccountId: null });
  });
});

describe('on the spot: a manager approves on the same till', () => {
  it('the right approval prints the slip and records both people — voucher, audit row, ledger and download', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit approved', usageLimit: 2 });
    const res = await issue(till, { definitionId: credit, approval: { phone: '0900000004', password: BRANCH_MANAGER.password } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.voucher).toMatchObject({ definitionId: credit, kind: 'wallet_credit' });
    const [row] = await minted(credit);
    expect(row).toMatchObject({ issuedByAccountId: receptionId, approvedByAccountId: managerId, status: 'issued' });

    const [audited] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, row!.id), eq(auditLog.action, 'voucher.issue')));
    expect(audited!.actorAccountId).toBe(receptionId);
    expect(audited!.after).toMatchObject({ approvedByAccountId: managerId, stationId: t1.id });

    const [job] = await ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'voucher'), eq(printJob.subjectId, row!.id)));
    expect(job).toMatchObject({ kind: 'booth_voucher', stationId: t1.id });
    expect(body.print.jobId).toBe(job!.id);

    // The Console's ledger: issued by reception, approved by the manager.
    const ledger = await ctx.app.inject({ method: 'GET', url: `/vouchers?branchId=${hktId}&definitionId=${credit}`, headers: { cookie: admin } });
    expect(ledger.statusCode, ledger.body).toBe(200);
    const [line] = ledger.json().rows as Array<{ issuedBy: { accountId: string; name: string | null } | null; approvedBy: { accountId: string; name: string | null } | null }>;
    expect(line!.issuedBy).toMatchObject({ accountId: receptionId, name: 'Som (Reception)' });
    expect(line!.approvedBy).toMatchObject({ accountId: managerId, name: 'Khun Lek (Manager)' });
    // And its download carries the approver in its own column.
    const csv = await ctx.app.inject({ method: 'GET', url: `/vouchers/export?branchId=${hktId}&definitionId=${credit}`, headers: { cookie: admin } });
    expect(csv.statusCode).toBe(200);
    const [header, first] = csv.body.slice(csv.body.charCodeAt(0) === 0xfeff ? 1 : 0).trim().split('\r\n');
    const columns = header!.split(',');
    const cells = first!.split(',');
    expect(cells[columns.indexOf('Issued by')]).toBe('Som (Reception)');
    expect(cells[columns.indexOf('Approved by')]).toMatch(/^Khun Lek \(Manager\) \(S-[0-9A-Z]+\)$/);
  });

  it('a wrong password, an unknown phone and an inactive manager get one plain answer; nothing is minted', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit wrong password' });
    const wrong = await issue(till, { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: 'manager9999' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toEqual({ code: 'VOUCHER_APPROVAL_INCORRECT', message: 'The manager’s phone number or password is incorrect.' });

    const nobody = await issue(till, { definitionId: credit, approval: { phone: '+66900000077', password: 'manager1234' } });
    expect(nobody.statusCode).toBe(403);
    expect(nobody.json().error).toEqual(wrong.json().error);

    await ctx.db.update(account).set({ status: 'inactive' }).where(eq(account.id, chalongManagerId));
    try {
      const inactive = await issue(till, { definitionId: credit, approval: { phone: CHALONG_MANAGER.phone, password: CHALONG_MANAGER.password } });
      expect(inactive.statusCode).toBe(403);
      expect(inactive.json().error).toEqual(wrong.json().error);
    } finally {
      await ctx.db.update(account).set({ status: 'active' }).where(eq(account.id, chalongManagerId));
    }
    expect(await minted(credit)).toEqual([]);
    // Each refusal is on the record with its reason, the phone as a hash only.
    const reasons = (await refusalsOf(credit)).map((r) => (r.after as { reason: string }).reason).sort();
    expect(reasons).toEqual(['account_inactive', 'bad_password', 'no_account']);
  });

  it('the person at the till cannot approve their own, and a manager of another park cannot approve here', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit wrong approver' });
    const self = await issue(till, { definitionId: credit, approval: { phone: RECEPTION.phone, password: RECEPTION.password } });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toEqual({ code: 'VOUCHER_APPROVER_IS_ASKER', message: VOUCHER_CREDIT_MESSAGES.approverIsAsker });

    // Khun Dao manages Robinson Chalong, not Central Floresta where this till is.
    const elsewhere = await issue(till, { definitionId: credit, approval: { phone: CHALONG_MANAGER.phone, password: CHALONG_MANAGER.password } });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error).toEqual({ code: 'VOUCHER_APPROVER_NOT_MANAGER', message: 'This account cannot approve a credit voucher at this park.' });
    expect(await minted(credit)).toEqual([]);
  });

  it('a manager still on a temporary password is told to set their own first', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit temporary password' });
    await ctx.db.update(account).set({ mustChangePassword: true }).where(eq(account.id, managerId));
    try {
      const res = await issue(till, { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toEqual({
        code: 'VOUCHER_APPROVER_MUST_CHANGE_PASSWORD',
        message: VOUCHER_CREDIT_MESSAGES.approverMustChangePassword,
      });
    } finally {
      await ctx.db.update(account).set({ mustChangePassword: false }).where(eq(account.id, managerId));
    }
    expect(await minted(credit)).toEqual([]);
  });

  it('the phone is throttled with sign-in’s own bucket: five wrong passwords close both doors to that phone', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit throttled' });
    for (let i = 0; i < 5; i += 1) {
      const res = await issue(till, { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: `wrong-${i}` } });
      expect(res.statusCode).toBe(403);
    }
    // Locked: the right password is not even checked now…
    const locked = await issue(till, { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('TOO_MANY_REQUESTS');
    // …and the lock screen shares the budget.
    const signIn = await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: BRANCH_MANAGER });
    expect(signIn.statusCode).toBe(429);
    expect(await minted(credit)).toEqual([]);
    const lockouts = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.locked_out'), eq(auditLog.entityId, managerId)));
    expect(lockouts.length).toBeGreaterThanOrEqual(1);
  });

  it('a replayed press is one voucher, and a retry differing only in the password is the same press', async () => {
    const credit = await define({ nameEn: 'ZZ TEST credit replay' });
    const key = newId();
    const payload = { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password } };
    const first = await issue(till, payload, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await issue(till, payload, key);
    expect(again.json().voucher.id).toBe(first.json().voucher.id);
    const otherPassword = await issue(till, { ...payload, approval: { ...payload.approval, password: 'anything-else' } }, key);
    expect(otherPassword.statusCode).toBe(200);
    expect(otherPassword.headers['x-oto-replay']).toBe('true');
    expect(otherPassword.json().voucher.id).toBe(first.json().voucher.id);
    expect(await minted(credit)).toHaveLength(1);
  });
});

describe('the side door is closed: a credit type has no fixed code', () => {
  const post = (body: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/voucher-definitions', headers: { cookie: admin }, payload: body });
  const patch = (id: string, body: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PATCH', url: `/voucher-definitions/${id}`, headers: { cookie: admin }, payload: body });
  const refusal = {
    code: 'VOUCHER_FIXED_CODE_CREDIT',
    message: 'A credit voucher type cannot have a fixed code — each credit voucher is issued at the till by a manager',
  };

  it('is refused at save: made with one, a fixed discount turned into credit, a credit given one', async () => {
    const made = await post({
      code: `zz-482-${newId().slice(-8)}`, nameEn: 'ZZ TEST fixed credit', kind: 'wallet_credit',
      valueType: 'amount', valueSatang: b(1), codeMode: 'fixed', fixedCode: 'ZZ482-CREDIT',
    });
    expect(made.statusCode).toBe(422);
    expect(made.json().error).toMatchObject(refusal);

    const fixedDiscount = await post({
      code: `zz-482-${newId().slice(-8)}`, nameEn: 'ZZ TEST fixed discount', kind: 'discount',
      valueType: 'amount', valueSatang: b(5), codeMode: 'fixed', fixedCode: 'ZZ482-DISC',
    });
    expect(fixedDiscount.statusCode, fixedDiscount.body).toBe(201);
    const turned = await patch(fixedDiscount.json().definition.id, { kind: 'wallet_credit', valueType: 'amount', valueSatang: b(1) });
    expect(turned.statusCode).toBe(422);
    expect(turned.json().error).toMatchObject(refusal);

    const credit = await post({
      code: `zz-482-${newId().slice(-8)}`, nameEn: 'ZZ TEST generated credit', kind: 'wallet_credit',
      valueType: 'amount', valueSatang: b(1),
    });
    expect(credit.statusCode, credit.body).toBe(201);
    const given = await patch(credit.json().definition.id, { codeMode: 'fixed', fixedCode: 'ZZ482-GIVEN' });
    expect(given.statusCode).toBe(422);
    expect(given.json().error).toMatchObject(refusal);
  });

  it('the shared code of a credit type saved before is a manager’s at the till: reception refused at look-up and hold, nothing minted', async () => {
    const credit = await define({ nameEn: 'ZZ TEST old fixed credit', codeMode: 'fixed', fixedCode: 'ZZ482-OLD' });
    const looked = await ctx.app.inject({ method: 'GET', url: '/vouchers/lookup?code=ZZ482-OLD', headers: { cookie: till } });
    expect(looked.statusCode).toBe(403);
    expect(looked.json().error).toMatchObject({ code: 'VOUCHER_CREDIT_NEEDS_MANAGER', message: VOUCHER_CREDIT_MESSAGES.needsManager });
    const held = await ctx.app.inject({ method: 'POST', url: `/sales/${newId()}/vouchers`, headers: { cookie: till }, payload: { code: 'ZZ482-OLD' } });
    expect(held.statusCode).toBe(403);
    expect(held.json().error.code).toBe('VOUCHER_CREDIT_NEEDS_MANAGER');
    expect(await minted(credit)).toEqual([]);
    // The manager may.
    const managerLook = await ctx.app.inject({ method: 'GET', url: '/vouchers/lookup?code=ZZ482-OLD', headers: { cookie: managerTill } });
    expect(managerLook.statusCode, managerLook.body).toBe(200);
  });
});

describe('the manager’s password is never logged, stored, echoed or kept in the replay store', () => {
  const RIGHT = 'ZZsentinel-right-482-Qv7';
  const WRONG = 'ZZsentinel-wrong-482-Jm3';

  it('the issue is the one route declaring a password in its body, and it keeps its replay', () => {
    const declared = ctx.app.routeRegistry.filter((r) => r.config.credentialInBody).map((r) => `${r.method} ${r.url}`);
    expect(declared).toEqual(['POST /vouchers/issue']);
    const route = ctx.app.routeRegistry.find((r) => r.method === 'POST' && r.url === '/vouchers/issue');
    expect(route?.config.secretResponse).not.toBe(true);
    expect(route?.config.replaysByOwnId).not.toBe(true);
  });

  it('on the success path and on every refusal', async () => {
    await setPassword(ctx.db, managerId, RIGHT);
    try {
      const credit = await define({ nameEn: 'ZZ TEST credit secrecy' });
      const answers: string[] = [];
      const send = async (password: string, phone = BRANCH_MANAGER.phone, key = newId()) => {
        const res = await issue(till, { definitionId: credit, approval: { phone, password } }, key);
        answers.push(res.body);
        return res;
      };
      expect((await send(WRONG)).statusCode).toBe(403);
      expect((await send(WRONG, '+66900000077')).statusCode).toBe(403);
      expect((await send(RIGHT, CHALONG_MANAGER.phone)).statusCode).toBe(403);
      const key = newId();
      const ok = await send(RIGHT, BRANCH_MANAGER.phone, key);
      expect(ok.statusCode, ok.body).toBe(200);
      // A password the schema refuses is not echoed in the validation answer either.
      const tooLong = `${WRONG}${'x'.repeat(300)}`;
      const invalid = await issue(till, { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: tooLong } });
      expect(invalid.statusCode).toBe(400);
      answers.push(invalid.body);

      // Never echoed.
      for (const body of answers) {
        expect(body).not.toContain(RIGHT);
        expect(body).not.toContain(WRONG);
      }
      // Never logged.
      expect(logLines.length).toBeGreaterThan(0);
      for (const line of logLines) {
        expect(line).not.toContain(RIGHT);
        expect(line).not.toContain(WRONG);
      }
      // Never stored, in any table of ours.
      const { rows: tables } = await ctx.db.execute<{ table_schema: string; table_name: string }>(sql`
        select table_schema, table_name from information_schema.tables
         where table_type = 'BASE TABLE'
           and table_schema in ('core', 'crm', 'pos', 'promo', 'booth', 'analytics', 'edge', 'inbox', 'assistant', 'public')`);
      expect(tables.length).toBeGreaterThan(50);
      for (const t of tables) {
        const { rows } = await ctx.db.execute<{ n: number }>(
          sql.raw(`select count(*)::int as n from "${t.table_schema}"."${t.table_name}" x
                    where x::text like '%ZZsentinel-%-482-%'`),
        );
        expect(Number(rows[0]!.n), `${t.table_schema}.${t.table_name}`).toBe(0);
      }
      // Not even as a hash in the replay store: its request hash is the body's without the password.
      const [stored] = await ctx.db
        .select()
        .from(idempotencyKey)
        .where(and(eq(idempotencyKey.accountId, receptionId), eq(idempotencyKey.key, key)));
      const hashOf = (body: unknown) => {
        const legacy = createHash('sha256').update('POST').update('\n').update('/vouchers/issue').update('\n')
          .update(JSON.stringify(body)).digest('hex');
        return createHash('sha256').update(legacy).update('\neffective-operator\n').update(operatorId).digest('hex');
      };
      const sent = { definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: RIGHT } };
      expect(stored!.requestHash).toBe(hashOf(withoutCredentials(sent)));
      expect(stored!.requestHash).not.toBe(hashOf(sent));
      expect(withoutCredentials(sent)).toEqual({ definitionId: credit, approval: { phone: BRANCH_MANAGER.phone, password: '[credential]' } });
    } finally {
      await setPassword(ctx.db, managerId, BRANCH_MANAGER.password);
    }
  });
});
