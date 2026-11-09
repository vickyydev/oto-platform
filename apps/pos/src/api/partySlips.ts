// SCRUM-805 — A PARTY'S KITCHEN AND BAR SLIPS on the party page (birthday plan
// §5; the owner's decision 3 of 2026-11-09).
//
// The platform prints each party's kitchen slip and bar slip at its slip time,
// from the OTO App's set menu and bar plan, to the printers of the station the
// park names for them; until the park names one it records "no printer". The
// party page shows the slip time and each slip's state on the party's day, and
// "Print party slips now" prints them again:
//
//   GET  /parties/:id               the party, with `slips`
//   POST /parties/:id/slips/print   a new run of the party's slips

import type { ApiResponse } from '@oto/api-types';
import type { PartySlipRecordView, PartySlipsPrintAnswer, PartySlipsView } from '@oto/shared';
import type { PartyBooking } from '@/types';
import { apiBranchIdForSlug } from './catalogBridge';
import { api, ApiError, NetworkError } from './client';
import { EVENTS_NOT_LINKED } from './events';

/**
 * The party's slips on its day; null when there are none to show — a party the
 * OTO App has no plan for, a till not linked to the platform, no answer, or an
 * api from before the slips. The page then shows no slips block.
 */
export async function readPartySlipsOnPlatform(
  party: Pick<PartyBooking, 'id' | 'branchId'>,
): Promise<PartySlipsView | null> {
  const branchId = apiBranchIdForSlug(party.branchId);
  if (!branchId) return null;
  try {
    // An api from before the slips answers without them: read as none.
    const answer: { slips?: PartySlipsView | null } | null = await api.get<ApiResponse<'/parties/{id}', 'get'>>(
      `/parties/${encodeURIComponent(party.id)}?branchId=${branchId}`,
    );
    return answer && typeof answer === 'object' && answer.slips ? answer.slips : null;
  } catch {
    return null;
  }
}

export type PartySlipsPrintOutcome =
  | { ok: true; answer: PartySlipsPrintAnswer }
  | { ok: false; message: string; retryable: boolean };

/**
 * "Print party slips now": a new run, under the action id of this press — the
 * same id again (a retry of a press nothing answered) answers the run it made.
 */
export async function printPartySlipsOnPlatform(args: {
  party: Pick<PartyBooking, 'id' | 'branchId'>;
  actionId: string;
}): Promise<PartySlipsPrintOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  try {
    const answer: PartySlipsPrintAnswer = await api.post<ApiResponse<'/parties/{id}/slips/print', 'post'>>(
      `/parties/${encodeURIComponent(args.party.id)}/slips/print`,
      { branchId, actionId: args.actionId },
      { idempotencyKey: `party-slips:${args.actionId}`, headers: { 'x-oto-action-id': args.actionId } },
    );
    return { ok: true, answer };
  } catch (err) {
    const retryable = err instanceof NetworkError || !(err instanceof ApiError) || err.status >= 500;
    return { ok: false, message: err instanceof Error ? err.message : String(err), retryable };
  }
}

/** What one slip's state reads as on the party page. */
export function partySlipWords(
  slip: PartySlipRecordView | null,
  station: PartySlipsView['station'],
  kind: 'kitchen' | 'bar',
): string {
  if (!slip) return 'Not printed yet';
  if (slip.status === 'printed') return `Printed ${slip.at}`;
  if (slip.status === 'nothing_to_print') return 'Nothing to print';
  return station ? `No ${kind} printer at ${station.name}` : 'No printer named for this park';
}
