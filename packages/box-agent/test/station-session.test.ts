import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChildReviewPrompt, ConsentPrompt, DisplayFnbCart, DisplayMerchCart } from '@oto/shared';

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

function childReviewPrompt(overrides: Partial<ChildReviewPrompt> = {}): ChildReviewPrompt {
  return { kind: 'child_review', requestId: 'review-1', visitorId: 'visitor-1', referenceDate: '2026-09-20',
    slots: [{ id: 'slot-1', savedChildId: 'child-1', name: 'Nok', dateOfBirth: '2020-03-14', ageYears: 6, confirmed: false }],
    choices: [{ id: 'child-1', name: 'Nok', dateOfBirth: '2020-03-14', ageYears: 6 },
      { id: 'child-2', name: 'Mali', dateOfBirth: null, ageYears: 8 }],
    save: { status: 'idle', slotId: null, actionId: null }, canContinue: false, ...overrides };
}

function fnbCart(): DisplayFnbCart {
  return { kind: 'fnb', supported: true,
    lines: [{ id: 'food-line', name: 'Cold drink', translations: { en: 'Cold drink', th: 'Drink TH' }, qty: 2,
      basePrice: 40, lineTotal: 100, modifiers: [{ groupName: 'Size', optionName: 'Large', price: 10 }], note: 'Less ice' }],
    orderNote: 'Serve together', manualDiscounts: [{ id: 'discount-1', scope: 'order', type: 'fixed', value: 10 }], completion: null };
}

test('guest F&B publication keeps captured rows, real payment metadata and settled completion without private records', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'food-till', holderKind: 'till' });
    assert.ok(claim.ok);
    const cart = fnbCart();
    const totals = { ...publicPresentation().totals, total: 90 };
    const payment = { ...publicPresentation().payment, saleId: 'food-sale', amountSatang: 9000 };
    const publish = async (stage: string, value: unknown, selectedPayment: unknown = null) => {
      const current = await h.manager.open(STATION_ID);
      return h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
        lastSeenSequence: current.sequence, payload: { stage, cart: value, totals, payment: selectedPayment, member: null, prompt: null } }, { source: 'till' });
    };
    const publicCart = { ...cart, wristband: { holderName: 'private-holder', medicalNotes: 'private-medical' },
      lines: cart.lines.map(line => ({ ...line, menuItem: { cost: 10, inventoryItemId: 'private-inventory' },
        modifiers: line.modifiers.map(modifier => ({ ...modifier, cost: 1 })) })),
      manualDiscounts: cart.manualDiscounts.map(discount => ({ ...discount, appliedBy: 'private-staff', reason: 'private-reason' })),
    };
    for (const stage of ['welcome', 'order', 'payment']) {
      const published = await publish(stage, publicCart, stage === 'payment' ? payment : null);
      assert.ok(published.ok);
      const publicDoc = h.manager.snapshotFor(published.document, 'customer', null).document;
      assert.deepEqual(publicDoc.cart, cart);
      assert.deepEqual(publicDoc.totals, totals);
      assert.equal(publicDoc.prompt, null); assert.equal(publicDoc.member, null);
      assert.doesNotMatch(JSON.stringify(publicDoc), /private-|menuItem|cost|reason|appliedBy/);
      if (stage === 'payment') assert.equal(publicDoc.payment?.qrPayload, payment.qrPayload);
    }
    const completion = { saleId: 'food-sale', pickupCode: 'A12', total: 90, payment: { cash: 30, card: 20, promptpay: 40 } };
    const finished = await publish('thankyou', { ...cart, completion: { ...completion, operatorName: 'private-staff' } });
    assert.ok(finished.ok);
    assert.deepEqual(finished.document.cart?.completion, completion);
    assert.equal(h.facts.length, 0, 'the display publication cannot take money or create an order');
  } finally { h.close(); }
});

test('guest F&B refuses wrong stages, private prompt bleed, missing totals/payment and inconsistent completion', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'strict-food-till', holderKind: 'till' });
    assert.ok(claim.ok);
    const cart = fnbCart();
    const completion = { saleId: 'food-sale', pickupCode: 'A12', total: 90, payment: { cash: 90, card: 0, promptpay: 0 } };
    const totals = { ...publicPresentation().totals, total: 90 };
    const initial = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence, payload: { stage: 'order', cart, totals } }, { source: 'till' });
    assert.ok(initial.ok);
    for (const changes of [
      { stage: 'input' }, { stage: 'identify' }, { stage: 'consent' },
      { prompt: { kind: 'contact', requestId: 'request', phone: '' } }, { member: { id: 'member', nickname: 'Private visitor', tier: 'member' } },
      { totals: null }, { stage: 'payment', payment: null }, { stage: 'thankyou' },
      { cart: { ...cart, completion } }, { stage: 'thankyou', cart: { ...cart, completion: { ...completion, total: 100, payment: { cash: 100, card: 0, promptpay: 0 } } } },
      { stage: 'thankyou', cart: { ...cart, completion: { ...completion, payment: { cash: 89, card: 0, promptpay: 0 } } } },
      { cart: { ...cart, lines: Array.from({ length: 201 }, (_, i) => ({ ...cart.lines[0], id: `line-${i}` })) } },
    ]) {
      const result = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
        lastSeenSequence: initial.document.sequence, payload: { stage: 'order', cart, totals, member: null, prompt: null, ...changes } }, { source: 'till' });
      assert.equal(result.ok, false);
    }
    const unchanged = await h.manager.open(STATION_ID);
    assert.equal(unchanged.sequence, initial.document.sequence);
    assert.deepEqual(unchanged.cart, cart);
    const forbidden = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display',
      lastSeenSequence: unchanged.sequence, payload: { stage: 'order', cart, totals } }, { source: 'display' });
    assert.equal(forbidden.ok, false);
  } finally { h.close(); }
});

test('an unsupported guest F&B frame clears the prior visitor and payment even at thank-you', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'food-fallback-till', holderKind: 'till' });
    assert.ok(claim.ok);
    const identified = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: claim.document.sequence, payload: { stage: 'identify', cart: { supported: true, sale: { tier: 'member' } },
        member: { id: 'old-member', nickname: 'Old visitor', tier: 'member' }, prompt: { kind: 'identify', requestId: 'old-request' } } }, { source: 'till' });
    assert.ok(identified.ok);
    const displayed = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: identified.document.sequence, payload: { stage: 'payment', cart: fnbCart(),
        totals: { ...publicPresentation().totals, total: 90 }, payment: publicPresentation().payment, member: null, prompt: null } }, { source: 'till' });
    assert.ok(displayed.ok);
    assert.equal(displayed.document.member, null); assert.equal(displayed.document.prompt, null);
    const fallback = { kind: 'fnb', supported: false, lines: [], orderNote: '', manualDiscounts: [], completion: null };
    const cleared = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: displayed.document.sequence, payload: { stage: 'thankyou', cart: fallback,
        totals: null, payment: null, member: null, prompt: null } }, { source: 'till' });
    assert.ok(cleared.ok);
    const publicDoc = h.manager.snapshotFor(cleared.document, 'customer', null).document;
    assert.deepEqual(publicDoc.cart, fallback);
    assert.equal(publicDoc.totals, null); assert.equal(publicDoc.payment, null);
    assert.equal(publicDoc.member, null); assert.equal(publicDoc.prompt, null);
    assert.doesNotMatch(JSON.stringify(publicDoc), /Cold drink|Old visitor|old-request|test-only-payment-data/);
    const legacy = h.manager.snapshotFor({ ...displayed.document,
      member: { id: 'old-member', nickname: 'Old visitor', tier: 'member' }, prompt: { kind: 'contact', phone: 'Private visitor' } }, 'customer', null).document;
    assert.equal(legacy.member, null); assert.equal(legacy.prompt, null);
  } finally { h.close(); }
});

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'guardian-request', visitorId: 'guardian-visitor',
    slots: [{ id: 'slot', name: 'Child one', ageYears: 6, requirement: 'drop_off' }],
    guardianName: '', consentRequired: true, consentAcknowledged: false,
    confirmations: [{ id: 'safety', text: 'Confirm pickup arrangements', required: true, acknowledged: false }],
    staffReady: false, canContinue: false, completed: false, ...overrides };
}

async function openConsent() {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'consent-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = async (prompt: unknown, stage = 'input', step = 7) => {
    const current = await h.manager.open(STATION_ID);
    return h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: current.sequence, payload: { stage, step, prompt } }, { source: 'till' });
  };
  const published = await publish(consentPrompt());
  assert.ok(published.ok);
  const send = async (payload: Record<string, unknown>, actionId: string, source: 'display' | 'console' = 'display') => {
    const current = await h.manager.open(STATION_ID);
    return h.manager.applyIntent(STATION_ID, { type: 'display.consent', actionId,
      lastSeenSequence: current.sequence, payload }, { source, deviceId: 'guardian-screen' });
  };
  return { ...h, publish, send };
}

test('guardian acknowledgement exposes finite public facts and never private child fields or log values', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    const published = await h.publish({ ...prompt, policy: 'private-policy',
      slots: prompt.slots.map(slot => ({ ...slot, childPhotoUrl: 'private-photo', allergiesMedical: 'private-health', waived: true })),
      answer: { type: 'consent', actionId: 'forged-answer', payload: { action: 'done' } } });
    assert.ok(published.ok);
    const publicDoc = h.manager.snapshotFor(published.document, 'customer', null).document;
    assert.deepEqual(publicDoc.prompt, prompt);
    assert.equal(publicDoc.step, null);
    assert.doesNotMatch(JSON.stringify(publicDoc), /private-policy|private-photo|private-health|waived|forged-answer/);
    const answer = await h.send({ action: 'acknowledge', requestId: prompt.requestId, visitorId: prompt.visitorId,
      guardianName: 'Guardian private', consentAcknowledged: true, acknowledgedConfirmationIds: ['safety'] }, 'guardian-ack');
    assert.ok(answer.ok);
    assert.equal(answer.document.stage, 'input');
    assert.equal(answer.document.step, 7);
    assert.doesNotMatch(JSON.stringify(h.events), /Guardian private|Child one|pickup arrangements/);
    assert.equal(h.facts.length, 0, 'public acknowledgement cannot register a child or collect payment');
  } finally { h.close(); }
});

test('guardian acknowledgement refuses foreign prompts, stages, sources, checklist fields and premature Done', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    const action = { action: 'acknowledge', requestId: prompt.requestId, visitorId: prompt.visitorId,
      guardianName: 'Guardian', consentAcknowledged: true, acknowledgedConfirmationIds: ['safety'] };
    for (const [index, invalid] of [{ ...action, visitorId: 'old-visitor' }, { ...action, requestId: 'old-request' },
      { ...action, acknowledgedConfirmationIds: ['undeclared'] }, { ...action, childPhotoUrl: 'private-photo' },
      { action: 'done', requestId: prompt.requestId, visitorId: prompt.visitorId }].entries()) {
      const refused = await h.send(invalid, `refused-${index}`); assert.equal(refused.ok, false);
    }
    assert.equal((await h.send(action, 'wrong-source', 'console')).ok, false);
    assert.equal((await h.publish(prompt, 'welcome', 7)).ok, false);
    assert.equal((await h.publish(prompt, 'input', 8)).ok, false);
    const current = await h.manager.open(STATION_ID);
    const generic = await h.manager.applyIntent(STATION_ID, { type: 'display.answer_prompt', lastSeenSequence: current.sequence,
      payload: { value: true } }, { source: 'display' });
    assert.equal(generic.ok, false, 'generic prompt input cannot bypass the typed acknowledgement');
    assert.equal((await h.manager.open(STATION_ID)).prompt?.answer, undefined);
  } finally { h.close(); }
});

test('guardian acknowledgement keeps the first action on replay and Done leaves registration to the staff', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    const action = { action: 'acknowledge', requestId: prompt.requestId, visitorId: prompt.visitorId,
      guardianName: 'Guardian', consentAcknowledged: true, acknowledgedConfirmationIds: ['safety'] };
    const first = await h.send(action, 'same-ack'); assert.ok(first.ok);
    const republished = await h.publish(prompt); assert.ok(republished.ok);
    assert.deepEqual(republished.document.prompt?.answer, first.document.prompt?.answer);
    assert.equal((await h.send(action, 'same-ack')).ok, true);
    assert.equal((await h.send({ ...action, guardianName: 'Changed' }, 'same-ack')).ok, false);
    assert.equal((await h.send(action, 'second-ack')).ok, false);
    const ready = consentPrompt({ requestId: 'ready-request', guardianName: 'Guardian', consentAcknowledged: true,
      confirmations: [{ id: 'safety', text: 'Confirm pickup arrangements', required: true, acknowledged: true }],
      staffReady: true, canContinue: true });
    assert.ok((await h.publish(ready)).ok);
    const done = await h.send({ action: 'done', requestId: ready.requestId, visitorId: ready.visitorId }, 'guardian-done');
    assert.ok(done.ok);
    assert.equal(done.document.stage, 'input'); assert.equal(done.document.step, 7);
    assert.equal(h.facts.length, 0);
  } finally { h.close(); }
});

async function openChildReview() {
  const h = await openManager();
  const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'child-review-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = async (prompt: unknown, stage = 'input', step = 8) => {
    const current = await h.manager.open(STATION_ID);
    return h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: current.sequence, payload: { stage, step, prompt } }, { source: 'till' });
  };
  const published = await publish(childReviewPrompt());
  assert.ok(published.ok);
  return { ...h, claim, publish, published };
}

test('saved-child review publishes only finite child details and keeps diagnostic events private', async () => {
  const h = await openChildReview();
  try {
    const prompt = childReviewPrompt();
    const published = await h.publish({ ...prompt, medicalNotes: 'private-medical', token: 'private-extra',
      slots: prompt.slots.map(slot => ({ ...slot, allergies: 'private-allergy', childPhotoUrl: 'private-photo' })),
      choices: prompt.choices.map(choice => ({ ...choice, medicalNotes: 'private-choice' })),
      answer: { type: 'child_review', actionId: 'forged', payload: { action: 'done' } } });
    assert.ok(published.ok);
    const publicDoc = h.manager.snapshotFor(published.document, 'customer', null).document;
    assert.deepEqual(publicDoc.prompt, prompt);
    assert.ok(JSON.stringify(publicDoc).includes('2020-03-14'), 'DOB is allowed only in this finite review prompt');
    assert.doesNotMatch(JSON.stringify(publicDoc), /private-|forged/);
    const answered = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'confirm-1',
      lastSeenSequence: published.document.sequence, payload: { action: 'confirm', requestId: prompt.requestId, visitorId: prompt.visitorId,
        slotId: 'slot-1', savedChildId: 'child-1', name: ' Nok corrected ', dateOfBirth: '2020-03-14', ageYears: 6 } },
    { source: 'display', deviceId: 'review-display' });
    assert.ok(answered.ok);
    const publicAnswer = h.manager.snapshotFor(answered.document, 'customer', null).document.prompt?.answer;
    assert.deepEqual(publicAnswer, { type: 'child_review', actionId: 'confirm-1', payload: {
      action: 'confirm', requestId: prompt.requestId, visitorId: prompt.visitorId, slotId: 'slot-1', savedChildId: 'child-1',
      name: 'Nok corrected', dateOfBirth: '2020-03-14', ageYears: 6 } });
    assert.equal(answered.document.prompt?.answeredAt, AT);
    assert.doesNotMatch(JSON.stringify(h.events), /Nok corrected|2020-03-14|private-/);
    assert.equal(h.facts.length, 0, 'review transport does not register, check in or collect money');
  } finally { h.close(); }
});

test('saved-child review refuses stale visitor, source, assignment and forged child details', async () => {
  const h = await openChildReview();
  try {
    const fence = { requestId: 'review-1', visitorId: 'visitor-1' };
    const confirm = { ...fence, action: 'confirm', slotId: 'slot-1', savedChildId: 'child-1', name: 'Nok', dateOfBirth: '2020-03-14', ageYears: 6 };
    for (const payload of [
      { ...confirm, requestId: 'old-review' }, { ...confirm, visitorId: 'old-visitor' }, { ...confirm, slotId: 'other-slot' },
      { ...confirm, savedChildId: 'child-2' }, { ...confirm, ageYears: 7 }, { ...confirm, dateOfBirth: '2026-09-21', ageYears: 0 },
      { ...confirm, dateOfBirth: '2020-02-30' }, { ...confirm, ageYears: 18 }, { ...confirm, medicalNotes: 'private' },
      { ...fence, action: 'select', slotId: 'slot-1', choiceId: 'undeclared' }, { ...fence, action: 'done' },
      { ...fence, action: 'retry', slotId: 'slot-1', retryActionId: 'unknown' },
    ]) {
      const result = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'refused',
        lastSeenSequence: h.published.document.sequence, payload }, { source: 'display' });
      assert.equal(result.ok, false);
    }
    for (const source of ['till', 'console'] as const) {
      const result = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', leaseId: h.claim.lease.leaseId,
        lastSeenSequence: h.published.document.sequence, actionId: 'wrong-source', payload: confirm }, { source });
      assert.equal(result.ok, false);
    }
    const generic = await h.manager.applyIntent(STATION_ID, { type: 'display.answer_prompt', actionId: 'generic',
      lastSeenSequence: h.published.document.sequence, payload: { value: true } }, { source: 'display' });
    assert.equal(generic.ok, false);
    assert.equal((await h.manager.open(STATION_ID)).sequence, h.published.document.sequence);
    assert.equal((await h.manager.open(STATION_ID)).prompt?.answer, undefined);
  } finally { h.close(); }
});

test('saved-child review is first-answer-wins and preserves the original action through publication and replay', async () => {
  const h = await openChildReview();
  try {
    const intent = { type: 'display.child_review', actionId: 'select-action', lastSeenSequence: h.published.document.sequence,
      payload: { action: 'select', requestId: 'review-1', visitorId: 'visitor-1', slotId: 'slot-1', choiceId: 'child-2' } };
    const answer = await h.manager.applyIntent(STATION_ID, intent, { source: 'display' });
    assert.ok(answer.ok);
    assert.equal(answer.document.sequence, h.published.document.sequence + 1);
    const directReplay = await h.manager.applyIntent(STATION_ID, intent, { source: 'display' });
    assert.equal(directReplay.ok, false, 'an old sequence must rehydrate before a same-action replay');
    if (!directReplay.ok) {
      assert.equal(directReplay.refusal, 'stale');
      assert.deepEqual(directReplay.document?.prompt?.answer, answer.document.prompt?.answer);
    }
    const republish = await h.publish({ ...childReviewPrompt(), answer: null, answeredAt: 'forged' });
    assert.ok(republish.ok);
    assert.deepEqual(republish.document.prompt?.answer, answer.document.prompt?.answer);
    assert.equal(republish.document.prompt?.answeredAt, AT);
    const replay = await h.manager.applyIntent(STATION_ID, { ...intent, lastSeenSequence: republish.document.sequence }, { source: 'display' });
    assert.ok(replay.ok);
    for (const changed of [ { ...intent, actionId: 'replacement-action' },
      { ...intent, payload: { ...intent.payload, choiceId: 'child-1' } } ]) {
      const refused = await h.manager.applyIntent(STATION_ID, { ...changed, lastSeenSequence: replay.document.sequence }, { source: 'display' });
      assert.equal(refused.ok, false);
    }
    const next = await h.publish(childReviewPrompt({ requestId: 'review-2' }));
    assert.ok(next.ok);
    assert.equal(next.document.prompt?.answer, undefined);
    const stale = await h.manager.applyIntent(STATION_ID, { ...intent, lastSeenSequence: next.document.sequence }, { source: 'display' });
    assert.equal(stale.ok, false);
  } finally { h.close(); }
});

test('saved-child saves freeze edits and require the original failed action, while staff help remains available', async () => {
  const h = await openChildReview();
  try {
    const fence = { requestId: 'review-1', visitorId: 'visitor-1' };
    for (const status of ['saving', 'failed'] as const) {
      const published = await h.publish(childReviewPrompt({ save: { status, slotId: 'slot-1', actionId: 'original-save' } }));
      assert.ok(published.ok);
      for (const payload of [{ ...fence, action: 'back' }, { ...fence, action: 'done' },
        { ...fence, action: 'select', slotId: 'slot-1', choiceId: null },
        { ...fence, action: 'confirm', slotId: 'slot-1', savedChildId: 'child-1', name: 'Nok', dateOfBirth: null, ageYears: 6 },
        { ...fence, action: 'retry', slotId: 'slot-1', retryActionId: 'changed-save' }]) {
        const result = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'blocked',
          lastSeenSequence: published.document.sequence, payload }, { source: 'display' });
        assert.equal(result.ok, false);
      }
      const payload = status === 'failed' ? { ...fence, action: 'retry', slotId: 'slot-1', retryActionId: 'original-save' }
        : { ...fence, action: 'staff_help' };
      const accepted = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: `accepted-${status}`,
        lastSeenSequence: published.document.sequence, payload }, { source: 'display' });
      assert.ok(accepted.ok);
      const cleared = await h.publish(childReviewPrompt({ requestId: 'review-2' }));
      assert.ok(cleared.ok);
    }
    const confirmedSlot = childReviewPrompt().slots[0];
    assert.ok(confirmedSlot);
    const confirmed = childReviewPrompt({ requestId: 'review-done', slots: [{ ...confirmedSlot, confirmed: true }], canContinue: true });
    const published = await h.publish(confirmed);
    assert.ok(published.ok);
    const done = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'done', lastSeenSequence: published.document.sequence,
      payload: { action: 'done', requestId: confirmed.requestId, visitorId: confirmed.visitorId } }, { source: 'display' });
    assert.ok(done.ok);
    assert.equal(h.facts.length, 0);
  } finally { h.close(); }
});

test('saved-child publication fails closed for wrong step, stale dates, duplicate assignment and excessive drafts', async () => {
  const h = await openChildReview();
  try {
    const prompt = childReviewPrompt();
    for (const invalid of [ { ...prompt, referenceDate: '2026-09-18' },
      { ...prompt, slots: [...prompt.slots, { ...prompt.slots[0], id: 'slot-2' }] },
      { ...prompt, slots: Array.from({ length: 51 }, (_, i) => ({ ...prompt.slots[0], id: `slot-${i}`, savedChildId: null })) },
      { ...prompt, slots: [{ ...prompt.slots[0], savedChildId: null, confirmed: true }], canContinue: true },
    ]) assert.equal((await h.publish(invalid)).ok, false);
    assert.equal((await h.publish(prompt, 'input', 7)).ok, false);
    assert.equal((await h.publish(prompt, 'welcome', 8)).ok, false);
    const withSecond = await h.publish(childReviewPrompt({ slots: [...prompt.slots,
      { id: 'slot-2', savedChildId: 'child-2', name: 'Mali', dateOfBirth: null, ageYears: 8, confirmed: false }] }));
    assert.ok(withSecond.ok);
    const duplicate = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'duplicate',
      lastSeenSequence: withSecond.document.sequence, payload: { action: 'select', requestId: prompt.requestId, visitorId: prompt.visitorId,
        slotId: 'slot-1', choiceId: 'child-2' } }, { source: 'display' });
    assert.equal(duplicate.ok, false);
    const stale = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'stale',
      lastSeenSequence: withSecond.document.sequence - 1, payload: { action: 'back', requestId: prompt.requestId, visitorId: prompt.visitorId } }, { source: 'display' });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.refusal, 'stale');
    h.setNow(plus(AT, 2 * 86_400_000));
    const expired = await h.manager.applyIntent(STATION_ID, { type: 'display.child_review', actionId: 'expired',
      lastSeenSequence: withSecond.document.sequence, payload: { action: 'back', requestId: prompt.requestId, visitorId: prompt.visitorId } }, { source: 'display' });
    assert.equal(expired.ok, false);
  } finally { h.close(); }
});

test('Console display probes use the real stage rules without writing or mutating nested live data', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'probe-till', holderKind: 'till', accountId: null });
    assert.ok(claim.ok);
    if (!claim.ok) return;
    const published = await h.manager.applyIntent(STATION_ID, {
      type: 'session.publish_display', leaseId: claim.lease.leaseId, lastSeenSequence: claim.document.sequence,
      payload: { ...publicPresentation(), stage: 'welcome', step: 2, prompt: { kind: 'welcome', nested: { label: 'keep' } } },
    }, { source: 'till' });
    assert.ok(published.ok);
    if (!published.ok) return;
    const document = await h.manager.open(STATION_ID);
    const before = structuredClone(document);
    const eventCount = h.events.length;
    const factCount = h.facts.length;
    const messages: StationChannelMessage[] = [];
    h.manager.subscribe(STATION_ID, 'customer', (message) => messages.push(message));

    const refused = h.manager.testDisplayIntent(document, 'welcome', 'consent_ack', MANAGER_ID);
    assert.equal(refused.accepted, false);
    assert.equal(refused.reason, 'wrong_stage');
    assert.equal(h.manager.testDisplayIntent(document, 'input', 'consent_ack', MANAGER_ID).accepted, true);
    assert.equal(h.manager.testDisplayIntent(document, 'identify', 'identify', MANAGER_ID).accepted, true);
    assert.equal(h.manager.testDisplayIntent(document, 'input', 'contact_done', MANAGER_ID).accepted, true);
    assert.equal(h.manager.testDisplayIntent(document, 'payment', 'set_language', MANAGER_ID).accepted, true);

    // A rule may mutate its input as well as return a write. The probe must own every nested reference.
    h.manager.register('display.identify', { sources: ['display'], requiresLease: false,
      apply({ document: probe }) {
        const sale = probe.cart?.sale as { lines: Array<{ name: string }> };
        sale.lines[0]!.name = 'Changed by diagnostic rule';
        return { ok: true, write: { prompt: probe.prompt } };
      },
    });
    assert.equal(h.manager.testDisplayIntent(document, 'identify', 'identify', MANAGER_ID).accepted, true);
    assert.deepEqual(document, before);
    assert.deepEqual(await h.manager.open(STATION_ID), before);
    assert.equal(h.events.length, eventCount);
    assert.equal(h.facts.length, factCount);
    assert.equal(messages.length, 0);
  } finally { h.close(); }
});

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

function merchCart(): DisplayMerchCart {
  return { kind: 'merch', supported: true,
    lines: [{ id: 'shop-line', name: 'Grip Socks (M)', qty: 2, unitPrice: 120, lineTotal: 240 }],
    manualDiscounts: [], completion: null };
}

test('guest shop publication keeps captured amounts and settled completion without taking money', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'shop-till', holderKind: 'till' });
    assert.ok(claim.ok);
    const totals = { ...publicPresentation().totals, total: 240 };
    const cart = merchCart();
    const publish = async (stage: string, value: unknown, payment: unknown = null) => {
      const current = await h.manager.open(STATION_ID);
      return h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
        lastSeenSequence: current.sequence, payload: { stage, cart: value, totals, payment, member: null, prompt: null } }, { source: 'till' });
    };
    const published = await publish('order', { ...cart, wallet: 'Private marker',
      lines: cart.lines.map(line => ({ ...line, merchItem: { stock: 5, cost: 10 } })) });
    assert.ok(published.ok);
    const publicDoc = h.manager.snapshotFor(published.document, 'customer', null).document;
    assert.deepEqual(publicDoc.cart, cart);
    assert.equal(publicDoc.member, null); assert.equal(publicDoc.prompt, null);
    assert.doesNotMatch(JSON.stringify(publicDoc), /Private marker|wallet|stock|cost|merchItem/);
    const completion = { saleId: 'shop-sale', total: 240, payment: { cash: 100, card: 140, promptpay: 0 } };
    const finished = await publish('thankyou', { ...cart, completion });
    assert.ok(finished.ok);
    assert.deepEqual(finished.document.cart?.completion, completion);
    assert.equal(h.facts.length, 0, 'display publication cannot create a sale or payment');
    const fallback = { kind: 'merch', supported: false, lines: [], manualDiscounts: [], completion: null };
    const cleared = await publish('thankyou', fallback, publicPresentation().payment);
    assert.ok(cleared.ok);
    const clearedDoc = h.manager.snapshotFor(cleared.document, 'customer', null).document;
    assert.deepEqual(clearedDoc.cart, fallback);
    assert.equal(clearedDoc.totals, null); assert.equal(clearedDoc.payment, null);
    assert.doesNotMatch(JSON.stringify(clearedDoc), /Grip Socks|shop-sale|test-only-payment-data/);
  } finally { h.close(); }
});

test('guest shop refuses private prompts, missing totals, bad completion and display-origin publication', async () => {
  const h = await openManager();
  try {
    const claim = await h.manager.claim({ stationId: STATION_ID, holder: 'strict-shop-till', holderKind: 'till' });
    assert.ok(claim.ok);
    const cart = merchCart();
    const totals = { ...publicPresentation().totals, total: 240 };
    const current = await h.manager.open(STATION_ID);
    for (const changes of [{ stage: 'input' }, { totals: null }, { stage: 'payment', payment: null },
      { member: { id: 'member', nickname: 'Private marker', tier: 'member' } },
      { prompt: { kind: 'contact', requestId: 'request' } }, { stage: 'thankyou' },
      { stage: 'thankyou', cart: { ...cart, completion: { saleId: 'sale', total: 239, payment: { cash: 239, card: 0, promptpay: 0 } } } }]) {
      const refused = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
        lastSeenSequence: current.sequence, payload: { stage: 'order', cart, totals, member: null, prompt: null, ...changes } }, { source: 'till' });
      assert.equal(refused.ok, false);
    }
    const forbidden = await h.manager.applyIntent(STATION_ID, { type: 'session.publish_display',
      lastSeenSequence: current.sequence, payload: { stage: 'order', cart, totals } }, { source: 'display' });
    assert.equal(forbidden.ok, false);
    assert.equal((await h.manager.open(STATION_ID)).sequence, current.sequence);
  } finally { h.close(); }
});
