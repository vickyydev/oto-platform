import { eq } from 'drizzle-orm';
import { account } from '@oto/db';
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
  it('keeps the same public reply for an unverified administrator and an unknown number, without sending', async () => {
    await ctx.db.update(account).set({ phoneVerifiedAt: null }).where(eq(account.phone, ADMIN.phone));
    const before = ctx.smsLog.length;
    const known = await sendReset(ADMIN.phone);
    const unknown = await sendReset('+12025550149');
    expect(known.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(ctx.smsLog).toHaveLength(before);
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
