import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsentPrompt } from '@oto/shared';

import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-857 — THE FAMILY'S DONE, AS THE STATION CARRIES IT.
 *
 * The owner's ruling of 8 November: once every check passes, the family's
 * Done moves the sale on without staff. The till is what writes the
 * registration; the station — this code, in the cloud and on a counter box
 * alike — is what makes sure the Done the till reads is the one pressed on
 * the form the till shows now: a Done fenced to an earlier revision of the
 * form, or to another family, is refused; the same Done sent again (a tap
 * whose reply was lost) is answered with the one already taken, never as a
 * second; another Done while the first waits for the till is refused; and a
 * form the till marks as being saved takes no Done at all. The station also
 * hands the customer screen the "saving" and "not saved" marks.
 */

const AT = '2026-11-12T03:00:00.000Z';

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'family-request', visitorId: 'family-visitor',
    slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true, confirmations: [],
    guardianPhone: '+66898020001', contactChannel: 'whatsapp', contactConfirmed: true,
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
  const claim = await manager.claim({ stationId: STATION_ID, holder: 'done-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = async (prompt: unknown) => {
    const current = await manager.open(STATION_ID);
    return manager.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: current.sequence, payload: { stage: 'input', step: 7, prompt } }, { source: 'till' });
  };
  const send = async (payload: Record<string, unknown>, actionId: string) => {
    const current = await manager.open(STATION_ID);
    return manager.applyIntent(STATION_ID, { type: 'display.consent', actionId,
      lastSeenSequence: current.sequence, payload }, { source: 'display', deviceId: 'family-screen' });
  };
  return { manager, publish, send, close: store.close };
}

const done = (prompt: Pick<ConsentPrompt, 'requestId' | 'visitorId'>) =>
  ({ action: 'done', requestId: prompt.requestId, visitorId: prompt.visitorId });

test('SCRUM-857: a Done for an earlier revision of the form, or another family, is refused', async () => {
  const h = await openConsent();
  try {
    const now = consentPrompt({ requestId: 'family-request-2' });
    assert.ok((await h.publish(now)).ok);
    assert.equal((await h.send(done({ requestId: 'family-request', visitorId: 'family-visitor' }), 'stale')).ok, false);
    assert.equal((await h.send(done({ requestId: 'family-request-2', visitorId: 'another-visitor' }), 'other')).ok, false);
    assert.equal((await h.manager.open(STATION_ID)).prompt?.answer, undefined);
    assert.ok((await h.send(done(now), 'current')).ok);
  } finally { h.close(); }
});

test('SCRUM-857: the same Done sent twice is one answer; another Done while it waits is refused', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const first = await h.send(done(prompt), 'tap');
    assert.ok(first.ok);
    const again = await h.send(done(prompt), 'tap');
    assert.ok(again.ok);
    assert.deepEqual(again.document.prompt?.answer, first.document.prompt?.answer);
    assert.equal((await h.send(done(prompt), 'second-tap')).ok, false);
    const answer = (await h.manager.open(STATION_ID)).prompt?.answer as { actionId: string };
    assert.equal(answer.actionId, 'tap');
  } finally { h.close(); }
});

test('SCRUM-857: a form being saved reaches the customer screen as such, and takes no Done', async () => {
  const h = await openConsent();
  try {
    const finishing = consentPrompt({ requestId: 'family-request-3', completed: true, finishing: true });
    const published = await h.publish(finishing);
    assert.ok(published.ok);
    assert.deepEqual(h.manager.snapshotFor(published.document, 'customer', null).document.prompt, finishing);
    assert.equal((await h.send(done(finishing), 'late-tap')).ok, false);
  } finally { h.close(); }
});

test('SCRUM-857: a form whose Done was not saved reaches the customer screen open again, and takes the next Done', async () => {
  const h = await openConsent();
  try {
    const reopened = consentPrompt({ requestId: 'family-request-4', notSaved: true });
    const published = await h.publish(reopened);
    assert.ok(published.ok);
    assert.deepEqual(h.manager.snapshotFor(published.document, 'customer', null).document.prompt, reopened);
    assert.ok((await h.send(done(reopened), 'retry')).ok);
  } finally { h.close(); }
});

test('SCRUM-857: a saving form that is not finished, or a finished form marked not saved, is refused', async () => {
  const h = await openConsent();
  try {
    assert.equal((await h.publish(consentPrompt({ requestId: 'bad-1', finishing: true }))).ok, false);
    assert.equal((await h.publish(consentPrompt({ requestId: 'bad-2', completed: true, notSaved: true }))).ok, false);
  } finally { h.close(); }
});
