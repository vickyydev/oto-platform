import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HidBurstReader,
  SerialScanReader,
  buttonKeyProblem,
  simulateHidKeys,
  simulateSerialRecord,
  stripCodeId,
} from '../src/scan-input';

/**
 * The burst rule (S2-06).
 *
 * This is the part of scanning that is genuinely hard to get right, and the
 * part where a wrong answer is expensive in both directions: a scan mistaken
 * for typing is a gate that does not open, and typing mistaken for a scan is a
 * code delivered into the middle of somebody's sale. So each rule is driven
 * character by character, at the timings DEVICE_INVENTORY §9.2 measured on the
 * real device — 0, 20 and 40 ms per keystroke — rather than asserted in prose.
 */

const CODE = 'T1-01J8ZQ4F7K';

test('a wedge burst ending in Enter is one scan', () => {
  const reader = new HidBurstReader();
  let scanned: string | null = null;
  for (const key of simulateHidKeys(CODE, { interCharDelayMs: 0 })) {
    const event = reader.push(key);
    if (event?.kind === 'scan') scanned = event.input.code;
  }
  assert.equal(scanned, CODE);
  assert.equal(reader.open, false);
});

test('the slowest keystroke delay the scanner offers is still a scan', () => {
  // "USB Keystroke Delay: Long" is 40 ms per character (PRG p.8-8), which is
  // why the threshold is 50 and not 25.
  const reader = new HidBurstReader();
  let scanned: string | null = null;
  for (const key of simulateHidKeys(CODE, { interCharDelayMs: 40 })) {
    const event = reader.push(key);
    if (event?.kind === 'scan') scanned = event.input.code;
  }
  assert.equal(scanned, CODE);
});

test('a person typing the same code is not a scan', () => {
  const reader = new HidBurstReader();
  const events: string[] = [];
  // 120 ms per key: brisk typing, and well over the 50 ms threshold.
  for (const key of simulateHidKeys(CODE, { interCharDelayMs: 120 })) {
    const event = reader.push(key);
    if (event) events.push(event.kind);
  }
  assert.equal(
    events.includes('scan'),
    false,
    'typing at 120 ms per key must never be delivered as a scan',
  );
});

test('a burst with no suffix is closed by the quiet gap and DISCARDED', () => {
  const reader = new HidBurstReader();
  for (const key of simulateHidKeys(CODE, { interCharDelayMs: 0, withSuffix: false })) {
    reader.push(key);
  }
  assert.equal(reader.open, true, 'with no terminator the burst is still open');
  const closed = reader.tick(10_000);
  assert.equal(closed?.kind, 'partial');
  assert.equal(closed?.kind === 'partial' ? closed.reason : null, 'timeout');
  // The whole point: half a band code is not a shorter band code. Nothing is
  // delivered, and the caller is told something was dropped so the Box log
  // drawer can say "the scanner's suffix is not set" rather than nothing.
  assert.equal(reader.open, false);
});

test('a short burst is dropped rather than delivered as a code', () => {
  const reader = new HidBurstReader({ minLength: 6 });
  let out: unknown = null;
  for (const key of simulateHidKeys('AB1', { interCharDelayMs: 0 })) {
    const event = reader.push(key);
    if (event) out = event;
  }
  assert.equal((out as { kind: string }).kind, 'partial');
  assert.equal((out as { reason: string }).reason, 'too_short');
});

test('a bare Enter passes through untouched — it is somebody submitting a form', () => {
  const reader = new HidBurstReader();
  assert.equal(reader.push({ key: 'Enter', at: 0 }), null);
});

test('the counter button is told apart from a scanner’s Enter', () => {
  const reader = new HidBurstReader({ buttonKey: 'F9' });
  const press = reader.push({ key: 'F9', at: 0 });
  assert.equal(press?.kind, 'button');

  // And the scanner's own suffix, on the same device, is still a scan.
  let scanned: string | null = null;
  for (const key of simulateHidKeys(CODE, { interCharDelayMs: 0, startAt: 1_000 })) {
    const event = reader.push(key);
    if (event?.kind === 'scan') scanned = event.input.code;
  }
  assert.equal(scanned, CODE);
});

test('a button key arriving inside an open burst loses to the scan', () => {
  const reader = new HidBurstReader({ buttonKey: 'F9' });
  const keys = simulateHidKeys(CODE, { interCharDelayMs: 0 });
  const half = Math.floor(keys.length / 2);
  for (const key of keys.slice(0, half)) reader.push(key);
  assert.equal(reader.push({ key: 'F9', at: keys[half]!.at }), null);
  let scanned: string | null = null;
  for (const key of keys.slice(half)) {
    const event = reader.push(key);
    if (event?.kind === 'scan') scanned = event.input.code;
  }
  assert.equal(scanned, CODE, 'the scan survives a button pressed in the middle of it');
});

test('Enter may not be configured as the button', () => {
  assert.notEqual(buttonKeyProblem('Enter'), null);
  assert.notEqual(buttonKeyProblem('NumpadEnter'), null);
  // A printable key would be typed into a code mid-scan.
  assert.notEqual(buttonKeyProblem('a'), null);
  assert.equal(buttonKeyProblem('F9'), null);
  assert.throws(() => new HidBurstReader({ buttonKey: 'Enter' }), /Enter/);
});

test('a modifier in the middle of a burst does not break the scan', () => {
  const reader = new HidBurstReader();
  const keys = simulateHidKeys(CODE, { interCharDelayMs: 0 });
  let scanned: string | null = null;
  for (const [i, key] of keys.entries()) {
    if (i === 4) reader.push({ key: 'Shift', at: key.at });
    const event = reader.push(key);
    if (event?.kind === 'scan') scanned = event.input.code;
  }
  assert.equal(scanned, CODE);
});

// --- USB CDC ----------------------------------------------------------------

test('a CDC record ends at CR, LF or CRLF', () => {
  for (const delimiter of ['\r', '\n', '\r\n']) {
    const reader = new SerialScanReader();
    const out = reader.push(`${CODE}${delimiter}`, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.code, CODE);
  }
});

test('a CDC record with NO terminator is finished by half a second of silence', () => {
  // The measured behaviour of this firmware family: no length field, no
  // header, and by default no terminator on the wire at all.
  const reader = new SerialScanReader();
  assert.deepEqual(reader.push(simulateSerialRecord(CODE, { withSuffix: false }), 0), []);
  assert.equal(reader.tick(200), null, 'still inside the quiet gap');
  assert.equal(reader.tick(600)?.code, CODE);
});

test('two records in one chunk are two scans', () => {
  const reader = new SerialScanReader();
  const out = reader.push(`${CODE}\r\nB1-SECOND\r\n`, 0);
  assert.deepEqual(
    out.map((r) => r.code),
    [CODE, 'B1-SECOND'],
  );
});

test('a record split across chunks is one scan', () => {
  const reader = new SerialScanReader();
  assert.deepEqual(reader.push('T1-01J8', 0), []);
  const out = reader.push('ZQ4F7K\r', 10);
  assert.equal(out[0]?.code, CODE);
});

test('a Symbol code ID prefix is stripped', () => {
  assert.equal(stripCodeId(']C0' + CODE), CODE);
  assert.equal(stripCodeId(']Q1' + CODE), CODE);
  assert.equal(stripCodeId(CODE), CODE, 'a code that merely starts oddly is left alone');
  const reader = new SerialScanReader();
  assert.equal(reader.push(simulateSerialRecord(CODE, { codeId: ']Q1' }), 0)[0]?.code, CODE);
});
