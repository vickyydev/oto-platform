import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planCacheApply } from '../src/cache-apply';

/**
 * Which scopes of a cache pull may land on a box, and in which order (S2-06).
 *
 * This is a security rule wearing the clothes of a bookkeeping one. The staff
 * list says who may work at the counter; the deny-list says whose access has
 * since been withdrawn. A box holding the first without the second admits a
 * dismissed employee's shift token for as long as it lives — and the way a box
 * got into that state was not an attack, it was one `writeBundle` failing part
 * way through a loop that carried on regardless.
 *
 * Tested as a function rather than through the agent because the agent's own
 * path needs a cloud, a store and a transport, and the rule is worth a case
 * that cannot be made to pass by any of those. `syncCache` writes exactly what
 * this returns, in this order.
 */

test('an ordinary pull applies everything, deny-list first', () => {
  const plan = planCacheApply(['catalogue', 'members', 'staff', 'deny_list', 'bookings'], []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.apply[0], 'deny_list', 'the deny-list is written before the staff list');
  assert.deepEqual([...plan.apply].sort(), [
    'bookings',
    'catalogue',
    'deny_list',
    'members',
    'staff',
  ]);
});

test('a staff list with no deny-list beside it is not applied at all', () => {
  // `GET /box/v1/cache?scopes=staff` used to answer exactly this, and a box
  // that asked that way held who-may-work-here and nothing about who had been
  // stopped — permanently, because nothing ever corrected it.
  const plan = planCacheApply(['catalogue', 'staff'], []);
  assert.ok(!plan.apply.includes('staff'));
  assert.deepEqual(plan.skipped, [{ scope: 'staff', reason: 'missing_deny_list' }]);
  // Everything else still lands: a price list is not held hostage by this.
  assert.deepEqual(plan.apply, ['catalogue']);
});

test('a truncated deny-list takes the staff list down with it', () => {
  // Half a deny-list is worse than none — it reads as a complete answer — so
  // it is skipped, and skipping it means the staff list cannot land either.
  const plan = planCacheApply(['staff', 'deny_list'], ['deny_list']);
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.skipped, [
    { scope: 'deny_list', reason: 'truncated' },
    { scope: 'staff', reason: 'missing_deny_list' },
  ]);
});

test('a truncated staff list is skipped on its own, and the deny-list still lands', () => {
  // The safe direction: the box keeps its last complete staff list and takes
  // the newer revocations. Somebody withdrawn this morning is refused tonight.
  const plan = planCacheApply(['staff', 'deny_list'], ['staff']);
  assert.deepEqual(plan.apply, ['deny_list']);
  assert.deepEqual(plan.skipped, [{ scope: 'staff', reason: 'truncated' }]);
});

test('the deny-list is first in every plan that contains it', () => {
  // Because `syncCache` abandons the pull at the first write that fails, the
  // order is the guarantee: any prefix of the plan leaves a box whose
  // revocations are at least as fresh as its staff list.
  for (const present of [
    ['deny_list', 'staff'],
    ['staff', 'deny_list'],
    ['members', 'staff', 'catalogue', 'deny_list'],
    ['bands', 'deny_list'],
  ]) {
    const plan = planCacheApply(present, []);
    assert.equal(plan.apply[0], 'deny_list', present.join(','));
  }
});

test('a pull with no staff list in it is left alone', () => {
  const plan = planCacheApply(['catalogue', 'members'], []);
  assert.deepEqual(plan.apply, ['catalogue', 'members']);
  assert.deepEqual(plan.skipped, []);
});
