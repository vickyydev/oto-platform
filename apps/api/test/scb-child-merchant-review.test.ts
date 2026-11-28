import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, branch, paymentAttempt } from '@oto/db';
import { SimulatorQrPayment } from '@oto/payments-2c2p';
import { hostedChoicePage, selectHostedMethod } from '../src/services/payments/hosted-choice';
import { hasGatewayHistory } from '../src/services/demo-reset';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext(); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

it('a deposit link opens one bank checkout on its original branch and keeps the same invoice on a repeated click', async () => {
  const [park] = await ctx.db.select().from(branch).limit(1);
  const id = randomUUID();
  const key = randomUUID();
  const invoiceNo = 'SBXREVIEW0001';
  await ctx.db.insert(paymentAttempt).values({
    id, operatorId: park!.operatorId, branchId: park!.id, invoiceNo,
    method: 'qr', provider: '2c2p', status: 'sent_to_terminal', amountSatang: 100,
    businessDate: '2026-11-23', expiresAt: new Date(Date.now() + 60000),
    payload: { hostedChoice: { key, card: 'CARDS', qrMerchant: 'QRS', qrChannel: 'PPQR',
      description: 'ZZ TEST deposit', frontendReturnUrl: 'https://booking.invalid/return' } },
  });
  const gateway = new SimulatorQrPayment();
  const open = vi.spyOn(gateway, 'createHostedPayment').mockImplementation(async () => {
    await ctx.db.update(paymentAttempt).set({
      payload: sql`${paymentAttempt.payload} || jsonb_build_object('callbackSeen', true)`,
    }).where(eq(paymentAttempt.id, id));
    return {
      webPaymentUrl: 'https://bank.invalid/checkout', expiresAt: new Date(Date.now() + 60000),
      state: 'pending', respCode: '0000', respDesc: null,
    };
  });
  await expect(hostedChoicePage(ctx.db, id, randomUUID())).rejects.toThrow();
  expect((await hostedChoicePage(ctx.db, id, key)).amount).toBe(100);
  const choice = () => selectHostedMethod(ctx.db, gateway, id, key, 'card');
  const clicks = await Promise.allSettled([choice(), choice()]);
  expect(clicks.some(c => c.status === 'fulfilled')).toBe(true);
  await expect(choice()).resolves.toBe('https://bank.invalid/checkout');
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toMatchObject({ invoiceNo, childMerchantId: 'CARDS', paymentChannels: ['CC'] });
  await expect(selectHostedMethod(ctx.db, gateway, id, key, 'qr')).rejects.toThrow();
  const [saved] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id));
  expect(saved).toMatchObject({ status: 'sent_to_terminal', method: 'card', payload: { childMerchantId: 'CARDS', callbackSeen: true } });
  const events = await ctx.db.select({ action: auditLog.action, after: auditLog.after }).from(auditLog)
    .where(eq(auditLog.entityId, id));
  expect(events.sort((a, b) => a.action.localeCompare(b.action))).toEqual([
    { action: 'payment.hosted_link_ready', after: { method: 'card' } },
    { action: 'payment.hosted_method_selected', after: { method: 'card' } },
  ]);
  expect(await hasGatewayHistory(ctx.db)).toBe(true);
  await ctx.db.update(paymentAttempt).set({ status: 'cancelled' }).where(eq(paymentAttempt.id, id));
  await expect(choice()).rejects.toThrow();
});
