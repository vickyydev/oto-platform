import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STATION_LEASE_TTL_S, type StationChannelMessage } from '../src/contract';
import { StationSessionManager } from '../src/station-session';
import type { QueuedFact } from '../src/store';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, plus, STATION_ID } from './_support';

const AT = '2026-09-20T03:00:00.000Z';
/** The manager whose name goes on a takeover. A takeover with none is refused. */
const MANAGER_ID = '018f0000-0000-7000-8000-0000000000a1';

interface Harness {
  manager: StationSessionManager;
  facts: QueuedFact[];
  setNow(iso: string): void;
  close(): void;
}

async function openManager(): Promise<Harness> {
  const store = openTestStore(AT);
  await store.store.init(BOX_ID);
  const facts: QueuedFact[] = [];
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
  return { manager, facts, setNow: store.setNow, close: store.close };
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
