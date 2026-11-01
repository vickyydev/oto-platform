/**
 * Today's nannies (SCRUM-699): what the Console asks the API for, and what it
 * gets back.
 *
 * The routes are `apps/api/src/routes/nanny-duty.ts`, and every shape below is
 * taken from the api's own description through `@oto/api-types`, so a field
 * the api renames or drops fails this app's typecheck rather than showing as
 * an undefined on a screen. The names stay the ones the card imports.
 *
 * Every write carries an idempotency key, as every Console write does: the
 * api's idempotency plugin covers POST, PATCH and DELETE alike.
 */
import type { ApiBody, ApiResponse } from '@oto/api-types';
import { api, ApiError, idemKey, isMissingRoute } from '@/api/client';

export { ApiError, isMissingRoute };

/** The day's nannies: `GET /branches/:id/nannies/today`, and the answer of every write but sync. */
export type NannyDutyView = ApiResponse<'/branches/{id}/nannies/today', 'get'>;

/** One nanny of the park, as the till's picker sees them, with the day's shifts. */
export type NannyRosterRow = NannyDutyView['nannies'][number];

/** One shift of a nanny that overlaps the trading day. */
export type NannyShiftView = NannyRosterRow['shifts'][number];

/** Where a nanny, or one of their shifts, came from. */
export type NannySource = NannyRosterRow['source'];

export type NannyDutyLogLine = NannyDutyView['log'][number];

type LastSync = NonNullable<NannyDutyView['lastSync']>;

/** What the last sync found about the OTO App itself. */
export type NannyAppState = LastSync['appState'];

/** A nanny-matched shift on the rota that the sync could not turn into a nanny. */
export type NannyUnmatched = LastSync['unmatched'][number];

export type NannySyncAnswer = ApiResponse<'/branches/{id}/nannies/sync', 'post'>;

export type NannySyncResult = NannySyncAnswer['sync'];

const at = (branchId: string) => `/branches/${encodeURIComponent(branchId)}/nannies`;

export const nannyApi = {
  today: (branchId: string, date?: string) =>
    api.get<ApiResponse<'/branches/{id}/nannies/today', 'get'>>(
      `${at(branchId)}/today${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    ),

  /** Read the OTO App's rota now and write today's nanny shifts to match it. */
  sync: (branchId: string) =>
    api.post<ApiResponse<'/branches/{id}/nannies/sync', 'post'>>(`${at(branchId)}/sync`, undefined, {
      idempotencyKey: idemKey(),
    }),

  /** A nanny for the day by hand: wall-clock times on the park's day; `to` at or before `from` ends the next day. */
  addManual: (branchId: string, input: ApiBody<'/branches/{id}/nannies/manual', 'post'>) =>
    api.post<ApiResponse<'/branches/{id}/nannies/manual', 'post'>>(`${at(branchId)}/manual`, input, {
      idempotencyKey: idemKey(),
    }),

  /** Not started: deleted. In progress: cut short now. A finished shift stays. */
  removeShift: (branchId: string, shiftId: string) =>
    api.delete<ApiResponse<'/branches/{id}/nannies/shifts/{shiftId}', 'delete'>>(
      `${at(branchId)}/shifts/${encodeURIComponent(shiftId)}`,
      { idempotencyKey: idemKey() },
    ),

  saveRule: (branchId: string, matchText: string) =>
    api.patch<ApiResponse<'/branches/{id}/nannies/rule', 'patch'>>(
      `${at(branchId)}/rule`,
      { matchText },
      { idempotencyKey: idemKey() },
    ),
};
