import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBandCode, ulidFromUuid } from '@oto/shared';

import type { BoxAgentOptions } from '../src/agent';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import { GATE_MESSAGES } from '../src/gate/decision';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import { BOX_ID, fakeBoxCloud, openTestAgent, tillBundle } from './_support';

/**
 * The gate host inside the agent (S2-12 round 2): built behind the gate
 * station kind and nowhere else.
 */

const KEY = 'gate-agent-band-key-0123456789abcdef';

function gateStation(): BoxConfigStation {
  return {
    id: uuidv7(),
    name: 'Entrance gate',
    kind: 'gate',
    codePrefix: 'G1',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'all_staff',
    devices: [
      {
        id: uuidv7(),
        role: 'gate',
        kind: 'gate',
        label: 'Lane controller',
        transport: 'serial',
        address: '/dev/serial/by-id/usb-lane',
        model: 'HX-X1',
        protocol: null,
        serialNumber: null,
        terminalId: null,
        merchantId: null,
        settings: { gate: { opener: 'box_relay', relay: { leftLine: 17, rightLine: 27 } } },
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
        serialNumber: 'LANE-9',
        terminalId: null,
        merchantId: null,
      },
    ],
  };
}

test('a till box never builds a gate host', async () => {
  const { agent, close } = await openTestAgent(fakeBoxCloud(tillBundle()));
  try {
    await agent.prepare();
    assert.equal(agent.gate(), null);
  } finally {
    close();
  }
});

test('a box whose bundle names a gate station runs one: a kid band is refused and journalled to the outbox', async () => {
  const st = gateStation();
  const bundle = tillBundle({ stations: [...tillBundle().stations, st] });
  const pulses: number[] = [];
  const options = {
    bands: { key: () => KEY },
    gate: {
      listen: null,
      relayDriver: {
        async pulse(line: { line: number }) {
          pulses.push(line.line);
        },
      },
    },
  } as unknown as Pick<BoxAgentOptions, 'bands'>;
  const { agent, harness, close } = await openTestAgent(fakeBoxCloud(bundle), options);
  try {
    await agent.prepare();
    const gate = agent.gate();
    assert.ok(gate, 'the agent built no gate host for a gate station');

    const kid = uuidv7();
    const adult = uuidv7();
    await harness.store.writeBundle(BOX_ID, {
      scope: 'bands',
      schemaVersion: 1,
      cursorSeq: 0,
      payload: {
        items: [
          { id: kid, kind: 'kid', status: 'active' },
          { id: adult, kind: 'adult', status: 'active' },
        ],
      },
      appliedAt: new Date().toISOString(),
    });
    const call = (id: string, reader: '0' | '1' = '0') =>
      gate.reader().handle({
        method: 'POST',
        path: READER_CHECK_CARD_PATH,
        body: {
          card: Buffer.from(mintBandCode('T1', ulidFromUuid(id), KEY)).toString('base64'),
          type: '1',
          serial: 'LANE-9',
          reader,
        },
      });

    assert.deepEqual((await call(kid)).body, { code: '0', message: GATE_MESSAGES.KID_BAND });
    const depth = await agent.outbox()!.depth();
    assert.equal(depth.queued, 1);

    // No controller line on this box: an entry could never be credited, so it
    // is refused rather than opened (anti-passback); the exit still opens (OD-A4).
    assert.deepEqual((await call(adult)).body, {
      code: '0',
      message: GATE_MESSAGES.GATE_NOT_READY,
    });
    assert.deepEqual(pulses, []);
    assert.deepEqual((await call(adult, '1')).body, { code: '1', message: GATE_MESSAGES.goodbye });
    assert.deepEqual(pulses, [27]);

    // The controller row reports what the host knows: no serial driver here.
    const controllerId = st.devices[0]!.id;
    assert.match(gate.deviceHealth()[controllerId]?.lastError ?? '', /no serial driver/);
    assert.ok(gate.errorReports().some((e) => e.code === 'gate.link_unavailable'));
  } finally {
    close();
  }
});
