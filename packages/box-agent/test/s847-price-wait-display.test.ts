import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, plus, STATION_ID } from './_support';

/**
 * SCRUM-847 — THE BOX TAKES THE TILL'S "PRICE NOT IN YET" PAYMENT FRAME.
 *
 * While a voucher's price is pending the counter till publishes the payment
 * stage with nothing of the sale on it: the tier-only cart marked unsupported,
 * no totals and no payment (`ticketDisplayPresentation`, apps/pos). The box
 * must accept that frame — a refusal would read on the till as a display
 * fault — and what it then hands the customer screen must carry no figure
 * from the frame before it.
 */

const AT = '2026-11-11T03:00:00.000Z';

/** The frame the till sends for the wait, to the letter. */
const HELD = { stage: 'payment', step: 5, cart: { supported: false, sale: { tier: 'tourist' } },
  member: null, totals: null, payment: null, prompt: null };

/** The payment frame of the same sale once priced — and what was sent before this change, estimate and all. */
function paymentFrame(total: number) {
  return {
    stage: 'payment', step: 5,
    cart: {
      supported: true, nickname: 'ZZ TEST guardian',
      sale: {
        id: 'sale-847', tier: 'tourist', total,
        lines: [{ id: 'line-1', name: 'Full Day Pass', lineTotal: total,
          breakdown: { rows: [{ key: 'kids', kind: 'kids', label: 'Children', unitPrice: total, quantity: 1, subtotal: total }],
            priced: true, lengthChosen: true } }],
        manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 1 },
      },
      voucherPrize: { nameEn: 'Golden Ticket', nameTh: null }, nothingToPay: total === 0,
    },
    member: null,
    totals: { manualAmounts: {}, discountAmount: 0, total, taxBreakdown: { serviceChargeTotal: 0, categories: [] } },
    payment: { saleId: null, amountSatang: total * 100, qrPayload: null, qrImageUrl: null,
      expiresAt: plus(AT, 60_000), status: 'idle', offline: false, online: true },
    prompt: null,
  };
}

test('SCRUM-847: the payment frame with no sale on it is accepted, and clears the figure shown before it', async () => {
  const store = openTestStore(AT);
  await store.store.init(BOX_ID);
  const manager = new StationSessionManager({
    store: store.store,
    boxId: BOX_ID,
    resolveStation: (stationId) =>
      stationId === STATION_ID ? { stationId, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID } : null,
    queueFact: async () => undefined,
    now: () => store.now(),
  });
  try {
    const claim = await manager.claim({ stationId: STATION_ID, holder: 'price-wait-till', holderKind: 'till' });
    assert.ok(claim.ok);
    const publish = async (payload: Record<string, unknown>) => {
      const current = await manager.open(STATION_ID);
      return manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
        lastSeenSequence: current.sequence, payload }, { source: 'till' });
    };

    // A frame with the till's estimate on it, as a display would have been left holding.
    const estimate = await publish(paymentFrame(1315));
    assert.ok(estimate.ok);
    assert.equal(manager.snapshotFor(estimate.document, 'customer', null).document.payment?.amountSatang, 131_500);

    const held = await publish(HELD);
    assert.ok(held.ok, 'the box takes the price-pending frame');
    const waiting = manager.snapshotFor(held.document, 'customer', null).document;
    assert.equal(waiting.stage, 'payment');
    assert.deepEqual(waiting.cart, { supported: false, sale: { tier: 'tourist' } });
    assert.equal(waiting.totals, null);
    assert.equal(waiting.payment, null);
    assert.doesNotMatch(JSON.stringify([waiting.cart, waiting.totals, waiting.payment]), /1315|131500/);

    // The same shape marked supported is the one the box refuses at this stage: the till never sends it.
    const refused = await publish({ ...HELD, cart: { supported: true, sale: { tier: 'tourist' } } });
    assert.equal(refused.ok, false);

    // The price arrives: the full frame goes through as it always has.
    const priced = await publish(paymentFrame(0));
    assert.ok(priced.ok);
    const shown = manager.snapshotFor(priced.document, 'customer', null).document;
    assert.equal(shown.payment?.amountSatang, 0);
    assert.equal(shown.totals?.total, 0);
  } finally { store.close(); }
});
