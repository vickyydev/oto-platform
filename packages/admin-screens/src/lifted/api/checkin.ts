import type { ApiBody, ApiResponse } from '@oto/api-types';
import type { LiftedAdminApi } from '../../api/lifted-api';


export type ApiSupervisionConfig = ApiResponse<'/checkin/config', 'get'>;
export type ApiNanny = ApiSupervisionConfig['nannies'][number];
export type PolicyBody = ApiBody<'/checkin/config/policy', 'put'>;
export type PricingBody = ApiBody<'/checkin/config/pricing', 'put'>;

/**
 * THE PARK, IN THE PLATFORM'S ID (round-1 fix, finding R1).
 *
 * The till's `useBranch().branch.id` is the CATALOGUE SLUG (`hkt-central`);
 * every `/checkin` route names the platform's branch row by its uuid, exactly
 * as the cart identity does through `apiBranchIdForSlug`. The first build
 * sent the slug, so every supervised walk-in was refused at Continue, the
 * roster was always empty and the waiting-bookings picker always errored.
 *
 * So the slug is mapped here, in one place, and a till with no platform
 * branch — a device still on the prototype's own setup — is refused in the
 * counter's words before anything is sent. `config` and `awaiting` refuse a
 * value that is not a uuid for the same reason: a slug can never again leave
 * this till as a branch id.
 */
export const TILL_NOT_LINKED =
  "This till isn't linked to a park on the platform, so nobody can be registered or checked in from it. Sign out and back in, or ask an administrator.";


const PLATFORM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function assertPlatformBranchId(branchId: string): string {
  if (!PLATFORM_ID.test(branchId)) throw new Error(TILL_NOT_LINKED);
  return branchId;
}
export function createCheckinAdminApi(api: LiftedAdminApi) {
 const checkinApi = {config: (branchId:string) => api.get<ApiResponse<'/checkin/config', 'get'>>(`/checkin/config?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`)};
 const boardApi = {
  savePolicy: (branchId: string, body: PolicyBody) =>
    api.put<ApiResponse<'/checkin/config/policy', 'put'>>(
      `/checkin/config/policy?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      body,
    ),

  saveConfirmations: (branchId: string, items: { id: string; text: string; required: boolean; order: number }[]) =>
    api.put<ApiResponse<'/checkin/config/confirmations', 'put'>>(
      `/checkin/config/confirmations?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      { items },
    ),

  savePricing: (branchId: string, body: PricingBody) =>
    api.put<ApiResponse<'/checkin/config/pricing', 'put'>>(
      `/checkin/config/pricing?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      body,
    ),
 };
 return {checkinApi,boardApi,TILL_NOT_LINKED};
}
