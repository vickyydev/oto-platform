import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalSyncBytes, type SyncPushRequest, type SyncPushResponse } from '../src/contract';
import {
  PAYMENT_RECORDED,
  SALE_FINALISED,
  createOutbox,
  paymentRecordedFact,
  saleFinalisedFact,
  type OfflineTenderFact,
} from '../src/outbox';
import { verifyCanonical } from '../src/signing';
import { BOX_ID, STATION_ID, openTestStore } from './_support';

/**
 * S2-10a (SCRUM-206), Slice G — THE BOX'S HALF OF A SALE TAKEN WITH NO INTERNET.
 *
 * The promise the outbox makes is that a fact is on disk before the person who
 * caused it is told it worked. This is that promise applied to money: a family
 * pays, the mall's link is down, and the sale is on the box's own queue with a
 * journal position of its own before the till says "paid".
 *
 * WHAT IS PROVED HERE AND WHAT IS PROVED IN THE API SUITE. Everything below is
 * the STORE and the OUTBOX: the sequence, the transaction, the signatures, the
 * shape of the two facts, and what a re-send does. The receipt number, the
 * drawer pulse and the cloud's own handlers live in `createBoxAgent` and in the
 * api, and neither can be loaded in this package's runner at all — Node's
 * strip-only mode refuses `Bitmap1`'s parameter properties, so `@oto/print`,
 * and therefore the printing controller and the agent, cannot be imported here
 * (`booth-offline.test.ts:38-50` records the same limit). Those cases are in
 * `apps/api/test/sync-sales.test.ts`, which drives the real agent.
 *
 * The signatures are checked with the CLOUD's check — `canonicalSyncBytes` over
 * the stored envelope plus the box id, then `verifyCanonical` against the public
 * half of the key. A box could not express a sale attributed to another box even
 * if it tried: the box id is put back by the verifier and is not in the envelope.
 */

const AT = '2026-09-22T11:00:00.000Z';
const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000ac001';
const SALE_ID = '018f0000-0000-7000-8000-0000005a1e01';

function cashTender(amountSatang: number, over: Partial<OfflineTenderFact> = {}): OfflineTenderFact {
  return {
    actionId: 'press-0001',
    methodCode: 'cash',
    kind: 'cash',
    amountSatang,
    tenderedSatang: amountSatang,
    changeSatang: 0,
    ...over,
  };
}

/** A card tender as the box's own terminal adapter answered it. */
function cardTender(amountSatang: number): OfflineTenderFact {
  return {
    actionId: 'press-0002',
    methodCode: 'card',
    kind: 'card',
    provider: 'ghl',
    amountSatang,
    deviceId: '018f0000-0000-7000-8000-00000000ed01',
    terminalRef: '650123000001',
    approvalCode: '123456',
    last4: '4242',
    tid: '65703235',
    mid: '4648434010',
    responseCode: '00',
  };
}

const sale = (tenders: OfflineTenderFact[]) =>
  saleFinalisedFact({
    saleId: SALE_ID,
    stationId: STATION_ID,
    actorAccountId: ACCOUNT_ID,
    cart: { lines: [{ id: 'line-1', packageId: 'pkg-1', kids: 1, adults: 0 }], expectedTotalSatang: 144_000 },
    tenders,
    receipt: { series: 'T1', seq: 42, number: 'T1-000042' },
    occurredAt: AT,
    actionId: 'press-0001',
  });

function acceptAll(request: SyncPushRequest): { status: number; body: SyncPushResponse } {
  return {
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
      epoch: 1,
      batchId: 'ops-run-1',
      serverTime: AT,
    },
  };
}

async function openBox(options: { offline?: boolean } = {}) {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  if (options.offline) await harness.store.setOffline(BOX_ID, true, { reason: 'the mall link' });
  const batches: SyncPushRequest[] = [];
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    privateKey: () => harness.keys.privateKeyPem,
    isOffline: async () => (await harness.store.readState(BOX_ID)).offline,
    push: async (request) => {
      batches.push(request);
      return acceptAll(request);
    },
    now: () => harness.now(),
  });
  return { harness, outbox, batches };
}

test('a sale taken offline is on disk with a journal position before anything is sent', async () => {
  const { harness, outbox, batches } = await openBox({ offline: true });

  const [record] = await outbox.queueAll([sale([cashTender(144_000)])]);

  assert.equal(record!.state, 'queued');
  assert.equal(record!.envelope.type, SALE_FINALISED);
  assert.equal(record!.envelope.boxSeq, 1, 'the first fact this box ever minted');
  assert.equal(record!.envelope.journalEpoch, 1);
  assert.equal(record!.envelope.stationId, STATION_ID);
  assert.equal(record!.envelope.actorAccountId, ACCOUNT_ID, 'a sale names who took the money');
  assert.equal((await outbox.depth()).queued, 1);

  // Nothing has left the box, and the fact is not waiting on the link.
  assert.equal((await outbox.flush()).state, 'offline');
  assert.equal(batches.length, 0);

  const payload = record!.envelope.payload as Record<string, unknown>;
  assert.equal(payload.saleId, SALE_ID);
  assert.deepEqual(payload.receipt, { series: 'T1', seq: 42, number: 'T1-000042' });
  const tenders = payload.tenders as OfflineTenderFact[];
  assert.equal(tenders.length, 1);
  assert.equal(tenders[0]!.amountSatang, 144_000);
  assert.equal(tenders[0]!.actionId, 'press-0001', 'the press is the cloud’s replay key');
  harness.close();
});

test('the sale and its money are one transaction: consecutive positions, no gap', async () => {
  const { harness, outbox } = await openBox({ offline: true });

  const records = await outbox.queueAll([
    sale([cashTender(72_000)]),
    paymentRecordedFact({
      saleId: SALE_ID,
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      tender: cashTender(72_000, { actionId: 'press-0003' }),
      occurredAt: AT,
    }),
  ]);

  assert.equal(records.length, 2);
  assert.equal(records[0]!.envelope.type, SALE_FINALISED);
  assert.equal(records[1]!.envelope.type, PAYMENT_RECORDED);
  assert.equal(records[0]!.envelope.boxSeq, 1);
  assert.equal(records[1]!.envelope.boxSeq, 2, 'consecutive: a gap is indistinguishable from a loss');
  // The next fact continues the same sequence, so nothing was reserved and
  // thrown away in between.
  const [next] = await outbox.queueAll([
    paymentRecordedFact({
      saleId: SALE_ID,
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      tender: cashTender(1_000, { actionId: 'press-0004' }),
    }),
  ]);
  assert.equal(next!.envelope.boxSeq, 3);
  harness.close();
});

test('a sale that cannot be signed leaves no position behind it', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    // A box that has not registered yet, which is the real shape of this: the
    // key arrives with the claim, and a till must not be able to take money the
    // box cannot express.
    privateKey: () => null,
    isOffline: async () => true,
    push: async (request) => acceptAll(request),
    now: () => harness.now(),
  });

  await assert.rejects(() => outbox.queueAll([sale([cashTender(144_000)])]), /signing key/);
  assert.equal((await outbox.depth()).queued, 0);
  assert.equal((await harness.store.readState(BOX_ID)).nextBoxSeq, 1, 'no sequence was spent');
  harness.close();
});

test('the cloud’s own check accepts what the box sealed', async () => {
  const { harness, outbox } = await openBox({ offline: true });
  const [record] = await outbox.queueAll([sale([cardTender(144_000)])]);
  const envelope = record!.envelope;

  // Exactly what `prepareEvent` does on the other side: the box id goes back
  // into the bytes, because it is in the canonical field list and is not a
  // field of the envelope.
  const canonical = canonicalSyncBytes({ ...envelope, boxId: BOX_ID });
  assert.equal(
    verifyCanonical(canonical, envelope.sig, harness.keys.publicKeyPem),
    true,
    'a sale the cloud would refuse is money the park cannot bank',
  );
  assert.equal(
    verifyCanonical(
      canonicalSyncBytes({ ...envelope, boxId: '018f0000-0000-7000-8000-00000000dead' }),
      envelope.sig,
      harness.keys.publicKeyPem,
    ),
    false,
    'and it is attributed to THIS box and no other',
  );
  harness.close();
});

test('a card tender carries what the terminal said and nothing a Pi should not hold', async () => {
  const { harness, outbox } = await openBox({ offline: true });
  const [record] = await outbox.queueAll([sale([cardTender(144_000)])]);

  const [tender] = (record!.envelope.payload as { tenders: OfflineTenderFact[] }).tenders;
  assert.equal(tender!.approvalCode, '123456');
  assert.equal(tender!.last4, '4242');
  assert.equal(tender!.tid, '65703235');
  assert.equal(tender!.terminalRef, '650123000001');
  // The queue file on a box in a storeroom holds four digits, never a PAN and
  // never a cardholder name: the adapter's parser drops both before the result
  // leaves it, and nothing in this shape can carry them.
  const serialised = JSON.stringify(record!.envelope);
  assert.equal(serialised.includes('4242424242424242'), false);
  assert.equal(serialised.includes('cardholder'), false);
  harness.close();
});

test('the link comes back: the batch goes up in order and the queue empties', async () => {
  const { harness, outbox, batches } = await openBox({ offline: true });

  await outbox.queueAll([
    sale([cashTender(72_000)]),
    paymentRecordedFact({
      saleId: SALE_ID,
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      tender: cashTender(72_000, { actionId: 'press-0003' }),
    }),
  ]);
  await harness.store.setOffline(BOX_ID, false);

  const sent = await outbox.flush();
  assert.equal(sent.state, 'pushed');
  if (sent.state !== 'pushed') return;
  assert.equal(sent.events, 2);
  assert.equal(batches.length, 1);
  // In the order the money happened, which is what lets the cloud apply the
  // sale before the tender that arrived after it.
  assert.deepEqual(
    batches[0]!.events.map((e) => [e.type, e.boxSeq]),
    [
      [SALE_FINALISED, 1],
      [PAYMENT_RECORDED, 2],
    ],
  );
  assert.equal((await outbox.depth()).queued, 0);
  harness.close();
});

test('an answer that never arrived is re-sent whole rather than half-forgotten', async () => {
  const harness = openTestStore(AT);
  await harness.store.init(BOX_ID);
  const batches: SyncPushRequest[] = [];
  let swallow = true;
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    privateKey: () => harness.keys.privateKeyPem,
    isOffline: async () => false,
    push: async (request) => {
      batches.push(request);
      // The cloud applied it and the answer was lost on the way back, which
      // from this side is indistinguishable from a request that never landed.
      if (swallow) throw new Error('ECONNRESET');
      return acceptAll(request);
    },
    now: () => harness.now(),
  });

  await outbox.queueAll([sale([cashTender(144_000)])]);
  const deferred = await outbox.flush();
  assert.equal(deferred.state, 'deferred');
  assert.equal((await outbox.depth()).queued, 1, 'a sale is never dropped on a lost answer');

  swallow = false;
  // Past the backoff the store wrote.
  harness.setNow('2026-09-22T11:05:00.000Z');
  const sent = await outbox.flush();
  assert.equal(sent.state, 'pushed');
  assert.equal(batches.length, 2);
  // The SAME event id and the same position both times: the cloud's
  // `(box, epoch, box_seq)` index is what turns the second one into a
  // duplicate, and the press on the tender is what stops the money doubling if
  // ever the ids are re-minted instead.
  assert.equal(batches[1]!.events[0]!.eventId, batches[0]!.events[0]!.eventId);
  assert.equal(batches[1]!.events[0]!.boxSeq, 1);
  harness.close();
});
