/**
 * The booth box's own routes, for the screens before there is a wheel
 * (SCRUM-223). Only a page served BY a box calls these — see `host.ts`.
 *
 * Same origin, no credential: the page and the box are one machine, and the
 * box answers nothing but itself (`kiosk-server.ts` in `@oto/box-agent`).
 * Nothing here carries a secret back to the page — the claim code goes in,
 * and "it worked" or a reason code comes out.
 */

export interface KioskBooth {
  stationId: string;
  name: string;
  codePrefix: string | null;
}

export interface KioskState {
  registered: boolean;
  online: boolean;
  booths: KioskBooth[];
  selectedStationId: string | null;
  agentVersion: string;
}

export type KioskClaimOutcome =
  | { ok: true }
  | { ok: false; reason: 'refused' | 'unreachable' | 'already_registered' | 'invalid' };

const TIMEOUT_MS = 20_000;

async function kioskCall<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`kiosk ${path} answered ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const kiosk = {
  state: () => kioskCall<KioskState>('/kiosk/state'),
  /** A claim can take the length of one registration with the cloud. */
  claim: (code: string) => kioskCall<KioskClaimOutcome>('/kiosk/claim', { code }),
  chooseBooth: (stationId: string) => kioskCall<{ ok: true }>('/kiosk/booth', { stationId }),
};
