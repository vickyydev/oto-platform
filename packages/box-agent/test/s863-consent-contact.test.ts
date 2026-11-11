import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsentPrompt } from '@oto/shared';

import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-863 — THE STATION PASSES THE PARENT'S NUMBER AND CHANNEL BOTH WAYS.
 *
 * The drop-off and nanny form on a paired display asks the family to confirm
 * or change the number, with the WhatsApp, LINE or Telegram choice (the
 * owner's ruling of 12 November; the prototype's form). The till publishes
 * the channel beside the number; the family's step brings both back. The
 * station — this code, in the cloud and on a counter box alike — must hand the
 * channel to the customer screen and take a step that carries it, and must go
 * on taking the step an older display sends with neither.
 *
 * A station from before this change drops the channel from the form (it does
 * not know the field), and the display then shows the form as it was and
 * sends no channel: that is why the display asks only when the channel
 * arrives. A step with a field the station does not know is refused whole.
 */

const AT = '2026-11-12T03:00:00.000Z';

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'guardian-request', visitorId: 'guardian-visitor',
    slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
    guardianName: '', consentRequired: true, consentAcknowledged: false, confirmations: [],
    guardianPhone: '+66898020001', contactChannel: 'whatsapp',
    staffReady: false, canContinue: false, completed: false, ...overrides };
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
  const claim = await manager.claim({ stationId: STATION_ID, holder: 'contact-till', holderKind: 'till' });
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
  guardianName: 'ZZ TEST guardian', consentAcknowledged: false, acknowledgedConfirmationIds: [], ...extra,
});

test('SCRUM-863: the customer screen is handed the channel beside the number', async () => {
  const h = await openConsent();
  try {
    for (const contactChannel of ['whatsapp', 'telegram', 'line'] as const) {
      const prompt = consentPrompt({ requestId: `request-${contactChannel}`, contactChannel });
      const published = await h.publish(prompt);
      assert.ok(published.ok);
      assert.deepEqual(h.manager.snapshotFor(published.document, 'customer', null).document.prompt, prompt);
    }
    const refused = await h.publish({ ...consentPrompt({ requestId: 'request-sms' }), contactChannel: 'sms' });
    assert.equal(refused.ok, false);
  } finally { h.close(); }
});

test('SCRUM-863: the family’s step reaches the till with the number and channel they chose', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const answered = await h.send(step(prompt, { guardianPhone: '+66891112222', contactChannel: 'telegram' }), 'changed-number');
    assert.ok(answered.ok);
    const answer = answered.document.prompt?.answer as { payload: Record<string, unknown> };
    assert.equal(answer.payload.guardianPhone, '+66891112222');
    assert.equal(answer.payload.contactChannel, 'telegram');
    // The till's own read of the station carries the answer as sent.
    const forTill = (await h.manager.open(STATION_ID)).prompt?.answer as { payload: Record<string, unknown> };
    assert.equal(forTill.payload.contactChannel, 'telegram');

    // A channel that is not one of the three is refused, like any field that is not the form's.
    const next = consentPrompt({ requestId: 'guardian-request-2' });
    assert.ok((await h.publish(next)).ok);
    assert.equal((await h.send(step(next, { contactChannel: 'sms' }), 'bad-channel')).ok, false);
    assert.equal((await h.send(step(next, { customerPhone: '+66891112222' }), 'bad-field')).ok, false);
  } finally { h.close(); }
});

test('SCRUM-863: an older display’s step, with no number and no channel, is still taken', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const answered = await h.send(step(prompt), 'older-display');
    assert.ok(answered.ok);
    const answer = answered.document.prompt?.answer as { payload: Record<string, unknown> };
    assert.equal('guardianPhone' in answer.payload, false);
    assert.equal('contactChannel' in answer.payload, false);
  } finally { h.close(); }
});

test('SCRUM-863: an older till’s form, with no channel, is published and shown as it was', async () => {
  const h = await openConsent();
  try {
    const { contactChannel: _channel, ...older } = consentPrompt();
    const published = await h.publish(older);
    assert.ok(published.ok);
    const shown = h.manager.snapshotFor(published.document, 'customer', null).document.prompt as Record<string, unknown>;
    assert.equal('contactChannel' in shown, false);
    assert.equal(shown.guardianPhone, '+66898020001');
  } finally { h.close(); }
});
