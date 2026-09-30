import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBandCode, ulidFromUuid } from '@oto/shared';

import { encodeBoardFrame } from '../src/gate/ge-x2';
import { createGateHost } from '../src/gate/host';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import type { TerminalTransport } from '../src/terminal/serial-channel';

/**
 * Gate re-check reproduction (S2-12 round 2): anti-passback beaten by timeouts
 * on a board that ANSWERS but does not push its passages.
 *
 * The board is still booting when the box reads its settings at startup, so
 * L-9 / L-34 come back unread — and `checkSettings` treats an unread L-34 as
 * sound. The board then comes up with upload mode L-34 = 0: it answers every
 * poll (so `isAnswering()` is true) but never pushes a §2 passage. Every entry
 * opens, expires as an inferred timeout, commits nothing, and ONE adult band
 * admits one person after another. The controller even raises `no_feedback`
 * after three silent opens, and the host keeps opening regardless.
 *
 * Expected: once the lane cannot be shown to credit passages (settings unread,
 * or `no_feedback` raised), an entry is refused as the silent-line case is.
 *
 * Fixed: an entry is refused while L-9 / L-34 are unread or `no_feedback` is
 * raised (`controller.creditBlocker`), and a board that answers after a
 * silence has its settings read again on the next tick — so a board that
 * booted late is judged on real values: refused when they are unsound,
 * admitted when they are sound.
 */

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

const UNSOUND = { 1: 5, 2: 0, 3: 2, 9: 0, 21: 1, 22: 0, 34: 0 };
const SOUND = { 1: 5, 2: 0, 3: 2, 9: 0, 21: 1, 22: 0, 34: 1 };

test('a board that answers polls but pushes no passages must not let one band admit repeatedly', async () => {
  const board = lateBoard(UNSOUND);
  const r = rig(board.transport);
  await r.host.start(); // the settings read goes unanswered: the board is booting
  board.up();
  await r.host.tick(); // the board now answers the door / infrared polls

  const opened: string[] = [];
  for (let guest = 0; guest < 5; guest += 1) {
    opened.push(await r.scan());
    r.advance(10_000); // past open duration + close delay + grace
    await r.host.tick();
  }
  await r.host.stop();
  // At the re-check: ['1','1','1','1','1'] — five people in on one adult band.
  assert.equal(
    opened.filter((c) => c === '1').length <= 1,
    true,
    `opened ${JSON.stringify(opened)}, pulses ${r.pulses.length}`,
  );
  assert.deepEqual(opened, ['0', '0', '0', '0', '0']);
  assert.equal(r.pulses.length, 0);
  // The board was read again once it answered, and what it said — L-34 = 0 —
  // is the refusal; nothing is left unread.
  assert.equal(board.reads(), 14);
  assert.ok(r.counted('entry_uncreditable.crediting_unsound'));
  assert.ok(r.faultCodes().includes('crediting_unsound'));
  assert.equal(r.faultCodes().includes('settings_unread'), false);
});

test('a board silent at the startup read, then answering with sound settings: entries refused until it is read again, then admitted', async () => {
  const board = lateBoard(SOUND);
  const r = rig(board.transport);
  await r.host.start();
  assert.equal(board.reads(), 7);
  assert.ok(r.faultCodes().includes('settings_unread'));

  // Unverified: refused, whatever the board would have said.
  assert.equal(await r.scan(), '0');
  assert.ok(r.counted('entry_uncreditable.not_answering'));
  assert.deepEqual(r.pulses, []);

  board.up();
  await r.host.tick(); // the polls are answered: the board came back, so it is read again
  assert.equal(board.reads(), 14);
  assert.equal(r.faultCodes().includes('settings_unread'), false);
  assert.equal(r.faultCodes().includes('not_answering'), false);

  assert.equal(await r.scan(), '1');
  assert.deepEqual(r.pulses, [17]);
  await r.host.stop();
});

test('a board that comes up part-way through the startup read is read again on the first tick', async () => {
  // L-1, L-2, L-3, L-9 go unanswered (the machine read too); L-21, L-22, L-34 answer.
  const board = lateBoard(SOUND, { upAfterReads: 4 });
  const r = rig(board.transport);
  await r.host.start();
  assert.equal(board.reads(), 7);
  assert.ok(r.faultCodes().includes('settings_unread'));
  // L-9 is unread: not verified, whatever L-34 said.
  assert.equal(await r.scan(), '0');
  assert.ok(r.counted('entry_uncreditable.settings_unread'));

  await r.host.tick(); // the board came back mid-read: the rest is read now, not next silence
  assert.equal(board.reads(), 14);
  assert.equal(r.faultCodes().includes('settings_unread'), false);
  assert.equal(await r.scan(), '1');
  assert.deepEqual(r.pulses, [17]);
  await r.host.stop();
});
