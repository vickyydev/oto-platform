import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GateEventPayloadSchema, mintBandCode, ulidFromUuid } from '@oto/shared';

import { readGateStation } from '../src/gate/config';
import { GATE_MESSAGES } from '../src/gate/decision';
import { createGateHost, type GateHostDeps } from '../src/gate/host';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import type { BoxConfigDevice, BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import type { QueuedFact } from '../src/store';

/**
 * SCRUM-68 — the reader-only lane: a Gate station holding a gate reader and
 * no controller board. The reader opens the barrier itself on code "1", and
 * the passage is credited at the granted scan, since no board can report it.
 * Lanes with a controller are covered, unchanged, by gate-host.test.ts.
 */

const KEY = 'gate-reader-only-band-key-0123456789ab';
const SERIAL = 'GATE-RO-1';

function reader(over: Partial<BoxConfigDevice> = {}): BoxConfigDevice {
  return {
    id: uuidv7(),
    role: 'gate',
    kind: 'gate_reader',
    label: 'Entrance reader',
    transport: 'network',
    address: null,
    model: null,
    protocol: null,
    serialNumber: SERIAL,
    terminalId: null,
    merchantId: null,
    ...over,
  };
}

function station(devices: BoxConfigDevice[] = [reader()], name = 'Entrance'): BoxConfigStation {
  return {
    id: uuidv7(),
    name,
    kind: 'gate',
    codePrefix: 'G1',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'branch',
    devices,
  };
}

interface Rig {
  host: ReturnType<typeof createGateHost>;
  journal: QueuedFact[];
  bands: Array<{ id: string; kind: string; status: string; gateAccess?: boolean }>;
  online: { value: boolean };
  notes: string[];
  serialOpened: number;
  clock: { v: number };
  st: BoxConfigStation;
}

async function rig(opts: { stations?: BoxConfigStation[]; over?: Partial<GateHostDeps> } = {}) {
  const journal: QueuedFact[] = [];
  const bands: Rig['bands'] = [];
  const online = { value: false };
  const notes: string[] = [];
  const kv = new Map<string, string>();
  const clock = { v: Date.now() };
  const stations = opts.stations ?? [station()];
  const r: Rig = {
    host: null as unknown as Rig['host'],
    journal,
    bands,
    online,
    notes,
    serialOpened: 0,
    clock,
    st: stations[0]!,
  };
  r.host = createGateHost({
    boxId: uuidv7(),
    stations,
    now: () => clock.v,
    realNow: () => clock.v,
    bandKey: () => KEY,
    readCopy: async () => ({ bands: [...bands], deny: [] }),
    isOnline: () => online.value,
    journal: async (fact) => void journal.push(fact),
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    openSerial: async () => {
      r.serialOpened += 1;
      throw new Error('no serial line on this box');
    },
    // The Pi's relay driver is present; a reader-only lane must not need it.
    relayDriver: null,
    pollIntervalMs: 60_000,
    note: (_level, message) => void notes.push(message),
    ...opts.over,
  });
  await r.host.start();
  return r;
}

function band(r: Rig, kind: 'adult' | 'kid' = 'adult', gateAccess?: boolean) {
  const id = uuidv7();
  r.bands.push({ id, kind, status: 'active', ...(gateAccess === undefined ? {} : { gateAccess }) });
  return { id, code: mintBandCode('T1', ulidFromUuid(id), KEY) };
}

async function scan(r: Rig, code: string, readerNo: '0' | '1', serial = SERIAL) {
  const res = await r.host.reader().handle({
    method: 'POST',
    path: READER_CHECK_CARD_PATH,
    body: { card: Buffer.from(code).toString('base64'), type: '1', serial, reader: readerNo },
  });
  return res.body;
}

const kinds = (r: Rig) => r.journal.map((f) => (f.payload as { kind: string }).kind);
const payload = (f: QueuedFact) =>
  f.payload as {
    kind: string;
    bandId: string;
    reason: string | null;
    inferred?: boolean;
    exitWithoutEntry?: boolean;
    offline?: boolean;
  };

// --- The config -------------------------------------------------------------------

test('a gate station with a reader and no controller is a reader-only lane: the reader is the opener, nothing to save', () => {
  const c = readGateStation(station());
  assert.equal(c.readerOnly, true);
  assert.equal(c.opener, 'reader_relay');
  assert.equal(c.controller.deviceId, null);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(
    c.readers.map((x) => x.serial),
    [SERIAL],
  );
});

test('a reader-only lane takes the gate serial from Address when the row holds no serial number', () => {
  const c = readGateStation(station([reader({ serialNumber: null, address: ' GATE-FROM-ADDR ' })]));
  assert.equal(c.readerOnly, true);
  assert.deepEqual(
    c.readers.map((x) => x.serial),
    ['GATE-FROM-ADDR'],
  );
  const none = readGateStation(station([reader({ serialNumber: null, address: null })]));
  assert.deepEqual(none.readers, []);
  assert.match(none.problems.join(' '), /no gate serial number/);
});

test('a station WITH a controller is not reader-only and keeps its opener default and its serial rule', () => {
  const controller: BoxConfigDevice = {
    ...reader({ kind: 'gate', label: 'Lane controller', transport: 'serial', serialNumber: null }),
    address: '/dev/serial/by-id/usb-lane-1',
  };
  const c = readGateStation(
    station([controller, reader({ role: 'scanner', serialNumber: null, address: '10.0.0.9' })]),
  );
  assert.equal(c.readerOnly, false);
  assert.equal(c.opener, 'box_relay');
  assert.deepEqual(c.readers, [], 'Address is never read as a serial on a lane with a controller');
  const bare = readGateStation(station([]));
  assert.equal(bare.readerOnly, false);
  assert.ok(bare.problems.includes('no gate controller device is assigned to this station'));
});

// --- The lane -----------------------------------------------------------------------

test('reader-only: adult in → "1" and ONE credited entry at the scan; again → Already entered; out → "1" and one exit; in again', async () => {
  const r = await rig();
  const b = band(r);

  assert.deepEqual(await scan(r, b.code, '0'), { code: '1', message: GATE_MESSAGES.welcome });
  assert.deepEqual(kinds(r), ['entry']);
  assert.equal(payload(r.journal[0]!).bandId, b.id);
  assert.equal(payload(r.journal[0]!).inferred, true, 'the box inferred the passage; no board reported it');
  assert.equal(await r.host.occupancy(), 1);

  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.ANTI_PASSBACK,
  });
  assert.deepEqual(kinds(r), ['entry', 'denied']);
  assert.equal(payload(r.journal[1]!).reason, 'ANTI_PASSBACK');

  assert.deepEqual(await scan(r, b.code, '1'), { code: '1', message: GATE_MESSAGES.goodbye });
  assert.deepEqual(kinds(r), ['entry', 'denied', 'exit']);
  assert.equal(payload(r.journal[2]!).exitWithoutEntry, undefined);
  assert.equal(await r.host.occupancy(), 0);

  assert.deepEqual(await scan(r, b.code, '0'), { code: '1', message: GATE_MESSAGES.welcome });
  assert.deepEqual(kinds(r), ['entry', 'denied', 'exit', 'entry']);
  assert.equal(await r.host.occupancy(), 1);

  for (const f of r.journal) {
    assert.equal(f.stationId, r.st.id);
    assert.equal(f.type, 'band.gate_event');
    assert.equal(GateEventPayloadSchema.safeParse(f.payload).success, true);
  }
  // No open was claimed, so nothing times out later.
  r.clock.v += 60_000;
  await r.host.tick();
  assert.equal(r.journal.length, 4);
  // Nothing tried to open a serial line, and nothing is reported as a fault.
  assert.equal(r.serialOpened, 0);
  assert.deepEqual(r.host.errorReports(), []);
  await r.host.stop();
});

test('reader-only: an exit by a band the box did not see enter is let out, recorded, the count stays at zero', async () => {
  const r = await rig();
  const b = band(r);
  assert.equal((await scan(r, b.code, '1')).code, '1');
  assert.deepEqual(kinds(r), ['exit']);
  assert.equal(payload(r.journal[0]!).exitWithoutEntry, true);
  assert.equal(await r.host.occupancy(), 0);
  await r.host.stop();
});

test('reader-only: two scans of one band at once credit ONE entry; the other is Already entered', async () => {
  const r = await rig();
  const b = band(r);
  const answers = await Promise.all([scan(r, b.code, '0'), scan(r, b.code, '0')]);
  assert.deepEqual(answers.map((a) => a.code).sort(), ['0', '1']);
  assert.ok(answers.some((a) => a.message === GATE_MESSAGES.ANTI_PASSBACK));
  assert.deepEqual(kinds(r).sort(), ['denied', 'entry']);
  assert.equal(await r.host.occupancy(), 1);
  await r.host.stop();
});

test('reader-only: a kid band and a band without Gate access are refused both ways; nothing is credited', async () => {
  const r = await rig();
  const kid = band(r, 'kid');
  const noGate = band(r, 'adult', false);
  for (const readerNo of ['0', '1'] as const) {
    assert.deepEqual(await scan(r, kid.code, readerNo), {
      code: '0',
      message: GATE_MESSAGES.KID_BAND,
    });
    assert.deepEqual(await scan(r, noGate.code, readerNo), {
      code: '0',
      message: GATE_MESSAGES.NO_GATE_ACCESS,
    });
  }
  assert.deepEqual(kinds(r), ['denied', 'denied', 'denied', 'denied']);
  assert.deepEqual(
    r.journal.map((f) => payload(f).reason),
    ['KID_BAND', 'NO_GATE_ACCESS', 'KID_BAND', 'NO_GATE_ACCESS'],
  );
  assert.equal(await r.host.occupancy(), 0);
  await r.host.stop();
});

test('reader-only: a reader serial this box has no gate for is "not ready", and nothing is journalled', async () => {
  const r = await rig();
  const b = band(r);
  assert.deepEqual(await scan(r, b.code, '0', 'SOMEONE-ELSE'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  assert.equal(r.journal.length, 0);
  assert.ok(r.host.errorReports().some((e) => e.code === 'gate.reader_unknown'));
  await r.host.stop();
});

test('reader-only: offline, a band held is credited and marked offline; an unknown band is see-reception', async () => {
  const r = await rig();
  const b = band(r);
  assert.equal((await scan(r, b.code, '0')).code, '1');
  assert.equal(payload(r.journal[0]!).offline, true);
  const stranger = mintBandCode('T1', ulidFromUuid(uuidv7()), KEY);
  assert.deepEqual(await scan(r, stranger, '0'), {
    code: '0',
    message: GATE_MESSAGES.BAND_UNKNOWN_OFFLINE,
  });
  await r.host.stop();
});

test('reader-only: an Entrance and an Exit station, each with its own reader, share who is inside', async () => {
  const entrance = station([reader({ serialNumber: 'GATE-IN' })], 'Entrance');
  const exit = station([reader({ serialNumber: 'GATE-OUT', label: 'Exit reader' })], 'Exit');
  const r = await rig({ stations: [entrance, exit] });
  const b = band(r);
  assert.equal((await scan(r, b.code, '0', 'GATE-IN')).code, '1');
  assert.deepEqual(await scan(r, b.code, '0', 'GATE-IN'), {
    code: '0',
    message: GATE_MESSAGES.ANTI_PASSBACK,
  });
  assert.equal((await scan(r, b.code, '1', 'GATE-OUT')).code, '1');
  assert.deepEqual(
    r.journal.map((f) => [payload(f).kind, f.stationId]),
    [
      ['entry', entrance.id],
      ['denied', entrance.id],
      ['exit', exit.id],
    ],
  );
  assert.equal(await r.host.occupancy(), 0);
  await r.host.stop();
});

test('reader-only: the box log says so once per lane at start, and on every decision', async () => {
  const r = await rig();
  const startLines = r.notes.filter((n) => /reader-only lane/.test(n));
  assert.equal(startLines.length, 1);
  assert.match(startLines[0]!, /credited at the scan/);
  const b = band(r);
  const kid = band(r, 'kid');
  await scan(r, b.code, '0');
  await scan(r, b.code, '0');
  await scan(r, kid.code, '1');
  const decisions = r.notes.filter((n) => /^reader-only gate Entrance:/.test(n));
  assert.equal(decisions.length, 3);
  assert.match(decisions[0]!, /entry granted and credited at the scan/);
  assert.match(decisions[1]!, /entry refused/);
  assert.match(decisions[2]!, /exit refused/);
  await r.host.stop();
});
