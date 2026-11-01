/**
 * Today's nannies (SCRUM-699): what the Console asks the API for, and what it
 * gets back.
 *
 * The routes are `apps/api/src/routes/nanny-duty.ts` and the shapes are
 * `NannyDutyView` and friends in `apps/api/src/services/nanny-duty.ts`. They
 * are restated here rather than imported, for the reason `boothApi.ts` gives:
 * the console does not depend on the api app, so a field added there is added
 * here by hand, and a field quietly renamed shows up as a type error on the
 * first read of this file rather than as an undefined on a screen.
 *
 * Every write carries an idempotency key, as every Console write does: the
 * api's idempotency plugin covers POST, PATCH and DELETE alike.
 */
import { api, ApiError, idemKey, isMissingRoute } from '@/api/client';

export { ApiError, isMissingRoute };

/** Where a nanny, or one of their shifts, came from. */
export type NannySource = 'seed' | 'app_schedule' | 'manual';

/** What the last sync found about the OTO App itself. */
export type NannyAppState = 'ok' | 'app_not_installed' | 'no_app_branch' | 'ambiguous_app_branch';

/** A nanny-matched shift on the rota that the sync could not turn into a nanny. */
export interface NannyUnmatched {
  /** Null when the rota names nobody the OTO App can put a name to. */
  name: string | null;
  reason: 'no_employee_row' | 'no_name' | 'casual_worker';
}

/** One shift of a nanny that overlaps the trading day. */
export interface NannyShiftView {
  id: string;
  source: NannySource;
  startsAt: string;
  endsAt: string;
  syncedAt: string | null;
  addedByAccountId: string | null;
}

/** One nanny of the park, as the till's picker sees them, with the day's shifts. */
export interface NannyRosterRow {
  id: string;
  name: string;
  source: NannySource;
  employeeId: string | null;
  /** On shift at `asOf`: the same answer the till gives. */
  onShift: boolean;
  /** Children checked in with this nanny now. */
  load: number;
  shifts: NannyShiftView[];
}

export interface NannyDutyLogLine {
  at: string;
  action: string;
  actorAccountId: string | null;
  detail: Record<string, unknown> | null;
}

export interface NannyDutyView {
  branchId: string;
  businessDate: string;
  timezone: string;
  /** The instant `onShift` was measured at. */
  asOf: string;
  rule: {
    /** Matched inside a shift row's role, group or department name. */
    matchText: string;
    /** Words that match whatever the match text says. */
    alsoMatches: string[];
  };
  nannies: NannyRosterRow[];
  lastSync: {
    syncedAt: string;
    appState: NannyAppState;
    unmatched: NannyUnmatched[];
    syncedByAccountId: string | null;
  } | null;
  /** The day's nanny_duty.* audit lines, newest first. */
  log: NannyDutyLogLine[];
}

export interface NannySyncResult {
  businessDate: string;
  appState: NannyAppState;
  added: number;
  removed: number;
  renamed: number;
  reshifted: number;
  unmatched: NannyUnmatched[];
}

export interface NannySyncAnswer {
  sync: NannySyncResult;
  view: NannyDutyView;
}

const at = (branchId: string) => `/branches/${encodeURIComponent(branchId)}/nannies`;

export const nannyApi = {
  today: (branchId: string, date?: string) =>
    api.get<NannyDutyView>(
      `${at(branchId)}/today${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    ),

  /** Read the OTO App's rota now and write today's nanny shifts to match it. */
  sync: (branchId: string) =>
    api.post<NannySyncAnswer>(`${at(branchId)}/sync`, undefined, { idempotencyKey: idemKey() }),

  /** A nanny for the day by hand: wall-clock times on the park's day; `to` at or before `from` ends the next day. */
  addManual: (branchId: string, input: { name: string; from: string; to: string; date?: string }) =>
    api.post<NannyDutyView>(`${at(branchId)}/manual`, input, { idempotencyKey: idemKey() }),

  /** Not started: deleted. In progress: cut short now. A finished shift stays. */
  removeShift: (branchId: string, shiftId: string) =>
    api.delete<NannyDutyView>(`${at(branchId)}/shifts/${encodeURIComponent(shiftId)}`, {
      idempotencyKey: idemKey(),
    }),

  saveRule: (branchId: string, matchText: string) =>
    api.patch<NannyDutyView>(`${at(branchId)}/rule`, { matchText }, { idempotencyKey: idemKey() }),
};
