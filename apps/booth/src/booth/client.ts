/**
 * How the page reaches a booth — and which booth it is reaching.
 *
 * Two implementations of one interface (src/booth/contract.ts): the fake in
 * this folder, and plain `fetch` against `/booth/*`. The page never branches
 * on which it has; only the `#debug` header names it, because a person reading
 * a distribution table has to know whether the numbers came from a box or from
 * a browser.
 *
 * **The default is the fake in development and HTTP in a build**, which is the
 * only pair of defaults where both mistakes are loud: `pnpm dev` gives a
 * playable wheel with no box to run, and a deployed booth that cannot reach
 * its box shows the offline dot rather than quietly playing a game that
 * records nothing. `#fake` and `#live` override for one load, and
 * `VITE_BOOTH_FAKE=0|1` overrides at build time.
 */

import { flags } from '../flags';
import {
  BOOTH_ERROR_CODES,
  BoothCallError,
  type BoothConfigResponse,
  type BoothErrorCode,
  type BoothStatus,
  type BoothTransport,
  type SpinRequest,
  type SpinResponse,
  type StaffSignInRequest,
  type StaffSignInResponse,
} from './contract';
import { FakeBooth } from './fake';

/** Long enough for a Pi under a television, short enough that a press is not dead. */
const REQUEST_TIMEOUT_MS = 6000;

function baseUrl(): string {
  const configured = import.meta.env.VITE_BOOTH_API;
  const base = typeof configured === 'string' && configured !== '' ? configured : '/booth';
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function isBoothErrorCode(value: unknown): value is BoothErrorCode {
  return typeof value === 'string' && (BOOTH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Pull the platform's error envelope out of a response body.
 *
 * Only the CODE is read. `error.message` is written for a log and could say
 * anything — a station name, a constraint, a stack — and this page is a
 * television in a shopping centre (D15). The words the guest sees come from
 * src/copy.ts and from nowhere else.
 */
async function errorFrom(response: Response): Promise<BoothCallError> {
  try {
    const body: unknown = await response.json();
    const envelope =
      typeof body === 'object' && body !== null ? (body as { error?: { code?: unknown } }) : null;
    const code = envelope?.error?.code;
    if (isBoothErrorCode(code)) return new BoothCallError(code, response.status);
  } catch {
    // A body that is not JSON is not worth reporting any differently than one
    // that is: both end on the same fixed line.
  }
  return new BoothCallError(null, response.status);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...init?.headers },
      // The booth service is same-origin behind the rewrite; a booth carries
      // no session cookie and wants none.
      credentials: 'omit',
    });
  } catch {
    // A refused connection, a DNS failure and a timeout are one fact to this
    // page: the booth service did not answer.
    throw new BoothCallError('unreachable', null);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new BoothCallError(null, response.status);
  }
}

class HttpBooth implements BoothTransport {
  readonly kind = 'http' as const;

  getConfig(): Promise<BoothConfigResponse> {
    return call<BoothConfigResponse>('/config');
  }

  getStatus(): Promise<BoothStatus> {
    return call<BoothStatus>('/status');
  }

  spin(request: SpinRequest): Promise<SpinResponse> {
    return call<SpinResponse>('/spin', { method: 'POST', body: JSON.stringify(request) });
  }

  signIn(request: StaffSignInRequest): Promise<StaffSignInResponse> {
    return call<StaffSignInResponse>('/staff/sign-in', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async signOut(): Promise<void> {
    await call<void>('/staff/sign-out', { method: 'POST', body: '{}' });
  }
}

function chooseTransport(): BoothTransport {
  if (flags.live) return new HttpBooth();
  if (flags.fake) return new FakeBooth();
  const configured = import.meta.env.VITE_BOOTH_FAKE;
  if (configured === '1') return new FakeBooth();
  if (configured === '0') return new HttpBooth();
  return import.meta.env.DEV ? new FakeBooth() : new HttpBooth();
}

/** One transport for the life of the page. */
export const booth: BoothTransport = chooseTransport();
