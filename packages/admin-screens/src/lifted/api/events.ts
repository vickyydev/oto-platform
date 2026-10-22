import type { ApiResponse } from '@oto/api-types';
import type {EventDropInPricing} from '@oto/shared';
import type { AdminApi } from '../../api/admin-api';


/** A till with no platform branch, in the counter's words (like the check-in board's). */
export const EVENTS_NOT_LINKED =
  "This till isn't linked to a park on the platform, so it has no events to show. Sign out and back in, or ask an administrator.";
export function createEventsAdminApi(api: AdminApi) {
const eventsApi = {
  dropInPricing: (branchId: string) =>
    api.get<ApiResponse<'/branches/{branchId}/event-drop-in-pricing', 'get'>>(`/branches/${encodeURIComponent(branchId)}/event-drop-in-pricing`),
  saveDropInPricing: (branchId: string, pricing: EventDropInPricing) =>
    api.put<ApiResponse<'/branches/{branchId}/event-drop-in-pricing', 'put'>>(`/branches/${encodeURIComponent(branchId)}/event-drop-in-pricing`, pricing),
};
return {eventsApi,EVENTS_NOT_LINKED};
}
