import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOutbox, saleFinalisedFact } from '../src/outbox';
import { BOX_ID, STATION_ID, openTestStore } from './_support';

/**
 * SCRUM-486 — ADOPTING AN EPOCH IS A COMPARE-AND-SET.
 *
 * The heartbeat, the push answer and a command's acknowledgement each adopt
 * the platform's epoch, on their own timers. Each used to read `box_state` and
 * then call `setEpoch`, which puts the sequence back at 1 unconditionally. Two
 * adoptions that both read the old epoch — the second resuming after a fact was
 * sealed at (new epoch, 1) — reset the sequence under that fact, and every later
 * fact then claimed seq 1 again, hit the journal's unique address, rolled back
 * and stayed at 1: the box could record nothing more. The platform's Postgres
 * edge store takes no lock on that read; the gate's reproduction against it is
 * `apps/api/test/box-epoch-adopt-race.test.ts`. Here, the store's own answer.
 */

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000ac486';
const quiet = { info() {}, warn() {}, error() {} };

test('advanceEpoch moves only forwards for "newer", to any other value for "different", and says whether it moved', async () => {
  const harness = openTestStore();
  try {
    await harness.store.init(BOX_ID);
    await harness.store.setEpoch(BOX_ID, 2);

    const same = await harness.store.advanceEpoch(BOX_ID, 2, 'newer');
    assert.equal(same.moved, false);
    const older = await harness.store.advanceEpoch(BOX_ID, 1, 'newer');
    assert.equal(older.moved, false);
    assert.equal(older.state.journalEpoch, 2, 'never backwards');
    const newer = await harness.store.advanceEpoch(BOX_ID, 3, 'newer');
    assert.deepEqual([newer.moved, newer.state.journalEpoch, newer.state.nextBoxSeq], [true, 3, 1]);

    const unchanged = await harness.store.advanceEpoch(BOX_ID, 3, 'different');
    assert.equal(unchanged.moved, false);
    const minted = await harness.store.advanceEpoch(BOX_ID, 5, 'different');
    assert.deepEqual([minted.moved, minted.state.journalEpoch], [true, 5]);
  } finally {
    harness.close();
  }
});

test('a second adoption of the same epoch, decided on a stale read, does not put the sequence back under a sealed fact', async () => {
  const harness = openTestStore();
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    privateKey: () => harness.keys.privateKeyPem,
    isOffline: async () => true,
    push: async () => {
      throw new Error('offline');
    },
    now: () => harness.now(),
    log: quiet,
  });
  const sale = () =>
    saleFinalisedFact({
      saleId: crypto.randomUUID(),
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      cart: { expectedTotalSatang: 0 },
      tenders: [],
    });
  try {
    await harness.store.init(BOX_ID);
    // B reads the old epoch...
    const staleRead = await harness.store.readState(BOX_ID);
    assert.equal(staleRead.journalEpoch, 1);
    // ...A adopts epoch 2, and a fact is sealed at (2, 1)...
    assert.equal((await harness.store.advanceEpoch(BOX_ID, 2, 'newer')).moved, true);
    const first = await outbox.queue(sale());
    assert.deepEqual([first.envelope.journalEpoch, first.envelope.boxSeq], [2, 1]);
    // ...then B, still believing the store is on 1, adopts 2 as well.
    assert.ok(2 > staleRead.journalEpoch);
    const late = await harness.store.advanceEpoch(BOX_ID, 2, 'newer');
    assert.equal(late.moved, false, 'the late adoption moves nothing');
    assert.deepEqual([late.state.journalEpoch, late.state.nextBoxSeq], [2, 2]);
    // And the journal goes on: the next fact takes (2, 2), not a refusal at (2, 1).
    const next = await outbox.queue(sale());
    assert.deepEqual([next.envelope.journalEpoch, next.envelope.boxSeq], [2, 2]);
  } finally {
    harness.close();
  }
});
