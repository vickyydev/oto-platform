import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBandCode, ulidFromUuid } from '@oto/shared';

import { createGateHost } from '../src/gate/host';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import type { TerminalTransport } from '../src/terminal/serial-channel';

/**
 * Gate review reproduction (S2-12 round 2): anti-passback beaten by timeouts
 * when the controller cannot report passages. With the default box_relay
 * opener the lane opens without the serial link, every open then expires as
 * an inferred timeout, nothing is ever committed, and ONE adult band admits
 * one person after another, a window apart.
 *
 * Fixed: an entry is refused (GATE_NOT_READY) while the lane cannot report a
 * passage, so nothing opens that could never be credited.
 */

const KEY = 'gate-review-band-key-0123456789abcdef';
const SERIAL = 'LANE-R';

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
        address: '/dev/serial/by-id/usb-lane-r',
        model: 'HX-X1',
        protocol: 'ge_x2',
        serialNumber: null,
        terminalId: null,
        merchantId: null,
        settings: {
          gate: {
            machineId: 1,
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

test('a controller that cannot report passages must not let one band admit repeatedly', async () => {
  let clock = Date.now();
  const silent: TerminalTransport = {
    async write() {},
    onData() {},
    async close() {},
  };
  const id = uuidv7();
  const kv = new Map<string, string>();
  const pulses: number[] = [];
  const host = createGateHost({
    boxId: uuidv7(),
    stations: [station()],
    now: () => clock,
    realNow: () => clock,
    bandKey: () => KEY,
    readCopy: async () => ({ bands: [{ id, kind: 'adult', status: 'active' }], deny: [] }),
    isOnline: () => false,
    journal: async () => {},
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    openSerial: async () => silent,
    relayDriver: {
      async pulse(line) {
        pulses.push(line.line);
      },
    },
    replyTimeoutMs: 5,
    pollIntervalMs: 60_000,
  });
  await host.start();
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

  const opened: string[] = [];
  for (let guest = 0; guest < 3; guest += 1) {
    opened.push(await scan());
    clock += 10_000; // past open duration + close delay + grace
    await host.tick();
  }
  await host.stop();
  // Before the fix: ['1', '1', '1'] — three people in on one band, three relay pulses.
  assert.deepEqual(
    opened,
    ['0', '0', '0'],
    `opened ${JSON.stringify(opened)}, pulses ${pulses.length}`,
  );
  assert.equal(pulses.length, 0);
});
