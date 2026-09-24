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
 */

import { hostname as osHostname } from 'node:os';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createBoxAgent, type BoxAgent, type BoxConfigCache } from '../agent';
import type { Booth } from '../booth';
import { createBoothHttp } from '../booth-http';
import { fileCredentialStore } from '../credentials';
import type { BoxConfigBundle } from '../protocol';
import { SqlBoxStore } from '../store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver, type SqliteDatabaseLike } from '../store-sqlite';
import { httpTransport, silentLog, type AgentFetch, type AgentLog } from '../transport';
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
  type KioskServer,
  type KioskState,
} from './kiosk-server';
import { applyPrinterOverride } from './printer-override';

/** A failure the person running the box can act on, worded for them. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

export type OpenDatabase = (file: string) => Promise<SqliteDatabaseLike> | SqliteDatabaseLike;

/**
 * `node:sqlite`, opened lazily.
 *
 * Lazily so the import's one-line "experimental" warning can be kept out of
 * the box's journal: SQLite in Node 22 works and is what the store is tested
 * on, and a warning on every boot is noise somebody reading the journal for a
 * real fault has to step over.
 */
export const openNodeSqlite: OpenDatabase = async (file) => {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(file) as unknown as SqliteDatabaseLike;
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
  /** Off for a test that drives the handler without a socket. */
  listen?: boolean;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  syncIntervalMs?: number;
  cacheRefreshIntervalMs?: number;
  /** How long a slip waits before the printer is tried again (30 s unless a test says). */
  printRetryDelayMs?: number;
}

export interface RunningBox {
  agent: BoxAgent;
  kiosk: KioskServer;
  /** Where the kiosk is listening; the configured port when `listen` is off. */
  port: number;
  paths: RunnerPaths;
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

  const db = await (options.openDatabase ?? openNodeSqlite)(paths.database);
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });

  const verifySecret =
    options.verifySecret === undefined ? await loadArgon2Verifier(log) : options.verifySecret;

  let selected = state.stationId;
  let pendingClaim: string | null = null;
  const reportedWithoutPrinter = new Set<string>();

  const agent = createBoxAgent({
    apiBaseUrl,
    credentials: fileCredentialStore(paths.credential),
    // Only ever a code a person typed on the kiosk's first-run screen, and
    // only for as long as that one registration takes.
    claimCode: async () => pendingClaim,
    hostname: options.hostname ?? overrides.hostname ?? osHostname(),
    fetch:
      options.fetch ??
      httpTransport(
        options.cloudTimeoutMs === undefined ? {} : { answerTimeoutMs: options.cloudTimeoutMs },
      ),
    log,
    store,
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
    printing: {
      durable: true,
      ...(options.printRetryDelayMs !== undefined ? { retryDelayMs: options.printRetryDelayMs } : {}),
    },
    booth: {
      ...(verifySecret ? { verifySecret } : {}),
      stationId: () => selected,
    },
    ...(options.heartbeatIntervalMs ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.syncIntervalMs ? { syncIntervalMs: options.syncIntervalMs } : {}),
    ...(options.cacheRefreshIntervalMs
      ? { cacheRefreshIntervalMs: options.cacheRefreshIntervalMs }
      : {}),
  });

  /** Whether `start` got past registration and set the agent's timers going. */
  let running = false;
  /** See the watch set up below, once the kiosk is listening. */
  let credentialWatch: ReturnType<typeof setInterval> | null = null;
  // A claim typed on the television writes the same file from inside this
  // process; that one is not a reason to restart.
  let claimingHere = false;

  const online = (): boolean => !agent.state.offline && agent.state.linkUp;
  const handlers = new WeakMap<Booth, BoothHandler>();

  function boothStations(): KioskBoothSummary[] {
    return (agent.config()?.stations ?? [])
      .filter((station) => station.kind === 'booth')
      .map((station) => ({
        stationId: station.id,
        name: station.name,
        codePrefix: station.codePrefix,
      }));
  }

  function boothHandler(): BoothHandler | null {
    if (!agent.state.registered) return null;
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
      registered: agent.state.registered,
      online: online(),
      booths,
      selectedStationId: booths.length === 1 ? booths[0]!.stationId : chosen,
      agentVersion: agent.version,
    };
  }

  async function claim(code: string): Promise<KioskClaimOutcome> {
    if (agent.state.registered) return { ok: false, reason: 'already_registered' };
    const previousBox = agent.state.boxId;
    pendingClaim = code;
    claimingHere = true;
    try {
      const registered = await agent.ensureRegistered();
      if (!registered) return { ok: false, reason: 'refused' };
    } catch (err) {
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
    log.info({ module: 'runner', boxId: agent.state.boxId }, 'this box was claimed from the kiosk');
    if (previousBox && previousBox !== agent.state.boxId) {
      // The store on disk is the old box's. A fresh process opens it for the
      // new identity rather than this one writing one box's facts as another.
      log.warn({ module: 'runner' }, 'a new box identity needs a restart; restarting');
      options.onRestartNeeded?.();
      return { ok: true };
    }
    if (!running) {
      await agent.start();
      running = true;
    }
    return { ok: true };
  }

  async function selectBooth(stationId: string): Promise<boolean> {
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
   * The order of a boot, and why (SCRUM-223): the box's own half, then the
   * television, then the cloud.
   *
   * `prepare` needs nothing from the cloud — the credential file, the store,
   * the copy of the config, the booth on the wheel it holds — and after it the
   * kiosk has everything it serves. So the kiosk listens before `start` asks
   * the cloud for anything. The other way round, a cloud that took the
   * connection and never answered kept the television dark for as long as
   * `start` waited — measured at over seven minutes — and the watchdog, which
   * asks this server for `/kiosk/health`, restarted the box into the same wait
   * for as long as the stall lasted.
   */
  const registered = await agent.prepare();

  const kiosk = createKioskServer({
    port: options.port ?? KIOSK_DEFAULT_PORT,
    host: '127.0.0.1',
    pageDir: options.pageDir ?? null,
    booth: boothHandler,
    state: kioskState,
    claim,
    selectBooth,
    log,
  });
  let port = options.port ?? KIOSK_DEFAULT_PORT;
  if (options.listen !== false) {
    const address = await kiosk.listen();
    port = address.port;
    log.info({ module: 'runner', port }, `the booth page is served at http://127.0.0.1:${port}/`);
  }

  // The cloud. Each call is bounded by the transport's timeout and none of
  // them can stop the start (see `BoxAgent.start`).
  if (registered) await agent.start();
  running = agent.state.registered;
  if (!running) {
    log.warn(
      { module: 'runner' },
      'this box has no credential yet: enter the claim code from Console → Devices on the television, or run "oto-box claim <code>"',
    );
  }

  /**
   * `oto-box claim` in a terminal while the service is already up and showing
   * the claim screen writes the credential under this process's feet. Without
   * this the television would go on asking for a code that had already been
   * used, until somebody thought to restart the service. The file appearing is
   * the signal; a fresh process (systemd restarts it) opens it cleanly.
   */
  if (!running) {
    const credentials = fileCredentialStore(paths.credential);
    credentialWatch = setInterval(() => {
      if (agent.state.registered) {
        if (credentialWatch) clearInterval(credentialWatch);
        credentialWatch = null;
        return;
      }
      if (claimingHere) return;
      void credentials
        .read()
        .then((held) => {
          if (!held || claimingHere || agent.state.registered || !credentialWatch) return;
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

  return {
    agent,
    kiosk,
    port,
    paths,
    async stop() {
      if (credentialWatch) clearInterval(credentialWatch);
      credentialWatch = null;
      agent.stop();
      if (options.listen !== false) await kiosk.close();
      db.close();
    },
  };
}

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
 * `oto-box claim <code>`: register this box with a claim code from the
 * Console, write the credential file, and stop.
 *
 * Refuses a box that already has an identity unless told to replace it, and
 * then sets the old credential and store ASIDE rather than deleting them — a
 * box claimed over by mistake can be put back by an engineer, where one whose
 * files were deleted cannot.
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
  if (existing) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const file of [
      paths.credential,
      paths.database,
      `${paths.database}-wal`,
      `${paths.database}-shm`,
    ]) {
      await rename(file, `${file}.replaced-${stamp}`).catch(() => {});
    }
    await rm(paths.configBundle, { force: true });
    log.warn({ module: 'runner', previous: existing.boxId }, 'the previous identity was set aside');
  }

  const apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
  const db = await (options.openDatabase ?? openNodeSqlite)(paths.database);
  prepareSqliteBoxStore(db);
  const agent = createBoxAgent({
    apiBaseUrl,
    credentials,
    claimCode: async () => options.code,
    hostname: options.hostname ?? osHostname(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    log,
    store: new SqlBoxStore({ driver: sqliteBoxDriver(db) }),
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
    await writeRunnerState(paths, { apiBaseUrl, stationId: null });
    return { boxId: agent.state.boxId };
  } finally {
    agent.stop();
    db.close();
  }
}
