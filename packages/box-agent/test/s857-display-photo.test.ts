import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsentPrompt } from '@oto/shared';

import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-857 — THE STATION PASSES THE FAMILY'S PHOTO MARK AND ITS ANSWER.
 *
 * The till marks each child whose photo the display may take (`photo`:
 * needed or taken); the display sends the picture to the platform and then
 * names the stored file in a `photo` answer. The station — this code, in the
 * cloud and, after a release, on a counter box — must hand the mark to the
 * customer screen, take the answer for a marked child, and refuse it for a
 * child the form does not ask a photo of. A station from before this change
 * strips the mark, so the display never offers the camera through it.
 */

const AT = '2026-11-12T03:00:00.000Z';
const FILE_ID = '0190f0a4-7b7e-7c3a-9f1e-1a2b3c4d5e6f';

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'photo-request', visitorId: 'photo-visitor',
    slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off', photo: 'needed' }],
    guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true, confirmations: [],
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
  const claim = await manager.claim({ stationId: STATION_ID, holder: 'photo-till', holderKind: 'till' });
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

const photo = (prompt: ConsentPrompt, slotId = 'slot') =>
  ({ action: 'photo', requestId: prompt.requestId, visitorId: prompt.visitorId, slotId, fileId: FILE_ID });

test('SCRUM-857: the customer screen is handed the photo mark of each child', async () => {
  const h = await openConsent();
  try {
    for (const mark of ['needed', 'taken'] as const) {
      const prompt = consentPrompt({ requestId: `request-${mark}`,
        slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off', photo: mark }] });
      const published = await h.publish(prompt);
      assert.ok(published.ok);
      assert.deepEqual(h.manager.snapshotFor(published.document, 'customer', null).document.prompt, prompt);
    }
  } finally { h.close(); }
});

test('SCRUM-857: the family’s photo answer reaches the till for a marked child', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt();
    assert.ok((await h.publish(prompt)).ok);
    const answered = await h.send(photo(prompt), 'photo-taken');
    assert.ok(answered.ok);
    const forTill = (await h.manager.open(STATION_ID)).prompt?.answer as { payload: Record<string, unknown> };
    assert.deepEqual(forTill.payload, photo(prompt));
  } finally { h.close(); }
});

test('SCRUM-857: a photo answer for an unmarked or unknown child is refused', async () => {
  const h = await openConsent();
  try {
    const prompt = consentPrompt({ slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }] });
    assert.ok((await h.publish(prompt)).ok);
    assert.equal((await h.send(photo(prompt), 'unmarked')).ok, false);
    const marked = consentPrompt({ requestId: 'photo-request-2' });
    assert.ok((await h.publish(marked)).ok);
    assert.equal((await h.send(photo(marked, 'another-child'), 'unknown-child')).ok, false);
    assert.equal((await h.send({ ...photo(marked), visitorId: 'another-visitor' }, 'another-visitor')).ok, false);
  } finally { h.close(); }
});
