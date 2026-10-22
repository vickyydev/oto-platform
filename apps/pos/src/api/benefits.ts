import type { ApiResponse } from '@oto/api-types';
import {createBenefitsAdminApi} from '@oto/admin-screens/lifted/api/benefits';
import {api,idemKey} from './client';
import {adminScreenApi} from './admin-screen-api';
export type * from '@oto/admin-screens/lifted/api/benefits';
export {profileFromApi,profileToApi,sameProfile,inForceOn} from '@oto/admin-screens/lifted/api/benefits';

const path = (s: string) => encodeURIComponent(s);

export const benefitsApi = {
 ...createBenefitsAdminApi(adminScreenApi),
  // --- At the F&B checkout (round 3) ---------------------------------------------
  /**
   * The scan dialog's check: who the QR names and whether they have anything
   * set up, refused in the prototype's words. No idempotency key: it writes
   * nothing, and the platform keeps none of its answers.
   */
  resolve: (code: string) =>
    api.post<ApiResponse<'/benefits/resolve', 'post'>>('/benefits/resolve', { code }),
  /**
   * Take the benefit off an order already rung up (before any money): its
   * free items and credit go back to the staff member, and the order is rung
   * up again without it.
   */
  removeFromSale: (saleId: string, idempotencyKey: string = idemKey()) =>
    api.delete<ApiResponse<'/sales/{id}/benefit', 'delete'>>(
      `/sales/${path(saleId)}/benefit`,
      undefined,
      { idempotencyKey },
    ),
};
