/**
 * The serial line to the gate's control board (S2-12 round 2).
 *
 * One request in flight at a time, because the board's answers carry nothing
 * that says which question they answer: the §3 door and infrared replies are
 * the same shape, and a §4 reply names only its menu number. Everything the
 * board says that is not the answer being waited for — the §2 feedback it
 * pushes on its own — goes to `onFeedback`.
 *
 * The port itself is the terminal's `TerminalTransport` (a byte pipe) opened
 * by the host's `SerialOpener`: this package ships no serial driver, and a
 * box that has none says so by name (`noSerialDriver`).
 */

import type { TerminalTransport } from '../terminal/serial-channel';
import {
  buildCommand,
  buildSettingRead,
  buildStatusQuery,
  createFrameScanner,
  doorStateOf,
  infraredStateOf,
  type DoorState,
  type GateFeedback,
  type GateSide,
  type GeX2Frame,
  type InfraredState,
  type StatusQuery,
} from './ge-x2';

export interface GateLinkOptions {
  transport: TerminalTransport;
  machineId: number;
  /** Real time, in ms. */
  now?: () => number;
  /** How long an answer may take. The board acknowledges "immediately" (§1). */
  replyTimeoutMs?: number;
  /** A silence this long between bytes throws away a half-read frame. */
  interByteGapMs?: number;
  /** `computed` (default) or §1's fixed `95 FC`. */
  crc?: 'computed' | 'fixed';
  onFeedback: (feedback: GateFeedback, machineId: number) => void;
  /** Every frame the board sent — the controller's evidence it is alive. */
  onReply?: () => void;
  /** A request that went unanswered. */
  onMissedReply?: () => void;
}

export interface GateLink {
  open(side: GateSide, hold?: boolean): Promise<boolean>;
  close(side: GateSide): Promise<boolean>;
  readMachine(): Promise<number | null>;
  readSetting(number: number): Promise<number | null>;
  query(kind: 'door'): Promise<DoorState | null>;
  query(kind: 'infrared'): Promise<InfraredState | null>;
  /** Bytes discarded while resynchronising. */
  discarded(): number;
  closeLink(): Promise<void>;
}

export const GATE_REPLY_TIMEOUT_MS = 500;

export function createGateLink(options: GateLinkOptions): GateLink {
  const now = options.now ?? Date.now;
  const timeoutMs = options.replyTimeoutMs ?? GATE_REPLY_TIMEOUT_MS;
  const gapMs = options.interByteGapMs ?? 250;
  const machineId = options.machineId;
  const scanner = createFrameScanner({ statusAddress: machineId });
  let lastByteAt = 0;
  let waiting: { match: (f: GeX2Frame) => boolean; resolve: (f: GeX2Frame | null) => void } | null =
    null;
  let chain: Promise<unknown> = Promise.resolve();

  options.transport.onData((bytes) => {
    const at = now();
    if (scanner.pending() > 0 && at - lastByteAt > gapMs) scanner.clear();
    lastByteAt = at;
    for (const frame of scanner.push(bytes)) handle(frame);
  });

  function handle(frame: GeX2Frame): void {
    // Our own bytes heard back on a two-wire line say nothing about the board.
    if (frame.type === 'echo') return;
    if ('machineId' in frame && frame.machineId !== machineId) return;
    options.onReply?.();
    if (frame.type === 'feedback') {
      options.onFeedback(frame.feedback, frame.machineId);
      return;
    }
    if (waiting?.match(frame)) {
      const w = waiting;
      waiting = null;
      w.resolve(frame);
    }
  }

  /** Send, then wait for the first frame `match` accepts. Serialised. */
  function request(bytes: Uint8Array, match: (f: GeX2Frame) => boolean): Promise<GeX2Frame | null> {
    const run = async (): Promise<GeX2Frame | null> => {
      const answer = new Promise<GeX2Frame | null>((resolve) => {
        const timer = setTimeout(() => {
          if (waiting?.resolve === settle) waiting = null;
          options.onMissedReply?.();
          resolve(null);
        }, timeoutMs);
        // Not unref'd: a caller is awaiting this answer, and a deadline of a
        // fraction of a second is not what keeps a process alive.
        function settle(frame: GeX2Frame | null): void {
          clearTimeout(timer);
          resolve(frame);
        }
        waiting = { match, resolve: settle };
      });
      try {
        await options.transport.write(bytes);
      } catch {
        // A write that fails is an answer that will not come; the timer says so.
      }
      return answer;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => null);
    return next;
  }

  async function query(kind: StatusQuery): Promise<DoorState | InfraredState | null> {
    const frame = await request(buildStatusQuery(kind, machineId), (f) => f.type === 'status');
    if (frame?.type !== 'status') return null;
    return kind === 'door' ? doorStateOf(frame.value) : infraredStateOf(frame.value);
  }

  return {
    async open(side, hold = false) {
      const frame = await request(
        buildCommand({ op: 'open', machineId, side, hold }, { crc: options.crc }),
        (f) => f.type === 'ack' && f.command === 'open',
      );
      return frame !== null;
    },
    async close(side) {
      const frame = await request(
        buildCommand({ op: 'close', machineId, side }, { crc: options.crc }),
        (f) => f.type === 'ack' && f.command === 'close',
      );
      return frame !== null;
    },
    async readMachine() {
      const frame = await request(
        buildCommand({ op: 'read_machine', machineId }, { crc: options.crc }),
        (f) => f.type === 'machine',
      );
      return frame?.type === 'machine' ? frame.machineId : null;
    },
    async readSetting(number) {
      const frame = await request(
        buildSettingRead(number),
        (f) => f.type === 'setting' && f.menu === 'L' && f.number === number,
      );
      if (frame?.type !== 'setting' || frame.status === 'failed') return null;
      return frame.value;
    },
    query: query as GateLink['query'],
    discarded: () => scanner.discarded(),
    async closeLink() {
      await options.transport.close();
    },
  };
}
