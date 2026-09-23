import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TerminalError } from '../src/terminal/contract';
import { createTerminalRefCounter, deviceTag, formatRef } from '../src/terminal/counter';
import { BOX_ID, openTestStore } from './_support';

/**
 * The per-terminal, per-day reference counter (S2-10a).
 *
 * The counter is `edge.box_counter` with `scope = 'terminal_ref'` and the
 * device id as its key, so "unique per terminal per day" is the table's primary
 * key rather than a rule somebody has to remember. These tests drive the real
 * store — SQLite here, Postgres in the api's suite — because the property being
 * proved is a property of the SQL.
 */

const DEVICE_A = '018f0000-0000-7000-8000-0000000edc01';
const DEVICE_B = '018f0000-0000-7000-8000-0000000edc03';
const TODAY = '2026-09-23';
const TOMORROW = '2026-09-24';

test('a thousand mints on one terminal on one day are a thousand different references', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const counter = createTerminalRefCounter({ store: held.store, boxId: () => BOX_ID });
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(
        await counter.next({ deviceId: DEVICE_A, protocol: 'digio_tlv', businessDate: TODAY }),
      );
    }
    assert.equal(seen.size, 1000);
    for (const ref of seen) assert.match(ref, /^\d{6}$/, 'Digio wants six digits');
  } finally {
    held.close();
  }
});

test('the counter resets when the trading day rolls', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const counter = createTerminalRefCounter({ store: held.store, boxId: () => BOX_ID });
    const first = await counter.next({
      deviceId: DEVICE_A,
      protocol: 'ghl_linkpos',
      businessDate: TODAY,
    });
    await counter.next({ deviceId: DEVICE_A, protocol: 'ghl_linkpos', businessDate: TODAY });
    const nextDay = await counter.next({
      deviceId: DEVICE_A,
      protocol: 'ghl_linkpos',
      businessDate: TOMORROW,
    });
    assert.ok(first.endsWith('0001'));
    assert.ok(nextDay.endsWith('0001'), 'the sequence starts again on the new trading day');
    assert.notEqual(
      first,
      nextDay,
      'and a GHL reference still differs, because the date is in it',
    );
    assert.ok(first.startsWith('260923'));
    assert.ok(nextDay.startsWith('260924'));

    /**
     * A Digio reference REPEATS across days, and that is correct.
     *
     * Six digits have no room for a date, and the uniqueness both vendors ask
     * for is per terminal — Digio's own field is documented as "unique
     * reference number from 3rd party. 6 digit". The cloud's index is
     * `(device_id, business_date, terminal_ref)`, which is the same statement.
     */
    const digioToday = await counter.next({
      deviceId: DEVICE_B,
      protocol: 'digio_tlv',
      businessDate: TODAY,
    });
    const digioTomorrow = await counter.next({
      deviceId: DEVICE_B,
      protocol: 'digio_tlv',
      businessDate: TOMORROW,
    });
    assert.equal(digioToday, digioTomorrow);
  } finally {
    held.close();
  }
});

test('two terminals on one box never mint the same reference on the same day', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const counter = createTerminalRefCounter({ store: held.store, boxId: () => BOX_ID });
    const a = new Set<string>();
    const b = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      a.add(await counter.next({ deviceId: DEVICE_A, protocol: 'digio_tlv', businessDate: TODAY }));
      b.add(await counter.next({ deviceId: DEVICE_B, protocol: 'digio_tlv', businessDate: TODAY }));
    }
    assert.equal(a.size, 200);
    assert.equal(b.size, 200);
    for (const ref of a) assert.equal(b.has(ref), false, `${ref} was minted on both terminals`);
    // The counters are independent: neither terminal consumed the other's
    // sequence, so both ran 1..200 behind their own device tag.
    assert.notEqual(deviceTag(DEVICE_A), deviceTag(DEVICE_B));
  } finally {
    held.close();
  }
});

test('the two tenders of one sale and its void draw from the same counter', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const counter = createTerminalRefCounter({ store: held.store, boxId: () => BOX_ID });
    const sale = await counter.next({
      deviceId: DEVICE_A,
      protocol: 'digio_tlv',
      businessDate: TODAY,
    });
    const voidRef = await counter.next({
      deviceId: DEVICE_A,
      protocol: 'digio_tlv',
      businessDate: TODAY,
    });
    const inquiryRef = await counter.next({
      deviceId: DEVICE_A,
      protocol: 'digio_tlv',
      businessDate: TODAY,
    });
    // Both vendors require a FRESH reference for a void rather than the sale's
    // (GHL pp.16-17, Digio §5.5.1), and a Digio inquiry mints one too.
    assert.notEqual(sale, voidRef);
    assert.notEqual(voidRef, inquiryRef);
  } finally {
    held.close();
  }
});

test('a reference is shaped for the dialect it is going to', () => {
  const ghl = formatRef(
    'ghl_linkpos',
    { deviceId: DEVICE_A, protocol: 'ghl_linkpos', businessDate: TODAY },
    147,
  );
  assert.equal(ghl.length, 12, 'twelve is the intersection of the vendor’s 20, 12 and 32');
  assert.match(ghl, /^\d{12}$/);
  assert.ok(ghl.startsWith('260923'));

  const digio = formatRef(
    'digio_tlv',
    { deviceId: DEVICE_A, protocol: 'digio_tlv', businessDate: TODAY },
    147,
  );
  assert.equal(digio.length, 6);
  assert.match(digio, /^\d{6}$/);
  assert.ok(digio.endsWith('0147'));
});

test('a day that runs out of references is refused, never wrapped', () => {
  // Wrapping would reuse a reference the terminal has already seen today, which
  // is exactly what both vendors forbid.
  assert.throws(
    () =>
      formatRef(
        'digio_tlv',
        { deviceId: DEVICE_A, protocol: 'digio_tlv', businessDate: TODAY },
        10_000,
      ),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_BAD_REQUEST',
  );
});

test('a box with no store refuses to mint rather than counting in memory', async () => {
  const counter = createTerminalRefCounter({ store: null, boxId: () => BOX_ID });
  await assert.rejects(
    counter.next({ deviceId: DEVICE_A, protocol: 'digio_tlv', businessDate: TODAY }),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_NOT_CONFIGURED',
  );
  // And a box that has not registered has no counter either: the key is
  // (box, scope, device, day), and there is no box yet.
  const unregistered = createTerminalRefCounter({ store: null, boxId: () => null });
  await assert.rejects(
    unregistered.next({ deviceId: DEVICE_A, protocol: 'digio_tlv', businessDate: TODAY }),
    TerminalError,
  );
});
