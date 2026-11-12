import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsentPrompt } from '@oto/shared';

import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-857 — THE STATION CARRIES THE FORM AS IT IS FILLED.
 *
 * The owner's ruling of 12 November: staff watch the family fill the
 * drop-off and nanny form, live. The family's screen sends a `fill` as they
 * type (debounced), with the step they are on, and the till publishes its
 * copy with that step (`familyStep`) so a screen that re-pairs comes back to
 * it. The station — in the cloud and on a counter box alike — must hand the
 * step to the customer screen, take a fill that carries it, take one fill at
 * a time for each copy of the form (a second, different one waits until the
 * till has taken the first), and refuse a fill based on a copy the till has
 * since replaced, so a staff edit is never laid under a stale family fill.
 */

const AT = '2026-11-12T03:00:00.000Z';

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'live-request', visitorId: 'live-visitor',
    slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
    guardianName: '', consentRequired: true, consentAcknowledged: false, confirmations: [],
    guardianPhone: '+66898020001', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'children',
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
  const claim = await manager.claim({ stationId: STATION_ID, holder: 'live-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = async (prompt: unknown) => {
    const current = await manager.open(STATION_ID);
    return manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: current.sequence, payload: { stage: 'input', step: 7, prompt } }, { source: 'till' });
  };
  const send = async (payload: Record<string, unknown>, actionId: string) => {
    const current = await manager.open(STATION_ID);
    return manager.applyIntent(STATION_ID, { type: 'display.consent', actionId,
      lastSeenSequence: current.sequence, payload }, { source: 'display', deviceId: 'live-screen' });
  };
  return { manager, publish, send, close: store.close };
}

const fill = (prompt: ConsentPrompt, extra: Record<string, unknown> = {}) => ({
  action: 'fill', requestId: prompt.requestId, visitorId: prompt.visitorId,
  slots: [{ id: 'slot', name: 'ZZ TEST child', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: '', guardianPhone: '+66898020001', contactChannel: 'whatsapp',
  consentAcknowledged: false, acknowledgedConfirmationIds: [], ...extra,
});

test('SCRUM-857: the customer screen is handed the step the family is on', async () => {
  const h = await openConsent();
  try {
    for (const familyStep of ['children', 'care', 'agreements'] as const) {
      const prompt = consentPrompt({ requestId: `request-${familyStep}`, familyStep });
      const published = await h.publish(prompt);
      assert.ok(published.ok);
      assert.deepEqual(h.manager.snapshotFor(published.document, 'customer', null).document.prompt, prompt);
    }
    assert.equal((await h.publish({ ...consentPrompt({ requestId: 'request-bad' }), familyStep: 'payment' })).ok, false);
  } finally { h.close(); }
});

test('SCRUM-857: a fill typed half way reaches the till with its step', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const answered = await h.send(fill(prompt, { guardianName: 'ZZ TEST gua', step: 'agreements' }), 'typing-1');
    assert.ok(answered.ok);
    const forTill = (await h.manager.open(STATION_ID)).prompt?.answer as { payload: Record<string, unknown> };
    assert.equal(forTill.payload.guardianName, 'ZZ TEST gua');
    assert.equal(forTill.payload.step, 'agreements');
    // The same fill again (a reply lost on the way back) is the same answer.
    assert.ok((await h.send(fill(prompt, { guardianName: 'ZZ TEST gua', step: 'agreements' }), 'typing-1')).ok);
    // A newer one waits: the station keeps one answer until the till has taken it.
    assert.equal((await h.send(fill(prompt, { guardianName: 'ZZ TEST guardian', step: 'agreements' }), 'typing-2')).ok, false);
  } finally { h.close(); }
});

test('SCRUM-857: a fill based on a copy the till has replaced is refused, so a staff edit stands', async () => {
  const h = await openConsent();
  try {
    const first = consentPrompt();
    assert.ok((await h.publish(first)).ok);
    // Staff type the guardian's name on the till: the till publishes a newer copy.
    const staffEdit = consentPrompt({ requestId: 'live-request-2', guardianName: 'ZZ TEST staff typed' });
    assert.ok((await h.publish(staffEdit)).ok);
    assert.equal((await h.send(fill(first, { guardianName: 'ZZ TEST stale' }), 'stale')).ok, false);
    const shown = (await h.manager.open(STATION_ID)).prompt as Record<string, unknown>;
    assert.equal(shown.guardianName, 'ZZ TEST staff typed');
    assert.equal(shown.answer, undefined);
    // A fill on the newer copy is taken.
    assert.ok((await h.send(fill(staffEdit, { guardianName: 'ZZ TEST staff typed', step: 'care' }), 'fresh')).ok);
  } finally { h.close(); }
});

test('SCRUM-857: a fill without a step (an older display, or a form without familyStep) is still taken', async () => {
  const h = await openConsent();
  try {
    const { familyStep: _step, ...older } = consentPrompt();
    assert.ok((await h.publish(older)).ok);
    const shown = (await h.manager.open(STATION_ID)).prompt as Record<string, unknown>;
    assert.equal('familyStep' in shown, false);
    assert.ok((await h.send(fill(older as ConsentPrompt, { guardianName: 'ZZ TEST older' }), 'older')).ok);
  } finally { h.close(); }
});
