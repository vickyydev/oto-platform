import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GATE_EVENT_TYPE, GateEventPayloadSchema, mintBandCode, ulidFromUuid } from '@oto/shared';

import {
  GATE_MESSAGES,
  commitPassage,
  decideGate,
  gateEventFact,
  type BandLookup,
  type GateDecisionInput,
} from '../src/gate/decision';
import { bandCopyFrom } from '../src/gate/host';
import { uuidv7 } from '../src/signing';

/**
 * The access decision (S2-12 round 2, plan §2.5): the decision table the
 * round's tests are required to prove, over real signed band codes.
 */

const KEY = 'gate-test-band-key-0123456789abcdef';
const OTHER_KEY = 'some-other-parks-key-0123456789abcd';

function band(key = KEY): { id: string; code: string } {
  const id = uuidv7();
  return { id, code: mintBandCode('T1', ulidFromUuid(id), key) };
}

function input(
  over: Partial<GateDecisionInput> & Pick<GateDecisionInput, 'code'>,
): GateDecisionInput {
  return {
    direction: 'entry',
    key: KEY,
    lookup: () => ({ state: 'unknown' }),
    inside: () => false,
    unknownMeans: 'offline',
    ...over,
  };
}

const adult: BandLookup = { state: 'active', kind: 'adult' };

test('an adult band enters', () => {
  const b = band();
  const d = decideGate(input({ code: b.code, lookup: () => adult }));
  assert.deepEqual(d, {
    open: true,
    bandId: b.id,
    direction: 'entry',
    exitWithoutEntry: false,
    revoked: false,
    message: GATE_MESSAGES.welcome,
  });
});

test('the same adult again, after a committed entry, is refused ANTI_PASSBACK', () => {
  const b = band();
  const d = decideGate(input({ code: b.code, lookup: () => adult, inside: (id) => id === b.id }));
  assert.equal(d.open, false);
  assert.equal(!d.open && d.reason, 'ANTI_PASSBACK');
  assert.equal(!d.open && d.bandId, b.id);
});

test('an adult inside exits', () => {
  const b = band();
  const d = decideGate(
    input({ code: b.code, direction: 'exit', lookup: () => adult, inside: () => true }),
  );
  assert.equal(d.open, true);
  assert.equal(d.open && d.exitWithoutEntry, false);
  assert.equal(d.message, GATE_MESSAGES.goodbye);
});

test('exit without entry is let out and flagged (OD-A4)', () => {
  const b = band();
  const d = decideGate(input({ code: b.code, direction: 'exit', lookup: () => adult }));
  assert.equal(d.open, true);
  assert.equal(d.open && d.exitWithoutEntry, true);
});

test("a kid's band never operates the gate, in either direction (C8, OD-A6)", () => {
  const b = band();
  for (const direction of ['entry', 'exit'] as const) {
    const d = decideGate(
      input({ code: b.code, direction, lookup: () => ({ state: 'active', kind: 'kid' }) }),
    );
    assert.equal(!d.open && d.reason, 'KID_BAND');
    assert.equal(d.message, GATE_MESSAGES.KID_BAND);
  }
});

test('a revoked band is refused at the entry, and let out at the exit flagged revoked', () => {
  const b = band();
  const revoked: BandLookup = { state: 'revoked', kind: 'adult' };
  const inD = decideGate(input({ code: b.code, lookup: () => revoked }));
  assert.equal(!inD.open && inD.reason, 'BAND_REVOKED');
  const outD = decideGate(
    input({ code: b.code, direction: 'exit', lookup: () => revoked, inside: () => true }),
  );
  assert.equal(outD.open && outD.revoked, true);
});

test('a band unknown to the copy, offline, is sent to reception (OD-A5); after a refresh it is not found', () => {
  const b = band();
  const offline = decideGate(input({ code: b.code }));
  assert.equal(!offline.open && offline.reason, 'BAND_UNKNOWN_OFFLINE');
  assert.equal(offline.message, GATE_MESSAGES.BAND_UNKNOWN_OFFLINE);
  assert.equal(!offline.open && offline.bandId, b.id);
  const online = decideGate(input({ code: b.code, unknownMeans: 'not_found' }));
  assert.equal(!online.open && online.reason, 'BAND_NOT_FOUND');
});

test('a code that is not a band — a booking QR, a voucher, a card id — is not admissible', () => {
  for (const code of ['BK-2F7Q-9XKM', '01AD2136', 'https://example.test/v/abc', '', 'T1-7KMQ4X']) {
    const d = decideGate(input({ code, lookup: () => adult }));
    assert.equal(!d.open && d.reason, 'NOT_A_BAND', code);
    assert.equal(!d.open && d.bandId, null);
  }
});

test('a tampered band — one character changed, or signed with another key — is refused and names no band', () => {
  const b = band();
  const at = b.code.indexOf('.') - 1;
  const swap = b.code[at] === 'A' ? 'B' : 'A';
  const tampered = b.code.slice(0, at) + swap + b.code.slice(at + 1);
  for (const code of [tampered, band(OTHER_KEY).code]) {
    const d = decideGate(input({ code, lookup: () => adult }));
    assert.equal(!d.open && d.reason, 'BAND_INVALID');
    assert.equal(!d.open && d.bandId, null);
  }
});

test('a box with no usable key admits nobody', () => {
  const b = band();
  assert.equal(
    (decideGate(input({ code: b.code, key: null, lookup: () => adult })) as { reason: string })
      .reason,
    'BOX_NOT_READY',
  );
  assert.equal(
    (decideGate(input({ code: b.code, key: 'short', lookup: () => adult })) as { reason: string })
      .reason,
    'BOX_NOT_READY',
  );
});

test('the copy: active bands from `bands`, revoked ones named by the deny list win over it', () => {
  const a = uuidv7();
  const k = uuidv7();
  const r = uuidv7();
  const replaced = uuidv7();
  const copy = bandCopyFrom(
    [
      { id: a, kind: 'adult', status: 'active' },
      { id: k, kind: 'kid', status: 'active' },
      { id: r, kind: 'adult', status: 'active' },
      { id: replaced, kind: 'adult', status: 'replaced' },
      { id: 'junk' },
    ],
    [{ revokedAccountIds: [], revokedTokenIds: [], revokedBands: [{ id: r, kind: 'adult' }] }],
  );
  assert.deepEqual(copy.lookup(a), { state: 'active', kind: 'adult' });
  assert.deepEqual(copy.lookup(k.toUpperCase()), { state: 'active', kind: 'kid' });
  assert.deepEqual(copy.lookup(r), { state: 'revoked', kind: 'adult' });
  assert.deepEqual(copy.lookup(replaced), { state: 'revoked', kind: 'adult' });
  assert.deepEqual(copy.lookup(uuidv7()), { state: 'unknown' });
});

test('anti-passback commits: in counts one, out takes one off, never below zero', () => {
  assert.deepEqual(commitPassage(false, 'entry', 0), {
    inside: true,
    count: 1,
    exitWithoutEntry: false,
  });
  assert.deepEqual(commitPassage(true, 'exit', 1), {
    inside: false,
    count: 0,
    exitWithoutEntry: false,
  });
  assert.deepEqual(commitPassage(false, 'exit', 0), {
    inside: false,
    count: 0,
    exitWithoutEntry: true,
  });
});

test('the journal fact matches the shared wire schema and carries no code', () => {
  const b = band();
  const fact = gateEventFact({
    eventId: uuidv7(),
    bandId: b.id,
    kind: 'denied',
    direction: 'entry',
    side: 'left',
    stationId: uuidv7(),
    occurredAt: new Date().toISOString(),
    reason: 'ANTI_PASSBACK',
    offline: true,
  });
  assert.equal(fact.type, GATE_EVENT_TYPE);
  assert.equal(fact.actorKind, 'device');
  assert.equal(GateEventPayloadSchema.safeParse(fact.payload).success, true);
  assert.equal(JSON.stringify(fact).includes(b.code), false);
});
