import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalSyncBytes } from '../src/contract';
import { verifyCanonical } from '../src/signing';
import { BOX_ID, openTestStore, plus, STATION_ID } from './_support';
import { clockTrustFor } from '../src/store-sql';
import { migrateSessionDocument, StoreSchemaTooNewError } from '../src/store';

const AT = '2026-09-20T03:00:00.000Z';

test('a queued fact is on disk with a gapless sequence', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  const first = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { phone: '+66811111111' } },
    harness.seal,
  );
  const second = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { phone: '+66822222222' } },
    harness.seal,
  );

  assert.equal(first.envelope.boxSeq, 1);
  assert.equal(second.envelope.boxSeq, 2);
  assert.equal(first.envelope.journalEpoch, 1);
  assert.equal((await harness.store.depth(BOX_ID)).queued, 2);
  harness.close();
});

test('a rolled back enqueue returns its sequence, so the journal has no gap', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: {} }, harness.seal);

  await assert.rejects(
    harness.store.enqueue(BOX_ID, { type: 'member.created', payload: {} }, () => {
      throw new Error('the signing key was unreadable');
    }),
  );

  const next = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  // Not 3: the sequence the failed transaction took went back with it. A gap
  // is indistinguishable from an event that went missing.
  assert.equal(next.envelope.boxSeq, 2);
  harness.close();
});

test('the envelope is signed over bytes that include the box, and tampering is visible', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const record = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { name: 'Nok' } },
    harness.seal,
  );

  const canonical = canonicalSyncBytes({ ...record.envelope, boxId: BOX_ID });
  assert.equal(verifyCanonical(canonical, record.envelope.sig, harness.keys.publicKeyPem), true);

  // The same envelope claimed by a different box does not verify: `boxId` is
  // hashed but is not a field, so the cloud adds it from the credential.
  const stolen = canonicalSyncBytes({ ...record.envelope, boxId: 'another-box' });
  assert.equal(verifyCanonical(stolen, record.envelope.sig, harness.keys.publicKeyPem), false);

  const edited = canonicalSyncBytes({
    ...record.envelope,
    boxId: BOX_ID,
    payload: { name: 'Somebody else' },
  });
  assert.equal(verifyCanonical(edited, record.envelope.sig, harness.keys.publicKeyPem), false);
  harness.close();
});

test('a power cut mid-push puts the batch back on the queue', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  for (let i = 0; i < 3; i += 1) {
    await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: { i } }, harness.seal);
  }
  const batch = await harness.store.takeBatch(BOX_ID);
  assert.equal(batch.events.length, 3);
  assert.equal((await harness.store.depth(BOX_ID)).queued, 3, 'in flight still counts as unacked');

  // The process dies here: three rows are `sending` and nobody knows whether
  // the cloud saw them. `init` is what the next boot runs.
  const recovered = await harness.store.init(BOX_ID);
  assert.equal(recovered.offline, false);
  const again = await harness.store.takeBatch(BOX_ID);
  assert.equal(again.events.length, 3);
  assert.deepEqual(
    again.events.map((event) => event.boxSeq),
    [1, 2, 3],
  );
  harness.close();
});

test('the offline flag and the epoch survive a restart', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  await harness.store.setOffline(BOX_ID, true, { reason: 'console' });
  await harness.store.setEpoch(BOX_ID, 2);
  for (let i = 0; i < 3; i += 1) {
    await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: { i } }, harness.seal);
  }

  const afterRestart = await harness.store.init(BOX_ID);
  assert.equal(afterRestart.offline, true);
  assert.equal(afterRestart.offlineReason, 'console');
  assert.equal(afterRestart.journalEpoch, 2);
  assert.equal((await harness.store.depth(BOX_ID)).queued, 3);
  harness.close();
});

test('a lost answer settles as a duplicate, not as a second member', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const record = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { phone: '+66811111111' } },
    harness.seal,
  );
  await harness.store.takeBatch(BOX_ID);

  // The cloud applied it and the acknowledgement was lost, so the box sends
  // again and is told `duplicate`. That means accepted, and the row is done.
  await harness.store.settle(
    BOX_ID,
    [{ eventId: record.envelope.eventId, boxSeq: 1, result: 'duplicate' }],
    {
      sent: [record.envelope.eventId],
      cursorSeq: 1,
      now: AT,
      retryAt: () => plus(AT, 1000),
    },
  );
  assert.equal((await harness.store.depth(BOX_ID)).queued, 0);
  harness.close();
});

test('the cloud cursor sweeps up a batch whose answer never arrived', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  for (let i = 0; i < 5; i += 1) {
    await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: { i } }, harness.seal);
  }
  const batch = await harness.store.takeBatch(BOX_ID);
  const sent = batch.events.map((event) => event.eventId);
  // Only the last event is named in the answer, but the cursor says the cloud
  // has everything up to 5 — and all five were handed over, so all five are
  // covered by that.
  await harness.store.settle(
    BOX_ID,
    [{ eventId: sent[4]!, boxSeq: 5, result: 'applied' }],
    { sent, cursorSeq: 5, now: AT, retryAt: () => plus(AT, 1000) },
  );
  assert.equal((await harness.store.depth(BOX_ID)).queued, 0);
  harness.close();
});

test('a cursor that jumped does not sweep events the box never sent', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const first = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { n: 1 } },
    harness.seal,
  );
  await harness.store.takeBatch(BOX_ID);
  // Queued AFTER the batch went out, so the cloud has never seen it. The
  // "Inject poison event" control used to push the cursor a million past the
  // high-water mark, and a sweep on `box_seq <= cursor` then acked this — a
  // fact that had never left the building, marked delivered.
  const unsent = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { n: 2 } },
    harness.seal,
  );

  await harness.store.settle(
    BOX_ID,
    [{ eventId: first.envelope.eventId, boxSeq: 1, result: 'applied' }],
    { sent: [first.envelope.eventId], cursorSeq: 1_000_001, now: AT, retryAt: () => AT },
  );

  assert.equal((await harness.store.depth(BOX_ID)).queued, 1);
  const next = await harness.store.takeBatch(BOX_ID, { now: AT });
  assert.deepEqual(
    next.events.map((event) => event.eventId),
    [unsent.envelope.eventId],
    'it is still there to be sent',
  );
  harness.close();
});

test('an answer that says nothing about an event it was sent leaves it to be retried', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  for (let i = 0; i < 2; i += 1) {
    await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: { i } }, harness.seal);
  }
  const batch = await harness.store.takeBatch(BOX_ID);
  const sent = batch.events.map((event) => event.eventId);

  // The cloud named the first and its cursor stops there, so it has said
  // nothing at all about the second. Silence above the cursor is not consent.
  await harness.store.settle(
    BOX_ID,
    [{ eventId: sent[0]!, boxSeq: 1, result: 'applied' }],
    { sent, cursorSeq: 1, now: AT, retryAt: () => plus(AT, 60_000) },
  );

  assert.equal((await harness.store.depth(BOX_ID)).queued, 1);
  const retried = await harness.store.takeBatch(BOX_ID, { now: plus(AT, 61_000) });
  assert.deepEqual(
    retried.events.map((event) => event.eventId),
    [sent[1]],
  );
  harness.close();
});

test('an answer naming an event this batch did not carry moves nothing', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const queued = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );

  // Nothing was taken, so nothing was sent. An answer claiming this event was
  // applied is either a confused cloud or somebody else's batch.
  await harness.store.settle(
    BOX_ID,
    [{ eventId: queued.envelope.eventId, boxSeq: 1, result: 'applied' }],
    { sent: [], cursorSeq: 1, now: AT, retryAt: () => AT },
  );
  assert.equal((await harness.store.depth(BOX_ID)).queued, 1);
  harness.close();
});

test('a quarantined event is parked and a rejected one is retried later', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const poison = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { n: 1 } },
    harness.seal,
  );
  const transient = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { n: 2 } },
    harness.seal,
  );
  await harness.store.takeBatch(BOX_ID);

  await harness.store.settle(
    BOX_ID,
    [
      { eventId: poison.envelope.eventId, boxSeq: 1, result: 'quarantined', reason: 'poison' },
      {
        eventId: transient.envelope.eventId,
        boxSeq: 2,
        result: 'rejected',
        errorCode: 'APPLY_FAILED',
      },
    ],
    {
      sent: [poison.envelope.eventId, transient.envelope.eventId],
      cursorSeq: 0,
      now: AT,
      retryAt: () => plus(AT, 60_000),
    },
  );

  // The quarantined one is a person's problem now and is not retried; the
  // rejected one waits out its backoff and comes back.
  assert.equal((await harness.store.depth(BOX_ID)).queued, 1);
  assert.equal((await harness.store.takeBatch(BOX_ID, { now: AT })).events.length, 0);
  const afterBackoff = await harness.store.takeBatch(BOX_ID, { now: plus(AT, 61_000) });
  assert.equal(afterBackoff.events.length, 1);
  assert.equal(afterBackoff.events[0]?.boxSeq, 2);
  harness.close();
});

test('a refusal below the cloud cursor is retried, not swept away', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const refused = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  await harness.store.takeBatch(BOX_ID);

  // The cursor has moved past it AND the cloud said "try again". Sweeping on
  // the cursor alone would turn that into a lost sale.
  await harness.store.settle(
    BOX_ID,
    [
      {
        eventId: refused.envelope.eventId,
        boxSeq: 1,
        result: 'rejected',
        errorCode: 'APPLY_FAILED',
      },
    ],
    {
      sent: [refused.envelope.eventId],
      cursorSeq: 5,
      now: AT,
      retryAt: () => plus(AT, 60_000),
    },
  );
  assert.equal((await harness.store.depth(BOX_ID)).queued, 1);
  assert.equal((await harness.store.takeBatch(BOX_ID, { now: plus(AT, 61_000) })).events.length, 1);
  harness.close();
});

test('a quarantined event is never picked up again, whatever the clock says', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const poison = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  await harness.store.takeBatch(BOX_ID);
  await harness.store.settle(
    BOX_ID,
    [{ eventId: poison.envelope.eventId, boxSeq: 1, result: 'quarantined', reason: 'poison' }],
    { sent: [poison.envelope.eventId], cursorSeq: 1, now: AT, retryAt: () => AT },
  );
  assert.equal((await harness.store.takeBatch(BOX_ID, { now: AT })).events.length, 0);
  assert.equal(
    (await harness.store.takeBatch(BOX_ID, { now: plus(AT, 86_400_000) })).events.length,
    0,
  );
  assert.equal(
    (await harness.store.depth(BOX_ID)).queued,
    0,
    'it is on Failures, not in the queue',
  );
  harness.close();
});

test('a batch is bounded by count and by bytes, and one huge event still goes', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  for (let i = 0; i < 6; i += 1) {
    await harness.store.enqueue(
      BOX_ID,
      { type: 'member.created', payload: { blob: 'x'.repeat(400) } },
      harness.seal,
    );
  }

  const two = await harness.store.takeBatch(BOX_ID, { maxEvents: 2 });
  assert.equal(two.events.length, 2);

  // Measured rather than guessed: the canonical form carries ids and stamps
  // as well as the payload, and a hard-coded number here would only be
  // asserting what the envelope happens to weigh today.
  const one = Buffer.byteLength(canonicalSyncBytes({ ...two.events[0], boxId: BOX_ID }), 'utf8');
  const byBytes = await harness.store.takeBatch(BOX_ID, { maxBytes: one * 2 + 10 });
  assert.equal(byBytes.events.length, 2, 'the cap stops the batch rather than the queue');

  await harness.store.init(BOX_ID);
  const oversized = await harness.store.takeBatch(BOX_ID, { maxBytes: 10 });
  assert.equal(
    oversized.events.length,
    1,
    'a single event over the cap goes on its own rather than never',
  );
  harness.close();
});

test('"Replay last batch" puts accepted events back and the cloud sees duplicates', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  for (let i = 0; i < 3; i += 1) {
    await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: { i } }, harness.seal);
  }
  const accepted = await harness.store.takeBatch(BOX_ID);
  await harness.store.settle(BOX_ID, [], {
    sent: accepted.events.map((event) => event.eventId),
    cursorSeq: 3,
    now: AT,
    retryAt: () => AT,
  });
  assert.equal((await harness.store.depth(BOX_ID)).queued, 0);

  assert.equal(await harness.store.requeueAcked(BOX_ID, 3), 3);
  const replay = await harness.store.takeBatch(BOX_ID);
  assert.deepEqual(
    replay.events.map((event) => event.boxSeq),
    [1, 2, 3],
    'the same three sequences go up again, which is what makes them duplicates',
  );
  harness.close();
});

test('a clock the box knows is wrong is stamped on the event, not hidden', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  const honest = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  assert.equal(honest.envelope.clockTrust, 'trusted');

  await harness.store.setClockSkew(BOX_ID, 45 * 60_000);
  const skewed = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  assert.equal(skewed.envelope.clockTrust, 'skewed');
  assert.equal(skewed.envelope.clockOffsetMs, 45 * 60_000);

  await harness.store.setClockSkew(BOX_ID, 3 * 24 * 60 * 60_000);
  const lost = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  assert.equal(lost.envelope.clockTrust, 'untrusted');
  harness.close();
});

test('clock trust has the boundaries the comment claims', () => {
  assert.equal(clockTrustFor(0), 'trusted');
  assert.equal(clockTrustFor(-5 * 60_000), 'trusted');
  assert.equal(clockTrustFor(5 * 60_000 + 1), 'skewed');
  assert.equal(clockTrustFor(24 * 60 * 60_000), 'skewed');
  assert.equal(clockTrustFor(24 * 60 * 60_000 + 1), 'untrusted');
});

test('a cache bundle from a newer agent is dropped rather than half understood', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  await harness.store.writeBundle(BOX_ID, {
    scope: 'catalogue',
    schemaVersion: 1,
    cursorSeq: 12,
    payload: { packages: [{ id: 'p1', name: 'Day pass' }] },
    appliedAt: AT,
  });
  assert.equal((await harness.store.readBundle(BOX_ID, 'catalogue'))?.cursorSeq, 12);

  await harness.store.writeBundle(BOX_ID, {
    scope: 'members',
    schemaVersion: 99,
    cursorSeq: 3,
    payload: {},
    appliedAt: AT,
  });
  // A cache is rebuildable, so the honest answer is to have none and pull
  // again — unlike the outbox, where refusing to read would be losing sales.
  assert.equal(await harness.store.readBundle(BOX_ID, 'members'), null);
  harness.close();
});

test('a document written by a newer box is refused rather than misread', () => {
  assert.throws(
    () =>
      migrateSessionDocument({
        stationId: STATION_ID,
        boxId: BOX_ID,
        schemaVersion: 99,
        sequence: 0,
        stage: 'identify',
        language: 'en',
        lease: null,
        takeoverCount: 0,
        updatedAt: AT,
      }),
    StoreSchemaTooNewError,
  );
});
