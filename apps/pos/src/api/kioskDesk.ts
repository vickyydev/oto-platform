import { KioskDeskAnswerSchema, type KioskDeskAnswer } from '@oto/shared';
import { api } from './client';

/**
 * S2-20 K2 — THE STAFF DESK'S VIEW OF THE SELF-SERVICE KIOSK: the families a
 * kiosk sent to the desk today, with their booking and what is left to do
 * (`GET /kiosk-desk`, staff session, `pos:booking:read` at the branch).
 * Parsed against the shared schema, so the till draws exactly what the
 * contract carries: a reference and counts, never a child or an allergy.
 */
export const kioskDeskApi = {
  list: async (branchId: string): Promise<KioskDeskAnswer> =>
    KioskDeskAnswerSchema.parse(await api.get<unknown>(`/kiosk-desk?branchId=${encodeURIComponent(branchId)}`)),
};
