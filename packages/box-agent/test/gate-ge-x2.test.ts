import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DOOR_STATES,
  GE_X2_FIXED_CRC,
  INFRARED_STATES,
  buildCommand,
  buildInfraredPairsRead,
  buildSettingRead,
  buildStatusQuery,
  buildSupplyVoltageRead,
  crc16Xmodem,
  createFrameScanner,
  doorStateOf,
  encodeBoardFrame,
  feedbackCode,
  hex,
  infraredStateOf,
  parseFrames,
  type GateFeedback,
} from '../src/gate/ge-x2';

/**
 * GE-X2 frames (S2-12 round 2), derived section by section from the GE-X2
 * communication protocol (2021-12-01). The few byte strings below are the
 * protocol document's own worked examples for machine 1 — the vectors that
 * pin the checksum — not anything read off a device.
 */

// --- §1 commands -------------------------------------------------------------

test('§1: the open, stay-open, close and machine-read frames carry the documented layout and checksum', () => {
  assert.equal(
    hex(buildCommand({ op: 'open', machineId: 1, side: 'left' })),
    '7E 80 00 01 00 00 80 AA 00 01 01 00 DE 62 7E',
  );
  assert.equal(
    hex(buildCommand({ op: 'open', machineId: 1, side: 'left', hold: true })),
    '7E 80 00 01 00 00 80 AA 00 01 01 01 CE 43 7E',
  );
  assert.equal(
    hex(buildCommand({ op: 'open', machineId: 1, side: 'right' })),
    '7E 80 00 01 00 00 80 AA 00 01 02 00 8B 31 7E',
  );
  assert.equal(
    hex(buildCommand({ op: 'close', machineId: 1, side: 'left' })),
    '7E 80 00 01 00 00 81 AA 00 01 01 8A AB 7E',
  );
  assert.equal(
    hex(buildCommand({ op: 'read_machine', machineId: 0 })),
    '7E 80 00 00 00 00 01 AA 00 01 A3 7A 7E',
  );
  assert.equal(
    hex(buildCommand({ op: 'read_machine', machineId: 1 })),
    '7E 80 00 01 00 00 01 AA 00 01 1B 1B 7E',
  );
});

test('§1: the checksum may be sent as the fixed 95 FC', () => {
  const frame = buildCommand({ op: 'open', machineId: 9, side: 'right' }, { crc: 'fixed' });
  assert.deepEqual([...frame.slice(-3, -1)], [...GE_X2_FIXED_CRC]);
  assert.equal(frame[3], 9);
});

test('§1: every machine id 1-255 and both sides build a frame the scanner reads back as our own echo', () => {
  for (const machineId of [1, 2, 17, 128, 255]) {
    for (const side of ['left', 'right'] as const) {
      for (const cmd of [
        { op: 'open' as const, machineId, side },
        { op: 'open' as const, machineId, side, hold: true },
        { op: 'close' as const, machineId, side },
      ]) {
        const frame = buildCommand(cmd);
        // The checksum covers everything between the leading 7E and itself.
        const crc = crc16Xmodem(frame.slice(1, -3));
        assert.deepEqual([frame.at(-3), frame.at(-2)], [crc >> 8, crc & 0xff]);
        const [parsed] = parseFrames(frame, machineId);
        assert.equal(parsed?.type, 'echo');
        assert.equal(parsed?.type === 'echo' && parsed.machineId, machineId);
      }
    }
  }
});

test('§1: a machine id the board cannot hold (L-30 is 1-255) is refused, not truncated', () => {
  assert.throws(() => buildCommand({ op: 'open', machineId: 0, side: 'left' }), RangeError);
  assert.throws(() => buildCommand({ op: 'open', machineId: 256, side: 'left' }), RangeError);
  assert.throws(() => buildCommand({ op: 'close', machineId: 1.5, side: 'left' }), RangeError);
});

test('§1: acknowledgements and the machine-number reply parse, including a checksum that contains 7E', () => {
  const openAck = encodeBoardFrame(3, 0x80);
  const closeAck = encodeBoardFrame(1, 0x81);
  // The close acknowledgement for machine 1 checksums to BC 7E: a delimiter
  // splitter would end the frame one byte early.
  assert.deepEqual([...closeAck.slice(-3)], [0xbc, 0x7e, 0x7e]);
  const machine = encodeBoardFrame(5, 0x01, [0x00, 0x05]);
  const frames = parseFrames(Uint8Array.from([...openAck, ...closeAck, ...machine]), 1);
  assert.deepEqual(frames, [
    { type: 'ack', machineId: 3, command: 'open' },
    { type: 'ack', machineId: 1, command: 'close' },
    { type: 'machine', machineId: 5 },
  ]);
});

// --- §2 feedback --------------------------------------------------------------

const FAMILIES: GateFeedback[] = [
  { kind: 'passed', side: 'left' },
  { kind: 'passed', side: 'right' },
  { kind: 'timeout', side: 'left' },
  { kind: 'timeout', side: 'right' },
  { kind: 'timeout_in_lane', side: 'left' },
  { kind: 'timeout_in_lane', side: 'right' },
  { kind: 'reverse', side: 'left' },
  { kind: 'reverse', side: 'right' },
  { kind: 'tailgating', side: 'left' },
  { kind: 'tailgating', side: 'right' },
  { kind: 'ir_blocked_standby' },
];

test('§2: every feedback family on each side round-trips through its byte-7 code', () => {
  assert.deepEqual(
    FAMILIES.map(feedbackCode),
    [0x61, 0x62, 0x63, 0x64, 0x73, 0x74, 0x83, 0x84, 0x93, 0x94, 0x95],
  );
  for (const feedback of FAMILIES) {
    const [frame] = parseFrames(encodeBoardFrame(1, feedbackCode(feedback)), 1);
    assert.deepEqual(frame, { type: 'feedback', machineId: 1, feedback });
  }
});

test('§2: the checksum of a board frame is not verified (either byte order, or junk)', () => {
  const frame = encodeBoardFrame(1, 0x61);
  frame[10] = 0x12;
  frame[11] = 0x34;
  assert.deepEqual(parseFrames(frame, 1), [
    { type: 'feedback', machineId: 1, feedback: { kind: 'passed', side: 'left' } },
  ]);
});

test('§2: a doubled leading 7E is ignored, and back-to-back frames share nothing', () => {
  const a = encodeBoardFrame(1, 0x61);
  const b = encodeBoardFrame(1, 0x64);
  const stream = Uint8Array.from([0x7e, ...a, 0x7e, ...b]);
  assert.deepEqual(
    parseFrames(stream, 1).map((f) => f.type === 'feedback' && f.feedback),
    [
      { kind: 'passed', side: 'left' },
      { kind: 'timeout', side: 'right' },
    ],
  );
});

test('the scanner resynchronises past noise and waits across chunk boundaries', () => {
  const scanner = createFrameScanner({ statusAddress: 1 });
  const frame = encodeBoardFrame(1, 0x93);
  assert.deepEqual(scanner.push(Uint8Array.from([0x00, 0xff, 0x13])), []);
  assert.deepEqual(scanner.push(frame.slice(0, 5)), []);
  assert.equal(scanner.pending(), 5);
  const out = scanner.push(frame.slice(5));
  assert.deepEqual(out, [
    { type: 'feedback', machineId: 1, feedback: { kind: 'tailgating', side: 'left' } },
  ]);
  assert.equal(scanner.discarded(), 3);
});

test('a frame that does not end in 7E where its length says is dropped, not trusted', () => {
  const frame = encodeBoardFrame(1, 0x62);
  frame[frame.length - 1] = 0x00;
  const good = encodeBoardFrame(1, 0x61);
  const out = parseFrames(Uint8Array.from([...frame, ...good]), 1);
  assert.deepEqual(out, [
    { type: 'feedback', machineId: 1, feedback: { kind: 'passed', side: 'left' } },
  ]);
});

test('an unlisted board code is surfaced as unknown rather than guessed at', () => {
  assert.deepEqual(parseFrames(encodeBoardFrame(2, 0x55), 1), [
    { type: 'board_unknown', machineId: 2, code: 0x55 },
  ]);
});

// --- §3 status ------------------------------------------------------------------

test('§3: the door and infrared queries carry the Modbus checksum', () => {
  assert.equal(hex(buildStatusQuery('door', 1)), '01 03 00 12 00 01 24 0F');
  assert.equal(hex(buildStatusQuery('infrared', 1)), '01 03 00 21 00 01 D4 00');
  assert.throws(() => buildStatusQuery('door', 0), RangeError);
});

test('§3.2 / §3.3: every door and infrared value reads to its named state', () => {
  DOOR_STATES.forEach((state, n) => {
    const [frame] = parseFrames(Uint8Array.from([0x01, 0x03, 0x02, 0x00, n, 0xaa, 0x55]), 1);
    assert.deepEqual(frame, { type: 'status', address: 1, value: n });
    assert.equal(doorStateOf(n), state);
  });
  INFRARED_STATES.forEach((state, n) => assert.equal(infraredStateOf(n), state));
  assert.equal(doorStateOf(42), 'unknown');
  assert.equal(infraredStateOf(9), 'unknown');
});

test('§3: a status reply is read for the configured address only', () => {
  const reply = Uint8Array.from([0x07, 0x03, 0x02, 0x00, 0x00, 0xaa, 0x55]);
  assert.deepEqual(parseFrames(reply, 7), [{ type: 'status', address: 7, value: 0 }]);
  assert.deepEqual(parseFrames(reply, 1), []);
});

// --- §4 settings -----------------------------------------------------------------

test('§4: an L-menu read is 55 01 nn 00 00 01 AA 55, and its reply is X1 high, X2 low', () => {
  assert.equal(hex(buildSettingRead(1)), '55 01 01 00 00 01 AA 55');
  assert.equal(hex(buildSettingRead(34)), '55 01 22 00 00 01 AA 55');
  assert.throws(() => buildSettingRead(0), RangeError);
  const replies = Uint8Array.from([
    ...[0x55, 0x01, 0x01, 0x00, 0x06, 0x00, 0xaa, 0x55],
    ...[0x55, 0x01, 0x22, 0x01, 0x2c, 0x01, 0xaa, 0x55],
    ...[0x55, 0x01, 0x09, 0x00, 0x00, 0x02, 0xaa, 0x55],
    ...[0x55, 0x02, 0x04, 0x00, 0x03, 0x00, 0xaa, 0x55],
  ]);
  assert.deepEqual(parseFrames(replies, 1), [
    { type: 'setting', menu: 'L', number: 1, value: 6, status: 'ok' },
    { type: 'setting', menu: 'L', number: 34, value: 300, status: 'read' },
    { type: 'setting', menu: 'L', number: 9, value: 0, status: 'failed' },
    { type: 'setting', menu: 'D', number: 4, value: 3, status: 'ok' },
  ]);
});

test('§4: the supply-voltage and infrared-pair reads, and the supply voltage in mV', () => {
  assert.equal(hex(buildSupplyVoltageRead()), '55 01 FF 00 00 00 AA 55');
  assert.equal(hex(buildInfraredPairsRead()), '55 01 FD 00 00 01 AA 55');
  const [frame] = parseFrames(Uint8Array.from([0x55, 0x01, 0xff, 0x5d, 0x00, 0x02, 0xaa, 0x55]), 1);
  assert.equal(frame?.type === 'setting' && frame.value, 0x5d00);
});

test('the three families interleave on one line and each is read whole', () => {
  const stream = Uint8Array.from([
    ...encodeBoardFrame(1, 0x80),
    ...[0x55, 0x01, 0x03, 0x00, 0x02, 0x00, 0xaa, 0x55],
    ...[0x01, 0x03, 0x02, 0x00, 0x01, 0xaa, 0x55],
    ...encodeBoardFrame(1, 0x62),
  ]);
  assert.deepEqual(
    parseFrames(stream, 1).map((f) => f.type),
    ['ack', 'setting', 'status', 'feedback'],
  );
});
