import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupBoothCode, sliceIndexFor, visiblePrizes } from '../src/booth/wheel-view.ts';

/**
 * SCRUM-223 — the television draws only switched-on prizes, and still stops
 * on the prize the box drew.
 */

function prize(id: string, active: boolean) {
  return {
    id,
    nameEn: id,
    nameTh: null,
    wheelLabel: null,
    weightBp: active ? 5000 : 0,
    active,
    dailyCap: null,
    expiryDays: 14,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: 0,
    voucherDefinitionId: null,
  };
}

const bundle = {
  prizes: [prize('p100', true), prize('mystery', false), prize('p150', true), prize('off2', false)],
};

test('a switched-off prize is never a slice', () => {
  const visible = visiblePrizes(bundle);
  assert.deepEqual(
    visible.map((v) => v.prize.id),
    ['p100', 'p150'],
  );
  assert.equal(visible.some((v) => !v.prize.active), false);
  assert.deepEqual(visiblePrizes(null), []);
});

test('the slice to stop on is found by the prize, not by its place in the bundle', () => {
  const visible = visiblePrizes(bundle);
  // p150 is third in the bundle and second on the wheel.
  assert.equal(sliceIndexFor(visible, { prizeIndex: 2, prizeId: 'p150' }), 1);
  assert.equal(sliceIndexFor(visible, { prizeIndex: 0, prizeId: 'p100' }), 0);
  // A drifted index still lands on the named prize.
  assert.equal(sliceIndexFor(visible, { prizeIndex: 3, prizeId: 'p150' }), 1);
  // A prize the wheel does not show (or does not have) has no slice.
  assert.equal(sliceIndexFor(visible, { prizeIndex: 1, prizeId: 'mystery' }), null);
  assert.equal(sliceIndexFor(visible, { prizeIndex: 0, prizeId: 'nope' }), null);
});

test('a code is shown in groups of 2, 4, 4 and the rest, whatever its length', () => {
  assert.equal(groupBoothCode('B1RT7KMQ4X'), 'B1 RT7K MQ4X');
  assert.equal(groupBoothCode('B1RT7KMQ4XZ'), 'B1 RT7K MQ4X Z');
  assert.equal(groupBoothCode('B1RT7'), 'B1 RT7');
  assert.equal(groupBoothCode('B1 RT7K MQ4X'), 'B1 RT7K MQ4X');
});
