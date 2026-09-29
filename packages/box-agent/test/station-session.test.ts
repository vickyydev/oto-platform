import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STATION_LEASE_TTL_S,
  type StationChannelMessage,
  type StationLease,
} from '../src/contract';
import { StationSessionManager } from '../src/station-session';
import type { QueuedFact, SessionWrite, StationEventWrite } from '../src/store';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, plus, STATION_ID } from './_support';

const AT = '2026-09-20T03:00:00.000Z';
/** The manager whose name goes on a takeover. A takeover with none is refused. */
const MANAGER_ID = '018f0000-0000-7000-8000-0000000000a1';

interface Harness {
  manager: StationSessionManager;
  facts: QueuedFact[];
  events: StationEventWrite[];
  setNow(iso: string): void;
  close(): void;
}

async function openManager(): Promise<Harness> {
  const store = openTestStore(AT);
  await store.store.init(BOX_ID);
  const facts: QueuedFact[] = [];
  const events: StationEventWrite[] = [];
  const recordStationEvent = store.store.recordStationEvent.bind(store.store);
  store.store.recordStationEvent = async (event, now) => {
    events.push(event);
    await recordStationEvent(event, now);
  };
  const manager = new StationSessionManager({
    store: store.store,
    boxId: BOX_ID,
    resolveStation: (stationId) =>
      stationId === STATION_ID
        ? { stationId, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID }
        : null,
    queueFact: async (fact) => {
      facts.push(fact);
    },
    now: () => store.now(),
  });
  return { manager, facts, events, setNow: store.setNow, close: store.close };
}

function publicPresentation() {
  return {
    cart: {
      supported: true, nickname: 'Nok',
      sale: {
        id: 'sale-1', tier: 'member', total: 190,
        lines: [{ id: 'line-1', name: 'Play', translations: { en: 'Play', th: 'Play TH' }, lineTotal: 200,
          breakdown: { rows: [{ key: 'kids', kind: 'kids', label: 'Children', unitPrice: 100, quantity: 2, subtotal: 200 }],
            priced: true, lengthChosen: true } }],
        manualDiscounts: [{ id: 'discount-1', scope: 'order', type: 'fixed', value: 10 }],
        creditGrants: [{ type: 'fnb_credit', label: 'Food credit', valueTHB: 20 }],
        bracelets: { adults: 1, children: 2 },
      },
      voucherPrize: null, nothingToPay: false,
    },
    member: { id: 'm-1', nickname: 'Nok', tier: 'member' },
    totals: { manualAmounts: { 'discount-1': 10 }, discountAmount: 10, total: 190,
      taxBreakdown: { serviceChargeTotal: 0,
        categories: [{ taxMode: 'inclusive', taxName: 'VAT', tax: 12.43, secondaryTaxMode: 'none', secondaryTax: 0 }] } },
    payment: { saleId: 'sale-1', amountSatang: 19000, qrPayload: 'test-only-payment-data', qrImageUrl: null,
      expiresAt: plus(AT, 60_000), status: 'pending', offline: false, online: true },
  };
}

test('two screens on one station see the same snapshot and the same sequence', async () => {
  const h = await openManager();
  const till: StationChannelMessage[] = [];
  const display: StationChannelMessage[] = [];
  h.manager.subscribe(STATION_ID, 'staff', (m) => till.push(m));
  h.manager.subscribe(STATION_ID, 'customer', (m) => display.push(m));

  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
    accountId: null,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  const applied = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'display.set_language',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { language: 'th' },
    },
    { source: 'till' },
  );
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const lastTill = till.filter((m) => m.kind === 'snapshot').at(-1);
  const lastDisplay = display.filter((m) => m.kind === 'snapshot').at(-1);
  assert.equal(
    lastTill?.kind === 'snapshot' && lastTill.document.sequence,
    applied.document.sequence,
  );
  assert.equal(
    lastDisplay?.kind === 'snapshot' && lastDisplay.document.sequence,
    applied.document.sequence,
  );
  assert.equal(lastDisplay?.kind === 'snapshot' && lastDisplay.document.language, 'th');
  assert.equal(h.manager.subscriberCount(STATION_ID), 2);
  h.close();
});

test('a second till on a live lease is refused until a manager takes it over', async () => {
  const h = await openManager();
  const first = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(first.ok, true);

  const second = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-2',
    holderKind: 'till',
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.refusal, 'no_lease');

  const manager = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-2',
    holderKind: 'till',
    accountId: MANAGER_ID,
    takeover: true,
  });
  assert.equal(manager.ok, true);
  if (!manager.ok) return;
  assert.equal(manager.takenOver, true);
  assert.equal(manager.document.takeoverCount, 1);

  // The takeover is a fact for the cloud's audit, not only a log line: it is
  // exactly the thing somebody asks about a week later — and the first thing
  // that question asks is WHO.
  const takeover = h.facts.find((fact) => fact.type === 'station.takeover');
  assert.ok(takeover, 'a takeover queues station.takeover');
  assert.equal(takeover?.actorAccountId, MANAGER_ID);
  assert.equal(takeover?.payload.newLeaseId, manager.lease.leaseId);
  h.close();
});

/**
 * The holder string is on the document, so it is something anybody watching
 * can type back. Before the account was part of the test, doing so was read as
 * a RENEWAL: the second till kept the live lease id, `takenOver` came back
 * false, no fact was queued and nobody was ever told a sale had changed hands.
 */
test('copying the holder string off the document is not a renewal', async () => {
  const h = await openManager();
  const OTHER_ID = '018f0000-0000-7000-8000-0000000000b2';
  const first = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'ipad-A2',
    holderKind: 'till',
    accountId: MANAGER_ID,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const copied = await h.manager.claim({
    stationId: STATION_ID,
    // The holder exactly as the snapshot publishes it, from a different
    // account: a second till, not the first one's other tab.
    holder: 'ipad-A2',
    holderKind: 'till',
    accountId: OTHER_ID,
  });
  assert.equal(copied.ok, false, 'a copied holder must not renew somebody else’s lease');
  if (copied.ok) return;
  assert.equal(copied.refusal, 'no_lease');

  const row = await h.manager.open(STATION_ID);
  assert.equal(row.lease?.leaseId, first.lease.leaseId);
  assert.equal(row.lease?.accountId, MANAGER_ID);
  assert.equal(h.facts.length, 0, 'nothing changed hands, so nothing is audited');

  // And the same holder from the account that claimed it — the reloaded tab —
  // is the renewal it always was.
  const reloaded = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'ipad-A2',
    holderKind: 'till',
    accountId: MANAGER_ID,
  });
  assert.equal(reloaded.ok, true);
  if (!reloaded.ok) return;
  assert.equal(reloaded.lease.leaseId, first.lease.leaseId, 'a renewal keeps the id');
  assert.equal(reloaded.takenOver, false);
  h.close();
});

test('the lease id is published, so it is the account that lets a till use it', async () => {
  const h = await openManager();
  const OTHER_ID = '018f0000-0000-7000-8000-0000000000b2';
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'ipad-A2',
    holderKind: 'till',
    accountId: MANAGER_ID,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  // Everything the second till can reach with the id it read off the document.
  const drove = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { stage: 'order' },
    },
    { source: 'till', accountId: OTHER_ID },
  );
  assert.equal(drove.ok, false);
  if (drove.ok) return;
  assert.equal(drove.refusal, 'not_permitted');

  const renewed = await h.manager.renew(STATION_ID, claim.lease.leaseId, { accountId: OTHER_ID });
  assert.equal(renewed.ok, false);
  if (renewed.ok) return;
  assert.equal(renewed.refusal, 'not_permitted');

  const released = await h.manager.release(STATION_ID, claim.lease.leaseId, {
    accountId: OTHER_ID,
  });
  assert.equal(released.ok, false);
  if (released.ok) return;
  assert.equal(released.refusal, 'not_permitted');

  const row = await h.manager.open(STATION_ID);
  assert.equal(row.stage, 'identify', 'the sale is where its own till left it');
  assert.equal(row.lease?.leaseId, claim.lease.leaseId);

  // The till that claimed it is unaffected by any of the above.
  const own = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: row.sequence,
      payload: { stage: 'order' },
    },
    { source: 'till', accountId: MANAGER_ID },
  );
  assert.equal(own.ok, true);
  if (!own.ok) return;
  assert.equal(own.document.stage, 'order');

  const gone = await h.manager.release(STATION_ID, claim.lease.leaseId, { accountId: MANAGER_ID });
  assert.equal(gone.ok, true);
  if (!gone.ok) return;
  assert.equal(gone.released, true);
  h.close();
});

test('a takeover with nobody behind it is refused rather than audited as somebody', async () => {
  const h = await openManager();
  await h.manager.claim({ stationId: STATION_ID, holder: 'tab-1', holderKind: 'till' });

  const anonymous = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-2',
    holderKind: 'till',
    takeover: true,
  });
  assert.equal(anonymous.ok, false);
  if (anonymous.ok) return;
  assert.equal(anonymous.refusal, 'not_permitted');
  assert.equal(h.facts.length, 0, 'nothing is queued for an unnamed takeover');
  h.close();
});

/**
 * The race the expiry check inside the compare-and-set exists for.
 *
 * A holds the station. Sixty-one seconds pass with no heartbeat reaching the
 * store, so B reads the row, sees an expired lease and decides to claim it.
 * A's fifteen-second heartbeat then lands — late, but alive — inside B's
 * read-to-write window. B's write must find a lease that is no longer expired
 * and lose, because the till it would displace is somebody standing at a
 * counter mid-sale.
 */
test('a renewal landing mid-claim keeps the station with the till that is alive', async () => {
  const h = await openManager();
  const a = await h.manager.claim({ stationId: STATION_ID, holder: 'till-A', holderKind: 'till' });
  assert.equal(a.ok, true);
  if (!a.ok) return;

  // B reads the row while the lease is expired and decides, on that read, to
  // claim it — exactly what `claim` does between its read and its write.
  const pastTtl = plus(AT, (STATION_LEASE_TTL_S + 1) * 1000);
  h.setNow(pastTtl);
  const readByB = await h.manager.open(STATION_ID);
  assert.ok(readByB.lease, 'the row still carries A’s lease');
  assert.ok(
    Date.parse(readByB.lease.expiresAt) <= Date.parse(pastTtl),
    'and on that read it is expired, which is what B decides on',
  );

  // A's heartbeat lands in that window. It keeps the same lease id on purpose.
  const renewed = await h.manager.renew(STATION_ID, a.lease.leaseId, { accountId: null });
  assert.equal(renewed.ok, true);
  if (!renewed.ok) return;
  assert.equal(renewed.lease.leaseId, a.lease.leaseId, 'a renewal keeps the id');

  const b = await h.manager.claim({ stationId: STATION_ID, holder: 'till-B', holderKind: 'till' });
  assert.equal(b.ok, false, 'B must not take a station whose till is alive');
  if (b.ok) return;
  assert.equal(b.refusal, 'no_lease');

  const row = await h.manager.open(STATION_ID);
  assert.equal(row.lease?.holder, 'till-A');
  assert.equal(row.takeoverCount, 0);
  assert.equal(h.facts.length, 0, 'nobody was displaced, so nothing is audited');
  h.close();
});

/**
 * Read-only means a source no rule admits, not a flag a screen is trusted to
 * honour. The cart is the thing worth naming: it is what a manager watching
 * from a back office and a visitor at a display must not be able to move.
 */
test('a watching manager and a customer display cannot change the cart', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  // Registered the way the money path will register it, so the rule is tested
  // on the real registration and not on a built-in that happens to be strict.
  h.manager.register('cart.add_line', {
    sources: ['till', 'kiosk'],
    requiresLease: true,
    apply: ({ intent }) => ({ ok: true, write: { cart: { lines: [intent.payload] } } }),
  });

  for (const source of ['console', 'display'] as const) {
    const attempt = await h.manager.applyIntent(
      STATION_ID,
      {
        type: 'cart.add_line',
        // Quoting the live lease, so the refusal cannot be "no lease": what is
        // under test is that the SOURCE is not allowed, whatever it holds.
        leaseId: claim.lease.leaseId,
        lastSeenSequence: claim.document.sequence,
        payload: { sku: 'kid-2h', qty: 1 },
      },
      { source },
    );
    assert.equal(attempt.ok, false, `${source} must not change the cart`);
    if (attempt.ok) return;
    assert.equal(attempt.refusal, 'not_permitted');
  }

  const row = await h.manager.open(STATION_ID);
  assert.equal(row.cart, null, 'the cart is untouched');

  // And the Console cannot do the till's other work either — it is an
  // observer, not a till with a different name.
  const staged = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { stage: 'order' },
    },
    { source: 'console' },
  );
  assert.equal(staged.ok, false);
  if (staged.ok) return;
  assert.equal(staged.refusal, 'not_permitted');
  h.close();
});

test('the displaced till is told the session moved, and rehydrates from the refusal', async () => {
  const h = await openManager();
  const first = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-2',
    holderKind: 'till',
    accountId: MANAGER_ID,
    takeover: true,
  });

  const refused = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: first.lease.leaseId,
      lastSeenSequence: first.document.sequence,
      payload: { stage: 'order' },
    },
    { source: 'till' },
  );
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.refusal, 'stale');
  assert.match(refused.message, /moved to another till/);
  assert.ok(
    refused.document,
    'the current document comes back with the refusal, in one round trip',
  );
  h.close();
});

test('an abandoned lease is claimable after the TTL, with no manager', async () => {
  const h = await openManager();
  const first = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(first.ok, true);

  h.setNow(plus(AT, (STATION_LEASE_TTL_S + 1) * 1000));
  const second = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-2',
    holderKind: 'till',
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.takenOver, false, 'an expired lease is claimed, not taken over');
  assert.equal(second.document.takeoverCount, 0);
  assert.equal(h.facts.length, 0, 'nobody was displaced, so nothing is audited');
  h.close();
});

test('a renewal moves the expiry and not the sequence', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  h.setNow(plus(AT, 15_000));
  const renewed = await h.manager.renew(STATION_ID, claim.lease.leaseId, { accountId: null });
  assert.equal(renewed.ok, true);
  if (!renewed.ok) return;
  assert.equal(
    renewed.document.sequence,
    claim.document.sequence,
    'two tabs keep agreeing on a number',
  );
  assert.ok(Date.parse(renewed.lease.expiresAt) > Date.parse(claim.lease.expiresAt));
  h.close();
});

test('an intent quoting an old sequence is stale even from the lease holder', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  const first = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { stage: 'order' },
    },
    { source: 'till' },
  );
  assert.equal(first.ok, true);

  const behind = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { stage: 'payment' },
    },
    { source: 'till' },
  );
  assert.equal(behind.ok, false);
  if (behind.ok) return;
  assert.equal(behind.refusal, 'stale');
  h.close();
});

/**
 * The last way a screen that was refused the station could still reach into it.
 *
 * `display.set_language` needs no lease, because the toggle belongs to the
 * customer display and a display never holds one. What it must not do is move
 * the number the holder is fenced against: while it did, a second till could
 * toggle the language in a loop and every intent the till working the sale sent
 * came back "session moved to another till", with nothing having moved.
 */
test('a second till with no lease cannot make the holder stale', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
    accountId: MANAGER_ID,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  // A second till at the same counter. It was refused the lease and holds none.
  const refused = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-2',
    holderKind: 'till',
    accountId: '018f0000-0000-7000-8000-0000000000b2',
  });
  assert.equal(refused.ok, false);

  for (const language of ['th', 'en', 'th']) {
    const toggled = await h.manager.applyIntent(
      STATION_ID,
      { type: 'display.set_language', lastSeenSequence: claim.document.sequence, payload: { language } },
      { source: 'till' },
    );
    assert.equal(toggled.ok, true);
    if (!toggled.ok) return;
    assert.equal(toggled.document.language, language);
    assert.equal(toggled.document.sequence, claim.document.sequence, 'the fence did not move');
  }

  // The holder read the document before any of that and is still current.
  const held = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'session.set_stage',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { stage: 'order' },
    },
    { source: 'till', accountId: MANAGER_ID },
  );
  assert.equal(held.ok, true);
  if (!held.ok) return;
  assert.equal(held.document.stage, 'order');
  assert.equal(held.document.language, 'th');
  assert.equal(held.document.sequence, claim.document.sequence + 1);

  // The other half of "it does not move the fence": it is still HELD to it. A
  // screen with no lease still cannot write over a change it has not seen.
  const behind = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'display.set_language',
      lastSeenSequence: claim.document.sequence,
      payload: { language: 'en' },
    },
    { source: 'display' },
  );
  assert.equal(behind.ok, false);
  if (behind.ok) return;
  assert.equal(behind.refusal, 'stale');
  assert.equal((await h.manager.open(STATION_ID)).language, 'th');
  h.close();
});

/**
 * And the other half of the same rule: a lease-free intent may write only the
 * display's own fields. The check is on the WRITE rather than on the spec, so an
 * intent registered later cannot become a second writer of the sale by being
 * declared `requiresLease: false`.
 */
test('a lease-free intent may not write a field the sale is made of', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  h.manager.register('display.overreach', {
    sources: ['display', 'till'],
    requiresLease: false,
    apply: () => ({ ok: true, write: { cart: { lines: [] }, language: 'en' } }),
  });

  const result = await h.manager.applyIntent(
    STATION_ID,
    { type: 'display.overreach', lastSeenSequence: claim.document.sequence, payload: {} },
    { source: 'display' },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal, 'not_permitted');
  assert.match(result.message, /cart/);

  // And nothing was written: not the field it may not touch, not the one it may.
  const after = await h.manager.open(STATION_ID);
  assert.equal(after.cart, null);
  assert.equal(after.sequence, claim.document.sequence);
  h.close();
});

test('the display holds no lease and may still answer what it was asked', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  const prompted = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'prompt.set',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: { kind: 'phone', label: 'Find my membership' },
    },
    { source: 'till' },
  );
  assert.equal(prompted.ok, true);
  if (!prompted.ok) return;

  const answered = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'display.answer_prompt',
      lastSeenSequence: prompted.document.sequence,
      payload: { value: '0811111111' },
    },
    { source: 'display' },
  );
  assert.equal(answered.ok, true);
  if (!answered.ok) return;
  assert.equal(answered.document.prompt?.answer, '0811111111');

  // And may not do a till's job.
  const forbidden = await h.manager.applyIntent(
    STATION_ID,
    { type: 'session.reset', lastSeenSequence: answered.document.sequence, payload: {} },
    { source: 'display' },
  );
  assert.equal(forbidden.ok, false);
  if (forbidden.ok) return;
  assert.equal(forbidden.refusal, 'not_permitted');
  h.close();
});

test('typed display answers are matched, timestamped and retained until the till moves on', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'display-till', holderKind: 'till' });
  assert.ok(claim.ok);
  let current = claim.document;
  const publish = async (stage: 'identify' | 'input' | 'payment', prompt: Record<string, unknown> | null) => {
    const result = await h.manager.applyIntent(STATION_ID, {
      type: 'session.publish_display', leaseId: claim.lease.leaseId, lastSeenSequence: current.sequence,
      payload: { stage, step: 1, cart: null, member: null, totals: null, payment: null, prompt },
    }, { source: 'till' });
    assert.ok(result.ok);
    current = result.document;
  };
  await publish('identify', { kind: 'identify', requestId: 'identify-1' });
  const sequence = current.sequence;
  const identify = { type: 'display.identify', lastSeenSequence: sequence, actionId: 'identify-action-1',
    payload: { requestId: 'identify-1', phone: ' 0811111111 ' } };
  const answered = await h.manager.applyIntent(STATION_ID, identify, { source: 'display', deviceId: 'display-device-1' });
  assert.ok(answered.ok);
  current = answered.document;
  assert.equal(current.sequence, sequence + 1);
  assert.deepEqual(current.prompt?.answer, { type: 'identify', actionId: 'identify-action-1', phone: '0811111111' });
  assert.equal(current.prompt?.answeredAt, AT);
  const answerEvent = h.events.find((event) => event.intentType === 'display.identify' && event.outcome === 'applied');
  assert.deepEqual(answerEvent?.payload, { keys: ['phone', 'requestId'], deviceId: 'display-device-1' });
  assert.equal(answerEvent?.actorAccountId, null);

  h.setNow(plus(AT, 1000));
  await publish('identify', { kind: 'identify', requestId: 'identify-1', answer: null, answeredAt: 'forged' });
  assert.deepEqual(current.prompt?.answer, answered.document.prompt?.answer);
  assert.equal(current.prompt?.answeredAt, AT);
  const replacement = await h.manager.applyIntent(STATION_ID, { ...identify, lastSeenSequence: current.sequence,
    actionId: 'different-action', payload: { requestId: 'identify-1', phone: '0822222222' } }, { source: 'display', deviceId: 'display-device-1' });
  assert.equal(replacement.ok, false);
  assert.deepEqual(h.events.at(-1)?.payload, { keys: ['phone', 'requestId'], deviceId: 'display-device-1' });
  const retry = await h.manager.applyIntent(STATION_ID, { ...identify, lastSeenSequence: current.sequence }, { source: 'display' });
  assert.ok(retry.ok);
  current = retry.document;
  assert.equal(current.prompt?.answeredAt, AT);

  await publish('identify', { kind: 'identify', requestId: 'identify-2' });
  assert.equal(current.prompt?.answer, undefined);
  const late = await h.manager.applyIntent(STATION_ID, { ...identify, lastSeenSequence: current.sequence }, { source: 'display' });
  assert.equal(late.ok, false);
  const skipped = await h.manager.applyIntent(STATION_ID, { type: 'display.skip_identify', actionId: 'skip-action-2',
    lastSeenSequence: current.sequence, payload: { requestId: 'identify-2' } }, { source: 'display' });
  assert.ok(skipped.ok);
  current = skipped.document;
  assert.deepEqual(current.prompt?.answer, { type: 'skip_identify', actionId: 'skip-action-2' });

  await publish('input', { kind: 'contact', requestId: 'contact-1', phone: '', nickname: '', contactChannel: 'line' });
  const contact = await h.manager.applyIntent(STATION_ID, { type: 'display.contact_done', actionId: 'contact-action-1',
    lastSeenSequence: current.sequence, payload: { requestId: 'contact-1', phone: '', nickname: '', contactChannel: 'line' } }, { source: 'display' });
  assert.ok(contact.ok);
  current = contact.document;
  assert.deepEqual(current.prompt?.answer, { type: 'contact_done', actionId: 'contact-action-1', phone: '', nickname: '', contactChannel: 'line' });
  assert.equal(current.prompt?.answeredAt, plus(AT, 1000));
  await publish('payment', null);
  const wrongStage = await h.manager.applyIntent(STATION_ID, { type: 'display.contact_done', actionId: 'late-contact',
    lastSeenSequence: current.sequence, payload: { requestId: 'contact-1', phone: '', nickname: '', contactChannel: 'line' } }, { source: 'display' });
  assert.equal(wrongStage.ok, false);
  if (!wrongStage.ok) assert.equal(wrongStage.refusal, 'wrong_stage');
  assert.equal(h.facts.length, 0, 'presentation and answers perform no money effect');
  h.close();
});

test('typed prompts refuse generic bypasses, unkeyed answers and extra contact fields', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'strict-display-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: claim.document.sequence, payload: { stage: 'identify', prompt: { kind: 'identify', requestId: 'strict-identify' } } }, { source: 'till' });
  assert.ok(publish.ok);
  const sequence = publish.document.sequence;
  for (const intent of [
    { type: 'display.answer_prompt', payload: { value: '0811111111' }, actionId: 'generic-bypass' },
    { type: 'display.identify', payload: { requestId: 'strict-identify', phone: '0811111111' } },
    { type: 'display.identify', payload: { requestId: 'strict-identify', phone: '0811111111' }, actionId: '   ' },
    { type: 'display.identify', payload: { requestId: 'strict-identify', phone: '' }, actionId: 'empty-phone' },
    { type: 'display.identify', payload: { requestId: 'strict-identify', phone: '0811111111', contactChannel: 'email' }, actionId: 'invalid-identify-channel' },
    { type: 'display.identify', payload: { requestId: 'strict-identify', phone: '0811111111', nickname: 'x'.repeat(101) }, actionId: 'long-identify-name' },
    { type: 'display.identify', payload: { requestId: 'strict-identify', phone: '0811111111', at: AT }, actionId: 'forged-time' },
  ]) {
    const result = await h.manager.applyIntent(STATION_ID, { ...intent, lastSeenSequence: sequence }, { source: 'display' });
    assert.equal(result.ok, false);
  }
  const identified = await h.manager.applyIntent(STATION_ID, { type: 'display.identify', actionId: 'identify-details',
    lastSeenSequence: sequence, payload: { requestId: 'strict-identify', phone: ' 0811111111 ', nickname: ' Nok ', contactChannel: 'telegram' } }, { source: 'display' });
  assert.ok(identified.ok);
  assert.deepEqual(identified.document.prompt?.answer, { type: 'identify', actionId: 'identify-details', phone: '0811111111', nickname: 'Nok', contactChannel: 'telegram' });
  const contact = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: identified.document.sequence, payload: { stage: 'input', prompt: { kind: 'contact', requestId: 'strict-contact' } } }, { source: 'till' });
  assert.ok(contact.ok);
  for (const payload of [
    { requestId: 'strict-contact', phone: '', nickname: '', contactChannel: 'email' },
    { requestId: 'strict-contact', phone: '', nickname: 'x'.repeat(101), contactChannel: 'line' },
    { requestId: 'strict-contact', phone: '', nickname: '', contactChannel: 'line', memberNotes: 'private' },
  ]) {
    const result = await h.manager.applyIntent(STATION_ID, { type: 'display.contact_done', actionId: 'bad-contact',
      lastSeenSequence: contact.document.sequence, payload }, { source: 'display' });
    assert.equal(result.ok, false);
  }
  const consent = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: contact.document.sequence, payload: { stage: 'payment', prompt: { kind: 'food_consent' } } }, { source: 'till' });
  assert.ok(consent.ok);
  const wrongConsent = await h.manager.applyIntent(STATION_ID, { type: 'display.answer_prompt',
    lastSeenSequence: consent.document.sequence, payload: { value: true } }, { source: 'display' });
  assert.equal(wrongConsent.ok, false);
  if (!wrongConsent.ok) assert.equal(wrongConsent.refusal, 'wrong_stage');
  h.close();
});

test('a typed answer survives a simultaneous publish from another manager sharing the store', async () => {
  const store = openTestStore(AT);
  await store.store.init(BOX_ID);
  const options = { store: store.store, boxId: BOX_ID,
    resolveStation: (stationId: string) => ({ stationId, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID }),
    now: () => store.now() };
  const displayManager = new StationSessionManager(options);
  const tillManager = new StationSessionManager(options);
  const claim = await tillManager.claim({ stationId: STATION_ID, holder: 'shared-store-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const payload = { stage: 'identify', prompt: { kind: 'identify', requestId: 'racing-request' } };
  const published = await tillManager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: claim.document.sequence, payload }, { source: 'till' });
  assert.ok(published.ok);
  const [answer, stalePublish] = await Promise.all([
    displayManager.applyIntent(STATION_ID, { type: 'display.identify', actionId: 'racing-answer',
      lastSeenSequence: published.document.sequence, payload: { requestId: 'racing-request', phone: '0811111111' } }, { source: 'display' }),
    tillManager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: published.document.sequence, payload }, { source: 'till' }),
  ]);
  assert.ok(answer.ok);
  assert.equal(stalePublish.ok, false);
  if (!stalePublish.ok) assert.equal(stalePublish.refusal, 'stale');
  const fresh = await tillManager.open(STATION_ID);
  const republished = await tillManager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: fresh.sequence, payload }, { source: 'till' });
  assert.ok(republished.ok);
  assert.deepEqual(republished.document.prompt?.answer, answer.document.prompt?.answer);
  const secondAnswer = await displayManager.applyIntent(STATION_ID, { type: 'display.skip_identify', actionId: 'second-racing-answer',
    lastSeenSequence: republished.document.sequence, payload: { requestId: 'racing-request' } }, { source: 'display' });
  assert.equal(secondAnswer.ok, false);
  assert.deepEqual((await tillManager.open(STATION_ID)).prompt?.answer, answer.document.prompt?.answer);
  store.close();
});

test('display publication is till-only and recursively removes presentation-private aliases', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'presentation-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const presentation = publicPresentation();
  const payload = { stage: 'order', step: 4,
    cart: { ...presentation.cart, unexpected: 'private-extra', sale: { ...presentation.cart.sale,
      children: [{ medicalNotes: 'private-medical' }], receipt: { phone: 'private-receipt' },
      lines: presentation.cart.sale.lines.map(line => ({ ...line, catalog: { holderName: 'private-holder' },
        translations: { ...line.translations, internal: 'private-translation' },
        breakdown: { ...line.breakdown, rows: line.breakdown.rows.map(row => ({ ...row, customer: 'private-row' })) } })),
      creditGrants: presentation.cart.sale.creditGrants.map(grant => ({ ...grant, id: 'private-wallet-code' })),
    } },
    member: { ...presentation.member, phone: 'private-phone', children: [{ nickname: 'private-child' }] },
    totals: { ...presentation.totals, paymentToken: 'private-token', taxBreakdown: { ...presentation.totals.taxBreakdown,
      categories: presentation.totals.taxBreakdown.categories.map(category => ({ ...category, stationSecret: 'private-station' })) } },
    payment: { ...presentation.payment, providerResponse: { approvalCode: 'private-approval' }, credentials: 'private-auth' },
    prompt: null };
  for (const source of ['display', 'kiosk', 'console'] as const) {
    const result = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence, payload }, { source });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal, 'not_permitted');
  }
  const result = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: claim.document.sequence, payload }, { source: 'till' });
  assert.ok(result.ok);
  const snapshot = h.manager.snapshotFor(result.document, 'customer', null).document;
  assert.equal(snapshot.step, null);
  assert.equal(snapshot.lease, null);
  assert.equal(snapshot.member?.nickname, 'Nok');
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
  assert.deepEqual(snapshot.cart, presentation.cart);
  assert.deepEqual(snapshot.totals, presentation.totals);
  assert.equal(snapshot.payment?.amountSatang, 19000);
  assert.equal(typeof snapshot.payment?.qrPayload, 'string');
  assert.deepEqual(h.events.at(-1)?.payload, { keys: ['cart', 'member', 'payment', 'prompt', 'stage', 'step', 'totals'] });
  const payment = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: result.document.sequence, payload: { ...payload, stage: 'payment', step: 6 } }, { source: 'till' });
  assert.ok(payment.ok);
  const thanks = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: payment.document.sequence, payload: { ...payload, stage: 'thankyou', step: 9,
      payment: { ...presentation.payment, status: 'paid', qrPayload: null } } }, { source: 'till' });
  assert.ok(thanks.ok);
  assert.equal(thanks.document.payment?.status, 'paid');
  assert.equal(thanks.document.sequence, result.document.sequence + 2);
  assert.equal(h.facts.length, 0);
  h.close();
});

test('malformed public money and full sales are refused without changing the station', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'validated-presentation', holderKind: 'till' });
  assert.ok(claim.ok);
  const presentation = publicPresentation();
  const invalidFields = [
    { payment: { ...presentation.payment, amountSatang: -1 } },
    { payment: { ...presentation.payment, amountSatang: 1.5 } },
    { payment: { ...presentation.payment, amountSatang: Number.MAX_SAFE_INTEGER + 1 } },
    { payment: { ...presentation.payment, status: 'approved' } },
    { payment: { ...presentation.payment, qrImageUrl: 'javascript:fixture-only' } },
    { payment: { ...presentation.payment, expiresAt: 'tomorrow' } },
    { totals: { ...presentation.totals, total: Number.POSITIVE_INFINITY } },
    { totals: { ...presentation.totals, total: 190.001 } },
    { totals: { ...presentation.totals, taxBreakdown: { serviceChargeTotal: 0, categories: [{ taxMode: 'other' }] } } },
    { member: { ...presentation.member, tier: { name: 'Member' } } },
    { cart: { ...presentation.cart, sale: { ...presentation.cart.sale, total: -1 } } },
    { cart: { ...presentation.cart, sale: { ...presentation.cart.sale, lines: [{ ...presentation.cart.sale.lines[0],
      breakdown: { rows: [{ key: 'kids', kind: 'kids', label: 'Children', unitPrice: 100, quantity: 1.5, subtotal: 150 }],
        priced: true, lengthChosen: true } }] } } },
    // A malformed full sale must never be accepted as the old tier-only form.
    { cart: { supported: false, sale: { id: 'sale-1', tier: 'member' } } },
  ];
  for (const fields of invalidFields) {
    const result = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence, payload: { stage: 'payment', ...presentation, ...fields } }, { source: 'till' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal, 'not_permitted');
    assert.equal((await h.manager.open(STATION_ID)).sequence, claim.document.sequence);
  }
  const early = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: claim.document.sequence, payload: { stage: 'identify', cart: { supported: true, sale: { tier: 'member' } } } }, { source: 'till' });
  assert.ok(early.ok);
  const unsupported = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
    lastSeenSequence: early.document.sequence, payload: { stage: 'input', step: 7,
      cart: { supported: false, sale: { tier: 'member', children: [{ name: 'private-child' }] } } } }, { source: 'till' });
  assert.ok(unsupported.ok);
  assert.deepEqual(unsupported.document.cart, { supported: false, sale: { tier: 'member' } });
  assert.equal(h.facts.length, 0);
  h.close();
});

test('customer snapshots whitelist cached presentations and omit malformed legacy money', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'legacy-presentation', holderKind: 'till' });
  assert.ok(claim.ok);
  const presentation = publicPresentation();
  let write: SessionWrite = { ...presentation, stage: 'payment', step: 6,
    cart: { ...presentation.cart, sale: { ...presentation.cart.sale, children: [{ name: 'private-child' }] } },
    totals: { ...presentation.totals, receipt: { phone: 'private-phone' } },
    payment: { ...presentation.payment, rawProviderReply: 'private-provider' },
  };
  h.manager.register('legacy.publish', { sources: ['till'], requiresLease: true, apply: () => ({ ok: true, write }) });
  const cached = await h.manager.applyIntent(STATION_ID, { type: 'legacy.publish', leaseId: claim.lease.leaseId,
    lastSeenSequence: claim.document.sequence, payload: {} }, { source: 'till' });
  assert.ok(cached.ok);
  assert.equal(JSON.stringify(cached.document).includes('private-'), true, 'staff snapshot remains untouched');
  const customer = h.manager.snapshotFor(cached.document, 'customer', null).document;
  assert.equal(JSON.stringify(customer).includes('private-'), false);
  assert.deepEqual(customer.cart, presentation.cart);
  assert.deepEqual(customer.totals, presentation.totals);
  assert.equal(customer.payment?.amountSatang, 19000);
  write = { stage: 'payment', cart: { supported: true, sale: { id: 'old-sale', lines: [{ name: 'Play' }] } },
    totals: { total: 200 }, payment: { amountSatang: 0.5, approvalCode: 'private-code' },
    member: { id: 'm-1', nickname: 'Nok', tier: { name: 'Member', secret: 'private-tier' } } };
  const malformed = await h.manager.applyIntent(STATION_ID, { type: 'legacy.publish', leaseId: claim.lease.leaseId,
    lastSeenSequence: cached.document.sequence, payload: {} }, { source: 'till' });
  assert.ok(malformed.ok);
  const safe = h.manager.snapshotFor(malformed.document, 'customer', null).document;
  assert.equal(safe.cart, null);
  assert.equal(safe.totals, null);
  assert.equal(safe.payment, null);
  assert.deepEqual(safe.member, { id: 'm-1', nickname: 'Nok' });
  assert.equal(safe.lease, null);
  assert.equal(safe.step, null);
  assert.equal(h.facts.length, 0);
  h.close();
});

test('an intent this box has never heard of is named, not silently dropped', async () => {
  const h = await openManager();
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const result = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'cart.add_line',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: {},
    },
    { source: 'till' },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal, 'unknown_intent');
  h.close();
});

test('a mutating intent with no lease is refused before the store is touched', async () => {
  const h = await openManager();
  await h.manager.open(STATION_ID);
  const result = await h.manager.applyIntent(
    STATION_ID,
    { type: 'session.reset', lastSeenSequence: 0, payload: {} },
    { source: 'till' },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal, 'no_lease');
  h.close();
});

test('the customer display never receives a child’s allergy or the till’s step', async () => {
  const h = await openManager();
  const seen: StationChannelMessage[] = [];
  h.manager.subscribe(STATION_ID, 'customer', (m) => seen.push(m));
  const claim = await h.manager.claim({
    stationId: STATION_ID,
    holder: 'tab-1',
    holderKind: 'till',
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  const attached = await h.manager.applyIntent(
    STATION_ID,
    {
      type: 'member.attach',
      leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence,
      payload: {
        member: {
          id: 'm-1',
          displayName: 'Nok',
          phone: '+66811111111',
          notes: 'owes for last time',
          children: [{ name: 'Ploy', allergies: 'peanuts', medicalNotes: 'asthma inhaler in bag' }],
        },
      },
    },
    { source: 'till' },
  );
  assert.equal(attached.ok, true);

  const snapshot = seen.filter((m) => m.kind === 'snapshot').at(-1);
  assert.ok(snapshot && snapshot.kind === 'snapshot');
  const member = snapshot.document.member ?? {};
  assert.equal(member.displayName, 'Nok');
  assert.equal(
    'phone' in member,
    false,
    'the allow-list keeps a number off a screen a stranger can read',
  );
  assert.equal('notes' in member, false);
  assert.equal('children' in member, false);
  assert.equal(snapshot.document.step, null);

  // The till's own view is untouched: the redaction happens on the way out to
  // the display, once, and no screen is trusted to hide anything itself.
  assert.equal((attached.ok && attached.document.member?.phone) || null, '+66811111111');
  h.close();
});

test('a station that is not on this box is refused rather than invented', async () => {
  const h = await openManager();
  await assert.rejects(
    h.manager.open('018f0000-0000-7000-8000-0000000099ff'),
    /not on this box's config bundle/,
  );
  h.close();
});

/**
 * A lease taken before the clock was corrected back (SCRUM-439).
 *
 * The expiry is the box's clock plus the TTL, and since SCRUM-402 that clock
 * is the corrected one: a Pi that booted three hours ahead after a power cut
 * and then measured itself against the platform leaves a lease taken before
 * the measurement three hours from expiring. A holder that is gone — the tab
 * closed in the power cut — would hold the station that long, with a
 * manager's takeover the only way in. So a lease further from expiring than
 * its full length is treated as run out: claimable, with no manager, and
 * nothing audited, as an expired one is. The lease length itself does not
 * change.
 */
test('a lease left further from expiring than its length by a clock correction is claimable, with no manager', async () => {
  const h = await openManager();
  const HOUR = 3_600_000;
  // Booted three hours ahead; the till claims on that clock.
  h.setNow(plus(AT, 3 * HOUR));
  const first = await h.manager.claim({ stationId: STATION_ID, holder: 'tab-1', holderKind: 'till' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.lease.expiresAt, plus(AT, 3 * HOUR + STATION_LEASE_TTL_S * 1000));

  // The box measures itself against the platform: three hours back. The
  // lease it holds now expires three hours and a minute from now.
  h.setNow(AT);
  const second = await h.manager.claim({ stationId: STATION_ID, holder: 'tab-2', holderKind: 'till' });
  assert.equal(second.ok, true, 'the station was held for as long as the clock had been out');
  if (!second.ok) return;
  assert.equal(second.takenOver, false, 'claimed as an expired lease is, not taken over');
  assert.equal(second.document.takeoverCount, 0);
  assert.equal(
    second.lease.expiresAt,
    plus(AT, STATION_LEASE_TTL_S * 1000),
    'the lease length itself is unchanged',
  );
  assert.equal(h.facts.length, 0, 'nobody was displaced, so nothing is audited');
  h.close();
});

/**
 * And the same rule inside the write, where the decision is made for real.
 *
 * A holder that IS still there renews onto the corrected clock within a
 * heartbeat, so its lease is inside the length again — and a claim that read
 * the stretched expiry and decided on it must lose to that renewal, exactly
 * as it loses to one landing on an ordinary expired lease (`a renewal
 * landing mid-claim` above). Two stations, one for each half.
 */
test('the compare-and-set claims a stretched lease and refuses one renewed onto the corrected clock', async () => {
  const box = openTestStore(AT);
  await box.store.init(BOX_ID);
  const HOUR = 3_600_000;
  const aheadAt = plus(AT, 3 * HOUR);
  const stations = {
    abandoned: '018f0000-0000-7000-8000-0000000057a2',
    renewed: '018f0000-0000-7000-8000-0000000057a3',
  };
  const stretched = (stationId: string, leaseId: string): StationLease => ({
    leaseId,
    holder: `till-${stationId.slice(-1)}`,
    holderKind: 'till',
    accountId: null,
    startedAt: aheadAt,
    heartbeatAt: aheadAt,
    expiresAt: plus(aheadAt, STATION_LEASE_TTL_S * 1000),
  });
  const claimant = (stationId: string, leaseId: string): StationLease => ({
    leaseId,
    holder: `till-B-${stationId.slice(-1)}`,
    holderKind: 'till',
    accountId: null,
    startedAt: AT,
    heartbeatAt: AT,
    expiresAt: plus(AT, STATION_LEASE_TTL_S * 1000),
  });
  for (const stationId of Object.values(stations)) {
    await box.store.ensureSession(
      { stationId, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID },
      aheadAt,
    );
  }

  // Both leases were taken on the clock three hours ahead.
  const abandonedLease = stretched(stations.abandoned, '018f0000-0000-7000-8000-0000000a0001');
  const renewedLease = stretched(stations.renewed, '018f0000-0000-7000-8000-0000000a0002');
  assert.ok(
    await box.store.applyLease(stations.abandoned, { leaseId: null }, { lease: abandonedLease }, aheadAt),
  );
  assert.ok(
    await box.store.applyLease(stations.renewed, { leaseId: null }, { lease: renewedLease }, aheadAt),
  );

  // The box measures itself: three hours back. A claimant reads both rows,
  // judges both leases run out, and quotes the instant it decided.
  box.setNow(AT);
  const decidedAt = AT;

  // On one station the holder is gone: the claimant's write wins.
  const claimed = await box.store.applyLease(
    stations.abandoned,
    { leaseId: abandonedLease.leaseId, expiredBefore: decidedAt },
    { lease: claimant(stations.abandoned, '018f0000-0000-7000-8000-0000000a0003') },
    decidedAt,
  );
  assert.ok(claimed, 'a lease three hours from expiring on the corrected clock is claimable');
  assert.equal(claimed.lease?.holder, 'till-B-2');
  assert.equal(claimed.takeoverCount, 0);

  // On the other, the holder's heartbeat lands first, on the corrected clock.
  const renewed = await box.store.applyLease(
    stations.renewed,
    { leaseId: renewedLease.leaseId },
    { lease: { ...renewedLease, heartbeatAt: AT, expiresAt: plus(AT, STATION_LEASE_TTL_S * 1000) } },
    AT,
  );
  assert.ok(renewed);
  const lost = await box.store.applyLease(
    stations.renewed,
    { leaseId: renewedLease.leaseId, expiredBefore: decidedAt },
    { lease: claimant(stations.renewed, '018f0000-0000-7000-8000-0000000a0004') },
    decidedAt,
  );
  assert.equal(lost, null, 'the claimant must not take a station from a till that renewed');
  assert.equal((await box.store.readSession(stations.renewed))?.lease?.holder, 'till-3');
  box.close();
});
