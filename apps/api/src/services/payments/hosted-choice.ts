import { and, eq, gt } from 'drizzle-orm';
import { paymentAttempt, type Db } from '@oto/db';
import { WEB_INVOICE_STATION_CODE } from '@oto/shared';
import type { QrPayment } from '@oto/payments-2c2p';
import { z } from 'zod';
import { errors } from '../../lib/errors';
import type { AttemptRow } from './attempt';

const choiceSchema = z.object({
  key: z.string().uuid(), card: z.string(), qrMerchant: z.string(), qrChannel: z.string(),
  description: z.string(), frontendReturnUrl: z.string(), locale: z.string().optional(),
});
type PayMethod = 'card' | 'qr';

function readChoice(row: AttemptRow | undefined, key: string) {
  const payload = (row?.payload ?? {}) as Record<string, unknown>;
  const parsed = choiceSchema.safeParse(payload.hostedChoice);
  if (!row || row.provider !== '2c2p' || row.status !== 'sent_to_terminal' ||
      !row.expiresAt || row.expiresAt.getTime() <= Date.now() || !row.invoiceNo ||
      !parsed.success || parsed.data.key !== key) {
    throw errors.notFound('Payment link');
  }
  return { choice: parsed.data, payload, expiresAt: row.expiresAt, invoiceNo: row.invoiceNo };
}

export async function hostedChoicePage(db: Db, id: string, key: string) {
  const [row] = await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id)).limit(1);
  const { payload } = readChoice(row, key);
  return { amount: row!.amountSatang, method: payload.chosenMethod };
}

export async function selectHostedMethod(db: Db, qr: QrPayment, id: string, key: string, method: PayMethod) {
  const claimed = await db.transaction(async tx => {
    const [row] = await tx.select().from(paymentAttempt).where(eq(paymentAttempt.id, id)).for('update');
    const { choice, payload, expiresAt, invoiceNo } = readChoice(row, key);
    if (payload.chosenMethod) {
      if (payload.chosenMethod === method && typeof payload.bankPaymentUrl === 'string') {
        return { existingUrl: payload.bankPaymentUrl };
      }
      throw errors.conflict('PAYMENT_METHOD_SELECTED', 'A payment method has already been selected. Reopen the payment link.');
    }
    const childMerchantId = method === 'card' ? choice.card : choice.qrMerchant;
    const routed = { ...payload, childMerchantId, chosenMethod: method };
    await tx.update(paymentAttempt).set({
      method, methodCode: method === 'card' ? 'card' : 'promptpay', payload: routed,
    }).where(eq(paymentAttempt.id, id));
    return { routed, request: {
      attemptId: id, invoiceNo, amountSatang: row!.amountSatang, childMerchantId,
      description: choice.description, frontendReturnUrl: choice.frontendReturnUrl,
      locale: choice.locale, paymentChannels: [method === 'card' ? 'CC' : choice.qrChannel],
      expiresAt, expiryMinutes: (expiresAt.getTime() - Date.now()) / 60_000,
      userDefined: { stationCode: WEB_INVOICE_STATION_CODE, businessDate: row!.businessDate },
    } };
  });
  if (claimed.existingUrl !== undefined) return claimed.existingUrl;
  const opened = await qr.createHostedPayment(claimed.request);
  if (!opened.webPaymentUrl) {
    throw errors.badRequest('The bank could not open this payment page. Please request a new link from the park.');
  }
  const [saved] = await db.update(paymentAttempt).set({
    payload: { ...claimed.routed, bankPaymentUrl: opened.webPaymentUrl, respCode: opened.respCode },
  }).where(and(eq(paymentAttempt.id, id), eq(paymentAttempt.status, 'sent_to_terminal'),
    gt(paymentAttempt.expiresAt, new Date()))).returning({ id: paymentAttempt.id });
  if (!saved) throw errors.notFound('Payment link');
  return opened.webPaymentUrl;
}
