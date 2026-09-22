import {
  createBooth,
  type Booth,
  type BoothBranchContext,
  type BoothStaffRecord,
  type BoothStationContext,
} from './booth';
import { planCacheApply, type CacheFaultReason } from './cache-apply';
import type { SyncPushRequest, SyncPushResponse } from './contract';
import type { CredentialStore } from './credentials';
import { createOutbox, type Outbox } from './outbox';
import { generateSyncKeyPair, publicKeyFor } from './signing';
import { ScanRouter, type ScanInput } from './scan';
import { HidBurstReader, buttonKeyProblem, simulateHidKeys } from './scan-input';
import { StationSessionManager } from './station-session';
import type { BoxStore, CachedBundle, StationIdentity } from './store';
import {
  BOX_AGENT_VERSION,
  boxCredential,
  type BoxCommandHandout,
  type BoxCommandPollResponse,
  type BoxCommandResultRequest,
  type BoxCommandResultResponse,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxHeartbeatAck,
  type BoxHeartbeatRequest,
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
import { PrintTemplateSchema } from '@oto/shared';
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
  /** Injected so a test — and the Console's "Advance box clock" — can move it. */
  now?: () => number;
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
   * The operator this box belongs to. Learned at registration; pass it for a
   * box that comes back from its credential file and never registers again.
   */
  operatorId?: string;
  /** How often the outbox tries to hand its queue over. */
  syncIntervalMs?: number;
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
  };
}

export interface BoxAgentState {
  boxId: string | null;
  operatorId: string | null;
  registered: boolean;
  /** What the agent has actually applied, which is what the cloud compares. */
  configVersion: string | null;
  epoch: number;
  offline: boolean;
  heartbeatsPaused: boolean;
  clockSkewMs: number;
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
  /** Register, sync, heartbeat, poll — then set the three timers going. */
  start(): Promise<void>;
  stop(): void;
  /** The Console's "Stop heartbeats" test control. */
  pauseHeartbeats(paused: boolean): void;
  /** The Console's "Advance box clock": a deliberate skew, in milliseconds. */
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
   * The Lucky Wheel, or null on a box with no store (S2-07a).
   *
   * Non-null does NOT mean this box is a booth: the module answers
   * `config() === null` and `heartbeat() === null` until the box's bundle
   * carries a station of kind `booth`. Whatever serves the booth page wires
   * `createBoothHttp` to this.
   */
  booth(): Booth | null;
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
  let bundle: BoxConfigBundle | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let cacheRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const cacheRefreshIntervalMs = options.cacheRefreshIntervalMs ?? 60_000;
  /**
   * Strictly increasing, because the cloud refuses a heartbeat whose reported
   * time is not after the last one it accepted — that refusal is its replay
   * defence, and a box whose clock steps backwards under NTP would otherwise
   * silence itself until the clock caught up.
   */
  let lastReportedAt = 0;

  let printing: PrintingController | null = null;
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
  const ring: string[] = [];
  const state: BoxAgentState = {
    boxId: null,
    operatorId: options.operatorId ?? null,
    registered: false,
    configVersion: null,
    epoch: 1,
    offline: false,
    heartbeatsPaused: false,
    clockSkewMs: 0,
    lastHeartbeatAt: null,
    lastAckAt: null,
    commandsRun: 0,
    outboxDepth: 0,
    oldestUnackedS: null,
  };

  const clock = (): number => (options.now ? options.now() : Date.now()) + state.clockSkewMs;

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
    init: { method: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {
      method: 'GET',
    },
  ): Promise<{ status: number; body: T | null; etag: string | null }> {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.auth !== false) {
      if (!credential) throw new Error('box agent has no credential yet');
      headers.authorization = `Bearer ${credential}`;
    }
    const res = await call(`${base}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
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
     * `PrintJobOutcome` does not carry one: the booth knows which ids are its
     * own, including the ones a previous process left unprinted, which it
     * adopts at start-up for exactly this reason.
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
    const persisted = await store.init(boxId);
    state.offline = persisted.offline;
    state.epoch = persisted.journalEpoch;
    state.clockSkewMs = persisted.clockSkewMs;

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
        print: printing ? { submit: (request) => printing!.submit(request) } : null,
        printerHealth: () => printing?.jobs.health() ?? {},
        staff: () => boothStaff,
        ...(options.booth?.verifySecret ? { verifySecret: options.booth.verifySecret } : {}),
        printTemplates: () => cachedTemplates,
        ...(options.booth?.randomIndex ? { randomIndex: options.booth.randomIndex } : {}),
        now: () => new Date(clock()),
        log,
      });
    }

    note('info', 'box store attached', {
      boxId,
      offline: persisted.offline,
      epoch: persisted.journalEpoch,
    });
  }

  /** The booth station on this box, if its bundle names one. */
  function boothStation(): BoothStationContext | null {
    const station = bundle?.stations.find((s) => s.kind === 'booth');
    if (!station) return null;
    return { id: station.id, name: station.name, codePrefix: station.codePrefix };
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

  /**
   * A credential that stopped working is not a reason to give up: an
   * administrator rotating a box's claim code is exactly how a stolen box is
   * cut off and a replacement Pi is brought up in its slot, and the honest
   * response from this side is to drop what we hold and register again if we
   * can.
   */
  async function reregisterAfterRefusal(where: string): Promise<boolean> {
    note('warn', `credential refused on ${where} — dropping it and trying to register again`);
    credential = null;
    state.registered = false;
    await options.credentials.clear();
    try {
      return await ensureRegistered();
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
   * The Console's toggle writes `edge.box_state` directly, and for the virtual
   * box that row IS this box's store — so the button reaches a box that has
   * stopped listening to the network, which is the only way a box put offline
   * on purpose can be brought back without walking to it. A Pi cannot be
   * reached that way while its link is down: its `go_online` command is
   * delivered when the link returns, and its own till has a local control.
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
    bundle = body;
    adoptTemplates(body);
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
    // old as it was, and the till's banner should say so.
    if (status === 304) return [];
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
    if (applied.includes('booth')) {
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
      await store.setAppliedConfigVersion(state.boxId, state.configVersion);
    }
    note('info', 'cache applied', {
      scopes: applied.length,
      bundleVersion: body.bundleVersion,
      cursorSeq: body.cursorSeq,
    });
    return applied;
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
    const reportedMs = Math.max(clock(), lastReportedAt + 1);
    lastReportedAt = reportedMs;
    const payload: BoxHeartbeatRequest = {
      reportedAt: new Date(reportedMs).toISOString(),
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
       * has been ended and refuses to unlock offline at all.
       */
      errors: cacheFaultReports(),
    };
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
    const { status, body } = await request<BoxHeartbeatAck>('/box/v1/heartbeat', {
      method: 'POST',
      body: payload,
    });
    if (status === 401) {
      await reregisterAfterRefusal('heartbeat');
      return null;
    }
    if (status !== 200 || !body) {
      note('warn', 'heartbeat refused', { status });
      return null;
    }
    state.lastHeartbeatAt = payload.reportedAt;
    state.lastAckAt = body.receivedAt;
    state.epoch = body.epoch;
    /**
     * The last time this box has good reason to believe in (D11).
     *
     * The cloud's own clock, taken from the acknowledgement, is the only
     * trustworthy time a Pi with no clock battery ever sees. Remembering the
     * highest one is what lets a booth that came up after a mall power cut
     * notice that its clock is now EARLIER than a moment it has already lived
     * through — which is what flags a spin `clock_suspect` and stops the
     * trading day moving backwards.
     */
    await booth?.noteCloudTime(body.serverTime).catch((err) => {
      note('warn', 'the booth could not record the cloud time', { err: String(err) });
    });
    if (body.configVersion !== state.configVersion) {
      await syncConfig();
    }
    if (body.commandsPending > 0) {
      await runPendingCommands();
    }
    return body;
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

  async function runPendingCommands(): Promise<number> {
    if (!credential || state.offline) return 0;
    const { status, body } = await request<BoxCommandPollResponse>('/box/v1/commands/poll', {
      method: 'POST',
      body: { max: 5 },
    });
    if (status === 401) {
      await reregisterAfterRefusal('command poll');
      return 0;
    }
    if (status !== 200 || !body) return 0;
    let ran = 0;
    for (const command of body.commands) {
      const outcome = await executeCommand(command);
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
        if (store && state.boxId && ack.epoch !== state.epoch) {
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
      await syncConfig();
      await outbox?.flush();
    }
    return state.offline;
  }

  async function start(): Promise<void> {
    await ensureRegistered();
    if (!credential) return;
    await syncConfig();
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
     * Before the first heartbeat, because that heartbeat carries the booth
     * block and a block measured before the wheel was adopted would report
     * `configVersion: null` on a booth that is in fact running version 4.
     *
     * It also adopts the vouchers a previous process left unprinted, so their
     * outcomes go to the outbox rather than to the cloud's print route — which
     * has to happen before anything can submit a job (D20).
     */
    await booth?.start().catch((err) => {
      note('error', 'the booth could not start', { err: String(err) });
    });
    await heartbeat();
    await runPendingCommands();
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
  }

  return {
    version: BOX_AGENT_VERSION,
    state,
    ensureRegistered,
    syncConfig,
    syncCache,
    heartbeat,
    runPendingCommands,
    start,
    stop,
    setOffline,
    outbox: () => outbox,
    sessions: () => sessions,
    scanner: () => scanner,
    cacheCursorSeq: () => cacheCursorSeq,
    printing: () => printing,
    booth: () => booth,
    pauseHeartbeats(paused) {
      state.heartbeatsPaused = paused;
      note('info', paused ? 'heartbeats stopped by a test control' : 'heartbeats resumed');
    },
    async advanceClock(ms) {
      state.clockSkewMs += ms;
      // Persisted, because the skew decides `clock_trust` on every event the
      // box mints from here on, and an event stamped `trusted` by a box whose
      // clock is a day out is how a day's takings land on the wrong date.
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
