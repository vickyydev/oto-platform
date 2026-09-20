import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SyncPushRequest, SyncPushResponse } from '../src/contract';
import { createOutbox } from '../src/outbox';
import { BOX_ID, openTestStore, plus } from './_support';

const AT = '2026-09-20T03:00:00.000Z';

interface FakeCloud {
  batches: SyncPushRequest[];
  answer: (request: SyncPushRequest) => { status: number; body: SyncPushResponse | null };
}

function acceptAll(epoch = 1): FakeCloud['answer'] {
  return (request) => ({
    status: 200,
    body: {
      applied: request.events.length,
      duplicates: 0,
      quarantined: 0,
      rejected: 0,
      results: request.events.map((event) => ({
        eventId: event.eventId,
        boxSeq: event.boxSeq,
        result: 'applied' as const,
      })),
      cursorSeq: request.events[request.events.length - 1]?.boxSeq ?? 0,
      epoch,
      batchId: 'ops-run-1',
      serverTime: AT,
    },
  });
}

async function openPump(options?: { offline?: boolean; answer?: FakeCloud['answer'] }) {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  if (options?.offline) await harness.store.setOffline(BOX_ID, true, { reason: 'console' });

  const cloud: FakeCloud = { batches: [], answer: options?.answer ?? acceptAll() };
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    privateKey: () => harness.keys.privateKeyPem,
    isOffline: async () => (await harness.store.readState(BOX_ID)).offline,
    push: async (request) => {
      cloud.batches.push(request);
      return cloud.answer(request);
    },
    now: () => harness.now(),
  });
  return { harness, cloud, outbox };
}

test('an offline box still records the fact and sends nothing', async () => {
  const { harness, cloud, outbox } = await openPump({ offline: true });
  await outbox.queue({ type: 'member.created', payload: { phone: '+66811111111' } });

  const result = await outbox.flush();
  assert.equal(result.state, 'offline');
  assert.equal(cloud.batches.length, 0);
  assert.equal((await outbox.depth()).queued, 1, 'the sale is on disk, which is the promise');

  // The Console's toggle writes the row; the pump reads it fresh every tick.
  await harness.store.setOffline(BOX_ID, false);
  const sent = await outbox.flush();
  assert.equal(sent.state, 'pushed');
  if (sent.state !== 'pushed') return;
  assert.equal(sent.applied, 1);
  assert.equal((await outbox.depth()).queued, 0);
  harness.close();
});

test('a lost link defers the batch with a backoff instead of losing it', async () => {
  const { harness, cloud, outbox } = await openPump({
    answer: () => {
      throw new Error('ECONNRESET');
    },
  });
  await outbox.queue({ type: 'member.created', payload: {} });

  const failed = await outbox.flush();
  assert.equal(failed.state, 'deferred');
  if (failed.state !== 'deferred') return;
  assert.equal(failed.errorCode, 'PUSH_FAILED');
  assert.equal((await outbox.depth()).queued, 1);

  // Backed off: the very next tick does not hammer the api.
  assert.equal((await outbox.flush()).state, 'empty');

  harness.setNow(plus(AT, 10 * 60_000));
  cloud.answer = acceptAll();
  const sent = await outbox.flush();
  assert.equal(sent.state, 'pushed');
  harness.close();
});

test('a five hundred from the cloud is deferred, not treated as accepted', async () => {
  const { harness, outbox } = await openPump({ answer: () => ({ status: 503, body: null }) });
  await outbox.queue({ type: 'member.created', payload: {} });
  const result = await outbox.flush();
  assert.equal(result.state, 'deferred');
  if (result.state !== 'deferred') return;
  assert.equal(result.errorCode, 'PUSH_503');
  assert.equal((await outbox.depth()).queued, 1);
  harness.close();
});

test('a replay of an accepted batch is all duplicates and creates nothing', async () => {
  const { harness, cloud, outbox } = await openPump();
  for (let i = 0; i < 3; i += 1) await outbox.queue({ type: 'member.created', payload: { i } });
  const first = await outbox.flush();
  assert.equal(first.state, 'pushed');

  cloud.answer = (request) => ({
    status: 200,
    body: {
      applied: 0,
      duplicates: request.events.length,
      quarantined: 0,
      rejected: 0,
      results: request.events.map((event) => ({
        eventId: event.eventId,
        boxSeq: event.boxSeq,
        result: 'duplicate' as const,
      })),
      cursorSeq: request.events[request.events.length - 1]?.boxSeq ?? 0,
      epoch: 1,
      batchId: 'ops-run-2',
      serverTime: AT,
    },
  });

  assert.equal(await outbox.replayLastBatch(3), 3);
  const replayed = await outbox.flush();
  assert.equal(replayed.state, 'pushed');
  if (replayed.state !== 'pushed') return;
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.duplicates, 3);
  assert.deepEqual(
    cloud.batches[1]?.events.map((event) => event.eventId),
    cloud.batches[0]?.events.map((event) => event.eventId),
    'the same event ids, which is what makes them duplicates rather than new facts',
  );
  harness.close();
});

test('the box adopts an epoch the cloud has moved on to', async () => {
  const { harness, outbox } = await openPump({ answer: acceptAll(2) });
  await outbox.queue({ type: 'member.created', payload: {} });
  await outbox.flush();

  const state = await harness.store.readState(BOX_ID);
  assert.equal(state.journalEpoch, 2);
  assert.equal(state.nextBoxSeq, 1, 'the sequence restarts with the epoch');

  const next = await outbox.queue({ type: 'member.created', payload: {} });
  assert.equal(next.envelope.journalEpoch, 2);
  assert.equal(next.envelope.boxSeq, 1);
  harness.close();
});

test('two flushes at once send one batch', async () => {
  const { harness, cloud, outbox } = await openPump();
  await outbox.queue({ type: 'member.created', payload: {} });
  const [a, b] = await Promise.all([outbox.flush(), outbox.flush()]);
  assert.equal(cloud.batches.length, 1, 'a mall uplink is not spent saying the same thing twice');
  assert.equal(a.state, 'pushed');
  assert.equal(b.state, 'pushed');
  harness.close();
});

test('a box with no signing key refuses to queue rather than minting unverifiable facts', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    privateKey: () => null,
    isOffline: async () => false,
    push: async () => ({ status: 200, body: null }),
    now: () => harness.now(),
  });
  await assert.rejects(outbox.queue({ type: 'member.created', payload: {} }), /no signing key/);
  assert.equal((await outbox.flush()).state, 'not_registered');
  harness.close();
});
