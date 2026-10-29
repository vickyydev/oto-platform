/**
 * The Lucky Wheel, as the box runs it (S2-07a).
 *
 * A child presses a red button at a mall booth, a wheel spins on a television,
 * and a printed voucher brings the family to the park. Everything between the
 * press and the paper happens here: the published wheel is read from the
 * box's cache, the prize is drawn on the box, the spin is written down before
 * anything animates, the code is minted, the voucher is queued for the
 * printer, and the facts go in the outbox for whenever the mall's internet
 * comes back.
 *
 * **There is no cloud transport in this file, and that is the design** (D2).
 * `createBooth` takes no base URL, no `fetch`, no credential; it cannot reach
 * the cloud even by mistake, because it has nothing to reach it with. An
 * offline demo whose browser is quietly talking to a reachable api proves
 * nothing at all, so the illegal call is made unrepresentable rather than
 * merely unintended. What this module touches is the box's own store, the
 * box's own printer, and an outbox that the agent flushes when it can.
 *
 * **What it deliberately does not import.** `@oto/print` is type-only
 * throughout: the booth decides what goes on the paper and never renders it.
 * The printer is reached through an injected port, so the press path runs —
 * and is tested — with no renderer, no fonts and no printer behind it. (The
 * package's tests could not load `@oto/print` at all until SCRUM-223 moved
 * them to `--experimental-transform-types`; the port is the boundary either
 * way.)
 *
 * **The order of a press, and why it is that order.** The spin row is written
 * BEFORE the wheel animates, because a spin recorded and not shown is a
 * discrepancy somebody can reconcile, while a prize shown on a television and
 * recorded nowhere is a family at reception with a voucher the park has never
 * heard of. A write that fails therefore refuses the press (D7): failing to
 * entertain a child is the correct outcome when the record cannot be written.
 * And the spin's facts, its voucher, its print job and its daily counter
 * commit in ONE transaction, because every half-landing of that set is a real
 * failure somebody would have to unpick by hand.
 */

import { randomInt } from 'node:crypto';
import { z } from 'zod';

import {
  BOOTH_CODE_MINT_ATTEMPTS,
  BOOTH_CODE_PREFIX_LENGTH,
  BoothConfigBundleSchema,
  BoothDutyRosterSchema,
  addDaysToIsoDate,
  boothDutyLabel,
  boothVoucherSlip,
  isoDateInTz,
  mintBoothCode,
  businessDate as businessDateFor,
  parseDayStart,
  type BoothConfigBundle,
  type BoothConfigPrize,
  type BoothPrintState,
  type BoothReprintResponse,
  type SpinResponse,
} from '@oto/shared';
import type { PrintJob as RenderPrintJob } from '@oto/print';

import { cappedPrizeIds, drawPrize, judgePrizes, type RandomIndex } from './booth-draw';
import type { BoxStore, PrintJobRecord, QueuedFact } from './store';
import { BoxStoreFeatureMissingError } from './store';
import { sealEnvelope, uuidv7 } from './signing';
import { silentLog, type AgentLog } from './transport';

// --- What a booth is running ------------------------------------------------

/**
 * One booth's entry in the `booth` cache scope.
 *
 * **The cloud fills this scope**: `boothCacheItems` in the api's
 * `services/sync-booth.ts`, whose `BoothCacheItem` is the other half of this
 * schema, and the api's `booth-sync.test.ts` applies a real bundle through
 * the real agent to keep the two in step. This schema states what a booth
 * box needs in order to run a wheel, and the cloud has to produce exactly
 * this. It is declared here rather than in `@oto/shared` because only the
 * box reads it — `BoothConfigBundle` next door is the document three
 * surfaces share, and it is embedded whole below rather than restated.
 *
 * Four fields ride beside the bundle, and each is here because something the
 * box must do cannot be done without it:
 *
 *  - `version` — the bundle document deliberately does not carry its own
 *    publish number, and without it the television cannot check
 *    `SpinResponse.configVersion` against anything.
 *  - `configVersionId` — `booth.spin.booth_config_version_id` is NOT NULL and
 *    references the row, so the number alone will not write a spin.
 *  - `dutyRoster` — the day's booth staff (SCRUM-473): the trading day it is
 *    for, and every name on the booth that day with their account, when they
 *    have one. The voucher's Staff row prints the names merged into one
 *    label. Nobody signs in at the booth (SCRUM-694): the roster is the whole
 *    of the attribution. Optional: a cloud older than this field serves none,
 *    and a roster that cannot be read is dropped rather than taking the booth
 *    off the air — the slip then prints "unattributed".
 *  - `voucherDefinitions` — the terms and the expiry of the types the
 *    bundle's prizes point at, as they are now, refreshed at every pull. The
 *    bundle carries no type's expiry, so `resolveExpiry` reads it here when a
 *    prize names no days of its own. The bundle carries terms only for a type
 *    that had a title or an instruction when it was published (SCRUM-400),
 *    and `buildPrintJob` prints those; the terms here are what every other
 *    type prints.
 */
export const BoothVoucherDefinitionSchema = z.object({
  id: z.string().uuid(),
  /** `promo.voucher_definition.terms_en`. Null is a definition with no terms. */
  termsEn: z.string().nullable().default(null),
  termsTh: z.string().nullable().default(null),
  /** Null means this definition's vouchers never expire. */
  expiryDays: z.number().int().positive().nullable().default(null),
  /**
   * A fixed-code type's shared code: every slip prints it in place of the
   * minted code, which still identifies the win. Null (or a cloud older than
   * the field) prints the minted code.
   */
  fixedCode: z.string().nullable().default(null),
});
export type BoothVoucherDefinition = z.infer<typeof BoothVoucherDefinitionSchema>;

export const BoothCacheEntrySchema = z.object({
  stationId: z.string().uuid(),
  /** `booth.booth_config_version.id`. See above — the spin row needs the row. */
  configVersionId: z.string().uuid(),
  /** `booth.booth_config_version.version`: 1, 2, 3, one per publish. */
  version: z.number().int().positive(),
  /** SHA-256 over the canonical JSON of the bundle AS PUBLISHED, lower-case hex. */
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  bundle: BoothConfigBundleSchema,
  /**
   * See above. `.catch(null)`: a malformed roster is no roster, never a booth
   * off the air. An older cloud's `allowedStaff` beside it is stripped on
   * parse, never refused: this is a plain (non-strict) object.
   */
  dutyRoster: BoothDutyRosterSchema.nullable().default(null).catch(null),
  voucherDefinitions: z.array(BoothVoucherDefinitionSchema).default([]),
});
export type BoothCacheEntry = z.infer<typeof BoothCacheEntrySchema>;

/** The scope's payload as `syncCache` writes it: one object wrapping the items. */
const BoothCachePayloadSchema = z.object({ items: z.array(z.unknown()) });

// --- What the booth needs from the box it runs on ---------------------------

/** The booth station, as the box's config bundle describes it. */
export interface BoothStationContext {
  id: string;
  name: string;
  /** `core.station.code_prefix` — `B1`. The first two characters of every code. */
  codePrefix: string | null;
  /**
   * The printers assigned to this booth station in the Console, by device id
   * (SCRUM-419, closing audit L18). What the heartbeat reports the printer
   * from before the first voucher has been printed, so the corner and Health
   * read the probe the heartbeat already makes every minute rather than
   * `unknown` until somebody wins.
   */
  printerDeviceIds?: readonly string[];
}

/** The branch, which is what turns an instant into a trading day. */
export interface BoothBranchContext {
  id: string;
  operatorId: string;
  name: string;
  timezone: string;
  /** `branch.business_day_start`, `HH:MM` or `HH:MM:SS`. */
  businessDayStart: string;
}

/**
 * How a voucher reaches paper.
 *
 * A port rather than the print subsystem itself, for the reason at the top of
 * this file: the booth decides what goes on the paper and never renders it, so
 * the press path runs — and is tested — with no renderer, no fonts and no
 * printer behind it. The agent passes `printing.submit`; a test passes a
 * function that records what it was asked to print.
 */
export interface BoothPrintPort {
  /** Save a slip on the retry queue without printing while the wheel turns. */
  hold?(request: Parameters<BoothPrintPort['submit']>[0], until: Date): Promise<void>;
  submit(request: {
    id: string;
    kind: 'booth_voucher';
    job: RenderPrintJob;
    stationId: string | null;
    actionId: string | null;
    copies: number;
  }): Promise<BoothPrintSubmitOutcome>;
}

/** The part of a print outcome the booth reads. Structural, so the port is cheap to stand in for. */
export interface BoothPrintSubmitOutcome {
  id: string;
  status: 'queued' | 'printed' | 'failed' | 'skipped';
  attempts: number;
  deviceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** What the printers themselves last said. Absent means nobody has asked. */
export interface BoothPrinterHealth {
  reachability: 'unknown' | 'reachable' | 'unreachable';
  paperStatus: 'unknown' | 'ok' | 'low' | 'out';
}

export interface BoothOptions {
  boxId: string;
  store: BoxStore;
  /** The booth station on this box, or null when this box hosts none. */
  station: () => BoothStationContext | null;
  branch: () => BoothBranchContext | null;
  /**
   * The private half of this box's sync signing key, or null before
   * registration. A booth that cannot sign cannot queue a fact, and a press
   * that cannot be recorded is refused rather than shown.
   */
  privateKey: () => string | null;
  /** Null on a booth with no printer at all — a demo box, or a virtual one. */
  print?: BoothPrintPort | null;
  /** Measured health per device id. Never defaulted; see `heartbeat`. */
  printerHealth?: () => Record<string, BoothPrinterHealth>;
  /**
   * **Read by nothing, and kept only so the agent's wiring still compiles.**
   *
   * It used to feed the voucher's footer from a `booth_voucher` print
   * template, a type `pos.print_template` has never allowed, so the footer was
   * always empty. The booth's own settings carry the footer now, in the
   * published wheel (SCRUM-471, `voucherFooterText` → `boothVoucherSlip` in
   * `@oto/shared`). Remove it together with the agent's `printTemplates`
   * argument to `createBooth`.
   *
   * @deprecated The voucher slip comes from the published wheel.
   */
  printTemplates?: () => readonly { type: string; footerText?: string | null }[];
  /**
   * The draw's randomness (D3). `randomInt` from `node:crypto` by default —
   * uniform, and with the biased tail of its range rejected, which a
   * hand-rolled `byte % n` does not do. A test passes a counter or a seeded
   * generator; nothing passes `Math.random`.
   */
  randomIndex?: RandomIndex;
  /**
   * How long a press or a reprint waits on the printer before it answers
   * `queued`. `BOOTH_PRINT_WAIT_MS` unless a test needs a shorter wait.
   */
  printWaitMs?: number;
  /**
   * The box's clock, as the agent corrects it (SCRUM-402): the platform's
   * time once the box has measured itself in this boot, its own raw clock
   * until then. Every time the booth stamps, counts a day by or prints is
   * read from here.
   */
  now?: () => Date;
  /**
   * How the box's clock stands against the platform's, as the agent measured
   * it in this boot (SCRUM-402), or null when nothing has been measured since
   * the box booted.
   *
   * Absent is a booth run without an agent — this module's own tests — and
   * keeps the rule it had before: suspect only when the clock is behind a
   * time already lived through, and every press's time remembered.
   */
  clockStanding?: () => BoothClockStanding | null;
  log?: AgentLog;
}

/** See `BoothOptions.clockStanding`. */
export interface BoothClockStanding {
  /** The machine's clock minus the platform's, in ms; positive when it is ahead. */
  rawOffsetMs: number;
  /**
   * What is left after the correction `now` already applies: zero, unless the
   * test control has moved the raw clock since the last measurement.
   */
  residualMs: number;
}

// --- Policy numbers ---------------------------------------------------------

/** How often a booth looks for a newer published wheel. "About once a minute." */
export const BOOTH_CONFIG_REFRESH_MS = 60_000;

/**
 * How far the box's clock may be from the truth before a spin is flagged
 * (D11, SCRUM-402): behind a time the box has already lived through, or — as
 * the agent measured it against the platform in this boot — out in either
 * direction.
 *
 * A Pi with no clock battery does not come back from a power cut at the
 * moment it was switched off, or in 1970: Raspberry Pi OS Bookworm saves the
 * clock every minute, so the Pi comes back BEHIND by about the length of the
 * cut. That is not earlier than anything it lived through before the cut, so
 * the lived-through rule does not see it; the measurement on the next
 * heartbeat does. The booth's time is corrected from then on, and the spin is
 * still flagged, because the machine's own clock was that far out when it was
 * pressed. Ten minutes is wide enough that ordinary NTP correction does not
 * trip it.
 */
export const BOOTH_CLOCK_SUSPECT_MS = 10 * 60_000;

/** The `box_counter` scope holding "how many of this prize, today". */
export const BOOTH_PRIZE_COUNTER_SCOPE = 'booth_prize';
/** The `box_counter` scope holding "has this press already been recorded". */
export const BOOTH_PRESS_COUNTER_SCOPE = 'booth_press';
/**
 * The `box_counter` scope holding "how many spins this booth has given today"
 * — the whole booth, not one prize (SCRUM-257).
 *
 * A scope of its own rather than a reserved key inside `booth_prize`, because
 * the two answer different questions and one of them is read as a whole:
 * `readCounters(BOOTH_PRIZE_COUNTER_SCOPE, …)` is handed to the draw as the
 * per-prize usage map, and a "total" entry sitting in it would be read as a
 * prize nobody can find and would make `dailyCapsReached` name a prize that
 * does not exist. Keyed by STATION id, so a box that ever hosts two booths
 * counts each one's day separately rather than adding them together.
 */
export const BOOTH_SPIN_COUNTER_SCOPE = 'booth_spin';

/** How many press replies are kept in memory for a retry. See `spin`. */
const REPLAY_LIMIT = 64;

/**
 * How long a press, or a reprint, waits for its slip before it answers
 * (closing audit H1).
 *
 * The page gives up on a call after six seconds (`REQUEST_TIMEOUT_MS` in
 * `apps/booth/src/booth/client.ts`) and retries a press once. A press used to
 * wait for the printer however long it took, and a printer slow to answer —
 * one that does not reply to the status questions the box asks before and
 * after every job — made that wait longer than the page's: the television
 * said "Booth not ready" while the slip came out. Three seconds is half the
 * page's patience, which leaves the other half for the press's own writes and
 * the network, and it is far longer than a press takes with a printer that
 * answers (92 to 159 ms, measured in the closing audit). Past it the answer
 * is `queued`, the television shows the code and its QR, and the print goes
 * on as it would have — see `answerWithin`.
 */
export const BOOTH_PRINT_WAIT_MS = 3_000;

/** A page that stops during the animation still gets its saved slip on a later tick. */
export const BOOTH_PRINT_HOLD_MS = 30_000;

/**
 * Two letters or digits: the prefix `mintBoothCode` can print, after it has
 * upper-cased what it was given — the same rule, checked here BEFORE the draw
 * (closing audit H2) so that a station without one is refused by name rather
 * than failing inside the mint.
 */
const PRINTABLE_CODE_PREFIX = new RegExp(`^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}$`);

const HOUR_MS = 60 * 60_000;

/**
 * The last millisecond of a calendar date on a time zone's clock, as epoch
 * milliseconds — what a voucher's expiry is (closing audit M6; see
 * `resolveExpiry`).
 *
 * Found by halving rather than by adding an offset, because an offset is the
 * thing that changes on the days that would make one wrong: a zone that moves
 * its clocks has a day of 23 or 25 hours. The window is one every zone's end
 * of the date falls in — UTC offsets in use run from −12 to +14 hours, so the
 * start of the next date lies between 14 hours before and 12 hours after its
 * midnight in UTC — and each step asks one question of an instant: is it past
 * `isoDate` on this zone's calendar? At the window's start the answer is no
 * and at its end yes, and the halving keeps that true, so it ends on an
 * instant not past `isoDate` whose next millisecond is: a midnight ending the
 * date. (On a clock that goes back an hour across midnight the date ends
 * twice, and this finds one of the two.) About 27 halvings of the 28-hour
 * window; each is one formatting call on a cached formatter.
 */
function lastMomentOfDate(isoDate: string, timeZone: string): number {
  const nextMidnightUtc = Date.parse(`${addDaysToIsoDate(isoDate, 1)}T00:00:00.000Z`);
  let onTheDate = nextMidnightUtc - 15 * HOUR_MS;
  let pastIt = nextMidnightUtc + 13 * HOUR_MS;
  while (pastIt - onTheDate > 1) {
    const middle = Math.floor((onTheDate + pastIt) / 2);
    if (isoDateInTz(new Date(middle), timeZone) > isoDate) pastIt = middle;
    else onTheDate = middle;
  }
  return onTheDate;
}

// --- Refusals ---------------------------------------------------------------

/**
 * Why a press was refused.
 *
 * These are CODES, and the television maps each to its own copy — no message
 * written here reaches a screen in a shopping centre (D15). The page knows five
 * of them (`BOOTH_ERROR_CODES` in apps/booth/src/booth/contract.ts):
 * `not_configured`, `daily_spin_cap_reached` and `duplicate_press` have lines
 * of their own under the wheel, `nothing_to_reprint` on the staff panel's
 * Reprint, and `booth_not_ready` is said with the page's
 * fixed line, "Booth not ready — please call staff". `runtime_unavailable`
 * and `cannot_record` are not on its list and end on that same fixed line:
 * `#debug` shows only their status, and the box log says which it was, which
 * is where the difference belongs.
 */
export const BOOTH_REFUSAL_CODES = [
  /** No wheel has ever been published to this booth, or the cache holds none. */
  'not_configured',
  /**
   * D5: every prize is inactive, capped, out of stock or weighted zero. Also
   * a booth station whose code prefix is not two letters or digits, so no
   * voucher code can be made (closing audit H2): somebody has to fix the
   * station in the Console, which is what "please call staff" asks for. The
   * message says which of the two it is; the television reads only the code.
   */
  'booth_not_ready',
  /**
   * This booth has given away all the spins a manager allowed it for today
   * (SCRUM-257), and the day has not rolled over yet.
   *
   * **The television says something of its own about it**, rather than the
   * fixed "Booth not ready — please call staff", which is right when
   * something is wrong: a member of staff can act on it. Nothing is wrong
   * with a booth that has run its day, nobody can fix it, and calling staff
   * over would waste a family's time and a member of staff's — so the page
   * answers this one with "That's all the spins for today — come back
   * tomorrow" instead. The words live on the page
   * (`apps/booth/src/copy.ts`), like every other word a guest reads; what
   * travels from here is the code.
   */
  'daily_spin_cap_reached',
  /** The store cannot keep a daily counter, so a cap would silently not count. */
  'runtime_unavailable',
  /** No signing key yet, so nothing can be recorded — and D7 refuses the press. */
  'cannot_record',
  /**
   * This exact press was already recorded, and this process holds no record
   * of it to answer from: the box restarted since, or 64 newer presses have
   * pushed its answer out of memory. A retry that arrives while the press is
   * still being answered — still writing, or still waiting on the printer —
   * is not refused: it joins that press and gets its answer (closing audit
   * H1; see `spin`).
   */
  'duplicate_press',
  /** A reprint with nothing to reprint: no voucher yet, or not that spin's. */
  'nothing_to_reprint',
  'nothing_to_print',
] as const;
export type BoothRefusalCode = (typeof BOOTH_REFUSAL_CODES)[number];

export class BoothRefusal extends Error {
  readonly code: BoothRefusalCode;

  constructor(code: BoothRefusalCode, message: string) {
    super(message);
    this.name = 'BoothRefusal';
    this.code = code;
  }
}

// --- The module -------------------------------------------------------------

export interface BoothSpinRequest {
  /**
   * Draw, but change nothing: no spin row, no voucher, no print, no cap
   * consumed. The `#debug` distribution table sends it, and it runs through
   * THIS function rather than a second copy of the arithmetic (D16) — a table
   * generated by a separate implementation of the draw would measure the
   * separate implementation.
   */
  simulate?: boolean;
  /**
   * Minted where the button was pressed (D7).
   *
   * A network retry carrying the same key is one spin; a second press mints a
   * second key and is two. Required, so that the box's own surface is
   * unambiguous about it — `booth-http.ts` is where a request that arrives
   * without one is dealt with.
   */
  idempotencyKey: string;
  /** `x-oto-action-id`, carried booth -> box -> cloud. */
  actionId?: string | null;
}

export interface BoothStatusReport {
  online: boolean;
  neverSynced: boolean;
  configVersion: number | null;
  printerReachable: BoothPrinterHealth['reachability'];
  paperStatus: BoothPrinterHealth['paperStatus'];
  vouchersPending: number;
  lastSpinAt: string | null;
  dailyCapsReached: string[];
  /**
   * The label the slip would print now, for the corner of the television
   * (SCRUM-694): today's roster names merged ("Tom and Jerry"), or null when
   * nobody is on today's roster. Names only, as the corner already showed
   * under the owner's ruling of 24 September; never an account id.
   */
  dutyLabel: string | null;
}

/** The booth's trading day so far, counted on the box (SCRUM-419). */
export interface BoothDayCounts {
  businessDate: string;
  /** Spins drawn today — one per press that was not refused. */
  spins: number;
  /** Vouchers issued today, from the per-prize counters. */
  vouchers: number;
}

/** The heartbeat's booth block. Same fields, measured rather than defaulted. */
export interface BoothHeartbeatReport {
  configVersion: number | null;
  printerReachable: BoothPrinterHealth['reachability'];
  paperStatus: BoothPrinterHealth['paperStatus'];
  /** Vouchers minted here that the cloud has not acknowledged — see `pendingUnit`. */
  vouchersPending: number;
  /**
   * `vouchers` when the figure above counts vouchers (SCRUM-419, L16);
   * `events` on a store too old to count by type, where it is the whole
   * outbox. Health words the figure by this, never by guess.
   */
  pendingUnit: 'vouchers' | 'events';
  lastSpinAt: string | null;
  /**
   * Whether today's roster names anybody on this box (SCRUM-694): the slip
   * prints names when true and "unattributed" when false. A boolean, never
   * who.
   */
  rostered: boolean;
  /**
   * Retired by SCRUM-694, always false: nobody signs in at the booth. Sent
   * only so an api older than SCRUM-694, whose heartbeat schema requires the
   * field, still accepts the heartbeat. Drop it next round.
   */
  staffSignedIn: false;
  dailyCapsReached: string[];
  /** Null where there is no wheel or branch to count a day against. */
  today: BoothDayCounts | null;
}

export interface BoothReprintRequest {
  /** The spin whose voucher to print again. Absent: this booth's last one. */
  spinId?: string;
  actionId?: string | null;
}

export interface Booth {
  print?(request: { spinId: string; actionId?: string | null }): Promise<SpinResponse>;
  /** Adopt whatever the cache holds and pick up any vouchers still to print. */
  start(): Promise<void>;
  stop(): void;
  /** The wheel this booth is running, or null when none has ever been applied. */
  config(): { version: number; bundle: BoothConfigBundle } | null;
  /** Re-read the cache and apply a newer version whole. True when it changed. */
  refresh(): Promise<boolean>;
  spin(request: BoothSpinRequest): Promise<SpinResponse>;
  /**
   * Print the last voucher of this booth again, or a given spin's (SCRUM-223).
   *
   * The SAME code on new paper, marked "Reprint · <time>": no draw, no
   * counter, no second voucher, never a new prize. Anyone at the screen may
   * ask for one (SCRUM-694: nobody signs in at the booth), and the copy is
   * reported to the cloud as a `reprint` print of that voucher, with no
   * account. Optional in the type so a stand-in booth in a test need not grow
   * one; `createBooth` always has it, and the http contract answers 404 for a
   * booth without it.
   */
  reprint?(request: BoothReprintRequest): Promise<BoothReprintResponse>;
  status(opts: { online: boolean }): Promise<BoothStatusReport>;
  heartbeat(): Promise<BoothHeartbeatReport | null>;
  /**
   * Whether a print job belongs to this booth (D20).
   *
   * The agent asks before reporting an outcome to the cloud's print-result
   * route: a booth's outcomes travel as outbox FACTS instead, because an
   * offline booth cannot report against a cloud row that does not exist.
   */
  ownsPrintJob(jobId: string): boolean;
  /** Queue the outbox fact that says what became of a voucher's paper. */
  reportPrint(outcome: BoothPrintSubmitOutcome & { kind?: string }): Promise<void>;
  /**
   * Remember a time the box has good reason to believe in (D11).
   *
   * The agent calls it with the cloud's `serverTime` off every heartbeat ack,
   * and off a heartbeat refused for its clock or as stale (SCRUM-402). That
   * is what makes "the highest time this box has already lived through" a
   * statement about real time rather than about this box's own drift —
   * without it, a Pi whose clock is a day fast would simply believe itself.
   */
  noteCloudTime(at: string): Promise<void>;
}

/**
 * A voucher's paper this booth is responsible for reporting (D20), and why
 * it was printed: the first copy after a spin, or a copy somebody asked for.
 */
interface OwnedPrintJob {
  voucherId: string | null;
  voucherCode: string;
  reason: 'initial' | 'reprint';
  /**
   * The booth the voucher was won at, which is the station its outcome is
   * filed under (SCRUM-223). Not "the booth this box serves now": on a box
   * with several booths that can be a different one by the time the paper
   * comes out, or none at all — a restarted box prints its left-over slips
   * before anybody has chosen a booth on the television.
   */
  stationId: string | null;
}

/**
 * One voucher this booth issued, kept so it can be printed again (SCRUM-223).
 *
 * The print queue deletes a job once its paper is out, and the outbox is sent
 * and forgotten, so without this a reprint would have nothing to reprint. It
 * carries the renderer's input exactly as the first copy had it — the code,
 * the prize, the staff row — so a reprint cannot say anything the first slip
 * did not. Nothing personal about a guest is in it: a booth voucher names a
 * prize, a code and the member of staff on duty.
 */
interface RecentVoucher {
  spinId: string;
  voucherId: string;
  voucherCode: string;
  issuedAt: string;
  job: RenderPrintJob;
}

/** How many of the booth's last vouchers stay reprintable. */
const RECENT_VOUCHERS_KEPT = 10;

/** How many reported print jobs the booth still answers for (see `finishedPrintJobs`). */
const FINISHED_PRINT_JOBS_KEPT = 200;

/** `box_runtime` keys, per booth station. */
const recentVouchersKey = (stationId: string): string => `booth.recent_vouchers:${stationId}`;
/**
 * The `box_runtime` key under which one voucher code this box has minted is
 * remembered — one row per code, for as long as the card lasts (SCRUM-414).
 * Exported for the test that proves a repeat is drawn again.
 */
export const boothMintedCodeKey = (code: string): string => `booth.minted_code:${code}`;

/** What `createBooth` builds: a `Booth` whose reprint is always there. */
export type BoothModule = Booth & Required<Pick<Booth, 'reprint' | 'print'>>;

export function createBooth(options: BoothOptions): BoothModule {
  const { boxId, store } = options;
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? silentLog;
  const randomIndex: RandomIndex = options.randomIndex ?? ((max) => randomInt(max));
  const printWaitMs = options.printWaitMs ?? BOOTH_PRINT_WAIT_MS;

  let applied: BoothCacheEntry | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * When this booth was last played, as the box stamped it.
   *
   * In memory on purpose, and the contract says so: `BoothStatus.lastSpinAt`
   * is "null when this booth has not been played since it started". Nothing
   * about a report of today's activity needs to survive a power cut, and the
   * durable record of every spin is the outbox.
   */
  let lastSpinAt: string | null = null;
  /**
   * The printer the last voucher actually went to.
   *
   * A box may drive several printers, and `printerHealth` is keyed by device
   * id, so this is what stops the booth's television reporting the kitchen
   * printer's paper. Null until a voucher has been attempted, which reports
   * `unknown` — and that is true rather than convenient.
   */
  let lastPrintDeviceId: string | null = null;
  /**
   * The vouchers this booth has put on a printer, by print job id (D20).
   *
   * A Map rather than a Set of ids, and the values are the point: a print
   * outcome has to name the VOUCHER it printed. The job id is an
   * `edge.print_job` row minted on the box for a spin the cloud has not heard
   * about yet, so it names nothing the cloud can resolve — reporting it alone
   * is a fact that arrives and cannot be matched to anything.
   *
   * `voucherId` is known at the press. `voucherCode` is known then too AND is
   * on the stored print job, which is what lets a restarted box still say
   * which voucher a recovered job belongs to — see `adoptPendingPrintJobs`,
   * where the id is gone and the code is not.
   */
  const ownedPrintJobs = new Map<string, OwnedPrintJob>();
  /**
   * The jobs whose paper this booth has already reported, newest last, so it
   * still answers for them (SCRUM-223).
   *
   * A job ends once, and the print queue makes sure of that. But the agent
   * decides where an outcome goes by asking `ownsPrintJob`, and a booth that
   * forgot a job the moment its fact was queued would send any later outcome
   * for it — a second slip, as a queue that held one job twice once printed —
   * to the cloud's print-result route, against a row the cloud does not have,
   * while the spin itself may still be in the outbox (D20). Remembered here,
   * such an outcome is still a fact in the outbox, where the cloud files one
   * print per job however often a box reports it.
   *
   * The last `FINISHED_PRINT_JOBS_KEPT`, in memory: this is a guard, not a
   * record — the outbox is the record — and a restarted box's queue holds no
   * job that was finished before the restart, so there is nothing to guard.
   */
  const finishedPrintJobs = new Map<string, OwnedPrintJob>();
  /**
   * The answer to a press, kept so that a retry of the SAME press gets the
   * same answer rather than a second prize.
   *
   * **A promise, and it goes in when the press STARTS** (closing audit H1).
   * A retry therefore gets the answer whether it arrives after the press was
   * answered or while it is still being written or waiting on the printer —
   * it waits for the same promise. The answer used to go in only once the
   * slip had printed, so a page that gave up on a slow printer and retried
   * met the durable guard below and was refused `duplicate_press`, while the
   * slip came out anyway. A press that is refused is taken back out, so a
   * press refused for a write that failed can still be made by a retry.
   *
   * **In memory, and a restart forgets it.** That is not the whole of D7's
   * protection and is not claimed to be: the durable half is a counter row
   * written inside the spin's own transaction (`BOOTH_PRESS_COUNTER_SCOPE`),
   * which survives a restart and turns a repeat of a key this process can no
   * longer answer for into a refusal rather than a second voucher. So a retry
   * is replayed when the box has been up throughout, and refused when the box
   * restarted in between — never drawn again.
   */
  const replay = new Map<string, Promise<SpinResponse>>();
  /**
   * The reprint of each voucher still on its way to the printer, keyed by
   * station and spin (closing audit H1).
   *
   * A reprint asked for again while its copy is still printing joins that
   * copy rather than putting a second one on paper: nothing about the first
   * has failed yet, and another slip carrying the same live code is one more
   * for reception to tell apart. Taken out once the copy is out of the
   * printer's hands, so asking after that is a new copy, as it always was.
   */
  const reprintsInFlight = new Map<string, Promise<BoothReprintResponse>>();
  const pressSlips = new Map<
    string,
    {
      stationId: string;
      jobId: string;
      job: RenderPrintJob;
      response: SpinResponse;
      state: BoothPrintState | null;
      answer: Promise<SpinResponse> | null;
    }
  >();

  function note(
    level: 'info' | 'warn' | 'error',
    msg: string,
    detail: Record<string, unknown> = {},
  ): void {
    log[level]({ ...detail, boxId, module: 'booth' }, msg);
  }

  // --- Configuration ------------------------------------------------------

  /**
   * Read the `booth` cache scope and adopt a newer wheel WHOLE.
   *
   * Whole or not at all is the rule the bundle's own note states and the
   * reason it is hashed: half a prize list is a wheel whose odds do not add
   * up. An entry that does not parse is not partially adopted and does not
   * replace what is already running — a booth going on with last week's wheel
   * is a worse outcome than a booth stopping only in the sense that the odds
   * are stale, and a much better one than a booth drawing from a document it
   * half-understood.
   *
   * A LOWER version is not adopted. `booth_config_version` rows are immutable
   * and the current wheel is the highest version, so a lower one arriving
   * means the cache was rebuilt from behind; going backwards would silently
   * restore odds an administrator has already replaced.
   */
  async function refresh(): Promise<boolean> {
    const stationId = options.station()?.id ?? null;
    /**
     * The wheel belongs to ONE station, and the station can change under it
     * (SCRUM-223): a box with two booth stations runs whichever the kiosk's
     * picker chose. The old station's wheel is dropped the moment it is no
     * longer the one being served — otherwise a lower version for the new
     * station would be refused as "older than the wheel already running", and
     * the television would go on drawing the other booth's prizes under this
     * booth's prefix.
     */
    if (applied && applied.stationId !== stationId) {
      note('info', 'the booth station changed; the previous wheel is set aside', {
        from: applied.stationId,
        to: stationId,
      });
      applied = null;
      replay.clear();
    }
    /**
     * No station, no wheel. This used to adopt whichever entry came last in
     * the scope, which on a box with two booths and no choice made yet is a
     * wheel belonging to neither.
     */
    if (stationId === null) return false;
    const held = await store.readBundle(boxId, 'booth');
    if (!held) return false;
    const payload = BoothCachePayloadSchema.safeParse(held.payload);
    if (!payload.success) {
      note('warn', 'the booth cache scope did not carry an item list and was ignored');
      return false;
    }
    let adopted = false;
    for (const raw of payload.data.items) {
      const parsed = BoothCacheEntrySchema.safeParse(raw);
      if (!parsed.success) {
        // By name where there is one, so a publish that cannot be read is
        // traceable to a booth rather than to "an entry".
        note('warn', 'a booth cache entry could not be read and was not applied', {
          stationId: readStationId(raw),
          issue: parsed.error.issues[0]?.message ?? null,
        });
        continue;
      }
      const entry = parsed.data;
      // A box runs one booth at a time (see `BoothHeartbeatSchema`), but the
      // scope is free to carry an entry per booth station on the box, so the
      // box takes the one for the station it is serving.
      if (entry.stationId !== stationId) continue;
      if (applied && entry.version < applied.version) {
        note('warn', 'a booth cache entry was older than the wheel already running', {
          held: applied.version,
          offered: entry.version,
        });
        continue;
      }
      if (applied && entry.version === applied.version && entry.bundleHash === applied.bundleHash) {
        /**
         * The same wheel — and possibly a different roster for today or
         * different voucher terms beside it (SCRUM-223, SCRUM-473).
         *
         * Neither is part of the published bundle, so neither moves the
         * version: somebody added to today's staff in the Console reaches the
         * slip at the box's next pull, with no publish. The wheel is still
         * not touched; only what rides beside it is taken.
         */
        if (!sameSideData(applied, entry)) {
          applied = entry;
          note('info', "today's roster or the voucher terms were refreshed", {
            version: entry.version,
            rostered: entry.dutyRoster?.people.length ?? 0,
          });
        }
        continue;
      }
      applied = entry;
      adopted = true;
      note('info', 'a published wheel was applied', {
        version: entry.version,
        prizes: entry.bundle.prizes.length,
        bundleHash: entry.bundleHash.slice(0, 12),
      });
    }
    return adopted;
  }

  /** Today's roster and the voucher terms, compared as the box holds them. */
  function sameSideData(a: BoothCacheEntry, b: BoothCacheEntry): boolean {
    return (
      JSON.stringify(a.dutyRoster) === JSON.stringify(b.dutyRoster) &&
      JSON.stringify(a.voucherDefinitions) === JSON.stringify(b.voucherDefinitions)
    );
  }

  /**
   * The trading day by the box's corrected clock, for reading the roster — or
   * null when the branch is not known. A lighter read than `resolveClock`,
   * which a press uses: this one decides only whose names are today's, and a
   * clock read here is never stamped on anything.
   */
  function todayForRoster(): string | null {
    const branch = options.branch();
    if (!branch) return null;
    try {
      return businessDateFor(clock(), branch.timezone, parseDayStart(branch.businessDayStart));
    } catch {
      return null;
    }
  }

  /**
   * The label the slip would print now (SCRUM-694): today's roster names
   * merged, or null when there is no branch, no roster, or a roster for
   * another trading day — a box offline since yesterday names nobody today.
   * What the corner of the television and the heartbeat read; a press works
   * its own label out from the entry it drew under.
   */
  function currentDutyLabel(): string | null {
    return boothDutyLabel({ roster: applied?.dutyRoster ?? null, today: todayForRoster() ?? '' });
  }

  function readStationId(raw: unknown): string | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const value = (raw as { stationId?: unknown }).stationId;
    return typeof value === 'string' ? value : null;
  }

  function config(): { version: number; bundle: BoothConfigBundle } | null {
    return applied ? { version: applied.version, bundle: applied.bundle } : null;
  }

  // --- Time ---------------------------------------------------------------

  /**
   * What the box believes the time is, what trading day that falls in, and
   * whether either can be trusted (D11).
   *
   * Three separate answers, and conflating them is how a night's takings land
   * on the wrong date:
   *
   *  - `occurredAt` is the box's clock as the agent corrects it: the
   *    platform's time once the box has measured itself in this boot
   *    (SCRUM-402), the machine's own until then. The envelope keeps it as
   *    sent even when the cloud disbelieves it, which is the only honest thing
   *    to store.
   *  - `businessDate` is resolved from the LATER of that clock and the highest
   *    time this box has already lived through, so a booth that came up with
   *    a clock from before a power cut does not file today's spins on an
   *    earlier trading day, and the day never moves backwards.
   *  - `clockSuspect` says the two disagree by more than ten minutes, or that
   *    the machine's own clock was measured more than ten minutes out, so a
   *    day's figures that look wrong can be explained from the row itself.
   *  - `believable` says whether this time is worth remembering as lived
   *    through: only a time corrected by a measurement made in this boot, and
   *    not one the test control has since moved. A time read from a clock
   *    nobody has measured is exactly what the lived-through rule exists to
   *    doubt, and remembering it would let a clock that is AHEAD hold the
   *    trading day in the future after the correction arrives.
   *
   * **`business_date` is NOT NULL with no default**, so this fails loudly when
   * the branch is unknown rather than filing a late-night spin on whatever a
   * database would have guessed.
   */
  async function resolveClock(branch: BoothBranchContext): Promise<{
    occurredAt: string;
    stampMs: number;
    businessDate: string;
    clockSuspect: boolean;
    believable: boolean;
  }> {
    const nowMs = clock().getTime();
    const seenIso = await store.lastGoodTime(boxId);
    const seenMs = seenIso === null ? null : Date.parse(seenIso);
    const lived = seenMs !== null && Number.isFinite(seenMs) ? seenMs : null;
    const behindMs = lived === null ? 0 : lived - nowMs;
    const stampMs = lived !== null && lived > nowMs ? lived : nowMs;
    const dayStart = parseDayStart(branch.businessDayStart);
    // Undefined: a booth with no agent behind it. Null: an agent that has not
    // measured the clock in this boot.
    const standing = options.clockStanding ? options.clockStanding() : undefined;
    const measuredOut = !!standing && Math.abs(standing.rawOffsetMs) > BOOTH_CLOCK_SUSPECT_MS;
    return {
      occurredAt: new Date(nowMs).toISOString(),
      stampMs,
      businessDate: businessDateFor(new Date(stampMs), branch.timezone, dayStart),
      clockSuspect: behindMs > BOOTH_CLOCK_SUSPECT_MS || measuredOut,
      // Nothing has moved the raw clock since the measurement, to the second.
      believable: standing === undefined || (!!standing && Math.abs(standing.residualMs) < 1_000),
    };
  }

  /**
   * Remember a time this box has good reason to believe in.
   *
   * The agent calls it with the cloud's `serverTime` off every heartbeat ack,
   * and off a heartbeat refused for its clock or as stale (SCRUM-402), which
   * is what makes "the highest time already lived through" a statement about
   * real time rather than about this box's own drift. A press adds its own
   * time only when a measurement made in this boot corrected it
   * (`believable`). `markTimeSeen`
   * only ever moves forward, so a backwards value is a no-op rather than a
   * correction.
   */
  async function noteTime(at: string): Promise<void> {
    try {
      await store.markTimeSeen(boxId, at);
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return;
      throw err;
    }
  }

  // --- The press ----------------------------------------------------------

  /**
   * One press of the red button, answered once however often it arrives (D7).
   *
   * **A retry joins the press it repeats** (closing audit H1). The page mints
   * one key per press and sends it again when its first attempt goes
   * unanswered for six seconds. The press's own promise goes into `replay`
   * here, before anything is awaited, so the second arrival of a key — while
   * the first is still writing, or still waiting on the printer, or after it
   * has answered — waits for that same promise and gets that same answer.
   * Nothing between the lookup and the insertion awaits (`press` runs to its
   * own first `await` and hands back its promise), so two arrivals of one key
   * cannot both miss it. `duplicate_press` is left for a key this process
   * holds no record of: after a restart, or once newer presses have pushed it
   * out.
   *
   * A simulated press is never remembered: it records nothing, so there is
   * nothing a retry could be owed.
   */
  async function spin(request: BoothSpinRequest): Promise<SpinResponse> {
    const entry = applied;
    const station = options.station();
    const branch = options.branch();
    if (!entry || !station || !branch) {
      throw new BoothRefusal(
        'not_configured',
        'This booth has no published wheel, or the box has not applied its station configuration yet',
      );
    }
    if (!store.features().boothRuntime) {
      // Loudly, and before the draw. A cap that silently does not count looks
      // fine for a fortnight and then somebody has taken the cash prize twice
      // a day throughout.
      throw new BoothRefusal(
        'runtime_unavailable',
        'This box cannot keep a daily counter, so it will not draw a prize it could not cap',
      );
    }

    const held = replay.get(request.idempotencyKey);
    if (held) return held;
    if (request.simulate) return press(request, entry, station, branch);
    const pending = press(request, entry, station, branch);
    remember(request.idempotencyKey, pending);
    // A refused press is not an answer to keep: a retry of it is judged again.
    pending.catch(() => {
      if (replay.get(request.idempotencyKey) === pending) replay.delete(request.idempotencyKey);
    });
    return pending;
  }

  /** The press itself, once `spin` has made sure it is the only one running for its key. */
  async function press(
    request: BoothSpinRequest,
    entry: BoothCacheEntry,
    station: BoothStationContext,
    branch: BoothBranchContext,
  ): Promise<SpinResponse> {
    /**
     * A station whose code prefix is not two letters or digits cannot mint a
     * code (closing audit H2). A booth station saved with the field empty —
     * the Console's default before that audit — or with `PI1` in it reaches
     * the box as it was saved, and every press used to fail inside the mint
     * and come back a 500: "Booth not ready" on the television, with nothing
     * on the television, in the answer or in the Console saying why — only
     * the box log had the mint's error. So it is refused here, BEFORE the
     * draw and before the store is read or written, with the code the page
     * already shows for a booth staff must fix and a message that names the
     * prefix. What the station holds goes to the box log; the message itself
     * is a fixed line (D15). A simulated press is refused too: the `#debug`
     * table asks what a press would do now, and the honest answer is this
     * refusal.
     */
    const prefix = (station.codePrefix ?? '').toUpperCase();
    if (!PRINTABLE_CODE_PREFIX.test(prefix)) {
      note('warn', 'a press was refused: the booth station has no usable code prefix', {
        codePrefix: station.codePrefix,
      });
      throw new BoothRefusal(
        'booth_not_ready',
        "This booth station's code prefix is not two letters or digits, so no voucher code can be made; set the station's Code prefix in the Console (for example B1)",
      );
    }

    const timing = await resolveClock(branch);

    /**
     * "Spins per day", as a manager set it on the Console (SCRUM-257).
     *
     * Checked BEFORE the draw, so a booth that has run its day mints nothing
     * and draws nothing — and checked against the box's OWN count for the
     * trading day, which is the only count a booth in a mall with no internet
     * has. `dailySpinCap` rode in the published bundle from the first day and
     * was read by nothing; this is the whole of it being enforced.
     *
     * Null is no limit, and it is the common case: most booths run all day.
     *
     * **A simulated press is refused too**, though it consumes nothing. The
     * `#debug` distribution table asks "what would a press do now", and on a
     * booth that has reached its cap the honest answer is that it would be
     * refused — a table showing prizes still flowing would say the opposite of
     * what the red button does. The table already counts refusals for exactly
     * the same reason on a wheel whose every prize is capped.
     */
    const dailySpinCap = entry.bundle.settings.dailySpinCap;
    if (dailySpinCap !== null) {
      const given = await store.readCounter(boxId, {
        scope: BOOTH_SPIN_COUNTER_SCOPE,
        key: station.id,
        businessDate: timing.businessDate,
      });
      if (given >= dailySpinCap) {
        note('warn', 'a press was refused: this booth has reached its spins for the day', {
          businessDate: timing.businessDate,
          given,
          dailySpinCap,
        });
        throw new BoothRefusal(
          'daily_spin_cap_reached',
          'This booth has given away all the spins it is allowed today',
        );
      }
    }

    const counters = await store.readCounters(
      boxId,
      BOOTH_PRIZE_COUNTER_SCOPE,
      timing.businessDate,
    );
    const outcome = drawPrize(entry.bundle.prizes, randomIndex, { counters });
    if (!outcome.ok) {
      note('warn', 'a press was refused: nothing on the wheel can be won', {
        refusal: outcome.refusal,
        prizes: entry.bundle.prizes.length,
      });
      throw new BoothRefusal(
        'booth_not_ready',
        outcome.refusal === 'no_prizes'
          ? 'The published wheel has no prizes on it'
          : 'Every prize is inactive, capped or out of stock',
      );
    }

    /**
     * Who the slip names (SCRUM-694, D2/D3/D7): today's roster, from the
     * entry this press drew under — never `applied`, so a refresh in the
     * middle of a press cannot split the label from the wheel. Nobody signs
     * in at the booth. Any spin on the trading day gets the day's names,
     * whatever the time; nobody rostered is null, which prints "unattributed"
     * and never blocks the press. The account ids are the rostered people
     * who have one (a casual has none); they travel to the cloud only, never
     * to the television.
     */
    const staffLabel = boothDutyLabel({ roster: entry.dutyRoster, today: timing.businessDate });
    const dutyAccountIds =
      entry.dutyRoster?.date === timing.businessDate
        ? [...new Set(entry.dutyRoster.people.flatMap((p) => (p.accountId ? [p.accountId] : [])))]
        : [];

    if (request.simulate) {
      /**
       * A simulated press writes NOTHING: no spin, no voucher, no print, no
       * cap consumed, no counter moved (D16). What makes it a simulation is
       * that this booth is unchanged by it — and it reaches here through the
       * same eligibility, the same renormalisation and the same draw a real
       * press takes, which is the whole point of the distribution table.
       */
      return {
        spinId: uuidv7(timing.stampMs),
        prizeIndex: outcome.index,
        prizeId: outcome.prize.id,
        configVersion: entry.version,
        voucherCode: null,
        expiresAt: null,
        printState: 'no_printer',
        staffLabel,
        clockSuspect: timing.clockSuspect,
      };
    }

    const key = options.privateKey();
    if (!key) {
      // D7: a failed write refuses the press. A box with no signing key cannot
      // put a fact on disk that the cloud will ever accept, so drawing a prize
      // it could not record would be showing a child a voucher the park will
      // never have heard of.
      throw new BoothRefusal(
        'cannot_record',
        'This box has no signing key yet, so a spin cannot be recorded',
      );
    }

    const spinId = uuidv7(timing.stampMs);
    const voucherId = uuidv7(timing.stampMs);
    const printJobId = uuidv7(timing.stampMs);
    /**
     * Minted here, and drawn again when this box has minted the code before
     * (closing audit L15, SCRUM-414). The prefix is the one checked at the
     * top of the press.
     *
     * `mintBoothCode`'s note asks the CALLER to own the retry because only a
     * caller can see the repeat that makes one necessary. The cloud's
     * uniqueness is `promo.voucher (operator_id, code)`, and a collision
     * there is settled at sync by quarantining the loser and alerting on
     * both booths (D9) — never by a silent reassign, because the paper in a
     * visitor's hand is the authority. That left the second family holding a
     * slip which redeems as the first voucher, about three times a decade
     * per booth. So the box keeps every code it has minted — one
     * `box_runtime` row each, written in the spin's transaction below — and
     * `mintUnusedCode` asks that memory before the code reaches paper. It
     * knows this box's own codes only; two booths minting from one prefix
     * are what the Console's per-operator prefix rule rules out.
     */
    const voucherCode = await mintUnusedCode(prefix);
    const expiresAt = resolveExpiry(outcome.prize, timing.stampMs, branch.timezone);

    const spinFact: QueuedFact = {
      type: 'booth.spin_recorded',
      occurredAt: timing.occurredAt,
      stationId: station.id,
      actorKind: 'device',
      actorAccountId: null,
      actionId: request.actionId ?? null,
      payload: {
        spinId,
        boothConfigVersionId: entry.configVersionId,
        configVersion: entry.version,
        outcome: 'prize',
        prizeId: outcome.prize.id,
        voucherId,
        // The attribution (SCRUM-694): what the Staff row printed, and the
        // rostered accounts. Sent whatever `voucherShowStaff` says, because
        // attribution does not depend on paper.
        staffLabel,
        dutyAccountIds,
        clockSuspect: timing.clockSuspect,
        simulated: false,
        businessDate: timing.businessDate,
        occurredAt: timing.occurredAt,
      },
    };
    const voucherFact: QueuedFact = {
      type: 'promo.voucher_issued',
      occurredAt: timing.occurredAt,
      stationId: station.id,
      actorKind: 'device',
      actorAccountId: null,
      actionId: request.actionId ?? null,
      payload: {
        voucherId,
        spinId,
        code: voucherCode,
        source: 'booth',
        voucherDefinitionId: outcome.prize.voucherDefinitionId,
        prizeId: outcome.prize.id,
        costSatang: outcome.prize.costSatang,
        issuedAt: timing.occurredAt,
        expiresAt,
        businessDate: timing.businessDate,
      },
    };

    /**
     * The slip is built whether or not there is a printer, because it is also
     * what a reprint prints (SCRUM-223): the voucher is remembered with the
     * exact renderer input of its first copy, inside the spin's transaction.
     */
    const slip = buildPrintJob(printJobId, station, branch, {
      prize: outcome.prize,
      voucherCode,
      expiresAt,
      issuedAtMs: timing.stampMs,
      /**
       * Today's roster label (SCRUM-473, SCRUM-694): every name on today's
       * roster merged ("Tom and Jerry"), or null, which prints
       * "unattributed". The same value the spin fact carries, so the slip
       * and the attribution can never disagree.
       */
      staffLabel,
    });
    const heldUntil = new Date(Date.parse(timing.occurredAt) + BOOTH_PRINT_HOLD_MS);
    const printJob = options.print ? { ...slip, nextAttemptAt: heldUntil.toISOString() } : null;

    /**
     * One transaction: the facts, the print job and the counters commit
     * together or not at all.
     *
     * Every half-landing of this set is something a person would have to
     * reconcile by hand — a counter that moved for a spin with no voucher, a
     * voucher with nothing to print it, a print job for a spin the cloud will
     * never hear about. The printer itself is NOT touched in here: opening a
     * socket inside a transaction would hold it open for as long as a roll of
     * paper takes, and a print that fails must not undo a spin that happened.
     */
    try {
      await store.atomically(async (tx) => {
        /**
         * The durable half of D7, and it goes FIRST so that a duplicate costs
         * nothing else. `bumpCounter` is one statement, so two presses in the
         * same instant cannot both read zero: exactly one of them gets 1 back.
         * Anything else means this key has already been recorded — by a retry
         * this process can no longer answer for, since the in-memory replay
         * was checked above — and the press is refused rather than drawn
         * again.
         */
        /**
         * Yesterday is checked too, and that is not belt-and-braces.
         *
         * A counter row is keyed by trading day, so a retry that arrives after
         * the day rolled over — 05:00 on the branch's wall clock — would look
         * at an empty row for the new day and draw a second prize for one
         * press. One extra read closes the boundary, and without it the
         * sentence above would be true of every press except the ones nobody
         * would think to test.
         */
        const yesterday = await tx.readCounter(boxId, {
          scope: BOOTH_PRESS_COUNTER_SCOPE,
          key: request.idempotencyKey,
          businessDate: addDaysToIsoDate(timing.businessDate, -1),
        });
        const presses = await tx.bumpCounter(
          boxId,
          {
            scope: BOOTH_PRESS_COUNTER_SCOPE,
            key: request.idempotencyKey,
            businessDate: timing.businessDate,
          },
          1,
          timing.occurredAt,
        );
        if (presses !== 1 || yesterday > 0) {
          throw new BoothRefusal(
            'duplicate_press',
            'This press was already recorded; the box will not draw a second prize for it',
          );
        }
        /**
         * The day's spin, counted where it cannot be counted twice — and the
         * cap tested again on the value the counter came back with.
         *
         * The read before the draw is what keeps the ordinary refusal cheap;
         * THIS is what makes the cap exact. `bumpCounter` is one statement, so
         * two presses arriving together cannot both read "one short of the
         * cap" and both be allowed: one of them gets the number that is over
         * it, throws, and the transaction takes its press row, its facts and
         * this increment back out with it. A booth has one button and that
         * race is unlikely; a cap that can be stepped over by pressing twice
         * quickly is not a cap.
         *
         * The increment belongs to the SPIN, not to the press: a refusal above
         * never reaches here, and a duplicate press is turned away by the
         * guard a few lines up, so neither moves the day's count.
         */
        const given = await tx.bumpCounter(
          boxId,
          {
            scope: BOOTH_SPIN_COUNTER_SCOPE,
            key: station.id,
            businessDate: timing.businessDate,
          },
          1,
          timing.occurredAt,
        );
        if (dailySpinCap !== null && given > dailySpinCap) {
          throw new BoothRefusal(
            'daily_spin_cap_reached',
            'This booth has given away all the spins it is allowed today',
          );
        }
        await tx.enqueueMany(
          boxId,
          [spinFact, voucherFact],
          (draft) => sealEnvelope(draft, boxId, key),
          timing.occurredAt,
        );
        await tx.bumpCounter(
          boxId,
          {
            scope: BOOTH_PRIZE_COUNTER_SCOPE,
            key: outcome.prize.id,
            businessDate: timing.businessDate,
          },
          1,
          timing.occurredAt,
        );
        if (printJob) await tx.putPrintJob(printJob);
        await rememberVoucher(tx, station.id, {
          spinId,
          voucherId,
          voucherCode,
          issuedAt: timing.occurredAt,
          job: slip.job,
        });
        // The code joins this box's memory of what it has minted, in the same
        // transaction as the voucher it is on (SCRUM-414).
        await tx.writeRuntimeValue(
          boxId,
          boothMintedCodeKey(voucherCode),
          spinId,
          timing.occurredAt,
        );
      });
    } catch (err) {
      if (err instanceof BoothRefusal) throw err;
      note('error', 'a spin could not be written, so the press was refused', { err: String(err) });
      throw new BoothRefusal(
        'cannot_record',
        'This spin could not be written down, so no prize was drawn',
      );
    }

    // The spin is on disk from here. Everything below is about paper.
    lastSpinAt = timing.occurredAt;
    if (timing.believable) await noteTime(timing.occurredAt);

    const response: SpinResponse = {
      spinId,
      prizeIndex: outcome.index,
      prizeId: outcome.prize.id,
      configVersion: entry.version,
      ...(slip.job.kind === 'booth_voucher' && slip.job.data.legacyQrPayload
        ? { qrPayload: slip.job.data.legacyQrPayload } : {}),
      // The code the family is handed: a fixed-code type's shared code, as on the slip.
      voucherCode:
        applied?.voucherDefinitions.find(
          (candidate) => candidate.id === outcome.prize.voucherDefinitionId,
        )?.fixedCode ?? voucherCode,
      expiresAt,
      printState: printJob ? 'queued' : 'no_printer',
      staffLabel,
      clockSuspect: timing.clockSuspect,
    };
    const port = options.print;
    pressSlips.set(spinId, {
      stationId: station.id,
      jobId: printJobId,
      job: slip.job,
      response,
      state: null,
      answer: null,
    });
    while (pressSlips.size > REPLAY_LIMIT) {
      const oldest = pressSlips.keys().next();
      if (!oldest.done) pressSlips.delete(oldest.value);
    }
    if (printJob && port) {
      ownedPrintJobs.set(printJobId, {
        voucherId,
        voucherCode,
        reason: 'initial',
        stationId: station.id,
      });
      // The durable job is already saved. Holding never opens the printer.
      await port
        .hold?.(
          {
            id: printJobId,
            kind: 'booth_voucher',
            job: printJob.job,
            stationId: station.id,
            actionId: request.actionId ?? null,
            copies: 1,
          },
          heldUntil,
        )
        .catch(() => {
          note('warn', 'the voucher waits on the card for the print queue', { jobId: printJobId });
        });
    }

    // `spin` put this press's promise in `replay` when it started; the answer
    // is kept by that, not by anything here.
    return response;
  }

  async function print(request: {
    spinId: string;
    actionId?: string | null;
  }): Promise<SpinResponse> {
    const slip = pressSlips.get(request.spinId);
    if (!slip || slip.stationId !== options.station()?.id) {
      throw new BoothRefusal('nothing_to_print', 'This booth holds no slip for that spin');
    }
    if (slip.answer) return slip.answer;
    const port = options.print;
    const ended = slip.state !== null && slip.state !== 'queued' ? slip.state : null;
    const outcome =
      ended !== null || !port
        ? Promise.resolve(ended ?? 'no_printer')
        : answerWithin(
            attemptPrint(port, slip.jobId, slip.job, slip.stationId, request.actionId ?? null),
            { spinId: request.spinId, jobId: slip.jobId },
          );
    // Keep the first answer, including a bounded wait's queued outcome.
    slip.answer = outcome.then((printState) => ({ ...slip.response, printState }));
    return slip.answer;
  }

  /**
   * A code this box has not minted before.
   *
   * Each draw is `mintBoothCode`'s — uniform, check character and all — and
   * one that this box's memory already holds is drawn again, up to
   * `BOOTH_CODE_MINT_ATTEMPTS` times. A working random source repeats a
   * code about three times a decade and never twice running, so the bound
   * is only ever met by a source that is not random, and that is refused
   * rather than printed. The code itself is not logged: it is on a slip in
   * somebody's hand.
   */
  async function mintUnusedCode(prefix: string): Promise<string> {
    for (let attempt = 1; attempt <= BOOTH_CODE_MINT_ATTEMPTS; attempt += 1) {
      const code = mintBoothCode(prefix, randomIndex);
      if ((await store.readRuntimeValue(boxId, boothMintedCodeKey(code))) === null) return code;
      note('warn', 'a minted voucher code repeats one this box has minted before; drawing again', {
        attempt,
      });
    }
    throw new Error(
      `${BOOTH_CODE_MINT_ATTEMPTS} draws in a row repeated codes this box had already minted — the random source is not random`,
    );
  }

  function remember(key: string, response: Promise<SpinResponse>): void {
    replay.set(key, response);
    // Oldest out first. A Map iterates in insertion order, so this is the
    // press before last rather than an arbitrary one.
    while (replay.size > REPLAY_LIMIT) {
      const oldest = replay.keys().next();
      if (oldest.done) break;
      replay.delete(oldest.value);
    }
  }

  /**
   * Hand the voucher to the printer and say what became of it.
   *
   * A throw here is NOT a failed spin. The job row is on disk, committed with
   * the spin, and the print queue's own retry tick will pick it up — so the
   * honest answer to the television is `queued`, which is what it says when a
   * printer is out of paper too. It therefore never rejects, which is what
   * lets `answerWithin` answer before it has finished and leave it running.
   */
  async function attemptPrint(
    port: BoothPrintPort,
    jobId: string,
    job: RenderPrintJob,
    stationId: string,
    actionId: string | null,
  ): Promise<BoothPrintState> {
    try {
      const outcome = await port.submit({
        id: jobId,
        kind: 'booth_voucher',
        job,
        stationId,
        actionId,
        copies: 1,
      });
      if (outcome.deviceId) lastPrintDeviceId = outcome.deviceId;
      return printStateFor(outcome.status);
    } catch (err) {
      note('warn', 'the voucher could not be handed to a printer; it stays queued', {
        jobId,
        err: String(err),
      });
      return 'queued';
    }
  }

  /**
   * What became of the paper, waiting no longer than `printWaitMs` to find
   * out (closing audit H1; see `BOOTH_PRINT_WAIT_MS`).
   *
   * Past the wait the answer is `queued` — the state of a slip a printer has
   * not produced yet, on which the television shows the code and its QR, as
   * it does for a printer that is out of paper. The print is NOT abandoned:
   * `printing` goes on exactly as it would have, and its outcome reaches the
   * outbox through the print queue, as every outcome does (`reportPrint`).
   * `printing` never rejects (`attemptPrint`), so nothing is left unhandled
   * behind the answer.
   */
  async function answerWithin(
    printing: Promise<BoothPrintState>,
    detail: Record<string, unknown>,
  ): Promise<BoothPrintState> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), printWaitMs);
    });
    try {
      const state = await Promise.race([printing, waited]);
      if (state !== null) return state;
      note(
        'warn',
        'the printer had not finished in time, so the answer is "queued"; the print goes on',
        { ...detail, waitedMs: printWaitMs },
      );
      return 'queued';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `skipped` becomes `no_printer`, which is the one mapping worth stating.
   *
   * The print subsystem skips a job when no station on this box has a printer
   * for its role, or when the device it was queued for has since been removed.
   * Neither is a fault and nobody can fix either by waiting, so the television
   * shows the code and the QR instead of a printer error — which is exactly
   * what `no_printer` means in the frozen contract.
   */
  function printStateFor(status: BoothPrintSubmitOutcome['status']): BoothPrintState {
    switch (status) {
      case 'printed':
        return 'printed';
      case 'queued':
        return 'queued';
      case 'failed':
        return 'failed';
      case 'skipped':
        return 'no_printer';
    }
  }

  // --- The voucher on paper ------------------------------------------------

  /**
   * When this voucher runs out, or null: the END of the date its slip prints,
   * on the branch's clock (closing audit M6; the owner's answer, 25
   * September).
   *
   * The slip, the television and the till show the expiry as a date and
   * nothing else — "Expires 09 Oct 2026" — which reads as "through the 9th".
   * It used to be the moment of the win plus N × 24 hours, so a voucher won at
   * 15:00 was refused at 16:00 on the day it names, and two slips carrying
   * the same date got different answers at 11:00 that day. It is now the last
   * millisecond of that date in the branch's time zone: the calendar date of
   * the win there, plus N days. In a zone that keeps one offset all year, as
   * Bangkok does, the date printed is the one it always was — only the moment
   * within it moves, to its end. The branch's time zone is on the box, so
   * this needs no internet. The calendar date and not the
   * trading day, because the slip prints the calendar date: a voucher won at
   * 00:30 belongs to the previous trading day, and it still runs to the end
   * of the date printed on it. Slips already printed keep the moment they
   * were issued with, because the cloud compares against whatever moment the
   * box sent.
   *
   * **The published bundle cannot always answer the days, and the box does
   * not guess.** `booth_prize.expiry_days` is an OVERRIDE — null means "take the
   * definition's" — and the bundle carries no definition's expiry: its
   * `voucherDefinitions` hold only the words of a type that had a title or
   * an instruction when the wheel was published (SCRUM-400). So the
   * expiries travel beside it in the cache entry, refreshed at every pull,
   * and the prize's type's `expiryDays` is taken from there: a type's
   * changed expiry applies to vouchers won after the box's next pull, with
   * no publish.
   *
   * Null is a designed answer: a type set to never expire, under a prize with
   * no days of its own, prints "No expiry" (owner, 24 September; the publish
   * no longer refuses such a prize). The cloud sends every type the running
   * wheel's prizes point at, archived ones included (`boothCacheItems` in the
   * api's `services/sync-booth.ts`). An entry with no `voucherDefinitions` at
   * all — from a cloud older than that, or a test that caches none — has
   * nothing to read: a prize with no days of its own comes out as null and
   * prints "No expiry", and a type with no words in the bundle prints no
   * terms (`buildPrintJob`).
   */
  function resolveExpiry(
    prize: BoothConfigPrize,
    stampMs: number,
    timeZone: string,
  ): string | null {
    const definition = applied?.voucherDefinitions.find(
      (candidate) => candidate.id === prize.voucherDefinitionId,
    );
    const days = prize.expiryDays ?? definition?.expiryDays ?? null;
    if (days === null) return null;
    const wonOn = isoDateInTz(new Date(stampMs), timeZone);
    return new Date(lastMomentOfDate(addDaysToIsoDate(wonOn, days), timeZone)).toISOString();
  }

  /**
   * Build the renderer's input for one voucher.
   *
   * Every string the slip carries is resolved HERE, on the box, from the
   * cached bundle — not by the printer and not by the cloud — because the
   * whole claim of this ticket is that a booth with no internet prints a
   * voucher the park will honour.
   *
   * The fields are required-and-nullable throughout, which is `BoothVoucherData`'s
   * own rule: a caller has to write the word `null` for the Thai name it does
   * not have, and the template prints a visible answer for it, rather than a
   * slip silently coming out a row short.
   */
  function buildPrintJob(
    jobId: string,
    station: BoothStationContext,
    branch: BoothBranchContext,
    detail: {
      prize: BoothConfigPrize;
      voucherCode: string;
      expiresAt: string | null;
      issuedAtMs: number;
      /** Today's roster label, "Tom and Jerry", or null, which prints "unattributed". */
      staffLabel: string | null;
    },
  ): PrintJobRecord {
    /**
     * The park's own words for this prize's voucher type, as the published
     * wheel froze them (SCRUM-400): the title, the instruction AND the terms,
     * all from the version the box is running. So a version says what its
     * slips said, and an edit to any of the three reaches paper at the
     * booth's next publish, not at the box's next pull.
     *
     * Only a type somebody has worded (a title or an instruction) has an
     * entry. Without one the slip is what it always was: the prize's own
     * names, the generic line, and the terms from the cache scope beside the
     * bundle, which every pull refreshes. A booth nobody has set up therefore
     * prints exactly what it printed before.
     */
    const words = applied?.bundle.voucherDefinitions?.find(
      (w) => w.id === detail.prize.voucherDefinitionId,
    );
    const termsFrom =
      words ??
      applied?.voucherDefinitions.find(
        (candidate) => candidate.id === detail.prize.voucherDefinitionId,
      );
    /**
     * The booth's own slip (SCRUM-471): logo, header line, footer line, Staff
     * row and terms, as the running version published them — so, like the
     * words above, a change reaches paper at the booth's next publish. A
     * bundle published before the fields existed carries none of them and
     * resolves to the slip every booth printed before.
     *
     * Written into the job in full rather than left for the renderer to
     * default, so a reprint — which prints the remembered job — is the same
     * slip as its first copy even after the booth's next publish.
     */
    const slip = boothVoucherSlip(applied?.bundle.settings ?? {});
    const job: RenderPrintJob = {
      kind: 'booth_voucher',
      data: {
        venueLine: branch.name,
        prizeLine: words?.titleEn ?? detail.prize.nameEn,
        prizeLineThai: words?.titleTh ?? detail.prize.nameTh,
        redemptionLine:
          [words?.instructionEn, words?.instructionTh].filter(Boolean).join('\n') ||
          `Show this QR at OTO Reception to claim: ${detail.prize.nameEn}.`,
        /**
         * The type's terms, split a line each, printed at the foot of the
         * slip (SCRUM-223): the running version's for a type it carries
         * words for, the cache's for any other (see `words` above). An
         * empty array is a real value and prints no terms at all: that is a
         * definition with no terms, and the place to fix it is the
         * definition.
         */
        terms: splitTerms(termsFrom),
        termsEn: splitTermBlock(termsFrom?.termsEn),
        termsTh: splitTermBlock(termsFrom?.termsTh),
        legacyQrPayload: words?.legacyQrPayload ?? null,
        voucherCode:
          applied?.voucherDefinitions.find(
            (candidate) => candidate.id === detail.prize.voucherDefinitionId,
          )?.fixedCode ?? detail.voucherCode,
        codeMode: applied?.voucherDefinitions.some(
          (candidate) =>
            candidate.id === detail.prize.voucherDefinitionId && candidate.fixedCode !== null,
        ) ? 'fixed' : 'generated',
        issuedAt: formatStamp(new Date(detail.issuedAtMs), branch.timezone),
        issuedDate: formatStamp(new Date(detail.issuedAtMs), branch.timezone, { time: false }),
        booth: `${branch.name} · ${station.name}`,
        /**
         * Today's roster label — "Tom and Jerry" — from Console → Booths →
         * Today's staff (SCRUM-694), or null, which the template prints as
         * "unattributed": nobody was on today's roster and the slip says so.
         * No account id is ever printed.
         */
        staff: detail.staffLabel,
        expiresAt:
          detail.expiresAt === null
            ? null
            : formatStamp(new Date(detail.expiresAt), branch.timezone, { time: false }),
        footerLine: slip.footerText ?? '',
        showLogo: slip.showLogo,
        headerLine: slip.headerText,
        showStaff: slip.showStaff,
        showTerms: slip.showTerms,
        design: slip.design,
      },
    };
    const nowIso = new Date(detail.issuedAtMs).toISOString();
    return {
      id: jobId,
      boxId,
      kind: 'booth_voucher',
      role: 'receipt',
      stationId: station.id,
      deviceId: null,
      copies: 1,
      job,
      finish: null,
      templateId: null,
      templateVersion: null,
      actionId: null,
      state: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      queuedAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /** A published entry's terms or a cached definition's: the same two fields. */
  function splitTermBlock(block: string | null | undefined): string[] {
    return block?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  }

  function splitTerms(
    source: { termsEn?: string | null; termsTh?: string | null } | undefined,
  ): string[] {
    return [...splitTermBlock(source?.termsEn), ...splitTermBlock(source?.termsTh)];
  }

  /**
   * Keep this voucher reprintable: newest first, the last few only.
   *
   * Written inside the spin's own transaction, so a voucher that exists is a
   * voucher that can be printed again — and one that was rolled back is not
   * on the list. A list that no longer parses is started again rather than
   * failing the spin: losing the chance to reprint an old slip is a far
   * smaller thing than refusing a child's press.
   */
  async function rememberVoucher(tx: BoxStore, stationId: string, voucher: RecentVoucher): Promise<void> {
    const held = await readRecentVouchers(stationId, tx);
    const next = [voucher, ...held.filter((v) => v.spinId !== voucher.spinId)].slice(
      0,
      RECENT_VOUCHERS_KEPT,
    );
    await tx.writeRuntimeValue(boxId, recentVouchersKey(stationId), JSON.stringify(next), voucher.issuedAt);
  }

  async function readRecentVouchers(stationId: string, from: BoxStore = store): Promise<RecentVoucher[]> {
    const raw = await from.readRuntimeValue(boxId, recentVouchersKey(stationId));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (v): v is RecentVoucher =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as RecentVoucher).spinId === 'string' &&
          typeof (v as RecentVoucher).voucherCode === 'string' &&
          typeof (v as RecentVoucher).job === 'object',
      );
    } catch {
      note('warn', 'the list of reprintable vouchers could not be read and was started again');
      return [];
    }
  }

  /**
   * The same slip, marked as a copy.
   *
   * Everything the first copy said is kept — the code above all, and the
   * member of staff who was on duty when it was WON — and one line is added
   * saying when this copy was made. Reception holding two slips with one code
   * can then see which is the reprint; the code is single-use whichever is
   * scanned first.
   */
  function reprintedJob(job: RenderPrintJob, timeZone: string, at: Date): RenderPrintJob {
    if (job.kind !== 'booth_voucher') return job;
    return {
      ...job,
      data: { ...job.data, reprintNote: `Reprint · ${formatStamp(at, timeZone)}` },
    };
  }

  async function reprint(request: BoothReprintRequest): Promise<BoothReprintResponse> {
    const station = options.station();
    if (!station) {
      throw new BoothRefusal('not_configured', 'This box is not serving a booth station');
    }
    let recent: RecentVoucher[] = [];
    try {
      recent = await readRecentVouchers(station.id);
    } catch (err) {
      if (!(err instanceof BoxStoreFeatureMissingError)) throw err;
    }
    const target = request.spinId
      ? recent.find((v) => v.spinId === request.spinId)
      : recent[0];
    if (!target) {
      throw new BoothRefusal('nothing_to_reprint', 'There is no voucher to print again');
    }

    /**
     * A copy of this voucher still on its way to the printer: this request
     * joins it rather than putting another on paper (closing audit H1). The
     * lookup and the `set` below have no `await` between them, so two
     * requests that got this far together cannot both miss it.
     */
    const inFlightKey = `${station.id}:${target.spinId}`;
    const copyOnItsWay = reprintsInFlight.get(inFlightKey);
    if (copyOnItsWay) {
      note(
        'info',
        'a reprint was asked for while a copy of that voucher was still printing; it joins that copy',
        { spinId: target.spinId },
      );
      return copyOnItsWay;
    }

    const now = clock();
    const jobId = uuidv7(now.getTime());
    const job = reprintedJob(target.job, options.branch()?.timezone ?? 'UTC', now);
    /**
     * Owned before it is submitted, so the outcome — whenever it comes — is
     * reported as a REPRINT of this voucher, with no account (anyone at the
     * screen may ask for one since SCRUM-694), and never through the cloud's
     * print route (D20). No counter moves and no fact about a spin or a
     * voucher is queued: the only record a reprint makes is the print itself,
     * which is what the cloud counts copies from.
     */
    ownedPrintJobs.set(jobId, {
      voucherId: target.voucherId,
      voucherCode: target.voucherCode,
      reason: 'reprint',
      stationId: station.id,
    });
    const port = options.print;
    if (!port) {
      // No printer to put it on. The attempt is still recorded, as a skipped
      // print, so the cloud knows a copy was asked for.
      await reportPrint({
        id: jobId,
        status: 'skipped',
        attempts: 0,
        deviceId: null,
        errorCode: 'NO_PRINTER',
        errorMessage: null,
      });
      note('info', 'a voucher was printed again at the booth', {
        spinId: target.spinId,
        printState: 'no_printer',
      });
      return { spinId: target.spinId, printState: 'no_printer' };
    }

    /**
     * The answer waits `printWaitMs` at most, like a press's: the panel gives
     * up on a call after six seconds, and a reprint that outlasted it read
     * "The reprint did not go through" while the copy came out (closing
     * audit H1). The copy stays in `reprintsInFlight` until the printer is
     * done with it, not merely until the answer.
     */
    const copy = attemptPrint(port, jobId, job, station.id, request.actionId ?? null);
    const answer = answerWithin(copy, { spinId: target.spinId, jobId }).then(
      (printState): BoothReprintResponse => {
        note('info', 'a voucher was printed again at the booth', {
          spinId: target.spinId,
          printState,
        });
        return { spinId: target.spinId, printState };
      },
    );
    reprintsInFlight.set(inFlightKey, answer);
    void copy.then(() => {
      if (reprintsInFlight.get(inFlightKey) === answer) reprintsInFlight.delete(inFlightKey);
    });
    return answer;
  }

  /**
   * A time on the slip, in the BRANCH's timezone.
   *
   * `@oto/print` owns no clock — a booth box has no real-time clock to own one
   * with — so the caller formats, and the caller is here. `en-GB` is named
   * because a tag is required and this is the one that produces "21 Sep 2026"
   * rather than "Sep 21, 2026"; the sample voucher in the device inventory is
   * written the first way.
   */
  function formatStamp(at: Date, timeZone: string, opts?: { time?: boolean }): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      ...(opts?.time === false ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    })
      .format(at)
      .replace(',', '');
  }

  // --- Print outcomes, as facts (D20) --------------------------------------

  function ownsPrintJob(jobId: string): boolean {
    return ownedPrintJobs.has(jobId) || finishedPrintJobs.has(jobId);
  }

  /**
   * Say what became of a voucher's paper, as an outbox fact.
   *
   * NOT through the cloud's print-result route, which is the whole of D20: an
   * offline booth cannot report against a cloud row that does not exist,
   * because the row is created from the spin this box has not managed to send
   * yet. As a fact it queues behind the spin and the voucher and arrives in
   * the right order whenever the link comes back.
   */
  async function reportPrint(outcome: BoothPrintSubmitOutcome): Promise<void> {
    for (const slip of pressSlips.values()) {
      if (slip.jobId === outcome.id) slip.state = printStateFor(outcome.status);
    }
    const finished = finishedPrintJobs.get(outcome.id);
    const printed = ownedPrintJobs.get(outcome.id) ?? finished;
    if (!printed) return;
    if (finished && !ownedPrintJobs.has(outcome.id)) {
      // Not supposed to happen: a job ends once. Queued all the same, because
      // the one wrong place for it is the cloud's print route (see
      // `finishedPrintJobs`), and said, because it means a slip came out twice.
      note('warn', 'a booth print job was reported again after it had ended', {
        jobId: outcome.id,
        status: outcome.status,
      });
    }
    const key = options.privateKey();
    // The voucher's own booth; the one served now only for a job raised
    // before jobs remembered theirs.
    const stationId = printed.stationId ?? options.station()?.id ?? null;
    if (!key || !stationId) {
      note('warn', 'a booth print outcome has no booth to be filed under and was not sent', {
        jobId: outcome.id,
        status: outcome.status,
      });
      return;
    }
    const nowIso = clock().toISOString();
    try {
      await store.enqueue(
        boxId,
        {
          type: 'booth.voucher_printed',
          occurredAt: nowIso,
          stationId,
          actorKind: 'box',
          payload: {
            /**
             * **The voucher, named, and this is the load-bearing part.**
             *
             * `printJobId` below is an `edge.print_job` row on the BOX, for a
             * spin the cloud may not have received yet — it resolves to
             * nothing on the other side, so an outcome carrying only that is a
             * fact that arrives and cannot be matched to the voucher it is
             * about. The id is present when this process raised the job; the
             * CODE is present either way, because it is on the stored job and
             * so survives the restart that loses the id.
             */
            // Left out, never sent as null, when a restart has lost it: the
            // cloud takes the id OR the code, and refuses a null id as a
            // malformed fact — which put every slip a restarted box printed
            // in quarantine (SCRUM-223 bench run), once a box kept its queue.
            ...(printed.voucherId ? { voucherId: printed.voucherId } : {}),
            voucherCode: printed.voucherCode,
            printJobId: outcome.id,
            status: outcome.status,
            attempts: outcome.attempts,
            deviceId: outcome.deviceId,
            errorCode: outcome.errorCode,
            errorMessage: outcome.errorMessage,
            /**
             * `reprint` or `initial` (SCRUM-223). The cloud files a
             * `booth.voucher_print` row per job and counts the copies of the
             * code, so two slips with one code at reception is answerable:
             * which one is the reprint. A reprint names no account: anyone at
             * the screen may ask for one (SCRUM-694).
             */
            reason: printed.reason,
          },
        },
        (draft) => sealEnvelope(draft, boxId, key),
        nowIso,
      );
    } catch (err) {
      note('error', 'a booth print outcome could not be queued', {
        jobId: outcome.id,
        err: String(err),
      });
      return;
    }
    // Only once the fact is on disk, and into the finished set rather than out
    // of the booth's hands: a job this booth stopped answering for would have
    // any later result reported to the cloud's print route by the agent,
    // which is the thing D20 forbids.
    if (outcome.status !== 'queued') {
      ownedPrintJobs.delete(outcome.id);
      finishedPrintJobs.delete(outcome.id);
      finishedPrintJobs.set(outcome.id, printed);
      while (finishedPrintJobs.size > FINISHED_PRINT_JOBS_KEPT) {
        const oldest = finishedPrintJobs.keys().next();
        if (oldest.done) break;
        finishedPrintJobs.delete(oldest.value);
      }
    }
  }

  // --- Reporting ------------------------------------------------------------

  /**
   * What the corner of the screen and the heartbeat are drawn from, MEASURED.
   *
   * Nothing here has a cheerful default. A printer the box has not managed to
   * talk to is `unknown` rather than `reachable`, which is the one answer a
   * health indicator must never give by default — the fleet has already been
   * bitten by a Devices drawer that said "no printers" when what it meant was
   * that it could not ask.
   */
  async function measure(): Promise<BoothHeartbeatReport> {
    const health = healthForBooth();
    const pending = await pendingCount();
    return {
      configVersion: applied?.version ?? null,
      printerReachable: health?.reachability ?? 'unknown',
      paperStatus: health?.paperStatus ?? 'unknown',
      vouchersPending: pending.count,
      pendingUnit: pending.unit,
      lastSpinAt,
      rostered: currentDutyLabel() !== null,
      staffSignedIn: false,
      dailyCapsReached: await cappedToday(),
      today: await countsToday(),
    };
  }

  /**
   * The health of the printer this booth prints ON.
   *
   * `printerHealth` is keyed by device id and a box may drive several
   * printers, so taking the first entry would report the kitchen printer's
   * paper on the booth's television. Resolved through the booth's own print
   * job history instead: the device the last voucher actually went to. Until a
   * voucher has been attempted, this is `unknown` — which is true.
   */
  function healthForBooth(): BoothPrinterHealth | null {
    const all = options.printerHealth?.() ?? {};
    const deviceId = lastPrintDeviceId;
    if (deviceId) return all[deviceId] ?? null;
    /**
     * Nothing has been printed on this run — but the heartbeat probes every
     * assigned printer each minute (SCRUM-419, L18), so the printer the
     * Console assigned to THIS booth station already has an answer. Only this
     * station's own printers are read: reporting another station's would be
     * worse than reporting nothing, which still surfaces as `unknown`.
     */
    for (const id of options.station()?.printerDeviceIds ?? []) {
      const measured = all[id];
      if (measured) return measured;
    }
    return null;
  }

  /**
   * How much this box is holding that the cloud has not acknowledged.
   *
   * Vouchers, which is what the field `vouchersPending` and the number beside
   * the TV's offline dot are named for. Until SCRUM-419 this was the whole
   * outbox depth — spins, vouchers and print outcomes, two or three rows a
   * press, and a till's facts too on a shared box — which read as "6" after
   * two offline spins (closing audit L16).
   */
  async function pendingCount(): Promise<{ count: number; unit: 'vouchers' | 'events' }> {
    /**
     * SCRUM-419 (L16): vouchers, counted by type — one `promo.voucher_issued`
     * per voucher — rather than the outbox's two or three facts per press.
     * A store that cannot count by type falls back to the whole depth and
     * SAYS so, so nobody reads six events as six vouchers.
     */
    try {
      return { count: await store.countUnsent(boxId, ['promo.voucher_issued']), unit: 'vouchers' };
    } catch (err) {
      note('warn', 'the booth could not count its unsent vouchers; it reports the whole outbox', {
        err: String(err),
      });
      const depth = await store.depth(boxId);
      return { count: depth.queued, unit: 'events' };
    }
  }

  /**
   * Today's spins and vouchers, from the counters the press itself bumps
   * (SCRUM-419). Read from the box's own store, so the count is true while it
   * is offline. Null without a wheel, a station or a branch to count against.
   */
  async function countsToday(): Promise<BoothDayCounts | null> {
    const station = options.station();
    const businessDate = todayForRoster();
    if (!applied || !station || businessDate === null) return null;
    try {
      const spins = await store.readCounter(boxId, {
        scope: BOOTH_SPIN_COUNTER_SCOPE,
        key: station.id,
        businessDate,
      });
      const prizes = await store.readCounters(boxId, BOOTH_PRIZE_COUNTER_SCOPE, businessDate);
      const vouchers = Object.values(prizes).reduce((sum, n) => sum + n, 0);
      return { businessDate, spins, vouchers };
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return null;
      note('warn', 'the booth could not count its day', { err: String(err) });
      return null;
    }
  }

  /** `booth_prize.id` of everything that has hit its cap on this booth today. */
  async function cappedToday(): Promise<string[]> {
    const branch = options.branch();
    if (!applied || !branch) return [];
    try {
      const timing = await resolveClock(branch);
      const counters = await store.readCounters(
        boxId,
        BOOTH_PRIZE_COUNTER_SCOPE,
        timing.businessDate,
      );
      return cappedPrizeIds(judgePrizes(applied.bundle.prizes, { counters }));
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return [];
      throw err;
    }
  }

  async function status(opts: { online: boolean }): Promise<BoothStatusReport> {
    // The heartbeat-only fields stay off the television's answer: it reads
    // `dutyLabel`, and the retired `staffSignedIn` is for an older api only.
    const { rostered: _rostered, staffSignedIn: _retired, ...measured } = await measure();
    return {
      online: opts.online,
      dutyLabel: currentDutyLabel(),
      /**
       * "Never synced" is a different screen from "offline", and the
       * difference is whether a wheel has ever been applied — not whether the
       * link is up. A booth that has run all week is offline every time the
       * mall's wifi drops and is emphatically not unconfigured.
       */
      neverSynced: applied === null,
      ...measured,
    };
  }

  async function heartbeat(): Promise<BoothHeartbeatReport | null> {
    // A box with no booth station sends no booth block at all, rather than a
    // block full of nulls that Health would have to learn to ignore.
    if (!options.station()) return null;
    return measure();
  }

  // --- Lifecycle ------------------------------------------------------------

  async function start(): Promise<void> {
    await refresh();
    await adoptPendingPrintJobs();
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        void refresh().catch((err) =>
          note('error', 'the booth config refresh failed', { err: String(err) }),
        );
      }, BOOTH_CONFIG_REFRESH_MS);
      refreshTimer.unref?.();
    }
  }

  /**
   * Take ownership of vouchers the previous process left unprinted.
   *
   * Without this, a box that restarted holding three unprinted vouchers would
   * report their outcomes to the CLOUD's print-result route when they finally
   * came out, because the agent asks this module whether a job is its own and
   * a fresh module remembers nothing. That is D20's failure exactly: a report
   * against a row the cloud may not have, for a spin still sitting in the
   * outbox.
   *
   * The ones a power cut caught on their way to the printer are adopted too.
   * The print queue never prints those again (D12) but it does report them,
   * as failed — and that report is an outcome like any other, owed to the
   * outbox and not to the cloud's print route.
   */
  async function adoptPendingPrintJobs(): Promise<void> {
    if (!store.features().printJobs) return;
    try {
      const leftBehind = [
        ...(await store.loadPendingPrintJobs(boxId)),
        ...(await store.loadInterruptedPrintJobs(boxId)),
      ];
      for (const job of leftBehind) {
        if (job.job.kind !== 'booth_voucher') continue;
        // A job this process raised itself keeps what it knows — the voucher
        // id — when the booth is started again (a `restart` command stops and
        // starts it while slips are still waiting).
        if (ownedPrintJobs.has(job.id)) continue;
        /**
         * The voucher id is gone with the process that minted it — nothing on
         * the stored job carries it, because the RENDERER has no use for it
         * and a print job holds what goes on the paper. The code does go on
         * the paper, so it comes back, and it is what lets the cloud match
         * this outcome to `promo.voucher` after a power cut.
         */
        ownedPrintJobs.set(job.id, {
          voucherId: null,
          voucherCode: job.job.data.voucherCode,
          // A copy made on request carries its note on the job itself, which
          // is what lets a restart still report it as a reprint.
          reason: job.job.data.reprintNote ? 'reprint' : 'initial',
          // On the stored job, so a restart keeps it.
          stationId: job.stationId,
        });
      }
    } catch (err) {
      note('warn', 'the booth could not read the jobs it left behind', { err: String(err) });
    }
  }

  function stop(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  return {
    start,
    stop,
    config,
    refresh,
    spin,
    reprint,
    status,
    heartbeat,
    ownsPrintJob,
    print,
    async reportPrint(outcome) {
      if (outcome.deviceId) lastPrintDeviceId = outcome.deviceId;
      await reportPrint(outcome);
    },
    noteCloudTime: noteTime,
  };
}
