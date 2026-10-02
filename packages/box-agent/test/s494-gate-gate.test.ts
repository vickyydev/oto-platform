import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBandCode, planLedgerBands, ulidFromUuid } from '@oto/shared';

import { decideGate, type GateDecisionInput } from '../src/gate/decision';
import { bandCopyFrom } from '../src/gate/host';
import { uuidv7 } from '../src/signing';

/**
 * SCRUM-494 gate review, register item 4: Gate access on a ticket decides
 * whether its adult bands operate the gate; with it on, the gate behaves as
 * before (a revoked adult is still let out, OD-A4).
 */

const KEY = 'gate-test-band-key-0123456789abcdef';

function band(): { id: string; code: string } {
  const id = uuidv7();
  return { id, code: mintBandCode('T1', ulidFromUuid(id), KEY) };
}

function input(over: Partial<GateDecisionInput> & Pick<GateDecisionInput, 'code'>): GateDecisionInput {
  return {
    direction: 'entry',
    key: KEY,
    lookup: () => ({ state: 'unknown' }),
    inside: () => false,
    unknownMeans: 'offline',
    ...over,
  };
}

test('Gate access on: a revoked adult is refused entry and still let out (OD-A4)', () => {
  const b = band();
  const copy = bandCopyFrom([], [{ revokedBands: [{ id: b.id, kind: 'adult', gateAccess: true }] }]);
  assert.equal(decideGate(input({ code: b.code, lookup: copy.lookup })).open, false);
  assert.deepEqual(decideGate(input({ code: b.code, direction: 'exit', lookup: copy.lookup, inside: () => true })), {
    open: true,
    bandId: b.id,
    direction: 'exit',
    exitWithoutEntry: false,
    revoked: true,
    message: 'Goodbye / ขอบคุณที่มาเที่ยว',
  });
});

test('Gate access off: refused even while the box holds the band as inside', () => {
  const b = band();
  const copy = bandCopyFrom([{ id: b.id, kind: 'adult', status: 'active', gateAccess: false }], []);
  for (const direction of ['entry', 'exit'] as const) {
    const decision = decideGate(input({ code: b.code, direction, lookup: copy.lookup, inside: () => true }));
    assert.equal(decision.open, false);
    assert.equal(decision.open === false && decision.reason, 'NO_GATE_ACCESS');
  }
});

test('a line whose adults are all free takes Gate access from its own row; its kids never have it', () => {
  const plan = planLedgerBands([
    { id: 'k', cartLineId: 'c', kind: 'kids', ticket: true, kidCount: 1, adultCount: 2, freeAdultCount: 2, gateAccess: true },
    { id: 'f', cartLineId: 'c', kind: 'adults_free', ticket: true, kidCount: 1, adultCount: 2, freeAdultCount: 2, gateAccess: true },
  ]);
  assert.deepEqual(
    plan.map((p) => [p.kind, p.saleLineId, p.gateAccess]),
    [
      ['kid', 'k', false],
      ['adult', 'f', true],
      ['adult', 'f', true],
    ],
  );
});
