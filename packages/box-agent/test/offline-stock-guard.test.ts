import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BridgeCart, StockSnapshotItem } from '@oto/shared';
import {
  planStock,
  readStockShares,
  readStockSnapshot,
  shareReflected,
  stockAsksOf,
  stockAvailable,
  stockShortages,
  stockShortRefusal,
  stockSizeRefusal,
  unreflectedUnits,
  type StockAsk,
  type StockShare,
} from '../src/stock-lane';

/**
 * THE BOX'S STOCK GUARD, AS ARITHMETIC — S2-14b round 3 (plan
 * docs/progress/plans/stock/PLAN.md §2.4).
 *
 *   available = snapshot total − this box's own counted shares whose sale
 *                                sits above the snapshot's filed mark
 *
 * per size, honouring an add-on's breakdown, in the platform guard's words.
 * The bridge suite (`offline-stock.test.ts`) proves the same through a real
 * store, a restart and the sale's own transaction.
 */

const SOCKS = 'p-socks';
const CAP = 'p-cap';
const GRIP = 'p-grip';
const FOH = 'loc-foh';
const BOH = 'loc-boh';

function snapshot(over: Partial<StockSnapshotItem> = {}): StockSnapshotItem {
  const entry = (
    stockItemId: string,
    productId: string,
    itemName: string,
    variantId: string | null,
    sizeLabel: string | null,
    foh: number,
    boh: number,
  ) => ({ stockItemId, productId, itemName, variantId, sizeLabel, levels: { [FOH]: foh, [BOH]: boh }, total: foh + boh });
  return {
    version: 'stock-v1',
    generatedAt: '2026-10-02T03:00:00.000Z',
    branchId: 'branch',
    sellPointId: FOH,
    places: [
      { id: FOH, name: 'FOH', type: 'rotation', sellPoint: true },
      { id: BOH, name: 'BOH', type: 'back_of_house', sellPoint: false },
    ],
    items: [
      entry('si-socks-s', SOCKS, 'Grip Socks', 's', 'S', 2, 1),
      entry('si-socks-m', SOCKS, 'Grip Socks', 'm', 'M', 0, 0),
      entry('si-socks-l', SOCKS, 'Grip Socks', 'l', 'L', 5, 5),
      entry('si-cap', CAP, 'Oto Cap', null, null, 1, 0),
      entry('si-grip-s', GRIP, 'Grip Add-on', 's', 'S', 2, 0),
      entry('si-grip-m', GRIP, 'Grip Add-on', 'm', 'M', 1, 0),
    ],
    boxFiled: { journalEpoch: 1, boxSeq: 0 },
    ...over,
  };
}

const ask = (productId: string, quantity: number, more: Partial<StockAsk> = {}): StockAsk => ({
  productId,
  label: productId,
  quantity,
  ...more,
});

const share = (boxSeq: number, quantity: number, journalEpoch = 1): StockShare => ({
  saleId: `sale-${journalEpoch}-${boxSeq}`,
  journalEpoch,
  boxSeq,
  quantity,
});

test('available is the snapshot less this box’s own sales the snapshot does not yet reflect, never negative', () => {
  assert.equal(stockAvailable({ total: 3 }, 0), 3);
  assert.equal(stockAvailable({ total: 3 }, 2), 1, 'two sold here since the snapshot');
  assert.equal(stockAvailable({ total: 0 }, 5), 0, 'never below nothing');
  assert.equal(stockAvailable({ total: 4 }, -1), 4, 'a damaged count takes nothing off');
});

test('reflected or not is the share’s journal position against the snapshot’s filed mark — never a total', () => {
  const mark = { journalEpoch: 2, boxSeq: 10 };
  assert.equal(shareReflected({ journalEpoch: 2, boxSeq: 10 }, mark, 2), true, 'at the mark: in the levels');
  assert.equal(shareReflected({ journalEpoch: 2, boxSeq: 11 }, mark, 2), false, 'above it: not yet');
  assert.equal(shareReflected({ journalEpoch: 1, boxSeq: 999 }, mark, 2), true, 'an epoch the platform moved on from');
  assert.equal(shareReflected({ journalEpoch: 1, boxSeq: 999 }, mark, 3), true, 'filed aside before a re-provisioning');
  assert.equal(shareReflected({ journalEpoch: 3, boxSeq: 1 }, mark, 3), false, 'a re-provisioned store starts clean');
  assert.equal(shareReflected({ journalEpoch: 2, boxSeq: 1 }, null, 2), false, 'no mark: nothing is reflected');

  // THE FINAL GATE FINDING: the platform minted epoch 2 but the box never
  // adopted it and still seals on 1. A mark on epoch 2 cannot hold the sales
  // the box keeps sealing on its own epoch — however low or high their seq.
  assert.equal(shareReflected({ journalEpoch: 1, boxSeq: 1 }, mark, 1), false, 'the box’s own epoch, mark on a newer one');
  assert.equal(shareReflected({ journalEpoch: 1, boxSeq: 999 }, mark, 1), false, 'still not, at any position');
  assert.equal(unreflectedUnits([share(4, 1), share(7, 1)], mark, 1), 2, 'nothing hidden by an epoch the box never adopted');
  // The store could not say which epoch it seals on: cautious, only the mark's own epoch is judged.
  assert.equal(shareReflected({ journalEpoch: 1, boxSeq: 999 }, mark, null), false, 'unknown epoch: not reflected');
  assert.equal(shareReflected({ journalEpoch: 2, boxSeq: 9 }, mark, null), true, 'unknown epoch: the mark’s own still judged');

  // Two sold here (seq 4 and 7), the platform has applied up to 5: one unreflected.
  const shares = [share(4, 1), share(7, 1)];
  assert.equal(unreflectedUnits(shares, { journalEpoch: 1, boxSeq: 5 }, 1), 1);
  assert.equal(unreflectedUnits(shares, { journalEpoch: 1, boxSeq: 7 }, 1), 0, 'reflected sales are not taken off twice');
  assert.equal(unreflectedUnits(shares, null, 1), 2);

  // THE GATE FINDING: a sale the platform filed that the box never counted
  // (seq 3: no snapshot row then) moves the mark past it — and hides nothing.
  // The old rule (all-time totals: platform 2 filed, box 1 counted) let the
  // surplus swallow the later unreflected sale and sold past the shelf.
  const afterUncounted = [share(5, 1)];
  assert.equal(unreflectedUnits(afterUncounted, { journalEpoch: 1, boxSeq: 3 }, 1), 1);
  assert.equal(stockAvailable({ total: 1 }, unreflectedUnits(afterUncounted, { journalEpoch: 1, boxSeq: 3 }, 1)), 0);

  // A counted sale the platform filed aside (quarantined, never applied): once
  // its mark passes it, the box stops counting it — no permanent refusal.
  const discarded = [share(6, 2)];
  assert.equal(stockAvailable({ total: 2 }, unreflectedUnits(discarded, { journalEpoch: 1, boxSeq: 5 }, 1)), 0, 'not yet passed');
  assert.equal(stockAvailable({ total: 2 }, unreflectedUnits(discarded, { journalEpoch: 1, boxSeq: 6 }, 1)), 2, 'passed: the snapshot stands');
});

test('the open shares are read defensively: junk or a damaged entry is dropped', () => {
  assert.deepEqual(readStockShares(null), []);
  assert.deepEqual(readStockShares('not json'), []);
  assert.deepEqual(readStockShares('{"a":1}'), []);
  assert.deepEqual(
    readStockShares(
      JSON.stringify([
        { saleId: 's1', journalEpoch: 1, boxSeq: 4, quantity: 2 },
        { saleId: 's2', journalEpoch: 1, boxSeq: 5, quantity: 0 },
        { saleId: 's3', journalEpoch: 1, quantity: 1 },
        { journalEpoch: 1, boxSeq: 6, quantity: 1 },
      ]),
    ),
    [{ saleId: 's1', journalEpoch: 1, boxSeq: 4, quantity: 2 }],
  );
});

test('per size: each size against its own count, refused in the counter’s words', () => {
  const snap = snapshot();
  const plan = planStock([ask(SOCKS, 4, { variant: { variantId: 's', variantLabel: 'S' } })], snap);
  assert.deepEqual([...plan.demand], [['si-socks-s', 4]]);
  const short = stockShortages(plan.demand, snap, () => 0);
  assert.equal(stockShortRefusal(short), 'Only 3 Grip Socks S left. Nothing was saved.');
  const out = stockShortages(planStock([ask(SOCKS, 1, { variant: { variantId: 'm' } })], snap).demand, snap, () => 0);
  assert.equal(stockShortRefusal(out), 'Grip Socks M is out of stock. Nothing was saved.');
  // Two lines of one size count together.
  const two = planStock(
    [ask(SOCKS, 2, { variant: { variantId: 's' } }), ask(SOCKS, 2, { variant: { variantId: 's' } })],
    snap,
  );
  assert.deepEqual([...two.demand], [['si-socks-s', 4]]);
  // Within stock: nothing to say.
  assert.deepEqual(stockShortages(planStock([ask(SOCKS, 3, { variant: { variantId: 's' } })], snap).demand, snap, () => 0), []);
  // The box's own sales since the snapshot come off.
  assert.equal(
    stockShortRefusal(stockShortages(planStock([ask(CAP, 1)], snap).demand, snap, (id) => (id === 'si-cap' ? 1 : 0))),
    'Oto Cap is out of stock. Nothing was saved.',
  );
});

test('an add-on’s variantBreakdown takes each size it names; a short or long breakdown is refused', () => {
  const snap = snapshot();
  const fits = planStock(
    [ask(GRIP, 3, { breakdown: [{ variantId: 's', variantLabel: 'S', quantity: 2 }, { variantId: 'm', variantLabel: 'M', quantity: 1 }] })],
    snap,
  );
  assert.deepEqual(fits.sizeProblems, []);
  assert.deepEqual([...fits.demand], [['si-grip-s', 2], ['si-grip-m', 1]]);
  assert.deepEqual(stockShortages(fits.demand, snap, () => 0), []);

  // The prototype's guard ignored the breakdown: 2 M is short even though 3 add-ons "fit".
  const twoM = planStock([ask(GRIP, 2, { breakdown: [{ variantId: 'm', quantity: 2 }] })], snap);
  assert.equal(stockShortRefusal(stockShortages(twoM.demand, snap, () => 0)), 'Only 1 Grip Add-on M left. Nothing was saved.');

  const unsized = planStock([ask(GRIP, 2)], snap);
  assert.equal(stockSizeRefusal(unsized.sizeProblems), 'Choose a size for Grip Add-on — it comes in S, M. Nothing was saved.');
  const partial = planStock([ask(GRIP, 3, { breakdown: [{ variantId: 's', quantity: 1 }] })], snap);
  assert.deepEqual(partial.sizeProblems, ['Choose a size for Grip Add-on — it comes in S, M']);
  const over = planStock([ask(GRIP, 1, { breakdown: [{ variantId: 's', quantity: 2 }] })], snap);
  assert.deepEqual(over.sizeProblems, ['The sizes chosen for Grip Add-on add up to more than the 1 on the line']);
  const unknown = planStock([ask(GRIP, 1, { breakdown: [{ variantId: 'xl', variantLabel: 'XL', quantity: 1 }] })], snap);
  assert.deepEqual(unknown.sizeProblems, ['Grip Add-on has no size XL in stock here — it comes in S, M']);
});

test('a product the snapshot does not count takes nothing; a one-size item ignores a size it was not sold in', () => {
  const snap = snapshot();
  const plan = planStock([ask('p-sticker', 9), ask(CAP, 1, { variant: { variantId: 'whatever' } })], snap);
  assert.deepEqual([...plan.demand], [['si-cap', 1]]);
  assert.deepEqual([...plan.counted], [CAP]);
});

test('the asks a cart makes: items with their size, a ticket line’s socks and add-ons with their breakdown', () => {
  const cart = {
    socks: { addOnId: 'a-socks' },
    lines: [
      {
        id: 'l1',
        packageId: 'pkg',
        kids: 2,
        adults: 1,
        socks: 2,
        addOns: [
          { id: GRIP, quantity: 3, variantBreakdown: [{ variantId: 's', quantity: 3 }] },
          { id: 'not-in-catalogue', quantity: 1 },
        ],
      },
    ],
    items: [{ id: 'i1', productId: CAP, quantity: 1, modifiers: [], variant: null }],
    manualDiscounts: [],
    promos: [],
    promoCodes: [],
  } as unknown as BridgeCart;
  const known: Record<string, string> = { [GRIP]: 'Grip Add-on', [CAP]: 'Oto Cap', [SOCKS]: 'Grip Socks' };
  const asks = stockAsksOf(cart, {
    socksProductId: SOCKS,
    productOf: (id) => (known[id] ? { id, name: known[id]! } : null),
  });
  assert.deepEqual(
    asks.map((a) => [a.productId, a.quantity, a.breakdown?.map((b) => `${b.variantId}x${b.quantity}`).join(',') ?? null]),
    [
      [CAP, 1, null],
      [SOCKS, 2, null],
      [GRIP, 3, 'sx3'],
    ],
  );
});

test('the scope is read defensively: no item, or junk, is no snapshot; bad rows are dropped', () => {
  assert.equal(readStockSnapshot(null), null);
  assert.equal(readStockSnapshot({ items: [] }), null);
  assert.equal(readStockSnapshot({ items: [{ version: 'x' }] }), null);
  const read = readStockSnapshot({
    items: [
      {
        version: 'v',
        generatedAt: 'g',
        branchId: 'b',
        sellPointId: FOH,
        places: [{ id: FOH, name: 'FOH', type: 'rotation', sellPoint: true }],
        items: [
          { stockItemId: 'a', productId: CAP, itemName: 'Oto Cap', variantId: null, sizeLabel: null, levels: { [FOH]: 3 }, total: 3 },
          { stockItemId: 'b' },
          { stockItemId: 'c', productId: CAP, levels: { [FOH]: -4, x: 'two' } },
        ],
        boxFiled: { journalEpoch: 2, boxSeq: 41 },
      },
    ],
  });
  assert.ok(read);
  assert.deepEqual(
    read.items.map((e) => [e.stockItemId, e.total]),
    [
      ['a', 3],
      ['c', 0],
    ],
  );
  assert.deepEqual(read.boxFiled, { journalEpoch: 2, boxSeq: 41 });
  // A mark that is not whole is no mark: the box then trusts nothing as reflected.
  const noMark = (boxFiled: unknown) =>
    readStockSnapshot({ items: [{ version: 'v', items: [], boxFiled }] })?.boxFiled;
  assert.equal(noMark(undefined), null);
  assert.equal(noMark({ journalEpoch: 0, boxSeq: 3 }), null);
  assert.equal(noMark({ journalEpoch: 1, boxSeq: -1 }), null);
  assert.equal(noMark({ journalEpoch: 1, boxSeq: '3' }), null);
  assert.deepEqual(noMark({ journalEpoch: 1, boxSeq: 0 }), { journalEpoch: 1, boxSeq: 0 });
});
