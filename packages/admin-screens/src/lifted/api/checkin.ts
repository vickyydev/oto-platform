import type { DropOffPricingConfig, SupervisionPolicy, SupervisionRequirement } from '@oto/shared';
import type { LiftedAdminApi } from '../../api/lifted-api';


export interface ApiNanny {
  id: string;
  name: string;
  onShift: boolean;
  load: number;
  coveredNames: string[];
}


export interface ApiSupervisionConfig {
  policy: SupervisionPolicy;
  pricing: DropOffPricingConfig;
  photoRetentionDays: number;
  nannies: ApiNanny[];
  /** The box's answer only: false while `CHILD_PHOTOS_ENABLED` is off on that box. Absent from the platform's. */
  photosEnabled?: boolean;
}


export interface PolicyBody {
  bands: { id: string; label: string; minAge: number; maxAge: number | null; requirement: SupervisionRequirement }[];
  siblingWaiver: { enabled: boolean; guardianMinAge: number; waivableRequirement: SupervisionRequirement; staffOnly: boolean };
}


export interface PricingBody {
  oneTimeFee: { weekday: number; weekend: number };
  nannyHourly: { weekday: number; weekend: number };
  extraHour: { weekday: number; weekend: number };
  fullDayHours: number;
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}


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
 const checkinApi = {config: (branchId:string) => api.get<ApiSupervisionConfig>(`/checkin/config?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`)};
 const boardApi = {
  savePolicy: (branchId: string, body: PolicyBody) =>
    api.put<ApiSupervisionConfig>(
      `/checkin/config/policy?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      body,
    ),

  saveConfirmations: (branchId: string, items: { id: string; text: string; required: boolean; order: number }[]) =>
    api.put<ApiSupervisionConfig>(
      `/checkin/config/confirmations?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      { items },
    ),

  savePricing: (branchId: string, body: PricingBody) =>
    api.put<ApiSupervisionConfig>(
      `/checkin/config/pricing?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      body,
    ),
 };
 return {checkinApi,boardApi,TILL_NOT_LINKED};
}
