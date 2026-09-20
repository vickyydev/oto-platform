import type { CredentialStore } from './credentials';
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
}

export interface BoxAgentState {
  boxId: string | null;
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
}

export interface BoxAgent {
  readonly version: string;
  readonly state: BoxAgentState;
  /** Register if the store has no credential; a no-op afterwards. */
  ensureRegistered(): Promise<boolean>;
  /** Pull the bundle and adopt it. Returns true when it changed. */
  syncConfig(): Promise<boolean>;
  heartbeat(): Promise<BoxHeartbeatAck | null>;
  /** Poll, run what comes back, report each result. Returns how many ran. */
  runPendingCommands(): Promise<number>;
  /** Register, sync, heartbeat, poll — then set both timers going. */
  start(): Promise<void>;
  stop(): void;
  /** The Console's "Stop heartbeats" test control. */
  pauseHeartbeats(paused: boolean): void;
  /** The Console's "Advance box clock": a deliberate skew, in milliseconds. */
  advanceClock(ms: number): void;
  /** Recent agent log lines, which is what `collect_logs` hands back. */
  recentLogs(limit?: number): string[];
  config(): BoxConfigBundle | null;
}

/** Kept small: it is read by `collect_logs` and it lives in a Pi's memory. */
const LOG_RING = 500;

export function createBoxAgent(options: BoxAgentOptions): BoxAgent {
  const base = options.apiBaseUrl.replace(/\/$/, '');
  const call = options.fetch ?? httpTransport();
  const log = options.log ?? silentLog;
  const startedAt = Date.now();

  let credential: string | null = null;
  let bundle: BoxConfigBundle | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  /**
   * Strictly increasing, because the cloud refuses a heartbeat whose reported
   * time is not after the last one it accepted — that refusal is its replay
   * defence, and a box whose clock steps backwards under NTP would otherwise
   * silence itself until the clock caught up.
   */
  let lastReportedAt = 0;

  const ring: string[] = [];
  const state: BoxAgentState = {
    boxId: null,
    registered: false,
    configVersion: null,
    epoch: 1,
    offline: false,
    heartbeatsPaused: false,
    clockSkewMs: 0,
    lastHeartbeatAt: null,
    lastAckAt: null,
    commandsRun: 0,
  };

  const clock = (): number => (options.now ? options.now() : Date.now()) + state.clockSkewMs;

  function note(level: 'info' | 'warn' | 'error', msg: string, obj: Record<string, unknown> = {}): void {
    ring.push(`${new Date(clock()).toISOString()} ${level} ${msg}`);
    if (ring.length > LOG_RING) ring.splice(0, ring.length - LOG_RING);
    log[level]({ ...obj, module: 'box-agent' }, msg);
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

  async function ensureRegistered(): Promise<boolean> {
    if (credential) return false;
    const held = await options.credentials.read();
    if (held) {
      credential = boxCredential(held.boxId, held.secret);
      state.boxId = held.boxId;
      state.registered = true;
      note('info', 'box credential loaded from the store', { boxId: held.boxId });
      return false;
    }
    const claimCode = options.claimCode ? await options.claimCode() : null;
    if (!claimCode) {
      note('warn', 'no credential and no claim code — this box cannot register yet');
      return false;
    }
    const { status, body } = await request<BoxRegisterResponse>('/box/v1/register', {
      method: 'POST',
      auth: false,
      body: { claimCode, agentVersion: BOX_AGENT_VERSION, hostname: options.hostname },
    });
    if (status !== 200 || !body) {
      note('error', 'registration refused', { status });
      throw new Error(`box registration failed with ${status}`);
    }
    // Written BEFORE anything else: the secret exists in exactly one place
    // until this line, and the cloud will never send it again.
    await options.credentials.write({ boxId: body.boxId, secret: body.secret });
    credential = boxCredential(body.boxId, body.secret);
    state.boxId = body.boxId;
    state.registered = true;
    state.epoch = body.epoch;
    heartbeatIntervalMs = options.heartbeatIntervalMs ?? body.heartbeatIntervalS * 1000;
    note('info', 'box registered', { boxId: body.boxId, slot: body.slot, epoch: body.epoch });
    return true;
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
    for (const device of devices) {
      // One device can serve two roles on one station; it is still one device.
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      const fault = options.faults?.[device.id] ?? options.faults?.[device.label];
      reports.push({
        id: device.id,
        address: device.address ?? undefined,
        kind: device.kind,
        model: device.model ?? undefined,
        reachability: fault?.reachability ?? 'reachable',
        paperStatus: fault?.paperStatus ?? (device.kind.endsWith('printer') ? 'ok' : 'unknown'),
        lastError: fault?.lastError,
      });
    }
    return reports;
  }

  async function syncConfig(): Promise<boolean> {
    if (!credential) return false;
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

  async function heartbeat(): Promise<BoxHeartbeatAck | null> {
    if (!credential || state.heartbeatsPaused) return null;
    const reportedMs = Math.max(clock(), lastReportedAt + 1);
    lastReportedAt = reportedMs;
    const payload: BoxHeartbeatRequest = {
      reportedAt: new Date(reportedMs).toISOString(),
      agentVersion: BOX_AGENT_VERSION,
      uptimeS: Math.floor((Date.now() - startedAt) / 1000),
      // Null, not zero: a virtual box has no thermometer, and zero reads as cold.
      tempC: null,
      outboxDepth: 0,
      configVersion: state.configVersion ?? undefined,
      offline: state.offline,
      devices: deviceReports(),
      leases: [],
      errors: [],
    };
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
    if (body.configVersion !== state.configVersion) {
      await syncConfig();
    }
    if (body.commandsPending > 0) {
      await runPendingCommands();
    }
    return body;
  }

  async function runPendingCommands(): Promise<number> {
    if (!credential) return 0;
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
        state.epoch = ack.epoch;
      } else {
        note('warn', 'command result was not accepted', { status: resultStatus, kind: command.kind });
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
        const role = typeof payload.role === 'string' ? payload.role : 'receipt';
        const stationId = typeof payload.stationId === 'string' ? payload.stationId : null;
        const station = stationId
          ? bundle?.stations.find((s) => s.id === stationId)
          : bundle?.stations[0];
        const device = station?.devices.find((d) => d.role === role);
        if (!station || !device) {
          return {
            state: 'failed',
            errorCode: 'NO_DEVICE_FOR_ROLE',
            errorMessage: `No ${role} device is assigned to ${station?.name ?? 'any station on this box'}`,
          };
        }
        // S2-06 replaces this with the real adapter; what it proves today is
        // the whole routed path — Console, cloud, box, back — which is the
        // part that cannot be tested once and forgotten.
        return {
          state: 'succeeded',
          result: {
            stationId: station.id,
            stationName: station.name,
            deviceId: device.id,
            deviceLabel: device.label,
            protocol: device.protocol,
            transport: device.transport,
            simulated: true,
          },
        };
      }
      case 'config_apply': {
        const changed = await syncConfig();
        return { state: 'succeeded', result: { configVersion: state.configVersion, changed } };
      }
      case 'clear_cache':
        // There is no cache to throw away before S2-05. Saying so is more use
        // than a success that implies work happened.
        return { state: 'succeeded', result: { entries: 0, note: 'no cache on this agent yet' } };
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
      case 'go_offline':
        state.offline = true;
        return { state: 'succeeded', result: { offline: true } };
      case 'go_online':
        state.offline = false;
        return { state: 'succeeded', result: { offline: false } };
      case 'reset_store': {
        // The local side of it: everything the box was holding goes. The new
        // epoch comes back on the acknowledgement, which is what makes a batch
        // replayed from the old store recognisably stale.
        bundle = null;
        state.configVersion = null;
        await syncConfig();
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

  async function start(): Promise<void> {
    await ensureRegistered();
    if (!credential) return;
    await syncConfig();
    await heartbeat();
    await runPendingCommands();
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch((err) => note('error', 'heartbeat tick failed', { err: String(err) }));
    }, heartbeatIntervalMs);
    pollTimer = setInterval(() => {
      void runPendingCommands().catch((err) =>
        note('error', 'command poll tick failed', { err: String(err) }),
      );
    }, pollIntervalMs);
    // A pending timer must never be the reason the process cannot exit.
    heartbeatTimer.unref?.();
    pollTimer.unref?.();
    note('info', 'box agent started', {
      boxId: state.boxId,
      heartbeatIntervalMs,
      pollIntervalMs,
    });
  }

  function stop(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    heartbeatTimer = null;
    pollTimer = null;
  }

  return {
    version: BOX_AGENT_VERSION,
    state,
    ensureRegistered,
    syncConfig,
    heartbeat,
    runPendingCommands,
    start,
    stop,
    pauseHeartbeats(paused) {
      state.heartbeatsPaused = paused;
      note('info', paused ? 'heartbeats stopped by a test control' : 'heartbeats resumed');
    },
    advanceClock(ms) {
      state.clockSkewMs += ms;
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
