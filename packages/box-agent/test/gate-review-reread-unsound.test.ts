import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBandCode, ulidFromUuid } from '@oto/shared';

import { encodeBoardFrame } from '../src/gate/ge-x2';
import { createGateHost } from '../src/gate/host';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import type { TerminalTransport } from '../src/terminal/serial-channel';

/** Final-check reproduction (S2-12 round 2): rig and board double as in gate-review-unread-settings. */

const KEY = 'gate-recheck-band-key-0123456789abcdef';
const SERIAL = 'LANE-U';
const MACHINE = 2;

function station(): BoxConfigStation {
  return {
    id: uuidv7(),
    name: 'Entrance',
    kind: 'gate',
    codePrefix: 'G1',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'branch',
    devices: [
      {
        id: uuidv7(),
        role: 'gate',
        kind: 'gate',
        label: 'Lane controller',
        transport: 'serial',
        address: '/dev/serial/by-id/usb-lane-u',
        model: 'HX-X1',
        protocol: 'ge_x2',
        serialNumber: null,
        terminalId: null,
        merchantId: null,
        settings: {
          gate: {
            machineId: MACHINE,
            entrySide: 'left',
            opener: 'box_relay',
            relay: { leftLine: 17, rightLine: 27 },
          },
        },
      },
      {
        id: uuidv7(),
        role: 'scanner',
        kind: 'gate_reader',
        label: 'Lane reader',
        transport: 'network',
        address: null,
        model: null,
        protocol: null,
        serialNumber: SERIAL,
        terminalId: null,
        merchantId: null,
      },
    ],
  };
}

/**
 * A board still booting — answering nothing — until `up()` is called, or
 * until it has been sent `upAfterReads` §4 reads (a board that comes up
 * part-way through the startup read).
 */
function lateBoard(
  settings: Record<number, number>,
  opts: { upAfterReads?: number } = {},
): { transport: TerminalTransport; up(): void; reads(): number } {
  let booting = true;
  let reads = 0;
  let sink: (bytes: Uint8Array) => void = () => {};
  return {
    up: () => {
      booting = false;
    },
    reads: () => reads,
    transport: {
      async write(b) {
        if (b[0] === 0x55 && b[5] === 0x01) {
          reads += 1;
          if (opts.upAfterReads !== undefined && reads > opts.upAfterReads) booting = false;
        }
        if (booting) return;
        let reply: Uint8Array | null = null;
        if (b[0] === 0x7e && b[6] === 0x80) reply = encodeBoardFrame(b[3]!, 0x80);
        else if (b[0] === 0x7e && b[6] === 0x01)
          reply = encodeBoardFrame(MACHINE, 0x01, [0x00, MACHINE]);
        else if (b[0] === 0x55 && b[5] === 0x01) {
          const v = settings[b[2]!] ?? 0;
          reply = Uint8Array.from([0x55, 0x01, b[2]!, v >> 8, v & 0xff, 0x00, 0xaa, 0x55]);
        } else if (b[0] === MACHINE && b[1] === 0x03 && (b[3] === 0x12 || b[3] === 0x21))
          reply = Uint8Array.from([MACHINE, 3, 2, 0, 0, 0xaa, 0x55]);
        if (reply) {
          const r = reply;
          queueMicrotask(() => sink(r));
        }
      },
      onData(s) {
        sink = s;
      },
      async close() {},
    },
  };
}

function rig(board: TerminalTransport) {
  let clock = Date.now();
  const id = uuidv7();
  const kv = new Map<string, string>();
  const pulses: number[] = [];
  const st = station();
  const host = createGateHost({
    boxId: uuidv7(),
    stations: [st],
    now: () => clock,
    realNow: () => clock,
    bandKey: () => KEY,
    readCopy: async () => ({ bands: [{ id, kind: 'adult', status: 'active' }], deny: [] }),
    isOnline: () => false,
    journal: async () => {},
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    openSerial: async () => board,
    relayDriver: {
      async pulse(line) {
        pulses.push(line.line);
      },
    },
    replyTimeoutMs: 5,
    pollIntervalMs: 60_000,
  });
  const code = mintBandCode('T1', ulidFromUuid(id), KEY);
  const scan = async () =>
    (
      await host.reader().handle({
        method: 'POST',
        path: READER_CHECK_CARD_PATH,
        body: {
          card: Buffer.from(code).toString('base64'),
          type: '1',
          serial: SERIAL,
          reader: '0',
        },
      })
    ).body.code;
  const faultCodes = () => host.faults(st.id).map((f) => f.code);
  const counted = (code: string) => host.errorReports().some((e) => e.code === `gate.${code}`);
  return {
    host,
    pulses,
    scan,
    faultCodes,
    counted,
    advance(ms: number) {
      clock += ms;
    },
  };
}


/*
 * Gate final check (S2-12 round 2): a board read again after it came up must
 * be judged on what it holds. When the re-read finds the crediting rule
 * genuinely broken — entry/exit memory L-9 on, or upload mode L-34 = 0 — an
 * entry stays refused with no pulse, however many ticks pass; an exit still
 * opens (OD-A4).
 */
for (const [label, settings] of [
  ['L-9 on', { 1: 5, 2: 0, 3: 2, 9: 1, 21: 1, 22: 0, 34: 1 }],
  ['L-34 = 0', { 1: 5, 2: 0, 3: 2, 9: 0, 21: 1, 22: 0, 34: 0 }],
] as const) {
  test(`a late board whose re-read finds ${label} keeps refusing entries`, async () => {
    const board = lateBoard(settings);
    const r = rig(board.transport);
    await r.host.start();
    assert.equal(await r.scan(), '0');
    board.up();
    for (let i = 0; i < 4; i += 1) {
      await r.host.tick();
      assert.equal(await r.scan(), '0');
      r.advance(40_000); // past GATE_SETTINGS_RETRY_MS each time
    }
    assert.equal(board.reads(), 14, 'read once at start, once on recovery; sound-or-not is settled');
    assert.deepEqual(r.pulses, []);
    assert.ok(r.counted('entry_uncreditable.crediting_unsound'));
    assert.ok(r.faultCodes().includes('crediting_unsound'));
    assert.equal(r.faultCodes().includes('settings_unread'), false);
    await r.host.stop();
  });
}
