import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { canonicalSyncBytes } from '../src/contract';
import { verifyCanonical } from '../src/signing';
import { BOX_ID, openTestStore, plus, STATION_ID } from './_support';
import { BOX_LOCAL_TABLES, clockTrustFor, SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import {
  backoffMs,
  BoxStoreFeatureMissingError,
  migrateSessionDocument,
  OUTBOX_BACKOFF_CAP_MS,
  StoreSchemaTooNewError,
  type ClockStamp,
  type PrintJobRecord,
} from '../src/store';

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

/**
 * A retry time further off than any backoff (SCRUM-402, round 2).
 *
 * Every retry time is the box's clock plus a backoff that never passes
 * `OUTBOX_BACKOFF_CAP_MS`, so one further off than that was counted from a
 * clock that has since gone back: a box that booted hours ahead, deferred a
 * push, and then measured itself against the platform. It is due now. One
 * inside the cap is an ordinary backoff and still waits its turn.
 */
test('a retry time further off than any backoff is due now; one inside it waits', async () => {
  for (let attempts = 1; attempts <= 40; attempts += 1) {
    assert.ok(backoffMs(attempts) <= OUTBOX_BACKOFF_CAP_MS, `a backoff past the cap at ${attempts}`);
  }

  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const stretched = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { n: 1 } },
    harness.seal,
  );
  const waiting = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: { n: 2 } },
    harness.seal,
  );
  await harness.store.takeBatch(BOX_ID, { now: AT });
  // Deferred on a clock twelve hours ahead of the one the store now reads.
  await harness.store.releaseBatch(BOX_ID, [stretched.envelope.eventId], {
    errorCode: 'PUSH_503',
    errorMessage: 'The cloud answered 503',
    retryAt: plus(AT, 12 * 3_600_000),
  });
  // Deferred by the longest backoff there is, on the clock the store reads.
  await harness.store.releaseBatch(BOX_ID, [waiting.envelope.eventId], {
    errorCode: 'PUSH_503',
    errorMessage: 'The cloud answered 503',
    retryAt: plus(AT, OUTBOX_BACKOFF_CAP_MS),
  });

  const now = await harness.store.takeBatch(BOX_ID, { now: AT });
  assert.deepEqual(
    now.events.map((event) => event.eventId),
    [stretched.envelope.eventId],
    'the stretched retry was held, or the ordinary one was not',
  );
  assert.equal((await harness.store.takeBatch(BOX_ID, { now: plus(AT, 1_000) })).events.length, 0);
  const due = await harness.store.takeBatch(BOX_ID, { now: plus(AT, OUTBOX_BACKOFF_CAP_MS) });
  assert.deepEqual(
    due.events.map((event) => event.eventId),
    [waiting.envelope.eventId],
  );
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

/**
 * The test control's skew decides an event's trust only in a store no agent
 * has stamped (SCRUM-402). A running box stamps from its measurement against
 * the platform — see the case after this one — and the skew moves its raw
 * clock for that measurement to find.
 */
test('a store no agent has stamped reads the test control’s skew onto the event', async () => {
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

test('the agent’s stamp decides an event’s trust, inside a transaction too, and the skew does not', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  // Three days of test-control skew, which on its own would read `untrusted`
  // with a three-day offset: under a stamp it decides nothing.
  await harness.store.setClockSkew(BOX_ID, 3 * 24 * 60 * 60_000);
  let stamp: ClockStamp = { clockTrust: 'untrusted' };
  harness.store.stampClockWith(BOX_ID, () => stamp);

  const unmeasured = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  assert.equal(unmeasured.envelope.clockTrust, 'untrusted');
  assert.equal(unmeasured.envelope.clockOffsetMs, undefined, 'no offset where the box has none');

  // Measured: trusted, with what the correction left over. A spin's two facts
  // are queued on the store a transaction hands out, and carry it as well.
  stamp = { clockTrust: 'trusted', clockOffsetMs: 0 };
  const pair = await harness.store.atomically((tx) =>
    tx.enqueueMany(
      BOX_ID,
      [
        { type: 'booth.spin_recorded', payload: {} },
        { type: 'promo.voucher_issued', payload: {} },
      ],
      harness.seal,
    ),
  );
  for (const record of pair) {
    assert.equal(record.envelope.clockTrust, 'trusted');
    assert.equal(record.envelope.clockOffsetMs, 0);
  }

  // What was written is what goes up.
  const batch = await harness.store.takeBatch(BOX_ID);
  assert.deepEqual(
    batch.events.map((event) => [event.clockTrust, event.clockOffsetMs]),
    [
      ['untrusted', undefined],
      ['trusted', 0],
      ['trusted', 0],
    ],
  );

  // Taken away, the store falls back on the skew.
  harness.store.stampClockWith(BOX_ID, null);
  const fallback = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  assert.equal(fallback.envelope.clockTrust, 'untrusted');
  assert.equal(fallback.envelope.clockOffsetMs, 3 * 24 * 60 * 60_000);
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

/**
 * SCRUM-275 — a bundle is on the disk, not in the object that wrote it.
 *
 * The store that reads here is constructed AFTER the write, over the same
 * database, which is the only shape that can tell a table from a `Map`: a
 * second read through the writing store passes either way. This is the SQLite
 * half of the claim `apps/api/test/box-cache-survives.test.ts` makes about the
 * `edge` schema, and the two matter for the same reason — a box that has lost
 * its deny-list is a box deciding an offline unlock from a staff list with no
 * revocations beside it.
 */
test('a cached bundle outlives the store that wrote it', async () => {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);

  const writer = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(AT) });
  await writer.writeBundle(BOX_ID, {
    scope: 'deny_list',
    schemaVersion: 1,
    cursorSeq: 7,
    payload: { items: [{ revokedTokenIds: ['jti-1'] }] },
    appliedAt: AT,
  });

  // The process died here. A Pi's card is all that crosses this line.
  const reader = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(AT) });
  const held = await reader.readBundle(BOX_ID, 'deny_list');
  assert.ok(held, 'the deny-list did not survive the store that wrote it');
  assert.equal(held.cursorSeq, 7);
  assert.deepEqual(held.payload, { items: [{ revokedTokenIds: ['jti-1'] }] });
  assert.equal(await reader.readBundle(BOX_ID, 'staff'), null);

  db.close();
});

// --- Several facts at once, and one unit of work (S2-07a) -------------------

test("a spin's two facts get consecutive sequences from one claim", async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  await harness.store.enqueue(BOX_ID, { type: 'member.created', payload: {} }, harness.seal);

  const pair = await harness.store.enqueueMany(
    BOX_ID,
    [
      { type: 'booth.spin_recorded', payload: { prizeId: 'p1' } },
      { type: 'promo.voucher_issued', payload: { code: 'B1K7M2QPXR' } },
    ],
    harness.seal,
  );

  assert.deepEqual(
    pair.map((record) => record.envelope.boxSeq),
    [2, 3],
    'consecutive, and in the order the facts were given',
  );
  assert.deepEqual(
    pair.map((record) => record.envelope.type),
    ['booth.spin_recorded', 'promo.voucher_issued'],
  );
  assert.equal((await harness.store.depth(BOX_ID)).queued, 3);
  harness.close();
});

test('a pair of facts cannot half-land, and the sequences go back with them', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  let sealed = 0;
  await assert.rejects(
    harness.store.enqueueMany(
      BOX_ID,
      [
        { type: 'booth.spin_recorded', payload: {} },
        { type: 'promo.voucher_issued', payload: {} },
      ],
      (draft) => {
        sealed += 1;
        // The voucher is the one that fails to sign. A spin the cloud hears
        // about with no voucher behind it is a prize nobody can account for.
        if (sealed === 2) throw new Error('the signing key was unreadable');
        return harness.seal(draft);
      },
    ),
  );

  assert.equal((await harness.store.depth(BOX_ID)).queued, 0, 'neither fact was kept');
  const next = await harness.store.enqueue(
    BOX_ID,
    { type: 'member.created', payload: {} },
    harness.seal,
  );
  assert.equal(next.envelope.boxSeq, 1, 'both sequences went back; the journal has no hole');
  harness.close();
});

test('a spin commits as one thing: facts, the voucher to print, and the counter', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const key = { scope: 'booth_prize', key: 'prize-1', businessDate: '2026-09-20' };

  await assert.rejects(
    harness.store.atomically(async (tx) => {
      await tx.enqueueMany(
        BOX_ID,
        [
          { type: 'booth.spin_recorded', payload: {} },
          { type: 'promo.voucher_issued', payload: {} },
        ],
        harness.seal,
      );
      await tx.putPrintJob(printJob('half-landed'));
      await tx.bumpCounter(BOX_ID, key);
      throw new Error('the voucher code could not be minted');
    }),
  );

  // A counter that moved for a spin with no voucher is a prize given away
  // twice at the end of the day, and nobody could tell from the rows.
  assert.equal((await harness.store.depth(BOX_ID)).queued, 0);
  assert.deepEqual(await harness.store.loadPendingPrintJobs(BOX_ID), []);
  assert.equal(await harness.store.readCounter(BOX_ID, key), 0);

  const kept = await harness.store.atomically(async (tx) => {
    const facts = await tx.enqueueMany(
      BOX_ID,
      [
        { type: 'booth.spin_recorded', payload: {} },
        { type: 'promo.voucher_issued', payload: {} },
      ],
      harness.seal,
    );
    await tx.putPrintJob(printJob('landed'));
    await tx.bumpCounter(BOX_ID, key);
    return facts.length;
  });

  assert.equal(kept, 2);
  assert.equal((await harness.store.depth(BOX_ID)).queued, 2);
  assert.equal((await harness.store.loadPendingPrintJobs(BOX_ID))[0]?.id, 'landed');
  assert.equal(await harness.store.readCounter(BOX_ID, key), 1);
  harness.close();
});

// --- Booth runtime state (S2-07a) -------------------------------------------

test('counters are per scope, per key and per trading day', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const today = '2026-09-20';

  assert.equal(await harness.store.bumpCounter(BOX_ID, { scope: 's', key: 'all', businessDate: today }), 1);
  assert.equal(await harness.store.bumpCounter(BOX_ID, { scope: 's', key: 'all', businessDate: today }), 2);
  await harness.store.bumpCounter(BOX_ID, { scope: 'p', key: 'prize-1', businessDate: today }, 3);
  // Yesterday's cap has nothing to do with today's, which is what "daily" means.
  await harness.store.bumpCounter(BOX_ID, { scope: 'p', key: 'prize-1', businessDate: '2026-09-19' }, 7);

  assert.deepEqual(await harness.store.readCounters(BOX_ID, 'p', today), { 'prize-1': 3 });
  assert.equal(
    await harness.store.readCounter(BOX_ID, { scope: 'p', key: 'never-drawn', businessDate: today }),
    0,
    'a prize nobody has won reads zero rather than missing',
  );
  harness.close();
});

test('one station holds one staff session, and signing in replaces it', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  await harness.store.writeStaffSession({
    stationId: STATION_ID,
    boxId: BOX_ID,
    accountId: 'acct-som',
    credentialKind: 'pin',
    staffCode: 'S-014',
    signedInAt: AT,
    lastSeenAt: AT,
    expiresAt: null,
  });
  await harness.store.touchStaffSession(STATION_ID, plus(AT, 60_000));
  let held = await harness.store.readStaffSession(STATION_ID);
  assert.equal(held?.accountId, 'acct-som');
  assert.equal(held?.lastSeenAt, plus(AT, 60_000), 'a touch moves the clock, not the person');
  assert.equal(held?.signedInAt, AT);

  await harness.store.writeStaffSession({
    stationId: STATION_ID,
    boxId: BOX_ID,
    accountId: 'acct-nok',
    credentialKind: 'badge',
    staffCode: null,
    signedInAt: plus(AT, 120_000),
    lastSeenAt: plus(AT, 120_000),
    expiresAt: null,
  });
  held = await harness.store.readStaffSession(STATION_ID);
  assert.equal(held?.accountId, 'acct-nok', 'two people signed in at one booth is not a state');
  assert.equal(held?.credentialKind, 'badge');

  await harness.store.clearStaffSession(STATION_ID);
  assert.equal(await harness.store.readStaffSession(STATION_ID), null);
  harness.close();
});

test('the throttle counts failures and keeps a lock the caller does not mention', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  const first = await harness.store.recordThrottleFailure(BOX_ID, 'booth_pin', 'station-1', {
    now: AT,
  });
  assert.equal(first.failures, 1);
  assert.equal(first.lockedUntil, null);

  const locked = await harness.store.recordThrottleFailure(BOX_ID, 'booth_pin', 'station-1', {
    now: plus(AT, 1_000),
    lockedUntil: plus(AT, 31_000),
  });
  assert.equal(locked.failures, 2);
  assert.equal(locked.lockedUntil, plus(AT, 31_000));

  // The sixth wrong PIN inside a lockout says nothing about the lock, and must
  // not lift the one the fifth set.
  const during = await harness.store.recordThrottleFailure(BOX_ID, 'booth_pin', 'station-1', {
    now: plus(AT, 2_000),
  });
  assert.equal(during.failures, 3);
  assert.equal(during.lockedUntil, plus(AT, 31_000));
  assert.equal(during.firstFailureAt, AT);

  // Two booths, two locks: a wrong PIN at one does not lock the other.
  const elsewhere = await harness.store.recordThrottleFailure(BOX_ID, 'booth_pin', 'station-2', {
    now: plus(AT, 3_000),
  });
  assert.equal(elsewhere.failures, 1);

  await harness.store.clearThrottle(BOX_ID, 'booth_pin', 'station-1');
  assert.equal(await harness.store.readThrottle(BOX_ID, 'booth_pin', 'station-1'), null);
  assert.equal(
    (await harness.store.readThrottle(BOX_ID, 'booth_pin', 'station-2'))?.failures,
    1,
    'one success clears one subject',
  );
  harness.close();
});

test('the last time the box believed in only ever moves forward', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);

  assert.equal(await harness.store.lastGoodTime(BOX_ID), null);
  assert.equal(await harness.store.markTimeSeen(BOX_ID, AT), AT);
  assert.equal(await harness.store.markTimeSeen(BOX_ID, plus(AT, 60_000)), plus(AT, 60_000));

  // A Pi with no clock battery boots believing it is whenever it was switched
  // off, or 1970. That is how the booth can tell its clock is not to be
  // trusted: this box has already lived through a later moment than "now".
  assert.equal(
    await harness.store.markTimeSeen(BOX_ID, '1970-01-01T00:00:00.000Z'),
    plus(AT, 60_000),
    'a clock that went backwards does not rewrite what the box has seen',
  );
  harness.close();
});

// --- The print queue on disk (S2-07a) ---------------------------------------

function printJob(id: string, over: Partial<PrintJobRecord> = {}): PrintJobRecord {
  return {
    id,
    boxId: BOX_ID,
    kind: 'booth_voucher',
    role: 'receipt',
    stationId: STATION_ID,
    deviceId: null,
    copies: 1,
    job: {
      kind: 'booth_voucher',
      data: {
        venueLine: 'Oto — Kids Play Park · Central Phuket',
        prizeLine: '150 THB VOUCHER',
        prizeLineThai: null,
        redemptionLine: 'Show this QR at OTO Reception.',
        terms: [],
        voucherCode: 'B1K7M2QPXR',
        issuedAt: '20 Sep 2026 10:00',
        booth: 'Central Phuket · G floor',
        staff: null,
        expiresAt: null,
        footerLine: 'oto.co.th',
      },
    },
    finish: null,
    templateId: null,
    templateVersion: null,
    actionId: null,
    state: 'queued',
    attempts: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    queuedAt: AT,
    updatedAt: AT,
    ...over,
  };
}

test('a job on the printer right now still counts as pending', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  await harness.store.putPrintJob(printJob('a'));
  await harness.store.updatePrintJob('a', { state: 'sending', deviceId: 'dev-1', attempts: 1 });

  // The count the booth reports is "vouchers not yet printed", and a job in
  // the middle of printing has not been printed. `init()` is what separates a
  // job this process is printing from one the last process died holding.
  const pending = await harness.store.loadPendingPrintJobs(BOX_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.state, 'sending');
  assert.equal(pending[0]?.deviceId, 'dev-1');
  assert.equal(pending[0]?.attempts, 1);
  harness.close();
});

test('re-submitting a job id replaces the job rather than printing two', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  await harness.store.putPrintJob(printJob('same-id', { attempts: 4 }));
  await harness.store.putPrintJob(printJob('same-id', { attempts: 0 }));

  const pending = await harness.store.loadPendingPrintJobs(BOX_ID);
  assert.equal(pending.length, 1, 'the id the cloud minted is the fence');
  assert.equal(pending[0]?.attempts, 0);
  harness.close();
});

test('an update changes only the fields it names', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  await harness.store.putPrintJob(
    printJob('b', { lastErrorCode: 'PRINTER_PAPER_OUT', attempts: 2, deviceId: 'dev-1' }),
  );
  await harness.store.updatePrintJob('b', { attempts: 3 });

  const held = (await harness.store.loadPendingPrintJobs(BOX_ID))[0];
  assert.equal(held?.attempts, 3);
  assert.equal(held?.lastErrorCode, 'PRINTER_PAPER_OUT', 'not cleared by a patch that is silent');
  assert.equal(held?.deviceId, 'dev-1');

  // And naming it with null IS how it is cleared — the two are different asks.
  await harness.store.updatePrintJob('b', { lastErrorCode: null });
  assert.equal((await harness.store.loadPendingPrintJobs(BOX_ID))[0]?.lastErrorCode, null);
  harness.close();
});

test('a store with no tables for this says so, rather than losing it quietly', async () => {
  // The virtual box's condition today, built deliberately: the S2-05 tables
  // and none of the S2-07a ones, because no migration has added them to the
  // `edge` schema yet. Opened here rather than through the shared harness, so
  // the missing half is missing in the same way the platform database's is.
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  for (const table of BOX_LOCAL_TABLES) db.exec(`drop table ${table}`);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(AT) });
  await store.init(BOX_ID);

  assert.deepEqual(store.features(), { printJobs: false, boothRuntime: false });
  assert.equal(store.printJobs(), null, 'the print queue is told to keep to memory');

  // A read with nowhere to read from is honestly empty: the print queue asks
  // at every boot and an exception there would stop a box that can still print.
  assert.deepEqual(await store.loadPendingPrintJobs(BOX_ID), []);

  // A write is not allowed to look like it worked, and booth state is refused
  // outright: a daily cap that does not count, or a lockout that does not
  // lock, is worse than an outage because nothing about it looks wrong.
  await assert.rejects(store.putPrintJob(printJob('nowhere')), BoxStoreFeatureMissingError);
  await assert.rejects(
    store.bumpCounter(BOX_ID, { scope: 'p', key: 'x', businessDate: '2026-09-20' }),
    BoxStoreFeatureMissingError,
  );
  await assert.rejects(
    store.recordThrottleFailure(BOX_ID, 'booth_pin', 'station-1'),
    (err: unknown) =>
      err instanceof BoxStoreFeatureMissingError &&
      err.missing.includes('box_throttle') &&
      err.feature === 'boothRuntime',
  );
  db.close();
});

test('a store that was never opened keeps nothing, which is the safe answer', async () => {
  const harness = openTestStore(AT);
  // No `init()`: nothing has probed, so nothing is known to be there. Saying
  // "yes" here would mean a caller writing a lockout into a table this store
  // has never looked for.
  assert.deepEqual(harness.store.features(), { printJobs: false, boothRuntime: false });
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
