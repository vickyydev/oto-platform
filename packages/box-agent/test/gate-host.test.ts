import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GateEventPayloadSchema, mintBandCode, ulidFromUuid } from '@oto/shared';

import { GATE_MESSAGES } from '../src/gate/decision';
import { encodeBoardFrame } from '../src/gate/ge-x2';
import { createGateHost, GATE_SETTINGS_RETRY_MS, type GateHostDeps } from '../src/gate/host';
import { gpiosetRelayDriver, relayOpener, type RelayDriver } from '../src/gate/opener';
import {
  READER_CHECK_CARD_PATH,
  READER_HEARTBEAT_PATH,
  decodeCardField,
  startReaderServer,
} from '../src/gate/reader-host';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import type { QueuedFact } from '../src/store';
import type { TerminalTransport } from '../src/terminal/serial-channel';

/**
 * The gate box end to end (S2-12 round 2): reader call → decision → open →
 * board feedback → credited passage → journal. The board and the reader are
 * plain in-test doubles — a scripted byte pipe that answers the way the GE-X2
 * document says the board answers, and direct calls into the reader contract.
 */

const KEY = 'gate-host-band-key-0123456789abcdef';
const SERIAL = 'LANE-1';
const MACHINE = 3;

// --- The board, scripted ------------------------------------------------------

interface ScriptedBoard {
  transport: TerminalTransport;
  written: Uint8Array[];
  /** Push a §2 feedback code as the board would. */
  emit(code: number): void;
  silent: boolean;
  settings: Record<number, number>;
  door: number;
}

function scriptedBoard(
  settings: Record<number, number> = { 1: 5, 2: 0, 3: 2, 9: 0, 21: 1, 22: 0, 34: 1 },
): ScriptedBoard {
  let sink: (bytes: Uint8Array) => void = () => {};
  const board: ScriptedBoard = {
    written: [],
    silent: false,
    settings,
    door: 0,
    emit(code) {
      sink(encodeBoardFrame(MACHINE, code));
    },
    transport: {
      async write(bytes) {
        board.written.push(bytes);
        if (board.silent) return;
        const reply = answer(bytes);
        if (reply) queueMicrotask(() => sink(reply));
      },
      onData(s) {
        sink = s;
      },
      async close() {},
    },
  };
  function answer(b: Uint8Array): Uint8Array | null {
    if (b[0] === 0x7e && b[6] === 0x80) return encodeBoardFrame(b[3]!, 0x80);
    if (b[0] === 0x7e && b[6] === 0x01) return encodeBoardFrame(MACHINE, 0x01, [0x00, MACHINE]);
    if (b[0] === 0x55 && b[5] === 0x01) {
      const v = board.settings[b[2]!] ?? 0;
      return Uint8Array.from([0x55, 0x01, b[2]!, v >> 8, v & 0xff, 0x00, 0xaa, 0x55]);
    }
    if (b[0] === MACHINE && b[1] === 0x03 && b[3] === 0x12)
      return Uint8Array.from([MACHINE, 3, 2, 0, board.door, 0xaa, 0x55]);
    if (b[0] === MACHINE && b[1] === 0x03 && b[3] === 0x21)
      return Uint8Array.from([MACHINE, 3, 2, 0, 0, 0xaa, 0x55]);
    return null;
  }
  return board;
}

// --- The box around the host ----------------------------------------------------

function station(
  opener: 'box_relay' | 'serial' | 'reader_relay',
  relay = true,
  serial = SERIAL,
): BoxConfigStation {
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
        address: '/dev/serial/by-id/usb-lane-1',
        model: 'HX-X1',
        protocol: 'ge_x2',
        serialNumber: null,
        terminalId: null,
        merchantId: null,
        settings: {
          gate: {
            machineId: MACHINE,
            entrySide: 'left',
            opener,
            ...(relay ? { relay: { leftLine: 17, rightLine: 27 } } : {}),
            expected: { openDurationS: 5, tailgatingDetection: 1 },
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
        serialNumber: serial,
        terminalId: null,
        merchantId: null,
      },
    ],
  };
}

interface Rig {
  host: ReturnType<typeof createGateHost>;
  board: ScriptedBoard;
  journal: QueuedFact[];
  pulses: Array<{ line: number; ms: number }>;
  bands: Array<{ id: string; kind: string; status: string }>;
  deny: { revokedBands: Array<{ id: string; kind: string }> };
  online: { value: boolean };
  st: BoxConfigStation;
  refreshed: Array<{ id: string; kind: string; status: string }>;
}

async function rig(
  opts: {
    opener?: 'box_relay' | 'serial' | 'reader_relay';
    relay?: boolean;
    driver?: boolean;
    over?: Partial<GateHostDeps>;
  } = {},
): Promise<Rig> {
  const board = scriptedBoard();
  const journal: QueuedFact[] = [];
  const pulses: Rig['pulses'] = [];
  const bands: Rig['bands'] = [];
  const refreshed: Rig['refreshed'] = [];
  const deny = { revokedBands: [] as Array<{ id: string; kind: string }> };
  const online = { value: false };
  const kv = new Map<string, string>();
  const st = station(opts.opener ?? 'box_relay', opts.relay ?? true);
  const driver: RelayDriver = {
    async pulse(line, ms) {
      pulses.push({ line: line.line, ms });
    },
  };
  const host = createGateHost({
    boxId: uuidv7(),
    stations: [st],
    now: () => Date.now(),
    bandKey: () => KEY,
    readCopy: async () => ({
      bands: [...bands],
      deny: [{ revokedAccountIds: [], revokedTokenIds: [], ...deny }],
    }),
    isOnline: () => online.value,
    refreshBands: async () => {
      bands.push(...refreshed.splice(0));
      return true;
    },
    journal: async (fact) => {
      journal.push(fact);
    },
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    openSerial: async () => board.transport,
    relayDriver: opts.driver === false ? null : driver,
    replyTimeoutMs: 30,
    pollIntervalMs: 60_000,
    ...opts.over,
  });
  await host.start();
  return { host, board, journal, pulses, bands, deny, online, st, refreshed };
}

function adultBand(r: Rig, kind: 'adult' | 'kid' = 'adult'): { id: string; code: string } {
  const id = uuidv7();
  r.bands.push({ id, kind, status: 'active' });
  return { id, code: mintBandCode('T1', ulidFromUuid(id), KEY) };
}

async function scan(r: Rig, code: string, reader: '0' | '1') {
  const res = await r.host.reader().handle({
    method: 'POST',
    path: READER_CHECK_CARD_PATH,
    body: { card: Buffer.from(code).toString('base64'), type: '1', serial: SERIAL, reader },
  });
  return res.body;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const kinds = (r: Rig) => r.journal.map((f) => (f.payload as { kind: string }).kind);

// --- The path -------------------------------------------------------------------

test('startup finds the machine and READS the settings that matter — it never writes one', async () => {
  const r = await rig();
  // Every 55-frame the box sent is a read (X3 = 01), and nothing else it sent is a setting.
  const menu = r.board.written.filter((b) => b[0] === 0x55);
  assert.equal(menu.length, 7);
  assert.ok(menu.every((b) => b[5] === 0x01));
  assert.deepEqual(
    menu.map((b) => b[2]),
    [1, 2, 3, 9, 21, 22, 34],
  );
  assert.deepEqual(r.host.faults(r.st.id), []);
  await r.host.stop();
});

test('adult in → credited entry; the same band again → ANTI_PASSBACK; out → credited exit', async () => {
  const r = await rig();
  const b = adultBand(r);

  assert.deepEqual(await scan(r, b.code, '0'), { code: '1', message: GATE_MESSAGES.welcome });
  assert.deepEqual(r.pulses, [{ line: 17, ms: 1000 }]);
  // Nothing is journalled or committed on the open alone.
  assert.equal(r.journal.length, 0);
  r.board.emit(0x61);
  await settle();
  assert.deepEqual(kinds(r), ['entry']);
  assert.equal(await r.host.occupancy(), 1);

  const again = await scan(r, b.code, '0');
  assert.deepEqual(again, { code: '0', message: GATE_MESSAGES.ANTI_PASSBACK });
  assert.equal((r.journal[1]!.payload as { reason: string }).reason, 'ANTI_PASSBACK');

  assert.deepEqual(await scan(r, b.code, '1'), { code: '1', message: GATE_MESSAGES.goodbye });
  assert.deepEqual(r.pulses.at(-1), { line: 27, ms: 1000 });
  r.board.emit(0x62);
  await settle();
  assert.deepEqual(kinds(r), ['entry', 'denied', 'exit']);
  assert.equal(await r.host.occupancy(), 0);
  for (const f of r.journal) {
    assert.equal(f.stationId, r.st.id);
    assert.equal(GateEventPayloadSchema.safeParse(f.payload).success, true);
  }
  await r.host.stop();
});

test('exit without entry is let out, recorded, and the count stays at zero (OD-A4)', async () => {
  const r = await rig();
  const b = adultBand(r);
  assert.equal((await scan(r, b.code, '1')).code, '1');
  r.board.emit(0x62);
  await settle();
  assert.equal((r.journal[0]!.payload as { exitWithoutEntry?: boolean }).exitWithoutEntry, true);
  assert.equal(await r.host.occupancy(), 0);
  await r.host.stop();
});

test('a timeout changes nothing: the band can still enter afterwards', async () => {
  const r = await rig();
  const b = adultBand(r);
  await scan(r, b.code, '0');
  r.board.emit(0x63);
  await settle();
  assert.deepEqual(kinds(r), ['timeout']);
  assert.equal((await scan(r, b.code, '0')).code, '1');
  await r.host.stop();
});

test('tailgating after an open is journalled as an alarm on that band and credits nobody', async () => {
  const r = await rig();
  const b = adultBand(r);
  await scan(r, b.code, '0');
  r.board.emit(0x93);
  await settle();
  assert.deepEqual(kinds(r), ['alarm']);
  assert.equal((r.journal[0]!.payload as { alarm: string }).alarm, 'tailgating');
  assert.equal(await r.host.occupancy(), 0);
  r.board.emit(0x61);
  await settle();
  assert.deepEqual(kinds(r), ['alarm', 'entry']);
  await r.host.stop();
});

test('a second scan while an open is pending on that side is refused GATE_BUSY', async () => {
  const r = await rig();
  const a = adultBand(r);
  const b = adultBand(r);
  assert.equal((await scan(r, a.code, '0')).code, '1');
  assert.deepEqual(await scan(r, b.code, '0'), { code: '0', message: GATE_MESSAGES.GATE_BUSY });
  await r.host.stop();
});

test('kid, revoked, and non-band codes are refused; only the ones naming a band are journalled', async () => {
  const r = await rig();
  const kid = adultBand(r, 'kid');
  const revoked = adultBand(r);
  r.deny.revokedBands.push({ id: revoked.id, kind: 'adult' });
  assert.deepEqual(await scan(r, kid.code, '0'), { code: '0', message: GATE_MESSAGES.KID_BAND });
  assert.deepEqual(await scan(r, revoked.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.BAND_REVOKED,
  });
  assert.deepEqual(await scan(r, 'BK-2F7Q-9XKM', '0'), {
    code: '0',
    message: GATE_MESSAGES.NOT_A_BAND,
  });
  assert.deepEqual(
    r.journal.map((f) => (f.payload as { reason: string }).reason),
    ['KID_BAND', 'BAND_REVOKED'],
  );
  assert.ok(r.host.errorReports().some((e) => e.code === 'gate.denied.NOT_A_BAND'));
  assert.equal(r.pulses.length, 0);
  await r.host.stop();
});

test('an unknown band: offline → see reception (OD-A5); online → the box refreshes its copy and admits', async () => {
  const r = await rig();
  const id = uuidv7();
  const code = mintBandCode('T1', ulidFromUuid(id), KEY);
  assert.deepEqual(await scan(r, code, '0'), {
    code: '0',
    message: GATE_MESSAGES.BAND_UNKNOWN_OFFLINE,
  });
  assert.equal((r.journal[0]!.payload as { offline?: boolean }).offline, true);

  r.online.value = true;
  r.refreshed.push({ id, kind: 'adult', status: 'active' });
  assert.equal((await scan(r, code, '0')).code, '1');

  const stranger = mintBandCode('T1', ulidFromUuid(uuidv7()), KEY);
  assert.deepEqual(await scan(r, stranger, '0'), {
    code: '0',
    message: GATE_MESSAGES.BAND_NOT_FOUND,
  });
  await r.host.stop();
});

test('the serial opener sends the §1 open and admits on its acknowledgement; a silent board is "not ready"', async () => {
  const r = await rig({ opener: 'serial', relay: false });
  const b = adultBand(r);
  assert.equal((await scan(r, b.code, '0')).code, '1');
  const open = r.board.written.find((w) => w[0] === 0x7e && w[6] === 0x80);
  assert.ok(open);
  assert.deepEqual([open[3], open[10], open[11]], [MACHINE, 0x01, 0x00]);

  r.board.emit(0x63);
  await settle();
  r.board.silent = true;
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  // The failed open released its claim.
  r.board.silent = false;
  assert.equal((await scan(r, b.code, '0')).code, '1');
  await r.host.stop();
});

test('a box relay with no driver refuses loudly: "not ready" at the reader and a fault on the controller', async () => {
  const r = await rig({ driver: false });
  const b = adultBand(r);
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  const controllerId = r.st.devices[0]!.id;
  assert.match(r.host.deviceHealth()[controllerId]?.lastError ?? '', /no relay driver/);
  await r.host.stop();
});

// --- Entries only where a passage can be credited (review finding 1) --------------

test('a board that does not push passages (L-34 = 0): entries refused, exits still let out', async () => {
  const board = scriptedBoard({ 1: 5, 2: 0, 3: 2, 9: 0, 21: 1, 22: 0, 34: 0 });
  const r = await rig({ over: { openSerial: async () => board.transport } });
  const b = adultBand(r);
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  assert.deepEqual(r.pulses, []);
  assert.deepEqual(kinds(r), ['denied']);
  assert.equal((r.journal[0]!.payload as { reason: string }).reason, 'GATE_NOT_READY');
  assert.ok(
    r.host.errorReports().some((e) => e.code === 'gate.entry_uncreditable.crediting_unsound'),
  );
  assert.equal((await scan(r, b.code, '1')).code, '1');
  assert.deepEqual(r.pulses, [{ line: 27, ms: 1000 }]);
  await r.host.stop();
});

test('a controller that stops answering refuses entries until it answers again', async () => {
  const board = scriptedBoard();
  const r = await rig({ over: { openSerial: async () => board.transport } });
  const b = adultBand(r);
  board.silent = true;
  for (let i = 0; i < 2; i += 1) await r.host.tick();
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  assert.deepEqual(r.pulses, []);
  board.silent = false;
  await r.host.tick();
  assert.equal((await scan(r, b.code, '0')).code, '1');
  await r.host.stop();
});

test('a controller line that cannot be opened refuses entries; the exit still opens', async () => {
  const r = await rig({
    over: {
      openSerial: async () => {
        throw new Error('no such port');
      },
    },
  });
  const b = adultBand(r);
  assert.equal((await scan(r, b.code, '0')).code, '0');
  assert.equal((await scan(r, b.code, '1')).code, '1');
  await r.host.stop();
});

test('opens that keep ending with no passage report (no_feedback): entries refused, exits let out, the next report clears it', async () => {
  const offset = { v: 0 };
  const r = await rig({ over: { realNow: () => Date.now() + offset.v } });
  const b = adultBand(r);
  // Settings read and sound, the board answering — and three opens that end in silence.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await scan(r, b.code, '0')).code, '1');
    offset.v += 10_000;
    await r.host.tick();
  }
  assert.deepEqual(kinds(r), ['timeout', 'timeout', 'timeout']);
  assert.ok(r.host.faults(r.st.id).some((f) => f.code === 'no_feedback'));
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  assert.ok(r.host.errorReports().some((e) => e.code === 'gate.entry_uncreditable.no_feedback'));
  assert.equal(r.pulses.length, 3);
  // The exit still opens (OD-A4); its report is the board speaking again.
  assert.equal((await scan(r, b.code, '1')).code, '1');
  r.board.emit(0x62);
  await settle();
  assert.equal(
    r.host.faults(r.st.id).some((f) => f.code === 'no_feedback'),
    false,
  );
  assert.equal((await scan(r, b.code, '0')).code, '1');
  await r.host.stop();
});

test('a crediting setting one lost reply left unread is asked again of a board that answers — spaced, not every tick', async () => {
  const board = scriptedBoard();
  let dropL34 = true;
  const write = board.transport.write;
  board.transport.write = async (b) => {
    if (dropL34 && b[0] === 0x55 && b[2] === 34) {
      dropL34 = false;
      board.written.push(b);
      return;
    }
    await write(b);
  };
  const offset = { v: 0 };
  const r = await rig({
    over: { openSerial: async () => board.transport, realNow: () => Date.now() + offset.v },
  });
  const b = adultBand(r);
  const reads = () => board.written.filter((w) => w[0] === 0x55).length;
  assert.equal(reads(), 7);
  assert.ok(r.host.faults(r.st.id).some((f) => f.code === 'settings_unread'));
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: GATE_MESSAGES.GATE_NOT_READY,
  });
  assert.ok(
    r.host.errorReports().some((e) => e.code === 'gate.entry_uncreditable.settings_unread'),
  );
  assert.deepEqual(r.pulses, []);
  // One lost reply is not a silence: nothing came back, so the retry waits its interval.
  await r.host.tick();
  assert.equal(reads(), 7);
  offset.v += GATE_SETTINGS_RETRY_MS;
  await r.host.tick();
  assert.equal(reads(), 14);
  assert.equal(
    r.host.faults(r.st.id).some((f) => f.code === 'settings_unread'),
    false,
  );
  assert.equal((await scan(r, b.code, '0')).code, '1');
  await r.host.stop();
});

// --- Nothing dropped, nothing doubled (review findings 2 and 3) ---------------------

test('an open that expires between ticks is journalled when the next scan claims its side', async () => {
  const offset = { v: 0 };
  const r = await rig({ over: { realNow: () => Date.now() + offset.v } });
  const a = adultBand(r);
  const b = adultBand(r);
  assert.equal((await scan(r, a.code, '0')).code, '1');
  offset.v += 10_000; // past open duration + close delay + grace, before any tick
  assert.equal((await scan(r, b.code, '0')).code, '1');
  assert.deepEqual(kinds(r), ['timeout']);
  const t = r.journal[0]!.payload as { bandId: string; inferred?: boolean };
  assert.equal(t.bandId, a.id);
  assert.equal(t.inferred, true);
  await r.host.stop();
});

test('two lanes on one box: a band with an open pending in one lane is GATE_BUSY in the other', async () => {
  const one = station('box_relay', true, 'LANE-1');
  const two = station('box_relay', true, 'LANE-2');
  two.devices[0]!.address = '/dev/serial/by-id/usb-lane-2';
  const boards = new Map([
    [one.devices[0]!.address!, scriptedBoard()],
    [two.devices[0]!.address, scriptedBoard()],
  ]);
  const id = uuidv7();
  const kv = new Map<string, string>();
  const journal: QueuedFact[] = [];
  const host = createGateHost({
    boxId: uuidv7(),
    stations: [one, two],
    now: () => Date.now(),
    bandKey: () => KEY,
    readCopy: async () => ({ bands: [{ id, kind: 'adult', status: 'active' }], deny: [] }),
    isOnline: () => false,
    journal: async (f) => void journal.push(f),
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    openSerial: async (t) => boards.get(t.path)!.transport,
    relayDriver: { async pulse() {} },
    replyTimeoutMs: 30,
    pollIntervalMs: 60_000,
  });
  await host.start();
  const code = mintBandCode('T1', ulidFromUuid(id), KEY);
  const at = async (serial: string) =>
    (
      await host.reader().handle({
        method: 'POST',
        path: READER_CHECK_CARD_PATH,
        body: { card: Buffer.from(code).toString('base64'), type: '1', serial, reader: '0' },
      })
    ).body;
  assert.equal((await at('LANE-1')).code, '1');
  assert.deepEqual(await at('LANE-2'), { code: '0', message: GATE_MESSAGES.GATE_BUSY });
  assert.equal((journal[0]!.payload as { reason: string }).reason, 'GATE_BUSY');
  await host.stop();
});

test('a controller that does not answer is reported unreachable', async () => {
  const board = scriptedBoard();
  board.silent = true;
  const r = await rig({ over: { openSerial: async () => board.transport } });
  for (let i = 0; i < 3; i += 1) await r.host.tick();
  const controllerId = r.st.devices[0]!.id;
  assert.equal(r.host.deviceHealth()[controllerId]?.reachability, 'unreachable');
  assert.ok(r.host.errorReports().some((e) => e.code === 'gate.not_answering'));
  await r.host.stop();
});

test('the reader: heartbeat answers "1", missed heartbeats make it unreachable', async () => {
  let t = 0;
  const r = await rig({ over: { realNow: () => t, readerOfflineAfterMs: 1000 } });
  const readerId = r.st.devices[1]!.id;
  const hb = await r.host
    .reader()
    .handle({ method: 'POST', path: READER_HEARTBEAT_PATH, body: { serial: SERIAL, reader: '0' } });
  assert.deepEqual(hb, { status: 200, body: { code: '1', message: 'Operation successful' } });
  await r.host
    .reader()
    .handle({ method: 'POST', path: READER_HEARTBEAT_PATH, body: { serial: SERIAL, reader: 1 } });
  assert.equal(r.host.deviceHealth()[readerId]?.reachability, 'reachable');
  t = 2000;
  const health = r.host.deviceHealth()[readerId];
  assert.equal(health?.reachability, 'unreachable');
  assert.match(health?.lastError ?? '', /reader offline/);
  await r.host.stop();
});

test('a reader this box has no lane for is refused, and malformed calls never open', async () => {
  const r = await rig();
  const b = adultBand(r);
  const other = await r.host.reader().handle({
    method: 'POST',
    path: READER_CHECK_CARD_PATH,
    body: {
      card: Buffer.from(b.code).toString('base64'),
      type: '1',
      serial: 'ELSEWHERE',
      reader: '0',
    },
  });
  assert.equal(other.body.code, '0');
  const noReader = await r.host
    .reader()
    .handle({ method: 'POST', path: READER_CHECK_CARD_PATH, body: { card: 'x', serial: SERIAL } });
  assert.equal(noReader.body.code, '0');
  assert.equal(
    (await r.host.reader().handle({ method: 'GET', path: READER_CHECK_CARD_PATH, body: {} }))
      .status,
    405,
  );
  assert.equal(r.pulses.length, 0);
  await r.host.stop();
});

test('the card field: base64 per the spec, raw text tolerated, binary refused', () => {
  assert.equal(decodeCardField(Buffer.from('T1ABC.DEF').toString('base64')), 'T1ABC.DEF');
  assert.equal(decodeCardField('T1ABC.DEF'), 'T1ABC.DEF');
  assert.equal(decodeCardField(Buffer.from([0, 1, 2, 3]).toString('base64')), 'AAECAw==');
  assert.equal(decodeCardField('   '), null);
});

test('the listener serves the two calls over HTTP, JSON with string values', async () => {
  const r = await rig({ opener: 'reader_relay', relay: false });
  const b = adultBand(r);
  const server = await startReaderServer(r.host.reader(), { port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${READER_CHECK_CARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        card: Buffer.from(b.code).toString('base64'),
        type: '1',
        serial: SERIAL,
        reader: '0',
      }),
    });
    assert.deepEqual(await res.json(), { code: '1', message: GATE_MESSAGES.welcome });
    const form = await fetch(`http://127.0.0.1:${server.port}${READER_HEARTBEAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `serial=${SERIAL}&reader=0`,
    });
    assert.equal(((await form.json()) as { code: string }).code, '1');
    const missing = await fetch(`http://127.0.0.1:${server.port}/admin`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    await r.host.stop();
  }
});

test('the relay opener pulses the side line through gpioset, and refuses without wiring', async () => {
  const calls: Array<[string, string[]]> = [];
  const driver = gpiosetRelayDriver(async (cmd, args) => {
    calls.push([cmd, args]);
    return 0;
  });
  const opener = relayOpener(
    { chip: 'gpiochip0', leftLine: 5, rightLine: 6, activeLow: true, pulseMs: 900 },
    driver,
  );
  await opener.open('right');
  assert.deepEqual(calls, [['gpioset', ['-c', 'gpiochip0', '-t', '900ms,0', '6=0']]]);
  await assert.rejects(relayOpener(null, driver).open('left'), /no relay wiring/);
  const failing = gpiosetRelayDriver(async () => 1);
  await assert.rejects(
    relayOpener(
      { chip: 'gpiochip0', leftLine: 5, rightLine: 6, activeLow: false, pulseMs: 900 },
      failing,
    ).open('left'),
    /gpioset exited 1/,
  );
});
