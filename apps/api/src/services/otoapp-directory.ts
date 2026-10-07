import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env';

/**
 * THE POS'S ONLY WAY TO WRITE TO THE OTO APP — its directory API (events-kiosk
 * PLAN §8 round 0, S2-20 E2).
 *
 * The OTO App is the master of every event registration (conflict C10, Q1).
 * When a till adds a walk-up or sells an event pass, the child is added there
 * with `POST /api/directory/events/:id/attendees`, authenticated by a key the
 * app issued to this api for ONE tenant (`directory_clients`), so the tenant a
 * write lands in is the key's and never the request's. Every call carries the
 * attendee id the till minted: the app looks it up first, so a retry after a
 * lost answer — or a press of Retry on the Failures page — is a replay there,
 * never a second child.
 *
 * S2-20 E4 adds `POST /api/directory/events/:id/edits`: a party's own fields
 * as a till edited them, carrying the edit's id and the moment it was made, so
 * the app can refuse an edit older than its own latest change.
 *
 * Nothing here reads or writes a database. The POS reads the app's state back
 * through the app's published views, in the one read-only repository
 * (`otoapp-events.ts`), and the H1 grep holds every file in `src` to that.
 *
 * What a call can come back as, and what the caller does with it:
 *
 *   - ok — the attendee the app holds (made now, replayed, or merged into a
 *     registration the app already had under the same name and phone);
 *   - refused — a 4xx the app chose to answer (an event it no longer has, an
 *     id it holds for another child, a body it will not take). Repeating the
 *     same call gets the same answer, so it is not retried by itself;
 *   - unavailable — no answer, a timeout, a 5xx, a 429, or this deployment has
 *     no directory configured. A retry may well succeed.
 */

/** The child, as the app's directory takes it (`attendeeBodySchema`, the app's eventRoutes.ts). */
export interface DirectoryAttendeeBody {
  id: string;
  childFullName: string;
  dateOfBirth?: string | null;
  ageYears?: number | null;
  primaryLanguage?: string | null;
  allergies?: string | null;
  foodRestrictions?: string | null;
  parentName?: string | null;
  parentPhone?: string | null;
  parentAttending: boolean;
  attendanceDays: string[];
  notes?: string | null;
  bookingId?: string | null;
  source: 'pos' | 'booking' | 'kiosk';
  createdBy?: string | null;
}

/** What the app answers with (`AttendeeResult`, the app's eventWrites.ts). */
export interface DirectoryAttendeeAnswer {
  attendee: {
    id: string;
    eventId: string;
    recordKind: 'camp_registration' | 'event_attendee';
    childName: string;
    parentName: string | null;
    parentPhone: string | null;
    parentAttending: boolean;
    attendanceDays: string[];
    createdAt: string;
  };
  replayed: boolean;
  merged: boolean;
}

/**
 * S2-20 E3 — a check-in, as the app's directory takes it (`checkinBodySchema`,
 * the app's eventRoutes.ts): the POS's own check-in id, the branch's business
 * date, when it happened and who did it.
 */
export interface DirectoryCheckinBody {
  id: string;
  date: string;
  checkedInAt?: string | null;
  checkedInBy?: string | null;
}

/** What the app answers a check-in with (`CheckinResult`, the app's eventWrites.ts). */
export interface DirectoryCheckinAnswer {
  checkin: {
    id: string;
    checkinRef: string | null;
    attendeeId: string;
    eventId: string;
    date: string;
    status: 'waiting' | 'checked_in' | 'checked_out';
    checkedInAt: string | null;
    checkedInBy: string | null;
  };
  replayed: boolean;
}

export type DirectoryOutcome<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      /** The HTTP status, or null when nothing answered. */
      status: number | null;
      /** Short and non-leaking: the app's own error code, or ours for no answer. */
      code: string;
      message: string;
      /** False only for a refusal the app chose; a retry of it gets the same answer. */
      retryable: boolean;
    };

/**
 * S2-20 E4 — a party's own fields as a till edited them, in the app's words
 * (`editBodySchema`, the app's eventRoutes.ts). Money is whole baht, as the app
 * keeps it.
 */
export interface DirectoryEventEditFields {
  title?: string;
  status?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string | null;
  location?: string | null;
  numChildren?: number | null;
  numAdults?: number | null;
  childName?: string | null;
  kidTurningAge?: number | null;
  parentName?: string | null;
  whatsappPhone?: string | null;
  decoration?: string | null;
  activities?: string | null;
  totalValueThb?: number | null;
  prepaymentAmountThb?: number | null;
  prepaymentDate?: string | null;
}

/** `POST /api/directory/events/:id/edits` — the edit's own id, and when it was made at the till. */
export interface DirectoryEventEditBody {
  id: string;
  editedAt: string;
  fields: DirectoryEventEditFields;
}

/** What the app answers with (`EventEditResult`, the app's eventWrites.ts). */
export interface DirectoryEventEditAnswer {
  edit: { id: string; eventId: string; editedAt: string; fields: string[] };
  event: Record<string, unknown> & { id: string; updatedAt: string };
  replayed: boolean;
}

export interface OtoAppDirectory {
  /** Whether this deployment has a directory to call at all. */
  readonly configured: boolean;
  addAttendee(eventId: string, body: DirectoryAttendeeBody): Promise<DirectoryOutcome<DirectoryAttendeeAnswer>>;
  /**
   * S2-20 E4 — write a till's party edit back. Optional so a directory built
   * before E4 (a test's stub) still types; one without it is answered as
   * "not configured", and the edit waits as pending.
   */
  editEvent?(eventId: string, body: DirectoryEventEditBody): Promise<DirectoryOutcome<DirectoryEventEditAnswer>>;
  /**
   * S2-20 E3 — check an attendee in for a day:
   * `POST /api/directory/events/:id/attendees/:attendeeId/checkins`. The body
   * carries the POS's check-in id, so a retry is a replay in the app.
   */
  checkinAttendee(
    eventId: string,
    attendeeId: string,
    body: DirectoryCheckinBody,
  ): Promise<DirectoryOutcome<DirectoryCheckinAnswer>>;
}

/** Said when this deployment has no directory: the write waits, it is not lost. */
export const DIRECTORY_NOT_CONFIGURED = 'OTOAPP_DIRECTORY_NOT_CONFIGURED';
/** Said when nothing answered in time. */
export const DIRECTORY_UNREACHABLE = 'OTOAPP_DIRECTORY_UNREACHABLE';

const MAX_MESSAGE = 300;

/** The app answers `{ error, message }`; anything else is said as its status. */
function refusalOf(status: number, payload: unknown): { code: string; message: string } {
  const body = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; message?: unknown };
  const raw = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : `HTTP_${status}`;
  // The app's codes are snake_case words ("event_not_found") or short phrases
  // ("Validation error"); either becomes one upper-case token.
  const code = `OTOAPP_${raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}`.slice(0, 80);
  const message =
    typeof body.message === 'string' && body.message.trim()
      ? body.message.trim().slice(0, MAX_MESSAGE)
      : `The OTO App answered ${status}`;
  return { code, message };
}

/**
 * The directory, over HTTP. A deployment with no URL or no key answers every
 * call `unavailable` without making one — the caller records the child as
 * pending, which is the truth.
 */
export function buildOtoAppDirectory(
  env: Pick<Env, 'OTOAPP_DIRECTORY_URL' | 'OTOAPP_DIRECTORY_KEY' | 'OTOAPP_DIRECTORY_TIMEOUT_MS'>,
  log?: FastifyBaseLogger,
  fetchImpl: typeof fetch = fetch,
): OtoAppDirectory {
  const origin = env.OTOAPP_DIRECTORY_URL.replace(/\/+$/, '');
  const key = env.OTOAPP_DIRECTORY_KEY;
  const configured = Boolean(origin && key);

  /**
   * One POST to the directory, and what came of it. `readable` says whether a
   * 2xx carries what the caller needs; one that does not is a fault to retry.
   */
  async function post<T>(
    path: string,
    body: unknown,
    readable: (answer: unknown) => answer is T,
    missing: string,
    notConfigured: string,
  ): Promise<DirectoryOutcome<T>> {
    if (!configured) {
      return { ok: false, status: null, code: DIRECTORY_NOT_CONFIGURED, message: notConfigured, retryable: true };
    }
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.OTOAPP_DIRECTORY_TIMEOUT_MS),
      });
    } catch (err) {
      // The key never reaches a log line; the error's name and the host do.
      log?.warn({ err: (err as Error)?.name, host: new URL(origin).host }, 'otoapp directory unreachable');
      return {
        ok: false,
        status: null,
        code: DIRECTORY_UNREACHABLE,
        message: 'The OTO App did not answer',
        retryable: true,
      };
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (res.ok) {
      if (!readable(payload)) {
        return { ok: false, status: res.status, code: 'OTOAPP_UNREADABLE_ANSWER', message: missing, retryable: true };
      }
      return { ok: true, status: res.status, body: payload };
    }
    const refusal = refusalOf(res.status, payload);
    return {
      ok: false,
      status: res.status,
      ...refusal,
      retryable: res.status >= 500 || res.status === 429 || res.status === 408,
    };
  }

  return {
    configured,
    addAttendee(eventId, body) {
      return post(
        `/api/directory/events/${encodeURIComponent(eventId)}/attendees`,
        body,
        (answer): answer is DirectoryAttendeeAnswer => !!(answer as Partial<DirectoryAttendeeAnswer> | null)?.attendee?.id,
        'The OTO App answered without the attendee',
        'This deployment has no OTO App directory configured, so the child was not written there yet',
      );
    },
    checkinAttendee(eventId, attendeeId, body) {
      return post(
        `/api/directory/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(attendeeId)}/checkins`,
        body,
        (answer): answer is DirectoryCheckinAnswer => !!(answer as Partial<DirectoryCheckinAnswer> | null)?.checkin?.id,
        'The OTO App answered without the check-in',
        'This deployment has no OTO App directory configured, so the check-in was not written there yet',
      );
    },
    async editEvent(eventId, body) {
      if (!configured) {
        return {
          ok: false,
          status: null,
          code: DIRECTORY_NOT_CONFIGURED,
          message: 'This deployment has no OTO App directory configured, so the edit was not written there yet',
          retryable: true,
        };
      }
      const url = `${origin}/api/directory/events/${encodeURIComponent(eventId)}/edits`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(env.OTOAPP_DIRECTORY_TIMEOUT_MS),
        });
      } catch (err) {
        log?.warn({ err: (err as Error)?.name, host: new URL(origin).host }, 'otoapp directory unreachable');
        return {
          ok: false,
          status: null,
          code: DIRECTORY_UNREACHABLE,
          message: 'The OTO App did not answer',
          retryable: true,
        };
      }
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      if (res.ok) {
        const answer = payload as Partial<DirectoryEventEditAnswer> | null;
        if (!answer?.edit?.id || !answer.event?.id) {
          return {
            ok: false,
            status: res.status,
            code: 'OTOAPP_UNREADABLE_ANSWER',
            message: 'The OTO App answered without the edit',
            retryable: true,
          };
        }
        return { ok: true, status: res.status, body: answer as DirectoryEventEditAnswer };
      }
      const refusal = refusalOf(res.status, payload);
      return {
        ok: false,
        status: res.status,
        ...refusal,
        retryable: res.status >= 500 || res.status === 429 || res.status === 408,
      };
    },
  };
}
