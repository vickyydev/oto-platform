import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintBoothCode } from '@oto/shared';

import {
  OFFLINE_VOUCHER_REFUSAL,
  OfflineSaleRefused,
  createBoxAgent,
  voucherOnOfflineCart,
} from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import { BOX_ID, STATION_ID, openTestStore, seededIndex } from './_support';

/**
 * S2-10b (SCRUM-207) — A VOUCHER NEVER RIDES AN OFFLINE SALE.
 *
 * A voucher is redeemed online only: the platform holds it for one cart and
 * uses it up in the transaction that closes that sale. A sale the box takes
 * with the link down reaches the platform later, through a replay that prices
 * the cart without its `promoCodes` — so a voucher on it would be honoured on
 * the slip alone and never used up. The box refuses such a sale before it
 * numbers or queues anything, with one fixed sentence of its own. (The till's
 * own line for a voucher offline is the api's, `VOUCHER_MESSAGES.offline`, in
 * other words; nothing carries the box's sentence to a till today, as
 * `agent.sales()` has no caller outside this file — closing audit L20.)
 *
 * The agent here is the real one, on a real SQLite store, holding a credential
 * and a receipt mark and with no cloud at all: a box whose mall link is down.
 */

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000ac001';
const quiet = { info() {}, warn() {}, error() {} };
const code = mintBoothCode('B1', seededIndex(7));
const wrongCheck = `${code.slice(0, 10)}${code[10] === 'A' ? 'B' : 'A'}`;

test('the refusal is one fixed sentence, naming the reason and what to do', () => {
  assert.equal(
    OFFLINE_VOUCHER_REFUSAL,
    'Vouchers need the internet — take this one when the connection is back',
  );
});

test('a booth code in promoCodes is a voucher on the cart, flat or nested; nothing else is', () => {
  assert.equal(voucherOnOfflineCart({ promoCodes: [code], expectedTotalSatang: 0 }), code);
  // As the till nests it.
  assert.equal(voucherOnOfflineCart({ cart: { promoCodes: [code] }, expectedTotalSatang: 0 }), code);
  // Typed with a dash and in lower case: the same code.
  const typed = `${code.slice(0, 2).toLowerCase()}-${code.slice(2)}`;
  assert.equal(voucherOnOfflineCart({ promoCodes: [typed] }), code);
  // The ten-character shape printed before the check.
  assert.equal(voucherOnOfflineCart({ promoCodes: ['B1RT7KMQ4X'] }), 'B1RT7KMQ4X');
  // No codes, an ordinary code, a code with a wrong check: no voucher.
  assert.equal(voucherOnOfflineCart({ lines: [], expectedTotalSatang: 100 }), null);
  assert.equal(voucherOnOfflineCart({ promoCodes: ['KIDS23'] }), null);
  assert.equal(voucherOnOfflineCart({ promoCodes: [wrongCheck] }), null);
  // The park's own discount codes ride in `promos` with their definition, and
  // some have a booth code's shape (SONGKRAN25): `promos` is not the box's to judge.
  const songkran = { code: 'SONGKRAN25', label: 'Songkran', type: 'percent', value: 10 };
  assert.equal(voucherOnOfflineCart({ promos: [songkran] }), null);
  // Something that is not a list of strings is not a code.
  assert.equal(voucherOnOfflineCart({ promoCodes: 'B1RT7KMQ4X' }), null);
  assert.equal(voucherOnOfflineCart({ promoCodes: [42, null] }), null);
});

test('the box refuses an offline sale carrying a voucher, spends no receipt number, queues nothing', async () => {
  const t = openTestStore();
  // A till that has been running: its store already keeps this box's journal.
  // A store new under a credential the box already held seals nothing until
  // the platform gives it a new epoch (SCRUM-403, `store-recovery.test.ts`).
  await t.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID,
      secret: 'offline-voucher-test-secret',
      syncPrivateKeyPem: t.keys.privateKeyPem,
    }),
    // The mall's link is down: nothing answers.
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
    log: quiet,
    store: t.store,
    printing: { enabled: false },
    terminal: { enabled: false },
    booth: { enabled: false },
  });
  try {
    await agent.ensureRegistered();
    // Where this till's receipt numbering stood when the box last had a link.
    await t.store.writeBundle(BOX_ID, {
      scope: 'receipt_series',
      schemaVersion: 1,
      cursorSeq: 1,
      payload: { items: [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }] },
      appliedAt: t.now().toISOString(),
    });
    await agent.setOffline(true, { reason: 'the mall link is down' });
    const sales = agent.sales();
    assert.ok(sales, 'a box with a store takes sales offline');

    const cash = (amountSatang: number, actionId: string) => ({
      actionId,
      methodCode: 'cash',
      kind: 'cash' as const,
      amountSatang,
      tenderedSatang: amountSatang,
      changeSatang: 0,
    });
    const before = (await agent.outbox()!.depth()).queued;

    await assert.rejects(
      sales!.record({
        stationId: STATION_ID,
        actorAccountId: ACCOUNT_ID,
        cart: {
          lines: [{ id: 'line-1', packageId: 'pkg-1', kids: 1, adults: 0 }],
          promoCodes: [code],
          expectedTotalSatang: 74_000,
        },
        tenders: [cash(74_000, 'press-0001')],
        actionId: 'press-0001',
      }),
      (err: unknown) =>
        err instanceof OfflineSaleRefused &&
        err.code === 'VOUCHER_NEEDS_INTERNET' &&
        err.message === OFFLINE_VOUCHER_REFUSAL,
    );
    // Nothing went on the queue for it.
    assert.equal((await agent.outbox()!.depth()).queued, before);

    // The same cart without the voucher is taken, and is numbered straight
    // after the mark: the refused sale spent no number in the series.
    const taken = await sales!.record({
      stationId: STATION_ID,
      actorAccountId: ACCOUNT_ID,
      cart: {
        lines: [{ id: 'line-1', packageId: 'pkg-1', kids: 1, adults: 0 }],
        expectedTotalSatang: 89_000,
      },
      tenders: [cash(89_000, 'press-0002')],
      actionId: 'press-0002',
    });
    assert.equal(taken.receipt?.number, 'T1-000043');
    assert.equal((await agent.outbox()!.depth()).queued, before + 1);
  } finally {
    agent.stop();
    t.close();
  }
});
