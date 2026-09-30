/**
 * THE GATE BOX (S2-12 round 2; plan §2.4-2.5): the reader host, the
 * controller link, the decision and the journal, wired together for every
 * gate station in the box's bundle.
 *
 * Built by the agent ONLY when its bundle names a station of kind `gate`; a
 * till or booth box never constructs one. Everything it needs from the agent
 * comes in through `GateHostDeps`, so a test drives the whole path with a
 * scripted serial transport and a scripted reader call — no simulator, no
 * cloud.
 *
 * The path of one scan:
 *
 *   reader POST → match the reader to its lane → decide (decision.ts) →
 *   claim the side's one pending open (controller.ts) → open (opener.ts) →
 *   answer "1" — and later, the board's feedback on that side credits the
 *   passage, which commits anti-passback and journals entry / exit.
 *
 * Every refusal the box reaches about a band is journalled as a `denied`
 * band event; outcomes that name no band (a voucher at the reader, a beam
 * broken at rest, the gate held open) cannot be band events and are counted
 * into the heartbeat's fault reports instead.
 */

import type { QueuedFact } from '../store';
import type { SerialOpener, SerialTarget, TerminalTransport } from '../terminal/serial-channel';
import {
  directionFor,
  readGateStation,
  sideFor,
  type GateDirection,
  type GateStationConfig,
} from './config';
import {
  createGateController,
  creditingUnread,
  type ControllerOutcome,
  type CreditBlocker,
  type GateController,
  type GateFault,
} from './controller';
import {
  GATE_MESSAGES,
  commitPassage,
  decideGate,
  gateEventFact,
  type BandKind,
  type BandLookup,
  type GateDecision,
} from './decision';
import {
  WATCHED_SETTINGS,
  WATCHED_SETTING_KEYS,
  type GateSide,
  type WatchedSetting,
} from './ge-x2';
import { createGateLink, type GateLink } from './link';
import { createOpener, GateOpenerError, type GateOpener, type RelayDriver } from './opener';
import {
  createReaderHost,
  startReaderServer,
  type ReaderAnswer,
  type ReaderHost,
  type ReaderScan,
  type ReaderServer,
} from './reader-host';
import type { BoxConfigStation } from '../protocol';
import type { GateDenyReason } from '@oto/shared';

// --- The box's copy of the bands ------------------------------------------------

export interface BandCopy {
  lookup(bandId: string): BandLookup;
}

/**
 * The band copy from the two cached scopes: `bands` (active bands, with their
 * kind) and `deny_list` (revoked bands, named explicitly with their kind). The
 * deny list wins: a band on it is revoked whatever an older `bands` copy says.
 */
export function bandCopyFrom(
  bandItems: readonly unknown[],
  denyItems: readonly unknown[],
): BandCopy {
  const active = new Map<string, { kind: BandKind; status: string }>();
  for (const row of bandItems) {
    const r = row as { id?: unknown; kind?: unknown; status?: unknown };
    if (typeof r.id !== 'string') continue;
    if (r.kind !== 'kid' && r.kind !== 'adult') continue;
    active.set(r.id.toLowerCase(), {
      kind: r.kind,
      status: typeof r.status === 'string' ? r.status : 'active',
    });
  }
  const revoked = new Map<string, BandKind | null>();
  for (const item of denyItems) {
    const list = (item as { revokedBands?: unknown }).revokedBands;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { id?: unknown; kind?: unknown };
      if (typeof e.id !== 'string') continue;
      revoked.set(e.id.toLowerCase(), e.kind === 'kid' || e.kind === 'adult' ? e.kind : null);
    }
  }
  return {
    lookup(bandId) {
      const id = bandId.toLowerCase();
      if (revoked.has(id))
        return { state: 'revoked', kind: revoked.get(id) ?? active.get(id)?.kind ?? null };
      const row = active.get(id);
      if (!row) return { state: 'unknown' };
      if (row.status !== 'active') return { state: 'revoked', kind: row.kind };
      return { state: 'active', kind: row.kind };
    },
  };
}

// --- Passage state ------------------------------------------------------------------

/** Where the box keeps who is inside: one runtime value, pruned as it is written. */
export interface GateStateStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export const GATE_PASSAGES_KEY = 'gate.passages';
/** A band admits for one visit; state older than this is dropped (the `bands` scope's window). */
const PASSAGE_RETAIN_MS = 36 * 60 * 60 * 1000;

interface PassageState {
  bands: Record<string, { inside: boolean; at: number }>;
  count: number;
}

function parsePassages(raw: string | null): PassageState {
  if (!raw) return { bands: {}, count: 0 };
  try {
    const held = JSON.parse(raw) as Partial<PassageState>;
    return {
      bands: held.bands && typeof held.bands === 'object' ? held.bands : {},
      count: typeof held.count === 'number' && held.count >= 0 ? held.count : 0,
    };
  } catch {
    return { bands: {}, count: 0 };
  }
}

// --- The host -------------------------------------------------------------------------

export type GateNote = (
  level: 'info' | 'warn' | 'error',
  message: string,
  detail?: Record<string, unknown>,
) => void;

export interface GateHostDeps {
  boxId: string;
  stations: readonly BoxConfigStation[];
  /** The box's corrected clock, for the stamps facts carry. */
  now: () => number;
  /** Real time, for deadlines on the wire. Defaults to `Date.now`. */
  realNow?: () => number;
  bandKey: () => string | Uint8Array | null;
  /** The cached `bands` and `deny_list` items. */
  readCopy: () => Promise<{ bands: readonly unknown[]; deny: readonly unknown[] }>;
  /** Whether the platform can be asked right now. */
  isOnline: () => boolean;
  /** Pull the `bands` scope now. True when it landed. */
  refreshBands?: () => Promise<boolean>;
  journal: (fact: QueuedFact) => Promise<unknown>;
  state: GateStateStore;
  mintId: () => string;
  openSerial?: SerialOpener | null;
  relayDriver?: RelayDriver | null;
  /** Serve the reader's calls on this port; omitted, nothing listens (the virtual box). */
  listen?: { port: number; host?: string } | null;
  note?: GateNote;
  /** How often the board's door and infrared state are asked. */
  pollIntervalMs?: number;
  /** How long a scan may wait for a band refresh before answering on what is held. */
  refreshBudgetMs?: number;
  readerOfflineAfterMs?: number;
  replyTimeoutMs?: number;
}

export interface GateDeviceHealth {
  reachability: 'unknown' | 'reachable' | 'unreachable';
  lastError?: string;
}

interface Lane {
  config: GateStationConfig;
  controller: GateController;
  link: GateLink | null;
  linkError: string | null;
  opener: GateOpener;
  openerError: string | null;
  /**
   * The board answered after a silence: it booted late or came back, and the
   * settings are read again on the next tick, on real values.
   */
  settingsStale: boolean;
  /** Real time the watched settings were last asked for; 0 before the first read. */
  settingsReadAt: number;
}

export interface GateHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The reader contract, for a host that serves it itself (and for tests). */
  reader(): ReaderHost;
  /** Decide one scan as the reader would have sent it. */
  scan(scan: ReaderScan): Promise<ReaderAnswer>;
  /** Run the timers' work once: expire opens, poll the boards. */
  tick(): Promise<void>;
  /** Per device id, what the heartbeat should say. */
  deviceHealth(): Record<string, GateDeviceHealth>;
  /** Fingerprinted faults and counters for the heartbeat's `errors`. */
  errorReports(): Array<{ fingerprint: string; code: string; count: number }>;
  faults(stationId: string): GateFault[];
  /** The box's own count of adults inside. */
  occupancy(): Promise<number>;
  /** A stable signature of the config this host runs, to notice a change. */
  readonly signature: string;
  readonly server: ReaderServer | null;
}

export const GATE_POLL_INTERVAL_MS = 2_000;
/**
 * Where a gate box serves the reader's calls on the gate's LAN. The reader is
 * pointed at `http://<box>:8790` at installation; whether the reader speaks
 * plain HTTP or needs TLS is still open (OD-A15).
 */
export const GATE_READER_DEFAULT_PORT = 8790;
export const GATE_REFRESH_BUDGET_MS = 1_500;
/**
 * A crediting setting (L-9, L-34) a board that answers has still not
 * answered — one reply lost to line noise at startup — is asked again, no
 * more often than this. A board that comes back after a silence is re-read
 * at once instead (see `settingsStale`).
 */
export const GATE_SETTINGS_RETRY_MS = 30_000;

export function gateSignature(stations: readonly BoxConfigStation[]): string {
  return JSON.stringify(stations.map((s) => ({ id: s.id, v: s.configVersion, d: s.devices })));
}

export function createGateHost(deps: GateHostDeps): GateHost {
  const note: GateNote = deps.note ?? (() => {});
  const realNow = deps.realNow ?? Date.now;
  const lanes = new Map<string, Lane>();
  const counters = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let server: ReaderServer | null = null;
  let polling = false;
  let stateChain: Promise<unknown> = Promise.resolve();

  function count(code: string): void {
    counters.set(code, (counters.get(code) ?? 0) + 1);
  }

  for (const station of deps.stations) {
    const config = readGateStation(station);
    const lane: Lane = {
      config,
      controller: createGateController({ now: realNow, mintId: deps.mintId }),
      link: null,
      linkError: null,
      opener: createOpener(config.opener, {
        wiring: config.relay,
        relay: deps.relayDriver ?? null,
        link: () => lane.link,
      }),
      openerError: null,
      settingsStale: false,
      settingsReadAt: 0,
    };
    lanes.set(station.id, lane);
    for (const p of config.problems) note('warn', `gate ${config.stationName}: ${p}`);
  }

  const reader = createReaderHost({
    onScan: (s) => scan(s),
    now: realNow,
    ...(deps.readerOfflineAfterMs ? { offlineAfterMs: deps.readerOfflineAfterMs } : {}),
    failMessage: GATE_MESSAGES.GATE_NOT_READY,
  });
  for (const lane of lanes.values()) {
    for (const r of lane.config.readers) {
      if (r.direction) reader.expect(r.serial, r.direction);
      else {
        reader.expect(r.serial, 'entry');
        reader.expect(r.serial, 'exit');
      }
    }
  }

  function laneFor(serial: string, direction: GateDirection): Lane | null {
    for (const lane of lanes.values()) {
      if (
        lane.config.readers.some(
          (r) => r.serial === serial && (r.direction === null || r.direction === direction),
        )
      ) {
        return lane;
      }
    }
    return null;
  }

  /** Read-modify-write of the passage state, one at a time. */
  function withPassages<T>(fn: (state: PassageState) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const state = parsePassages(await deps.state.read(GATE_PASSAGES_KEY));
      const result = fn(state);
      const cutoff = deps.now() - PASSAGE_RETAIN_MS;
      for (const [id, entry] of Object.entries(state.bands)) {
        if (entry.at < cutoff) delete state.bands[id];
      }
      await deps.state.write(GATE_PASSAGES_KEY, JSON.stringify(state));
      return result;
    };
    const next = stateChain.then(run, run);
    stateChain = next.catch(() => null);
    return next;
  }

  async function readPassages(): Promise<PassageState> {
    await stateChain.catch(() => null);
    return parsePassages(await deps.state.read(GATE_PASSAGES_KEY));
  }

  async function journal(fact: QueuedFact): Promise<void> {
    try {
      await deps.journal(fact);
    } catch (err) {
      // The gate has already answered the guest; a journal that cannot be
      // written is the box's fault to report, never a reason to un-answer.
      count('journal_failed');
      note('error', 'a gate event could not be queued', { err: String(err), type: fact.type });
    }
  }

  function stamp(): string {
    return new Date(deps.now()).toISOString();
  }

  async function journalDenied(
    lane: Lane,
    decision: Extract<GateDecision, { open: false }>,
    direction: GateDirection,
    offline: boolean,
  ): Promise<void> {
    if (!decision.bandId) {
      count(`denied.${decision.reason}`);
      return;
    }
    await journal(
      gateEventFact({
        eventId: deps.mintId(),
        bandId: decision.bandId,
        kind: 'denied',
        direction,
        side: sideFor(direction, lane.config.entrySide),
        stationId: lane.config.stationId,
        occurredAt: stamp(),
        reason: decision.reason,
        offline,
      }),
    );
  }

  function denial(
    reason: GateDenyReason,
    bandId: string | null,
  ): Extract<GateDecision, { open: false }> {
    return { open: false, reason, bandId, message: GATE_MESSAGES[reason] };
  }

  async function decide(
    code: string,
    direction: GateDirection,
    online: boolean,
  ): Promise<GateDecision> {
    const held = await deps.readCopy().catch(() => ({ bands: [], deny: [] }));
    const passages = await readPassages();
    const inside = (id: string): boolean => passages.bands[id.toLowerCase()]?.inside === true;
    const first = decideGate({
      code,
      direction,
      key: deps.bandKey(),
      lookup: bandCopyFrom(held.bands, held.deny).lookup,
      inside,
      unknownMeans: 'offline',
    });
    // OD-A5: online, an unknown band is asked of the platform before anyone
    // is sent to reception — by pulling the band copy, bounded so the reader
    // is answered in time.
    if (first.open || first.reason !== 'BAND_UNKNOWN_OFFLINE' || !online || !deps.refreshBands)
      return first;
    let budget: ReturnType<typeof setTimeout> | undefined;
    const refreshed = await Promise.race([
      deps.refreshBands().catch(() => false),
      new Promise<false>((resolve) => {
        budget = setTimeout(() => resolve(false), deps.refreshBudgetMs ?? GATE_REFRESH_BUDGET_MS);
      }),
    ]);
    clearTimeout(budget);
    if (!refreshed) return first;
    const again = await deps.readCopy().catch(() => held);
    return decideGate({
      code,
      direction,
      key: deps.bandKey(),
      lookup: bandCopyFrom(again.bands, again.deny).lookup,
      inside,
      unknownMeans: 'not_found',
    });
  }

  /**
   * Why this lane cannot report a passage right now, or null when it can: a
   * controller line that is open, and a board that answers, whose L-9 and
   * L-34 were READ and are sound, and whose opens do end in a report
   * (`controller.creditBlocker`). Unread is not sound: a board that was still
   * booting at the startup read is refused until it is read again.
   */
  function creditBlocker(lane: Lane): 'no_link' | CreditBlocker | null {
    if (!lane.link) return 'no_link';
    return lane.controller.creditBlocker();
  }

  async function pendingElsewhere(self: Lane, bandId: string): Promise<boolean> {
    const id = bandId.toLowerCase();
    for (const other of lanes.values()) {
      if (other === self) continue;
      // Expire first so a stale open elsewhere cannot hold the band forever.
      const expired = other.controller.expire();
      if (expired.length) await settle(other, expired);
      for (const side of ['left', 'right'] as const) {
        if (other.controller.pending(side)?.bandId.toLowerCase() === id) return true;
      }
    }
    return false;
  }

  async function scan(s: ReaderScan): Promise<ReaderAnswer> {
    const lane = laneFor(s.serial, s.direction);
    if (!lane) {
      count('reader_unknown');
      note('warn', 'a reader this box has no gate for called in', {
        serial: s.serial,
        direction: s.direction,
      });
      return { code: '0', message: GATE_MESSAGES.GATE_NOT_READY };
    }
    const online = deps.isOnline();
    const decision = await decide(s.code, s.direction, online);
    if (!decision.open) {
      await journalDenied(lane, decision, s.direction, !online);
      return { code: '0', message: decision.message };
    }
    const side = sideFor(s.direction, lane.config.entrySide);
    const ready = lane.opener.ready();
    if (!ready.ok) {
      lane.openerError = ready.reason;
      await journalDenied(lane, denial('GATE_NOT_READY', decision.bandId), s.direction, !online);
      return { code: '0', message: GATE_MESSAGES.GATE_NOT_READY };
    }
    // Anti-passback is committed ONLY from the board's §2 passage report. An
    // entry opened on a lane that cannot report one would expire as a timeout
    // and let the same band in again a window later, so an entry waits for a
    // lane that can credit it. Exits stay open whatever the board says (OD-A4).
    if (s.direction === 'entry') {
      const why = creditBlocker(lane);
      if (why) {
        count(`entry_uncreditable.${why}`);
        note('warn', 'an entry was refused: the gate cannot report its passage', {
          station: lane.config.stationId,
          why,
        });
        await journalDenied(lane, denial('GATE_NOT_READY', decision.bandId), s.direction, !online);
        return { code: '0', message: GATE_MESSAGES.GATE_NOT_READY };
      }
    }
    // One band, one open in flight, box-wide: a second lane must not admit a
    // band whose first open has not yet been credited or expired.
    if (await pendingElsewhere(lane, decision.bandId)) {
      await journalDenied(lane, denial('GATE_BUSY', decision.bandId), s.direction, !online);
      return { code: '0', message: GATE_MESSAGES.GATE_BUSY };
    }
    const claim = lane.controller.claim({
      side,
      direction: s.direction,
      bandId: decision.bandId,
      offline: !online,
      revoked: decision.revoked,
    });
    // Opens the claim found past their window: journal their timeouts now.
    if (claim.expired.length) await settle(lane, claim.expired);
    if (!claim.ok) {
      await journalDenied(lane, denial(claim.reason, decision.bandId), s.direction, !online);
      return { code: '0', message: GATE_MESSAGES[claim.reason] };
    }
    try {
      await lane.opener.open(side);
      lane.openerError = null;
    } catch (err) {
      lane.controller.release(claim.pending.id);
      lane.openerError = err instanceof GateOpenerError ? err.message : String(err);
      note('error', 'the gate could not be opened', {
        station: lane.config.stationId,
        err: lane.openerError,
      });
      await journalDenied(lane, denial('GATE_NOT_READY', decision.bandId), s.direction, !online);
      return { code: '0', message: GATE_MESSAGES.GATE_NOT_READY };
    }
    return { code: '1', message: decision.message };
  }

  async function settle(lane: Lane, outcomes: ControllerOutcome[]): Promise<void> {
    for (const o of outcomes) {
      const stationId = lane.config.stationId;
      switch (o.type) {
        case 'passed': {
          const p = o.pending;
          const commit = await withPassages((state) => {
            const key = p.bandId.toLowerCase();
            const result = commitPassage(
              state.bands[key]?.inside === true,
              p.direction,
              state.count,
            );
            state.bands[key] = { inside: result.inside, at: deps.now() };
            state.count = result.count;
            return result;
          });
          await journal(
            gateEventFact({
              eventId: deps.mintId(),
              bandId: p.bandId,
              kind: p.direction,
              direction: p.direction,
              side: p.side,
              stationId,
              occurredAt: stamp(),
              exitWithoutEntry: commit.exitWithoutEntry,
              revoked: p.revoked,
              offline: p.offline,
            }),
          );
          break;
        }
        case 'timeout':
          await journal(
            gateEventFact({
              eventId: deps.mintId(),
              bandId: o.pending.bandId,
              kind: 'timeout',
              direction: o.pending.direction,
              side: o.pending.side,
              stationId,
              occurredAt: stamp(),
              inferred: o.inferred,
              personInLane: o.personInLane,
              offline: o.pending.offline,
            }),
          );
          break;
        case 'alarm':
          count(`alarm.${o.alarm}`);
          if (o.pending) {
            await journal(
              gateEventFact({
                eventId: deps.mintId(),
                bandId: o.pending.bandId,
                kind: 'alarm',
                alarm: o.alarm,
                direction: o.pending.direction,
                side: o.side,
                stationId,
                occurredAt: stamp(),
                offline: o.pending.offline,
              }),
            );
          } else {
            note('warn', `gate ${o.alarm} alarm with no open pending`, {
              station: stationId,
              direction: directionFor(o.side, lane.config.entrySide),
            });
          }
          break;
        case 'uncredited_passage':
          count(`uncredited.${o.why}`);
          note('warn', 'a passage the gate box can credit to nobody', {
            station: stationId,
            side: o.side,
            why: o.why,
          });
          break;
        case 'ir_blocked_standby':
          count('ir_blocked_standby');
          break;
      }
    }
  }

  async function openLink(lane: Lane): Promise<void> {
    const c = lane.config.controller;
    if (!c.path) return;
    if (!deps.openSerial) {
      lane.linkError = 'this box has no serial driver for the gate controller';
      return;
    }
    const target: SerialTarget = {
      path: c.path,
      baud: c.baud,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
    };
    let transport: TerminalTransport;
    try {
      transport = await deps.openSerial(target);
    } catch (err) {
      lane.linkError = `the gate controller line could not be opened: ${String(err)}`;
      note('error', 'gate controller line could not be opened', {
        station: lane.config.stationId,
        err: String(err),
      });
      return;
    }
    lane.linkError = null;
    lane.link = createGateLink({
      transport,
      machineId: c.machineId,
      now: realNow,
      ...(deps.replyTimeoutMs ? { replyTimeoutMs: deps.replyTimeoutMs } : {}),
      onFeedback: (feedback) => {
        void settle(lane, lane.controller.onFeedback(feedback)).catch((err) =>
          note('error', 'a gate feedback could not be settled', { err: String(err) }),
        );
      },
      onReply: () => {
        // A board answering after a silence booted late or came back: what
        // the last read saw — or missed — is read again on the next tick.
        if (lane.controller.noteReply()) lane.settingsStale = true;
      },
      onMissedReply: () => lane.controller.noteMissedReply(),
    });
    // Startup: is the machine on the line, and what does it hold? READ only.
    const machine = await lane.link.readMachine();
    if (machine === null)
      note('warn', 'the gate controller did not answer its machine number', {
        station: lane.config.stationId,
      });
    await readSettings(lane);
  }

  /** READ the watched settings and adopt the check. Never a write. */
  async function readSettings(lane: Lane): Promise<void> {
    const link = lane.link;
    if (!link) return;
    // Cleared before the reads: a board that comes up part-way through them
    // marks the lane stale again, and the next tick reads the rest.
    lane.settingsStale = false;
    lane.settingsReadAt = realNow();
    const read: Partial<Record<WatchedSetting, number | null>> = {};
    for (const key of WATCHED_SETTING_KEYS)
      read[key] = await link.readSetting(WATCHED_SETTINGS[key]);
    const check = lane.controller.applySettings(read, lane.config.expected);
    if (check.mismatches.length || check.notes.length || check.unread.length) {
      note('warn', 'gate controller settings need a look', {
        station: lane.config.stationId,
        mismatches: check.mismatches,
        unread: check.unread,
        notes: check.notes,
      });
    }
  }

  /**
   * Whether the settings are read again this tick, and why: the board came
   * back after a silence (at once), or it answers but a crediting setting is
   * still unread (spaced by `GATE_SETTINGS_RETRY_MS`). Null otherwise.
   */
  function settingsRereadDue(lane: Lane): 'recovered' | 'unread' | null {
    if (!lane.link) return null;
    if (lane.settingsStale) return 'recovered';
    if (!lane.controller.isAnswering()) return null;
    if (creditingUnread(lane.controller.settings()).length === 0) return null;
    if (realNow() - lane.settingsReadAt < GATE_SETTINGS_RETRY_MS) return null;
    return 'unread';
  }

  async function tick(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      for (const lane of lanes.values()) {
        await settle(lane, lane.controller.expire());
        if (!lane.link) continue;
        const door = await lane.link.query('door');
        if (door) lane.controller.onDoorState(door);
        const infrared = await lane.link.query('infrared');
        if (infrared) lane.controller.onInfraredState(infrared);
        // A board that booted after the startup read, or came back after a
        // silence, is verified on what it holds now — not left refusing
        // entries on the values it never answered.
        const why = settingsRereadDue(lane);
        if (why) {
          note('info', 'gate controller settings read again', {
            station: lane.config.stationId,
            why,
          });
          await readSettings(lane);
        }
      }
    } finally {
      polling = false;
    }
  }

  function clip(text: string): string {
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  }

  const signature = gateSignature(deps.stations);

  return {
    signature,
    get server() {
      return server;
    },
    reader: () => reader,
    scan,
    tick,

    async start() {
      for (const lane of lanes.values()) await openLink(lane);
      if (deps.listen) {
        try {
          server = await startReaderServer(reader, deps.listen);
          note('info', 'gate reader endpoint listening', { port: server.port });
        } catch (err) {
          count('reader_listen_failed');
          note('error', 'the gate reader endpoint could not listen', { err: String(err) });
        }
      }
      timer = setInterval(() => {
        void tick().catch((err) => note('error', 'gate tick failed', { err: String(err) }));
      }, deps.pollIntervalMs ?? GATE_POLL_INTERVAL_MS);
      timer.unref?.();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (server) await server.close().catch(() => undefined);
      server = null;
      for (const lane of lanes.values()) {
        await lane.link?.closeLink().catch(() => undefined);
        lane.link = null;
      }
    },

    deviceHealth() {
      const out: Record<string, GateDeviceHealth> = {};
      const states = reader.states();
      for (const lane of lanes.values()) {
        const c = lane.config;
        if (c.controller.deviceId) {
          const faults = lane.controller.faults();
          const words = [
            ...(lane.linkError ? [lane.linkError] : []),
            ...(lane.openerError ? [`opener: ${lane.openerError}`] : []),
            ...faults.map((f) => f.message),
            ...c.problems,
          ];
          const reachability: GateDeviceHealth['reachability'] = lane.link
            ? lane.controller.isAnswering()
              ? 'reachable'
              : 'unreachable'
            : lane.linkError
              ? 'unreachable'
              : 'unknown';
          out[c.controller.deviceId] = {
            reachability,
            ...(words.length ? { lastError: clip(words.join('; ')) } : {}),
          };
        }
        for (const r of c.readers) {
          const mine = states.filter(
            (s) => s.serial === r.serial && (r.direction === null || s.direction === r.direction),
          );
          const offline = mine.filter((s) => !s.online);
          out[r.deviceId] = offline.length
            ? {
                reachability: 'unreachable',
                lastError: `reader offline: no heartbeat (${offline.map((s) => s.direction).join(', ')})`,
              }
            : { reachability: mine.some((s) => s.lastSeenAt !== null) ? 'reachable' : 'unknown' };
        }
      }
      return out;
    },

    errorReports() {
      const reports: Array<{ fingerprint: string; code: string; count: number }> = [];
      for (const lane of lanes.values()) {
        for (const f of lane.controller.faults()) {
          reports.push({
            fingerprint: `gate.${f.code}`.slice(0, 32),
            code: `gate.${f.code}`,
            count: 1,
          });
        }
        if (lane.linkError)
          reports.push({ fingerprint: 'gate.link', code: 'gate.link_unavailable', count: 1 });
        if (lane.openerError)
          reports.push({ fingerprint: 'gate.opener', code: 'gate.opener_not_ready', count: 1 });
      }
      for (const [code, n] of counters) {
        reports.push({
          fingerprint: `gate.${code}`.slice(0, 32),
          code: `gate.${code}`.slice(0, 64),
          count: n,
        });
      }
      return reports.slice(0, 16);
    },

    faults(stationId) {
      return lanes.get(stationId)?.controller.faults() ?? [];
    },

    async occupancy() {
      return (await readPassages()).count;
    },
  };
}

/** Which side a lane uses for a direction — re-exported for callers of the host. */
export { sideFor, directionFor };
export type { GateSide };
