import type {
  HeldSalesAnswer,
  SaleHoldAnswer,
  SaleHoldBody,
  SaleResumeAnswer,
} from '@oto/shared';
import { api, idemKey } from './client';

/**
 * SCRUM-774 — the till's Held sales: park the sale on the payment screen
 * (`Hold sale` / `Save as partly paid`), read the branch's list, and take a
 * held sale back to this till. Online only: the platform refuses each press
 * that cannot be made with its reason, and the till shows that reason.
 *
 * Each press carries its own action id in the body and in `x-oto-action-id`,
 * so a retry after a lost answer is the same press — the platform answers the
 * hold or the resume it already made.
 */
export const heldSalesApi = {
  list: (branchId: string) =>
    api.get<HeldSalesAnswer>(`/sales/held?branchId=${encodeURIComponent(branchId)}`),
  hold: (saleId: string, body: SaleHoldBody & { actionId: string }) =>
    api.post<SaleHoldAnswer>(`/sales/${encodeURIComponent(saleId)}/hold`, body, {
      idempotencyKey: `hold:${saleId}:${body.actionId}`,
      headers: { 'x-oto-action-id': body.actionId },
    }),
  resume: (saleId: string, actionId: string = idemKey()) =>
    api.post<SaleResumeAnswer>(`/sales/${encodeURIComponent(saleId)}/resume`, { actionId }, {
      idempotencyKey: `resume:${saleId}:${actionId}`,
      headers: { 'x-oto-action-id': actionId },
    }),
};
