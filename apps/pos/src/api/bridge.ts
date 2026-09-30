import {
  STATION_BRIDGE_BASE,
  StationSessionDocumentSchema,
  type BridgeStatus,
  type BridgeUnlockRequest,
  type BridgeUnlockResponse,
  type StationIntent,
  type StationSessionDocument,
} from '@oto/shared';
import { ApiError, NetworkError } from './client';

/**
 * THE TILL'S SIDE OF THE STATION BRIDGE (offline plan §2.2, Round 3).
 *
 * `/box/v1/station/:stationId/*` is how a till reaches its box: the api
 * mounts it for a virtual box behind the platform session, a Raspberry Pi
 * serves it on the counter's LAN behind Caddy. One client for both, and the
 * difference is only where the requests go and what they carry:
 *
 *   - a VIRTUAL box answers on this page's own origin, under `/api`, and the
 *     session cookie is the credential (OD-2);
 *   - a PI answers on its own HTTPS origin on the LAN, and the credential is
 *     the box session its bridge issued at unlock, carried as a bearer.
 *
 * Errors arrive in the platform's envelope, as `ApiError`, and a request that
 * reached nothing is a `NetworkError` — the same two facts the rest of the
 * till already tells apart.
 */

let origin: string | null = null;
let boxSession: string | null = null;

/**
 * Where this till's box answers: null for this page's own origin (a virtual
 * box), or a Pi's LAN origin once the platform names one.
 */
export function setBridgeOrigin(value: string | null): void {
  origin = value ? value.replace(/\/$/, '') : null;
}

/** The box session from the last unlock, held in memory only: a lock or a reload ends it. */
export function holdBoxSession(value: string | null): void {
  boxSession = value;
}

export function bridgeUrl(stationId: string, rest: string): string {
  const path = `${STATION_BRIDGE_BASE}/${encodeURIComponent(stationId)}/${rest}`;
  return origin ? `${origin}${path}` : `/api${path}`;
}

async function request<T>(
  method: 'GET' | 'POST',
  stationId: string,
  rest: string,
  body?: unknown,
  opts: { bearer?: string | null; signal?: AbortSignal; actionId?: string } = {},
): Promise<T> {
  const bearer = opts.bearer !== undefined ? opts.bearer : boxSession;
  let res: Response;
  try {
    res = await fetch(bridgeUrl(stationId, rest), {
      method,
      // The platform cookie on a virtual box; nothing ambient on a Pi.
      credentials: origin ? 'omit' : 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(opts.actionId ? { 'x-oto-action-id': opts.actionId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
  const data = (await res.json().catch(() => null)) as {
    error?: { code: string; message: string; details?: unknown };
  } | null;
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 423) window.dispatchEvent(new CustomEvent('oto:session-locked'));
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return data as T;
}

export interface BridgeIntentAnswer<R = Record<string, unknown>> {
  document: StationSessionDocument;
  result?: R;
}

export const bridgeApi = {
  status: (stationId: string, signal?: AbortSignal) =>
    request<BridgeStatus>('GET', stationId, 'status', undefined, { signal }),
  /**
   * Unlock through the box (OD-2). The answer's session is held for the
   * calls that follow, which is what a Pi needs; a virtual box also accepts
   * the platform cookie.
   */
  unlock: async (stationId: string, body: BridgeUnlockRequest): Promise<BridgeUnlockResponse> => {
    const answer = await request<BridgeUnlockResponse>('POST', stationId, 'unlock', body, {
      bearer: null,
    });
    holdBoxSession(answer.session);
    return answer;
  },
  lock: async (stationId: string): Promise<void> => {
    const held = boxSession;
    holdBoxSession(null);
    if (held) await request('POST', stationId, 'lock', {}, { bearer: held }).catch(() => undefined);
  },
  lookup: (stationId: string, phone: string) =>
    request<{ member: Record<string, unknown> | null }>(
      'GET',
      stationId,
      `members/lookup?phone=${encodeURIComponent(phone)}`,
    ),
  intent: <R = Record<string, unknown>>(
    stationId: string,
    type: string,
    payload: Record<string, unknown>,
    opts: { actionId?: string; lastSeenSequence?: number; leaseId?: string | null } = {},
  ) =>
    request<BridgeIntentAnswer<R>>(
      'POST',
      stationId,
      'intents',
      {
        type,
        payload,
        lastSeenSequence: opts.lastSeenSequence ?? 0,
        ...(opts.leaseId ? { leaseId: opts.leaseId } : {}),
        ...(opts.actionId ? { actionId: opts.actionId.slice(0, 64) } : {}),
      },
      { actionId: opts.actionId },
    ),
  /** The publisher's calls (`lib/displaySession.ts`): the lease, the document, an intent. */
  session: (stationId: string) =>
    request<{ document: StationSessionDocument }>('GET', stationId, 'session'),
  lease: (stationId: string, holder: string) =>
    request<{ lease: { leaseId: string }; document: StationSessionDocument }>(
      'POST',
      stationId,
      'lease',
      { holder },
    ),
  renew: (stationId: string, leaseId: string) =>
    request<{ document: StationSessionDocument }>('POST', stationId, 'lease/renew', { leaseId }),
  release: (stationId: string, leaseId: string) =>
    request<{ released: boolean }>('POST', stationId, 'lease/release', { leaseId }),
  publish: (stationId: string, intent: StationIntent) =>
    request<{ document: StationSessionDocument }>('POST', stationId, 'intents', intent),
};

/**
 * THE CUSTOMER DISPLAY'S SIDE (OD-10): the paired credential, never the staff
 * session, and never a cookie.
 */
export const displayBridgeApi = {
  session: async (stationId: string, bearer: string, signal?: AbortSignal) => {
    const answer = await request<{
      station: { id: string; name: string; kind: string };
      device: { id: string; name: string };
      document: StationSessionDocument;
    }>('GET', stationId, 'display/session', undefined, { bearer, signal });
    return { ...answer, document: StationSessionDocumentSchema.parse(answer.document) };
  },
  intent: async (
    stationId: string,
    bearer: string,
    intent: StationIntent,
    signal?: AbortSignal,
  ) => {
    const answer = await request<{ document: StationSessionDocument }>(
      'POST',
      stationId,
      'display/intents',
      intent,
      { bearer, signal },
    );
    return { document: StationSessionDocumentSchema.parse(answer.document) };
  },
};
