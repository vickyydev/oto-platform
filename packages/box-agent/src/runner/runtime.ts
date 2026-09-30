/**
 * The booth box, assembled (SCRUM-223).
 *
 * Every part of a real box already existed and was tested on its own — the
 * SQLite store, the credential file, the HTTP transport, the booth role, the
 * TCP 9100 printer channel, the outbox and the heartbeat — and nothing put them
 * together into a process that runs on a Raspberry Pi. This does, and adds the
 * two things only a real box needs:
 *
 *  - a copy of the config bundle on disk, so the booth knows its station, its
 *    printer and its trading day when it boots before the internet does;
 *  - the kiosk server (`kiosk-server.ts`) for the television plugged into it.
 *
 * It is the same agent the api runs as the virtual box, built with a file
 * credential store and a SQLite store instead of memory and Postgres. What a
 * test proves about one is a claim about the other.
 *
 * **A store it cannot use does not stop it (SCRUM-403).** A card that loses
 * writes it said were saved leaves `box.sqlite` unreadable or damaged. The
 * process used to exit on it in about 160 ms, systemd started it again every
 * three seconds, and the television showed Chromium's error page while the
 * Console heard nothing. Now the kiosk listens before the store is opened; a
 * store that cannot be opened, or whose integrity check finds damage, puts the
 * box in NEEDS SERVICE — the television says so and names the way back, the
 * health route answers 503 with the reason, the unsent outbox is copied out of
 * the file into a salvage file beside it, the heartbeat carries the fault, and
 * the store is tried again once a minute in case the card recovers. The file
 * itself is never moved or deleted here: that is `oto-box claim --force`'s
 * decision, taken by a person.
 */

import { hostname as osHostname } from 'node:os';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createBoxAgent, type BoxAgent, type BoxConfigCache } from '../agent';
import type { Booth } from '../booth';
import { createBoothHttp } from '../booth-http';
import { fileCredentialStore, type BoxCredential, type CredentialStore } from '../credentials';
import { BOX_AGENT_VERSION, type BoxConfigBundle } from '../protocol';
import { SqlBoxStore } from '../store-sql';
import {
  checkSqliteStore,
  prepareSqliteBoxStore,
  salvageSqliteOutbox,
  sqliteBoxDriver,
  sqliteMessage,
  sqliteProblemOf,
  type OutboxSalvage,
  type SqliteDatabaseLike,
  type SqliteStoreCheck,
  type SqliteStoreProblem,
} from '../store-sqlite';
import {
  httpTransport,
  silentLog,
  type AgentFetch,
  type AgentLog,
  type AgentResponse,
} from '../transport';
import {
  readJsonFile,
  readOverrides,
  readRunnerState,
  runnerPaths,
  writeJsonAtomic,
  writeRunnerState,
  type RunnerPaths,
} from './home';
import {
  createKioskServer,
  KIOSK_DEFAULT_PORT,
  type BoothHandler,
  type KioskBoothSummary,
  type KioskClaimOutcome,
  type KioskCondition,
  type KioskServer,
  type KioskState,
} from './kiosk-server';
import { applyPrinterOverride } from './printer-override';
import { createBridgeServer, type BridgeServer } from './bridge-server';

/** A failure the person running the box can act on, worded for them. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

export type OpenDatabase = (
  file: string,
  /** Read-only: for looking at a store, never for running on it (SCRUM-403). */
  options?: { readOnly?: boolean },
) => Promise<SqliteDatabaseLike> | SqliteDatabaseLike;

/**
 * `node:sqlite`, opened lazily.
 *
 * Lazily so the import's one-line "experimental" warning can be kept out of
 * the box's journal: SQLite in Node 22 works and is what the store is tested
 * on, and a warning on every boot is noise somebody reading the journal for a
 * real fault has to step over.
 */
export const openNodeSqlite: OpenDatabase = async (file, options) => {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(
      file,
      options?.readOnly ? { readOnly: true } : {},
    ) as unknown as SqliteDatabaseLike;
  } finally {
    process.emitWarning = emit;
  }
};

/**
 * argon2id verification for booth PINs, from `@node-rs/argon2`.
 *
 * The one native module a box needs, loaded here rather than imported so that
 * a box whose prebuilt binary failed to install still runs its wheel: PINs are
 * then refused (said loudly in the log) and a phone-and-password sign-in, which
 * the cloud checks, still works.
 */
export async function loadArgon2Verifier(
  log: AgentLog,
): Promise<((hash: string, secret: string) => Promise<boolean>) | null> {
  try {
    const argon2 = (await import('@node-rs/argon2')) as {
      verify: (hash: string, secret: string) => Promise<boolean>;
    };
    return async (hash, secret) => {
      try {
        return await argon2.verify(hash, secret);
      } catch {
        return false;
      }
    };
  } catch (err) {
    log.error(
      { module: 'runner', err: String(err) },
      'argon2 could not be loaded: booth PIN sign-in is refused until @node-rs/argon2 is installed',
    );
    return null;
  }
}

function isBundle(value: unknown): value is BoxConfigBundle {
  if (typeof value !== 'object' || value === null) return false;
  const held = value as Partial<BoxConfigBundle>;
  return (
    typeof held.configVersion === 'string' &&
    Array.isArray(held.stations) &&
    typeof held.branch === 'object' &&
    held.branch !== null
  );
}

/** The config bundle on disk, exactly as the cloud sent it. */
function fileConfigCache(paths: RunnerPaths): BoxConfigCache {
  return {
    async read() {
      const raw = await readJsonFile(paths.configBundle);
      return isBundle(raw) ? raw : null;
    },
    async write(bundle) {
      await writeJsonAtomic(paths.configBundle, bundle, 0o600);
    },
  };
}

// --- A store the box cannot use (SCRUM-403) ----------------------------------

/**
 * Look at a store file without running on it: opened read-only, its
 * integrity checked, closed again. A file that is not there is fine — a new
 * store is made where it was.
 *
 * Read-only because a closing read-write connection checkpoints the WAL into
 * the file and deletes it, and nothing is written into a file that is about
 * to be read for what it still holds. Closed before this returns, so a claim
 * in a terminal can set the file aside while the service keeps looking at it.
 */
export async function inspectStoreFile(
  file: string,
  openDatabase: OpenDatabase = openNodeSqlite,
): Promise<SqliteStoreCheck> {
  const found = await stat(file).catch(() => null);
  if (!found) return { ok: true };
  let db: SqliteDatabaseLike | null = null;
  try {
    db = await openDatabase(file, { readOnly: true });
    return checkSqliteStore(db);
  } catch (err) {
    return { ok: false, problem: sqliteProblemOf(err), detail: sqliteMessage(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* a handle that never opened has nothing to close */
    }
  }
}

/** What a salvage file says it is, so nothing else beside the store is taken for one. */
const SALVAGE_KIND = 'oto-box.outbox-salvage';

/** The store file as it stood when its outbox was copied out, to know a copy of it again. */
interface SalvageSource {
  file: string;
  bytes: number;
  modifiedAt: string;
  walBytes: number;
}

/**
 * `box.sqlite.salvage-<time>.json`: the unsent outbox of a store the box could
 * not run on, owner-only like the store it came from. The rows are every
 * column the store holds, the signed envelope untouched, in journal order — so
 * an engineer can put the vouchers the cloud never received back on their way.
 */
export interface SalvageDocument {
  kind: typeof SALVAGE_KIND;
  version: 1;
  salvagedAt: string;
  store: SqliteStoreProblem;
  source: SalvageSource;
  rows: number;
  /** False when the read stopped at damage part-way: more may be in the file. */
  complete: boolean;
  error: string | null;
  events: Array<Record<string, unknown>>;
}

/** What a salvage came to, for the health route, the log and the heartbeat. */
export interface SalvageOutcome {
  rows: number;
  file: string | null;
  error: string | null;
  /**
   * Whether every unsent row in the file was read. False when the read
   * stopped at damage part-way or never started: `rows` is then how many AT
   * LEAST, and the heartbeat says so (`reportingStoreFault`).
   */
  complete: boolean;
  /** When the oldest of them was queued, for the heartbeat's `oldestUnackedS`. */
  oldestQueuedAt: string | null;
}

async function salvageSource(paths: RunnerPaths): Promise<SalvageSource | null> {
  const main = await stat(paths.database).catch(() => null);
  if (!main) return null;
  // The WAL's size and not its time: a read-only look makes an empty one,
  // and an empty WAL holds nothing either way.
  const wal = await stat(`${paths.database}-wal`).catch(() => null);
  return {
    file: basename(paths.database),
    bytes: main.size,
    modifiedAt: main.mtime.toISOString(),
    walBytes: wal?.size ?? 0,
  };
}

function oldestQueued(events: Array<Record<string, unknown>>): string | null {
  const times = events
    .map((event) => event.created_at)
    .filter((value): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
    .sort();
  return times[0] ?? null;
}

/**
 * The newest salvage file beside the store, whatever file it was copied from.
 * `oto-box status` names it; the runner reuses it when it was copied from the
 * very file that is still there.
 */
export async function latestSalvage(
  paths: RunnerPaths,
): Promise<{ file: string; document: SalvageDocument } | null> {
  const prefix = `${basename(paths.database)}.salvage-`;
  const names = (await readdir(paths.home).catch(() => [] as string[]))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  const newest = names[names.length - 1];
  if (!newest) return null;
  const file = join(paths.home, newest);
  const raw = (await readJsonFile(file)) as Partial<SalvageDocument> | null;
  if (!raw || raw.kind !== SALVAGE_KIND || !Array.isArray(raw.events)) return null;
  return { file, document: raw as SalvageDocument };
}

/**
 * Copy the unsent outbox out of a store the box cannot run on (SCRUM-403).
 *
 * Once per start, and not again for the same file: a box restarted — the
 * nightly reboot, a restart by hand, systemd after a crash — would otherwise
 * write another copy at every start onto a card that is already failing.
 * Nothing is moved or deleted — the file stays exactly where it is, for the
 * claim that sets it aside and the engineer after it.
 */
async function salvageOutbox(
  paths: RunnerPaths,
  problem: SqliteStoreProblem,
  openDatabase: OpenDatabase,
  log: AgentLog,
): Promise<SalvageOutcome> {
  const source = await salvageSource(paths);
  if (!source) {
    return {
      rows: 0,
      file: null,
      error: 'the store file is not there',
      complete: false,
      oldestQueuedAt: null,
    };
  }
  const held = await latestSalvage(paths);
  if (held && JSON.stringify(held.document.source) === JSON.stringify(source)) {
    return {
      rows: held.document.rows,
      file: held.file,
      error: held.document.error,
      // What the copy said of its own read: a restart does not make it whole.
      complete: held.document.complete === true,
      oldestQueuedAt: oldestQueued(held.document.events),
    };
  }

  let salvage: OutboxSalvage;
  let db: SqliteDatabaseLike | null = null;
  try {
    db = await openDatabase(paths.database, { readOnly: true });
    salvage = salvageSqliteOutbox(db);
  } catch (err) {
    salvage = { rows: [], complete: false, error: sqliteMessage(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing opened */
    }
  }
  if (salvage.rows.length === 0) {
    return {
      rows: 0,
      file: null,
      error: salvage.error,
      complete: salvage.complete,
      oldestQueuedAt: null,
    };
  }

  const salvagedAt = new Date().toISOString();
  const file = `${paths.database}.salvage-${salvagedAt.replace(/[:.]/g, '-')}.json`;
  const document: SalvageDocument = {
    kind: SALVAGE_KIND,
    version: 1,
    salvagedAt,
    store: problem,
    source,
    rows: salvage.rows.length,
    complete: salvage.complete,
    error: salvage.error,
    events: salvage.rows,
  };
  try {
    await writeJsonAtomic(file, document, 0o600);
  } catch (err) {
    log.error(
      { module: 'runner', err: String(err), rows: salvage.rows.length },
      'the unsent records read out of the store could not be written beside it',
    );
    return {
      rows: salvage.rows.length,
      file: null,
      error: `the salvage file could not be written: ${sqliteMessage(err)}`,
      complete: salvage.complete,
      oldestQueuedAt: oldestQueued(salvage.rows),
    };
  }
  return {
    rows: salvage.rows.length,
    file,
    error: salvage.error,
    complete: salvage.complete,
    oldestQueuedAt: oldestQueued(salvage.rows),
  };
}

/** What the heartbeat of a box that needs service says about its store. */
interface StoreFaultReport {
  store: SqliteStoreProblem;
  /** Failed looks at the store since this process started. */
  checks: number;
  /** Unsent rows copied out of it, and when the oldest was queued. */
  salvaged: number;
  /** Whether those were every unsent row in the file (`SalvageOutcome.complete`). */
  salvageComplete: boolean;
  oldestQueuedAt: string | null;
}

function isPath(url: string, path: string): boolean {
  try {
    return new URL(url).pathname.endsWith(path);
  } catch {
    return false;
  }
}

/**
 * A command poll answered on the box itself: nothing to run. A 200 with an
 * empty list, which the agent takes for an empty queue and nothing else. Its
 * `serverTime` is this box's own clock, which nothing reads off a poll; and
 * the link a 200 implies is read by nothing a box that needs service shows
 * (the notice has no link dot, and there is no booth to be online for).
 */
function nothingToRun(): AgentResponse {
  const body = { commands: [], serverTime: new Date().toISOString() };
  return {
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    header: () => null,
  };
}

/**
 * The transport of the agent that reports for a box whose store cannot be
 * used (SCRUM-403). Two things differ from the ordinary transport:
 *
 *  - It takes NO command, ever. The Console's commands stay queued on the
 *    platform for the agent that runs on the store, or lapse there. This one
 *    has nowhere to run them, and the one that matters most shows why:
 *    Reset the store, acknowledged by an agent with no store, has the
 *    platform close the epoch the store still seals under, with nothing on
 *    the box to take the new one — so once the card recovered, every fact
 *    sealed would be quarantined as `epoch_regressed` and its voucher would
 *    never reach a till. Answered here for the whole life of this agent, not
 *    only while `current()` names a fault, so a poll already on its way as
 *    the store comes back takes nothing either.
 *  - Its heartbeat carries the fault in `errors` — fingerprint, code and
 *    count, no contents, as every other fault goes (Health files it under
 *    the offline-copy alert's wording until SCRUM-445) — and the unsent records
 *    the box still holds in the damaged file, which an agent with no store
 *    would report as none. That number is all the Console goes on when it
 *    refuses Reset the store for a box with unsent events
 *    (`BOX_OUTBOX_UNSYNCED`), so where the file could not be read in full it
 *    is AT LEAST ONE — at least the rows that were read — and the age of the
 *    oldest is not known: it may be among the rows that were not.
 *
 * Every other call passes untouched.
 */
export function reportingStoreFault(
  fetch: AgentFetch,
  current: () => StoreFaultReport | null,
): AgentFetch {
  return async (url, init) => {
    if (init.method === 'POST' && isPath(url, '/box/v1/commands/poll')) return nothingToRun();
    const fault = current();
    if (
      !fault ||
      init.method !== 'POST' ||
      init.body === undefined ||
      !isPath(url, '/box/v1/heartbeat')
    ) {
      return fetch(url, init);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(init.body);
    } catch {
      return fetch(url, init);
    }
    if (typeof payload !== 'object' || payload === null) return fetch(url, init);
    const heartbeat = payload as Record<string, unknown>;
    const fingerprint = `store:${fault.store}`;
    const others = (Array.isArray(heartbeat.errors) ? heartbeat.errors : []).filter(
      (entry: unknown) =>
        !(
          typeof entry === 'object' &&
          entry !== null &&
          String((entry as { fingerprint?: unknown }).fingerprint ?? '').startsWith('store:')
        ),
    );
    heartbeat.errors = [
      { fingerprint, code: `box.store_${fault.store}`, count: Math.max(1, fault.checks) },
      ...others,
    ].slice(0, 32);
    if (fault.salvaged > 0 || !fault.salvageComplete) {
      const reported = typeof heartbeat.outboxDepth === 'number' ? heartbeat.outboxDepth : 0;
      heartbeat.outboxDepth = Math.max(reported, fault.salvaged, fault.salvageComplete ? 0 : 1);
      heartbeat.oldestUnackedS =
        fault.salvageComplete && fault.oldestQueuedAt
          ? Math.max(0, Math.floor((Date.now() - Date.parse(fault.oldestQueuedAt)) / 1000))
          : null;
    }
    return fetch(url, { ...init, body: JSON.stringify(heartbeat) });
  };
}

/**
 * `oto-box claim` in a terminal holds this file for as long as it runs
 * (SCRUM-403): it sets the old store and credential aside, makes a new store,
 * registers, and writes the new credential, in that order and in another
 * process. A box that needs service, trying its store again meanwhile, would
 * otherwise open the store half made — and find no credential and run
 * unclaimed, or find the new credential before its journal row and take the
 * new box's store for a new store under an old identity. So it waits.
 */
const CLAIM_LOCK_FILE = 'claiming.json';
/** A claim that has held the lock this long has died holding it; it is ignored. */
const CLAIM_LOCK_STALE_MS = 5 * 60_000;
/** How long a starting box waits for a claim under way before it opens the store anyway. */
const CLAIM_WAIT_MS = 60_000;

function claimLockPath(paths: RunnerPaths): string {
  return join(paths.home, CLAIM_LOCK_FILE);
}

/** Whether `oto-box claim` is making this box's store and credential right now. */
async function claimUnderWay(paths: RunnerPaths): Promise<boolean> {
  const held = (await readJsonFile(claimLockPath(paths))) as { startedAt?: unknown } | null;
  const at = typeof held?.startedAt === 'string' ? Date.parse(held.startedAt) : Number.NaN;
  return Number.isFinite(at) && Math.abs(Date.now() - at) < CLAIM_LOCK_STALE_MS;
}

/** Anything SQLite threw: `node:sqlite` puts its result code on the error. */
function isSqliteError(err: unknown): boolean {
  return typeof (err as { errcode?: unknown } | null)?.errcode === 'number';
}

/**
 * The credential as the agent that reports for a box needing service may use
 * it (SCRUM-403): read, never written or cleared, and only while the file
 * names the box it named first.
 *
 * The way back from a damaged store is `oto-box claim --force` in a terminal
 * while this process runs, and the claim writes a NEW box's credential into
 * the same file. This agent must not take that one for its own; and a refusal
 * of the old one — which an agent answers by clearing the file — must not
 * wipe the new box's secret, which the cloud will never send again.
 */
function reportingCredentials(path: string): CredentialStore {
  const file = fileCredentialStore(path);
  let pinned: string | null = null;
  return {
    async read() {
      const held = await file.read();
      if (!held) return null;
      pinned ??= held.boxId;
      return held.boxId === pinned ? held : null;
    },
    async write() {},
    async clear() {},
  };
}

// --- oto-box run ------------------------------------------------------------

export interface RunnerOptions {
  /** The box's home directory: credential, store, config copy, choices. */
  home: string;
  /** The api to talk to. Falls back to the one this box was claimed against. */
  apiBaseUrl?: string | null;
  port?: number;
  /** The built booth page. Null serves a line saying it is missing. */
  pageDir?: string | null;
  hostname?: string;
  fetch?: AgentFetch;
  /**
   * How long a call to the cloud waits for an answer to begin, in ms:
   * `AGENT_ANSWER_TIMEOUT_MS` (15 s) unless a test says. Unused when `fetch`
   * is given.
   */
  cloudTimeoutMs?: number;
  log?: AgentLog;
  openDatabase?: OpenDatabase;
  /**
   * The PIN verifier. `undefined` loads `@node-rs/argon2`; `null` runs with
   * none, and every PIN is refused.
   */
  verifySecret?: ((hash: string, secret: string) => Promise<boolean>) | null;
  /**
   * A claim that gave this box a new identity needs a fresh process — and so
   * does a credential written by `oto-box claim` while this one was running
   * unclaimed.
   */
  onRestartNeeded?: () => void;
  /** How often an unclaimed box looks for a credential `oto-box claim` wrote. */
  credentialPollMs?: number;
  /** How often a store that cannot be used is tried again (60 s unless a test says). */
  storeRetryMs?: number;
  /** Off for a test that drives the handler without a socket. */
  listen?: boolean;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  syncIntervalMs?: number;
  cacheRefreshIntervalMs?: number;
  /** How long a slip waits before the printer is tried again (30 s unless a test says). */
  printRetryDelayMs?: number;
  /**
   * The station bridge for a counter box (offline plan §2.2, Round 3): a
   * second loopback listener that Caddy publishes on the counter's LAN.
   * Absent, the box serves no bridge — a booth box needs none.
   */
  bridge?: { port?: number; origins: readonly string[] } | null;
}

/** A store the box could not use, while it needs service (SCRUM-403). */
export interface StoreFault {
  store: SqliteStoreProblem;
  /** SQLite's words: the integrity check's first lines, or the error. For the log. */
  detail: string;
  /** Failed looks at the store since this process started. */
  checks: number;
  since: string;
  salvaged: number;
  /** False when the unsent rows could not all be read: `salvaged` is then a floor. */
  salvageComplete: boolean;
  salvageFile: string | null;
  salvageError: string | null;
}

export interface RunningBox {
  /**
   * The agent running now: the booth's — or, while the store needs service,
   * one with no store that reports the fault on its heartbeat (SCRUM-403).
   * Read it again after the store comes back: that is a new agent.
   */
  readonly agent: BoxAgent;
  kiosk: KioskServer;
  /** Where the kiosk is listening; the configured port when `listen` is off. */
  port: number;
  paths: RunnerPaths;
  /** Null while the box runs; what is wrong with its store while it needs service. */
  readonly storeFault: StoreFault | null;
  stop(): Promise<void>;
}

/** `oto-box run`: the agent, its store, and the kiosk server, until stopped. */
export async function startRunner(options: RunnerOptions): Promise<RunningBox> {
  const log = options.log ?? silentLog;
  const paths = runnerPaths(options.home);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const state = await readRunnerState(paths);
  const apiBaseUrl = (options.apiBaseUrl ?? state.apiBaseUrl ?? '').replace(/\/$/, '');
  if (!apiBaseUrl) {
    throw new RunnerError(
      'No api address: pass --api (or set OTO_BOX_API), e.g. https://oto-api-staging.onrender.com',
    );
  }
  const { overrides, problem } = await readOverrides(paths);
  if (problem) log.warn({ module: 'runner' }, problem);
  if (overrides.printer) {
    log.info(
      {
        module: 'runner',
        printer: `${overrides.printer.host}:${overrides.printer.port}`,
        widthDots: overrides.printer.widthDots,
      },
      'the booth receipt printer is overridden by config.json',
    );
  }
  const openDatabase = options.openDatabase ?? openNodeSqlite;

  let selected = state.stationId;
  let pendingClaim: string | null = null;
  const reportedWithoutPrinter = new Set<string>();

  /** The agent running now. Null only between the kiosk listening and the store being looked at. */
  let agent: BoxAgent | null = null;
  /** The store's connection, while the box runs on it. */
  let db: SqliteDatabaseLike | null = null;
  /** What the kiosk says of the box; see `KioskCondition`. */
  let condition: KioskCondition = { state: 'starting' };
  /** Set while the box needs service. */
  let fault: StoreFault | null = null;
  /** When the oldest unsent record copied out of the store was queued, for the heartbeat. */
  let faultOldestQueuedAt: string | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let retrying = false;
  let stopped = false;

  /** Whether `start` got past registration and set the agent's timers going. */
  let running = false;
  /** See `watchForCredential`, once the kiosk is listening. */
  let credentialWatch: ReturnType<typeof setInterval> | null = null;
  // A claim typed on the television writes the same file from inside this
  // process; that one is not a reason to restart.
  let claimingHere = false;

  const online = (): boolean => agent !== null && !agent.state.offline && agent.state.linkUp;
  const handlers = new WeakMap<Booth, BoothHandler>();

  function boothStations(): KioskBoothSummary[] {
    if (!agent || fault) return [];
    return (agent.config()?.stations ?? [])
      .filter((station) => station.kind === 'booth')
      .map((station) => ({
        stationId: station.id,
        name: station.name,
        codePrefix: station.codePrefix,
      }));
  }

  function boothHandler(): BoothHandler | null {
    if (!agent || fault || !agent.state.registered) return null;
    const booth = agent.booth();
    if (!booth) return null;
    let handler = handlers.get(booth);
    if (!handler) {
      handler = createBoothHttp({ booth, online, log });
      handlers.set(booth, handler);
    }
    return handler;
  }

  async function kioskState(): Promise<KioskState> {
    const booths = boothStations();
    const chosen = booths.find((b) => b.stationId === selected)?.stationId ?? null;
    return {
      registered: agent?.state.registered ?? false,
      online: online(),
      booths,
      selectedStationId: booths.length === 1 ? booths[0]!.stationId : chosen,
      agentVersion: agent?.version ?? BOX_AGENT_VERSION,
      service: fault ? { store: fault.store } : null,
    };
  }

  async function claim(code: string): Promise<KioskClaimOutcome> {
    const current = agent;
    // The kiosk refuses a claim while the box needs service; this is the
    // same answer from the one place that could still be reached.
    if (!current || fault) return { ok: false, reason: 'refused' };
    if (current.state.registered) return { ok: false, reason: 'already_registered' };
    const previousBox = current.state.boxId;
    pendingClaim = code;
    claimingHere = true;
    try {
      const registered = await current.ensureRegistered();
      if (!registered) return { ok: false, reason: 'refused' };
    } catch (err) {
      if (isSqliteError(err)) {
        // The code was taken and the credential is on the card, and the store
        // refused the rows the registration writes beside it (NO NEW FACT
        // BEFORE A FRESH EPOCH): a store this box cannot use, said as every
        // other one is (SCRUM-403), rather than a box left half claimed. The
        // page's next look at the box shows the notice.
        log.warn(
          { module: 'runner', boxId: current.state.boxId },
          'this box was claimed from the kiosk, and its store refused what the registration writes',
        );
        current.stop();
        try {
          db?.close();
        } catch {
          /* already gone */
        }
        db = null;
        await writeRunnerState(paths, { apiBaseUrl, stationId: selected }).catch(() => undefined);
        await needService(sqliteProblemOf(err), sqliteMessage(err));
        return { ok: true };
      }
      const refused = err instanceof Error && err.message.startsWith('box registration failed');
      log.warn(
        { module: 'runner', reason: refused ? 'refused' : 'unreachable' },
        'a claim code typed on the kiosk did not register this box',
      );
      return { ok: false, reason: refused ? 'refused' : 'unreachable' };
    } finally {
      pendingClaim = null;
      claimingHere = false;
    }
    await writeRunnerState(paths, { apiBaseUrl, stationId: selected });
    log.info({ module: 'runner', boxId: current.state.boxId }, 'this box was claimed from the kiosk');
    if (previousBox && previousBox !== current.state.boxId) {
      // The store on disk is the old box's. A fresh process opens it for the
      // new identity rather than this one writing one box's facts as another.
      log.warn({ module: 'runner' }, 'a new box identity needs a restart; restarting');
      options.onRestartNeeded?.();
      return { ok: true };
    }
    if (!running) {
      await current.start();
      running = true;
    }
    return { ok: true };
  }

  async function selectBooth(stationId: string): Promise<boolean> {
    if (!agent || fault) return false;
    if (!boothStations().some((b) => b.stationId === stationId)) return false;
    selected = stationId;
    await writeRunnerState(paths, { apiBaseUrl, stationId });
    await agent.booth()?.refresh().catch((err: unknown) => {
      log.error({ module: 'runner', err: String(err) }, 'the chosen booth could not be applied');
      return false;
    });
    log.info({ module: 'runner', stationId }, 'the kiosk chose a booth');
    // Tell the Console now rather than in a minute: the booth block moves.
    void agent.heartbeat().catch(() => null);
    return true;
  }

  /**
   * The order of a boot, and why (SCRUM-223, SCRUM-403): the television, then
   * the box's own half, then the cloud.
   *
   * The kiosk listens FIRST, before the store is opened, so the television
   * always has a page: "Starting the box…" for the moment the store and the
   * credential take, and — when the store cannot be used — the notice that
   * says the box needs service, rather than Chromium's error page. It used to
   * listen after `prepare`, and a store that failed to open ended the process
   * before anything was served.
   *
   * `prepare` needs nothing from the cloud — the credential file, the store,
   * the copy of the config, the booth on the wheel it holds — and after it the
   * kiosk has everything it serves. So the box is `running` before `start`
   * asks the cloud for anything. The other way round, a cloud that took the
   * connection and never answered kept the television dark for as long as
   * `start` waited — measured at over seven minutes — and the watchdog, which
   * asks this server for `/kiosk/health`, restarted the box into the same wait
   * for as long as the stall lasted.
   */
  const kiosk = createKioskServer({
    port: options.port ?? KIOSK_DEFAULT_PORT,
    host: '127.0.0.1',
    pageDir: options.pageDir ?? null,
    booth: boothHandler,
    state: kioskState,
    claim,
    selectBooth,
    condition: () => condition,
    log,
  });
  let port = options.port ?? KIOSK_DEFAULT_PORT;
  if (options.listen !== false) {
    const address = await kiosk.listen();
    port = address.port;
    log.info({ module: 'runner', port }, `the booth page is served at http://127.0.0.1:${port}/`);
  }

  /**
   * The station bridge (offline plan §2.2), for a counter box that names the
   * POS origins its tills are served from. It answers from whichever agent is
   * running now, and says the box is starting until there is one.
   */
  const bridgeServer: BridgeServer | null =
    options.bridge && options.bridge.origins.length > 0
      ? createBridgeServer({
          agent: () => (fault ? null : agent),
          origins: options.bridge.origins,
          ...(options.bridge.port !== undefined ? { port: options.bridge.port } : {}),
          log,
        })
      : null;
  if (bridgeServer && options.listen !== false) await bridgeServer.listen();

  const verifySecret =
    options.verifySecret === undefined ? await loadArgon2Verifier(log) : options.verifySecret;

  /**
   * The agent, over a store — or with none, while the store needs service.
   * That one only reports: it holds the credential and heartbeats with the
   * fault. It takes none of the Console's commands (`reportingStoreFault`),
   * and has no booth, no printer and no outbox, because it has nowhere to
   * keep a fact.
   */
  function buildAgent(store: SqlBoxStore | null): BoxAgent {
    const transport =
      options.fetch ??
      httpTransport(
        options.cloudTimeoutMs === undefined ? {} : { answerTimeoutMs: options.cloudTimeoutMs },
      );
    return createBoxAgent({
      apiBaseUrl,
      credentials: store
        ? fileCredentialStore(paths.credential)
        : reportingCredentials(paths.credential),
      // Only ever a code a person typed on the kiosk's first-run screen, and
      // only for as long as that one registration takes.
      claimCode: async () => (store ? pendingClaim : null),
      hostname: options.hostname ?? overrides.hostname ?? osHostname(),
      fetch: store
        ? transport
        : reportingStoreFault(transport, () =>
            fault
              ? {
                  store: fault.store,
                  checks: fault.checks,
                  salvaged: fault.salvaged,
                  salvageComplete: fault.salvageComplete,
                  oldestQueuedAt: faultOldestQueuedAt,
                }
              : null,
          ),
      log,
      ...(store ? { store } : {}),
      configCache: fileConfigCache(paths),
      configTransform: (bundle) => {
        const patched = applyPrinterOverride(bundle, overrides.printer);
        for (const name of patched.withoutPrinter) {
          if (reportedWithoutPrinter.has(name)) continue;
          reportedWithoutPrinter.add(name);
          log.warn(
            { module: 'runner', booth: name },
            'config.json names a printer, but this booth has no receipt printer in the Console to point at it — add one to this box first',
          );
        }
        return patched.bundle;
      },
      // The queue is kept on the card: a voucher waiting on paper survives a
      // power cut and prints when the printer is back.
      printing: store
        ? {
            durable: true,
            ...(options.printRetryDelayMs !== undefined
              ? { retryDelayMs: options.printRetryDelayMs }
              : {}),
          }
        : { enabled: false },
      ...(store ? {} : { terminal: { enabled: false } }),
      booth: store
        ? {
            ...(verifySecret ? { verifySecret } : {}),
            stationId: () => selected,
          }
        : { enabled: false },
      ...(options.heartbeatIntervalMs ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.syncIntervalMs ? { syncIntervalMs: options.syncIntervalMs } : {}),
      ...(options.cacheRefreshIntervalMs
        ? { cacheRefreshIntervalMs: options.cacheRefreshIntervalMs }
        : {}),
    });
  }

  /** Open the store to run on: looked at first, then opened and prepared. */
  async function openStore(): Promise<
    { ok: true; db: SqliteDatabaseLike } | { ok: false; problem: SqliteStoreProblem; detail: string }
  > {
    const verdict = await inspectStoreFile(paths.database, openDatabase);
    if (!verdict.ok) return verdict;
    let opened: SqliteDatabaseLike | null = null;
    try {
      opened = await openDatabase(paths.database);
      prepareSqliteBoxStore(opened);
      return { ok: true, db: opened };
    } catch (err) {
      try {
        opened?.close();
      } catch {
        /* nothing opened */
      }
      // Named by the same rule as everywhere else: "malformed" as it is
      // prepared is a damaged store, as it is when the agent meets it.
      return { ok: false, problem: sqliteProblemOf(err), detail: sqliteMessage(err) };
    }
  }

  /**
   * An unclaimed box watches for a credential `oto-box claim` writes.
   *
   * `oto-box claim` in a terminal while the service is already up and showing
   * the claim screen writes the credential under this process's feet. Without
   * this the television would go on asking for a code that had already been
   * used, until somebody thought to restart the service. The file appearing is
   * the signal; a fresh process (systemd restarts it) opens it cleanly.
   */
  function watchForCredential(): void {
    if (credentialWatch) return;
    const credentials = fileCredentialStore(paths.credential);
    credentialWatch = setInterval(() => {
      if (agent?.state.registered) {
        if (credentialWatch) clearInterval(credentialWatch);
        credentialWatch = null;
        return;
      }
      if (claimingHere) return;
      void credentials
        .read()
        .then((held) => {
          if (!held || claimingHere || agent?.state.registered || !credentialWatch) return;
          clearInterval(credentialWatch);
          credentialWatch = null;
          log.info(
            { module: 'runner', boxId: held.boxId },
            'this box was claimed from the command line; restarting to use the credential',
          );
          options.onRestartNeeded?.();
        })
        .catch(() => undefined);
    }, options.credentialPollMs ?? 5_000);
    credentialWatch.unref?.();
  }

  /** The box on its store: prepared, running, then the cloud. */
  async function runBox(opened: SqliteDatabaseLike): Promise<void> {
    if (stopped) {
      opened.close();
      return;
    }
    db = opened;
    const current = buildAgent(new SqlBoxStore({ driver: sqliteBoxDriver(opened) }));
    agent = current;
    let registered: boolean;
    try {
      registered = await current.prepare();
    } catch (err) {
      // A store that passed its check and still failed as it was opened for
      // this box — a write refused, a page the check could not reach — is the
      // same fault, and it is not a reason to exit either.
      if (!isSqliteError(err)) throw err;
      current.stop();
      try {
        opened.close();
      } catch {
        /* already gone */
      }
      db = null;
      await needService(sqliteProblemOf(err), sqliteMessage(err));
      return;
    }
    condition = { state: 'running' };

    // The cloud. Each call is bounded by the transport's timeout and none of
    // them can stop the start (see `BoxAgent.start`).
    if (registered) await current.start();
    if (stopped) {
      current.stop();
      return;
    }
    running = current.state.registered;
    if (!running) {
      log.warn(
        { module: 'runner' },
        'this box has no credential yet: enter the claim code from Console → Devices on the television, or run "oto-box claim" and type the code at its prompt',
      );
      watchForCredential();
    }
  }

  /**
   * NEEDS SERVICE: the store cannot be used. The process stays up and says
   * so — the television, `/kiosk/health`, the log and the heartbeat — copies
   * the unsent outbox out of the file once, and tries the store again on a
   * slow timer. It never exits over it: an exit is a restart, and a restart
   * cannot mend a card.
   */
  async function needService(storeProblem: SqliteStoreProblem, detail: string): Promise<void> {
    const salvage = await salvageOutbox(paths, storeProblem, openDatabase, log).catch(
      (err: unknown): SalvageOutcome => ({
        rows: 0,
        file: null,
        error: sqliteMessage(err),
        complete: false,
        oldestQueuedAt: null,
      }),
    );
    fault = {
      store: storeProblem,
      detail,
      checks: 1,
      since: new Date().toISOString(),
      salvaged: salvage.rows,
      salvageComplete: salvage.complete,
      salvageFile: salvage.file,
      salvageError: salvage.error,
    };
    faultOldestQueuedAt = salvage.oldestQueuedAt;
    condition = {
      state: 'needs_service',
      store: storeProblem,
      salvaged: salvage.rows,
      salvageFile: salvage.file,
      salvageError: salvage.error,
    };
    log.error(
      { module: 'runner', store: storeProblem, file: paths.database, detail },
      storeProblem === 'damaged'
        ? 'the box store is damaged: the booth needs service, and the television says so'
        : 'the box store could not be read: the booth needs service, and the television says so',
    );
    if (salvage.rows > 0) {
      log.warn(
        {
          module: 'runner',
          rows: salvage.rows,
          complete: salvage.complete,
          file: salvage.file,
          error: salvage.error,
        },
        `${salvage.rows} unsent record(s) were copied out of the store${
          salvage.file ? ` into ${salvage.file}` : ''
        }${salvage.complete ? '' : ' — the read stopped at damage, and the store may hold more'}; nothing was moved or deleted`,
      );
    } else if (salvage.complete) {
      log.info(
        { module: 'runner', rows: 0, complete: true },
        'the store holds no unsent record; nothing was moved or deleted',
      );
    } else {
      log.warn(
        { module: 'runner', rows: 0, complete: false, error: salvage.error },
        'no unsent record could be read out of the store; nothing was moved or deleted',
      );
    }
    log.error(
      { module: 'runner' },
      'to bring the booth back: make a new box in Console → Devices → Add a box, then run "sudo oto-box claim --force" and type its claim code at the prompt (PI_BOOTH.md section 7, "A damaged store"); the store is tried again every minute meanwhile',
    );
    log.info(
      { module: 'runner' },
      "the Console's commands for this box wait on the platform while it needs service, and run once it runs on its store again",
    );

    const reporter = buildAgent(null);
    agent = reporter;
    try {
      if (await reporter.prepare()) await reporter.start();
    } catch (err) {
      log.error({ module: 'runner', err: String(err) }, 'the box could not report its store to the cloud');
    }
    if (stopped) {
      reporter.stop();
      return;
    }
    retryTimer = setInterval(() => {
      void retryStore().catch((err: unknown) => {
        log.error({ module: 'runner', err: String(err) }, 'the store could not be tried again');
      });
    }, options.storeRetryMs ?? 60_000);
    retryTimer.unref?.();
  }

  /** The slow timer: the card may have recovered, or a claim may have made a new store. */
  async function retryStore(): Promise<void> {
    if (stopped || !fault || retrying) return;
    retrying = true;
    try {
      // Not while a claim is making the store: the next try, once it is done.
      if (await claimUnderWay(paths)) {
        log.info({ module: 'runner' }, 'a claim is being made on this box; the store is tried again after it');
        return;
      }
      const opened = await openStore();
      if (opened.ok && (await claimUnderWay(paths))) {
        // A claim began while the store was being looked at.
        opened.db.close();
        return;
      }
      if (!opened.ok) {
        fault.checks += 1;
        fault.store = opened.problem;
        fault.detail = opened.detail;
        if (condition.state === 'needs_service') condition = { ...condition, store: opened.problem };
        log.warn(
          { module: 'runner', store: opened.problem, detail: opened.detail, checks: fault.checks },
          'the box store still cannot be used; the booth still needs service',
        );
        return;
      }
      if (stopped) {
        opened.db.close();
        return;
      }
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = null;
      agent?.stop();
      log.info(
        { module: 'runner', file: paths.database, after: fault.checks },
        'the box store can be used again: the booth starts',
      );
      fault = null;
      faultOldestQueuedAt = null;
      condition = { state: 'starting' };
      try {
        await runBox(opened.db);
      } catch (err) {
        // Not the store (`runBox` turns that back into NEEDS SERVICE): a box
        // that cannot start on a store it can read is one a fresh process
        // opens cleanly, which is what systemd gives it.
        log.error(
          { module: 'runner', err: String(err) },
          'the box could not start on the store it can read again; restarting',
        );
        options.onRestartNeeded?.();
      }
    } finally {
      retrying = false;
    }
  }

  /** Everything this runner started, stopped, and the kiosk closed. */
  async function shutDown(): Promise<void> {
    stopped = true;
    if (credentialWatch) clearInterval(credentialWatch);
    credentialWatch = null;
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
    agent?.stop();
    if (options.listen !== false) await kiosk.close();
    if (bridgeServer && options.listen !== false) await bridgeServer.close();
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  }

  try {
    // A claim under way in a terminal is making the store and the credential
    // this box is about to open: wait for it, for a while — the television
    // says "Starting the box…" meanwhile — then open what is there.
    const waitUntil = Date.now() + CLAIM_WAIT_MS;
    if (await claimUnderWay(paths)) {
      log.info({ module: 'runner' }, 'a claim is being made on this box; waiting for it before opening the store');
      while (!stopped && Date.now() < waitUntil && (await claimUnderWay(paths))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const opened = await openStore();
    if (opened.ok) await runBox(opened.db);
    else await needService(opened.problem, opened.detail);
  } catch (err) {
    // Not the store — that is NEEDS SERVICE, above — but something the box
    // cannot start without. The kiosk is closed with the rest, so the process
    // can end and systemd start a fresh one, as it did before the kiosk
    // listened first; left open, it would hold the process up saying
    // "Starting the box…" for good.
    await shutDown();
    throw err;
  }

  return {
    get agent(): BoxAgent {
      // Never null once `startRunner` has returned: `runBox` or `needService` set it.
      return agent!;
    },
    kiosk,
    port,
    paths,
    get storeFault(): StoreFault | null {
      return fault ? { ...fault } : null;
    },
    stop: shutDown,
  };
}

// --- oto-box claim ----------------------------------------------------------

export interface ClaimOptions {
  home: string;
  apiBaseUrl: string;
  code: string;
  hostname?: string;
  fetch?: AgentFetch;
  log?: AgentLog;
  openDatabase?: OpenDatabase;
  /** Set aside an existing identity and claim again. */
  force?: boolean;
}

/**
 * `oto-box claim`: register this box with a claim code from the Console
 * (typed at the command's prompt), write the credential file, and stop.
 *
 * Refuses a box that already has an identity unless told to replace it, and
 * then sets the old credential and store ASIDE rather than deleting them — a
 * box claimed over by mistake can be put back by an engineer, where one whose
 * files were deleted cannot.
 *
 * A store that cannot be used is set aside the same way with `--force`, even
 * on a box with no identity to replace (SCRUM-403): it is the step the
 * television's "needs service" notice names, and it has to work on every box
 * that shows it.
 */
export async function claimBox(options: ClaimOptions): Promise<{ boxId: string }> {
  const log = options.log ?? silentLog;
  const paths = runnerPaths(options.home);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const credentials = fileCredentialStore(paths.credential);
  const existing = await credentials.read();
  if (existing && !options.force) {
    throw new RunnerError(
      `This box is already registered (box ${existing.boxId}). To give it a new identity, run the claim again with --force.`,
    );
  }
  // Held for as long as this claim runs, so a running box that needs service
  // does not open the store half made (`CLAIM_LOCK_FILE`). Best effort: a card
  // that refuses this small write must not stop the claim that mends it.
  const lock = claimLockPath(paths);
  await writeJsonAtomic(lock, { pid: process.pid, startedAt: new Date().toISOString() }, 0o600).catch(
    (err: unknown) => {
      log.warn({ module: 'runner', err: String(err) }, 'the claim could not mark itself as under way');
    },
  );
  try {
    return await claimHeld(options, paths, credentials, existing, log);
  } finally {
    await rm(lock, { force: true }).catch(() => {});
  }
}

/** `claimBox`, once it holds the claim lock. */
async function claimHeld(
  options: ClaimOptions,
  paths: RunnerPaths,
  credentials: CredentialStore,
  existing: BoxCredential | null,
  log: AgentLog,
): Promise<{ boxId: string }> {
  const openDatabase = options.openDatabase ?? openNodeSqlite;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const storeFiles = [paths.database, `${paths.database}-wal`, `${paths.database}-shm`];
  if (existing) {
    for (const file of [paths.credential, ...storeFiles]) {
      await rename(file, `${file}.replaced-${stamp}`).catch(() => {});
    }
    await rm(paths.configBundle, { force: true });
    log.warn({ module: 'runner', previous: existing.boxId }, 'the previous identity was set aside');
  }
  const verdict = await inspectStoreFile(paths.database, openDatabase);
  if (!verdict.ok) {
    const said = verdict.problem === 'damaged' ? 'is damaged' : 'could not be read';
    if (!options.force) {
      throw new RunnerError(
        `The store at ${paths.database} ${said} (${verdict.detail}). Run the claim again with --force: it is set aside, not deleted, and a new one is made.`,
      );
    }
    for (const file of storeFiles) {
      await rename(file, `${file}.replaced-${stamp}`).catch(() => {});
    }
    if (await stat(paths.database).then(() => true, () => false)) {
      throw new RunnerError(`The store at ${paths.database} ${said} and could not be set aside.`);
    }
    log.warn(
      { module: 'runner', store: verdict.problem, detail: verdict.detail },
      'a store that could not be used was set aside; a new one is made',
    );
  }

  const apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
  const db = await openDatabase(paths.database);
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const agent = createBoxAgent({
    apiBaseUrl,
    credentials,
    claimCode: async () => options.code,
    hostname: options.hostname ?? osHostname(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    log,
    store,
    /**
     * The SAME box again, onto a store that keeps no journal for it
     * (SCRUM-403)? Then the registration names the epoch the set-aside store
     * sealed under, and a journal restarted there would seal at addresses the
     * cloud already holds. Named before the registration, so the row it makes
     * waits for a new epoch in the same transaction that makes it — never a
     * row that says otherwise for a moment a power cut could keep.
     *
     * Named for every identity this claim replaces, and not only when the
     * store file was absent a moment ago: the running box can make an empty
     * store where the old one was set aside — its store tried again, or a
     * start whose look for a claim under way came a moment before this claim
     * marked itself — and that store is just as new. The hold applies only
     * where the store keeps no row for the box registered
     * (`takeRegisteredEpoch`), so an old store that stayed where it was goes
     * on with its own journal, and a new box — another id — is never held.
     */
    journalHoldFor: existing ? existing.boxId : null,
    // Registration only: nothing to print, draw or charge on the way.
    printing: { enabled: false },
    terminal: { enabled: false },
    booth: { enabled: false },
  });
  try {
    let registered: boolean;
    try {
      registered = await agent.ensureRegistered();
    } catch (err) {
      // The new store's first rows are written in the registration's own
      // transaction (NO NEW FACT BEFORE A FRESH EPOCH), and read back as the
      // store is attached: a card that refuses either is the card's fault,
      // not the api's.
      if (isSqliteError(err)) {
        throw new RunnerError(
          `The box registered, but its new store at ${paths.database} could not be written or read (${sqliteMessage(err)}): the memory card may be failing. See PI_BOOTH.md section 7, "A damaged store".`,
        );
      }
      const refused = err instanceof Error && err.message.startsWith('box registration failed');
      throw new RunnerError(
        refused
          ? 'The claim code was refused: it is wrong, used or older than its expiry. Ask for a new one in Console → Devices.'
          : `The api did not answer at ${apiBaseUrl}: check the internet and the address.`,
      );
    }
    if (!registered || !agent.state.boxId) {
      throw new RunnerError('The box did not register; nothing was written.');
    }
    if (agent.state.journalAwaitingEpoch) {
      // The same box again: its store waits for a new epoch (NO NEW FACT
      // BEFORE A FRESH EPOCH, in `agent.ts`), which Reset the store mints.
      log.warn(
        { module: 'runner', boxId: agent.state.boxId },
        'this claim registered the same box again onto a new store: it records nothing until Console → Devices → the box → Reset the store gives it a new journal epoch',
      );
    }
    await writeRunnerState(paths, { apiBaseUrl, stationId: null });
    return { boxId: agent.state.boxId };
  } finally {
    agent.stop();
    db.close();
  }
}
