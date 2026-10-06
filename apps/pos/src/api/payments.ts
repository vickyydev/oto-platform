import type { PaymentAttemptView } from '@oto/shared';
import { api } from './client';
import {
  boxSaleOfAttempt,
  confirmOnBox,
  inquireOnBox,
  laneSale,
  readOnBox,
  startOnBox,
} from './boxSales';

export interface PaymentQrMetadata {
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  expiryTimerMs: number | null;
}

export interface PaymentStartBody {
  saleId: string;
  actionId: string;
  amountSatang?: number;
  tender: 'card' | 'qr' | 'wallet';
  /** The configured token, not a token inferred from its kind. */
  method: string;
  kind: string;
  wallet?: string | null;
  qrDirection?: 'show' | 'scan';
  requestQrPayload?: boolean;
  cashier?: string | null;
}

export interface PaymentStartResult extends PaymentQrMetadata {
  route: 'card_terminal' | 'manual' | 'gateway';
  attempt: PaymentAttemptView | null;
  replayed: boolean;
  outstandingSatang: number;
}

export interface PaymentAttemptRead extends PaymentQrMetadata {
  attempt: PaymentAttemptView;
  deviceLabel: string | null;
  responseText: string | null;
  outstandingSatang: number | null;
}

export interface PaymentConfirmationBody {
  took: boolean;
  approvalCode?: string | null;
  tid?: string | null;
  last4?: string | null;
  note?: string | null;
}

export interface ManualPaymentBody {
  saleId: string;
  actionId: string;
  method: string;
  kind: string;
  amountSatang?: number;
  approvalCode: string;
  tid?: string | null;
  last4?: string | null;
  reference?: string | null;
}

export interface ManualPaymentResult {
  attempt: PaymentAttemptView;
  replayed: boolean;
  outstandingSatang: number;
}

// Keep one deliberate gesture's identity across retries. The client never
// mints a new identity when a previous request has an uncertain outcome.
const writeOptions = (scope: string, actionId: string) => ({
  idempotencyKey: `payment:${scope}:${actionId}`,
  headers: { 'x-oto-action-id': actionId },
});

/**
 * The payment routes. A sale rung up on the box lane (offline plan Round 4)
 * takes its card and its PAX QR on the counter's own terminal through the box,
 * and every read, inquiry and confirmation of such a tender goes back to that
 * box (`api/boxSales.ts`). Everything else is the platform's.
 */
export const paymentsApi = {
  start: (body: PaymentStartBody): Promise<PaymentStartResult> => {
    const held = laneSale(body.saleId);
    if (held?.lane === 'box' && body.tender !== 'wallet') return startOnBox(held, body);
    return api.post<PaymentStartResult>(
      '/payments/attempts', body, writeOptions(`${body.saleId}:start`, body.actionId),
    );
  },
  read: (attemptId: string): Promise<PaymentAttemptRead> =>
    boxSaleOfAttempt(attemptId)
      ? readOnBox(attemptId)
      : api.get<PaymentAttemptRead>(`/payments/attempts/${encodeURIComponent(attemptId)}`),
  inquire: (attemptId: string, actionId: string) =>
    boxSaleOfAttempt(attemptId)
      ? inquireOnBox(attemptId, actionId)
      : api.post<{ attempt: PaymentAttemptView }>(
          `/payments/attempts/${encodeURIComponent(attemptId)}/inquire`,
          undefined, writeOptions(`${attemptId}:inquire`, actionId),
        ),
  confirm: (attemptId: string, body: PaymentConfirmationBody, actionId: string) =>
    boxSaleOfAttempt(attemptId)
      ? confirmOnBox(attemptId, body, actionId)
      : api.post<{ attempt: PaymentAttemptView }>(
          `/payments/attempts/${encodeURIComponent(attemptId)}/confirm`,
          body, writeOptions(`${attemptId}:confirm`, actionId),
        ),
  manual: (body: ManualPaymentBody) =>
    api.post<ManualPaymentResult>(
      '/payments/manual', body, writeOptions(`${body.saleId}:manual`, body.actionId),
    ),
};
