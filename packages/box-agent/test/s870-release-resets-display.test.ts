import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StationChannelMessage, StationSessionDocument } from '../src/contract';
import { StationSessionManager } from '../src/station-session';
import type { StationEventWrite } from '../src/store';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-870 — THE SCREEN GOES WITH THE LEASE.
 *
 * When staff leave the Tickets tab the till gives the station up and publishes
 * nothing on the way out, so the paired display kept the previous family's
 * thank-you (their bracelet counts) or the old phone prompt. A guest who
 * answered that leftover prompt was accepted by the box — the display's own
 * intents need no lease — and their number was dropped when the till came
 * back under a new request.
 *
 * Now a release that frees the station resets the screen in the same write:
 * the document goes to its identify-idle state (no cart, no member, no
 * totals, no payment, no prompt), which every display draws as its welcome
 * screen, and a leftover prompt can no longer be answered. A release that
 * finds the lease already moved on, or that is refused, leaves the new
 * holder's screen alone. The api's cloud station is this same manager over
 * the `edge` schema, so it behaves the same; a Pi needs this build.
 */

const AT = '2026-11-12T03:00:00.000Z';
const STAFF = '018f0000-0000-7000-8000-0000000000a1';
const MANAGER = '018f0000-0000-7000-8000-0000000000a2';
const OTHER = '018f0000-0000-7000-8000-0000000000a3';

interface Harness {
  manager: StationSessionManager;
  events: StationEventWrite[];
  close(): void;
}

async function openManager(): Promise<Harness> {
  const store = openTestStore(AT);
  await store.store.init(BOX_ID);
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
      stationId === STATION_ID ? { stationId, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID } : null,
    queueFact: async () => undefined,
    now: () => store.now(),
  });
  return { manager, events, close: store.close };
}

const till = { source: 'till' as const, accountId: STAFF };
const display = { source: 'display' as const, deviceId: 'display-1' };

/** The first screen's prompt, as the till publishes it. */
const identifyFrame = (requestId: string) => ({
  stage: 'identify', step: 1, cart: { supported: true, sale: { tier: 'tourist' } }, member: null, totals: null, payment: null,
  prompt: { kind: 'identify', requestId, phone: '', nickname: '', contactChannel: 'whatsapp', saleKey: 'sale-1' },
});

/** The previous family's thank-you, bracelet counts and all. */
const thankYouFrame = () => ({
  stage: 'thankyou', step: 6,
  cart: {
    supported: true, nickname: 'ZZ TEST family',
    sale: { id: 'sale-870', tier: 'tourist', total: 1380,
      lines: [{ id: 'line-1', name: '1 Hour Play', lineTotal: 1380,
        breakdown: { rows: [{ key: 'kids', kind: 'kids', label: 'Children', unitPrice: 690, quantity: 2, subtotal: 1380 }],
          priced: true, lengthChosen: true } }],
      manualDiscounts: [], creditGrants: [], bracelets: { adults: 1, children: 2 } },
    voucherPrize: null, nothingToPay: false,
  },
  member: { id: 'member-1', nickname: 'ZZ TEST family', tier: 'tourist' },
  totals: { manualAmounts: {}, discountAmount: 0, total: 1380, taxBreakdown: { serviceChargeTotal: 0, categories: [] } },
  payment: { saleId: 'sale-870', amountSatang: 138000, qrPayload: null, qrImageUrl: null, expiresAt: null,
    status: 'paid', offline: false, online: true },
  prompt: null,
});

/** The F&B station's welcome frame, as `fnbDisplayPresentation` sends it. */
const fnbWelcomeFrame = () => ({
  stage: 'welcome', step: null, cart: { kind: 'fnb', supported: true, lines: [], orderNote: '', manualDiscounts: [], completion: null },
  member: null, totals: null, payment: null, prompt: null,
});

async function publish(h: Harness, leaseId: string, lastSeenSequence: number, payload: Record<string, unknown>,
  by: { source: 'till'; accountId: string } = till, actionId = `publish-${lastSeenSequence}`) {
  const result = await h.manager.applyIntent(STATION_ID,
    { type: 'session.publish_display', leaseId, lastSeenSequence, actionId, payload }, by);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.document;
}

const screenOf = (document: StationSessionDocument) => ({ stage: document.stage, step: document.step, cart: document.cart ?? null,
  member: document.member ?? null, totals: document.totals ?? null, payment: document.payment ?? null, prompt: document.prompt ?? null });

const IDLE = { stage: 'identify', step: null, cart: null, member: null, totals: null, payment: null, prompt: null };

test('SCRUM-870: giving the station up clears the previous family from the screen, in one write', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'tab-1', holderKind: 'till', accountId: STAFF });
    assert.equal(claim.ok, true);
    if (!claim.ok) return;
    // The family chose Thai on their screen; the language is theirs and stays.
    const thai = await h.manager.applyIntent(STATION_ID, { type: 'display.set_language', lastSeenSequence: claim.document.sequence,
      actionId: 'lang-1', payload: { language: 'th' } }, display);
    assert.equal(thai.ok, true);
    const shown = await publish(h, claim.lease.leaseId, claim.document.sequence, thankYouFrame());
    assert.equal(shown.stage, 'thankyou');

    const seen: StationChannelMessage[] = [];
    const unsubscribe = h.manager.subscribe(STATION_ID, 'customer', (message) => { seen.push(message); });
    try {
      const released = await h.manager.release(STATION_ID, claim.lease.leaseId, { accountId: STAFF, actionId: 'release-1' });
      assert.deepEqual(released, { ok: true, released: true });
    } finally { unsubscribe(); }

    const after = await h.manager.open(STATION_ID);
    assert.equal(after.lease, null);
    assert.deepEqual(screenOf(after), IDLE, 'the thank-you, its bracelet counts and the member are gone with the lease');
    assert.equal(after.language, 'th');
    assert.equal(after.sequence, shown.sequence + 1, 'the release and the reset are one move of the fence');

    // The screens watching were sent the lease going and the idle document, and nothing of the family.
    const snapshot = seen.find((message) => message.kind === 'snapshot');
    assert.ok(snapshot && snapshot.kind === 'snapshot');
    assert.deepEqual(screenOf(snapshot.document), IDLE);
    assert.equal(snapshot.document.lease, null);
    assert.equal(JSON.stringify(seen).includes('ZZ TEST family'), false);
    assert.ok(seen.some((message) => message.kind === 'lease' && message.lease === null));

    // The tape says the screen was cleared by the release, not by a till.
    const line = h.events.find((event) => event.kind === 'lease' && event.outcome === 'released');
    assert.ok(line);
    assert.equal(line.sequence, after.sequence);
    assert.deepEqual(line.payload, { screen: 'reset' });
  } finally { h.close(); }
});

test('SCRUM-870: a leftover phone prompt can no longer be answered once the till has gone', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'tab-1', holderKind: 'till', accountId: STAFF });
    assert.equal(claim.ok, true);
    if (!claim.ok) return;
    const asked = await publish(h, claim.lease.leaseId, claim.document.sequence, identifyFrame('request-1'));
    assert.equal(asked.prompt?.requestId, 'request-1');
    const released = await h.manager.release(STATION_ID, claim.lease.leaseId, { accountId: STAFF });
    assert.deepEqual(released, { ok: true, released: true });
    const idle = await h.manager.open(STATION_ID);
    assert.equal(idle.prompt, null);

    // The next family, answering what the screen showed a moment ago. Whether
    // the display quotes the sequence it read before the release or the one
    // after, the box refuses before it compares them: the screen asks nothing.
    const answer = (lastSeenSequence: number) => h.manager.applyIntent(STATION_ID, { type: 'display.identify', lastSeenSequence,
      actionId: `guest-${lastSeenSequence}`, payload: { requestId: 'request-1', phone: '0812345678', nickname: 'Guest', contactChannel: 'whatsapp' } }, display);
    for (const sequence of [asked.sequence, idle.sequence]) {
      const refused = await answer(sequence);
      assert.equal(refused.ok, false);
      if (refused.ok) return;
      assert.equal(refused.refusal, 'wrong_stage');
      assert.equal(refused.message, 'This screen is not asking for that answer.');
    }
    const still = await h.manager.open(STATION_ID);
    assert.deepEqual(screenOf(still), IDLE);
    assert.equal(still.sequence, idle.sequence);
  } finally { h.close(); }
});

test('SCRUM-870: a release that finds the lease moved on, or is refused, leaves the holder’s screen alone', async () => {
  const h = await openManager();
  try {
    const first = await h.manager.claim({ stationId: STATION_ID, holder: 'tab-1', holderKind: 'till', accountId: STAFF });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const asked = await publish(h, first.lease.leaseId, first.document.sequence, identifyFrame('request-1'));

    // Somebody who is not the holder cannot end the sale by giving it up.
    const refused = await h.manager.release(STATION_ID, first.lease.leaseId, { accountId: OTHER });
    assert.equal(refused.ok, false);
    assert.deepEqual(screenOf(await h.manager.open(STATION_ID)), screenOf(asked));

    // A manager takes the station and publishes the next sale; the displaced
    // tab's late release is `released: false` and changes nothing.
    const taken = await h.manager.claim({ stationId: STATION_ID, holder: 'manager-tab', holderKind: 'till', accountId: MANAGER, takeover: true });
    assert.equal(taken.ok, true);
    if (!taken.ok) return;
    assert.equal(taken.takenOver, true);
    const shown = await publish(h, taken.lease.leaseId, taken.document.sequence, thankYouFrame(), { source: 'till', accountId: MANAGER });
    const late = await h.manager.release(STATION_ID, first.lease.leaseId, { accountId: STAFF });
    assert.deepEqual(late, { ok: true, released: false });
    const kept = await h.manager.open(STATION_ID);
    assert.deepEqual(screenOf(kept), screenOf(shown));
    assert.equal(kept.lease?.leaseId, taken.lease.leaseId);
    assert.equal(kept.sequence, shown.sequence);
  } finally { h.close(); }
});

test('SCRUM-870: after the reset the F&B station takes the screen cleanly, and the till’s first screen comes back after it', async () => {
  const h = await openManager();
  try {
    const tickets = await h.manager.claim({ stationId: STATION_ID, holder: 'till-tab', holderKind: 'till', accountId: STAFF });
    assert.equal(tickets.ok, true);
    if (!tickets.ok) return;
    await publish(h, tickets.lease.leaseId, tickets.document.sequence, thankYouFrame());
    assert.deepEqual(await h.manager.release(STATION_ID, tickets.lease.leaseId, { accountId: STAFF }), { ok: true, released: true });

    // Staff open F&B: its publisher claims the idle station and shows its welcome.
    const fnb = await h.manager.claim({ stationId: STATION_ID, holder: 'fnb-tab', holderKind: 'till', accountId: STAFF });
    assert.equal(fnb.ok, true);
    if (!fnb.ok) return;
    assert.deepEqual(screenOf(fnb.document), IDLE);
    const welcome = await publish(h, fnb.lease.leaseId, fnb.document.sequence, fnbWelcomeFrame(), till, 'fnb-welcome');
    assert.equal(welcome.stage, 'welcome');
    assert.equal(welcome.cart?.kind, 'fnb');
    assert.equal(welcome.cart?.supported, true);
    assert.deepEqual(await h.manager.release(STATION_ID, fnb.lease.leaseId, { accountId: STAFF }), { ok: true, released: true });
    assert.deepEqual(screenOf(await h.manager.open(STATION_ID)), IDLE, 'the F&B welcome goes with its lease too');

    // Back to Tickets: the same till tab claims again and its first screen is what the display reads.
    const again = await h.manager.claim({ stationId: STATION_ID, holder: 'till-tab', holderKind: 'till', accountId: STAFF });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.takenOver, false);
    const asked = await publish(h, again.lease.leaseId, again.document.sequence, identifyFrame('request-2'), till, 'ask-again');
    assert.equal(asked.stage, 'identify');
    assert.equal(asked.prompt?.requestId, 'request-2');
    assert.equal(asked.prompt?.answer, undefined);
  } finally { h.close(); }
});
