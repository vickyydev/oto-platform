import type { PromoVoucherReport, VoucherTarget } from '@oto/shared';
import { api, idemKey } from './client';

/**
 * S2-14a round 5 — PROMOTIONAL VOUCHERS, from the back office's side: the
 * voucher definitions' promotional rules, campaigns, and the foregone-revenue
 * line. Every figure and every rule is the platform's
 * (`apps/api/src/services/voucher-promotions.ts`); this file only carries them.
 *
 *   definitions  `GET/PATCH /voucher-definitions` — admin:booth:read / manage
 *   campaigns    `GET/POST /voucher-campaigns`, the codes as a CSV download
 *   report       `GET /vouchers/promotions/report` — analytics:read
 */

/** A voucher definition as the back office edits its promotional rules. */
export interface VoucherDefinitionRow {
  id: string;
  code: string;
  nameEn: string;
  nameTh: string | null;
  kind: string;
  valueType: string;
  valueSatang: number | null;
  valueBp: number | null;
  productId: string | null;
  active: boolean;
  archivedAt: string | null;
  target: VoucherTarget | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  validFrom: string | null;
  validUntil: string | null;
  redeemedVouchers: number;
  unredeemedVouchers: number;
}

export interface VoucherPromoPatch {
  target?: VoucherTarget | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface VoucherCampaignRow {
  id: string;
  name: string;
  branchId: string;
  definitionId: string;
  definitionCode: string;
  quantity: number;
  redeemed: number;
  createdAt: string;
}

export const voucherPromotionsApi = {
  definitions: () => api.get<{ definitions: VoucherDefinitionRow[] }>('/voucher-definitions'),
  saveRules: (id: string, patch: VoucherPromoPatch) =>
    api.patch<{ definition: VoucherDefinitionRow }>(`/voucher-definitions/${encodeURIComponent(id)}`, patch, {
      idempotencyKey: idemKey(),
    }),
  campaigns: () => api.get<{ campaigns: VoucherCampaignRow[] }>('/voucher-campaigns'),
  /** One key per press: a retried press is the same batch, never a second. */
  mintCampaign: (
    body: { definitionId: string; branchId: string; name: string; quantity: number },
    idempotencyKey: string = idemKey(),
  ) => api.post<{ campaign: VoucherCampaignRow }>('/voucher-campaigns', body, { idempotencyKey }),
  /** Where the browser downloads a campaign's codes (a GET with the session cookie). */
  codesHref: (campaignId: string) => `/api/voucher-campaigns/${encodeURIComponent(campaignId)}/codes`,
  report: (params: { branchApiId?: string | null; from: string; to: string }) => {
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if (params.branchApiId) q.set('branchId', params.branchApiId);
    return api.get<PromoVoucherReport>(`/vouchers/promotions/report?${q}`);
  },
};
