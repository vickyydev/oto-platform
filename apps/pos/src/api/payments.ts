import type { PaymentAttemptView } from '@oto/shared';
import { api } from './client';

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

/** Cloud payment routes. Local box payment transport is separate work. */
export const paymentsApi = {
  start: (body: PaymentStartBody) =>
    api.post<PaymentStartResult>(
      '/payments/attempts', body, writeOptions(`${body.saleId}:start`, body.actionId),
    ),
  read: (attemptId: string) =>
    api.get<PaymentAttemptRead>(`/payments/attempts/${encodeURIComponent(attemptId)}`),
  inquire: (attemptId: string, actionId: string) =>
    api.post<{ attempt: PaymentAttemptView }>(
      `/payments/attempts/${encodeURIComponent(attemptId)}/inquire`,
      undefined, writeOptions(`${attemptId}:inquire`, actionId),
    ),
  confirm: (attemptId: string, body: PaymentConfirmationBody, actionId: string) =>
    api.post<{ attempt: PaymentAttemptView }>(
      `/payments/attempts/${encodeURIComponent(attemptId)}/confirm`,
      body, writeOptions(`${attemptId}:confirm`, actionId),
    ),
  manual: (body: ManualPaymentBody) =>
    api.post<ManualPaymentResult>(
      '/payments/manual', body, writeOptions(`${body.saleId}:manual`, body.actionId),
    ),
};
