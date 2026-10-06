import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBandCode, planLedgerBands, ulidFromUuid } from '@oto/shared';

import { GATE_MESSAGES, decideGate, type GateDecisionInput } from '../src/gate/decision';
import { bandCopyFrom } from '../src/gate/host';
import { readOfflineCatalogue } from '../src/offline-pricing';
import { uuidv7 } from '../src/signing';

/**
 * SCRUM-494 register item 4 — the gate checks the band's Gate access flag
 * (BL §7.1 "the gate reader checks this flag only", R-83). A band from a
 * ticket with Gate access off is refused as a kids band is, in either
 * direction; it follows its group instead.
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

test('an adult band without Gate access is refused at entry and at exit', () => {
  const b = band();
  const copy = bandCopyFrom([{ id: b.id, kind: 'adult', status: 'active', gateAccess: false }], []);
  for (const direction of ['entry', 'exit'] as const) {
    assert.deepEqual(decideGate(input({ code: b.code, direction, lookup: copy.lookup })), {
      open: false,
      reason: 'NO_GATE_ACCESS',
      bandId: b.id,
      message: GATE_MESSAGES.NO_GATE_ACCESS,
    });
  }
});

test('an adult band with Gate access enters and leaves', () => {
  const b = band();
  const copy = bandCopyFrom([{ id: b.id, kind: 'adult', status: 'active', gateAccess: true }], []);
  assert.equal(decideGate(input({ code: b.code, lookup: copy.lookup })).open, true);
  assert.equal(decideGate(input({ code: b.code, direction: 'exit', lookup: copy.lookup })).open, true);
});

test('a kids band is still refused as a kids band', () => {
  const b = band();
  const copy = bandCopyFrom([{ id: b.id, kind: 'kid', status: 'active', gateAccess: false }], []);
  const d = decideGate(input({ code: b.code, lookup: copy.lookup }));
  assert.equal(d.open, false);
  assert.equal(d.open === false && d.reason, 'KID_BAND');
});

test('a copy with no flag (an older platform) leaves the kind rule to decide', () => {
  const b = band();
  const copy = bandCopyFrom([{ id: b.id, kind: 'adult', status: 'active' }], []);
  assert.deepEqual(copy.lookup(b.id), { state: 'active', kind: 'adult' });
  assert.equal(decideGate(input({ code: b.code, lookup: copy.lookup })).open, true);
});

test('a revoked band keeps its flag from the deny list, or from the bands copy', () => {
  const listed = band();
  const copied = band();
  const copy = bandCopyFrom(
    [{ id: copied.id, kind: 'adult', status: 'active', gateAccess: false }],
    [
      {
        revokedBands: [
          { id: listed.id, kind: 'adult', gateAccess: false },
          { id: copied.id, kind: 'adult' },
        ],
      },
    ],
  );
  assert.deepEqual(copy.lookup(listed.id), { state: 'revoked', kind: 'adult', gateAccess: false });
  assert.deepEqual(copy.lookup(copied.id), { state: 'revoked', kind: 'adult', gateAccess: false });
  // A refunded adult with Gate access is let out (OD-A4); one without it is not.
  const out = decideGate(input({ code: listed.code, direction: 'exit', lookup: copy.lookup }));
  assert.equal(out.open === false && out.reason, 'NO_GATE_ACCESS');
});

test('the box reads each ticket Gate access from its catalogue, and its bands take it', () => {
  const catalogue = readOfflineCatalogue({
    items: [
      {
        packages: [
          { id: 'p-on', name: 'On', prices: {}, gateAccess: true },
          { id: 'p-off', name: 'Off', prices: {}, gateAccess: false },
          { id: 'p-unset', name: 'Unset', prices: {} },
        ],
      },
    ],
  })!;
  assert.equal(catalogue.packages.get('p-on')!.gateAccess, true);
  assert.equal(catalogue.packages.get('p-off')!.gateAccess, false);
  assert.equal(catalogue.packages.get('p-unset')!.gateAccess, false);

  const plan = planLedgerBands([
    { id: 'a', cartLineId: 'c-on', kind: 'adults_paid', ticket: true, kidCount: 1, adultCount: 1, freeAdultCount: 0, gateAccess: true },
    { id: 'b', cartLineId: 'c-off', kind: 'adults_paid', ticket: true, kidCount: 0, adultCount: 1, freeAdultCount: 0, gateAccess: false },
  ]);
  assert.deepEqual(
    plan.map((p) => [p.kind, p.cartLineId, p.gateAccess]),
    [
      ['kid', 'c-on', false],
      ['adult', 'c-on', true],
      ['adult', 'c-off', false],
    ],
  );
});
