import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsentPrompt } from '@oto/shared';

import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-857 — THE STATION PASSES THE NUMBER CONFIRMATION BOTH WAYS.
 *
 * The drop-off and nanny form asks the family to confirm that the number is
 * the one for the chosen channel (the owner's ruling of 8 November). The till
 * publishes the tick beside the number and channel; the family's step brings
 * it back; a Done is refused while the till asks and the tick is not given.
 * The station — this code, in the cloud and on a counter box alike — must
 * hand the tick to the customer screen, take a step that carries it, and go
 * on taking a step an older display sends without it.
 *
 * A station from before this change strips the tick from the form and
 * refuses a step that carries it whole; that is why the display sends the
 * tick only when the form arrived with it, and why the form's canContinue
 * never waits on it (an older station cross-checks that against what it
 * knows). Those two rules are pinned on the display and the schema; this
 * file pins the station of today.
 */

const AT = '2026-11-12T03:00:00.000Z';

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'guardian-request', visitorId: 'guardian-visitor',
    slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true, confirmations: [],
    guardianPhone: '+66898020001', contactChannel: 'whatsapp', contactConfirmed: false,
    staffReady: true, canContinue: true, completed: false, ...overrides };
}

async function openConsent() {
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
  const claim = await manager.claim({ stationId: STATION_ID, holder: 'confirm-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = async (prompt: unknown) => {
    const current = await manager.open(STATION_ID);
    return manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: current.sequence, payload: { stage: 'input', step: 7, prompt } }, { source: 'till' });
  };
  const send = async (payload: Record<string, unknown>, actionId: string) => {
    const current = await manager.open(STATION_ID);
    return manager.applyIntent(STATION_ID, { type: 'display.consent', actionId,
      lastSeenSequence: current.sequence, payload }, { source: 'display', deviceId: 'guardian-screen' });
  };
  return { manager, publish, send, close: store.close };
}

const step = (prompt: ConsentPrompt, extra: Record<string, unknown> = {}) => ({
  action: 'fill', requestId: prompt.requestId, visitorId: prompt.visitorId,
  slots: [{ id: 'slot', name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: 'ZZ TEST guardian', guardianPhone: '+66898020001', contactChannel: 'whatsapp',
  consentAcknowledged: true, acknowledgedConfirmationIds: [], ...extra,
});
const done = (prompt: ConsentPrompt) => ({ action: 'done', requestId: prompt.requestId, visitorId: prompt.visitorId });

test('SCRUM-857: the customer screen is handed the tick beside the number and channel', async () => {
  const h = await openConsent();
  try {
    for (const contactConfirmed of [false, true]) {
      const prompt = consentPrompt({ requestId: `request-${contactConfirmed}`, contactConfirmed });
      const published = await h.publish(prompt);
      assert.ok(published.ok);
      assert.deepEqual(h.manager.snapshotFor(published.document, 'customer', null).document.prompt, prompt);
    }
    const refused = await h.publish({ ...consentPrompt({ requestId: 'request-bad' }), contactConfirmed: 'yes' });
    assert.equal(refused.ok, false);
  } finally { h.close(); }
});

test('SCRUM-857: the family’s step reaches the till with the tick', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const answered = await h.send(step(prompt, { contactConfirmed: true }), 'confirmed');
    assert.ok(answered.ok);
    const answer = answered.document.prompt?.answer as { payload: Record<string, unknown> };
    assert.equal(answer.payload.contactConfirmed, true);
    assert.equal(answer.payload.guardianPhone, '+66898020001');
    const forTill = (await h.manager.open(STATION_ID)).prompt?.answer as { payload: Record<string, unknown> };
    assert.equal(forTill.payload.contactConfirmed, true);
  } finally { h.close(); }
});

test('SCRUM-857: a Done is refused while the till asks and the tick is not given, and taken once it is', async () => {
  const h = await openConsent();
  try {
    const asking = consentPrompt();
    assert.ok((await h.publish(asking)).ok);
    assert.equal((await h.send(done(asking), 'too-early')).ok, false);

    const confirmed = consentPrompt({ requestId: 'guardian-request-2', contactConfirmed: true });
    assert.ok((await h.publish(confirmed)).ok);
    assert.ok((await h.send(done(confirmed), 'finished')).ok);
  } finally { h.close(); }
});

test('SCRUM-857: an older display’s step, with no tick, is still taken; an older till’s form, with none, still finishes', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const answered = await h.send(step(prompt), 'older-display');
    assert.ok(answered.ok);
    const answer = answered.document.prompt?.answer as { payload: Record<string, unknown> };
    assert.equal('contactConfirmed' in answer.payload, false);

    const { contactConfirmed: _tick, ...older } = consentPrompt({ requestId: 'guardian-request-2' });
    const published = await h.publish(older);
    assert.ok(published.ok);
    const shown = h.manager.snapshotFor(published.document, 'customer', null).document.prompt as Record<string, unknown>;
    assert.equal('contactConfirmed' in shown, false);
    assert.ok((await h.send(done(older as ConsentPrompt), 'older-till-done')).ok);
  } finally { h.close(); }
});
