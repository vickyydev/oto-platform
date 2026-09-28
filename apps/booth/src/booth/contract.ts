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

import type {
  BoothConfigBundle,
  BoothPrintState,
  BoothReprintRequest,
  BoothReprintResponse,
  BoothSignInRefusal,
  BoothStaffOnDuty,
  SpinResponse,
} from '@oto/shared';

/** `GET /booth/config` */
export interface BoothConfigResponse {
  /**
   * `booth.booth_config_version.version`, or null when this booth has never
   * had a wheel published to it — which is a different screen, not an error:
   * "Booth not set up, connect to internet" while the box is offline, and
   * "No wheel published for this booth yet" while it is online (`noWheelScreen`
   * in src/copy.ts).
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
   * `account` is a phone and password, which the box checks with the cloud
   * (SCRUM-223); `pin` or nothing is the PIN, checked on the box.
   */
  mode?: 'pin' | 'account';
  /**
   * The typed PIN, or the scanned badge — never both. **The page holds
   * neither afterwards** (D15): it posts, reads `ok`, and drops the value.
   * There is no hash in this browser and no account id beyond the opaque one
   * the spin response carries.
   */
  pin?: string;
  badge?: string;
  /** Account sign-in only. Held by the page for as long as the post takes. */
  phone?: string;
  password?: string;
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
  /**
   * Why an account sign-in was refused, when the person can do something
   * about it: `offline` (use the PIN), `not_assigned`, `not_allowed`,
   * `must_change_password`, `locked`, and — when the cloud refused the box or
   * the booth rather than the person — `box_refused` and `booth_not_on_box`,
   * which a manager fixes in Console → Devices. A code, which the panel words
   * (D15); `BOOTH_SIGN_IN_REFUSALS` in `@oto/shared` says what each one means.
   */
  reason?: BoothSignInRefusal;
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
   * True until a wheel has been applied on the box. The page shows no game
   * then, because a wheel with no published config is not a wheel — and it is
   * a different state from "offline", which a booth that has run all week is
   * in every time the mall's wifi drops. Which words that screen shows is
   * decided by `online`: an offline box is told to connect, an online one that
   * nobody has published to is told where to publish (`noWheelScreen` in
   * src/copy.ts).
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
  /** Whether anybody is attending the booth. */
  staffSignedIn: boolean;
  /**
   * WHO is attending: name and staff code, and when the session ends by
   * itself (SCRUM-223). A deliberate change to D15 on the owner's
   * instruction — the corner of the screen shows the person on duty, as a
   * name badge would. Never an account id, a phone or anything that signs in.
   */
  staff?: BoothStaffOnDuty | null;
  /** `booth.booth_prize.id` of the prizes that have hit today's cap. */
  dailyCapsReached: string[];
}

/**
 * The failures this page knows how to say something about.
 *
 * `booth_not_ready` is D5's: every prize is inactive, capped or out of stock,
 * so the press is refused rather than drawing from an empty set. The box also
 * sends it for a booth station whose code prefix cannot start a voucher code
 * (closing audit H2); the television says the same line for both.
 * `unreachable` is not a server code at all — it is what the client returns
 * when the booth service could not be reached, kept in the same union so that
 * one branch on the page covers "it said no" and "it said nothing".
 */
export const BOOTH_ERROR_CODES = [
  'booth_not_ready',
  'not_configured',
  /**
   * SCRUM-257 — this booth has given away every spin it was allowed today.
   *
   * Listed rather than left to fall through to the fixed line, and the list is
   * what makes that possible: `client.ts` keeps only codes this page knows, so
   * a code missing from here reaches the page as null and shows "Booth not
   * ready — please call staff". That would send a family to find a member of
   * staff who can do nothing about it until tomorrow.
   */
  'daily_spin_cap_reached',
  /**
   * The box has this press on record — its key was counted in the transaction
   * that recorded the spin and minted the voucher — but holds no answer to
   * give again, so it refuses to draw a second prize (409). The page meets it
   * when its retry of an unanswered press reaches a box that no longer has the
   * first attempt in hand: after a restart, for one.
   *
   * Listed so it does not fall through to "Booth not ready — please call
   * staff": the prize exists, and on a booth with a printer its slip was
   * queued in that same transaction, so the television says the voucher is
   * being printed and to ask staff if it does not come out
   * (`COPY.voucherPrinting`). No wheel turns and no card opens for it — the
   * box did not send the prize again, and this page will not make one up.
   */
  'duplicate_press',
  'unreachable',
  /**
   * SCRUM-244 — this screen is not paired, or its credential no longer works.
   *
   * Not a code the booth service spells: it is what the client returns for a
   * 401 on any `/booth/*` call, whatever the envelope says. Deliberately
   * derived from the STATUS rather than from `error.code`, because the four
   * ways of not being paired — absent, wrong, expired, revoked, paired to
   * another booth — all answer `BOOTH_UNPAIRED` on purpose, and this page
   * would do the same thing with each of them anyway: show the pairing prompt
   * and ask for staff.
   */
  'unpaired',
  /** SCRUM-223 — a reprint asked for with nobody signed in at the booth. */
  'staff_required',
  /** SCRUM-223 — a reprint with no voucher on the box to print again. */
  'nothing_to_reprint',
  'nothing_to_print',
  /**
   * SCRUM-403 — the box's store cannot be used, so no press can be recorded.
   * The page shows its full-screen "needs service" notice from the box's own
   * state (`/kiosk/state`); this is the answer a press meets in the seconds
   * before that poll, and it gets the notice's words rather than the fixed
   * line (`refusalLine` in src/copy.ts).
   */
  'needs_service',
] as const;
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
  print(request: { spinId: string }): Promise<SpinResponse>;
  signIn(request: StaffSignInRequest): Promise<StaffSignInResponse>;
  signOut(): Promise<void>;
  /**
   * `POST /booth/reprint` — the booth's last voucher again, same code,
   * staff only (SCRUM-223). The box refuses with `staff_required` or
   * `nothing_to_reprint`.
   */
  reprint(request: BoothReprintRequest): Promise<BoothReprintResponse>;
}

export type {
  BoothConfigBundle,
  BoothPrintState,
  BoothReprintResponse,
  BoothSignInRefusal,
  BoothStaffOnDuty,
  SpinResponse,
};
