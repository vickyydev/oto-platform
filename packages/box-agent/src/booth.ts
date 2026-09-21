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
 * throughout. It cannot be LOADED by this package's test runner — Node's
 * strip-only mode refuses `Bitmap1`'s parameter properties, measured as
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — and a runtime import here would take
 * the booth's tests down with it. The printer is reached through an injected
 * port instead, which is also what lets a test prove the press path without
 * standing up a renderer.
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
  BoothConfigBundleSchema,
  addDaysToIsoDate,
  mintBoothCode,
  businessDate as businessDateFor,
  parseDayStart,
  type BoothConfigBundle,
  type BoothConfigPrize,
  type BoothPrintState,
  type SpinResponse,
} from '@oto/shared';
import type { PrintJob as RenderPrintJob } from '@oto/print';

import { cappedPrizeIds, drawPrize, judgePrizes, type RandomIndex } from './booth-draw';
import type { BoxStaffSession, BoxStore, PrintJobRecord, QueuedFact } from './store';
import { BoxStoreFeatureMissingError } from './store';
import { sealEnvelope, uuidv7 } from './signing';
import { silentLog, type AgentLog } from './transport';

// --- What a booth is running ------------------------------------------------

/**
 * One booth's entry in the `booth` cache scope.
 *
 * **Nothing fills this scope yet.** The vocabulary has existed since the
 * migration that created `booth.booth_config_version`; the builder that fills
 * it is the cloud's half of this ticket. So this schema is the box's side of a
 * contract with one end written: it states what a booth box needs in order to
 * run a wheel, and whatever builds the scope has to produce exactly this. It
 * is declared here rather than in `@oto/shared` because only the box reads it
 * — `BoothConfigBundle` next door is the document three surfaces share, and it
 * is embedded whole below rather than restated.
 *
 * Four fields ride beside the bundle, and each is here because something the
 * box must do cannot be done without it:
 *
 *  - `version` — the bundle document deliberately does not carry its own
 *    publish number, and without it the television cannot check
 *    `SpinResponse.configVersion` against anything.
 *  - `configVersionId` — `booth.spin.booth_config_version_id` is NOT NULL and
 *    references the row, so the number alone will not write a spin.
 *  - `allowedStaff` — who may sign in at this booth
 *    (`booth.booth_staff_assignment`). The `staff` cache scope says who may
 *    work at the branch, which is a different and much wider question.
 *  - `voucherDefinitions` — the terms and the expiry that go ON THE PAPER.
 *    See the note on `resolveExpiry` for why the bundle alone cannot answer
 *    either, and what the box prints while this is empty.
 */
export const BoothVoucherDefinitionSchema = z.object({
  id: z.string().uuid(),
  /** `promo.voucher_definition.terms_en`. Null is a definition with no terms. */
  termsEn: z.string().nullable().default(null),
  termsTh: z.string().nullable().default(null),
  /** Null means this definition's vouchers never expire. */
  expiryDays: z.number().int().positive().nullable().default(null),
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
  /** `core.account.id` of everybody on this booth's staff list. */
  allowedStaff: z.array(z.string().uuid()).default([]),
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
 * this file: `@oto/print` cannot be loaded where these tests run. The agent
 * passes `printing.submit`; a test passes a function that records what it was
 * asked to print.
 */
export interface BoothPrintPort {
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

/** One person, as the booth needs them: the `staff` scope plus the booth's fields. */
export interface BoothStaffRecord {
  accountId: string;
  status: string;
  /** argon2id over the booth PIN. Null for somebody who has not been given one. */
  pinHash?: string | null;
  /** argon2id over the badge secret. Nothing writes this yet — see `signIn`. */
  badgeHash?: string | null;
  /** The short code a person types before their PIN. Not a secret. */
  staffCode?: string | null;
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
   * Who may work at this branch, from the `staff` cache scope, with the
   * booth's own fields on each entry. Intersected with the booth's
   * `allowedStaff` before anything is verified.
   */
  staff?: () => readonly BoothStaffRecord[];
  /**
   * argon2id verification. Injected so this package needs no native
   * dependency, exactly as `OfflineAuthOptions.verifyPassword` is.
   */
  verifySecret?: (hash: string, secret: string) => Promise<boolean>;
  /** The branch's print templates, for the voucher's footer line. */
  printTemplates?: () => readonly { type: string; footerText?: string | null }[];
  /**
   * The draw's randomness (D3). `randomInt` from `node:crypto` by default —
   * uniform, and with the biased tail of its range rejected, which a
   * hand-rolled `byte % n` does not do. A test passes a counter or a seeded
   * generator; nothing passes `Math.random`.
   */
  randomIndex?: RandomIndex;
  now?: () => Date;
  log?: AgentLog;
}

// --- Policy numbers ---------------------------------------------------------

/** How often a booth looks for a newer published wheel. "About once a minute." */
export const BOOTH_CONFIG_REFRESH_MS = 60_000;

/**
 * How far the box's clock may sit behind a time it has already lived through
 * before a spin is flagged (D11).
 *
 * A Pi has no clock battery. Unplugged for a week it comes back believing it
 * is the moment it was switched off, or 1970, and it will happily stamp a
 * morning's spins with it. Ten minutes is wide enough that ordinary NTP
 * correction does not trip it and narrow enough that a mall power cut does.
 */
export const BOOTH_CLOCK_SUSPECT_MS = 10 * 60_000;

/**
 * The sign-in backoff, which must not disagree with the panel's copy in
 * `apps/booth/src/staff-backoff.ts`.
 *
 * Restated rather than imported: that file is browser code in another package,
 * and this one runs on a Pi. Drift between the two is survivable in one
 * direction only, and it is the direction the panel already documents — it
 * waits for the longer of its own countdown and the `retryAfterMs` this side
 * sends, so a booth that is stricter than the panel is merely a countdown that
 * runs out a moment early. A booth that were LAXER would be the panel refusing
 * attempts the box would have taken, which is why these numbers are the same
 * numbers and not smaller ones.
 *
 * Five wrong attempts are free: a booth is worked standing up, in a mall, by
 * somebody who has often just come on shift. The sixth starts a 30-second
 * wait, and each further wrong attempt doubles it to a fifteen-minute ceiling.
 */
export const BOOTH_STAFF_FREE_ATTEMPTS = 5;
export const BOOTH_STAFF_FIRST_BACKOFF_MS = 30_000;
export const BOOTH_STAFF_MAX_BACKOFF_MS = 15 * 60_000;

/** The `box_counter` scope holding "how many of this prize, today". */
export const BOOTH_PRIZE_COUNTER_SCOPE = 'booth_prize';
/** The `box_counter` scope holding "has this press already been recorded". */
export const BOOTH_PRESS_COUNTER_SCOPE = 'booth_press';
/** The `box_throttle` scope holding failed sign-ins, keyed by station. */
export const BOOTH_STAFF_THROTTLE_SCOPE = 'booth_staff';

/** How many press replies are kept in memory for a retry. See `spin`. */
const REPLAY_LIMIT = 64;

// --- Refusals ---------------------------------------------------------------

/**
 * Why a press was refused.
 *
 * These are CODES, and the television maps each to its own copy — no message
 * written here reaches a screen in a shopping centre (D15). `booth_not_ready`
 * and `not_configured` are the two the page already knows; the rest collapse
 * to its fixed line and are distinguishable only in `#debug` and in the box
 * log, which is where the difference belongs.
 */
export const BOOTH_REFUSAL_CODES = [
  /** No wheel has ever been published to this booth, or the cache holds none. */
  'not_configured',
  /** D5: every prize is inactive, capped, out of stock or weighted zero. */
  'booth_not_ready',
  /** The store cannot keep a daily counter, so a cap would silently not count. */
  'runtime_unavailable',
  /** No signing key yet, so nothing can be recorded — and D7 refuses the press. */
  'cannot_record',
  /** This exact press was already recorded and its answer is no longer held. */
  'duplicate_press',
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
  staffSignedIn: boolean;
  dailyCapsReached: string[];
}

/** The heartbeat's booth block. Same fields, measured rather than defaulted. */
export interface BoothHeartbeatReport {
  configVersion: number | null;
  printerReachable: BoothPrinterHealth['reachability'];
  paperStatus: BoothPrinterHealth['paperStatus'];
  vouchersPending: number;
  lastSpinAt: string | null;
  staffSignedIn: boolean;
  dailyCapsReached: string[];
}

export interface BoothSignInRequest {
  pin?: string;
  badge?: string;
}

export interface BoothSignInResult {
  ok: boolean;
  /** How long this box will refuse further attempts. Absent when it will not. */
  retryAfterMs?: number;
  /** The account that signed in. Never sent to the television. */
  accountId?: string;
}

export interface Booth {
  /** Adopt whatever the cache holds and pick up any vouchers still to print. */
  start(): Promise<void>;
  stop(): void;
  /** The wheel this booth is running, or null when none has ever been applied. */
  config(): { version: number; bundle: BoothConfigBundle } | null;
  /** Re-read the cache and apply a newer version whole. True when it changed. */
  refresh(): Promise<boolean>;
  spin(request: BoothSpinRequest): Promise<SpinResponse>;
  signIn(request: BoothSignInRequest): Promise<BoothSignInResult>;
  signOut(): Promise<void>;
  staffSession(): Promise<BoxStaffSession | null>;
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
   * The agent calls it with the cloud's `serverTime` off every heartbeat ack.
   * That is what makes "the highest time this box has already lived through" a
   * statement about real time rather than about this box's own drift — without
   * it, a Pi whose clock is a day fast would simply believe itself.
   */
  noteCloudTime(at: string): Promise<void>;
}

export function createBooth(options: BoothOptions): Booth {
  const { boxId, store } = options;
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? silentLog;
  const randomIndex: RandomIndex = options.randomIndex ?? ((max) => randomInt(max));

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
  const ownedPrintJobs = new Map<string, { voucherId: string | null; voucherCode: string }>();
  /**
   * The answer to a press, kept so that a retry of the SAME press gets the
   * same answer rather than a second prize.
   *
   * **In memory, and a restart forgets it.** That is not the whole of D7's
   * protection and is not claimed to be: the durable half is a counter row
   * written inside the spin's own transaction (`BOOTH_PRESS_COUNTER_SCOPE`),
   * which survives a restart and turns a repeat of a key this process can no
   * longer answer for into a refusal rather than a second voucher. So a retry
   * is replayed when the box has been up throughout, and refused when the box
   * restarted in between — never drawn again.
   */
  const replay = new Map<string, SpinResponse>();

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
    const held = await store.readBundle(boxId, 'booth');
    if (!held) return false;
    const payload = BoothCachePayloadSchema.safeParse(held.payload);
    if (!payload.success) {
      note('warn', 'the booth cache scope did not carry an item list and was ignored');
      return false;
    }
    const stationId = options.station()?.id ?? null;
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
      // A box hosts one booth (see `BoothHeartbeatSchema`), but the scope is
      // free to carry more than one entry, so the box takes the one that is
      // its own rather than the first that arrives.
      if (stationId !== null && entry.stationId !== stationId) continue;
      if (applied && entry.version < applied.version) {
        note('warn', 'a booth cache entry was older than the wheel already running', {
          held: applied.version,
          offered: entry.version,
        });
        continue;
      }
      if (applied && entry.version === applied.version && entry.bundleHash === applied.bundleHash) {
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
   *  - `occurredAt` is the box's own clock, reported as it reads. The envelope
   *    keeps it as sent even when the cloud disbelieves it, which is the only
   *    honest thing to store.
   *  - `businessDate` is resolved from the LATER of the clock and the highest
   *    time this box has already lived through, so a booth that came up after
   *    a power cut believing it is 1970 does not file today's spins on a
   *    trading day thirty years before the park existed, and the day never
   *    moves backwards.
   *  - `clockSuspect` says the two disagree by more than ten minutes, so a
   *    day's figures that look wrong can be explained from the row itself.
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
  }> {
    const nowMs = clock().getTime();
    const seenIso = await store.lastGoodTime(boxId);
    const seenMs = seenIso === null ? null : Date.parse(seenIso);
    const lived = seenMs !== null && Number.isFinite(seenMs) ? seenMs : null;
    const behindMs = lived === null ? 0 : lived - nowMs;
    const stampMs = lived !== null && lived > nowMs ? lived : nowMs;
    const dayStart = parseDayStart(branch.businessDayStart);
    return {
      occurredAt: new Date(nowMs).toISOString(),
      stampMs,
      businessDate: businessDateFor(new Date(stampMs), branch.timezone, dayStart),
      clockSuspect: behindMs > BOOTH_CLOCK_SUSPECT_MS,
    };
  }

  /**
   * Remember a time this box has good reason to believe in.
   *
   * The agent calls it with the cloud's `serverTime` off every heartbeat ack,
   * which is what makes "the highest time already lived through" a statement
   * about real time rather than about this box's own drift. `markTimeSeen`
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

  // --- Staff --------------------------------------------------------------

  /**
   * Who is signed in, read in a way that can never take the booth down.
   *
   * A sign-in problem must never stop the wheel (`docs/features/booth.md`), so
   * every failure here degrades to "nobody" and the spin is recorded
   * unattributed — which is a real and expected state, and the one the
   * `booth.unattributed` condition is raised from. The one failure NOT
   * swallowed at the press is a store with no booth runtime at all: a daily
   * cap that silently does not count is the defect those tables exist to
   * prevent, and `spin` refuses before it reaches here.
   */
  async function staffAccountQuietly(stationId: string): Promise<string | null> {
    try {
      const session = await store.readStaffSession(stationId);
      return session?.accountId ?? null;
    } catch (err) {
      note('warn', 'the booth could not read its staff session; the spin is unattributed', {
        err: String(err),
      });
      return null;
    }
  }

  function backoffFor(failures: number): number {
    if (failures <= BOOTH_STAFF_FREE_ATTEMPTS) return 0;
    const doublings = failures - BOOTH_STAFF_FREE_ATTEMPTS - 1;
    return Math.min(BOOTH_STAFF_FIRST_BACKOFF_MS * 2 ** doublings, BOOTH_STAFF_MAX_BACKOFF_MS);
  }

  /**
   * Sign somebody in by PIN or badge (D18).
   *
   * **It iterates and verifies; it cannot look up.** argon2id salts per row,
   * so there is no query — online or offline — that turns four typed digits
   * into an account. The booth therefore tries each of its own allowed staff
   * in turn and argon2-verifies against that person's hash. No pepper, no
   * lookup index: under fifty people on a booth's list makes that cheap, and
   * the alternative is a deterministic digest, which is a lookup key for
   * whoever holds the disk as much as for the booth.
   *
   * The cost of iterating is also the defence's shape: the throttle counts
   * against the STATION, not the account, because until a verification
   * succeeds there is no account to count against. That is the right subject
   * anyway — four digits against a whole booth's staff list is the brute force
   * worth slowing down.
   *
   * **Badge sign-in verifies the same way and finds nobody today.** Nothing
   * writes `badgeHash` yet (see `BoothStaffCacheFields`), so a scan is checked
   * against an empty set of hashes and refused. That is the honest behaviour
   * until PIN and badge management lands, and it is not a silent one — the
   * refusal is logged with the reason.
   */
  async function signIn(request: BoothSignInRequest): Promise<BoothSignInResult> {
    const station = options.station();
    if (!station) return { ok: false };
    const nowIso = clock().toISOString();
    const nowMs = clock().getTime();

    let held;
    try {
      held = await store.readThrottle(boxId, BOOTH_STAFF_THROTTLE_SCOPE, station.id);
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) {
        // A booth whose store cannot count failures cannot be defended by a
        // count. Refusing the sign-in is the safe side of that: the wheel goes
        // on spinning unattributed, which is the outcome the specification
        // already requires to keep working.
        note('error', 'this box cannot keep a sign-in throttle, so the booth refuses sign-in', {
          missing: err.missing,
        });
        return { ok: false };
      }
      throw err;
    }
    const lockedUntilMs = held?.lockedUntil ? Date.parse(held.lockedUntil) : null;
    if (lockedUntilMs !== null && Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
      return { ok: false, retryAfterMs: lockedUntilMs - nowMs };
    }

    const secret = request.badge ?? request.pin ?? '';
    const kind: 'badge' | 'pin' = request.badge !== undefined ? 'badge' : 'pin';
    const verify = options.verifySecret;
    const candidates = eligibleStaff();
    let matched: BoothStaffRecord | null = null;
    if (verify && secret !== '') {
      for (const candidate of candidates) {
        const hash = kind === 'badge' ? candidate.badgeHash : candidate.pinHash;
        if (!hash) continue;
        // Awaited in sequence rather than raced, so a booth cannot be made to
        // run fifty argon2 verifications in parallel by somebody holding the
        // button down. argon2 is deliberately slow; that is the point of it.
        // One at a time rather than `Promise.all`, so a single attempt costs at
        // most one argon2 verification at a time instead of fifty at once.
        // That bounds ONE request; what bounds a stream of them is the
        // throttle above, since nothing here serialises concurrent attempts.
        if (await verify(hash, secret)) {
          matched = candidate;
          break;
        }
      }
    }

    if (!matched) {
      const failures = (held?.failures ?? 0) + 1;
      const wait = backoffFor(failures);
      const record = await store.recordThrottleFailure(boxId, BOOTH_STAFF_THROTTLE_SCOPE, station.id, {
        now: nowIso,
        lockedUntil: wait > 0 ? new Date(nowMs + wait).toISOString() : undefined,
      });
      note('warn', 'a booth sign-in was refused', {
        kind,
        failures: record.failures,
        candidates: candidates.length,
        hashesHeld: candidates.filter((c) => (kind === 'badge' ? c.badgeHash : c.pinHash)).length,
      });
      return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: false };
    }

    await store.writeStaffSession({
      stationId: station.id,
      boxId,
      accountId: matched.accountId,
      credentialKind: kind,
      staffCode: matched.staffCode ?? null,
      signedInAt: nowIso,
      lastSeenAt: nowIso,
      // Null: the session ends when somebody signs out or the booth is reset.
      // A booth is attended for a shift, and an expiry that cut in mid-shift
      // would produce exactly the unattributed vouchers this is here to avoid.
      expiresAt: null,
    });
    await store.clearThrottle(boxId, BOOTH_STAFF_THROTTLE_SCOPE, station.id);
    note('info', 'somebody signed in at the booth', { kind });
    return { ok: true, accountId: matched.accountId };
  }

  /** The branch's staff, narrowed to this booth's list and to active accounts. */
  function eligibleStaff(): BoothStaffRecord[] {
    const allowed = new Set(applied?.allowedStaff ?? []);
    if (allowed.size === 0) return [];
    return (options.staff?.() ?? []).filter(
      (record) => allowed.has(record.accountId) && record.status === 'active',
    );
  }

  async function signOut(): Promise<void> {
    const station = options.station();
    if (!station) return;
    try {
      await store.clearStaffSession(station.id);
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return;
      throw err;
    }
  }

  async function staffSession(): Promise<BoxStaffSession | null> {
    const station = options.station();
    if (!station) return null;
    try {
      return await store.readStaffSession(station.id);
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return null;
      throw err;
    }
  }

  // --- The press ----------------------------------------------------------

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

    const timing = await resolveClock(branch);
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

    const staffAccountId = await staffAccountQuietly(station.id);

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
        staffAccountId,
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
    const prefix = station.codePrefix ?? '';
    /**
     * Minted once, with no retry loop, and that is correct here.
     *
     * `mintBoothCode`'s note asks the CALLER to own the retry because only a
     * caller can see the unique-index violation that makes one necessary. A
     * box has no voucher table and therefore no index to violate: uniqueness
     * is `promo.voucher (operator_id, code)` in the cloud, and a collision is
     * settled at sync by quarantining the loser and alerting on both booths
     * (D9) — never by a silent reassign, because the paper in a visitor's hand
     * is the authority. A loop here would be a loop that cannot detect
     * anything.
     */
    const voucherCode = mintBoothCode(prefix, randomIndex);
    const expiresAt = resolveExpiry(outcome.prize, timing.stampMs);

    const spinFact: QueuedFact = {
      type: 'booth.spin_recorded',
      occurredAt: timing.occurredAt,
      stationId: station.id,
      actorKind: staffAccountId ? 'account' : 'device',
      actorAccountId: staffAccountId,
      actionId: request.actionId ?? null,
      payload: {
        spinId,
        boothConfigVersionId: entry.configVersionId,
        configVersion: entry.version,
        outcome: 'prize',
        prizeId: outcome.prize.id,
        voucherId,
        staffAccountId,
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
      actorKind: staffAccountId ? 'account' : 'device',
      actorAccountId: staffAccountId,
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

    const printJob = options.print ? buildPrintJob(printJobId, station, branch, {
      prize: outcome.prize,
      voucherCode,
      expiresAt,
      issuedAtMs: timing.stampMs,
      staffAccountId,
    }) : null;

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
    await noteTime(timing.occurredAt);

    let printState: BoothPrintState = 'no_printer';
    const port = options.print;
    if (printJob && port) {
      ownedPrintJobs.set(printJobId, { voucherId, voucherCode });
      printState = await attemptPrint(
        port,
        printJobId,
        printJob.job,
        station.id,
        request.actionId ?? null,
      );
    }

    const response: SpinResponse = {
      spinId,
      prizeIndex: outcome.index,
      prizeId: outcome.prize.id,
      configVersion: entry.version,
      voucherCode,
      expiresAt,
      printState,
      staffAccountId,
      clockSuspect: timing.clockSuspect,
    };
    remember(request.idempotencyKey, response);
    return response;
  }

  function remember(key: string, response: SpinResponse): void {
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
   * printer is out of paper too.
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
   * When this voucher runs out, or null.
   *
   * **The published bundle cannot always answer this, and the box does not
   * guess.** `booth_prize.expiry_days` is an OVERRIDE — null means "take the
   * definition's" — and the bundle deliberately carries no voucher
   * definitions, because it is what the wheel needs to draw and to name a
   * prize. So the definitions travel beside it in the cache entry, and when
   * one is present its `expiryDays` is used. When neither the prize nor a
   * cached definition names a number, this returns null and the slip prints
   * "No expiry".
   *
   * That last case is a real gap rather than a designed behaviour: a voucher
   * that expires in fourteen days would be printed as though it never did, and
   * the paper in a visitor's hand is the authority (D9). Whatever fills the
   * `booth` cache scope has to send `voucherDefinitions`; until it does, a
   * booth whose prizes leave `expiryDays` null prints vouchers that claim more
   * than the park means to give.
   */
  function resolveExpiry(prize: BoothConfigPrize, stampMs: number): string | null {
    const definition = applied?.voucherDefinitions.find(
      (candidate) => candidate.id === prize.voucherDefinitionId,
    );
    const days = prize.expiryDays ?? definition?.expiryDays ?? null;
    if (days === null) return null;
    return new Date(stampMs + days * 24 * 60 * 60 * 1000).toISOString();
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
      staffAccountId: string | null;
    },
  ): PrintJobRecord {
    const definition = applied?.voucherDefinitions.find(
      (candidate) => candidate.id === detail.prize.voucherDefinitionId,
    );
    const job: RenderPrintJob = {
      kind: 'booth_voucher',
      data: {
        venueLine: branch.name,
        prizeLine: detail.prize.nameEn,
        prizeLineThai: detail.prize.nameTh,
        redemptionLine: `Show this QR at OTO Reception to claim: ${detail.prize.nameEn}.`,
        /**
         * The definition's terms, split a line each. An empty array is a real
         * value and prints no terms at all — which today is every voucher,
         * because nothing fills `voucherDefinitions` yet. See `resolveExpiry`.
         */
        terms: splitTerms(definition),
        voucherCode: detail.voucherCode,
        issuedAt: formatStamp(new Date(detail.issuedAtMs), branch.timezone),
        booth: `${branch.name} · ${station.name}`,
        /**
         * **The account id is NOT printed here, and null is expected.**
         * `BoothVoucherData.staff` wants a name and a staff code — "Nok
         * (S-014)" — and the box holds neither: the `staff` cache scope
         * carries a hash, a status and an id, and deliberately nothing that
         * identifies a person to whoever holds the disk. So an attended spin
         * prints the staff CODE where the booth knows one and nothing where it
         * does not, and the slip says "Not signed in" for an unattributed
         * voucher, which is the state the specification requires to keep
         * working.
         */
        staff: staffLabel(detail.staffAccountId),
        expiresAt:
          detail.expiresAt === null
            ? null
            : formatStamp(new Date(detail.expiresAt), branch.timezone, { time: false }),
        footerLine: voucherFooter(),
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

  function splitTerms(definition: BoothVoucherDefinition | undefined): string[] {
    const lines: string[] = [];
    for (const block of [definition?.termsEn, definition?.termsTh]) {
      if (!block) continue;
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '') lines.push(trimmed);
      }
    }
    return lines;
  }

  /** The staff code this booth knows for an account, or null. See `buildPrintJob`. */
  function staffLabel(accountId: string | null): string | null {
    if (!accountId) return null;
    const record = (options.staff?.() ?? []).find((s) => s.accountId === accountId);
    return record?.staffCode ?? null;
  }

  /** The `booth_voucher` template's footer, or an empty line when none is set. */
  function voucherFooter(): string {
    const template = (options.printTemplates?.() ?? []).find((t) => t.type === 'booth_voucher');
    return template?.footerText ?? '';
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
    return ownedPrintJobs.has(jobId);
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
    const printed = ownedPrintJobs.get(outcome.id);
    if (!printed) return;
    const key = options.privateKey();
    const station = options.station();
    if (!key || !station) return;
    const nowIso = clock().toISOString();
    try {
      await store.enqueue(
        boxId,
        {
          type: 'booth.voucher_printed',
          occurredAt: nowIso,
          stationId: station.id,
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
            voucherId: printed.voucherId,
            voucherCode: printed.voucherCode,
            printJobId: outcome.id,
            status: outcome.status,
            attempts: outcome.attempts,
            deviceId: outcome.deviceId,
            errorCode: outcome.errorCode,
            errorMessage: outcome.errorMessage,
            reason: 'initial',
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
    // Only once the fact is on disk. A job dropped from this set before its
    // outcome was queued would have its result reported to the cloud's print
    // route by the agent instead, which is the thing D20 forbids.
    if (outcome.status !== 'queued') ownedPrintJobs.delete(outcome.id);
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
    const station = options.station();
    const health = healthForBooth();
    let staffSignedIn = false;
    try {
      staffSignedIn = station ? (await store.readStaffSession(station.id)) !== null : false;
    } catch {
      // A store that cannot answer is reported as nobody signed in, which is
      // the same thing the spin path does with the same failure.
      staffSignedIn = false;
    }
    return {
      configVersion: applied?.version ?? null,
      printerReachable: health?.reachability ?? 'unknown',
      paperStatus: health?.paperStatus ?? 'unknown',
      vouchersPending: await pendingCount(),
      lastSpinAt,
      staffSignedIn,
      dailyCapsReached: await cappedToday(),
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
    // Nothing has been printed on this run, so the box has not asked any
    // printer anything. Reporting another station's printer would be worse
    // than reporting nothing, so nothing it is — which surfaces as `unknown`.
    return null;
  }

  /**
   * How much this box is holding that the cloud has not acknowledged.
   *
   * **This is the whole outbox depth, not a count of vouchers**, and the
   * difference is worth stating because the field it feeds is named
   * `vouchersPending`. A booth box's queue is made of spins, vouchers and
   * their print outcomes — roughly two to three rows per press — so the number
   * is an upper bound on unsent vouchers rather than the count of them, and on
   * a box that also ran a till it would include the till's facts too. What it
   * is exactly is "facts this box has not had acknowledged", which is the
   * thing an operator actually needs when deciding whether the booth can be
   * left offline. Counting by event type would need a store method that does
   * not exist.
   */
  async function pendingCount(): Promise<number> {
    const depth = await store.depth(boxId);
    return depth.queued;
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
    const measured = await measure();
    return {
      online: opts.online,
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
   */
  async function adoptPendingPrintJobs(): Promise<void> {
    if (!store.features().printJobs) return;
    try {
      for (const job of await store.loadPendingPrintJobs(boxId)) {
        if (job.job.kind !== 'booth_voucher') continue;
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
    signIn,
    signOut,
    staffSession,
    status,
    heartbeat,
    ownsPrintJob,
    async reportPrint(outcome) {
      if (outcome.deviceId) lastPrintDeviceId = outcome.deviceId;
      await reportPrint(outcome);
    },
    noteCloudTime: noteTime,
  };
}
