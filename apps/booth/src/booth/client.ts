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

import { BOOTH_DEVICE_HEADER, type BoothReprintRequest } from '@oto/shared';
import { flags } from '../flags';
import {
  BOOTH_ERROR_CODES,
  BoothCallError,
  type BoothConfigResponse,
  type BoothErrorCode,
  type BoothReprintResponse,
  type BoothStatus,
  type BoothStaffChoice,
  type BoothTransport,
  type SpinRequest,
  type SpinResponse,
  type StaffSignInRequest,
  type StaffSignInResponse,
} from './contract';
import { FakeBooth } from './fake';
import { boothHost } from './host';

/**
 * The paired screen's credential (SCRUM-244).
 *
 * **Why `localStorage` and not a cookie.** A booth carries no session and
 * wants none — every call sends `credentials: 'omit'` — and a cookie would
 * travel automatically on requests this page did not make. This is sent by
 * hand, on booth calls only, and is the only thing about this browser that
 * outlives a reload.
 *
 * **What D15 permits, and this is the line.** The rule is that nothing ships
 * a token TO a screen in a shopping centre: a secret in a build would be on
 * every booth at once, readable by anyone who opened the page. This secret was
 * typed in at this booth, by a member of staff, for this booth, and can be
 * revoked from the Console. It is still readable by somebody with the device's
 * developer tools, which is why revocation exists and why it names one booth.
 *
 * Every access is wrapped: a television in kiosk mode with site data disabled
 * throws on `localStorage`, and a booth that cannot remember its credential
 * must show the pairing prompt rather than a blank screen.
 */
const CREDENTIAL_KEY = 'oto.booth.device';

function readCredential(): string | null {
  try {
    const held = window.localStorage.getItem(CREDENTIAL_KEY);
    return held !== null && held !== '' ? held : null;
  } catch {
    return null;
  }
}

export const boothCredential = {
  /** Whether this screen holds one at all. Not whether it still works. */
  has(): boolean {
    return readCredential() !== null;
  },

  /**
   * Exchange the six digits for this screen's credential and keep it.
   *
   * Throws `BoothCallError` like every other call here — `'unpaired'` for a
   * code the service refused, `'unreachable'` when it did not answer — so the
   * pairing panel branches on exactly the same thing the rest of the page
   * does.
   */
  async redeem(code: string): Promise<void> {
    const answer = await call<{ deviceSecret: string }>('/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
      // A pairing request cannot carry a credential: not holding one is the
      // whole reason it is being made.
      noCredential: true,
    });
    try {
      window.localStorage.setItem(CREDENTIAL_KEY, answer.deviceSecret);
    } catch {
      /**
       * Paired, and unable to remember it.
       *
       * The credential is real and the server has already spent the code, so
       * this cannot be retried with the same digits. Refused loudly rather
       * than left to fail on the next call, where it would look like a wrong
       * code: a television that cannot keep site data has to be fixed at the
       * device, not paired again.
       */
      throw new BoothCallError('unpaired', null);
    }
  },

  /** Forget it — after a 401, or when staff unpair this screen deliberately. */
  forget(): void {
    try {
      window.localStorage.removeItem(CREDENTIAL_KEY);
    } catch {
      // Nothing to do: a browser that cannot write could not have stored one.
    }
  },
};

/** Long enough for a Pi under a television, short enough that a press is not dead. */
const REQUEST_TIMEOUT_MS = 6000;

function baseUrl(): string {
  /**
   * A page served by a booth box talks to that box, on the origin it came
   * from, whatever the build was told (SCRUM-223): the address a build bakes
   * in is the staging site's business, and a Pi under a television has no
   * other address to reach.
   */
  if (boothHost === 'box') return '/booth';
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

async function call<T>(
  path: string,
  init?: RequestInit & { noCredential?: boolean },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const held = init?.noCredential === true ? null : readCredential();
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // The paired screen's credential (SCRUM-244). Absent when this screen
        // holds none, which the service answers 401 — and that 401 is what
        // puts the pairing prompt on the television.
        ...(held !== null ? { [BOOTH_DEVICE_HEADER]: held } : {}),
        ...init?.headers,
      },
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

  if (response.status === 401) {
    /**
     * Not paired, or not paired any more (SCRUM-244).
     *
     * The credential is dropped here rather than in the page, so a screen that
     * was unpaired from the Console cannot go on sending a secret that is dead
     * — and so that "we hold one" and "it works" cannot disagree. The status
     * is what decides, not the envelope's code: every way of not being paired
     * answers the same code on purpose.
     */
    boothCredential.forget();
    throw new BoothCallError('unpaired', 401);
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

  getStaff(): Promise<{ staff: BoothStaffChoice[] }> {
    return call('/staff');
  }

  getConfig(): Promise<BoothConfigResponse> {
    return call<BoothConfigResponse>('/config');
  }

  getStatus(): Promise<BoothStatus> {
    return call<BoothStatus>('/status');
  }

  spin(request: SpinRequest): Promise<SpinResponse> {
    return call<SpinResponse>('/spin', { method: 'POST', body: JSON.stringify(request) });
  }

  print(request: { spinId: string }): Promise<SpinResponse> {
    return call<SpinResponse>('/print', { method: 'POST', body: JSON.stringify(request) });
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

  reprint(request: BoothReprintRequest): Promise<BoothReprintResponse> {
    return call<BoothReprintResponse>('/reprint', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
}

function chooseTransport(): BoothTransport {
  // A booth box is always the real thing: there is no demo mode on a Pi.
  if (boothHost === 'box') return new HttpBooth();
  if (flags.live) return new HttpBooth();
  if (flags.fake) return new FakeBooth();
  const configured = import.meta.env.VITE_BOOTH_FAKE;
  if (configured === '1') return new FakeBooth();
  if (configured === '0') return new HttpBooth();
  return import.meta.env.DEV ? new FakeBooth() : new HttpBooth();
}

/** One transport for the life of the page. */
export const booth: BoothTransport = chooseTransport();
