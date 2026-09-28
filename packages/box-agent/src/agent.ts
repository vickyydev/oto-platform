import { readFileSync } from 'node:fs';
import {
  BoothRefusal,
  createBooth,
  type Booth,
  type BoothAccountVerdict,
  type BoothBranchContext,
  type BoothClockStanding,
  type BoothStaffRecord,
  type BoothStationContext,
} from './booth';
import { planCacheApply, type CacheFaultReason } from './cache-apply';
import type { SyncPushRequest, SyncPushResponse } from './contract';
import type { CredentialStore } from './credentials';
import {
  createOutbox,
  paymentRecordedFact,
  saleFinalisedFact,
  type OfflineReceiptFact,
  type OfflineSaleFact,
  type OfflineTenderFact,
  type Outbox,
} from './outbox';
import { createRefusalBackOff } from './reregister';
import { generateSyncKeyPair, publicKeyFor, uuidv7 } from './signing';
import { ScanRouter, type ScanInput } from './scan';
import { HidBurstReader, buttonKeyProblem, simulateHidKeys } from './scan-input';
import { StationSessionManager } from './station-session';
import {
  BoxStoreFeatureMissingError,
  type BoxStore,
  type CachedBundle,
  type ClockStamp,
  type StationIdentity,
} from './store';
import {
  BOX_AGENT_VERSION,
  BOX_CLOCK_SKEW_ERROR,
  BOX_HEARTBEAT_STALE_ERROR,
  boxCredential,
  type BoxClockSkewDetails,
  type BoxCommandHandout,
  type BoxCommandKind,
  type BoxCommandPollResponse,
  type BoxCommandResultRequest,
  type BoxCommandResultResponse,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxHeartbeatAck,
  type BoxHeartbeatRequest,
  type BoxHeartbeatStaleDetails,
  type BoxRegisterResponse,
  type DeviceReport,
} from './protocol';
import { httpTransport, silentLog, type AgentFetch, type AgentLog } from './transport';
import {
  createPrinting,
  testPrintJob,
  type ChannelFactory,
  type PrintingController,
  type PrintJobOutcome,
} from './printing/index';
import {
  TerminalCommandPayloadSchema,
  createTerminals,
  type SerialOpener,
  type TerminalController,
  type TerminalProgress,
  type TerminalResult,
} from './terminal/index';
import {
  BOOTH_STAFF_VERIFY_ERRORS,
  BOOTH_STAFF_VERIFY_PATH,
  PrintTemplateSchema,
  isLegacyBoothCode,
  normaliseBoothCode,
  verifyBoothCode,
} from '@oto/shared';
import type { PrintKind, PrintTemplate, PrinterFault, SimulatorAction } from '@oto/shared';

/**
 * The box agent (S2-04).
 *
 * This is the whole of what a box does towards the cloud: register once, say
 * it is alive every minute, pull its configuration when the cloud says it has
 * changed, and take the commands somebody pressed on the Console. Everything
 * the box does towards the DEVICES — printing, scanning, the gate — is S2-06
 * and slots in behind `executeCommand` and `reportDevices`.
 *
 * It is written as ordinary code against an HTTP API and a credential store,
 * with no dependency on the platform's database or its Fastify instance, for
 * one reason: the same file has to run on a Raspberry Pi in Phuket and inside
 * the api process on Render. The "virtual box" is not a simulation of the
 * agent — it IS the agent, pointed at `127.0.0.1` with an in-memory credential
 * store. What differs between the two is one URL and where the secret is kept.
 */

/**
 * Where a box keeps the last config bundle it was given (SCRUM-223).
 *
 * The bundle names the box's stations, its devices and its branch — which is
 * to say, which booth it is, which printer the voucher goes to and what
 * trading day a spin falls in. Held only in memory, a Pi that came back from
 * a power cut before the mall's internet did knew none of that, and a booth
 * that does not know its own station cannot draw. So a real box passes a
 * cache and the agent writes every bundle it adopts to it and reads it back
 * at start. The virtual box passes none: its cloud is the process it runs in.
 *
 * Nothing secret is in a bundle — signing keys ride it as PUBLIC halves only.
 */
export interface BoxConfigCache {
  read(): Promise<BoxConfigBundle | null>;
  write(bundle: BoxConfigBundle): Promise<void>;
}

export interface DeviceFault {
  reachability?: 'unknown' | 'reachable' | 'unreachable';
  paperStatus?: 'unknown' | 'ok' | 'low' | 'out';
  lastError?: string;
}

export interface BoxAgentOptions {
  /** `https://oto-api-staging.onrender.com` or `http://127.0.0.1:3001`. */
  apiBaseUrl: string;
  credentials: CredentialStore;
  /**
   * Read when the store holds no credential. A function rather than a string
   * so the virtual box can mint itself a code at the moment it needs one,
   * instead of one sitting in a variable for the life of the process.
   */
  claimCode?: () => Promise<string | null>;
  hostname?: string;
  fetch?: AgentFetch;
  log?: AgentLog;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  /**
   * Devices this box should report as broken, keyed by device id or by label.
   * How the Console's simulator panel makes a printer run out of paper without
   * anybody walking to Phuket.
   */
  faults?: Record<string, DeviceFault>;
  /**
   * The machine's own clock, injected so a test can set it wherever it likes.
   * The Console's "Advance box clock" adds to it (`clockSkewMs`). Neither is
   * what the box stamps with once it has measured itself against the
   * platform — see THE BOX'S CLOCK in `createBoxAgent` (SCRUM-402).
   */
  now?: () => number;
  /**
   * Which boot of the machine this agent runs in (SCRUM-402).
   *
   * A clock measurement is good only for the clock it measured, and a Pi with
   * no clock battery comes back from every reboot with a different one. So a
   * measurement is kept with this and set aside when it differs. Linux's own
   * `/proc/sys/kernel/random/boot_id` by default; where there is none, the
   * process's start stands in, so a development box keeps a measurement for
   * one run and no longer. A test passes one to restart a box on the same
   * store as though it had rebooted — or had not.
   */
  bootId?: string;
  /**
   * The machine's monotonic clock, in milliseconds (SCRUM-402): a clock
   * nothing can step, against which a step of the wall clock is noticed.
   * `process.hrtime` by default, which on Linux is the kernel's monotonic
   * clock and runs on across a restart of the service. Where `now` is
   * injected it defaults to `now` itself, so a test's clock never steps
   * unless the test gives the two different clocks.
   */
  monotonic?: () => number;
  /**
   * Where this box remembers things (S2-05).
   *
   * Optional, and the agent is fully functional without one — that is the
   * S2-04 box: it registers, heartbeats, pulls config and runs commands, and
   * holds nothing. With a store it gains the three things that make it the
   * system of action rather than a reporter: a durable outbox, station
   * session documents, and an offline state that survives a restart.
   */
  store?: BoxStore;
  /**
   * The identity a claim is registering again onto a NEW store, or null
   * (SCRUM-403). A registration that names this box, onto a store with no row
   * for it, makes the row waiting for a new journal epoch — in the same
   * transaction as the row — rather than taking the epoch the answer names,
   * which is the one the set-aside store sealed under. `claimBox` passes the
   * credential it set aside. See NO NEW FACT BEFORE A FRESH EPOCH.
   */
  journalHoldFor?: string | null;
  /**
   * The operator this box belongs to. Learned at registration; pass it for a
   * box that comes back from its credential file and never registers again.
   */
  operatorId?: string;
  /** How often the outbox tries to hand its queue over. */
  syncIntervalMs?: number;
  /** See `BoxConfigCache`. A Raspberry Pi passes one; the virtual box does not. */
  configCache?: BoxConfigCache;
  /**
   * The last word on a bundle before this box adopts it (SCRUM-223): the
   * runner's bench override points the booth's receipt printer at an address
   * typed on the box itself. Applied to every bundle adopted — pulled or
   * restored — while the copy on disk stays exactly what the cloud sent, so
   * taking the override away takes effect at the next start.
   */
  configTransform?: (bundle: BoxConfigBundle) => BoxConfigBundle;
  /**
   * How often the box asks the cloud whether its cache bundles have moved.
   *
   * The ordinary answer is a 304 with no body (the agent sends the last
   * bundle version as `If-None-Match`), so this is one small request a minute
   * per box, and the price of it is the difference between a published wheel
   * or a withdrawn booth PIN reaching the counter within a minute and reaching
   * it at the next restart (SCRUM-275).
   */
  cacheRefreshIntervalMs?: number;
  /**
   * The print pipeline (S2-06).
   *
   * On by default, because a box that cannot print is not a box — the only
   * reason to turn it off is a test that wants the agent without it. Which
   * printers are real and which are simulated is decided per device by the
   * `transport` on its row, never here.
   */
  printing?: {
    enabled?: boolean;
    /** How a socket to a REAL printer is opened. Never used for a simulated one. */
    openReal?: ChannelFactory;
    /** How long a job waits before trying a printer that was out of paper. */
    retryDelayMs?: number;
    /**
     * Keep the print queue in the store, so a voucher waiting on a printer
     * that is out of paper — or unplugged — still prints after a power cut
     * (SCRUM-223).
     *
     * The print subsystem has taken a durable queue since S2-07a and nothing
     * handed it one, so every box printed from memory. A Raspberry Pi booth
     * turns it on: its store is a file on the card, and a queued slip there
     * is the one that must not be lost. Off by default, which is the
     * behaviour the virtual box and its tests are written against.
     */
    durable?: boolean;
  };
  /**
   * The card terminals (S2-10a).
   *
   * On by default for the same reason printing is: whether a station takes card
   * is a property of its configuration — a device row with a dialect on it —
   * and not of how the process was started. A box with no terminal in its
   * bundle builds the module and never has one to talk to.
   */
  terminal?: {
    /** Off only for a test that wants the agent without it. */
    enabled?: boolean;
    /**
     * How a REAL serial port is opened, and why there is no default.
     *
     * This package carries no native dependency, so it cannot configure a
     * `/dev/ttyACM*` line itself; a box with real terminals passes an opener
     * in. Both of the park's EDC rows are `transport: 'simulated'` today, and a
     * simulated terminal never reaches this.
     */
    openSerial?: SerialOpener;
    /**
     * The Digio void password, from the host's configuration.
     *
     * A credential printed in a vendor specification is still a credential: it
     * reaches the box as an environment value, and a box without one refuses to
     * send a void rather than guessing.
     */
    voidPassword?: string | null;
  };
  /**
   * The Lucky Wheel (S2-07a).
   *
   * Built whenever this box has a store, because whether it is a BOOTH is a
   * property of its configuration — a station of kind `booth` in its bundle —
   * and not of how the process was started. A till's agent constructs the
   * module too and it simply never has a station to run, which is why
   * `heartbeat()` answers null there and no booth block goes up.
   *
   * The module itself is built with no cloud transport at all (D2). Nothing
   * here can give it one.
   */
  booth?: {
    /** Off only for a test that wants the agent without it. */
    enabled?: boolean;
    /**
     * argon2id verification for a booth PIN or badge.
     *
     * Injected for the reason `OfflineAuthOptions.verifyPassword` is: this
     * package has no native dependency, and the api and a Pi supply the same
     * function from different places. Without it a booth still spins and every
     * spin is unattributed, which is the state the specification requires to
     * keep working anyway.
     */
    verifySecret?: (hash: string, secret: string) => Promise<boolean>;
    /** The draw's randomness (D3). `node:crypto`'s `randomInt` by default. */
    randomIndex?: (maxExclusive: number) => number;
    /**
     * Which booth station this box runs, when its bundle names more than one
     * (SCRUM-223).
     *
     * The kiosk's booth picker answers this and the runner keeps the answer on
     * disk. With one booth station the answer is that one whatever this says;
     * with several and no answer, the box runs none — it does not guess, for
     * the reason `resolveInProcessBooth` gives: the prefix on the paper says
     * which booth issued it. Absent altogether (the virtual box), the first
     * booth station is run, as before.
     */
    stationId?: () => string | null;
  };
}

export interface BoxAgentState {
  boxId: string | null;
  operatorId: string | null;
  registered: boolean;
  /** What the agent has actually applied, which is what the cloud compares. */
  configVersion: string | null;
  epoch: number;
  /**
   * The store's journal waits for a new epoch from the platform, and nothing
   * is sealed until it has one (SCRUM-403): a new store under an identity
   * this box already had. See `JOURNAL_EPOCH_KEY`.
   */
  journalAwaitingEpoch: boolean;
  offline: boolean;
  heartbeatsPaused: boolean;
  /**
   * Whether the last call to the cloud got an answer (SCRUM-223).
   *
   * `offline` is the Console's switch and says nothing about the wire: a Pi
   * whose mall internet has dropped is not "offline" in that sense, and its
   * television would go on showing a green dot. This is the wire — false
   * after a request that could not be sent or that a 5xx answered, true
   * after one that was answered — and the kiosk's dot reads both.
   */
  linkUp: boolean;
  /**
   * The Console's "Advance box clock": how far a test control has moved this
   * box's RAW clock, in milliseconds. Persisted, so a restart comes back to the
   * same clock. The next heartbeat measures it like any other error in the
   * clock (SCRUM-402).
   */
  clockSkewMs: number;
  /**
   * How far the machine's clock is from the platform's, in milliseconds,
   * positive when the box is ahead: the measurement made in this boot, moved
   * by whatever the test control has done since. Null until the platform has
   * answered a heartbeat in this boot. This is what the heartbeat declares.
   */
  clockOffsetMs: number | null;
  /** The platform's time when that measurement was taken. */
  clockMeasuredAt: string | null;
  lastHeartbeatAt: string | null;
  lastAckAt: string | null;
  commandsRun: number;
  /** Events queued and not yet accepted. Reported on every heartbeat. */
  outboxDepth: number;
  oldestUnackedS: number | null;
}

export interface BoxAgent {
  readonly version: string;
  readonly state: BoxAgentState;
  /** Register if the store has no credential; a no-op afterwards. */
  ensureRegistered(): Promise<boolean>;
  /** Pull the bundle and adopt it. Returns true when it changed. */
  syncConfig(): Promise<boolean>;
  /**
   * Pull the cache bundles and apply each scope whole (S2-06).
   *
   * `GET /box/v1/cache` was built by S2-05 and nothing called it, so every box
   * in the fleet held an empty cache — which is invisible until the day the
   * link drops and the till cannot check a password. Called at start, on the
   * cache refresh timer, and by the `config_apply` command (SCRUM-275).
   * Returns the scopes that were applied; empty for a 304.
   */
  syncCache(): Promise<string[]>;
  heartbeat(): Promise<BoxHeartbeatAck | null>;
  /** Poll, run what comes back, report each result. Returns how many ran. */
  runPendingCommands(): Promise<number>;
  /**
   * Everything `start` does that needs no cloud (SCRUM-223): load the
   * credential, open the store with the copy of the config it holds, and start
   * the booth on the wheel it holds. False when this box has no credential.
   * Idempotent, and `start` calls it first; a Raspberry Pi calls it on its own
   * so its television is up before `start` asks the cloud for anything.
   */
  prepare(): Promise<boolean>;
  /**
   * `prepare`, then sync, heartbeat, poll — then set the three timers going.
   * Every call to the cloud here may fail or time out without stopping the
   * start; the box then runs on what it holds and the timers try again.
   */
  start(): Promise<void>;
  stop(): void;
  /** The Console's "Stop heartbeats" test control. */
  pauseHeartbeats(paused: boolean): void;
  /**
   * The Console's "Advance box clock": moves the RAW clock by `ms`. The next
   * heartbeat declares the new offset and measures it, and the box's stamps
   * are corrected from that answer on (SCRUM-402).
   */
  advanceClock(ms: number): Promise<void>;
  /** Recent agent log lines, which is what `collect_logs` hands back. */
  recentLogs(limit?: number): string[];
  config(): BoxConfigBundle | null;
  /**
   * The offline toggle, persisted (S2-05).
   *
   * It cuts this box's cloud client: no heartbeat, no config pull, no command
   * poll, no push. Everything the till does still works and every fact it
   * causes still lands in the outbox, which is the claim the whole demo rests
   * on. The state lives in the store, so a restart comes back offline.
   */
  setOffline(offline: boolean, opts?: { reason?: string; accountId?: string }): Promise<boolean>;
  /** The durable outbox, or null on a box running without a store. */
  outbox(): Outbox | null;
  /** The station session documents this box serves, or null without a store. */
  sessions(): StationSessionManager | null;
  /**
   * The scanning service, or null without a store (S2-06).
   *
   * Later tickets register their handlers on it — `agent.scanner()?.register(…)`
   * — which is what makes a band scan admit a guest without this file growing
   * a case for every kind of code in the park.
   */
  scanner(): ScanRouter | null;
  /** Where `edge.sync_change` stood when the cache was last applied. */
  cacheCursorSeq(): number;
  /** The print pipeline and its simulators, or null when printing is off. */
  printing(): PrintingController | null;
  /**
   * The card terminals and their simulators (S2-10a).
   *
   * Non-null does not mean this box HAS a terminal: the module answers an empty
   * list until a device row in its bundle carries a dialect it speaks. What
   * reaches it is the `terminal_sale` command and the two `terminal.*`
   * simulator actions.
   */
  terminal(): TerminalController | null;
  /**
   * The Lucky Wheel, or null on a box with no store (S2-07a).
   *
   * Non-null does NOT mean this box is a booth: the module answers
   * `config() === null` and `heartbeat() === null` until the box's bundle
   * carries a station of kind `booth`. Whatever serves the booth page wires
   * `createBoothHttp` to this.
   */
  booth(): Booth | null;
  /**
   * Sales taken with no internet, or null on a box with no store (S2-10a).
   *
   * A box with nowhere to write cannot take an offline sale at all — a queue in
   * memory is a day's takings lost to a power cut — so this answers null rather
   * than pretending, and the till refuses the tender by name instead of taking
   * money it cannot account for.
   */
  sales(): SaleQueue | null;
}

/**
 * TAKING MONEY WITH THE LINK DOWN (S2-10a, Slice G).
 *
 * The rule the outbox states — a fact is on disk before the person who caused
 * it is told it worked — applied to the one fact that is money. The till hands
 * the sale over, this writes it to the box's own queue, and it reaches the
 * ledger whenever the mall's internet comes back: minutes, or tomorrow.
 *
 * WHAT THE BOX DECIDES AND WHAT IT DOES NOT. It decides three things, all of
 * them things only a box can know: the journal position (`box_seq`, from the
 * store's gapless generator), the receipt number to show the guest (from the
 * high-water mark the cloud last told it), and whether the drawer opens. It
 * decides NOTHING about what the sale costs — see `OfflineSaleFact.cart`.
 */
export interface SaleQueue {
  /**
   * Record a whole sale and its money. On disk when this resolves.
   *
   * ONE FACT carries both: the cart and every tender that closed the sale
   * travel inside a single `sale.finalised`, so a box that loses power has
   * either the whole sale or none of it, and the cloud applies both halves in
   * one savepoint. `queueAll` is used rather than `queue` because it is the
   * transaction the multi-fact case needs and a single fact is the same call
   * with one entry — money that arrives LATER is `recordTender`, which mints a
   * second fact of its own.
   */
  record(request: OfflineSaleRequest): Promise<OfflineSaleAnswer>;
  /** A later tender against a sale already queued: a split's second half, a late approval. */
  recordTender(request: OfflineTenderRequest): Promise<OfflineSaleAnswer>;
  /** Where this station's receipt numbering stands, as the box last heard. */
  receiptMark(stationId: string): Promise<ReceiptMark | null>;
}

/**
 * S2-10b (SCRUM-207) — THE WORDS AN OFFLINE SALE CARRYING A VOUCHER IS REFUSED
 * WITH, exactly as the till shows them.
 */
export const OFFLINE_VOUCHER_REFUSAL =
  'Vouchers need the internet — take this one when the connection is back';

/** A sale the box will not take offline, with a code the till can tell apart. */
export class OfflineSaleRefused extends Error {
  readonly code: 'VOUCHER_NEEDS_INTERNET';

  constructor(message: string, code: 'VOUCHER_NEEDS_INTERNET') {
    super(message);
    this.name = 'OfflineSaleRefused';
    this.code = code;
  }
}

/**
 * The Lucky Wheel voucher an offline sale's cart names, or null — the one
 * question the box asks of a cart it otherwise never reads
 * (`OfflineSaleFact.cart`).
 *
 * WHY THE BOX ASKS IT. A voucher is redeemed online only (spec §8; the owner,
 * 24 September): it is held by the platform for one cart and used up in the
 * transaction that closes that sale, and a sale taken offline reaches the
 * platform later through the replay, which prices the cart WITHOUT its
 * `promoCodes`. A voucher riding an offline sale would therefore be honoured
 * at the counter on the strength of the slip alone, never used up, and the
 * sale's price would disagree with the platform's when it arrived. So the box
 * refuses the sale before it numbers or queues anything, whatever the till
 * did or did not check first.
 *
 * WHERE A VOUCHER RIDES. A till names one by putting its code in the cart's
 * `promoCodes` — flat, or under `cart` as the till nests it — and nowhere
 * else: the platform refuses a voucher described in `promos`
 * (VOUCHER_CLAIM_REFUSED). `promos` is not read here on purpose. The park's own
 * discount codes ride there and some have a booth code's shape (SONGKRAN25,
 * MEMBERDAY25), which only the platform's discount catalogue can tell apart.
 *
 * Any code of a booth code's shape counts — eleven characters with a right
 * check, or the ten-character shape printed before the check — digits alone
 * included: refusing a sale over a code that turns out to be nobody's voucher
 * costs a retype, and a voucher taken offline costs the voucher.
 */
export function voucherOnOfflineCart(cart: Record<string, unknown>): string | null {
  const codesOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : [];
  const nested =
    cart.cart && typeof cart.cart === 'object' ? (cart.cart as Record<string, unknown>) : null;
  for (const raw of [...codesOf(cart.promoCodes), ...codesOf(nested?.promoCodes)]) {
    const code = normaliseBoothCode(raw);
    if (verifyBoothCode(code).ok || isLegacyBoothCode(code)) return code;
  }
  return null;
}

export interface OfflineSaleRequest extends Omit<OfflineSaleFact, 'saleId' | 'receipt'> {
  /** Minted at the till. One is minted here when the till did not send one. */
  saleId?: string;
  /**
   * Open the drawer. Defaults to "whenever one of the tenders was cash", which
   * is the rule the cloud's own cash finalise applies (`payments/drawer.ts`) —
   * a card payment leaves it shut.
   */
  openDrawer?: boolean;
}

export interface OfflineTenderRequest {
  saleId: string;
  stationId: string;
  actorAccountId: string;
  tender: OfflineTenderFact;
  occurredAt?: string;
  actionId?: string | null;
  openDrawer?: boolean;
}

export interface OfflineSaleAnswer {
  saleId: string;
  /** What the till shows the guest. Provisional: the cloud allocates the real one. */
  receipt: OfflineReceiptFact | null;
  /** The journal position the first of this sale's facts took. */
  boxSeq: number;
  /** How many facts this call put on the queue. One, on both paths today. */
  queued: number;
  /** What the drawer did. `not_asked` when this sale took no cash. */
  drawer: 'opened' | 'failed' | 'not_asked';
  /** Everything still waiting to go up, so the till can say "3 sales to send". */
  outboxDepth: number;
}

/** A station's receipt numbering, as the cache bundle last shipped it. */
export interface ReceiptMark {
  stationId: string;
  /** The station's `code_prefix`, which is the series name printed on the number. */
  prefix: string | null;
  /** The highest number the CLOUD has issued in this series. 0 means none. */
  highWaterMark: number;
}

/** Kept small: it is read by `collect_logs` and it lives in a Pi's memory. */
const LOG_RING = 500;

/**
 * The highest cache-bundle schema this agent can read, sent on every pull.
 *
 * Mirrors `CACHE_BUNDLE_SCHEMA_VERSION` in the api. A cloud that builds a
 * NEWER bundle refuses this box with `CACHE_SCHEMA_TOO_NEW` and raises an
 * alert naming the box, rather than handing over a document the agent would
 * half-understand — a counter running on a price list missing whatever was
 * added last week is the failure that rule exists to prevent.
 */
const CACHE_SCHEMA_VERSION = 1;

/**
 * The one cached scope that moves without anybody administering anything
 * (SCRUM-322): it carries where each station's receipt numbering stands, so a
 * finalised sale advances it. The cloud leaves it out of the bundle's version
 * for that reason, and the agent reads it on its own tick instead.
 */
const RECEIPT_SERIES = 'receipt_series' satisfies CachedBundle['scope'];

/**
 * The only commands an offline box takes (SCRUM-328).
 *
 * One kind, and the one that undoes the switch: a box that has been told to
 * stop talking to the cloud still has to be reachable by the instruction to
 * start again, or the Console's "Go online" is a button that cannot reach the
 * box it is for. Everything else stays queued in the cloud — the box does not
 * ask for it, so nothing hands it over and nothing marks it running.
 */
const OFFLINE_COMMAND_KINDS: readonly BoxCommandKind[] = ['go_online'];

/**
 * How long an account sign-in at the booth waits for the cloud (SCRUM-223).
 *
 * Under the six seconds the television gives the box (`REQUEST_TIMEOUT_MS` in
 * the booth page's client), so the page hears the box's own answer — "No
 * internet — sign in with your PIN" — instead of giving up first, while a
 * check still running behind it could sign the person in after the screen
 * said it had not. A healthy answer takes a few hundred milliseconds.
 */
const BOOTH_ACCOUNT_VERIFY_TIMEOUT_MS = 5_000;

/**
 * One measurement of the box's clock against the platform's (SCRUM-402), as
 * it is kept in `box_runtime` under `CLOCK_MEASUREMENT_KEY`.
 */
interface ClockMeasurement {
  /** Raw clock minus platform, in ms, at the moment of measuring. Positive: ahead. */
  offsetMs: number;
  /** The platform's time when it was taken (its `serverTime`). */
  measuredAt: string;
  /** The boot it was made in. A measurement from another boot is set aside. */
  bootId: string;
  /** `clockSkewMs` when it was taken, so a later move of the test control is known exactly. */
  skewMs: number;
  /**
   * The machine's wall clock (without the test control's skew) and its
   * monotonic clock, read together as the answer it was taken from came back.
   * Their difference only changes when the wall clock is stepped, which is
   * how a step is noticed.
   */
  wallAtMs: number;
  monoAtMs: number;
}

/**
 * The box's clocks, read together (SCRUM-402): the machine's wall clock and
 * the test control's skew on top of it, which together are the raw clock the
 * box measures, and the monotonic clock, which nothing can step and against
 * which a step of the wall clock is noticed.
 */
interface ClockReading {
  wallMs: number;
  skewMs: number;
  /** `wallMs + skewMs`. */
  rawMs: number;
  monoMs: number;
}

/** The `box_runtime` key the last measurement is kept under. */
const CLOCK_MEASUREMENT_KEY = 'box.clock_measurement';

/**
 * Past this the platform stops trusting an offset (its `CLOCK_TOLERANCE_MS`),
 * and a measurement this far out is worth a warning in the box's log.
 */
const CLOCK_IN_STEP_MS = 60_000;

/** A new measurement further than this from the last one is a step, and is logged. */
const CLOCK_STEP_NOTED_MS = 1_000;

/**
 * How far the wall clock may move against the monotonic clock before the
 * measurement is dropped as describing a clock that has since been stepped.
 * On Linux the two are slewed together by NTP and part only on a step, so
 * two seconds is far above anything but a step.
 */
const CLOCK_STEP_DROPPED_MS = 2_000;

/**
 * The process's own start, standing in for a boot where the machine names
 * none (see `BoxAgentOptions.bootId`).
 */
const PROCESS_BOOT = `process:${process.pid}:${Math.round(performance.timeOrigin)}`;

/**
 * Which boot of the machine this is. Linux names every boot with a fresh
 * random id, readable by anyone; that is what a Pi and the api on Render
 * both have.
 */
function currentBootId(): string {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (id) return `linux:${id}`;
  } catch {
    // Not Linux, or no /proc here: the process stands in.
  }
  return PROCESS_BOOT;
}

/** A measurement read back from the store, or null when it cannot be read as one. */
function parseClockMeasurement(raw: string): ClockMeasurement | null {
  try {
    const held = JSON.parse(raw) as Partial<ClockMeasurement> | null;
    if (!held || typeof held !== 'object') return null;
    if (typeof held.offsetMs !== 'number' || !Number.isFinite(held.offsetMs)) return null;
    if (typeof held.measuredAt !== 'string' || !Number.isFinite(Date.parse(held.measuredAt))) {
      return null;
    }
    if (typeof held.bootId !== 'string' || held.bootId === '') return null;
    if (typeof held.wallAtMs !== 'number' || !Number.isFinite(held.wallAtMs)) return null;
    if (typeof held.monoAtMs !== 'number' || !Number.isFinite(held.monoAtMs)) return null;
    const skewMs = typeof held.skewMs === 'number' && Number.isFinite(held.skewMs) ? held.skewMs : 0;
    return {
      offsetMs: held.offsetMs,
      measuredAt: held.measuredAt,
      bootId: held.bootId,
      skewMs,
      wallAtMs: held.wallAtMs,
      monoAtMs: held.monoAtMs,
    };
  } catch {
    return null;
  }
}

/** What a heartbeat refused for its clock carried (`BoxClockSkewDetails`), as far as it can be read. */
interface ClockSkewRefusal {
  /** The cloud's time as it refused, or null when the refusal did not say. */
  serverTime: string | null;
  /** The bound it refused against, in ms, or null when the refusal did not say. */
  maxSkewMs: number | null;
}

/**
 * A heartbeat the cloud refused for its clock, and what the refusal said
 * (`BoxClockSkewDetails`). Null for any other answer.
 */
function clockSkewRefusal(status: number, body: unknown): ClockSkewRefusal | null {
  if (status !== 400 || typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: { code?: unknown; details?: unknown } }).error;
  if (!error || error.code !== BOX_CLOCK_SKEW_ERROR) return null;
  const details = (error.details ?? null) as Partial<BoxClockSkewDetails> | null;
  const maxS = details?.maxClockSkewS;
  return {
    serverTime: typeof details?.serverTime === 'string' ? details.serverTime : null,
    maxSkewMs: typeof maxS === 'number' && Number.isFinite(maxS) && maxS >= 0 ? maxS * 1000 : null,
  };
}

/** What a heartbeat refused as stale carried (`BoxHeartbeatStaleDetails`), as far as it can be read. */
interface StaleRefusal {
  /** The cloud's time as it refused, or null when the refusal did not say. */
  serverTime: string | null;
  /** The last `reportedAt` the cloud accepted from this box, in ms, or null when the refusal did not say. */
  lastAcceptedMs: number | null;
}

/**
 * A heartbeat the cloud refused as stale — at or before the last one it
 * accepted from this box — and what the refusal said
 * (`BoxHeartbeatStaleDetails`). Null for any other answer.
 */
function heartbeatStaleRefusal(status: number, body: unknown): StaleRefusal | null {
  if (status !== 409 || typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: { code?: unknown; details?: unknown } }).error;
  if (!error || error.code !== BOX_HEARTBEAT_STALE_ERROR) return null;
  const details = (error.details ?? null) as Partial<BoxHeartbeatStaleDetails> | null;
  const acceptedMs =
    typeof details?.lastAcceptedReportedAt === 'string'
      ? Date.parse(details.lastAcceptedReportedAt)
      : Number.NaN;
  return {
    serverTime: typeof details?.serverTime === 'string' ? details.serverTime : null,
    lastAcceptedMs: Number.isFinite(acceptedMs) ? acceptedMs : null,
  };
}

// --- The journal's epoch comes from the platform (SCRUM-403) ----------------

/**
 * NO NEW FACT BEFORE A FRESH EPOCH.
 *
 * Every fact is sealed at `(box_id, journal_epoch, box_seq)`, and the cloud
 * holds a unique index on that address. A new store starts its journal at the
 * column's default — epoch 1, sequence 1 — and under a box the cloud already
 * knows, those are addresses the cloud already holds: it quarantines the new
 * facts or files them as replays of old ones (`apps/api/src/services/sync.ts`),
 * and the vouchers sealed there never reach a till (closing audit M16,
 * section 3). So a new store may seal only under an epoch the platform named
 * for it:
 *
 *  - REGISTRATION. A store created by the registration that gave the box its
 *    identity takes the epoch the registration answer names. A new box in the
 *    Console has never sealed anything, so its journal is clean.
 *  - A NEW STORE UNDER AN IDENTITY THE BOX ALREADY HAD — the file moved aside
 *    or lost from the card while the credential stayed, or a claim that
 *    registered the same box again (`claimBox`, through `journalHoldFor`).
 *    The platform's current epoch is the one the old store sealed under, so
 *    it waits for a NEW one: the Console's Reset the store mints it
 *    (`reset_store`), and the command's acknowledgement brings it. Until then
 *    every fact is refused, and a press at the booth is refused as "not
 *    ready" rather than sealed at an address the cloud already holds. The
 *    wait rides the heartbeat's `errors`.
 *
 * The state is kept in `box_runtime` under this key, so a restart in the
 * middle keeps waiting. A store with no note is one from before this rule and
 * keeps sealing as it did: its journal is already the platform's. Which is
 * why a note is never written apart from what it describes: the row and its
 * note, the named epoch and its note, a minted epoch and its note each land
 * in one transaction. A row made without its note — a power cut between two
 * writes, or a note the card refused — would read at the next start as a
 * store from before this rule, and seal at the default epoch.
 */
export const JOURNAL_EPOCH_KEY = 'journal_epoch';

interface JournalEpochNote {
  state: 'awaiting' | 'taken';
  /** The epoch the platform named, once it has. */
  epoch: number | null;
  /** Which answer named it. */
  from: 'register' | 'reset_store' | null;
  at: string;
}

function journalEpochNote(note: JournalEpochNote): string {
  return JSON.stringify(note);
}

/**
 * Whether the journal waits, by its note. No note does not wait: a store from
 * before this rule. A note that says `taken` does not wait. Every other note
 * waits — `awaiting`, and one that is there and cannot be read as either, a
 * card's garbling of what was written: it cannot say that the platform ever
 * named an epoch, and a store may seal only under one it named.
 */
function journalEpochAwaited(raw: string | null): boolean {
  if (raw === null) return false;
  let held: unknown;
  try {
    held = JSON.parse(raw);
  } catch {
    return true;
  }
  return !(
    typeof held === 'object' &&
    held !== null &&
    (held as { state?: unknown }).state === 'taken'
  );
}

/**
 * A fact refused because the store's journal has no epoch from the platform
 * yet. A `BoothRefusal` with the booth's own "not ready" code, so a press
 * comes back as the television's "Booth not ready — please call staff" — and
 * the spin's transaction, which it is thrown inside, takes the press, the
 * counters and the sequence back out with it.
 */
export class JournalEpochAwaitedError extends BoothRefusal {
  constructor() {
    super(
      'booth_not_ready',
      "This box's store is new and the platform has not given it a journal epoch, so nothing can be recorded; reset the store in Console → Devices → the box",
    );
    this.name = 'JournalEpochAwaitedError';
  }
}

/** What `readState` answers for a box the store keeps no row for (`store-sql.ts`). */
const NO_STATE_ROW = /No box_state row for /;

export function createBoxAgent(options: BoxAgentOptions): BoxAgent {
  const base = options.apiBaseUrl.replace(/\/$/, '');
  const call = options.fetch ?? httpTransport();
  const log = options.log ?? silentLog;
  const startedAt = Date.now();

  const store = options.store ?? null;
  let credential: string | null = null;
  let syncPrivateKeyPem: string | null = null;
  let outbox: Outbox | null = null;
  let sessions: StationSessionManager | null = null;
  let scanner: ScanRouter | null = null;
  let booth: Booth | null = null;
  /**
   * The `staff` cache scope, as the booth's sign-in reads it.
   *
   * Held here rather than read per attempt because the booth's `staff` option
   * is synchronous and a cache read is not. Refreshed wherever the cache
   * changes — on attach, so a box that comes back from a power cut knows its
   * people before the first pull, and after every successful pull, so somebody
   * removed from the list stops being able to sign in on the next one rather
   * than at the next restart.
   */
  let boothStaff: readonly BoothStaffRecord[] = [];
  /** The `sync_change` sequence the cache bundles were current to. */
  let cacheCursorSeq = 0;
  /**
   * The `bundleVersion` of the cache last applied, sent back as
   * `If-None-Match` so a pull that would land the same bytes costs a 304 and
   * nothing else. Null until the first full pull, and reset by anything that
   * throws the local copy away, so the pull after that is a whole one.
   */
  let cacheBundleVersion: string | null = null;
  /**
   * When the offline copies were last WRITTEN, when the cloud last CONFIRMED
   * them, and which of them this box has (SCRUM-323).
   *
   * All three ride the heartbeat, so the Console's box drawer can say whether a
   * box's copies are minutes or a week old — which it could not, because the
   * only record of it was `last_cache_applied_at` in the box's own store, and a
   * Pi's store is on the Pi. They are two timestamps rather than one because a
   * 304 confirms a copy without changing it: a healthy box that is told
   * "nothing has moved" all day has a fresh CHECK and an old APPLY, and painting
   * that box red would be wrong.
   *
   * The scopes are a SET that accumulates rather than the last pull's count,
   * which is not the same number the moment a pull is partial: a bundle with
   * one scope truncated would otherwise report a box holding eight copies as
   * holding eight NEW ones and the drawer would read it as what it has. A
   * process that has just started holds whatever the last one left in the store
   * and this set is empty — for one tick, because a start sends no
   * `If-None-Match` and the pull that follows is a whole one.
   */
  let cacheAppliedAt: string | null = null;
  let cacheCheckedAt: string | null = null;
  const cacheScopesHeld = new Set<string>();
  let bundle: BoxConfigBundle | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let cacheRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether `prepare` has started the booth since the last `stop`. */
  let boothStarted = false;
  let heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const cacheRefreshIntervalMs = options.cacheRefreshIntervalMs ?? 60_000;
  /**
   * Strictly increasing, because the cloud refuses a heartbeat whose reported
   * time is not after the last one it accepted — that refusal is its replay
   * defence, and a box whose clock steps backwards, under NTP or under a new
   * measurement against the platform (SCRUM-402), would otherwise silence
   * itself until the clock caught up. Every heartbeat sent raises it,
   * answered or not, because one whose answer was lost may still have been
   * accepted. One refused for its clock was not, and puts it back (see
   * `floorAfterClockRefusal`).
   *
   * It starts at nothing in every process, and a box that corrected its
   * clock left the cloud's watermark on the platform's time — or ahead of
   * it, while the floor was holding its reports after one it sent ahead. So
   * a new process can report at or before the watermark: after a reboot,
   * from a raw clock that is behind; after a restart in the same boot, from
   * the corrected clock without the floor. The cloud refuses that as stale
   * and names its watermark, and the floor goes up to it there (see
   * `heartbeat`): one heartbeat, not the minutes until real time passes the
   * watermark.
   */
  let lastReportedAt = 0;
  /**
   * The highest `reportedAt` the cloud is known to have accepted (SCRUM-402):
   * one it answered 200 to, or the watermark a stale refusal named. The one
   * floor known to be the cloud's own, and where a refusal for the clock puts
   * `lastReportedAt` back when nothing sent since can have been accepted.
   */
  let lastAcceptedReportedAt = 0;

  let printing: PrintingController | null = null;
  let terminals: TerminalController | null = null;
  /**
   * Cache scopes that did not land, counted per cause (S2-06).
   *
   * A log line on a box in a storeroom is read by nobody, so these ride the
   * heartbeat's `errors` — fingerprint, code and count, no contents — where
   * they reach `box.last_status` and the Console's box detail. That is the
   * difference between a box quietly holding an incomplete cache and somebody
   * being able to see that it does.
   */
  const cacheFaults = new Map<string, { code: string; count: number }>();
  /**
   * Facts refused while the journal waited for its epoch (SCRUM-403): the
   * count on the heartbeat's `journal:awaiting_epoch`, and when the wait was
   * last written to the log, so a busy booth writes it once a minute.
   */
  let journalRefusals = 0;
  let journalRefusalNotedAt: number | null = null;
  const ring: string[] = [];
  const state: BoxAgentState = {
    boxId: null,
    operatorId: options.operatorId ?? null,
    registered: false,
    configVersion: null,
    epoch: 1,
    journalAwaitingEpoch: false,
    offline: false,
    heartbeatsPaused: false,
    linkUp: false,
    clockSkewMs: 0,
    clockOffsetMs: null,
    clockMeasuredAt: null,
    lastHeartbeatAt: null,
    lastAckAt: null,
    commandsRun: 0,
    outboxDepth: 0,
    oldestUnackedS: null,
  };

  /**
   * THE BOX'S CLOCK (SCRUM-402).
   *
   * A Pi has no clock battery unless somebody fitted one. After a power cut it
   * comes back with the time Raspberry Pi OS last saved — at most a minute
   * before the cut, so BEHIND by about the length of it — and a mall network
   * that lets HTTPS out but blocks NTP never puts it right. The box used to
   * believe that clock: its heartbeats were refused as skewed and it showed
   * offline without the Console ever naming the clock, spins were filed on the
   * wrong trading day once the lag crossed 05:00, slips printed a stale issue
   * time with the expiry counted from it, and every event said `trusted`.
   *
   * So the box measures itself against the platform on every heartbeat:
   *
   *  - MEASUREMENT. `rawClock` is the machine's clock, plus the Console's
   *    "Advance box clock", which moves it on purpose. The box reads it just
   *    before a heartbeat goes and just after the answer comes back, and takes
   *    the answer's `serverTime` against the midpoint: offset = midpoint −
   *    server time, positive when the box is ahead, the sign the api's
   *    `clockOffsetMs` has always had. A heartbeat refused as `BOX_CLOCK_SKEW`
   *    carries the server's time in its details and is measured in exactly the
   *    same way, because that refusal is the one answer a badly wrong clock is
   *    sure to get.
   *  - CORRECTION. With a measurement made in THIS boot, `clock` is the raw
   *    clock minus the measured offset — the platform's time — and everything
   *    the box stamps or prints reads `clock`: the heartbeat's `reportedAt` (so
   *    the next heartbeat is accepted and the box shows online), every event's
   *    `occurredAt`, the slip's issue time and expiry, the booth's trading day
   *    and daily cap, and its "earlier than a moment already lived through"
   *    check. Without one, `clock` is the raw clock.
   *  - TRUST. With a measurement made in this boot an event is stamped
   *    `trusted`, and its `clockOffsetMs` is what the correction left over —
   *    zero, unless the test control has moved the raw clock since the
   *    measurement — never the raw offset, because `occurredAt` is already
   *    corrected. Without one it is `untrusted` with no offset, and the
   *    platform files it under the time it received it. A spin is flagged
   *    `clockSuspect` while the measured offset is past ten minutes, though its
   *    time is corrected.
   *  - BOOTS. A measurement is kept in the store with the boot it was made in,
   *    so a restart of the service keeps it and a reboot sets it aside: the
   *    clock it described is not the clock the machine came back with.
   *  - STEPS. For the same reason a measurement is dropped the moment the
   *    machine's clock is stepped — NTP getting through at last, somebody
   *    setting the date — which the box notices against its monotonic clock.
   *    The raw clock is used and events are `untrusted` until the next
   *    heartbeat measures again. Without this, a Pi measured twelve hours
   *    behind whose NTP then got through would stamp everything twelve hours
   *    AHEAD, as trusted, until that heartbeat. A step while a heartbeat is
   *    on the wire is caught the same way, between the exchange's two
   *    readings, and that exchange measures nothing: its midpoint would be
   *    off by half the step.
   *
   * What the box measured rides every heartbeat (`clock`), and that is the
   * box's clock on Health and in the Console's drawer — not the difference the
   * platform computes from `reportedAt`, which after the correction is little
   * more than the time on the wire.
   *
   * WAITS. One interval is timed on the raw clock: the re-registration
   * back-off, so a correction arriving mid-way cannot stretch or cut it.
   * Every other time the box waits for is a time on this clock, so a
   * correction moves whatever was set before it by the whole offset: later
   * when it moves the clock BACK (a box that booted ahead, measured), sooner
   * when it moves it forward. The outbox is held to its backoff: a retry time
   * further off than any backoff can set was set by a clock that has since
   * gone back, and the store sends it at once (`takeBatch`,
   * `OUTBOX_BACKOFF_CAP_MS`). Not yet the others: a slip waiting on paper is
   * retried that much later (`printing/queue.ts`), and a station lease
   * (`station-session.ts`), a booth staff session or a PIN lockout set before
   * the correction ends that much later, or sooner.
   */
  /** The machine's wall clock, before the test control's skew. */
  const wallClock = (): number => (options.now ? options.now() : Date.now());
  /** See `BoxAgentOptions.monotonic`. */
  const monotonic =
    options.monotonic ?? options.now ?? ((): number => Number(process.hrtime.bigint()) / 1e6);
  const rawClock = (): number => wallClock() + state.clockSkewMs;
  /** See `BoxAgentOptions.bootId`. Read once: a process does not change boots. */
  const bootId = options.bootId ?? currentBootId();
  /**
   * The measurement made in this boot, or null. Never one from another boot,
   * and read through `heldMeasurement`, which drops it once the wall clock has
   * been stepped since.
   */
  let measurement: ClockMeasurement | null = null;
  /** The box whose store the measurement is written to, once that store is open. */
  let measurementKeptFor: string | null = null;

  /** The measurement, while it still describes the machine's clock (see STEPS). */
  function heldMeasurement(): ClockMeasurement | null {
    const held = measurement;
    if (!held) return null;
    const steppedByMs = wallClock() - held.wallAtMs - (monotonic() - held.monoAtMs);
    if (Math.abs(steppedByMs) <= CLOCK_STEP_DROPPED_MS) return held;
    measurement = null;
    publishClockState();
    note(
      'warn',
      'the machine’s clock was stepped since the box measured it; events are untrusted until the next heartbeat measures again',
      { steppedByMs: Math.round(steppedByMs), measuredAt: held.measuredAt },
    );
    return null;
  }

  /** The box's clocks, read together; see `ClockReading`. */
  function readClocks(): ClockReading {
    const wallMs = wallClock();
    const skewMs = state.clockSkewMs;
    return { wallMs, skewMs, rawMs: wallMs + skewMs, monoMs: monotonic() };
  }

  /** The platform's time as this box reckons it, or its raw clock until it has measured. */
  const clock = (): number => {
    const held = heldMeasurement();
    return held ? rawClock() - held.offsetMs : rawClock();
  };

  /** What the correction leaves over: the test control's moves since the measurement. */
  function clockResidualMs(held: ClockMeasurement): number {
    return state.clockSkewMs - held.skewMs;
  }

  /** What every event queued from here is stamped with; see `BoxStore.stampClockWith`. */
  function clockStamp(): ClockStamp {
    const held = heldMeasurement();
    if (!held) return { clockTrust: 'untrusted' };
    return { clockTrust: 'trusted', clockOffsetMs: Math.round(clockResidualMs(held)) };
  }

  /**
   * The stamp this agent installs on its store: the clock's, once the journal
   * has an epoch from the platform (NO NEW FACT BEFORE A FRESH EPOCH, above
   * `JOURNAL_EPOCH_KEY`).
   *
   * The store reads it once for every run of facts it seals, inside the
   * transaction and after it has claimed their sequences — for every caller:
   * the booth's spin, the outbox, a till's sale. So a refusal thrown here
   * refuses them all, and rolls the sequences back rather than leaving a gap.
   */
  function sealStamp(): ClockStamp {
    if (state.journalAwaitingEpoch) {
      journalRefusals += 1;
      const at = rawClock();
      if (journalRefusalNotedAt === null || at - journalRefusalNotedAt >= 60_000) {
        journalRefusalNotedAt = at;
        note('warn', 'a fact was refused: this store waits for a new journal epoch from the platform', {
          refused: journalRefusals,
        });
      }
      throw new JournalEpochAwaitedError();
    }
    return clockStamp();
  }

  /**
   * The journal's note in `box_runtime`: null where there is none, or where
   * the store keeps no `box_runtime` to hold one (a platform database short of
   * migration 0013). A read that fails is not "no note" — that would release
   * a journal that waits, for the life of the process — so its error goes up:
   * the store cannot say whether it may seal, and on a Pi the runner takes
   * that for what it is, a store it cannot use (NEEDS SERVICE).
   */
  async function readJournalEpochNote(boxId: string): Promise<string | null> {
    if (!store) return null;
    try {
      return await store.readRuntimeValue(boxId, JOURNAL_EPOCH_KEY);
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return null;
      note('error', 'the store could not say whether its journal waits for a new epoch', {
        err: String(err),
      });
      throw err;
    }
  }

  /**
   * Write the journal's note inside the transaction `tx` belongs to, beside
   * what it describes (NO NEW FACT BEFORE A FRESH EPOCH): a note the card
   * refuses takes the rest of the transaction back with it.
   *
   * A store that keeps no `box_runtime` has nowhere to put one. A `taken`
   * note it can do without — a row with no note seals at the epoch it holds,
   * which is the one just named — but a wait it cannot keep is refused
   * loudly (`writeRuntimeValue` throws), because without the note a restart
   * would seal at an address the cloud already holds.
   */
  async function keepJournalEpochNote(
    tx: BoxStore,
    boxId: string,
    entry: JournalEpochNote,
  ): Promise<void> {
    if (entry.state === 'taken' && !tx.features().boothRuntime) {
      note('warn', 'this store keeps no box_runtime, so where its journal epoch came from is not kept', {
        epoch: entry.epoch,
      });
      return;
    }
    await tx.writeRuntimeValue(boxId, JOURNAL_EPOCH_KEY, journalEpochNote(entry), entry.at);
  }

  /**
   * Whether the store keeps a row for this box. A missing row is the only
   * "no". A store that cannot answer is not a new store, and taking it for one
   * would hold a journal that is running for a reset nobody needs; its error
   * goes up, and on a Pi a card that fails here is a store it cannot use.
   */
  async function stateRowHeld(boxId: string): Promise<boolean> {
    if (!store) return false;
    try {
      await store.readState(boxId);
      return true;
    } catch (err) {
      if (err instanceof Error && NO_STATE_ROW.test(err.message)) return false;
      throw err;
    }
  }

  /**
   * REGISTRATION: a store that holds nothing for the box just registered
   * starts its journal at the epoch the answer names — or, when the claim
   * says this is the same box again onto a new store (`journalHoldFor`),
   * waits for a new one. The row, its epoch and its note land in one
   * transaction. A store that already keeps this box's journal is left as it
   * is — registering again does not restart a journal, and one that waits
   * for a new epoch goes on waiting.
   */
  async function takeRegisteredEpoch(boxId: string, epoch: number): Promise<void> {
    if (!store) return;
    if (await stateRowHeld(boxId)) return;
    const hold = options.journalHoldFor === boxId;
    const at = new Date(clock()).toISOString();
    const named = await store.atomically(async (tx) => {
      const persisted = await tx.init(boxId);
      const value = Number.isInteger(epoch) && epoch > 0 ? epoch : persisted.journalEpoch;
      if (persisted.journalEpoch !== value) await tx.setEpoch(boxId, value, at);
      await keepJournalEpochNote(
        tx,
        boxId,
        hold
          ? { state: 'awaiting', epoch: null, from: null, at }
          : { state: 'taken', epoch: value, from: 'register', at },
      );
      return value;
    });
    // A held row says so as it is attached, a moment from now.
    if (!hold) {
      note('info', 'the store took its journal epoch from the registration', { boxId, epoch: named });
    }
  }

  /**
   * A `reset_store` acknowledged: the platform minted `epoch`, and it is the
   * new store's to seal under. The one way out of the wait. The epoch — and
   * with it the sequence back at 1 — and the note that says where it came
   * from land together.
   */
  async function takeMintedEpoch(epoch: number): Promise<void> {
    if (!store || !state.boxId || !Number.isInteger(epoch) || epoch < 1) return;
    const boxId = state.boxId;
    const at = new Date(clock()).toISOString();
    await store.atomically(async (tx) => {
      const persisted = await tx.readState(boxId);
      if (persisted.journalEpoch !== epoch) await tx.setEpoch(boxId, epoch, at);
      await keepJournalEpochNote(tx, boxId, { state: 'taken', epoch, from: 'reset_store', at });
    });
    if (state.journalAwaitingEpoch) {
      note('info', 'the platform minted a new journal epoch for this store; the box records again', {
        epoch,
        refused: journalRefusals,
      });
    }
    state.journalAwaitingEpoch = false;
    journalRefusals = 0;
    journalRefusalNotedAt = null;
  }

  /** The wait, on the heartbeat, as a fingerprint and a count like every other fault. */
  function journalFaultReports(): BoxHeartbeatRequest['errors'] {
    if (!state.journalAwaitingEpoch) return [];
    return [
      {
        fingerprint: 'journal:awaiting_epoch',
        code: 'box.journal_awaiting_epoch',
        count: Math.max(1, journalRefusals),
      },
    ];
  }

  /** What the booth reads to flag a spin and to decide which times are worth remembering. */
  function boothClockStanding(): BoothClockStanding | null {
    const held = heldMeasurement();
    if (!held) return null;
    const residualMs = clockResidualMs(held);
    return { rawOffsetMs: held.offsetMs + residualMs, residualMs };
  }

  /**
   * `state.clockOffsetMs` and `clockMeasuredAt`, from the measurement as it
   * stands. Reads `measurement` itself rather than `heldMeasurement`, because
   * the drop calls this.
   */
  function publishClockState(): void {
    const held = measurement;
    state.clockOffsetMs = held ? Math.round(held.offsetMs + clockResidualMs(held)) : null;
    state.clockMeasuredAt = held?.measuredAt ?? null;
  }

  /**
   * Measure the clock off one exchange whose answer carried the platform's
   * time, `platformMs`: `sent` and `answered` are the box's clocks read
   * either side of it. Answers whether it measured. When it did not, the box
   * keeps what it had — unless the machine's clock was stepped meanwhile,
   * which leaves nothing worth keeping.
   */
  async function measureClock(
    platformMs: number,
    sent: ClockReading,
    answered: ClockReading,
  ): Promise<boolean> {
    /**
     * The machine's clock was stepped while the heartbeat was on the wire
     * (see STEPS). The two readings straddle the step, so their midpoint is
     * off by half of it — a twelve-hour step measured as six, and every press
     * after it stamped `trusted` six hours out — and a measurement anchored
     * after the step would never be noticed as wrong. What the box held
     * describes the clock from before the step, so it goes too: the raw
     * clock, and `untrusted`, until the next heartbeat measures again.
     */
    const steppedByMs = answered.wallMs - sent.wallMs - (answered.monoMs - sent.monoMs);
    if (Math.abs(steppedByMs) > CLOCK_STEP_DROPPED_MS) {
      const dropped = measurement;
      measurement = null;
      publishClockState();
      note(
        'warn',
        'the machine’s clock was stepped while a heartbeat was on the wire; nothing is measured off it, and events are untrusted until the next heartbeat measures again',
        {
          steppedByMs: Math.round(steppedByMs),
          ...(dropped ? { droppedMeasuredAt: dropped.measuredAt } : {}),
        },
      );
      return false;
    }
    /**
     * The test control moved the raw clock while the heartbeat was on the
     * wire, so the midpoint would mix two clocks. What the box holds still
     * describes the machine, with the move as what the correction leaves
     * over, and the next heartbeat measures the moved clock.
     */
    if (answered.skewMs !== sent.skewMs) return false;
    const offsetMs = Math.round((sent.rawMs + answered.rawMs) / 2 - platformMs);
    const previous = measurement;
    const taken: ClockMeasurement = {
      offsetMs,
      measuredAt: new Date(platformMs).toISOString(),
      bootId,
      skewMs: answered.skewMs,
      // Anchored on the answer's own reading, so any step after it is one
      // `heldMeasurement` sees.
      wallAtMs: answered.wallMs,
      monoAtMs: answered.monoMs,
    };
    measurement = taken;
    publishClockState();
    if (!previous || Math.abs(previous.offsetMs - offsetMs) > CLOCK_STEP_NOTED_MS) {
      note(
        Math.abs(offsetMs) > CLOCK_IN_STEP_MS ? 'warn' : 'info',
        previous
          ? 'the box’s clock moved against the platform; stamping by the new measurement'
          : 'the box measured its clock against the platform; stamping by the platform’s time',
        { clockOffsetMs: offsetMs, measuredAt: taken.measuredAt },
      );
    }
    await keepClockMeasurement();
    return true;
  }

  /**
   * Write the measurement down, so a restart of the service in this boot
   * stamps `trusted` from its first second rather than from its first
   * heartbeat. A store without `box_runtime` — a platform database short of
   * migration 0013 — keeps it for this process only.
   */
  async function keepClockMeasurement(): Promise<void> {
    if (!store || !measurementKeptFor || !measurement) return;
    try {
      await store.writeRuntimeValue(
        measurementKeptFor,
        CLOCK_MEASUREMENT_KEY,
        JSON.stringify(measurement),
        new Date(clock()).toISOString(),
      );
    } catch (err) {
      if (err instanceof BoxStoreFeatureMissingError) return;
      note('warn', 'the clock measurement could not be written down; it holds for this process only', {
        err: String(err),
      });
    }
  }

  /** Bring back the measurement a previous process made — in this boot only. */
  async function restoreClockMeasurement(boxId: string): Promise<void> {
    if (!store || measurement) return;
    let raw: string | null;
    try {
      raw = await store.readRuntimeValue(boxId, CLOCK_MEASUREMENT_KEY);
    } catch (err) {
      if (!(err instanceof BoxStoreFeatureMissingError)) {
        note('warn', 'the clock measurement in the store could not be read', { err: String(err) });
      }
      return;
    }
    if (raw === null) return;
    const held = parseClockMeasurement(raw);
    if (!held) {
      note('warn', 'the clock measurement in the store is unreadable; the next heartbeat measures again');
      return;
    }
    if (held.bootId !== bootId) {
      note(
        'info',
        'the clock measurement in the store is from an earlier boot and is set aside; events are untrusted until the platform answers',
        { measuredAt: held.measuredAt, clockOffsetMs: held.offsetMs },
      );
      return;
    }
    measurement = held;
    publishClockState();
    note('info', 'the clock measurement made earlier in this boot is in use', {
      clockOffsetMs: held.offsetMs,
      measuredAt: held.measuredAt,
    });
  }

  function note(
    level: 'info' | 'warn' | 'error',
    msg: string,
    obj: Record<string, unknown> = {},
  ): void {
    ring.push(`${new Date(clock()).toISOString()} ${level} ${msg}`);
    if (ring.length > LOG_RING) ring.splice(0, ring.length - LOG_RING);
    log[level]({ ...obj, module: 'box-agent' }, msg);
  }

  function recordCacheFault(reason: CacheFaultReason, scope: string): void {
    const fingerprint = `${reason}:${scope}`.slice(0, 32);
    const held = cacheFaults.get(fingerprint) ?? { code: `box.cache_${reason}`, count: 0 };
    held.count += 1;
    cacheFaults.set(fingerprint, held);
  }

  /** A pull in which every scope landed clears them: the fault is over. */
  function clearCacheFaults(): void {
    cacheFaults.clear();
  }

  function cacheFaultReports(): BoxHeartbeatRequest['errors'] {
    return [...cacheFaults.entries()]
      .slice(0, 32)
      .map(([fingerprint, held]) => ({ fingerprint, code: held.code, count: held.count }));
  }

  async function request<T>(
    path: string,
    init: {
      method: string;
      body?: unknown;
      auth?: boolean;
      headers?: Record<string, string>;
      /** Less than the transport's allowance, for a person waiting on the answer. */
      answerTimeoutMs?: number;
    } = {
      method: 'GET',
    },
  ): Promise<{ status: number; body: T | null; etag: string | null }> {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.auth !== false) {
      if (!credential) throw new Error('box agent has no credential yet');
      headers.authorization = `Bearer ${credential}`;
    }
    let res: Awaited<ReturnType<AgentFetch>>;
    try {
      res = await call(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        ...(init.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: init.answerTimeoutMs }),
      });
    } catch (err) {
      // No answer at all: a dropped line, a DNS failure, a refused socket, or
      // a cloud that took the connection and did not answer in time.
      state.linkUp = false;
      throw err;
    }
    // A 502 from the platform's edge is the cloud not serving, whatever the
    // wire did; anything below that is the cloud answering.
    state.linkUp = res.status < 500;
    const etag = res.header('etag');
    if (res.status === 204 || res.status === 304) return { status: res.status, body: null, etag };
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      // A proxy's HTML error page, or an empty body on a status that should
      // have carried one. The status is the part worth acting on.
      body = null;
    }
    return { status: res.status, body, etag };
  }

  if (options.printing?.enabled !== false) {
    printing = createPrinting({
      bundle: () => bundle,
      /**
       * Straight out of the config bundle, so an edit made on the Console
       * reaches the paper by the route every other piece of branch
       * configuration takes: the edit bumps `configVersion`, the next
       * heartbeat's ack differs from what this box has applied, and
       * `syncConfig` pulls. Nothing here caches a template separately, so
       * there is no second copy to go stale.
       */
      templates: () => cachedTemplates,
      now: () => new Date(clock()),
      log: (level, msg, detail) => note(level, msg, detail),
      report: (outcome) => reportPrintJob(outcome),
      openReal: options.printing?.openReal,
      retryDelayMs: options.printing?.retryDelayMs,
      /**
       * Asked on every write, because the box id is learned at registration
       * and the store is opened then — see `PrintSubsystemOptions.durable`.
       */
      ...(options.printing?.durable
        ? {
            durable: () => {
              const jobs = store?.printJobs() ?? null;
              return jobs && state.boxId && state.registered ? { jobs, boxId: state.boxId } : null;
            },
          }
        : {}),
    });
  }

  if (options.terminal?.enabled !== false) {
    terminals = createTerminals({
      bundle: () => bundle,
      /**
       * The store, because the reference counter lives in it.
       *
       * A box without one refuses card tenders by name rather than minting
       * references from memory: an in-memory counter restarts at one after a
       * power cut, and a reference a terminal has already seen today is either
       * refused by it or — worse, on the inquiry path — matched to the wrong
       * transaction.
       */
      store,
      boxId: () => state.boxId,
      now: () => new Date(clock()),
      log: (level, msg, detail) => note(level, msg, detail),
      openSerial: options.terminal?.openSerial,
      voidPassword: options.terminal?.voidPassword ?? null,
    });
  }

  /**
   * The bundle's print templates, VALIDATED rather than cast.
   *
   * The wire type says `type: string` because the contract is deliberately
   * loose about a vocabulary the cloud may extend before this agent is
   * updated. Casting that to the closed union would be this file asserting a
   * guarantee the wire does not give — and the failure would be silent: a
   * template of an unknown type would reach the renderer's `resolveTemplate`,
   * match nothing, and print a receipt missing whatever it carried. So each
   * one is parsed, an unreadable one is dropped by name, and the rest are
   * used. Re-computed only when the bundle changes, because a receipt is
   * rendered per job and this is not free.
   */
  let cachedTemplates: readonly PrintTemplate[] = [];

  function adoptTemplates(next: BoxConfigBundle | null): void {
    const out: PrintTemplate[] = [];
    for (const raw of next?.printTemplates ?? []) {
      const parsed = PrintTemplateSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
      else note('warn', 'a print template in the bundle could not be read and was dropped', {
        id: typeof raw?.id === 'string' ? raw.id : null,
        type: typeof raw?.type === 'string' ? raw.type : null,
      });
    }
    cachedTemplates = out;
  }

  /**
   * Tell the cloud how a print job ended.
   *
   * Its own endpoint rather than the command result, because the two answer
   * different questions and a box that conflated them would lie about one of
   * them: a command result says "I took this instruction", and it is sent once,
   * seconds after the button; a job outcome says "paper came out", and for a
   * job that waited half an hour on an empty roll it is sent long after the
   * command was acknowledged. A box that is offline reports nothing and keeps
   * the job in its queue — the cloud row stays `queued`, which is true.
   */
  async function reportPrintJob(outcome: PrintJobOutcome): Promise<void> {
    /**
     * A booth voucher's outcome goes to the OUTBOX, not up this route (D20).
     *
     * The cloud's print-result route writes onto an `edge.print_job` row that
     * the cloud created. A booth's job was raised on the box, for a spin the
     * cloud has not heard about yet, so there is no row to write onto — an
     * offline booth reporting up this route would be reporting against
     * nothing. As a fact it queues behind the spin and the voucher and arrives
     * in the right order whenever the link comes back.
     *
     * Asked of the booth rather than switched on the kind, because
     * `PrintJobOutcome` does not carry one — and a Console test print of a
     * sample voucher is a `booth_voucher` with a cloud row. The booth knows
     * which ids are its own: the ones a previous process left unprinted or
     * interrupted, which it adopts at start-up for exactly this reason, and
     * the ones it has already reported, which it goes on answering for.
     */
    if (booth?.ownsPrintJob(outcome.id)) {
      await booth.reportPrint(outcome);
      return;
    }
    if (!credential || state.offline) return;
    const { status } = await request(`/box/v1/print-jobs/${outcome.id}/result`, {
      method: 'POST',
      body: {
        status: outcome.status,
        attempts: outcome.attempts,
        deviceId: outcome.deviceId,
        role: outcome.role,
        stationId: outcome.stationId,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        overflow: outcome.overflow,
        elapsedMs: outcome.elapsedMs,
      },
    });
    if (status !== 200) {
      note('warn', 'the cloud did not accept a print job outcome', {
        jobId: outcome.id,
        status,
      });
    }
  }

  /**
   * A tender's outcome, on its own route (S2-10a).
   *
   * NOT on the command's acknowledgement, and the reason is the one at
   * `:474-484`: a command result says "I took this instruction" and an outcome
   * says what the terminal did, which can be a hundred and twenty seconds later
   * while a guest finds a card. A command ack held open for that is a box that
   * looks hung on the Console, and a poll cycle that cannot deliver the next
   * instruction.
   *
   * Two stages on one route. `progress` carries the QR payload the moment the
   * terminal mints it, because the customer display has to draw the code BEFORE
   * the guest pays; `final` carries the outcome. The route itself is the
   * cloud's (Slice C2) — what this file fixes is the shape.
   */
  async function reportTerminalResult(
    attemptId: string,
    body: Record<string, unknown>,
    actionId: string | null,
  ): Promise<void> {
    if (!credential || state.offline) return;
    const { status } = await request(`/payments/attempts/${attemptId}/result`, {
      method: 'POST',
      body,
      headers: actionId ? { 'x-oto-action-id': actionId } : {},
    });
    if (status !== 200 && status !== 202) {
      note('warn', 'the cloud did not accept a terminal outcome', { attemptId, status });
    }
  }

  function terminalResultBody(result: TerminalResult): Record<string, unknown> {
    return {
      stage: 'final',
      deviceId: result.deviceId,
      protocol: result.protocol,
      outcome: result.outcome,
      requestedSatang: result.requestedSatang,
      approvedSatang: result.approvedSatang,
      terminalRef: result.terminalRef,
      tranRef: result.tranRef,
      invoiceNo: result.invoiceNo,
      approvalCode: result.approvalCode,
      last4: result.last4,
      tid: result.tid,
      mid: result.mid,
      qrPayload: result.qrPayload,
      responseCode: result.responseCode,
      responseText: result.responseText,
      elapsedMs: result.elapsedMs,
      at: result.at,
    };
  }

  function terminalProgressBody(event: TerminalProgress): Record<string, unknown> {
    return {
      stage: 'progress',
      kind: event.kind,
      deviceId: event.deviceId,
      qrPayload: event.qrPayload ?? null,
      tranRef: event.tranRef ?? null,
      at: event.at,
    };
  }

  async function ensureRegistered(): Promise<boolean> {
    if (credential) return false;
    const held = await options.credentials.read();
    if (held) {
      credential = boxCredential(held.boxId, held.secret);
      state.boxId = held.boxId;
      state.registered = true;
      if (held.syncPrivateKeyPem) {
        syncPrivateKeyPem = held.syncPrivateKeyPem;
      } else {
        // A box registered before S2-05. Its claim code is spent, so there is
        // no way back through `/register`; it mints a key here and offers the
        // public half on its next heartbeat, which is authenticated by the
        // same secret registration used.
        const pair = generateSyncKeyPair();
        syncPrivateKeyPem = pair.privateKeyPem;
        await options.credentials.write({ ...held, syncPrivateKeyPem: pair.privateKeyPem });
        note(
          'warn',
          'this box had no sync key; one was minted and will be offered on the next heartbeat',
        );
      }
      note('info', 'box credential loaded from the store', { boxId: held.boxId });
      await attachStore(held.boxId);
      return false;
    }
    const claimCode = options.claimCode ? await options.claimCode() : null;
    if (!claimCode) {
      note('warn', 'no credential and no claim code — this box cannot register yet');
      return false;
    }
    const pair = generateSyncKeyPair();
    const { status, body } = await request<BoxRegisterResponse>('/box/v1/register', {
      method: 'POST',
      auth: false,
      body: {
        claimCode,
        agentVersion: BOX_AGENT_VERSION,
        hostname: options.hostname,
        syncPublicKey: pair.publicKeyPem,
        syncKeyAlgorithm: 'ed25519',
      },
    });
    if (status !== 200 || !body) {
      note('error', 'registration refused', { status });
      throw new Error(`box registration failed with ${status}`);
    }
    // Written BEFORE anything else: the secret and the private key exist in
    // exactly one place until this line, and the cloud will never send the
    // secret again and has never held the key.
    await options.credentials.write({
      boxId: body.boxId,
      secret: body.secret,
      syncPrivateKeyPem: pair.privateKeyPem,
    });
    credential = boxCredential(body.boxId, body.secret);
    syncPrivateKeyPem = pair.privateKeyPem;
    state.boxId = body.boxId;
    state.operatorId = body.operatorId;
    state.registered = true;
    state.epoch = body.epoch;
    heartbeatIntervalMs = options.heartbeatIntervalMs ?? body.heartbeatIntervalS * 1000;
    note('info', 'box registered', { boxId: body.boxId, slot: body.slot, epoch: body.epoch });
    // Before the store is attached, so a store made by this registration
    // seals under the epoch the platform just named, and never the default.
    await takeRegisteredEpoch(body.boxId, body.epoch);
    await attachStore(body.boxId);
    return true;
  }

  /**
   * Open the store and adopt what the last process left behind.
   *
   * The order matters: the offline flag and the epoch are read BEFORE the
   * outbox starts, so a box that was offline when the power went does not
   * spend its first second back trying to push.
   */
  async function attachStore(boxId: string): Promise<void> {
    if (!store || outbox) return;
    await restoreConfig(boxId);
    /**
     * NO NEW FACT BEFORE A FRESH EPOCH (above `JOURNAL_EPOCH_KEY`). A
     * registration in this process has already made the row and named its
     * epoch, so a row made HERE belongs to a store that is new under an
     * identity the box already had, and it waits for the platform to mint a
     * new epoch. Decided before anything can queue a fact — and the row is
     * made with its note, in one transaction, or not at all.
     */
    const held = await stateRowHeld(boxId);
    if (!held) {
      const at = new Date(clock()).toISOString();
      await store.atomically(async (tx) => {
        await tx.init(boxId);
        await keepJournalEpochNote(tx, boxId, { state: 'awaiting', epoch: null, from: null, at });
      });
    }
    const persisted = await store.init(boxId);
    state.offline = persisted.offline;
    state.epoch = persisted.journalEpoch;
    state.clockSkewMs = persisted.clockSkewMs;
    state.journalAwaitingEpoch = held
      ? journalEpochAwaited(await readJournalEpochNote(boxId))
      : true;
    if (state.journalAwaitingEpoch) {
      note(
        'error',
        'this store is new under an identity this box already had: it records nothing until the platform gives it a new journal epoch — Console → Devices → the box → Reset the store',
        { boxId, epochNow: persisted.journalEpoch },
      );
    }
    /**
     * The clock, before anything can queue a fact (SCRUM-402): the measurement
     * made earlier in this boot, if a previous process made one — read after
     * the skew, because it is a measurement of the raw clock the skew is part
     * of — and the stamp every event is sealed with from here on.
     */
    measurementKeptFor = boxId;
    await restoreClockMeasurement(boxId);
    store.stampClockWith(boxId, sealStamp);

    outbox = createOutbox({
      store,
      boxId,
      privateKey: () => syncPrivateKeyPem,
      isOffline: async () => (await store.readState(boxId)).offline,
      push: (body) => pushBatch(body),
      intervalMs: options.syncIntervalMs ?? 5_000,
      now: () => new Date(clock()),
      log,
      onEpoch: (epoch) => {
        state.epoch = epoch;
      },
    });

    sessions = new StationSessionManager({
      store,
      boxId,
      resolveStation: (stationId) => stationIdentity(boxId, stationId),
      queueFact: async (fact) => {
        await outbox?.queue(fact);
      },
      now: () => new Date(clock()),
      log,
    });

    /**
     * The scanning service (S2-06).
     *
     * It needs the store — every scan leaves a redacted line on the station's
     * own tape — and the session manager, because the screens watching a
     * station are where the result is shown. Handlers are registered by the
     * tickets that own what a code MEANS; today none is, and a scan resolves
     * `unhandled`, which the till shows rather than swallowing.
     */
    scanner = new ScanRouter({
      boxId,
      store,
      publish: (stationId, message) => sessions?.emitScan(stationId, message),
      now: () => new Date(clock()),
      log,
    });

    /**
     * The Lucky Wheel (S2-07a).
     *
     * Constructed with the store, the box's signing key and a port to the
     * printer — and with no way of reaching the cloud, which is D2 expressed
     * as a constructor rather than as a rule somebody has to remember. It is
     * built on every box with a store; whether it has a booth to run is
     * answered by the config bundle, below.
     */
    if (options.booth?.enabled !== false) {
      await refreshBoothStaff(boxId);
      booth = createBooth({
        boxId,
        store,
        station: boothStation,
        branch: boothBranch,
        privateKey: () => syncPrivateKeyPem,
        print: printing
          ? {
              submit: (request) => printing!.submit(request),
              hold: (request, until) => printing!.hold(request, until),
            }
          : null,
        printerHealth: () => printing?.jobs.health() ?? {},
        staff: () => boothStaff,
        ...(options.booth?.verifySecret ? { verifySecret: options.booth.verifySecret } : {}),
        verifyAccount: (request) => verifyBoothAccount(request),
        printTemplates: () => cachedTemplates,
        ...(options.booth?.randomIndex ? { randomIndex: options.booth.randomIndex } : {}),
        now: () => new Date(clock()),
        clockStanding: boothClockStanding,
        log,
      });
    }

    note('info', 'box store attached', {
      boxId,
      offline: persisted.offline,
      epoch: persisted.journalEpoch,
    });
  }

  /**
   * Bring back the last bundle this box adopted, before anything asks for it
   * (SCRUM-223). A bundle for a different box — a card moved between Pis — is
   * not used: the stations in it are somebody else's.
   */
  async function restoreConfig(boxId: string): Promise<void> {
    if (bundle || !options.configCache) return;
    try {
      const held = await options.configCache.read();
      if (!held) return;
      if (held.box?.id && held.box.id !== boxId) {
        note('warn', 'the config on disk belongs to another box and was not used', {
          held: held.box.id,
        });
        return;
      }
      bundle = options.configTransform ? options.configTransform(held) : held;
      adoptTemplates(bundle);
      state.configVersion = held.configVersion;
      note('info', 'config restored from the copy on disk', {
        configVersion: held.configVersion,
        stations: held.stations.length,
      });
    } catch (err) {
      note('warn', 'the config on disk could not be read', { err: String(err) });
    }
  }

  /** The booth station this box runs, if its bundle names one. See `booth.stationId`. */
  function boothStation(): BoothStationContext | null {
    const booths = (bundle?.stations ?? []).filter((s) => s.kind === 'booth');
    if (booths.length === 0) return null;
    let station = booths[0]!;
    if (options.booth?.stationId) {
      const chosen = options.booth.stationId();
      const found = chosen ? booths.find((s) => s.id === chosen) : undefined;
      if (found) station = found;
      else if (booths.length > 1) return null;
    }
    return { id: station.id, name: station.name, codePrefix: station.codePrefix };
  }

  /**
   * Ask the cloud whether a phone and password may sign in at this booth
   * (SCRUM-223), under this box's own credential.
   *
   * Every way of not getting a verdict — the Console's offline switch, no
   * credential yet, a dropped line, no answer within
   * `BOOTH_ACCOUNT_VERIFY_TIMEOUT_MS`, the cloud not serving — is `offline`,
   * and the television then says to use the PIN, which the box can check
   * alone. The password is sent once in the body and kept nowhere.
   *
   * An answer that refuses the BOX is not `offline`, because the internet is
   * fine and saying otherwise sends staff to check a cable: a 401 that is not
   * a wrong password, or `BOX_DISABLED`, is this box's own credential refused
   * (`box_refused`); `BOOTH_NOT_ON_THIS_BOX` is a booth moved or archived in
   * the Console (`booth_not_on_box`). Neither drops the credential here: the
   * box's own calls — the command poll, the heartbeat, the pulls — meet the
   * same 401 within seconds and take the refusal path, which registers again
   * at most once a minute (`reregister.ts`).
   */
  async function verifyBoothAccount(req: {
    stationId: string;
    phone: string;
    password: string;
  }): Promise<BoothAccountVerdict> {
    if (!credential || state.offline) return { ok: false, reason: 'offline' };
    let answer: { status: number; body: unknown };
    try {
      answer = await request<unknown>(BOOTH_STAFF_VERIFY_PATH, {
        method: 'POST',
        body: req,
        answerTimeoutMs: BOOTH_ACCOUNT_VERIFY_TIMEOUT_MS,
      });
    } catch {
      return { ok: false, reason: 'offline' };
    }
    const body =
      typeof answer.body === 'object' && answer.body !== null
        ? (answer.body as Record<string, unknown>)
        : null;
    if (answer.status === 200 && body && typeof body.accountId === 'string') {
      return {
        ok: true,
        accountId: body.accountId,
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
        staffCode: typeof body.staffCode === 'string' ? body.staffCode : null,
      };
    }
    const error = (body?.error ?? null) as { code?: unknown; details?: unknown } | null;
    const code = typeof error?.code === 'string' ? error.code : null;
    switch (code) {
      case BOOTH_STAFF_VERIFY_ERRORS.invalid:
        return { ok: false, reason: 'wrong' };
      case BOOTH_STAFF_VERIFY_ERRORS.notAllowed:
        return { ok: false, reason: 'not_allowed' };
      case BOOTH_STAFF_VERIFY_ERRORS.notAssigned:
        return { ok: false, reason: 'not_assigned' };
      case BOOTH_STAFF_VERIFY_ERRORS.mustChangePassword:
        return { ok: false, reason: 'must_change_password' };
      case BOOTH_STAFF_VERIFY_ERRORS.locked: {
        const seconds = (error?.details as { retryAfterS?: unknown } | undefined)?.retryAfterS;
        return typeof seconds === 'number'
          ? { ok: false, reason: 'locked', retryAfterMs: seconds * 1000 }
          : { ok: false, reason: 'locked' };
      }
      case BOOTH_STAFF_VERIFY_ERRORS.boothNotOnBox:
        note('warn', 'the cloud says this booth is not on this box any more', {
          stationId: req.stationId,
        });
        return { ok: false, reason: 'booth_not_on_box' };
      case BOOTH_STAFF_VERIFY_ERRORS.boxDisabled:
        note('warn', 'the cloud refused a booth sign-in: this box is taken out of service');
        return { ok: false, reason: 'box_refused' };
    }
    if (answer.status === 401) {
      // Not a wrong password — that is `INVALID_CREDENTIALS`, above — so the
      // credential refused is this box's own.
      note('warn', 'the cloud refused a booth sign-in: this box’s credential is not accepted', {
        code,
      });
      return { ok: false, reason: 'box_refused' };
    }
    if (answer.status === 429) return { ok: false, reason: 'locked' };
    note('warn', 'the cloud could not check a booth sign-in', { status: answer.status, code });
    return { ok: false, reason: 'offline' };
  }

  /**
   * The branch, which is what turns an instant into a trading day.
   *
   * Null when the box has not applied a config bundle yet — and that null is
   * load-bearing: `booth.spin.business_date` is NOT NULL with no default, so a
   * spin whose trading day cannot be resolved is refused rather than filed on
   * whatever a database would have guessed.
   */
  function boothBranch(): BoothBranchContext | null {
    const branch = bundle?.branch;
    const operatorId = branch?.operatorId ?? state.operatorId;
    if (!branch || !operatorId) return null;
    return {
      id: branch.id,
      operatorId,
      name: branch.name,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    };
  }

  /**
   * Re-read the cached staff list the booth's sign-in verifies against.
   *
   * The booth fields (`pinHash`, `badgeHash`, `staffCode`) are optional on
   * every entry, so a bundle built before they existed parses and simply
   * yields nobody who can sign in — which is the current state of the fleet,
   * because nothing writes them yet. The cast is narrow and checked: anything
   * without a string `accountId` is dropped rather than carried as a record
   * with a hole in it.
   */
  async function refreshBoothStaff(boxId: string): Promise<void> {
    if (!store) return;
    try {
      const held = await store.readBundle(boxId, 'staff');
      const items = held?.payload?.items;
      if (!Array.isArray(items)) {
        boothStaff = [];
        return;
      }
      const records: BoothStaffRecord[] = [];
      for (const raw of items) {
        if (typeof raw !== 'object' || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.accountId !== 'string') continue;
        records.push({
          accountId: entry.accountId,
          status: typeof entry.status === 'string' ? entry.status : 'unknown',
          pinHash: typeof entry.pinHash === 'string' ? entry.pinHash : null,
          badgeHash: typeof entry.badgeHash === 'string' ? entry.badgeHash : null,
          staffCode: typeof entry.staffCode === 'string' ? entry.staffCode : null,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : null,
        });
      }
      boothStaff = records;
    } catch (err) {
      note('warn', 'the cached staff list could not be read for the booth', { err: String(err) });
    }
  }

  /** Which of this box's stations a device is assigned to, if any. */
  function stationForDevice(deviceId: string | undefined): string | null {
    if (!deviceId) return null;
    for (const station of bundle?.stations ?? []) {
      if (station.devices.some((d) => d.id === deviceId)) return station.id;
    }
    return null;
  }

  function stationIdentity(boxId: string, stationId: string): StationIdentity | null {
    const station = bundle?.stations.find((s) => s.id === stationId);
    if (!station) return null;
    const operatorId = bundle?.branch.operatorId ?? state.operatorId;
    const branchId = bundle?.branch.id;
    if (!operatorId || !branchId) return null;
    return { stationId, boxId, operatorId, branchId };
  }

  async function pushBatch(
    body: SyncPushRequest,
  ): Promise<{ status: number; body: SyncPushResponse | null }> {
    const { status, body: answer } = await request<SyncPushResponse>('/box/v1/sync/push', {
      method: 'POST',
      body,
    });
    if (status === 401) {
      await reregisterAfterRefusal('sync push');
    }
    return { status, body: answer };
  }

  /** The one-a-minute door on the refusal path below. The rule is in `reregister.ts`. */
  const refusals = createRefusalBackOff();

  /**
   * A credential that stopped working is not a reason to give up: an
   * administrator rotating a box's claim code is exactly how a stolen box is
   * cut off and a replacement Pi is brought up in its slot, and the honest
   * response from this side is to drop what we hold and register again if we
   * can.
   *
   * **At most once a minute, since SCRUM-331.** That answer, given to every
   * refusal, is also how two agents sharing one box row storm: each
   * registration takes the other's secret away, so each refusal breeds the
   * next at one cycle per tick, and every registration re-pulls the whole
   * offline cache because it has no etag. `reregister.ts` holds the rule; the
   * window bounds the damage while the cloud side (a lease over the virtual
   * box) stops two agents existing at all.
   *
   * While the door is shut the credential is KEPT on purpose, refused though
   * it is. Dropping it would silence the box — every caller below returns
   * early without one, so nothing would produce the next refusal, and a
   * refusal is the only thing that reopens the door.
   */
  async function reregisterAfterRefusal(where: string): Promise<boolean> {
    // The raw clock: this is a window of time, not a stamp (see THE BOX'S CLOCK).
    const verdict = refusals.refused(rawClock());
    if (!verdict.register) {
      note(
        'warn',
        `credential refused on ${where} — ${verdict.swallowed} refusal${
          verdict.swallowed === 1 ? '' : 's'
        } inside the back-off window, not registering again for ${Math.ceil(
          verdict.reopensInMs / 1000,
        )}s`,
      );
      return false;
    }
    note('warn', `credential refused on ${where} — dropping it and trying to register again`);
    credential = null;
    state.registered = false;
    await options.credentials.clear();
    try {
      const registered = await ensureRegistered();
      // The count restarts from a box that is actually registered again; the
      // window does not, for the reason `reregister.ts` sets out.
      if (registered) refusals.registered();
      return registered;
    } catch {
      return false;
    }
  }

  function deviceReports(): DeviceReport[] {
    const devices: BoxConfigDevice[] = (bundle?.stations ?? []).flatMap((s) => s.devices);
    const seen = new Set<string>();
    const reports: DeviceReport[] = [];
    /**
     * What the printers themselves last said (S2-06).
     *
     * Measured, not assumed: before this, every printer on a box reported
     * `reachable` / `ok` because nothing had asked it anything, which is the
     * one answer a health indicator must never give by default. A printer the
     * box has not managed to talk to yet is absent from this map and falls
     * through to `unknown` below.
     */
    const printerHealth = printing?.jobs.health() ?? {};
    for (const device of devices) {
      // One device can serve two roles on one station; it is still one device.
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      /**
       * The S2-04 fault injection still wins where it is set. It is how a test
       * and the Console's older controls make a device misbehave without a
       * simulator, and a fault somebody deliberately asked for must not be
       * overwritten by a probe that found the machine healthy.
       */
      const fault = options.faults?.[device.id] ?? options.faults?.[device.label];
      const health = printerHealth[device.id];
      reports.push({
        id: device.id,
        address: device.address ?? undefined,
        kind: device.kind,
        model: device.model ?? undefined,
        reachability: fault?.reachability ?? health?.reachability ?? 'unknown',
        paperStatus: fault?.paperStatus ?? health?.paperStatus ?? 'unknown',
        lastError: fault?.lastError ?? health?.lastError ?? undefined,
      });
    }
    return reports;
  }

  /**
   * Re-read the persisted offline flag.
   *
   * The second way a box comes back, and the slower one. For the virtual box
   * the store IS `edge.box_state`, so anything that writes that row — a hand
   * edit, another process holding the same box — is noticed on the next
   * heartbeat tick. Nothing in the Console writes it: "Go online" queues a
   * `go_online` command like every other button on the drawer
   * (`BoxDrawer.tsx`), and `runPendingCommands` below is what collects it
   * while the box is offline. That is the way back that also works for a Pi,
   * whose only link to the cloud is that poll.
   */
  async function refreshOffline(): Promise<boolean> {
    if (!store || !state.boxId) return state.offline;
    const persisted = await store.readState(state.boxId);
    if (persisted.offline !== state.offline) {
      note('info', persisted.offline ? 'box went offline' : 'box came back online', {
        reason: persisted.offlineReason,
      });
    }
    state.offline = persisted.offline;
    state.epoch = persisted.journalEpoch;
    return state.offline;
  }

  async function syncConfig(): Promise<boolean> {
    if (!credential || state.offline) return false;
    const { status, body } = await request<BoxConfigBundle>('/box/v1/config', {
      method: 'GET',
      headers: state.configVersion ? { 'if-none-match': `"${state.configVersion}"` } : {},
    });
    if (status === 304) return false;
    if (status === 401) {
      await reregisterAfterRefusal('config');
      return false;
    }
    if (status !== 200 || !body) {
      note('error', 'config could not be read', { status });
      return false;
    }
    const changed = body.configVersion !== state.configVersion;
    bundle = options.configTransform ? options.configTransform(body) : body;
    adoptTemplates(bundle);
    if (options.configCache) {
      await options.configCache.write(body).catch((err: unknown) => {
        note('warn', 'the config could not be kept on disk', { err: String(err) });
      });
    }
    state.configVersion = body.configVersion;
    state.epoch = body.box.epoch;
    heartbeatIntervalMs = options.heartbeatIntervalMs ?? body.heartbeatIntervalS * 1000;
    if (changed) {
      note('info', 'config applied', {
        configVersion: body.configVersion,
        stations: body.stations.length,
        devices: body.stations.reduce((n, s) => n + s.devices.length, 0),
      });
    }
    if (isBelow(BOX_AGENT_VERSION, body.minSupportedAgentVersion)) {
      note('warn', 'this agent is below the minimum version the cloud supports', {
        agentVersion: BOX_AGENT_VERSION,
        minSupportedAgentVersion: body.minSupportedAgentVersion,
      });
    }
    return changed;
  }

  /**
   * Take a copy of everything this counter needs with no internet (S2-06).
   *
   * The route has existed since S2-05 and nothing called it, which is the
   * quietest kind of gap: every box in the fleet reported healthy and held an
   * empty cache, and the first thing to discover it would have been a till
   * that could not check a password during an outage. Offline unlock is what
   * needed it, so this is where it gets its caller.
   *
   * **Whole or not at all, per scope.** `writeBundle` replaces a scope's
   * payload, so a person removed from the staff list is gone from the box on
   * the next pull rather than lingering until something expires — which is the
   * ticket's "the box drops cached staff not in the latest bundle".
   *
   * A scope the cloud TRUNCATED is skipped rather than applied: a half staff
   * list would silently refuse the people who fell off the end of it. The
   * honest answer is to keep the last complete copy and say so.
   *
   * **The staff list and the deny-list are one answer in two scopes**, and
   * this is where that is enforced. Written in the order `planCacheApply`
   * gives — the deny-list first — and abandoned at the first failure, so every
   * state this loop can stop in has a deny-list at least as fresh as the staff
   * list beside it. The reverse order was reachable before and was the quiet
   * one: a box left holding a current staff list and last week's revocations,
   * with nothing to say it had happened. A skip or a failure is now a fault
   * the heartbeat carries (`errors`) as well as a line in the box log.
   *
   * **Called on a timer, not only at start.** Until SCRUM-275 this had one
   * caller, in `start()`, and the consequence was measured from the booth's
   * side: a wheel published in the Console reached the television at the next
   * agent restart and not before, and a booth PIN withdrawn in the Console
   * kept signing that person in until then. The timer set in `start()` and the
   * `config_apply` command both come here now. The ordinary tick is a 304 —
   * the last `bundleVersion` goes up as `If-None-Match` — so a box that has
   * nothing new to learn pays one small request a minute for it.
   */
  async function syncCache(): Promise<string[]> {
    if (!credential || !store || !state.boxId || state.offline) return [];
    const boxId = state.boxId;
    const applied = await pullBundle(boxId);
    /**
     * The receipt mark, always, whatever the bundle answered (SCRUM-322).
     *
     * It is the one cached scope that moves without anybody administering
     * anything — every finalised sale advances it — so it is no longer part of
     * what the bundle's etag stands for, and a 304 above says nothing about it.
     * This is where it is kept current: one small unconditional read, on the
     * tick the timer was already making.
     *
     * **It is deliberately not in what this returns.** The answer is the
     * ADMINISTERED scopes this tick applied — it is what the Console prints
     * beside an Apply config press, and naming a scope nobody published there
     * every single time would make the reading worthless. A full pull still
     * lists it, because `receipt_series` is in the bundle and `pullBundle`
     * reports what it wrote. Where the mark itself has to be proved, the box's
     * own store is the evidence (`box-cache-survives.test.ts`).
     */
    await pullReceiptSeries(boxId);
    return applied;
  }

  /**
   * The administered half of the cache: everything the bundle's version stands
   * for, taken whole and written scope by scope.
   */
  async function pullBundle(boxId: string): Promise<string[]> {
    if (!store) return [];
    /**
     * The etag is only worth sending while the local copy it stands for is
     * still there (SCRUM-314). A box that stays online with a bundle gone bad
     * underneath it — a store file lost, a scope unreadable — would otherwise
     * be told "nothing changed" on every tick, because the cloud cannot know
     * the copy is bad. The two scopes read back are the ones a counter's
     * safety rests on; a missing or unreadable one forgets the etag, and the
     * pull below is a whole one.
     */
    if (cacheBundleVersion) {
      for (const scope of ['deny_list', 'staff'] as const) {
        const held = await store.readBundle(boxId, scope).catch(() => null);
        if (!held) {
          note('warn', 'a cached scope is missing on this box; pulling the cache whole', { scope });
          cacheBundleVersion = null;
          break;
        }
      }
    }
    const { status, body } = await request<{
      schemaVersion: number;
      bundleVersion: string;
      cursorSeq: number;
      scopes: Record<string, { items: unknown[]; nextCursor: string | null }>;
      truncated: string[];
    }>(`/box/v1/cache?schemaVersion=${CACHE_SCHEMA_VERSION}`, {
      method: 'GET',
      headers: cacheBundleVersion ? { 'if-none-match': `"${cacheBundleVersion}"` } : {},
    });
    // Nothing moved since the copy this box holds. Not a pull, so no fault is
    // recorded or cleared and no timestamp is stamped: the cache is exactly as
    // old as it was, and the till's banner should say so. The cloud HAS just
    // confirmed the copy is current, which is a different fact and the one the
    // Console's box drawer paints its tone from (SCRUM-323).
    if (status === 304) {
      cacheCheckedAt = new Date(clock()).toISOString();
      return [];
    }
    if (status === 401) {
      await reregisterAfterRefusal('cache');
      return [];
    }
    if (status !== 200 || !body) {
      note('warn', 'cache bundle could not be read', { status });
      recordCacheFault('unreadable', `status ${status}`);
      return [];
    }
    const plan = planCacheApply(Object.keys(body.scopes ?? {}), body.truncated ?? []);
    const applied: string[] = [];
    const appliedAt = new Date(clock()).toISOString();
    for (const scope of plan.apply) {
      const held = body.scopes[scope];
      if (!held) continue;
      try {
        await store.writeBundle(boxId, {
          scope: scope as CachedBundle['scope'],
          schemaVersion: body.schemaVersion,
          cursorSeq: body.cursorSeq,
          // One object rather than the array, because a scope is applied whole
          // and `items` is how the cloud pages it, not what it means.
          payload: { items: held.items },
          appliedAt,
        });
        applied.push(scope);
      } catch (err) {
        /**
         * One scope failing to write used to end the pull with whatever had
         * already landed, silently — and because `staff` is written before
         * `deny_list`, the state it left behind was the dangerous one: a box
         * that knew who could work here and not who had been stopped. The
         * write order below puts the deny-list first, and this refuses to go
         * on past a failure rather than filling in around it.
         */
        note('error', 'a cache scope could not be applied; the rest of the pull was abandoned', {
          scope,
          err: String(err),
          applied: [...applied],
        });
        recordCacheFault('write_failed', scope);
        return applied;
      }
    }
    for (const skipped of plan.skipped) {
      note('warn', 'a cache scope was not applied', skipped);
      recordCacheFault(skipped.reason, skipped.scope);
    }
    if (plan.skipped.length === 0) clearCacheFaults();
    cacheCursorSeq = body.cursorSeq;
    /**
     * When this box last WROTE its offline copies, and how many it holds
     * (SCRUM-323). Both ride the heartbeat, because a manager looking at a box
     * in the Console could otherwise not tell whether its copies were an hour
     * or a week old. `checkedAt` moves on a 304 as well; `appliedAt` only when
     * bytes actually landed, which is the difference between "confirmed
     * current" and "changed".
     */
    cacheCheckedAt = appliedAt;
    if (applied.length > 0) {
      cacheAppliedAt = appliedAt;
      for (const scope of applied) cacheScopesHeld.add(scope);
    }
    // Remembered only for a pull that landed whole. A pull with a skipped
    // scope keeps asking for the full document, so the scope that fell off is
    // tried again on every tick rather than answered 304 until something else
    // in the bundle happens to change.
    cacheBundleVersion = plan.skipped.length === 0 ? body.bundleVersion : null;
    /**
     * A pull can carry a newer wheel and a changed staff list, and both are
     * adopted here rather than on the booth's own minute timer — so a publish
     * an administrator has just made reaches the television as soon as the box
     * has it, instead of up to a minute later. The timer remains the floor,
     * for a box whose pull happens while nobody is watching.
     */
    if (applied.includes('staff')) await refreshBoothStaff(boxId);
    /**
     * A staff pull reaches the booth too (SCRUM-223): its `refresh` is where a
     * session whose holder has since been deactivated is ended, and that
     * check reads the staff list refreshed on the line above.
     */
    if (applied.includes('booth') || applied.includes('staff')) {
      await booth?.refresh().catch((err) => {
        note('error', 'a newly pulled wheel could not be applied', { err: String(err) });
      });
    }
    /**
     * Stamps `last_cache_applied_at`, which is what the till's banner reads to
     * say how old its copy is. Skipped when this box has not applied a config
     * version yet: the same call carries `applied_config_version`, and writing
     * a null there would tell the cloud the box is holding no configuration
     * when all that happened is that the cache was pulled first.
     */
    if (state.configVersion) {
      await store.setAppliedConfigVersion(boxId, state.configVersion);
    }
    note('info', 'cache applied', {
      scopes: applied.length,
      bundleVersion: body.bundleVersion,
      cursorSeq: body.cursorSeq,
    });
    return applied;
  }

  /**
   * Where this box's receipt numbering stands, read on its own (SCRUM-322).
   *
   * Asked for with `?scopes=receipt_series` and NO `If-None-Match`, because
   * this is the scope the bundle's version deliberately does not stand for: it
   * moves on every finalised sale, and hashing it into the version made a
   * selling box pull its whole cache every minute. Unconditional is what makes
   * it correct — the answer is a row per station and a few hundred bytes.
   *
   * It writes that one scope and nothing else, and it does NOT move
   * `cacheCursorSeq`: this box has not applied the deltas the cloud has since
   * published, and claiming otherwise would make it skip them. The row keeps
   * the cursor the box is actually at.
   *
   * A failure is a fault on the heartbeat and never a throw: the mark being
   * stale costs a box its offline receipt numbering, which S2-12 will care
   * about, and costs an online counter nothing at all today.
   */
  async function pullReceiptSeries(boxId: string): Promise<void> {
    if (!store) return;
    const { status, body } = await request<{
      schemaVersion: number;
      cursorSeq: number;
      scopes: Record<string, { items: unknown[]; nextCursor: string | null }>;
      truncated: string[];
    }>(`/box/v1/cache?schemaVersion=${CACHE_SCHEMA_VERSION}&scopes=${RECEIPT_SERIES}`, {
      method: 'GET',
    });
    if (status === 401) {
      await reregisterAfterRefusal('cache');
      return;
    }
    if (status !== 200 || !body) {
      note('warn', 'the receipt mark could not be read', { status });
      recordCacheFault('unreadable', RECEIPT_SERIES);
      return;
    }
    // The same rule-applier the bundle goes through, so a scope the cloud cut
    // short is skipped here too rather than half-written. The staff/deny-list
    // pairing it also enforces cannot bite: neither is in this answer.
    const plan = planCacheApply(Object.keys(body.scopes ?? {}), body.truncated ?? []);
    for (const skipped of plan.skipped) {
      note('warn', 'the receipt mark was not applied', skipped);
      recordCacheFault(skipped.reason, skipped.scope);
    }
    const held = plan.apply.includes(RECEIPT_SERIES) ? body.scopes[RECEIPT_SERIES] : undefined;
    if (!held) return;
    try {
      await store.writeBundle(boxId, {
        scope: RECEIPT_SERIES,
        schemaVersion: body.schemaVersion,
        cursorSeq: cacheCursorSeq,
        payload: { items: held.items },
        appliedAt: new Date(clock()).toISOString(),
      });
      cacheScopesHeld.add(RECEIPT_SERIES);
    } catch (err) {
      note('error', 'the receipt mark could not be written', { err: String(err) });
      recordCacheFault('write_failed', RECEIPT_SERIES);
    }
  }

  // --- Sales taken with no internet (S2-10a, Slice G) -----------------------

  /**
   * The local half of the receipt numbering, and why it is a counter rather
   * than a stored "next number".
   *
   * `edge.box_counter` moves in ONE statement (`store-sql.ts:1160`), so two
   * tills finishing in the same second cannot both read 41 and both write 42 —
   * which is the whole of the problem, and is exactly why the terminal
   * reference counter next door uses the same row.
   *
   * THE KEY CARRIES THE MARK. The counter says how many numbers this box has
   * minted SINCE the cloud last told it where the series stands, so a mark that
   * has moved starts a fresh run rather than colliding with the numbers the
   * cloud issued in between. Without the mark in the key, a box that sold five
   * offline, reconnected, and went offline again would mint those same five
   * numbers a second time.
   *
   * THE DATE IN THE KEY IS PINNED, which is the one unusual thing here: the
   * other users of this table are daily caps and want the reset that the
   * primary key's `business_date` gives them. A receipt series is continuous
   * and does not reset at 5am — a box that was offline across midnight would
   * otherwise re-issue the numbers it had already shown guests the evening
   * before.
   */
  const RECEIPT_SEQ_SCOPE = 'receipt_seq';
  const RECEIPT_SERIES_DAY = '1970-01-01';
  /**
   * `pos.receipt_series.seq_padding`'s default, which the cache bundle does not
   * carry. A series configured wider would make the box's PRINTED string differ
   * from the cloud's while the number itself is the same; the ledger's is
   * authoritative either way, and the audit row names both.
   */
  const RECEIPT_SEQ_PADDING = 6;

  /** The `receipt_series` scope of the cache, as this box last wrote it. */
  async function receiptMarks(boxId: string): Promise<ReceiptMark[]> {
    const held = await store?.readBundle(boxId, RECEIPT_SERIES).catch(() => null);
    const items = (held?.payload as { items?: unknown[] } | undefined)?.items ?? [];
    const out: ReceiptMark[] = [];
    for (const raw of items) {
      const item = raw as Partial<ReceiptMark>;
      if (typeof item?.stationId !== 'string') continue;
      out.push({
        stationId: item.stationId,
        prefix: typeof item.prefix === 'string' ? item.prefix : null,
        highWaterMark: typeof item.highWaterMark === 'number' ? item.highWaterMark : 0,
      });
    }
    return out;
  }

  /**
   * The number this sale is shown under at the counter.
   *
   * REFUSES rather than guesses, in both of the ways it can fail. A box that
   * has never been told where the series stands would start at 1 and collide
   * with numbers the cloud has already issued — and offline that collision is
   * discovered after the money is in the drawer, with the sale quarantined
   * (`receipt-hwm.test.ts` says exactly this). A station with no code prefix
   * cannot number a receipt at all, which the cloud refuses at the same point
   * on the online path (`sale.ts`, "this station has no code prefix"). Both
   * are configuration somebody can fix in a minute; taking the money first is
   * what cannot be fixed.
   */
  async function mintReceipt(boxId: string, stationId: string): Promise<OfflineReceiptFact> {
    if (!store) throw new Error('This box has no store, so it cannot number a sale offline');
    const marks = await receiptMarks(boxId);
    const mark = marks.find((m) => m.stationId === stationId);
    if (!mark) {
      throw new Error(
        'This box has not been told where this station’s receipt numbering stands, so it cannot number a sale offline',
      );
    }
    if (!mark.prefix) {
      throw new Error('This station has no code prefix, so it cannot number a receipt');
    }
    const since = await store.bumpCounter(
      boxId,
      {
        scope: RECEIPT_SEQ_SCOPE,
        key: `${stationId}:${mark.prefix}:${mark.highWaterMark}`,
        businessDate: RECEIPT_SERIES_DAY,
      },
      1,
      new Date(clock()).toISOString(),
    );
    const seq = mark.highWaterMark + since;
    return {
      series: mark.prefix,
      seq,
      number: `${mark.prefix}-${String(seq).padStart(RECEIPT_SEQ_PADDING, '0')}`,
    };
  }

  /** Cash opens the drawer; a card leaves it shut. */
  function tookCash(tenders: readonly OfflineTenderFact[]): boolean {
    return tenders.some((t) => t.kind === 'cash' || t.methodCode === 'cash');
  }

  /**
   * Open the drawer, and never let it fail a sale.
   *
   * The money is already in the till and the fact is already on disk by the
   * time this runs. A printer that has been unplugged is a drawer somebody
   * opens with the key, not a sale to roll back.
   */
  async function openDrawerFor(stationId: string, actionId: string | null): Promise<'opened' | 'failed'> {
    if (!printing) return 'failed';
    try {
      const outcome = await printing.pulseDrawer({ stationId, actionId });
      if (!outcome.opened) {
        note('warn', 'the cash drawer did not open for an offline sale', {
          stationId,
          errorCode: outcome.errorCode,
        });
      }
      return outcome.opened ? 'opened' : 'failed';
    } catch (err) {
      note('error', 'the cash drawer could not be opened', { stationId, err: String(err) });
      return 'failed';
    }
  }

  function saleQueue(): SaleQueue | null {
    const queue = outbox;
    const boxId = state.boxId;
    if (!store || !queue || !boxId) return null;
    return {
      async record(request) {
        /**
         * S2-10b — A VOUCHER NEVER RIDES AN OFFLINE SALE (`voucherOnOfflineCart`).
         * Refused first: before a receipt number is minted, so the refused
         * sale spends no number in the station's series, and before anything
         * is queued or the drawer opens. The code itself is not logged.
         */
        if (voucherOnOfflineCart(request.cart)) {
          note('warn', 'an offline sale carrying a voucher was refused', {
            stationId: request.stationId,
          });
          throw new OfflineSaleRefused(OFFLINE_VOUCHER_REFUSAL, 'VOUCHER_NEEDS_INTERNET');
        }
        const saleId = request.saleId ?? uuidv7();
        const receipt = await mintReceipt(boxId, request.stationId);
        /**
         * THE ORDER IS THE POINT: on disk, then the drawer.
         *
         * A drawer that opened for a sale the box then failed to record is
         * money in a till with no row behind it — the one outcome this whole
         * path exists to prevent. The other way round, the worst case is a
         * recorded sale whose drawer has to be opened by hand.
         */
        const records = await queue.queueAll([
          saleFinalisedFact({ ...request, saleId, receipt }),
        ]);
        const drawer =
          (request.openDrawer ?? tookCash(request.tenders))
            ? await openDrawerFor(request.stationId, request.actionId ?? null)
            : ('not_asked' as const);
        const depth = await queue.depth();
        note('info', 'an offline sale is on the queue', {
          saleId,
          stationId: request.stationId,
          boxSeq: records[0]?.envelope.boxSeq ?? null,
          receiptNumber: receipt.number,
          tenders: request.tenders.length,
          drawer,
        });
        return {
          saleId,
          receipt,
          boxSeq: records[0]?.envelope.boxSeq ?? 0,
          queued: records.length,
          drawer,
          outboxDepth: depth.queued,
        };
      },
      async recordTender(request) {
        const records = await queue.queueAll([paymentRecordedFact(request)]);
        const drawer =
          (request.openDrawer ?? tookCash([request.tender]))
            ? await openDrawerFor(request.stationId, request.actionId ?? null)
            : ('not_asked' as const);
        const depth = await queue.depth();
        return {
          saleId: request.saleId,
          receipt: null,
          boxSeq: records[0]?.envelope.boxSeq ?? 0,
          queued: records.length,
          drawer,
          outboxDepth: depth.queued,
        };
      },
      async receiptMark(stationId) {
        return (await receiptMarks(boxId)).find((m) => m.stationId === stationId) ?? null;
      },
    };
  }

  async function heartbeat(): Promise<BoxHeartbeatAck | null> {
    if (!credential || state.heartbeatsPaused) return null;
    // Read before the guard below, so the toggle coming back on is noticed on
    // the very tick that would otherwise have skipped.
    if (await refreshOffline()) return null;
    await refreshOutboxDepth();
    /**
     * Ping every assigned printer before saying anything about it
     * (PROJECT_CONTEXT §7.3: "Box pings every assigned printer on a schedule
     * and reports reachability and paper status in its heartbeat; the station
     * screen shows a red indicator before staff notice a missing receipt").
     *
     * The heartbeat is that schedule, which puts the worst case at one
     * interval — sixty seconds — between a roll running out and the header
     * turning red. Failures are swallowed on purpose: a printer that cannot be
     * reached is the news this carries, not a reason to skip the heartbeat
     * that would have carried it.
     */
    await printing?.jobs.probeAll().catch((err) => {
      note('warn', 'a printer could not be probed before the heartbeat', { err: String(err) });
      return {};
    });
    // And give anything waiting on a printer that was out of paper a go, so a
    // cleared fault prints without waiting for a separate timer.
    await printing?.jobs.tick().catch((err) => {
      note('error', 'the print retry tick failed', { err: String(err) });
      return [];
    });
    const previousReportedAt = lastReportedAt;
    const reportedMs = Math.max(clock(), lastReportedAt + 1);
    lastReportedAt = reportedMs;
    const declared = heldMeasurement();
    const payload: BoxHeartbeatRequest = {
      reportedAt: new Date(reportedMs).toISOString(),
      /**
       * What this box knows of its own clock (SCRUM-402): the measurement made
       * in this boot, moved by whatever the test control has done since, and
       * when it was taken. `reportedAt` above is already corrected, so this is
       * the only place the machine's clock is described at all.
       */
      clock: declared
        ? {
            offsetMs: Math.round(declared.offsetMs + clockResidualMs(declared)),
            measuredAt: declared.measuredAt,
          }
        : { offsetMs: null, measuredAt: null },
      agentVersion: BOX_AGENT_VERSION,
      syncPublicKey: syncPrivateKeyPem ? publicKeyFor(syncPrivateKeyPem) : undefined,
      uptimeS: Math.floor((Date.now() - startedAt) / 1000),
      // Null, not zero: a virtual box has no thermometer, and zero reads as cold.
      tempC: null,
      outboxDepth: state.outboxDepth,
      oldestUnackedS: state.oldestUnackedS,
      configVersion: state.configVersion ?? undefined,
      offline: state.offline,
      devices: deviceReports(),
      leases: await leaseReports(),
      /**
       * What has gone wrong on the box that nothing else would carry. Today
       * that is the cache pull: a scope that did not land leaves this box
       * running on an incomplete copy, and the one that matters is the
       * deny-list, because without it the till cannot check whether a shift
       * has been ended and refuses to unlock offline at all. And a store
       * whose journal waits for a new epoch (SCRUM-403): somebody has to
       * press Reset the store for it, and this is how they learn so.
       */
      errors: [...cacheFaultReports(), ...journalFaultReports()].slice(0, 32),
    };
    /**
     * What this box is holding offline (SCRUM-323).
     *
     * `appliedAt` is when administered bytes last landed and `checkedAt` when
     * the cloud last said the copy was current — a 304 moves the second alone,
     * which is the difference between a box nobody has published anything to
     * and a box that has stopped asking. The receipt mark is written on every
     * tick and deliberately moves NEITHER: an `appliedAt` of "just now" on
     * every heartbeat would answer the only question this line is read for
     * with the same word for ever.
     *
     * Sent only once something has been pulled: a block of nulls would give the
     * Console a cache to report on for a box that has never had one.
     */
    if (cacheCheckedAt || cacheAppliedAt) {
      payload.cache = {
        appliedAt: cacheAppliedAt,
        checkedAt: cacheCheckedAt,
        scopes: cacheScopesHeld.size,
      };
    }
    /**
     * What this booth is doing, MEASURED (S2-07a).
     *
     * `heartbeat()` answers null on a box whose bundle names no booth station,
     * and the field is then absent rather than a block of nulls Health would
     * have to learn to ignore. Every number in it is read from the store or
     * from what the printers themselves last said; nothing in it is defaulted
     * to a cheerful value, which is the one thing a health indicator must
     * never do.
     */
    const boothBlock = await booth?.heartbeat().catch((err) => {
      note('warn', 'the booth could not report itself; the heartbeat goes without it', {
        err: String(err),
      });
      return null;
    });
    if (boothBlock) payload.booth = boothBlock;
    /**
     * The measurement's two readings of the box's clocks, either side of the
     * exchange (see THE BOX'S CLOCK): the raw clock for the midpoint, and the
     * monotonic clock beside it, against which a step of the machine's clock
     * during the exchange is noticed. As near the wire as this file gets: the
     * printer probes and the booth's block are done before the first, and
     * nothing but the request lies between the two.
     */
    const sent = readClocks();
    const { status, body } = await request<unknown>('/box/v1/heartbeat', {
      method: 'POST',
      body: payload,
    });
    const answered = readClocks();
    if (status === 200) lastAcceptedReportedAt = Math.max(lastAcceptedReportedAt, reportedMs);
    if (status === 401) {
      await reregisterAfterRefusal('heartbeat');
      return null;
    }
    const skewRefusal = clockSkewRefusal(status, body);
    if (skewRefusal) {
      /**
       * Refused for its clock, and still worth measuring by (SCRUM-402).
       *
       * The cloud tests the skew before it reads its watermark, so it never
       * accepted this `reportedAt`, and the floor goes back — only if no later
       * heartbeat has moved it since.
       */
      if (lastReportedAt === reportedMs) {
        lastReportedAt = floorAfterClockRefusal(previousReportedAt, skewRefusal);
      }
      const measured = await adoptServerTime(skewRefusal.serverTime, sent, answered);
      note(
        'warn',
        measured
          ? 'heartbeat refused: this box’s clock is out; measured against the platform, the next heartbeat carries the platform’s time'
          : 'heartbeat refused: this box’s clock is out, and nothing was measured off the refusal; the next heartbeat tries again',
        { status, clockOffsetMs: state.clockOffsetMs },
      );
      return null;
    }
    const staleRefusal = heartbeatStaleRefusal(status, body);
    if (staleRefusal) {
      /**
       * Refused as stale (SCRUM-402): the cloud holds a later `reportedAt`
       * from this box than this one. After a restart that is the ordinary
       * case (see `lastReportedAt`): this process's floor started at nothing,
       * and the watermark stands on the platform's time. The refusal names
       * the watermark, and the floor goes up to it, so the next report is
       * after it; and it says what time it is, which the box measures itself
       * against exactly as against a refusal for its clock. After a reboot
       * that is the box's first measurement, which it used to wait for about
       * as long as its clock was out. A refusal that names neither, from a
       * platform older than this, moves nothing, as before.
       */
      if (staleRefusal.lastAcceptedMs !== null) {
        lastAcceptedReportedAt = Math.max(lastAcceptedReportedAt, staleRefusal.lastAcceptedMs);
        lastReportedAt = Math.max(lastReportedAt, staleRefusal.lastAcceptedMs);
      }
      const measured = await adoptServerTime(staleRefusal.serverTime, sent, answered);
      note(
        'warn',
        staleRefusal.lastAcceptedMs !== null
          ? 'heartbeat refused as stale: the platform holds a later report from this box; the next heartbeat reports after it'
          : 'heartbeat refused as stale, and the refusal did not say where the platform stands; the next heartbeat tries again',
        {
          status,
          lastAcceptedReportedAt:
            staleRefusal.lastAcceptedMs === null
              ? null
              : new Date(staleRefusal.lastAcceptedMs).toISOString(),
          measured,
          clockOffsetMs: state.clockOffsetMs,
        },
      );
      return null;
    }
    const ack = body as BoxHeartbeatAck | null;
    if (status !== 200 || !ack) {
      note('warn', 'heartbeat refused', { status });
      return null;
    }
    state.lastHeartbeatAt = payload.reportedAt;
    state.lastAckAt = ack.receivedAt;
    state.epoch = ack.epoch;
    await adoptServerTime(ack.serverTime, sent, answered);
    if (ack.configVersion !== state.configVersion) {
      await syncConfig();
    }
    if (ack.commandsPending > 0) {
      await runPendingCommands();
    }
    return ack;
  }

  /**
   * Everything the box takes from the platform's clock off one answer: the
   * measurement (THE BOX'S CLOCK), and the last time this box has good reason
   * to believe in (D11).
   *
   * The cloud's own clock is the only trustworthy time a Pi with no clock
   * battery ever sees. Remembering the highest one is what lets a booth notice
   * that its clock is EARLIER than a moment it has already lived through —
   * which flags a spin `clock_suspect` and stops the trading day moving
   * backwards. It is remembered off an exchange that measured nothing too:
   * it is the platform's time, whatever the box's clock did meanwhile.
   * Answers whether the box measured its clock off this answer.
   */
  async function adoptServerTime(
    serverTime: unknown,
    sent: ClockReading,
    answered: ClockReading,
  ): Promise<boolean> {
    const platformMs = typeof serverTime === 'string' ? Date.parse(serverTime) : Number.NaN;
    if (!Number.isFinite(platformMs)) return false;
    const measured = await measureClock(platformMs, sent, answered);
    await booth?.noteCloudTime(new Date(platformMs).toISOString()).catch((err) => {
      note('warn', 'the booth could not record the cloud time', { err: String(err) });
    });
    return measured;
  }

  /**
   * Where the floor under `reportedAt` goes after a heartbeat refused for its
   * clock (SCRUM-402), from `beforeMs`, where it stood before that heartbeat.
   *
   * The floor stands for the cloud's watermark, the last `reportedAt` it
   * accepted, and what raised it since the last 200 may never have reached
   * acceptance: a heartbeat with no answer (the router has no line yet after
   * a power cut), or a 502 or 503 from the edge during a deploy. Every
   * heartbeat the cloud accepted was within its bound of its own clock, so
   * none is later than this refusal's `serverTime` plus that bound. A floor
   * within it may be the watermark of a heartbeat whose answer was lost, and
   * stays. A floor past it was refused or never arrived, and goes back to
   * the last `reportedAt` answered 200: kept, it would hold a box that booted
   * hours AHEAD, and whose first heartbeat got no answer, at that future time
   * after it had measured itself — refused, and shown offline, for as long
   * as it had been ahead.
   */
  function floorAfterClockRefusal(beforeMs: number, refusal: ClockSkewRefusal): number {
    const serverMs = refusal.serverTime === null ? Number.NaN : Date.parse(refusal.serverTime);
    const latestAcceptedMs = refusal.maxSkewMs === null ? Number.NaN : serverMs + refusal.maxSkewMs;
    const mayBeTheWatermark = Number.isFinite(latestAcceptedMs) && beforeMs <= latestAcceptedMs;
    return Math.max(lastAcceptedReportedAt, mayBeTheWatermark ? beforeMs : 0);
  }

  async function refreshOutboxDepth(): Promise<void> {
    if (!outbox) return;
    const depth = await outbox.depth();
    state.outboxDepth = depth.queued;
    state.oldestUnackedS = depth.oldestQueuedAt
      ? Math.max(0, Math.floor((clock() - Date.parse(depth.oldestQueuedAt)) / 1000))
      : null;
  }

  /**
   * Who is standing at which till, as opaque holder ids and nothing else. The
   * cloud needs to know a station is busy; it has no business knowing who.
   */
  async function leaseReports(): Promise<BoxHeartbeatRequest['leases']> {
    if (!store || !sessions) return [];
    const reports: BoxHeartbeatRequest['leases'] = [];
    for (const station of bundle?.stations ?? []) {
      const document = await store.readSession(station.id);
      if (!document?.lease) continue;
      reports.push({
        stationId: station.id,
        holder: document.lease.holder,
        expiresAt: document.lease.expiresAt,
      });
    }
    return reports;
  }

  /**
   * Take the commands somebody queued on the Console, and while offline take
   * exactly one kind of them (SCRUM-328).
   *
   * This opened with `if (!credential || state.offline) return 0`, and the
   * consequence was that the Console's "Go online" could not reach the box it
   * had put offline: that button queues a `go_online` command like every other
   * one, and nothing was left polling to collect it. A queued `go_online` sat
   * there for as long as anyone watched, and the only way back was editing
   * `edge.box_state` by hand.
   *
   * So an offline box keeps this one request, on its ordinary cadence, and
   * asks for `OFFLINE_COMMAND_KINDS` and nothing else. The switch still means
   * what it meant — no heartbeat, no config pull, no cache pull, no push — and
   * the kinds filter is honoured on the CLOUD's side of the claim, so a test
   * print queued behind the `go_online` is never handed out and never marked
   * running: it is still queued, un-attempted, when the box is back.
   */
  async function runPendingCommands(): Promise<number> {
    if (!credential) return 0;
    /**
     * Read before the request rather than per command: a `go_online` in this
     * batch flips it half way through the loop, and what the box asked the
     * cloud for is a fact about the request that was sent.
     */
    const askedOffline = state.offline;
    const { status, body } = await request<BoxCommandPollResponse>('/box/v1/commands/poll', {
      method: 'POST',
      body: askedOffline ? { max: 1, kinds: OFFLINE_COMMAND_KINDS } : { max: 5 },
    });
    if (status === 401) {
      await reregisterAfterRefusal('command poll');
      return 0;
    }
    if (status !== 200 || !body) return 0;
    let ran = 0;
    for (const command of body.commands) {
      const outcome = offlineRefusal(command) ?? (await executeCommand(command));
      const { status: resultStatus, body: ack } = await request<BoxCommandResultResponse>(
        `/box/v1/commands/${command.id}/result`,
        {
          method: 'POST',
          body: outcome satisfies BoxCommandResultRequest,
          /**
           * The id minted where somebody pressed the button, carried back up
           * so the request that reports the result sits in the same log line
           * group as the one that queued it. That is what makes the Box log
           * drawer's filter show one gesture end to end rather than two
           * unrelated entries.
           */
          headers: command.actionId ? { 'x-oto-action-id': command.actionId } : {},
        },
      );
      if (resultStatus === 200 && ack) {
        // A `reset_store` mints the next journal epoch in the cloud, and the
        // box has to stamp its events with it from here on. Taking it from
        // the acknowledgement rather than computing it is what keeps the two
        // ends from disagreeing about which epoch a batch belongs to.
        if (command.kind === 'reset_store' && outcome.state === 'succeeded') {
          // With the note that says where it came from, in one transaction:
          // it is what a store waiting for a new epoch waits for (NO NEW FACT
          // BEFORE A FRESH EPOCH, above `JOURNAL_EPOCH_KEY`).
          await takeMintedEpoch(ack.epoch);
        } else if (store && state.boxId && ack.epoch !== state.epoch) {
          // Written to the store, not just to memory: the epoch and the
          // sequence generator are one thing, and a box that adopted a new
          // epoch in memory and then lost power would come back stamping the
          // old one over sequences it had already used.
          await store.setEpoch(state.boxId, ack.epoch, new Date(clock()).toISOString());
        }
        state.epoch = ack.epoch;
      } else {
        note('warn', 'command result was not accepted', {
          status: resultStatus,
          kind: command.kind,
        });
      }
      ran += 1;
      state.commandsRun += 1;
    }
    return ran;
  }

  /**
   * A command an offline box must not run, handed out to it anyway.
   *
   * Two ways that happens, and neither is the ordinary one: an api too old to
   * honour the `kinds` filter, or a `go_offline` earlier in the same batch
   * that turned the box off between the claim and this command's turn. The row
   * is already `running` by then, so saying nothing would leave a command
   * claimed by nobody and in progress for ever on the Console. It is reported
   * `failed` by name instead — true, terminal, and something whoever pressed
   * the button can press again once the box is back.
   */
  function offlineRefusal(command: BoxCommandHandout): BoxCommandResultRequest | null {
    if (!state.offline || OFFLINE_COMMAND_KINDS.includes(command.kind)) return null;
    note('warn', 'a command reached an offline box, which runs none but go_online', {
      kind: command.kind,
      actionId: command.actionId,
    });
    return {
      state: 'failed',
      errorCode: 'BOX_OFFLINE',
      errorMessage: `This box is offline and runs nothing but ${OFFLINE_COMMAND_KINDS.join(', ')}`,
    };
  }

  async function executeCommand(command: BoxCommandHandout): Promise<BoxCommandResultRequest> {
    const payload = (command.payload ?? {}) as Record<string, unknown>;
    note('info', 'running command', { kind: command.kind, actionId: command.actionId });
    switch (command.kind) {
      case 'test_print': {
        if (!printing) {
          return {
            state: 'failed',
            errorCode: 'PRINTING_DISABLED',
            errorMessage: 'This agent was built without its print pipeline',
          };
        }
        const kind = (typeof payload.kind === 'string' ? payload.kind : 'test_page') as PrintKind;
        const stationId = typeof payload.stationId === 'string' ? payload.stationId : null;
        const role = typeof payload.role === 'string' ? payload.role : null;
        /**
         * The job id is the `edge.print_job` row the cloud already created, so
         * the box's outcome lands on the row the button created rather than on
         * a second one nobody asked for. A command with none is a command from
         * an older api; the box still prints and reports against an id the
         * cloud will not recognise, which is honest and harmless.
         */
        const jobId = typeof payload.printJobId === 'string' ? payload.printJobId : command.id;
        let job;
        try {
          job = await testPrintJob(kind);
        } catch (err) {
          return {
            state: 'failed',
            errorCode: 'RENDER_FAILED',
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }
        const outcome = await printing.submit({
          id: jobId,
          kind,
          job,
          stationId,
          role,
          actionId: command.actionId,
          copies: typeof payload.copies === 'number' ? payload.copies : 1,
        });
        /**
         * The COMMAND succeeded whenever the box understood it and routed it.
         * Whether paper came out is the job's answer, on the job's row, and a
         * job still waiting on an empty roll must not make the command that
         * queued it look broken — the Console would then show a red command
         * and a queued job describing one healthy, well-understood situation.
         */
        return {
          state: outcome.status === 'failed' ? 'failed' : 'succeeded',
          result: {
            printJobId: outcome.id,
            status: outcome.status,
            kind,
            deviceId: outcome.deviceId,
            role: outcome.role,
            stationId: outcome.stationId,
            attempts: outcome.attempts,
            overflow: outcome.overflow,
          },
          errorCode: outcome.errorCode ?? undefined,
          errorMessage: outcome.errorMessage ?? undefined,
        };
      }
      case 'terminal_sale': {
        if (!terminals) {
          return {
            state: 'failed',
            errorCode: 'TERMINALS_DISABLED',
            errorMessage: 'This agent was built without its terminal pipeline',
          };
        }
        const parsed = TerminalCommandPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          return {
            state: 'failed',
            errorCode: 'BAD_TENDER',
            errorMessage: `The command did not describe a tender: ${parsed.error.issues[0]?.message ?? 'unreadable'}`,
          };
        }
        const tender = parsed.data;
        const outcome = await terminals.runCommand(tender, {
          onProgress: (event) => {
            void reportTerminalResult(
              tender.attemptId,
              terminalProgressBody(event),
              command.actionId,
            ).catch((err) => note('warn', 'a terminal progress report failed', { err: String(err) }));
          },
        });
        if (outcome.result) {
          /**
           * Reported before the command is acknowledged, but on its own route.
           *
           * Awaited rather than left in flight because the till is waiting on
           * exactly this: the command ack tells the Console the box acted, and
           * the attempt row is what the screen in front of a guest reads.
           */
          await reportTerminalResult(
            tender.attemptId,
            terminalResultBody(outcome.result),
            command.actionId,
          );
        }
        /**
         * The COMMAND succeeded whenever the box understood it and reached a
         * terminal. A declined card is a command that worked perfectly — the
         * same rule the test print states at `:1512-1518`, and the reason the
         * Console does not paint a red command for a guest whose card was
         * refused.
         */
        return {
          state: outcome.result || !outcome.errorCode ? 'succeeded' : 'failed',
          result: {
            attemptId: tender.attemptId,
            mode: tender.mode,
            ...(outcome.routed ?? {}),
            outcome: outcome.result?.outcome ?? null,
            // The reference and the response code, which is what ties this
            // command to the attempt row and to the terminal's own slip.
            terminalRef: outcome.result?.terminalRef ?? null,
            responseCode: outcome.result?.responseCode ?? null,
          },
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        };
      }
      case 'drawer_kick': {
        /**
         * CASH IN THE TILL OPENS THE TILL (S2-10a, decision O-4).
         *
         * The cloud resolved the station and queued this the moment a cash
         * tender closed a sale (`services/payments/drawer.ts`); the pulse
         * itself is the box's, because the drawer hangs off the receipt
         * printer's RJ11 and the box is what can reach it.
         *
         * **The box re-resolves the printer and its answer wins**, which is the
         * rule every routed job on this agent follows: the cloud names the
         * device it can see in the fleet table, the box knows what it can
         * actually talk to, and a printer swapped on the counter this morning
         * is a fact only one of them has. The cloud's answer is echoed back so
         * a disagreement is visible in the Console rather than silent.
         *
         * A command that could not open the drawer is `failed` — unlike a print
         * job, whose command succeeds the moment it is routed. There is no
         * second row here to carry the outcome: the pulse is not queued and has
         * no `edge.print_job` of its own, so this ack is the only place the
         * answer can live, and a green command over a drawer that stayed shut
         * would be the Console lying about the one thing somebody checked.
         */
        if (!printing) {
          return {
            state: 'failed',
            errorCode: 'PRINTING_DISABLED',
            errorMessage: 'This agent was built without its print pipeline, which is what pulses a drawer',
          };
        }
        const stationId = typeof payload.stationId === 'string' ? payload.stationId : null;
        const role = typeof payload.role === 'string' ? payload.role : null;
        const outcome = await printing.pulseDrawer({
          stationId,
          role,
          actionId: command.actionId,
        });
        return {
          state: outcome.opened ? 'succeeded' : 'failed',
          result: {
            opened: outcome.opened,
            deviceId: outcome.deviceId,
            role: outcome.role,
            stationId: outcome.stationId,
            elapsedMs: outcome.elapsedMs,
            // What the money this pulse belongs to was, so the Console's
            // command history can be read beside the Sale detail.
            saleId: typeof payload.saleId === 'string' ? payload.saleId : null,
            attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : null,
            ...(typeof payload.deviceId === 'string' && payload.deviceId !== outcome.deviceId
              ? { cloudDeviceId: payload.deviceId }
              : {}),
          },
          errorCode: outcome.errorCode ?? undefined,
          errorMessage: outcome.errorMessage ?? undefined,
        };
      }
      case 'simulate': {
        const action = (payload.action ?? null) as SimulatorAction | null;
        if (!action || typeof action.action !== 'string') {
          return {
            state: 'failed',
            errorCode: 'BAD_SIMULATOR_ACTION',
            errorMessage: 'The command carried no simulator action',
          };
        }
        if (
          (action.action === 'printer.fault' || action.action === 'printer.clear') &&
          !printing
        ) {
          return {
            state: 'failed',
            errorCode: 'PRINTING_DISABLED',
            errorMessage: 'This agent has no printer simulators',
          };
        }
        if (action.action === 'printer.fault' && printing) {
          const applied = printing.setFault(action.deviceId, action.fault as PrinterFault);
          return applied
            ? {
                state: 'succeeded',
                result: { deviceId: action.deviceId, fault: action.fault, applied: true },
              }
            : {
                state: 'failed',
                errorCode: 'DEVICE_NOT_SIMULATED',
                errorMessage:
                  'That device is a real printer on this box — a fault can only be injected into a simulated one',
              };
        }
        if (action.action === 'printer.clear' && printing) {
          const cleared = printing.clearFaults(action.deviceId);
          return cleared
            ? { state: 'succeeded', result: { deviceId: action.deviceId, cleared: true } }
            : {
                state: 'failed',
                errorCode: 'DEVICE_NOT_SIMULATED',
                errorMessage: 'That device is a real printer on this box',
              };
        }
        /**
         * The scanner (S2-06).
         *
         * The typed code is not handed to the scanning service directly: it is
         * turned into the key events a keyboard-wedge scanner would produce
         * and fed through `HidBurstReader`, the same state machine that reads
         * the real DS2278. A simulator that skipped the reader would prove the
         * service works and nothing about the rule that has to be right — and
         * the rule is the whole subtlety of scanning.
         */
        if (action.action === 'scanner.scan') {
          if (!scanner) {
            return {
              state: 'failed',
              errorCode: 'SCANNING_UNAVAILABLE',
              errorMessage: 'This box has no store, so it has no scanning service',
            };
          }
          const stationId = stationForDevice(action.deviceId) ?? bundle?.stations[0]?.id ?? null;
          if (!stationId) {
            return {
              state: 'failed',
              errorCode: 'NO_STATION_ON_THIS_BOX',
              errorMessage: 'This box has no station for a scan to arrive at',
            };
          }
          const reader = new HidBurstReader({ source: 'simulator' });
          let input: ScanInput | null = null;
          for (const key of simulateHidKeys(action.input.code, { startAt: clock() })) {
            const event = reader.push(key);
            if (event?.kind === 'scan') input = event.input;
          }
          if (!input) {
            // Shorter than a code, or the reader refused it. A REFUSAL rather
            // than a success with nothing behind it: the panel shows what the
            // reader decided, which is the point of driving it.
            return {
              state: 'failed',
              errorCode: 'SCAN_NOT_RECOGNISED',
              errorMessage:
                'The reader did not see that as a scan: a code is at least six characters',
            };
          }
          const outcome = await scanner.deliver(
            stationId,
            {
              ...input,
              scannedAt: action.input.scannedAt ?? input.scannedAt,
              actionId: command.actionId,
            },
            { screen: 'box' },
          );
          return {
            state: 'succeeded',
            result: {
              stationId,
              codeKind: outcome.kind,
              outcome: outcome.outcome,
              handler: outcome.handler,
              // The fingerprint, never the code: this result is stored on the
              // command row and rendered in the Console's history.
              codeFingerprint: outcome.codeFingerprint,
              handlers: scanner.registered(),
            },
          };
        }

        /**
         * The counter button, which is NOT a scan.
         *
         * It writes no `station_event`: that table's `kind` is a CHECK over
         * intent, snapshot, lease, scan and error, and recording a press as a
         * `scan` would make "how many scans failed this afternoon" wrong.
         * What it does is refuse Enter — the key a wedge scanner ends every
         * code with — and put a line in the box log the press's action id can
         * be found by.
         */
        if (action.action === 'button.press') {
          const problem = buttonKeyProblem(action.press.key);
          if (problem) {
            return { state: 'failed', errorCode: 'BUTTON_KEY_NOT_ALLOWED', errorMessage: problem };
          }
          note('info', 'counter button pressed', {
            key: action.press.key,
            actionId: command.actionId,
          });
          return { state: 'succeeded', result: { pressed: true, key: action.press.key } };
        }

        /**
         * The card terminals (S2-10a).
         *
         * `terminal.outcome` sets what the NEXT tender will do rather than
         * answering one in flight: a simulator asked after the fact could not
         * reproduce "no final response" at all, because the answer to that is
         * silence at the moment the sale is sent. `terminal.advance_clock`
         * moves the terminal's own clock, which is the only way the void
         * windows — before settlement, before 11PM — can be shown to exist.
         */
        if (action.action === 'terminal.outcome' || action.action === 'terminal.advance_clock') {
          if (!terminals) {
            return {
              state: 'failed',
              errorCode: 'TERMINALS_DISABLED',
              errorMessage: 'This agent has no terminal simulators',
            };
          }
          const applied =
            action.action === 'terminal.outcome'
              ? terminals.setOutcome(action.deviceId, action.outcome, {
                  ...(action.approvedSatang === undefined
                    ? {}
                    : { approvedSatang: action.approvedSatang }),
                  ...(action.approvalCode === undefined
                    ? {}
                    : { approvalCode: action.approvalCode }),
                })
              : terminals.advanceClock(action.deviceId, action.minutes);
          if (!applied) {
            return {
              state: 'failed',
              errorCode: 'DEVICE_NOT_SIMULATED',
              errorMessage:
                'That device is a real terminal on this box — an outcome can only be set on a simulated one',
            };
          }
          return {
            state: 'succeeded',
            result:
              action.action === 'terminal.outcome'
                ? // The approval code is NOT echoed: it is the reason this
                  // action is on `SIMULATOR_ACTIONS_WITH_SECRETS`, and a
                  // command result is a stored column the Console renders.
                  { deviceId: action.deviceId, outcome: action.outcome, applied: true }
                : { deviceId: action.deviceId, minutes: action.minutes, applied: true },
          };
        }

        return {
          state: 'failed',
          errorCode: 'SIMULATOR_NOT_BUILT',
          errorMessage: `This agent (${BOX_AGENT_VERSION}) has no simulator for ${action.action}`,
        };
      }
      case 'config_apply': {
        // Both bundles, because the button says "apply" and a manager pressing
        // it after publishing a wheel means the wheel. The config bundle is
        // stations and devices; the wheel, the staff list and the price list
        // travel in the cache, and a press that pulled only the first left the
        // box on last week's prizes with a green tick on the Console (SCRUM-275).
        const changed = await syncConfig();
        const cacheScopes = await syncCache();
        return {
          state: 'succeeded',
          result: { configVersion: state.configVersion, changed, cacheScopes },
        };
      }
      case 'clear_cache': {
        // The bundles only. The outbox is not a cache: those rows are facts
        // that happened and have not been accepted, and throwing them away
        // from a button on a web page would be losing sales by accident.
        if (!store || !state.boxId) {
          return { state: 'succeeded', result: { entries: 0, note: 'this box holds no cache' } };
        }
        await store.setAppliedConfigVersion(state.boxId, null);
        state.configVersion = null;
        cacheBundleVersion = null;
        const changed = await syncConfig();
        const cacheScopes = await syncCache();
        return { state: 'succeeded', result: { cleared: true, refetched: changed, cacheScopes } };
      }
      case 'collect_logs': {
        const lines = typeof payload.lines === 'number' ? payload.lines : 200;
        return { state: 'succeeded', result: { lines: recentLogs(lines) } };
      }
      case 'restart': {
        // Scheduled rather than done here: this call is running inside the
        // poll loop the restart is about to tear down. On a Pi this becomes a
        // service restart; in the api process it restarts the agent's timers
        // and nothing else, because taking the api down would be a strange way
        // to reboot a box it happens to host.
        setTimeout(() => {
          stop();
          void start().catch((err) => note('error', 'restart failed', { err: String(err) }));
        }, 50).unref?.();
        return { state: 'succeeded', result: { restarted: true } };
      }
      case 'go_offline': {
        const reason = typeof payload.reason === 'string' ? payload.reason : 'console';
        await setOffline(true, { reason });
        return { state: 'succeeded', result: { offline: true } };
      }
      case 'go_online':
        await setOffline(false);
        return { state: 'succeeded', result: { offline: false } };
      case 'reset_store': {
        // The local side of it: everything the box was holding goes. The new
        // epoch comes back on the acknowledgement, which is what makes a batch
        // replayed from the old store recognisably stale.
        bundle = null;
        adoptTemplates(null);
        state.configVersion = null;
        cacheBundleVersion = null;
        await syncConfig();
        // The epoch itself is adopted where the acknowledgement arrives, in
        // `runPendingCommands` — computing it here would mean the two ends
        // guessing at the same number instead of one of them being told.
        return { state: 'succeeded', result: { cleared: true } };
      }
      default: {
        // A command kind this agent is too old to understand. Failing by name
        // is what tells whoever pressed it to update the box rather than
        // leaving them watching a command that never finishes.
        const kind: string = command.kind;
        return {
          state: 'failed',
          errorCode: 'UNKNOWN_COMMAND',
          errorMessage: `This agent (${BOX_AGENT_VERSION}) does not understand ${kind}`,
        };
      }
    }
  }

  function recentLogs(limit = 200): string[] {
    return ring.slice(-limit);
  }

  /**
   * The offline toggle.
   *
   * Without a store it is a flag that dies with the process, which is the
   * S2-04 behaviour and is honest for a box that remembers nothing. With one
   * it is a row, and a Render restart or a power cut comes back offline —
   * which is the point: a box put offline for the evening must not rejoin the
   * network because somebody deployed.
   */
  async function setOffline(
    offline: boolean,
    opts?: { reason?: string; accountId?: string },
  ): Promise<boolean> {
    state.offline = offline;
    if (store && state.boxId) {
      await store.setOffline(state.boxId, offline, {
        reason: opts?.reason ?? null,
        accountId: opts?.accountId ?? null,
        now: new Date(clock()).toISOString(),
      });
    }
    note('warn', offline ? 'box put offline' : 'box brought back online', {
      reason: opts?.reason ?? null,
    });
    // Coming back online, try immediately rather than waiting for the tick:
    // whoever pressed the button is watching the outbox depth.
    if (!offline) {
      /**
       * The etag is forgotten here so the first pull after an outage is a
       * whole one. The 304 saves bytes on the ordinary tick; it must not
       * stand between a box whose local copy went bad while the link was
       * down and the pull that repairs it — the cloud cannot know the copy
       * is bad, so "nothing changed" would be the wrong answer for as long
       * as the bundle stayed the same. Found by scanning-staff-token's repair
       * test the day the etag arrived.
       */
      cacheBundleVersion = null;
      await syncConfig();
      await outbox?.flush();
    }
    return state.offline;
  }

  async function prepare(): Promise<boolean> {
    await ensureRegistered();
    if (!credential) return false;
    /**
     * The booth runs from what this box holds before it asks the cloud for
     * anything (SCRUM-223): the wheel in its store, and the copy of the config
     * restored when the store was attached. `start` used to reach this line
     * only after pulling config and cache — minutes, against a cloud that
     * takes the connection and never answers — and a booth that has not
     * started refuses every press as "not set up".
     *
     * It also adopts the vouchers a previous process left unprinted, so their
     * outcomes go to the outbox rather than to the cloud's print route — which
     * has to happen before anything can submit a job (D20), and here it
     * happens before a television can even be served.
     */
    if (!boothStarted) {
      boothStarted = true;
      await booth?.start().catch((err) => {
        note('error', 'the booth could not start', { err: String(err) });
      });
    }
    return true;
  }

  async function start(): Promise<void> {
    if (!(await prepare())) return;
    /**
     * Every step towards the cloud from here on may fail, and none of them is
     * a reason not to start (SCRUM-223). A Raspberry Pi comes up in a mall
     * before the router has its line, and a box that threw here never set its
     * timers — so it never tried again, and the booth sat unconfigured until
     * somebody power-cycled it.
     *
     * Nor may any of them take long to fail. A cloud that accepts the
     * connection and never answers is bounded by the transport: a Pi's
     * `httpTransport` gives up on a call with no answer after
     * `AGENT_ANSWER_TIMEOUT_MS`, and every call costs at most one of those.
     * Below that is four calls — config, cache, heartbeat, commands — plus,
     * inside the heartbeat, one for each print job its retry tick settles and
     * reports up the cloud's print-result route: a till's job that finishes,
     * or one a power cut interrupted. Never a booth voucher's, whose outcome
     * goes to the outbox. Meanwhile the booth is already playing (`prepare`)
     * and the runner is already serving the television. The copy of the
     * config on disk carries the booth until the first pull lands; the timers
     * pull the rest.
     */
    await syncConfig().catch((err) => {
      note('warn', 'config could not be pulled at start; running on the copy this box holds', {
        err: String(err),
      });
      return false;
    });
    // Before the first heartbeat, because the window that matters is the one
    // between a box coming up and the link dropping again: a box that has been
    // running for a minute with no cache can do less than one that has been
    // running for a second with one.
    await syncCache().catch((err) => {
      note('error', 'cache pull failed at start', { err: String(err) });
      // Swallowed so the agent still comes up, but not silently: the fault
      // goes out in the first heartbeat, so a box running on no cache is
      // visible in the Console rather than only in a log line on the box.
      recordCacheFault('unreadable', 'pull_threw');
      return [];
    });
    /**
     * What the pulls brought, adopted before the first heartbeat, because that
     * heartbeat carries the booth block and a block measured before the wheel
     * was adopted would report `configVersion: null` on a booth that is in
     * fact running version 4. A new wheel is adopted by the pull itself; this
     * is for a station the box learned only now — the virtual box, or a Pi's
     * first boot, has no copy of the config until the pull above — while the
     * cache pull failed and left last run's wheel in the store.
     */
    await booth?.refresh().catch((err) => {
      note('error', 'the booth could not apply what the pulls brought', { err: String(err) });
      return false;
    });
    await heartbeat().catch((err) => {
      note('warn', 'the first heartbeat did not reach the cloud; the timer tries again', {
        err: String(err),
      });
      return null;
    });
    await runPendingCommands().catch((err) => {
      note('warn', 'the first command poll did not reach the cloud', { err: String(err) });
      return 0;
    });
    outbox?.start();
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch((err) => note('error', 'heartbeat tick failed', { err: String(err) }));
    }, heartbeatIntervalMs);
    pollTimer = setInterval(() => {
      void runPendingCommands().catch((err) =>
        note('error', 'command poll tick failed', { err: String(err) }),
      );
    }, pollIntervalMs);
    /**
     * The third timer, and the one that was missing (SCRUM-275): without it
     * the cache pulled above was the cache this box ran on until its next
     * restart, whatever was published or withdrawn in the meantime. A tick
     * that fails is a log line and a fault on the next heartbeat, never a
     * reason to stop ticking — the next one may be the pull that lands.
     */
    cacheRefreshTimer = setInterval(() => {
      void syncCache().catch((err) => {
        note('error', 'cache refresh tick failed', { err: String(err) });
        recordCacheFault('unreadable', 'pull_threw');
      });
    }, cacheRefreshIntervalMs);
    // A pending timer must never be the reason the process cannot exit.
    heartbeatTimer.unref?.();
    pollTimer.unref?.();
    cacheRefreshTimer.unref?.();
    note('info', 'box agent started', {
      boxId: state.boxId,
      heartbeatIntervalMs,
      pollIntervalMs,
      cacheRefreshIntervalMs,
    });
  }

  function stop(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (cacheRefreshTimer) clearInterval(cacheRefreshTimer);
    heartbeatTimer = null;
    pollTimer = null;
    cacheRefreshTimer = null;
    outbox?.stop();
    booth?.stop();
    // A `restart` command is `stop` then `start`: the booth's own timer went
    // with it, so the next `prepare` starts the booth again.
    boothStarted = false;
  }

  return {
    version: BOX_AGENT_VERSION,
    state,
    ensureRegistered,
    syncConfig,
    syncCache,
    heartbeat,
    runPendingCommands,
    prepare,
    start,
    stop,
    setOffline,
    outbox: () => outbox,
    sessions: () => sessions,
    scanner: () => scanner,
    cacheCursorSeq: () => cacheCursorSeq,
    printing: () => printing,
    terminal: () => terminals,
    booth: () => booth,
    sales: saleQueue,
    pauseHeartbeats(paused) {
      state.heartbeatsPaused = paused;
      note('info', paused ? 'heartbeats stopped by a test control' : 'heartbeats resumed');
    },
    async advanceClock(ms) {
      /**
       * The RAW clock moves, as a machine's clock steps (SCRUM-402). Until the
       * next heartbeat the box knows its clock moved but has not measured it:
       * it declares the new offset at once and stamps what the correction
       * leaves over on every event, which the platform overrules past its
       * minute. That heartbeat's answer is the measurement, and the box
       * stamps by the platform's time again from then on. Persisted, so a
       * restart comes back to the same raw clock — the clock a measurement
       * kept for this boot describes.
       */
      state.clockSkewMs += ms;
      publishClockState();
      if (store && state.boxId) await store.setClockSkew(state.boxId, state.clockSkewMs);
      note('warn', 'box clock moved by a test control', { clockSkewMs: state.clockSkewMs });
    },
    recentLogs,
    config: () => bundle,
  };
}

/**
 * Dotted version comparison, enough for `0.1.0` against `0.2.0`. Anything the
 * agent cannot parse is treated as new enough: refusing to work because a
 * version string was unexpected would be a worse failure than running.
 */
function isBelow(version: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}
