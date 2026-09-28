import { eq } from 'drizzle-orm';
import { sale, station, type Db } from '@oto/db';
import { PaymentRoutingSchema, type PaymentAttemptView } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../../env';
import { errors } from '../../lib/errors';
import { withTx, type OpContext } from '../tx';
import { findAttemptByAction, outstandingAfter } from './attempt';
import { openQrAttempt, type OpenQrAttemptInput } from './gateway';
import {
  readAttempt,
  startTerminalTender,
  type StartTenderInput,
  type TenderActor,
} from './terminal';

export interface StartPaymentResult {
  route: 'card_terminal' | 'manual' | 'gateway';
  attempt: PaymentAttemptView | null;
  replayed: boolean;
  outstandingSatang: number;
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  expiryTimerMs: number | null;
}

const NO_QR = { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null };

/** Choose the station's route; gateway network calls follow the committed attempt. */
export async function startPaymentTender(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  ctx: OpContext,
  actor: TenderActor,
  input: StartTenderInput,
): Promise<StartPaymentResult> {
  // Only the route's final response is cached, never an intermediate routing or QR write.
  const operationCtx = { ...ctx, idempotency: undefined };
  const plan = await withTx(
    db,
    operationCtx,
    'payment.tender.start',
    async (
      tx,
    ): Promise<
      | { route: 'gateway'; input: OpenQrAttemptInput }
      | { route: 'started'; result: StartPaymentResult }
    > => {
      const [row] = await tx
        .select()
        .from(sale)
        .where(eq(sale.id, input.saleId))
        .for('update')
        .limit(1);
      if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
      await actor.assertBranchAllowed(row.branchId);

      const tender = input.tender ?? 'card';
      const methodCode = input.methodCode ?? (tender === 'card' ? 'card' : 'promptpay');
      const existing = input.actionId
        ? await findAttemptByAction(tx, actor.operatorId, input.actionId)
        : null;
      if (existing) {
        const normalise = (code: string) => (code === 'credit_card' ? 'card' : code);
        const previous = (existing.payload ?? {}) as { tender?: string };
        if (
          existing.saleId !== row.id ||
          existing.method !== (tender === 'card' ? 'card' : 'qr') ||
          normalise(existing.methodCode ?? existing.method) !== normalise(methodCode) ||
          (input.amountSatang !== undefined && existing.amountSatang !== input.amountSatang) ||
          (previous.tender !== undefined && previous.tender !== tender)
        ) {
          throw errors.conflict(
            'ACTION_ID_REUSED',
            'That action id already recorded a different tender',
          );
        }
        const read = await readAttempt(tx, actor.operatorId, existing.id);
        return {
          route: 'started',
          result: {
            route: existing.deviceId
              ? 'card_terminal'
              : existing.invoiceNo && existing.method === 'qr'
                ? 'gateway'
                : 'manual',
            attempt: read.attempt,
            replayed: true,
            outstandingSatang: read.outstandingSatang ?? 0,
            qrPayload: read.qrPayload,
            qrImageUrl: read.qrImageUrl,
            expiresAt: read.expiresAt,
            expiryTimerMs: read.expiryTimerMs,
          },
        };
      }

      const [st] = await tx.select().from(station).where(eq(station.id, row.stationId)).limit(1);
      if (
        !st ||
        st.operatorId !== row.operatorId ||
        st.branchId !== row.branchId ||
        st.archivedAt
      ) {
        throw errors.badRequest('This sale names a station that is no longer available');
      }
      const routing = PaymentRoutingSchema.safeParse(st.paymentRouting ?? {});
      if (tender === 'qr' && routing.success) {
        if (routing.data.qr === 'none') {
          throw errors.conflict(
            'QR_DISABLED_FOR_STATION',
            'This counter is not set up to take QR payments',
          );
        }
        if (routing.data.qr === 'gateway') {
          return {
            route: 'gateway',
            input: {
              operatorId: row.operatorId,
              branchId: row.branchId,
              saleId: row.id,
              stationId: row.stationId,
              businessDate: row.businessDate,
              amountSatang: input.amountSatang ?? (await outstandingAfter(tx, row)),
              methodCode,
              kind: input.kind ?? 'qr',
              actionId: input.actionId ?? null,
              accountId: actor.accountId,
            },
          };
        }
      }
      const result = await startTerminalTender(tx, actor, input);
      return { route: 'started', result: { ...result, ...NO_QR } };
    },
  );
  if (plan.route === 'started') return plan.result;

  const result = await openQrAttempt(db, env, log, operationCtx, plan.input);
  const read = await readAttempt(db, actor.operatorId, result.attempt.id);
  return {
    route: 'gateway',
    attempt: read.attempt,
    replayed: result.replay,
    outstandingSatang: read.outstandingSatang ?? 0,
    qrPayload: read.qrPayload,
    qrImageUrl: read.qrImageUrl,
    expiresAt: read.expiresAt,
    expiryTimerMs: read.expiryTimerMs,
  };
}
