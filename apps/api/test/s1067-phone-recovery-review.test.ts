import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { account, verificationCode } from '@oto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, RECEPTION, createTestContext, lastCode, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const sendReset = (phone: string) => ctx.app.inject({
  method: 'POST', url: '/auth/password-reset/request', payload: { phone },
});

describe('SCRUM-1067 staff phone recovery review', () => {
  it('sends to the registered administrator phone and requires a valid, single-use code before changing the account', async () => {
    const [admin] = await ctx.db.update(account).set({ phoneVerifiedAt: null, employeeId: null })
      .where(eq(account.phone, ADMIN.phone)).returning({ id: account.id, hash: account.passwordHash });
    const read = async () => (await ctx.db.select({ verified: account.phoneVerifiedAt, hash: account.passwordHash })
      .from(account).where(eq(account.id, admin!.id)))[0];
    const password = randomUUID();
    const complete = (code: string) => ctx.app.inject({
      method: 'POST', url: '/auth/password-reset/complete', payload: { phone: ADMIN.phone, code, password },
    });
    const before = ctx.smsLog.length;
    const known = await sendReset(ADMIN.phone);
    const unknown = await sendReset('+12025550149');
    expect(known.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(ctx.smsLog).toHaveLength(before + 1);
    const first = lastCode(ctx.smsLog);
    expect((await complete(first === '000000' ? '000001' : '000000')).statusCode).toBe(400);
    await ctx.db.update(verificationCode).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(verificationCode.accountId, admin!.id), eq(verificationCode.purpose, 'password_reset')));
    expect((await complete(first)).statusCode).toBe(400);
    const unchanged = await read();
    expect(unchanged?.verified).toBeNull();
    expect(unchanged?.hash === admin!.hash).toBe(true);
    expect((await sendReset(ADMIN.phone)).statusCode).toBe(200);
    const valid = lastCode(ctx.smsLog);
    expect((await complete(valid)).statusCode).toBe(200);
    expect((await read())?.verified).toBeInstanceOf(Date);
    expect((await complete(valid)).statusCode).toBe(400);
    await signInAs(ctx.app, ADMIN.phone, password);
  });

  it('refuses to apply a code sent to the earlier number after the registered number changes', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const newNumber = '+12025550147';
    await ctx.db.update(account).set({ phoneVerifiedAt: null }).where(eq(account.phone, RECEPTION.phone));
    const send = await ctx.app.inject({ method: 'POST', url: '/auth/phone-verification/request', headers: { cookie } });
    expect(send.statusCode).toBe(200);
    const code = lastCode(ctx.smsLog);
    await ctx.db.update(account).set({ phone: newNumber }).where(eq(account.phone, RECEPTION.phone));
    const confirm = await ctx.app.inject({ method: 'POST', url: '/auth/phone-verification/complete', headers: { cookie }, payload: { code } });
    expect(confirm.statusCode).toBe(400);
    const [current] = await ctx.db.select({ verified: account.phoneVerifiedAt }).from(account).where(eq(account.phone, newNumber));
    expect(current?.verified).toBeNull();
  });
});
