import {
  STATION_BRIDGE_BASE,
  trustedBoxBridgeOrigin,
  StationSessionDocumentSchema,
  StationScanMessageSchema,
  type StationScanEvent,
  type BridgeStatus,
  type BridgeUnlockRequest,
  type BridgeUnlockResponse,
  type StationIntent,
  type StationSessionDocument,
} from '@oto/shared';
import { ApiError, NetworkError } from './client';
import type { ApiResponse } from '@oto/api-types';

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
let sessionRevision = 0;
const sessionListeners = new Set<() => void>();
/**
 * SCRUM-780 — the unlocks on the wire. An online unlock opens the till on the
 * platform's answer and proves itself to the box beside it, so for a moment
 * the till is open and the box session is still being made. A read that
 * carries that session waits here for the box's answer instead of going out
 * without it and being told to unlock a till that is unlocking.
 */
const unlocksOnTheWire = new Set<Promise<void>>();

/**
 * SCRUM-503 — the refusals the BOX answered, so a note can name who said no.
 * Kept beside the errors rather than on them: an `ApiError` stays exactly the
 * error every caller already reads, and only a caller that asks learns that
 * this one came from the counter's box and not from the platform.
 */
const boxAnswers = new WeakSet<ApiError>();

/** Whether the counter's box, not the platform, gave this refusal. */
export function answeredByBox(err: unknown): boolean {
  return err instanceof ApiError && boxAnswers.has(err);
}

/**
 * Where this till's box answers: null for this page's own origin (a virtual
 * box), or a Pi's LAN origin once the platform names one.
 */
export function setBridgeOrigin(value: string | null): void {
  const next = trustedBoxBridgeOrigin(value, import.meta.env.VITE_BOX_BRIDGE_ZONE,
    import.meta.env.VITE_BOX_BRIDGE_ALLOW_LOOPBACK === 'true');
  if (next !== origin) holdBoxSession(null);
  origin = next;
}

/** Visible in station settings when this build refuses a configured box. */
export function bridgeConfigurationWarning(value: string | null | undefined): string | null {
  return value && !trustedBoxBridgeOrigin(value, import.meta.env.VITE_BOX_BRIDGE_ZONE,
    import.meta.env.VITE_BOX_BRIDGE_ALLOW_LOOPBACK === 'true')
    ? 'This till build cannot use the saved box address. Ask an administrator to configure its matching box DNS zone, then reload the till.' : null;
}

export function hasBridgeOrigin(): boolean { return origin !== null; }

/** The box session from the last unlock, held in memory only: a lock or a reload ends it. */
export function holdBoxSession(value: string | null): void {
  sessionRevision += 1;
  boxSession = value;
  for (const listener of sessionListeners) listener();
}

/** Prepare before platform authentication, invoke only after it succeeds. */
export function prepareConfiguredBridgeUnlock(stationId: string, body: BridgeUnlockRequest): () => Promise<void> {
  const revision = sessionRevision;
  const target = origin;
  return async () => {
    // A lock or scope change can also overtake the platform's answer, before
    // the local request has even started. It must not open that old session.
    if (!target || target !== origin || revision !== sessionRevision || !body.token || !body.password) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try { await bridgeApi.unlock(stationId, body, controller.signal); }
    catch { /* Platform authentication already succeeded; an unavailable box must not lock it out. */ }
    finally { clearTimeout(timer); }
  };
}

let staffName: string | null = null;

/**
 * Who is signed in at this till, as the receipt names them (Round 4). A till's
 * box holds no staff names (SCRUM-223), so a receipt it prints offline takes
 * the name from the till, which knows who is standing at it.
 */
export function setBridgeStaffName(value: string | null): void {
  staffName = value?.trim() || null;
}

export function bridgeStaffName(): string | null {
  return staffName;
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
      credentials: origin || rest.startsWith('display/') ? 'omit' : 'same-origin',
      cache: 'no-store',
      // A trusted box must not redirect the password to a different origin.
      ...(origin ? { redirect: 'error' as const } : {}),
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
    // Background display reads may arrive before the bounded online unlock.
    // A staff action that needs a box session opens the password screen once;
    // it is never replayed automatically after the unlock.
    const staffAction = rest.startsWith('members/') || (rest === 'intents'
      && (body as { type?: string } | undefined)?.type !== 'session.publish_display');
    if (res.status === 423 || (staffAction && res.status === 401 && err?.code === 'BOX_SESSION_REQUIRED')) {
      window.dispatchEvent(new CustomEvent('oto:session-locked'));
    }
    const refusal = new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? res.statusText,
      err?.details,
    );
    boxAnswers.add(refusal);
    throw refusal;
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
  displays: async (stationId: string) => {
    // SCRUM-780 — this waits no longer than the unlock itself: the one sent
    // beside an online unlock gives up after two seconds, and the box-lane
    // one is answered before the till opens. A box that refused the unlock,
    // or never answered, still refuses this read: a till that is not
    // unlocked on its box is told so.
    while (unlocksOnTheWire.size > 0) await Promise.all(unlocksOnTheWire);
    return request<ApiResponse<'/box/v1/station/{stationId}/displays', 'get'>>('GET', stationId, 'displays');
  },
  /**
   * Unlock through the box (OD-2). The answer's session is held for the
   * calls that follow, which is what a Pi needs; a virtual box also accepts
   * the platform cookie.
   */
  unlock: (stationId: string, body: BridgeUnlockRequest, signal?: AbortSignal): Promise<BridgeUnlockResponse> => {
    const revision = sessionRevision;
    const asked = (async () => {
      const answer = await request<BridgeUnlockResponse>('POST', stationId, 'unlock', body, {
        bearer: null,
        signal,
      });
      // A lock, sign-out, station change or timeout can overtake this response.
      if (revision === sessionRevision && !signal?.aborted) holdBoxSession(answer.session);
      return answer;
    })();
    // Settled either way, and only after the session is held (SCRUM-780).
    const settled: Promise<void> = asked.then(() => undefined, () => undefined)
      .finally(() => { unlocksOnTheWire.delete(settled); });
    unlocksOnTheWire.add(settled);
    return asked;
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

/** The scan channel's stream-first / bounded-open / polling fallback shape.
 * Fetch carries the paired bearer in a header (EventSource cannot); credentials
 * never enter a URL. The owner polls while onState(false), and retries are bounded.
 */
export function watchBridgeSnapshots(stationId: string, options: {
  bearer?: string;
  onSnapshot: (document: StationSessionDocument) => void;
  onState: (streaming: boolean) => void;
  onFailure: (error: unknown) => void;
  /** Every chunk read, heartbeats included: the last moment this connection was known to work. */
  onActivity?: () => void;
  /** Staff scans share this authenticated LAN stream; never a display credential. */
  onScan?: (scan: StationScanEvent) => void;
}): () => void {
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let awaitingSession = false;
  const afterUnlock = () => {
    if (stopped) return;
    // A lock revokes the live staff connection too, not only future fetches.
    // Its in-flight chunks carry the old revision and can never deliver scans.
    if (!boxSession) {
      awaitingSession = true;
      clearTimeout(retry); controller?.abort();
      return;
    }
    if (!awaitingSession) controller?.abort();
    awaitingSession = false;
    clearTimeout(retry);
    retry = setTimeout(() => { void connect(); }, 0);
  };
  const connect = async () => {
    const revision = sessionRevision;
    controller = new AbortController();
    const active = controller;
    const arm = (ms: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => active.abort(), ms);
    };
    arm(3_000);
    try {
      const bearer = options.bearer ?? boxSession;
      const response = await fetch(bridgeUrl(stationId, options.bearer ? 'display/channel' : 'channel?view=staff'), {
        credentials: options.bearer || origin ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { accept: 'text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        signal: active.signal,
      });
      if (!response.ok) throw new ApiError(response.status, 'CHANNEL_UNAVAILABLE', 'The display connection was interrupted.');
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('No display stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!stopped) {
          const part = await reader.read();
          if (part.done) throw new Error('Display stream ended');
          arm(options.bearer ? 12_000 : 35_000);
          options.onActivity?.();
          buffer += decoder.decode(part.value, { stream: true }).replace(/\r/g, '');
          if (buffer.length > 2_000_000) throw new Error('Display stream frame too large');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const message = JSON.parse(data) as { kind?: string; document?: unknown };
            if (message.kind === 'scan') {
              if (!stopped && !options.bearer && revision === sessionRevision) {
                const scan = StationScanMessageSchema.safeParse(message);
                if (scan.success) options.onScan?.(scan.data);
              }
              continue;
            }
            if (message.kind !== 'snapshot') continue;
            const document = StationSessionDocumentSchema.parse(message.document);
            if (document.stationId !== stationId) throw new Error('Wrong display station');
            if (stopped) return;
            attempt = 0;
            options.onSnapshot(document);
            options.onState(true);
          }
        }
      } finally { await reader.cancel().catch(() => undefined); }
    } catch (error) {
      if (!stopped) { options.onState(false); options.onFailure(error); }
      if (error instanceof ApiError && error.status === 401) {
        // A paired display's revoked credential stays refused. A staff stream
        // waits for a genuinely new box session, including an unlock that
        // overtook this response, instead of polling the rejected credential.
        if (!options.bearer) {
          awaitingSession = true;
          if (revision !== sessionRevision) afterUnlock();
        }
        return;
      }
    } finally { clearTimeout(deadline); active.abort(); }
    if (!stopped && !awaitingSession && revision === sessionRevision) {
      retry = setTimeout(() => { void connect(); }, Math.min(15_000, 1_000 * 2 ** attempt++));
    }
  };
  if (!options.bearer) sessionListeners.add(afterUnlock);
  void connect();
  return () => {
    stopped = true; sessionListeners.delete(afterUnlock);
    clearTimeout(retry); clearTimeout(deadline); controller?.abort();
  };
}

/**
 * THE CUSTOMER DISPLAY'S SIDE (OD-10): the paired credential, never the staff
 * session, and never a cookie.
 */
/**
 * SCRUM-975 — how long one display message to the box may take: the display's
 * other calls to the platform give up after the same eight seconds
 * (`displayRequest`, `api/display.ts`). One that hung kept Done or "Ask the
 * team" at "Sending…" until the browser gave up; past this it is a message
 * that reached nothing (`NetworkError`), which the display keeps and sends
 * again under the same action id (`lib/displaySendQueue.ts`).
 */
export const DISPLAY_INTENT_LIMIT_MS = 8_000;

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
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let outOfTime = false;
    const deadline = setTimeout(() => { outOfTime = true; controller.abort(); }, DISPLAY_INTENT_LIMIT_MS);
    try {
      const answer = await request<{ document: StationSessionDocument }>(
        'POST',
        stationId,
        'display/intents',
        intent,
        { bearer, signal: controller.signal },
      );
      return { document: StationSessionDocumentSchema.parse(answer.document) };
    } catch (err) {
      // Our own limit, not the caller's: the message reached nothing that answered.
      if (outOfTime) throw new NetworkError(err);
      throw err;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
    }
  },
};
