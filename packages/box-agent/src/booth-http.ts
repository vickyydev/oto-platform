/**
 * The `/booth/*` contract, as a function (S2-07a).
 *
 * **Transport-free on purpose.** This takes a method, a path, some headers and
 * a parsed body, and returns a status and a body. It opens no socket, binds no
 * port and knows nothing about Fastify, Express or Node's `http` — the process
 * that serves the booth's Chromium kiosk wires it to whichever it uses, and a
 * test calls it directly. Three things follow from that and all three are the
 * point:
 *
 *  - it can be exercised without standing up a server, which is what makes the
 *    press path cheap enough to test properly;
 *  - the same function serves a Raspberry Pi in Phuket and the virtual box
 *    inside the api, exactly as the agent does;
 *  - it cannot reach the cloud, because it has nothing to reach it with (D2).
 *    The browser calls only these paths, and these paths end at the box's own
 *    store. An offline demo whose page is quietly talking to a reachable api
 *    proves nothing.
 *
 * **Nothing written here is meant to be read by a guest** (D15). The page maps
 * an error CODE to its own copy and renders no server prose, so every `message`
 * below is for a developer console and a `#debug` line. They are fixed strings
 * carrying no station name, no account, no path and no code — a message
 * written for a log must never be able to land on a television in a shopping
 * centre.
 */

import {
  BoothRefusal,
  type Booth,
  type BoothRefusalCode,
  type BoothSignInRequest,
} from './booth';
import { uuidv7 } from './signing';
import { silentLog, type AgentLog } from './transport';

export interface BoothHttpRequest {
  method: string;
  /** Relative to wherever the booth is mounted: `/config`, `/spin`, … */
  path: string;
  /** Already parsed. This module does no JSON decoding and no framing. */
  body?: unknown;
  /** Lower-cased names. `x-oto-action-id` and the idempotency key are read. */
  headers?: Readonly<Record<string, string | undefined>>;
}

export interface BoothHttpResponse {
  status: number;
  /** Undefined for 204. Otherwise the document, or the error envelope. */
  body?: unknown;
}

export interface BoothHttpOptions {
  booth: Booth;
  /**
   * Whether the box currently has the cloud. The booth module has no opinion
   * about this and must not have one — it is the agent that knows, and
   * `BoothStatus.online` is the only field on this surface that comes from
   * outside the booth.
   */
  online: () => boolean;
  log?: AgentLog;
}

/** The header a press carries its idempotency key in, when it carries one. */
export const BOOTH_IDEMPOTENCY_HEADER = 'x-oto-idempotency-key';
/** Minted where somebody tapped, carried booth -> box -> cloud. */
export const BOOTH_ACTION_HEADER = 'x-oto-action-id';

/** The platform's envelope: `{ error: { code, message } }`. */
function refuse(status: number, code: string, message: string): BoothHttpResponse {
  return { status, body: { error: { code, message } } };
}

/**
 * Which HTTP status each refusal deserves.
 *
 * `booth_not_ready` and `not_configured` are 409 because the page already
 * expects them there — a booth with every prize capped is not a server fault
 * and a 500 would put it in the wrong column of every dashboard. The two that
 * mean the box cannot keep a record are 503: they are real faults, they are
 * temporary in principle, and they should show up as such.
 */
function statusFor(code: BoothRefusalCode): number {
  switch (code) {
    case 'not_configured':
    case 'booth_not_ready':
    case 'duplicate_press':
      return 409;
    case 'runtime_unavailable':
    case 'cannot_record':
      return 503;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function createBoothHttp(options: BoothHttpOptions): (
  request: BoothHttpRequest,
) => Promise<BoothHttpResponse> {
  const { booth } = options;
  const log = options.log ?? silentLog;
  /**
   * Whether this process has already complained about a press with no
   * idempotency key.
   *
   * Once, not once per press: a booth runs for a day and a log line per press
   * would bury everything else on the box. The condition is the same one D13
   * makes about unattributed vouchers — a count, not an alert each time.
   */
  let warnedAboutMissingKey = false;

  return async function handle(request: BoothHttpRequest): Promise<BoothHttpResponse> {
    const path = request.path.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    try {
      if (path === '/config') {
        if (method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET');
        const held = booth.config();
        /**
         * The version travels BESIDE the bundle. The document deliberately
         * does not carry its own publish number, so without this the page has
         * nothing to check `SpinResponse.configVersion` against — and the
         * whole point of that field is catching a page and a box that have
         * drifted onto different wheels.
         *
         * Nulls are not an error: a booth nobody has published to shows
         * "Booth not set up, connect to internet", which is a screen rather
         * than a failure.
         */
        return { status: 200, body: { version: held?.version ?? null, bundle: held?.bundle ?? null } };
      }

      if (path === '/status') {
        if (method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET');
        return { status: 200, body: await booth.status({ online: options.online() }) };
      }

      if (path === '/spin') {
        if (method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST');
        const body = asRecord(request.body);
        const headers = request.headers ?? {};
        /**
         * A press with no idempotency key gets one minted here, and is
         * therefore not protected by it.
         *
         * D7 says every press carries a client-minted key, and the page in
         * this repository does not send one yet — its `SpinRequest` is
         * `{ simulate? }`. Refusing those presses would mean a booth that
         * cannot be played by the page built for it, which is the wrong
         * failure by a distance; drawing without one is a press whose retry
         * would be a second spin, which is a real gap and is logged as one
         * rather than being papered over. The fix belongs on the page.
         */
        const supplied =
          readString(body.idempotencyKey) ?? readString(headers[BOOTH_IDEMPOTENCY_HEADER]);
        if (!supplied && !warnedAboutMissingKey) {
          warnedAboutMissingKey = true;
          log.warn(
            { module: 'booth-http' },
            'a press arrived with no idempotency key; a retry of it would be a second spin',
          );
        }
        const response = await booth.spin({
          simulate: body.simulate === true,
          idempotencyKey: supplied ?? uuidv7(),
          actionId: readString(headers[BOOTH_ACTION_HEADER]) ?? null,
        });
        return { status: 200, body: response };
      }

      if (path === '/staff/sign-in') {
        if (method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST');
        const body = asRecord(request.body);
        /**
         * PIN or badge, never both, and the box holds neither afterwards: the
         * value is verified against the cached hashes and goes out of scope
         * with this call. Nothing about it is logged, which is the one rule
         * that matters here — a booth PIN in a log line on a box in a
         * storeroom is the outgoing game's mistake in a new place.
         */
        const signIn: BoothSignInRequest = {};
        const badge = readString(body.badge);
        const pin = readString(body.pin);
        if (badge !== undefined) signIn.badge = badge;
        else if (pin !== undefined) signIn.pin = pin;
        const result = await booth.signIn(signIn);
        /**
         * A refused sign-in is 200 with `ok: false`, not 401.
         *
         * The panel reads `ok` and `retryAfterMs`; a 4xx would make the page's
         * generic error path fire and replace a countdown the person can act
         * on with the fixed line. And a sign-in problem must never look like
         * the booth being broken, because the wheel is still working.
         */
        return {
          status: 200,
          body:
            result.retryAfterMs === undefined
              ? { ok: result.ok }
              : { ok: result.ok, retryAfterMs: result.retryAfterMs },
        };
      }

      if (path === '/staff/sign-out') {
        if (method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST');
        await booth.signOut();
        return { status: 204 };
      }

      return refuse(404, 'not_found', 'No such booth route');
    } catch (err) {
      if (err instanceof BoothRefusal) {
        return refuse(statusFor(err.code), err.code, err.message);
      }
      /**
       * Anything else is a bug on the box. The code and a fixed line go back;
       * the error itself goes to the box log, where a developer can read it
       * and a guest cannot.
       */
      log.error({ module: 'booth-http', err: String(err) }, 'a booth request failed');
      return refuse(500, 'internal', 'The booth could not answer that');
    }
  };
}
