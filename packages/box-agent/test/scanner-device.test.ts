import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EV_KEY,
  EV_SYN,
  EvdevScanReader,
  InputEventDecoder,
  SYN_DROPPED,
  SYN_REPORT,
  cdcNodeFor,
  createScannerHost,
  encodeInputEvent,
  hidEventNodeFor,
  locateScanner,
  parseInputDeviceList,
  scannerSignature,
  scannerSpecsOf,
  type InputEvent,
  type ScannerSpec,
} from '../src/scanner-device';
import type { BoxConfigStation } from '../src/protocol';
import type { ScanInput } from '../src/scan';
import { PROC_INPUT, fakeIo, typed, until, type FakeWorld } from './_scanner-support';

/**
 * SCRUM-700 — the box reads the counter scanner itself.
 *
 * The kernel and the cradle are stood in for at the one seam the reader has
 * with them (`ScannerIo`): the bytes a real `/dev/input/eventN` hands over —
 * 24-byte `struct input_event` records, a press and a release per key, Shift
 * around a capital — and the lines a real `/dev/ttyACM0` does. Everything
 * between those bytes and a code delivered to a station is the shipped code.
 */

// --- The decoder and the key reader -----------------------------------------

test('a 24-byte input_event is decoded, even when a read ends half-way through one', () => {
  const event: InputEvent = { atMs: 1_730_000_000_123.456, type: EV_KEY, code: 30, value: 1 };
  const bytes = encodeInputEvent(event, 24);
  assert.equal(bytes.length, 24);
  const decoder = new InputEventDecoder(24);
  assert.deepEqual(decoder.push(bytes.subarray(0, 10)), []);
  const [decoded] = decoder.push(bytes.subarray(10));
  assert.equal(decoded?.type, EV_KEY);
  assert.equal(decoded?.code, 30);
  assert.equal(decoded?.value, 1);
  assert.ok(Math.abs((decoded?.atMs ?? 0) - event.atMs) < 0.01);
});

test('the 16-byte layout of a 32-bit system decodes the same event', () => {
  const event: InputEvent = { atMs: 5_000.25, type: EV_KEY, code: 28, value: 0 };
  const [decoded] = new InputEventDecoder(16).push(encodeInputEvent(event, 16));
  assert.deepEqual(
    { type: decoded?.type, code: decoded?.code, value: decoded?.value },
    { type: EV_KEY, code: 28, value: 0 },
  );
});

test('bytes off the event node become one scan: capitals, digits and symbols on a US layout', () => {
  let now = 1_000_000;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const code = 'T1-Ab:9_z.Q';
  const events = reader.push(typed(code, { startMs: now }));
  now += 100;
  const scans = events.filter((e) => e.kind === 'scan');
  assert.equal(scans.length, 1);
  const first = scans[0];
  assert.ok(first && first.kind === 'scan');
  assert.equal(first.input.code, code);
  assert.equal(first.input.source, 'box_hid');
});

test('the same code arriving in small reads is still one scan', () => {
  let now = 2_000_000;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const bytes = typed('ZZTEST12345', { startMs: now });
  const found: string[] = [];
  for (let at = 0; at < bytes.length; at += 37) {
    for (const e of reader.push(bytes.subarray(at, at + 37)))
      if (e.kind === 'scan') found.push(e.input.code);
    now += 1;
  }
  assert.deepEqual(found, ['ZZTEST12345']);
});

test('a person typing on the cradle’s keys is not a scan', () => {
  const now = 3_000_000;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const events = reader.push(typed('ZZTEST12345', { startMs: now, perKeyMs: 120 }));
  assert.equal(
    events.some((e) => e.kind === 'scan'),
    false,
  );
});

test('a burst the kernel dropped events from is thrown away whole, never delivered short', () => {
  let now = 4_000_000;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const head = typed('ABCD', { startMs: now, enter: false });
  const drop = Buffer.concat([
    encodeInputEvent({ atMs: now + 8, type: EV_SYN, code: SYN_DROPPED, value: 0 }, 24),
    // What is left of the report the drop fell in: unreliable, skipped.
    encodeInputEvent({ atMs: now + 8, type: EV_KEY, code: 33, value: 1 }, 24),
    encodeInputEvent({ atMs: now + 8, type: EV_SYN, code: SYN_REPORT, value: 0 }, 24),
  ]);
  // The tail of the code is long enough to pass for one on its own.
  const tail = typed('GHIJKLMNOP', { startMs: now + 10 });
  const events = [...reader.push(head), ...reader.push(drop), ...reader.push(tail)];
  assert.equal(
    events.some((e) => e.kind === 'scan'),
    false,
    JSON.stringify(events),
  );
  assert.equal(events.filter((e) => e.kind === 'overrun').length, 1);

  // The next scan, after a pause, reads normally.
  now += 2_000;
  const next = reader.push(typed('ZZTEST67890', { startMs: now }));
  const scan = next.find((e) => e.kind === 'scan');
  assert.ok(scan && scan.kind === 'scan');
  assert.equal(scan.input.code, 'ZZTEST67890');
});

/**
 * What the kernel leaves when its buffer overflows: `SYN_DROPPED`, stamped with
 * the newest event it kept, then the rest of the report that event was in.
 */
function overflow(atMs: number): Buffer {
  return Buffer.concat([
    encodeInputEvent({ atMs, type: EV_SYN, code: SYN_DROPPED, value: 0 }, 24),
    encodeInputEvent({ atMs, type: EV_KEY, code: 33, value: 0 }, 24),
    encodeInputEvent({ atMs, type: EV_SYN, code: SYN_REPORT, value: 0 }, 24),
  ]);
}

const kinds = (events: ReadonlyArray<{ kind: string }>): string[] => events.map((e) => e.kind);

test('a drop after a stall longer than the burst gap still throws the rest of its burst away', () => {
  const start = 6_000_000;
  let now = start;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const events = [...reader.push(typed('ABCD', { startMs: start, enter: false }))];
  // The box stops reading for a second and a half; the cradle keeps typing and
  // the kernel overflows 86 ms into the code. The box reads it all late.
  now = start + 1_500;
  const dropAt = start + 86;
  events.push(...reader.push(overflow(dropAt)));
  // The box's clock has moved on by far more than the burst gap: a tick here
  // must not end the damage.
  const between = reader.tick(now);
  if (between) events.push(between);
  // The tail of the code, at the scanner's pace from the drop, is long enough
  // to pass for a code on its own.
  events.push(...reader.push(typed('GHIJKLMNOP', { startMs: dropAt + 2 })));
  now += 600;
  const after = reader.tick(now);
  if (after) events.push(after);
  assert.deepEqual(kinds(events), ['overrun'], JSON.stringify(events));

  // The next scan, after a pause, reads normally.
  now += 2_000;
  const next = reader.push(typed('ZZTEST67890', { startMs: now }));
  const scan = next.find((e) => e.kind === 'scan');
  assert.ok(scan && scan.kind === 'scan', JSON.stringify(next));
  assert.equal(scan.input.code, 'ZZTEST67890');
});

test('a drop before any key of a new burst was read still throws that burst away', () => {
  let now = 7_000_000;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const first = reader.push(typed('ZZTEST11111', { startMs: now }));
  assert.deepEqual(kinds(first), ['scan']);
  // Three seconds on, the next scan starts while the box is busy: the kernel
  // overflows before the box reads a single key of it.
  now += 3_000;
  const dropAt = now;
  now += 200;
  const events = [
    ...reader.push(overflow(dropAt)),
    ...reader.push(typed('GHIJKLMNOP', { startMs: dropAt + 2 })),
  ];
  assert.deepEqual(kinds(events), ['overrun'], JSON.stringify(events));
  now += 2_000;
  assert.deepEqual(kinds(reader.push(typed('ZZTEST22222', { startMs: now }))), ['scan']);
});

test('a burst the tick closed while its tail sat unread is thrown away, not delivered as the tail', () => {
  const start = 8_000_000;
  let now = start;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const head = 'ZZTEST0123456789';
  const events = [...reader.push(typed(head, { startMs: start, enter: false }))];
  // The box stalls for 1.2 s with the last eight characters and the Enter in
  // the kernel's buffer (too few to overflow it), and its quiet tick runs
  // before the read that holds them.
  now = start + 1_200;
  const cut = reader.tick(now);
  assert.equal(cut?.kind, 'partial');
  // The tail, stamped by the kernel at the scanner's pace, straight after the head.
  events.push(...reader.push(typed('ABCDEFGH', { startMs: start + head.length * 2 })));
  assert.deepEqual(kinds(events), ['overrun'], JSON.stringify(events));

  now += 2_000;
  const next = reader.push(typed('ZZTEST33333', { startMs: now }));
  assert.deepEqual(kinds(next), ['scan']);
});

test('a code read in full more than a second late is still one scan', () => {
  const start = 9_000_000;
  let now = start;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  const head = 'ZZTEST0123456789';
  const events = [...reader.push(typed(head, { startMs: start, enter: false }))];
  // A 1.2 s stall with the rest of the code buffered and no tick in between:
  // the late read is not a pause inside the code.
  now = start + 1_200;
  events.push(...reader.push(typed('ABCDEFGH', { startMs: start + head.length * 2 })));
  const scans = events.filter((e) => e.kind === 'scan');
  assert.equal(scans.length, 1, JSON.stringify(events));
  const scan = scans[0];
  assert.ok(scan && scan.kind === 'scan');
  assert.equal(scan.input.code, `${head}ABCDEFGH`);
  assert.equal(events.length, 1, JSON.stringify(events));
});

test('a code with no suffix is closed by the quiet gap and dropped, as the burst rule says', () => {
  let now = 5_000_000;
  const reader = new EvdevScanReader({ eventSize: 24, now: () => now });
  assert.deepEqual(reader.push(typed('ZZTEST12345', { startMs: now, enter: false })), []);
  now += 600;
  const closed = reader.tick(now);
  assert.equal(closed?.kind, 'partial');
  // The next scan, a pause later, is not mistaken for the rest of that one.
  now += 2_000;
  assert.deepEqual(kinds(reader.push(typed('ZZTEST67890', { startMs: now }))), ['scan']);
});

// --- Finding the scanner -------------------------------------------------------

test('the cradle’s keyboard node is found by its USB ids in the kernel’s input list', () => {
  const entries = parseInputDeviceList(PROC_INPUT);
  assert.equal(entries.length, 5);
  assert.equal(hidEventNodeFor(entries, '05E0', '1200'), '/dev/input/event4');
  assert.equal(hidEventNodeFor(entries, '05e0', '1701'), null);
});

test('a serial cradle is found by its USB ids through sysfs, among the other ports', async () => {
  const { io } = fakeIo({
    inputs: '',
    ttys: {
      ttyACM0: { vendor: '1a86', product: '7523' },
      ttyACM1: { vendor: '05e0', product: '1701' },
    },
    nodes: new Set(),
    denied: new Set(),
  });
  assert.equal(await cdcNodeFor(io, '05e0', '1701'), '/dev/ttyACM1');
  assert.equal(await cdcNodeFor(io, '05e0', '1200'), null);
});

test('a path the row names is used as it is, but only a device node', async () => {
  const { io } = fakeIo({
    inputs: '',
    ttys: {},
    nodes: new Set(['/dev/ttyACM3']),
    denied: new Set(),
  });
  const spec = { mode: 'cdc', vendorId: '05e0', productId: '1701' } as const;
  assert.deepEqual(await locateScanner(io, { ...spec, path: '/dev/ttyACM3' }), {
    path: '/dev/ttyACM3',
  });
  const missing = await locateScanner(io, { ...spec, path: '/dev/ttyACM9' });
  assert.equal(missing.path, null);
  const outside = await locateScanner(io, { ...spec, path: '/var/lib/oto-box/credential.json' });
  assert.equal(outside.path, null);
  assert.match('problem' in outside ? outside.problem : '', /must be a device under \/dev\//);
});

// --- Which scanners a bundle asks the box to read -------------------------------

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const OTHER_STATION = '018f0000-0000-7000-8000-0000000057a2';
const SCANNER = '018f0000-0000-7000-8000-00000000ac01';

function scannerDevice(over: Record<string, unknown> = {}): BoxConfigStation['devices'][number] {
  return {
    id: SCANNER,
    role: 'scanner',
    kind: 'scanner',
    label: 'ZZ TEST Counter scanner',
    transport: 'usb',
    address: null,
    model: 'Zebra DS2278 (CR2278-PC cradle)',
    protocol: 'hid',
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    ...over,
  } as BoxConfigStation['devices'][number];
}

function station(id: string, devices: BoxConfigStation['devices']): BoxConfigStation {
  return {
    id,
    name: 'Till 2 (test)',
    kind: 'till',
    codePrefix: 'T2',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'all_staff',
    devices,
  };
}

test('a USB or serial scanner is read, a simulated one never, and one device once', () => {
  const specs = scannerSpecsOf([
    station(STATION, [
      scannerDevice(),
      scannerDevice({ id: '018f0000-0000-7000-8000-00000000ac02', transport: 'simulated' }),
      scannerDevice({ id: '018f0000-0000-7000-8000-00000000ac03', transport: 'bluetooth' }),
      scannerDevice({
        id: '018f0000-0000-7000-8000-00000000ac04',
        kind: 'receipt_printer',
        role: 'receipt',
      }),
    ]),
    station(OTHER_STATION, [scannerDevice()]),
  ]);
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], {
    deviceId: SCANNER,
    stationId: STATION,
    label: 'ZZ TEST Counter scanner',
    mode: 'hid',
    vendorId: '05e0',
    productId: '1200',
    path: null,
    terminatorKey: 'Enter',
  });
});

test('the mode, ids and path come from the row’s settings, and the transport stands in for the mode', () => {
  const [cdc] = scannerSpecsOf([
    station(STATION, [scannerDevice({ transport: 'serial', address: '/dev/ttyACM0' })]),
  ]);
  assert.equal(cdc?.mode, 'cdc');
  assert.equal(cdc?.productId, '1701');
  assert.equal(cdc?.path, '/dev/ttyACM0');

  const [told] = scannerSpecsOf([
    station(STATION, [
      scannerDevice({
        settings: {
          scanner: {
            mode: 'cdc',
            vendorId: '0C2E',
            productId: '0B61',
            devicePath: '/dev/serial/by-id/x',
            burstGapMs: 60,
          },
        },
      }),
    ]),
  ]);
  assert.deepEqual(
    {
      mode: told?.mode,
      vendorId: told?.vendorId,
      productId: told?.productId,
      path: told?.path,
      gap: told?.burstGapMs,
    },
    { mode: 'cdc', vendorId: '0c2e', productId: '0b61', path: '/dev/serial/by-id/x', gap: 60 },
  );

  // A section the box cannot read leaves the cradle's defaults, not no scanner.
  const [broken] = scannerSpecsOf([
    station(STATION, [scannerDevice({ settings: { scanner: { mode: 'x' } } })]),
  ]);
  assert.equal(broken?.mode, 'hid');
  assert.equal(broken?.productId, '1200');
  assert.notEqual(scannerSignature([told!]), scannerSignature([broken!]));
});

// --- The host: open, read, deliver, lose it, find it again ------------------------

function hidSpec(over: Partial<ScannerSpec> = {}): ScannerSpec {
  return {
    deviceId: SCANNER,
    stationId: STATION,
    label: 'ZZ TEST Counter scanner',
    mode: 'hid',
    vendorId: '05e0',
    productId: '1200',
    path: null,
    terminatorKey: 'Enter',
    ...over,
  };
}

test('a HID scanner is opened, read and delivered; pulled out, it is looked for again and reopened', async () => {
  const world: FakeWorld = { inputs: '', ttys: {}, nodes: new Set(), denied: new Set() };
  const { io, channels } = fakeIo(world);
  const delivered: Array<{ station: string; input: ScanInput }> = [];
  const notes: string[] = [];
  const host = createScannerHost({
    specs: [hidSpec()],
    io,
    deliver: async (spec, input) => {
      delivered.push({ station: spec.stationId, input });
    },
    note: (_level, message) => notes.push(message),
    stamp: () => '2026-11-02T03:00:00.000Z',
    retryMs: 5,
    tickMs: 5,
  });
  host.start();
  try {
    // Not plugged in: a state, with its reason, and the box keeps looking.
    await host.settled();
    let health = host.health()[SCANNER]!;
    assert.deepEqual(
      { present: health.present, open: health.open, lastScanAt: health.lastScanAt },
      { present: false, open: false, lastScanAt: null },
    );
    assert.match(health.lastError ?? '', /No scanner with USB id 05e0:1200/);

    // Plugged in.
    world.inputs = PROC_INPUT;
    world.nodes.add('/dev/input/event4');
    await until('the scanner to open', () => host.health()[SCANNER]!.open);
    health = host.health()[SCANNER]!;
    assert.equal(health.present, true);
    assert.equal(health.path, '/dev/input/event4');
    assert.equal(health.lastError, undefined);

    channels.at(-1)!.send(typed('ZZTEST12345', { startMs: Date.now() }));
    await host.settled();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.station, STATION);
    assert.equal(delivered[0]?.input.code, 'ZZTEST12345');
    assert.equal(delivered[0]?.input.source, 'box_hid');
    assert.equal(delivered[0]?.input.scannedAt, '2026-11-02T03:00:00.000Z');
    assert.equal(host.health()[SCANNER]!.lastScanAt, '2026-11-02T03:00:00.000Z');
    assert.equal(host.health()[SCANNER]!.scans, 1);

    // Pulled out mid-shift: closed, reported, looked for again.
    world.nodes.delete('/dev/input/event4');
    world.inputs = PROC_INPUT.replace(/Vendor=05e0/g, 'Vendor=ffff');
    const first = channels.at(-1)!;
    first.unplug();
    assert.equal(first.closed, true);
    assert.equal(host.health()[SCANNER]!.open, false);
    await until('the box to notice it is gone', () => host.health()[SCANNER]!.present === false);
    assert.match(host.health()[SCANNER]!.lastError ?? '', /No scanner with USB id/);

    // Plugged back in, perhaps on another node.
    world.inputs = PROC_INPUT.replace('event4', 'event9');
    world.nodes.add('/dev/input/event9');
    await until('the scanner to reopen', () => host.health()[SCANNER]!.open);
    assert.equal(host.health()[SCANNER]!.path, '/dev/input/event9');
    channels.at(-1)!.send(typed('ZZTEST67890', { startMs: Date.now() }));
    await host.settled();
    assert.deepEqual(
      delivered.map((d) => d.input.code),
      ['ZZTEST12345', 'ZZTEST67890'],
    );
    // One line per state, not one per retry.
    assert.equal(notes.filter((n) => /No scanner with USB id/.test(n)).length, 2);
  } finally {
    host.stop();
  }
  assert.equal(channels.at(-1)!.closed, true);
});

test('a serial scanner delivers a line, and a code with no suffix after the quiet gap', async () => {
  const world: FakeWorld = {
    inputs: '',
    ttys: { ttyACM0: { vendor: '05e0', product: '1701' } },
    nodes: new Set(['/dev/ttyACM0']),
    denied: new Set(),
  };
  const { io, channels } = fakeIo(world);
  const delivered: ScanInput[] = [];
  const host = createScannerHost({
    specs: [hidSpec({ mode: 'cdc', productId: '1701' })],
    io,
    deliver: async (_spec, input) => {
      delivered.push(input);
    },
    note: () => undefined,
    retryMs: 5,
    tickMs: 5,
  });
  host.start();
  try {
    await until('the port to open', () => host.health()[SCANNER]!.open);
    assert.equal(host.health()[SCANNER]!.path, '/dev/ttyACM0');
    channels[0]!.send('ZZTEST-SERIAL-1\r\n');
    await host.settled();
    assert.equal(delivered[0]?.code, 'ZZTEST-SERIAL-1');
    assert.equal(delivered[0]?.source, 'box_serial');

    // "Data As Is": no terminator on the wire, so half a second of quiet ends it.
    channels[0]!.send(']Q1ZZTEST-SERIAL-2');
    await until('the quiet gap to close the record', () => delivered.length === 2, 3_000);
    // The Symbol code id the scanner may prefix is not part of the code.
    assert.equal(delivered[1]?.code, 'ZZTEST-SERIAL-2');
  } finally {
    host.stop();
  }
});

test('a scanner the box may not read is reported as present and not open, naming the fix', async () => {
  const world: FakeWorld = {
    inputs: PROC_INPUT,
    ttys: {},
    nodes: new Set(),
    denied: new Set(['/dev/input/event4']),
  };
  const { io } = fakeIo(world);
  const host = createScannerHost({
    specs: [hidSpec()],
    io,
    deliver: async () => undefined,
    note: () => undefined,
    retryMs: 5,
  });
  host.start();
  try {
    await host.settled();
    const health = host.health()[SCANNER]!;
    assert.equal(health.present, true);
    assert.equal(health.open, false);
    assert.equal(health.path, '/dev/input/event4');
    assert.match(health.lastError ?? '', /may not read it — run the box installer again/);
  } finally {
    host.stop();
  }
});

test('a delivery that throws is logged, and the next scan still goes through', async () => {
  const world: FakeWorld = {
    inputs: PROC_INPUT,
    ttys: {},
    nodes: new Set(['/dev/input/event4']),
    denied: new Set(),
  };
  const { io, channels } = fakeIo(world);
  const delivered: string[] = [];
  const errors: string[] = [];
  let fail = true;
  const host = createScannerHost({
    specs: [hidSpec()],
    io,
    deliver: async (_spec, input) => {
      if (fail) {
        fail = false;
        throw new Error('the router fell over');
      }
      delivered.push(input.code);
    },
    note: (level, message) => {
      if (level === 'error') errors.push(message);
    },
    retryMs: 5,
  });
  host.start();
  try {
    await until('the scanner to open', () => host.health()[SCANNER]!.open);
    channels[0]!.send(typed('ZZTEST11111', { startMs: Date.now() }));
    channels[0]!.send(typed('ZZTEST22222', { startMs: Date.now() + 500 }));
    await host.settled();
    assert.deepEqual(delivered, ['ZZTEST22222']);
    assert.equal(errors.length, 1);
    assert.equal(host.health()[SCANNER]!.open, true);
  } finally {
    host.stop();
  }
});
