import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsentPrompt } from '@oto/shared';

import { StationBridge, type BridgeHost } from '../src/station-bridge';
import { StationSessionManager } from '../src/station-session';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, openTestStore, STATION_ID } from './_support';

/**
 * SCRUM-942 (first part) — THE STATION SAYS WHERE THE FAMILY'S FORM STANDS.
 *
 * A till that nobody touched locks while a family fills the drop-off form on
 * its paired display. A locked session may do no business, but it may read
 * its station's status, which carries no personal data; that read now says
 * whether the family's form is open (`filling`) or their Done waits for the
 * till (`done`), so the lock screen can say so. Read from the station
 * document, never created by the read.
 *
 * SCRUM-943 — the station carries the till's `reportsCamera` to the display
 * and takes a `fill` that says the display cannot take the photo.
 */

const AT = '2026-11-12T03:00:00.000Z';

function consentPrompt(overrides: Partial<ConsentPrompt> = {}): ConsentPrompt {
  return { kind: 'consent', requestId: 'zz-942-request', visitorId: 'zz-942-visitor',
    slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true, confirmations: [],
    guardianPhone: '+66898942001', contactChannel: 'whatsapp', contactConfirmed: true,
    staffReady: true, canContinue: true, completed: false, ...overrides };
}

async function station() {
  const store = openTestStore(AT);
  await store.store.init(BOX_ID);
  const identity = { stationId: STATION_ID, boxId: BOX_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID };
  const sessions = new StationSessionManager({
    store: store.store,
    boxId: BOX_ID,
    resolveStation: (stationId) => (stationId === STATION_ID ? identity : null),
    queueFact: async () => undefined,
    now: () => store.now(),
  });
  const host: BridgeHost = {
    boxId: BOX_ID,
    store: store.store,
    sessions,
    station: (id) => (id === STATION_ID ? { id, name: 'ZZ TEST till', kind: 'till', branchId: BRANCH_ID, operatorId: OPERATOR_ID } : null),
    branch: () => ({ id: BRANCH_ID, operatorId: OPERATOR_ID, timezone: 'Asia/Bangkok', businessDayStart: '05:00' }),
    signingKeys: () => [],
    link: () => ({ up: true, offline: false }),
    sealer: () => null,
    verifyPassword: async () => false,
    now: () => store.now(),
  };
  const bridge = new StationBridge(host);
  const familyForm = async () => (await bridge.status(STATION_ID)).familyForm;
  return { store, sessions, bridge, familyForm };
}

async function withForm() {
  const s = await station();
  const claim = await s.sessions.claim({ stationId: STATION_ID, holder: 'zz-till', holderKind: 'till' });
  assert.ok(claim.ok);
  const publish = async (payload: Record<string, unknown>) => {
    const current = await s.sessions.open(STATION_ID);
    return s.sessions.applyIntent(STATION_ID, { type: 'session.publish_display', leaseId: claim.lease.leaseId,
      lastSeenSequence: current.sequence, payload }, { source: 'till' });
  };
  const send = async (payload: Record<string, unknown>, actionId: string) => {
    const current = await s.sessions.open(STATION_ID);
    return s.sessions.applyIntent(STATION_ID, { type: 'display.consent', actionId,
      lastSeenSequence: current.sequence, payload }, { source: 'display', deviceId: 'zz-screen' });
  };
  return { ...s, publish, send };
}

test('SCRUM-942: a station with no document says no form, and the read does not create one', async () => {
  const s = await station();
  try {
    assert.equal(await s.familyForm(), null);
    assert.equal(await s.store.store.readSession(STATION_ID), null);
  } finally { s.store.close(); }
});

test('SCRUM-942: the form open on the display reads as filling, the family’s Done as done', async () => {
  const s = await withForm();
  try {
    const prompt = consentPrompt();
    assert.ok((await s.publish({ stage: 'input', step: 7, prompt })).ok);
    assert.equal(await s.familyForm(), 'filling');
    // A fill the till has not taken yet is still the form being filled.
    const fill = { action: 'fill', requestId: prompt.requestId, visitorId: prompt.visitorId, slots: [],
      guardianName: 'ZZ TEST guardian', consentAcknowledged: true, acknowledgedConfirmationIds: [] };
    assert.ok((await s.send(fill, 'zz-fill')).ok);
    assert.equal(await s.familyForm(), 'filling');
    // The till takes it (a new request), and the family presses Done.
    const next = consentPrompt({ requestId: 'zz-942-request-2' });
    assert.ok((await s.publish({ stage: 'input', step: 7, prompt: next })).ok);
    assert.ok((await s.send({ action: 'done', requestId: next.requestId, visitorId: next.visitorId }, 'zz-done')).ok);
    assert.equal(await s.familyForm(), 'done');
  } finally { s.store.close(); }
});

test('SCRUM-942: no form once the till has moved on, or while it saves the finished one', async () => {
  const s = await withForm();
  try {
    assert.ok((await s.publish({ stage: 'input', step: 7, prompt: consentPrompt({ completed: true, finishing: true }) })).ok);
    assert.equal(await s.familyForm(), null);
    assert.ok((await s.publish({ stage: 'order', step: 3, prompt: null })).ok);
    assert.equal(await s.familyForm(), null);
  } finally { s.store.close(); }
});

test('SCRUM-943: the till’s reportsCamera reaches the display, and a fill saying the camera was refused is taken', async () => {
  const s = await withForm();
  try {
    const prompt = consentPrompt({ reportsCamera: true, slots: [{ id: 'slot', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off', photo: 'needed' }] });
    const published = await s.publish({ stage: 'input', step: 7, prompt });
    assert.ok(published.ok);
    const shown = s.sessions.snapshotFor(published.document, 'customer', null).document.prompt as Record<string, unknown>;
    assert.equal(shown.reportsCamera, true);
    const fill = { action: 'fill', requestId: prompt.requestId, visitorId: prompt.visitorId, slots: [],
      guardianName: 'ZZ TEST guardian', consentAcknowledged: true, acknowledgedConfirmationIds: [], camera: 'refused' };
    const sent = await s.send(fill, 'zz-camera');
    assert.ok(sent.ok);
    assert.equal(((sent.document.prompt?.answer as { payload: { camera?: string } }).payload).camera, 'refused');
    // Anything else in that field is not a fill.
    assert.equal((await s.send({ ...fill, camera: 'broken' }, 'zz-camera-2')).ok, false);
  } finally { s.store.close(); }
});
