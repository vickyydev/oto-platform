import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StationChannelMessage } from '../src/contract';
import type { BoxConfigBundle, BoxHeartbeatRequest } from '../src/protocol';
import { scanFingerprint } from '../src/scan';
import type { ScannerIo } from '../src/scanner-device';
import type { AgentResponse } from '../src/transport';
import { PROC_INPUT, fakeIo, typed, until, type FakeWorld } from './_scanner-support';
import type { StationEventWrite } from '../src/store';
import {
  STATION_ID,
  fakeBoxCloud,
  openTestAgent,
  openTestStore,
  tillBundle,
  type FakeBoxCloud,
} from './_support';

/**
 * SCRUM-700 — the agent with a scanner plugged into its box.
 *
 * The till's box, on a real SQLite store, with a USB scanner on the till's
 * station in its config bundle and the kernel stood in for. What it proves is
 * the whole path the cradle at Till 1 needed and did not have: the box opens
 * the scanner its bundle names, a code read off it reaches the till on the
 * station channel exactly as a simulated scan does, and the heartbeat says
 * whether the box sees the scanner, has it open and when it last read a code.
 */

const SCANNER = '018f0000-0000-7000-8000-00000000ac01';

function withScanner(transport = 'usb'): BoxConfigBundle {
  const bundle = tillBundle();
  bundle.stations[0]!.devices.push({
    id: SCANNER,
    role: 'scanner',
    kind: 'scanner',
    label: 'ZZ TEST Counter scanner',
    transport,
    address: null,
    model: 'Zebra DS2278 (CR2278-PC cradle)',
    protocol: 'hid',
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: { scanner: { mode: 'hid', vendorId: '05e0', productId: '1200' } },
  });
  return bundle;
}

/** The fake cloud, answering heartbeats too, and keeping what each one said. */
function cloudKeepingHeartbeats(bundle: BoxConfigBundle): {
  cloud: FakeBoxCloud;
  beats: BoxHeartbeatRequest[];
} {
  const cloud = fakeBoxCloud(bundle);
  const beats: BoxHeartbeatRequest[] = [];
  const base = cloud.fetch;
  cloud.fetch = async (url, init) => {
    if (new URL(url).pathname !== '/box/v1/heartbeat') return base(url, init);
    beats.push(JSON.parse(init.body ?? '{}') as BoxHeartbeatRequest);
    const now = new Date().toISOString();
    const ack = {
      receivedAt: now,
      serverTime: now,
      clockOffsetMs: 0,
      configVersion: cloud.bundle.configVersion,
      minSupportedAgentVersion: '0.1.0',
      heartbeatIntervalS: 60,
      commandsPending: 0,
      epoch: 1,
      devicesMatched: 0,
      devicesUnknown: 0,
    };
    const answer: AgentResponse = {
      status: 200,
      json: async () => ack,
      text: async () => JSON.stringify(ack),
      header: () => null,
    };
    return answer;
  };
  return { cloud, beats };
}

test('a code read off the box’s own scanner reaches the till on the station channel, and the heartbeat says so', async () => {
  const world: FakeWorld = {
    inputs: PROC_INPUT,
    ttys: {},
    nodes: new Set(['/dev/input/event4']),
    denied: new Set(),
  };
  const { io, channels } = fakeIo(world);
  const { cloud, beats } = cloudKeepingHeartbeats(withScanner());
  // The station's tape, as the store is asked to write it.
  const harness = openTestStore();
  const tape: StationEventWrite[] = [];
  const write = harness.store.recordStationEvent.bind(harness.store);
  harness.store.recordStationEvent = async (event, now) => {
    tape.push(event);
    await write(event, now);
  };
  const { agent, close } = await openTestAgent(
    cloud,
    { scanners: { enabled: true, io, retryMs: 5, tickMs: 5 } },
    harness,
  );
  try {
    await agent.prepare();
    const host = agent.scanners();
    assert.ok(host, 'the box reads the scanner its bundle names');
    await until('the scanner to open', () => host.health()[SCANNER]?.open === true);

    const heard: StationChannelMessage[] = [];
    const unsubscribe = agent.sessions()!.subscribe(STATION_ID, 'staff', (m) => heard.push(m));
    channels[0]!.send(typed('ZZTEST12345', { startMs: Date.now() }));
    await host.settled();
    unsubscribe();

    const scans = heard.filter((m) => m.kind === 'scan');
    assert.equal(scans.length, 1);
    const scan = scans[0] as Extract<StationChannelMessage, { kind: 'scan' }>;
    assert.equal(scan.source, 'box_hid');
    // The fingerprint travels, as for every scan; a code nothing claims is unhandled.
    assert.equal(scan.codeFingerprint, scanFingerprint('ZZTEST12345'));
    assert.equal(scan.outcome, 'unhandled');
    // And the tape has its line: a scan at this station, entered at the box,
    // with the fingerprint and never the code.
    const lines = tape.filter((e) => e.kind === 'scan');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.stationId, STATION_ID);
    assert.equal(lines[0]?.source, 'box');
    assert.equal(lines[0]?.payload?.source, 'box_hid');
    assert.equal(lines[0]?.payload?.codeFingerprint, scanFingerprint('ZZTEST12345'));
    assert.equal(JSON.stringify(lines[0]).includes('ZZTEST12345'), false);

    await agent.heartbeat();
    const reported = beats.at(-1)?.devices.find((d) => d.id === SCANNER);
    assert.ok(reported, 'the heartbeat reports the scanner');
    assert.equal(reported.reachability, 'reachable');
    assert.equal(reported.lastError, undefined);
    assert.deepEqual(
      { ...reported.scanner, lastScanAt: typeof reported.scanner?.lastScanAt },
      {
        mode: 'hid',
        present: true,
        open: true,
        path: '/dev/input/event4',
        lastScanAt: 'string',
        scans: 1,
        dropped: 0,
      },
    );

    // Pulled out: the next heartbeat says so, with the reason.
    world.nodes.delete('/dev/input/event4');
    world.inputs = '';
    channels[0]!.unplug();
    await until('the box to notice', () => host.health()[SCANNER]?.present === false);
    await agent.heartbeat();
    const gone = beats.at(-1)?.devices.find((d) => d.id === SCANNER);
    assert.equal(gone?.reachability, 'unreachable');
    assert.match(gone?.lastError ?? '', /No scanner with USB id 05e0:1200/);
    assert.equal(gone?.scanner?.open, false);

    // A config pull that drops the scanner closes its reader.
    cloud.bundle = { ...tillBundle(), configVersion: 'cfg-till-no-scanner' };
    await agent.syncConfig();
    assert.equal(agent.scanners(), null);
  } finally {
    close();
    harness.close();
  }
});

test('a config pull that leaves the scanner as it was keeps its reader open', async () => {
  const world: FakeWorld = {
    inputs: PROC_INPUT,
    ttys: {},
    nodes: new Set(['/dev/input/event4']),
    denied: new Set(),
  };
  const { io, channels } = fakeIo(world);
  const { cloud } = cloudKeepingHeartbeats(withScanner());
  const { agent, close } = await openTestAgent(cloud, {
    scanners: { enabled: true, io, retryMs: 5, tickMs: 5 },
  });
  try {
    await agent.prepare();
    const host = agent.scanners()!;
    await until('the scanner to open', () => host.health()[SCANNER]?.open === true);
    cloud.bundle = { ...cloud.bundle, configVersion: 'cfg-till-price-change' };
    await agent.syncConfig();
    assert.equal(agent.scanners(), host);
    assert.equal(channels.length, 1);
    assert.equal(channels[0]!.closed, false);
  } finally {
    close();
  }
  assert.equal(channels[0]!.closed, true, 'stopping the agent closes the scanner');
});

test('a box that is not a Pi opens nothing, and a simulated scanner is never opened', async () => {
  const opened: string[] = [];
  const spy: ScannerIo = {
    readText: async () => {
      opened.push('read');
      return '';
    },
    list: async () => [],
    resolve: async (path) => path,
    open: async (path) => {
      opened.push(path);
      throw new Error('must not open');
    },
  };

  // The virtual box: no config cache, so no readers unless told.
  const virtual = await openTestAgent(cloudKeepingHeartbeats(withScanner()).cloud, {
    scanners: { io: spy },
  });
  try {
    await virtual.agent.prepare();
    assert.equal(virtual.agent.scanners(), null);
  } finally {
    virtual.close();
  }

  // Told to read, but the only scanner is the Console's simulated one.
  const simulated = await openTestAgent(cloudKeepingHeartbeats(withScanner('simulated')).cloud, {
    scanners: { enabled: true, io: spy },
  });
  try {
    await simulated.agent.prepare();
    assert.equal(simulated.agent.scanners(), null);
  } finally {
    simulated.close();
  }
  assert.deepEqual(opened, []);
});
