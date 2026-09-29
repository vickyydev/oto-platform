import { StationSessionDocumentSchema, type StationIntent, type StationSessionDocument } from '@oto/shared';

export interface DisplayBinding {
  station: { id: string; name: string; kind: string };
  device: { id: string; name: string };
}
export interface DisplaySession extends DisplayBinding { document: StationSessionDocument }
export interface DisplayPairing extends Partial<DisplayBinding> { status: 'pending' | 'paired' | 'expired' }

/** A delayed poll/intent must never restore an older visitor on this display. */
export function newerDisplaySession(previous: DisplaySession | null, incoming: DisplaySession): DisplaySession {
  return previous?.device.id === incoming.device.id && previous.document.sequence > incoming.document.sequence ? previous : incoming;
}

export class DisplayError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'DisplayError';
  }
}

/** A display has its own credential and never enters the staff 401/lock handler. */
export async function displayRequest<T>(
  bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 8_000);
  try {
    const response = await fetch(`/api/display${path}`, {
      method, credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new DisplayError(response.status, data?.error?.code ?? 'DISPLAY_UNAVAILABLE',
      data?.error?.message ?? 'The display could not connect. Please try again.');
    if (!data) throw new DisplayError(0, 'DISPLAY_UNAVAILABLE', 'The display received an unreadable reply. Please try again.');
    return data as T;
  } catch (error) {
    if (error instanceof DisplayError) throw error;
    throw new DisplayError(0, 'DISPLAY_UNAVAILABLE', 'Connection interrupted. Please retry when the connection returns.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const displayApi = {
  pairing: (bearer: string, signal?: AbortSignal) => displayRequest<DisplayPairing>(bearer, 'GET', '/pairing', undefined, signal),
  start: (bearer: string, signal?: AbortSignal) => displayRequest<{ pairingCode: string; expiresAt: string }>(bearer, 'POST', '/pairing', {}, signal),
  expire: (bearer: string) => displayRequest<{ expired: true }>(bearer, 'POST', '/pairing/expire', {}),
  session: async (bearer: string, signal?: AbortSignal): Promise<DisplaySession> => {
    const result = await displayRequest<DisplaySession>(bearer, 'GET', '/session', undefined, signal);
    return { ...result, document: StationSessionDocumentSchema.parse(result.document) };
  },
  intent: async (bearer: string, intent: StationIntent, signal?: AbortSignal) => {
    const result = await displayRequest<{ document: StationSessionDocument }>(bearer, 'POST', '/intents', intent, signal);
    return { document: StationSessionDocumentSchema.parse(result.document) };
  },
};

const CREDENTIAL_KEY = 'oto.display.credential';
export function readDisplayCredential(): string | null {
  try {
    const value = window.localStorage.getItem(CREDENTIAL_KEY);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch { return null; }
}
export function newDisplayCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function rememberDisplayCredential(value: string): boolean {
  try { window.localStorage.setItem(CREDENTIAL_KEY, value); return true; }
  catch { return false; }
}
