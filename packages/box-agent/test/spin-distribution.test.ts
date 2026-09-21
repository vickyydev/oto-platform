import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { drawPrize, judgePrizes } from '../src/booth-draw';
import { BOOTH_PRIZE_COUNTER_SCOPE, createBooth, type BoothCacheEntry } from '../src/booth';
import { generateSyncKeyPair } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import { BOX_ID, BRANCH_ID, OPERATOR_ID } from './_support';

/**
 * Is the wheel fair? (S2-07a, D6.)
 *
 * The draw is the one piece of this ticket whose wrongness is INVISIBLE. A
 * thumb on the scale does not throw, does not log, and does not fail a
 * type-check; it is discovered by counting several hundred spins, which
 * nobody does until a parent complains. So it is proved three ways, and the
 * three are deliberately different KINDS of evidence rather than three sizes
 * of the same test:
 *
 *  1. **A boundary test with an injected source** — exact, deterministic, and
 *     the only one that can distinguish "tests before subtracting" from
 *     "subtracts before testing" at the single value where they differ. A
 *     statistical test never sees that: both versions pass a chi-square.
 *  2. **A seeded chi-square at N = 100,000** — which catches the errors a
 *     boundary test cannot, such as a source whose low bits are biased or a
 *     renormalisation that drops a slice. Seeded, so it is a fixed number in
 *     CI rather than a coin toss.
 *  3. **The 200-spin table in the `#debug` overlay** — evidence a person reads
 *     at a booth, which the first two are not. What is proved HERE is the
 *     property that makes that table worth reading: it runs through the same
 *     draw a real press runs through, with a flag that stops it writing
 *     anything (D16).
 *
 * **Why the 200-spin table is not itself a CI gate.** "±5 percentage points
 * over 200 spins" is about ±1.6 standard deviations for the launch weights, so
 * roughly a third of honest runs fall outside it. As a gate that is a suite
 * that goes red on Tuesdays for no reason, which is worse than no gate at all
 * because of what people learn to do about it. The table stays a diagnostic
 * for a person; the gate is the seeded chi-square below, whose value does not
 * move between runs.
 */

const STATION_ID = '018f1d2c-0000-7000-8000-0000000057b1';
const LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const CONFIG_VERSION_ID = '018f1d2c-0000-7000-8000-00000000fc01';
const AT = '2026-09-21T06:00:00.000Z';
const BUSINESS_DATE = '2026-09-21';

/**
 * The live booth's six prizes, at the odds it is running today: 23.5 / 27.5 /
 * 17.5 / 14.5 / 14.5 / 2.5 per cent, as basis points summing to 10,000.
 *
 * Copied from the seed rather than imported, because `@oto/db` is a server
 * package with a database behind it and this file needs six numbers. If the
 * seed's weights change this drifts, which costs a reading of a comment and
 * proves exactly as much about the draw either way — what is under test is the
 * arithmetic, not the park's marketing.
 */
const LAUNCH_WEIGHTS_BP = [2350, 2750, 1750, 1450, 1450, 250];

function prize(index: number, weightBp: number, over: { dailyCap?: number | null } = {}) {
  return {
    id: `018f1d2c-0000-7000-8000-00000000fa1${index}`,
    nameEn: `Prize ${index}`,
    nameTh: null,
    wheelLabel: null,
    weightBp,
    active: true,
    dailyCap: over.dailyCap ?? null,
    expiryDays: 14,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: index,
    voucherDefinitionId: `018f1d2c-0000-7000-8000-00000000fd0${index}`,
  };
}

const LAUNCH_PRIZES = LAUNCH_WEIGHTS_BP.map((weight, index) => prize(index, weight));

/**
 * A seeded PRNG, for this file only.
 *
 * **Not the draw's source and never allowed to become one.** The box passes
 * `randomInt` from `node:crypto` (D3); this exists so that a hundred thousand
 * draws produce the SAME hundred thousand draws on every machine, which is
 * what turns a statistical check into a deterministic assertion. mulberry32 is
 * a well-behaved 32-bit generator — good enough that a failure below is a
 * failure of the draw rather than of the generator, and `Math.floor(r * max)`
 * over a 32-bit mantissa carries bias far below what a chi-square at this N
 * can see.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. The boundary --------------------------------------------------------

test('every basis point maps to exactly the slice it should, at both edges of each', () => {
  /**
   * Walked exhaustively across the whole wheel rather than sampled. Ten
   * thousand draws is nothing, and it is the only way to show that the map
   * from a roll to a slice has no gap and no overlap — a slice that is one
   * basis point wide or one too many is invisible to every other test in this
   * file, and it is a real prize given away at the wrong rate.
   */
  const counts = new Array<number>(LAUNCH_PRIZES.length).fill(0);
  for (let roll = 0; roll < 10_000; roll += 1) {
    const outcome = drawPrize(LAUNCH_PRIZES, () => roll);
    assert.equal(outcome.ok, true, `roll ${roll} drew nothing`);
    if (outcome.ok) counts[outcome.index] = (counts[outcome.index] ?? 0) + 1;
  }
  assert.deepEqual(
    counts,
    LAUNCH_WEIGHTS_BP,
    'each slice is exactly as many basis points wide as it was published',
  );
});

test('the boundary between two slices belongs to the later one, not to both', () => {
  const two = [prize(0, 100), prize(1, 200)];
  const drew = (roll: number): number => {
    const outcome = drawPrize(two, () => roll);
    return outcome.ok ? outcome.index : -1;
  };
  assert.equal(drew(99), 0);
  assert.equal(drew(100), 1, 'the first basis point past the first slice');
  // And the far edge: the last roll the source can produce is still in range.
  assert.equal(drew(299), 1);
});

test('renormalisation moves the boundaries, which is the whole point of it', () => {
  /**
   * With the third prize capped, the draw is over 10,000 − 1,750 = 8,250
   * basis points. Roll 2,350 was the first basis point of slice 1 on the full
   * wheel and must still be, because the capped slice is LATER in the order —
   * but roll 8,249 is now the last valid roll rather than 9,999.
   */
  const counters = { [LAUNCH_PRIZES[2]!.id]: 5 };
  const capped = LAUNCH_PRIZES.map((p, i) => (i === 2 ? { ...p, dailyCap: 1 } : p));
  const total = 10_000 - 1750;

  const seen = new Set<number>();
  for (let roll = 0; roll < total; roll += 1) {
    const outcome = drawPrize(capped, () => roll, { counters });
    assert.equal(outcome.ok, true);
    if (outcome.ok) seen.add(outcome.index);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 3, 4, 5], 'slice 2 is unreachable');

  // A roll at the OLD total is now out of range and is refused rather than
  // silently clamped — which is what stops a stale denominator going unnoticed.
  assert.throws(() => drawPrize(capped, () => total, { counters }), /not an index into 8250/);
});

// --- 2. The chi-square ------------------------------------------------------

test('100,000 seeded draws match the published weights (chi-square, df=5)', () => {
  const N = 100_000;
  const rng = mulberry32(0x07ac07a1);
  const counts = new Array<number>(LAUNCH_PRIZES.length).fill(0);
  for (let i = 0; i < N; i += 1) {
    const outcome = drawPrize(LAUNCH_PRIZES, (max) => Math.floor(rng() * max));
    assert.equal(outcome.ok, true);
    if (outcome.ok) counts[outcome.index] = (counts[outcome.index] ?? 0) + 1;
  }

  let chiSquare = 0;
  LAUNCH_WEIGHTS_BP.forEach((weightBp, index) => {
    const expected = (N * weightBp) / 10_000;
    const observed = counts[index] ?? 0;
    chiSquare += (observed - expected) ** 2 / expected;
  });

  /**
   * Five degrees of freedom. 20.515 is the 0.999 critical value, so an honest
   * draw exceeds it once in a thousand runs — and this run is SEEDED, so it
   * either exceeds it every time or never. A failure here is a change to the
   * draw, not a bad afternoon.
   */
  assert.ok(
    chiSquare < 20.515,
    `chi-square ${chiSquare.toFixed(3)} exceeds the 0.999 critical value for df=5`,
  );
  /**
   * And a floor, which is the assertion people forget. A chi-square that is
   * implausibly SMALL means the observed counts are closer to the expectation
   * than randomness allows — the signature of a draw that has quietly become
   * a round-robin, or of a test measuring a fixed sequence. 0.554 is the 0.01
   * critical value: an honest draw falls below it one run in a hundred.
   */
  assert.ok(
    chiSquare > 0.554,
    `chi-square ${chiSquare.toFixed(3)} is too good to be random — is this draw still random?`,
  );

  // Each slice within a percentage point of its published share. At this N the
  // standard error is about 0.13 of a point, so this is a wide bound that
  // still fails loudly on a slice that has been dropped or double-counted.
  LAUNCH_WEIGHTS_BP.forEach((weightBp, index) => {
    const share = ((counts[index] ?? 0) / N) * 100;
    const published = weightBp / 100;
    assert.ok(
      Math.abs(share - published) < 1,
      `slice ${index} came out at ${share.toFixed(2)}% against a published ${published}%`,
    );
  });
});

test('a biased source is caught by the same check, which is what makes it worth running', () => {
  /**
   * The test's own negative control. A draw that ignores its source and always
   * answers the first slice has to FAIL the gate above — otherwise the gate
   * proves nothing and would go on passing after somebody replaced the draw
   * with a constant.
   */
  const N = 10_000;
  const counts = new Array<number>(LAUNCH_PRIZES.length).fill(0);
  for (let i = 0; i < N; i += 1) {
    const outcome = drawPrize(LAUNCH_PRIZES, () => 0);
    if (outcome.ok) counts[outcome.index] = (counts[outcome.index] ?? 0) + 1;
  }
  let chiSquare = 0;
  LAUNCH_WEIGHTS_BP.forEach((weightBp, index) => {
    const expected = (N * weightBp) / 10_000;
    chiSquare += ((counts[index] ?? 0) - expected) ** 2 / expected;
  });
  assert.ok(chiSquare > 20.515, 'a stuck source must not pass the fairness gate');
});

// --- 3. The table on the screen ---------------------------------------------

test('the debug table draws through the same code a real press draws through (D16)', async () => {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const now = new Date(AT);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  await store.init(BOX_ID);
  const keys = generateSyncKeyPair();

  const rolls: number[] = [];
  let index = 0;
  const booth = createBooth({
    boxId: BOX_ID,
    store,
    station: () => ({ id: STATION_ID, name: 'Booth 1', codePrefix: 'B1' }),
    branch: () => ({
      id: BRANCH_ID,
      operatorId: OPERATOR_ID,
      name: 'HKT Central',
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00',
    }),
    privateKey: () => keys.privateKeyPem,
    print: null,
    randomIndex: (max) => Math.min(rolls[index++ % rolls.length] ?? 0, max - 1),
    now: () => now,
  });

  const cached: BoothCacheEntry = {
    stationId: STATION_ID,
    configVersionId: CONFIG_VERSION_ID,
    version: 1,
    bundleHash: 'a'.repeat(64),
    allowedStaff: [],
    voucherDefinitions: [],
    bundle: {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
      layout: { id: LAYOUT_ID, name: 'Classic wheel', version: 1, design: {}, assetManifest: {} },
      prizes: LAUNCH_PRIZES,
    },
  };
  await store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 1,
    payload: { items: [cached] },
    appliedAt: AT,
  });
  await booth.refresh();

  /**
   * The sharp version of "the same draw": for a given roll, a SIMULATED press
   * lands on exactly the slice `drawPrize` lands on. A table generated by a
   * second copy of the arithmetic would agree on the easy rolls and diverge at
   * the boundaries, which is precisely where a distribution table is supposed
   * to be evidence.
   */
  for (const roll of [0, 2349, 2350, 5099, 9749, 9999]) {
    rolls.length = 0;
    rolls.push(roll);
    index = 0;
    const direct = drawPrize(LAUNCH_PRIZES, () => roll);
    const simulated = await booth.spin({ idempotencyKey: `sim-${roll}`, simulate: true });
    assert.equal(direct.ok, true);
    assert.equal(simulated.prizeIndex, direct.ok ? direct.index : -1, `roll ${roll}`);
    assert.equal(simulated.prizeId, direct.ok ? direct.prize.id : '', `roll ${roll}`);
  }

  // Two hundred of them, which is what the overlay runs, and afterwards this
  // booth is unchanged: no spin, no voucher, no cap consumed, nothing printed.
  const rng = mulberry32(0x5eed);
  const drawn = new Array<number>(LAUNCH_PRIZES.length).fill(0);
  for (let i = 0; i < 200; i += 1) {
    rolls.length = 0;
    rolls.push(Math.floor(rng() * 10_000));
    index = 0;
    const simulated = await booth.spin({ idempotencyKey: `table-${i}`, simulate: true });
    drawn[simulated.prizeIndex] = (drawn[simulated.prizeIndex] ?? 0) + 1;
  }
  assert.equal(
    drawn.reduce((sum, n) => sum + n, 0),
    200,
    'every simulated press landed on a slice',
  );
  const batch = await store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 0, '200 simulated presses wrote no facts');
  assert.deepEqual(
    await store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, BUSINESS_DATE),
    {},
    'and consumed no daily cap — which is what stops the table minting 200 vouchers',
  );
  db.close();
});

test('a simulated draw HONOURS a cap even though it does not consume one', async () => {
  /**
   * The other half of the flag, and the one that is easy to get backwards. A
   * simulation that ignored caps would show a table full of a prize the booth
   * can no longer give away, which is the opposite of a diagnostic.
   */
  const capped = LAUNCH_PRIZES.map((p, i) => (i === 0 ? { ...p, dailyCap: 1 } : p));
  const counters = { [capped[0]!.id]: 1 };
  const judged = judgePrizes(capped, { counters });
  assert.equal(judged[0]?.eligible, false);
  assert.equal(judged[0]?.reason, 'capped');
  for (let roll = 0; roll < 10; roll += 1) {
    const outcome = drawPrize(capped, () => roll, { counters });
    assert.notEqual(outcome.ok && outcome.prize.id, capped[0]!.id);
  }
});
