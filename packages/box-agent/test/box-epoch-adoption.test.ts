import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBoxAgent, JournalEpochAwaitedError, type BoxAgent } from '../src/agent';
import type { SyncEventOutcome, SyncPushRequest } from '../src/contract';
import { memoryCredentialStore, type CredentialStore } from '../src/credentials';
import { createOutbox, saleFinalisedFact } from '../src/outbox';
import type { BoxConfigBundle } from '../src/protocol';
import type { AgentFetch, AgentResponse } from '../src/transport';
import { BOX_ID, STATION_ID, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * SCRUM-486 — A BOX ADOPTS THE PLATFORM'S JOURNAL EPOCH WHEREVER IT LEARNS IT.
 *
 * The platform mints a new epoch in the transaction that accepts a
 * `reset_store` result (`completeCommand`, apps/api/src/services/box.ts). The
 * box used to take it into its STORE from that answer only — or from another
 * command's acknowledgement, or a push answer. The heartbeat and the config
 * pull set only the in-memory `state.epoch`, which also disarmed the
 * acknowledgement's check (it compared against that in-memory value), and an
 * empty outbox never pushes. So a lost `reset_store` answer left a quiet box
 * sealing on the OLD epoch, and every sale it then took offline came back
 * `epoch_regressed` — set aside on the platform, out of the ledger and out of
 * the stock level.
 *
 * Run against the agent as it was, the REPRODUCTION failed at the heartbeat:
 * the store stayed on epoch 1, the offline sale was sealed at (1, 1), and the
 * cloud set it aside `epoch_regressed`. The other cases failed the same way.
 *
 * The cloud here is faked at the HTTP boundary and judges a push the way
 * `pushEvents` does: an event on any epoch but the box's current one is
 * quarantined `epoch_regressed`, everything else is applied.
 */

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000ac486';
const quiet = { info() {}, warn() {}, error() {} };

interface Cloud {
  fetch: AgentFetch;
  /** `core.box.current_epoch`. */
  epoch: number;
  /** Handed out by the next poll. */
  queued: Array<{ id: string; kind: string }>;
  /** The next command result is recorded (and a reset mints) but its answer never arrives. */
  loseNextResultAnswer: boolean;
  /** Every event the cloud judged, with what it made of it. */
  judged: Array<{ eventId: string; journalEpoch: number; boxSeq: number; type: string; outcome: SyncEventOutcome }>;
}

function fakeCloud(): Cloud {
  const reply = (status: number, json: unknown): AgentResponse => ({
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    header: () => null,
  });
  const cloud: Cloud = {
    epoch: 1,
    queued: [],
    loseNextResultAnswer: false,
    judged: [],
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const bundle = tillBundle();
      const config = { ...bundle, box: { ...bundle.box, epoch: cloud.epoch } } as BoxConfigBundle;
      if (path === '/box/v1/config') return reply(200, config);
      if (path === '/box/v1/heartbeat') {
        return reply(200, {
          receivedAt: new Date().toISOString(),
          serverTime: new Date().toISOString(),
          clockOffsetMs: 0,
          configVersion: config.configVersion,
          minSupportedAgentVersion: '0.1.0',
          heartbeatIntervalS: 60,
          commandsPending: cloud.queued.length,
          epoch: cloud.epoch,
          devicesMatched: 0,
          devicesUnknown: 0,
        });
      }
      if (path === '/box/v1/commands/poll') {
        const commands = cloud.queued.splice(0).map((command) => ({
          id: command.id,
          kind: command.kind,
          payload: null,
          actionId: null,
          attempts: 1,
          expiresAt: null,
          createdAt: new Date().toISOString(),
        }));
        return reply(200, { commands, serverTime: new Date().toISOString() });
      }
      const result = /^\/box\/v1\/commands\/([^/]+)\/result$/.exec(path);
      if (result) {
        const id = result[1]!;
        // `completeCommand`: a store reset that succeeded mints the next epoch,
        // in the same transaction as the result — whether or not the answer
        // makes it back to the box.
        if (body?.state === 'succeeded' && id.startsWith('reset-')) cloud.epoch += 1;
        if (cloud.loseNextResultAnswer) {
          cloud.loseNextResultAnswer = false;
          throw new Error('ECONNRESET: the answer was lost on the way back');
        }
        return reply(200, { id, state: String(body?.state), replayed: false, epoch: cloud.epoch });
      }
      if (path === '/box/v1/sync/push') {
        const request = body as unknown as SyncPushRequest;
        const results: SyncEventOutcome[] = request.events.map((event) => {
          const outcome: SyncEventOutcome =
            event.journalEpoch === cloud.epoch
              ? { eventId: event.eventId, boxSeq: event.boxSeq, result: 'applied' }
              : {
                  eventId: event.eventId,
                  boxSeq: event.boxSeq,
                  result: 'quarantined',
                  reason: 'epoch_regressed',
                  errorCode: 'SYNC_EPOCH_REGRESSED',
                };
          cloud.judged.push({
            eventId: event.eventId,
            journalEpoch: event.journalEpoch,
            boxSeq: event.boxSeq,
            type: event.type,
            outcome,
          });
          return outcome;
        });
        const current = request.events.filter((e) => e.journalEpoch === cloud.epoch).map((e) => e.boxSeq);
        return reply(200, {
          applied: results.filter((r) => r.result === 'applied').length,
          duplicates: 0,
          quarantined: results.filter((r) => r.result === 'quarantined').length,
          rejected: 0,
          results,
          cursorSeq: current.length > 0 ? Math.max(...current) : request.cursorSeq,
          epoch: cloud.epoch,
          batchId: `batch-${cloud.judged.length}`,
          serverTime: new Date().toISOString(),
        });
      }
      return reply(503, { error: { code: 'NOT_HERE', message: 'not faked' } });
    },
  };
  return cloud;
}

interface Box {
  agent: BoxAgent;
  harness: TestStore;
  credentials: CredentialStore;
}

/** A till's box that registered on an earlier day: a credential, and a store that keeps its journal. */
async function openBox(cloud: Cloud, opts: { storeRow?: boolean } = {}): Promise<Box> {
  const harness = openTestStore();
  if (opts.storeRow !== false) await harness.store.init(BOX_ID);
  const credentials = memoryCredentialStore({
    boxId: BOX_ID,
    secret: 'till-box-486-secret',
    syncPrivateKeyPem: harness.keys.privateKeyPem,
  });
  const agent = startAgent(cloud, harness, credentials);
  await agent.ensureRegistered();
  await agent.syncConfig();
  return { agent, harness, credentials };
}

function startAgent(cloud: Cloud, harness: TestStore, credentials: CredentialStore): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials,
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    printing: { enabled: false },
    terminal: { enabled: false },
    booth: { enabled: false },
  });
}

/** The box as the next power cut leaves it: a new process on the same store. */
async function restart(cloud: Cloud, box: Box): Promise<Box> {
  box.agent.stop();
  const agent = startAgent(cloud, box.harness, box.credentials);
  await agent.ensureRegistered();
  return { ...box, agent };
}

/** One cash sale, sealed on the box's queue the way the till's offline path seals it. */
async function sellOffline(box: Box, label: string) {
  const [record] = await box.agent.outbox()!.queueAll([
    saleFinalisedFact({
      saleId: crypto.randomUUID(),
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      cart: { items: [{ id: crypto.randomUUID(), productId: label, quantity: 1 }], expectedTotalSatang: 25_000 },
      tenders: [
        {
          actionId: `cash-${label}`,
          methodCode: 'cash',
          kind: 'cash',
          amountSatang: 25_000,
          tenderedSatang: 25_000,
          changeSatang: 0,
        },
      ],
      occurredAt: new Date().toISOString(),
      actionId: `pay-${label}`,
    }),
  ]);
  return record!.envelope;
}

/**
 * The Console's Reset the store, run by the box, with the answer that carries
 * the minted epoch lost on the way back. The platform HAS minted it.
 */
async function resetWithLostAnswer(cloud: Cloud, box: Box, id: string): Promise<void> {
  const before = cloud.epoch;
  cloud.queued.push({ id, kind: 'reset_store' });
  cloud.loseNextResultAnswer = true;
  await assert.rejects(box.agent.runPendingCommands(), /ECONNRESET/);
  assert.equal(cloud.epoch, before + 1, 'the platform minted the next epoch');
}

async function storeEpoch(box: Box): Promise<{ journalEpoch: number; nextBoxSeq: number }> {
  const state = await box.harness.store.readState(BOX_ID);
  return { journalEpoch: state.journalEpoch, nextBoxSeq: state.nextBoxSeq };
}

test('REPRODUCTION: a lost reset_store answer, a heartbeat naming the new epoch, then an offline sale — the sale is sealed on the new epoch and applied', async () => {
  const cloud = fakeCloud();
  const box = await openBox(cloud);
  try {
    assert.deepEqual(await storeEpoch(box), { journalEpoch: 1, nextBoxSeq: 1 });

    await resetWithLostAnswer(cloud, box, 'reset-1');
    // The box's store never heard of epoch 2 from that answer.
    assert.equal((await storeEpoch(box)).journalEpoch, 1);

    // A quiet box: nothing in its outbox, so nothing pushes. The heartbeat is
    // the only answer it gets — and it names epoch 2.
    assert.ok(await box.agent.heartbeat());
    assert.deepEqual(
      await storeEpoch(box),
      { journalEpoch: 2, nextBoxSeq: 1 },
      'the heartbeat adopted the platform epoch into the STORE, the sequence restarting with it',
    );
    assert.equal(box.agent.state.epoch, 2);

    // The mall link goes; a family pays cash.
    await box.agent.setOffline(true, { reason: 'the mall link' });
    const sealed = await sellOffline(box, 'cap-1');
    assert.equal(sealed.journalEpoch, 2, 'sealed on the epoch the platform is on — not the replaced one');
    assert.equal(sealed.boxSeq, 1);

    // Back online: the sale goes up and is APPLIED, not set aside as a regression.
    await box.agent.setOffline(false);
    const judged = cloud.judged.find((j) => j.eventId === sealed.eventId);
    assert.ok(judged, 'the sale was pushed');
    assert.equal(judged.outcome.result, 'applied');
    assert.equal(cloud.judged.filter((j) => j.outcome.reason === 'epoch_regressed').length, 0);
    assert.equal((await box.agent.outbox()!.depth()).queued, 0);
  } finally {
    box.agent.stop();
    box.harness.close();
  }
});

test('the adoption is on disk: a restart after the heartbeat seals on the new epoch, and the sequence carries on', async () => {
  const cloud = fakeCloud();
  let box = await openBox(cloud);
  try {
    await resetWithLostAnswer(cloud, box, 'reset-1');
    await box.agent.heartbeat();
    await box.agent.setOffline(true, { reason: 'the mall link' });
    const first = await sellOffline(box, 'cap-1');
    assert.deepEqual([first.journalEpoch, first.boxSeq], [2, 1]);

    // The power goes. The new process reads its epoch from the store and has
    // had no answer from the platform at all — the link is still down.
    box = await restart(cloud, box);
    assert.equal(box.agent.state.epoch, 2, 'the restarted box reads the adopted epoch back');
    const second = await sellOffline(box, 'cap-2');
    assert.deepEqual(
      [second.journalEpoch, second.boxSeq],
      [2, 2],
      'the same epoch, the next sequence: nothing re-used, nothing restarted',
    );

    await box.agent.setOffline(false);
    for (const sealed of [first, second]) {
      assert.equal(cloud.judged.find((j) => j.eventId === sealed.eventId)?.outcome.result, 'applied');
    }
  } finally {
    box.agent.stop();
    box.harness.close();
  }
});

test('an acknowledgement after the adoption is honoured against the STORE: the same epoch moves nothing, a newer one is adopted', async () => {
  const cloud = fakeCloud();
  const box = await openBox(cloud);
  try {
    await resetWithLostAnswer(cloud, box, 'reset-1');
    await box.agent.heartbeat();
    await box.agent.setOffline(true, { reason: 'the mall link' });
    const first = await sellOffline(box, 'cap-1');
    assert.deepEqual([first.journalEpoch, first.boxSeq], [2, 1]);
    await box.agent.setOffline(false);

    // An ordinary command's acknowledgement naming the epoch the store is on:
    // the sequence is NOT restarted (a restart would re-use (2, 1)).
    cloud.queued.push({ id: 'logs-1', kind: 'collect_logs' });
    assert.equal(await box.agent.runPendingCommands(), 1);
    assert.deepEqual(await storeEpoch(box), { journalEpoch: 2, nextBoxSeq: 2 });

    // The platform moves on without a reset answer reaching the box (another
    // lost one), and the next thing the box hears is an ordinary command's
    // acknowledgement naming epoch 3. Before SCRUM-486 the heartbeat had set
    // the in-memory epoch to the platform's, so this check compared 3 with 3
    // and wrote nothing to the store; it is compared with the store now.
    cloud.epoch = 3;
    cloud.queued.push({ id: 'logs-2', kind: 'collect_logs' });
    assert.equal(await box.agent.runPendingCommands(), 1);
    assert.deepEqual(await storeEpoch(box), { journalEpoch: 3, nextBoxSeq: 1 });
    await box.agent.setOffline(true, { reason: 'the mall link' });
    const next = await sellOffline(box, 'cap-2');
    assert.deepEqual([next.journalEpoch, next.boxSeq], [3, 1]);
  } finally {
    box.agent.stop();
    box.harness.close();
  }
});

test('the config pull carries the epoch too, and an older epoch than the store holds is never adopted', async () => {
  const cloud = fakeCloud();
  const box = await openBox(cloud);
  try {
    await resetWithLostAnswer(cloud, box, 'reset-1');
    // No heartbeat: the next thing the box hears is a config pull.
    assert.equal(await box.agent.syncConfig(), false, 'the bundle itself did not change');
    assert.deepEqual(await storeEpoch(box), { journalEpoch: 2, nextBoxSeq: 1 });

    await box.agent.setOffline(true, { reason: 'the mall link' });
    const sealed = await sellOffline(box, 'cap-1');
    assert.deepEqual([sealed.journalEpoch, sealed.boxSeq], [2, 1]);

    // A platform answering an OLDER epoch than the store holds (a restored
    // database, a stale replica): adopting it would restart the sequence on
    // addresses the cloud may already hold. The store keeps its epoch.
    await box.agent.setOffline(false);
    cloud.epoch = 1;
    await box.agent.heartbeat();
    assert.deepEqual(await storeEpoch(box), { journalEpoch: 2, nextBoxSeq: 2 });
  } finally {
    box.agent.stop();
    box.harness.close();
  }
});

test('a sale sealed BEFORE the adoption and pushed after it is set aside as epoch_regressed — never applied on the wrong journal, never re-sent for ever', async () => {
  const cloud = fakeCloud();
  const box = await openBox(cloud);
  try {
    // Sealed on epoch 1 while the link is down.
    await box.agent.setOffline(true, { reason: 'the mall link' });
    const stillOld = await sellOffline(box, 'cap-1');
    assert.deepEqual([stillOld.journalEpoch, stillOld.boxSeq], [1, 1]);

    // The toggle goes back on disk with nothing pushed yet, and the next
    // heartbeat finds a Reset the store waiting: the platform mints epoch 2
    // and the answer that carries it is lost.
    await box.harness.store.setOffline(BOX_ID, false);
    cloud.queued.push({ id: 'reset-1', kind: 'reset_store' });
    cloud.loseNextResultAnswer = true;
    await assert.rejects(box.agent.heartbeat(), /ECONNRESET/);
    assert.equal(cloud.epoch, 2);
    assert.equal(cloud.judged.length, 0, 'the old-epoch sale has not gone up yet');

    // The heartbeat after it adopts epoch 2.
    await box.agent.heartbeat();
    assert.deepEqual(await storeEpoch(box), { journalEpoch: 2, nextBoxSeq: 1 });

    // The queued epoch-1 sale goes up now. The platform sets it aside — the
    // api suite (`box-epoch-regressed-sale.test.ts`) proves the quarantine row,
    // the alert, and that it names the money and the units.
    await box.agent.outbox()!.flush();
    const judged = cloud.judged.find((j) => j.eventId === stillOld.eventId);
    assert.ok(judged, 'the old-epoch sale went up rather than being dropped on the box');
    assert.equal(judged.outcome.result, 'quarantined');
    assert.equal(judged.outcome.reason, 'epoch_regressed');
    // Settled on the box as set aside: not queued, so not re-sent for ever.
    assert.equal((await box.agent.outbox()!.depth()).queued, 0);
    // And a sale after the adoption is on the new journal.
    await box.agent.setOffline(true, { reason: 'the mall link' });
    const fresh = await sellOffline(box, 'cap-3');
    assert.deepEqual([fresh.journalEpoch, fresh.boxSeq], [2, 1]);
  } finally {
    box.agent.stop();
    box.harness.close();
  }
});

test('an outbox on its own (no agent) adopts a newer push-answer epoch and never an older one', async () => {
  const harness = openTestStore();
  await harness.store.init(BOX_ID);
  await harness.store.setEpoch(BOX_ID, 3);
  let answerEpoch = 2;
  const outbox = createOutbox({
    store: harness.store,
    boxId: BOX_ID,
    privateKey: () => harness.keys.privateKeyPem,
    isOffline: async () => false,
    push: async (request) => ({
      status: 200,
      body: {
        applied: 0,
        duplicates: 0,
        quarantined: request.events.length,
        rejected: 0,
        results: request.events.map((event) => ({
          eventId: event.eventId,
          boxSeq: event.boxSeq,
          result: 'quarantined' as const,
          reason: 'epoch_regressed' as const,
        })),
        cursorSeq: 0,
        epoch: answerEpoch,
        batchId: 'b',
        serverTime: new Date().toISOString(),
      },
    }),
    now: () => harness.now(),
    log: quiet,
  });
  try {
    const sale = saleFinalisedFact({
      saleId: crypto.randomUUID(),
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      cart: { expectedTotalSatang: 0 },
      tenders: [],
    });
    await outbox.queue(sale);
    await outbox.flush();
    assert.deepEqual(
      [(await harness.store.readState(BOX_ID)).journalEpoch, (await harness.store.readState(BOX_ID)).nextBoxSeq],
      [3, 2],
      'an older epoch in a push answer moved nothing',
    );
    answerEpoch = 4;
    await outbox.queue(sale);
    await outbox.flush();
    assert.deepEqual(
      [(await harness.store.readState(BOX_ID)).journalEpoch, (await harness.store.readState(BOX_ID)).nextBoxSeq],
      [4, 1],
      'a newer one is adopted, the sequence restarting with it',
    );
  } finally {
    harness.close();
  }
});

test('a store that WAITS for a minted epoch is not released by a heartbeat: only a reset answer frees it', async () => {
  const cloud = fakeCloud();
  cloud.epoch = 3;
  // A new store under an identity the box already had: no row on the card.
  const box = await openBox(cloud, { storeRow: false });
  try {
    await box.agent.heartbeat();
    // Epoch 3 is the one the OLD store sealed under; sealing on it here would
    // collide with the cloud's own addresses.
    await assert.rejects(sellOffline(box, 'cap-1'), JournalEpochAwaitedError);

    // The Console's Reset the store, answered: the minted epoch frees it.
    cloud.queued.push({ id: 'reset-1', kind: 'reset_store' });
    await box.agent.runPendingCommands();
    assert.equal((await storeEpoch(box)).journalEpoch, 4);
    const sealed = await sellOffline(box, 'cap-2');
    assert.deepEqual([sealed.journalEpoch, sealed.boxSeq], [4, 1]);
  } finally {
    box.agent.stop();
    box.harness.close();
  }
});
