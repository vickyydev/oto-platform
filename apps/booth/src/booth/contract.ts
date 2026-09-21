/**
 * The `/booth/*` calls this page makes, as the page understands them.
 *
 * `@oto/shared/booth` froze the documents that more than one surface names —
 * the config bundle, the answer to a press, the heartbeat block. It did not
 * freeze the HTTP shapes around them, because nothing existed yet to have an
 * opinion. This file is that opinion, written from the side that has to draw
 * the result: **whatever serves this page must answer exactly these.**
 *
 * Two of them are not derivable from the frozen types and are easy to get
 * subtly wrong, so they are stated here rather than assumed:
 *
 *   - `GET /booth/config` returns the version BESIDE the bundle. The bundle
 *     document deliberately does not carry its own publish number (see the
 *     note on `BoothConfigBundleSchema`), and without the number the page
 *     cannot check `SpinResponse.configVersion` against anything.
 *   - `POST /booth/spin` takes `simulate`. The `#debug` distribution table
 *     runs 200 presses through the same call the red button uses (D16), and a
 *     simulated press must write no spin row, mint no voucher, print nothing
 *     and count against no daily cap. **If the server ignores this flag, 200
 *     real vouchers are minted the first time somebody opens the table.**
 *
 * D15 runs through the whole file: nothing here carries a name, a phone
 * number, a token or an origin, and no server-supplied prose is rendered. The
 * page maps an error CODE to its own copy (see src/copy.ts) so that a message
 * written for a log can never land on a television in a shopping centre.
 */

import type { BoothConfigBundle, BoothPrintState, SpinResponse } from '@oto/shared';

/** `GET /booth/config` */
export interface BoothConfigResponse {
  /**
   * `booth.booth_config_version.version`, or null when this booth has never
   * had a wheel published to it — which is a different screen ("Booth not set
   * up, connect to internet"), not an error.
   */
  version: number | null;
  bundle: BoothConfigBundle | null;
}

/** `POST /booth/spin` */
export interface SpinRequest {
  /**
   * Draw, but change nothing: no spin row, no voucher, no print, no cap
   * consumed. Only the `#debug` distribution table sends it.
   */
  simulate?: boolean;
  /**
   * One value per PRESS, so a press that is sent twice is one spin (D7).
   *
   * The box has always read this; the page did not send it, and a reviewer
   * measured what that cost: two presses, two spins, two vouchers, and — the
   * case that matters — a press the box recorded and printed but answered
   * slowly shows the guest "Booth not ready", so the next press puts a second
   * prize on real paper. The key is minted when the button goes down and
   * reused for the retry, never for the next press: a retry is one spin, and
   * a second press is two.
   */
  idempotencyKey?: string;
}

/** `POST /booth/staff/sign-in` */
export interface StaffSignInRequest {
  /**
   * The typed PIN, or the scanned badge — never both. **The page holds
   * neither afterwards** (D15): it posts, reads `ok`, and drops the value.
   * There is no hash in this browser and no account id beyond the opaque one
   * the spin response carries.
   */
  pin?: string;
  badge?: string;
}

export interface StaffSignInResponse {
  ok: boolean;
  /**
   * How long the server will refuse further attempts, when it is refusing.
   *
   * The page runs its own backoff so the panel behaves correctly against a
   * server that never sends this — but a backoff kept in a browser is a
   * courtesy, not a control: a reload clears it. The real one belongs to
   * whatever verifies the PIN.
   */
  retryAfterMs?: number;
}

/**
 * `GET /booth/status` — what the corner of the screen and the `#debug` panel
 * are drawn from.
 *
 * Deliberately the heartbeat block's own fields, spelled the same, plus the
 * two facts the heartbeat has no reason to carry because the cloud can see
 * them for itself: whether this box currently has the cloud, and whether it
 * has ever had it.
 */
export interface BoothStatus {
  /** The box's link to the cloud. False lights the offline dot. */
  online: boolean;
  /**
   * True until the first successful sync. Shows "Booth not set up, connect to
   * internet" instead of the game, because a wheel with no published config
   * is not a wheel — and it is a different state from "offline", which a
   * booth that has run all week is in every time the mall's wifi drops.
   */
  neverSynced: boolean;
  /** `booth.booth_config_version.version` the box is drawing from. */
  configVersion: number | null;
  /** Tri-state on purpose: "could not ask" is not "unreachable". */
  printerReachable: 'unknown' | 'reachable' | 'unreachable';
  paperStatus: 'unknown' | 'ok' | 'low' | 'out';
  /** Spins and vouchers written locally and not yet acknowledged by the cloud. */
  vouchersPending: number;
  /** ISO 8601, or null when this booth has not been played since it started. */
  lastSpinAt: string | null;
  /** Whether anybody is attending the booth. Never who. */
  staffSignedIn: boolean;
  /** `booth.booth_prize.id` of the prizes that have hit today's cap. */
  dailyCapsReached: string[];
}

/**
 * The failures this page knows how to say something about.
 *
 * `booth_not_ready` is D5's: every prize is inactive, capped or out of stock,
 * so the press is refused rather than drawing from an empty set.
 * `unreachable` is not a server code at all — it is what the client returns
 * when the booth service could not be reached, kept in the same union so that
 * one branch on the page covers "it said no" and "it said nothing".
 */
export const BOOTH_ERROR_CODES = ['booth_not_ready', 'not_configured', 'unreachable'] as const;
export type BoothErrorCode = (typeof BOOTH_ERROR_CODES)[number];

/**
 * A call that did not produce its document.
 *
 * `code` is a member of the union above when the server sent one this page
 * recognises, and null when it sent something else — an unknown code, a 500,
 * a body that did not parse. Both end on the same fixed line to the guest;
 * the difference is only visible in `#debug`, which is where it belongs.
 */
export class BoothCallError extends Error {
  readonly code: BoothErrorCode | null;
  /** The HTTP status, or null when the request never got an answer. */
  readonly status: number | null;

  constructor(code: BoothErrorCode | null, status: number | null) {
    // The message is for a developer console and a `#debug` line, never for
    // the screen. It carries a code and a status and nothing else — no URL,
    // no body, no origin (D15).
    super(`booth call failed: ${code ?? 'unknown'}${status === null ? '' : ` (${status})`}`);
    this.name = 'BoothCallError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Everything the page can ask of a booth. One interface so the fake and the
 * HTTP client are interchangeable and the page cannot tell which it has — the
 * `#debug` panel names the live one so that a person can.
 */
export interface BoothTransport {
  /** Which implementation this is, for the `#debug` header. */
  readonly kind: 'fake' | 'http';
  getConfig(): Promise<BoothConfigResponse>;
  getStatus(): Promise<BoothStatus>;
  spin(request: SpinRequest): Promise<SpinResponse>;
  signIn(request: StaffSignInRequest): Promise<StaffSignInResponse>;
  signOut(): Promise<void>;
}

export type { BoothConfigBundle, BoothPrintState, SpinResponse };
