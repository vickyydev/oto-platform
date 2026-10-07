import {
  KioskAbandonAnswerSchema,
  KioskPairingStartAnswerSchema,
  KioskPairingStatusSchema,
  KioskRedeemAnswerSchema,
  KioskSessionAnswerSchema,
  KioskStateSchema,
  STATION_BRIDGE_BASE,
  type KioskAbandonAnswer,
  type KioskAbandonCause,
  type KioskPairingStatus,
  type KioskRedeemAnswer,
  type KioskSessionAnswer,
  type KioskState,
} from '@oto/shared';

/**
 * S2-20 K2 (SCRUM-217) — THE SELF-SERVICE KIOSK'S OWN CLIENT.
 *
 * A kiosk is a device, not a person: it carries its paired credential as a
 * bearer and never a cookie (`credentials: 'omit'`), so a staff session open
 * in the same browser on a test bench never rides along. Pairing is the
 * display's flow (`api/display.ts`): the browser makes its own 256-bit secret
 * before it asks for anything, so a lost answer can never lose it, and the
 * secret becomes the kiosk's credential when a manager claims the code.
 *
 * Every answer is parsed against `@oto/shared`'s strict kiosk schemas, so a
 * field that is not in the contract — an allergy, a phone — can never reach
 * the screen even if a server sent one (R-58, H15).
 */

export class KioskError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KioskError';
  }
}

/** No answer at all: the kiosk cannot reach the platform (or its box). */
export const KIOSK_UNREACHABLE = 'KIOSK_UNREACHABLE';

const REQUEST_TIMEOUT_MS = 20_000;

export async function kioskRequest<T>(
  bearer: string,
  method: 'GET' | 'POST',
  path: string,
  parse: (data: unknown) => T,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        method,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new KioskError(0, KIOSK_UNREACHABLE, 'This kiosk cannot reach the park right now');
    }
    const data = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) {
      throw new KioskError(
        response.status,
        data?.error?.code ?? KIOSK_UNREACHABLE,
        data?.error?.message ?? 'This kiosk could not finish that',
      );
    }
    if (data === null) throw new KioskError(0, KIOSK_UNREACHABLE, 'This kiosk received an unreadable answer');
    try {
      return parse(data);
    } catch {
      throw new KioskError(0, 'KIOSK_ANSWER_UNREADABLE', 'This kiosk received an answer it cannot read');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const bridge = (stationId: string, rest: string) => `${STATION_BRIDGE_BASE}/${encodeURIComponent(stationId)}/${rest}`;

/** The calls a kiosk makes, by name. Every one is the kiosk's own credential. */
export interface KioskApi {
  pairingStatus(bearer: string, signal?: AbortSignal): Promise<KioskPairingStatus>;
  startPairing(bearer: string, signal?: AbortSignal): Promise<{ pairingCode: string; expiresAt: string }>;
  expirePairing(bearer: string): Promise<{ expired: true }>;
  state(bearer: string, stationId: string, signal?: AbortSignal): Promise<KioskState>;
  startSession(bearer: string, stationId: string, sessionId: string): Promise<KioskSessionAnswer>;
  abandon(bearer: string, stationId: string, sessionId: string, cause: KioskAbandonCause): Promise<KioskAbandonAnswer>;
  redeem(
    bearer: string,
    stationId: string,
    press: { actionId: string; qr: string; sessionId?: string },
  ): Promise<KioskRedeemAnswer>;
}

export const kioskApi: KioskApi = {
  pairingStatus: (bearer, signal) =>
    kioskRequest(bearer, 'GET', '/kiosk/pairing', (d) => KioskPairingStatusSchema.parse(d), undefined, signal),
  startPairing: (bearer, signal) =>
    kioskRequest(bearer, 'POST', '/kiosk/pairing', (d) => KioskPairingStartAnswerSchema.parse(d), {}, signal),
  expirePairing: (bearer) =>
    kioskRequest(bearer, 'POST', '/kiosk/pairing/expire', (d) => d as { expired: true }, {}),
  state: (bearer, stationId, signal) =>
    kioskRequest(bearer, 'GET', bridge(stationId, 'kiosk/state'), (d) => KioskStateSchema.parse(d), undefined, signal),
  startSession: (bearer, stationId, sessionId) =>
    kioskRequest(bearer, 'POST', bridge(stationId, 'kiosk/sessions'), (d) => KioskSessionAnswerSchema.parse(d), {
      sessionId,
    }),
  abandon: (bearer, stationId, sessionId, cause) =>
    kioskRequest(
      bearer,
      'POST',
      bridge(stationId, `kiosk/sessions/${encodeURIComponent(sessionId)}/abandon`),
      (d) => KioskAbandonAnswerSchema.parse(d),
      { cause },
    ),
  redeem: (bearer, stationId, press) =>
    kioskRequest(bearer, 'POST', bridge(stationId, 'kiosk/redeem'), (d) => KioskRedeemAnswerSchema.parse(d), press),
};

// --- The kiosk's own secret, kept in this browser -------------------------------

const CREDENTIAL_KEY = 'oto.kiosk.credential';

export function readKioskCredential(): string | null {
  try {
    const value = window.localStorage.getItem(CREDENTIAL_KEY);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function newKioskCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** False when this browser cannot keep it (private mode, blocked storage): the page says so. */
export function rememberKioskCredential(value: string): boolean {
  try {
    window.localStorage.setItem(CREDENTIAL_KEY, value);
    return true;
  } catch {
    return false;
  }
}
