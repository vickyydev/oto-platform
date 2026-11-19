import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { BoxAgent } from '../src/agent';
import { StationBridge } from '../src/station-bridge';
import { StationSessionManager } from '../src/station-session';
import { createBridgeServer } from '../src/runner/bridge-server';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, STATION_ID, openTestStore } from './_support';

/**
 * SCRUM-1041 — MORE THAN ONE CUSTOMER DISPLAY ON A TILL, ON THE BOX.
 *
 * The box already holds a station's displays as a list in its
 * `station_config` copy; nothing on it refused a second one. These pins keep
 * it so: each paired display reads the same document and stream, an answer
 * from one is taken once and shown on the others, a second answer made on the
 * same copy is refused, and a display taken off the list stops while the
 * others go on. The till's list reads each display's name and when it was
 * last seen.
 */
test('several displays on one station: one document, one answer, per-display presence and removal', async () => {
  const store = openTestStore();
  await store.store.init(BOX_ID);
  const credentials = [0, 1, 2].map(() => randomBytes(32).toString('hex'));
  const names = ['ZZ TEST counter left', 'ZZ TEST counter right', 'ZZ TEST tablet'];
  const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');
  const configure = (kept: number[]) => store.store.writeBundle(BOX_ID, {
    scope: 'station_config', schemaVersion: 1, cursorSeq: 0, appliedAt: store.now().toISOString(),
    payload: { items: [{ id: STATION_ID, displays: kept.map((index) => ({
      id: `display-${index + 1}`, credentialHash: hashOf(credentials[index]!), name: names[index],
    })) }] },
  });
  await configure([0, 1, 2]);
  const sessions = new StationSessionManager({ store: store.store, boxId: BOX_ID, now: store.now,
    resolveStation: id => id === STATION_ID ? { stationId: id, boxId: BOX_ID, branchId: BRANCH_ID, operatorId: OPERATOR_ID } : null });
  const bridge = new StationBridge({ boxId: BOX_ID, store: store.store, sessions,
    station: id => id === STATION_ID ? { id, name: 'ZZ TEST counter', kind: 'till', branchId: BRANCH_ID, operatorId: OPERATOR_ID } : null,
    branch: () => ({ id: BRANCH_ID, operatorId: OPERATOR_ID, timezone: 'Asia/Bangkok', businessDayStart: '05:00' }),
    signingKeys: () => [], link: () => ({ up: false, offline: false }), sealer: () => null, verifyPassword: async () => false, now: store.now });
  const server = createBridgeServer({ agent: () => ({ bridge: () => bridge }) as BoxAgent, origins: ['https://pos.example'], port: 0 });
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}/box/v1/station/${STATION_ID}/display`;
  const controllers = credentials.map(() => new AbortController());
  try {
    await store.store.writeBundle(BOX_ID, { scope: 'deny_list', schemaVersion: 1, cursorSeq: 0,
      appliedAt: store.now().toISOString(), payload: { items: [{ revokedAccountIds: [], revokedTokenIds: [] }] } });
    const staffSession = bridge.issue(STATION_ID, { accountId: OPERATOR_ID, method: 'offline_token',
      offlineFresh: false, jti: null, expiresAt: store.now().getTime() + 600_000, permissions: new Set() });
    type Listed = { id: string; name: string; connected: boolean; lastSeenAt?: string | null };
    const presence = async (): Promise<Listed[]> => {
      const response = await fetch(base.replace(/\/display$/, '/displays'), { headers: { authorization: `Bearer ${staffSession}` } });
      assert.equal(response.status, 200);
      const body = await response.json() as { displays: Listed[] };
      assert.equal(JSON.stringify(body).includes('credentialHash'), false);
      return body.displays;
    };
    const headersOf = (index: number) => ({ authorization: `Bearer ${credentials[index]}` });

    // Listed by the names given in the Console, none seen yet.
    assert.deepEqual(await presence(), names.map((name, index) => ({ id: `display-${index + 1}`, name, connected: false, lastSeenAt: null })));

    // Each display opens its own stream on the same station.
    const streams = await Promise.all(credentials.map(async (_, index) => {
      const response = await fetch(`${base}/channel`, { headers: headersOf(index), signal: controllers[index]!.signal });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      let buffer = '';
      return async () => {
        for (;;) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) return JSON.parse(data.slice(6)) as { document: { sequence: number; prompt: Record<string, unknown> | null } };
            continue;
          }
          const part = await reader.read();
          assert.equal(part.done, false);
          buffer += new TextDecoder().decode(part.value);
        }
      };
    }));
    for (const next of streams) await next();
    assert.equal(sessions.subscriberCount(STATION_ID), 3);
    const listed = await presence();
    assert.deepEqual(listed.map(row => row.connected), [true, true, true]);
    assert.ok(listed.every(row => typeof row.lastSeenAt === 'string'));

    // The till publishes once: every display is sent the same document.
    const caller = { kind: 'till' as const, accountId: 'staff', can: () => true, method: 'platform' as const, offlineFresh: false, jti: null };
    const lease = await bridge.claim(STATION_ID, caller, 'test', null);
    for (const next of streams) await next();
    const published = await bridge.intent(STATION_ID, caller, { type: 'session.publish_display', leaseId: lease.lease.leaseId,
      lastSeenSequence: lease.document.sequence, actionId: 'publish', payload: {
        stage: 'identify', step: 1, cart: null, totals: null, payment: null, member: null,
        prompt: { kind: 'identify', requestId: 'request-1', phone: '', nickname: '', contactChannel: 'whatsapp' },
      } });
    const seen = await Promise.all(streams.map(next => next()));
    assert.ok(seen.every(message => message.document.sequence === published.document.sequence));
    assert.deepEqual(seen[1]!.document, seen[0]!.document);
    assert.deepEqual(seen[2]!.document, seen[0]!.document);

    // Two families' presses on the same copy: the first is taken, once; the second is refused.
    const answer = (index: number, phone: string, lastSeenSequence: number) => fetch(`${base}/intents`, {
      method: 'POST', headers: { ...headersOf(index), 'content-type': 'application/json', origin: 'https://pos.example' },
      body: JSON.stringify({ type: 'display.identify', actionId: `answer-${index}`, lastSeenSequence,
        payload: { requestId: 'request-1', phone, nickname: '', contactChannel: 'whatsapp' } }),
    });
    const first = await answer(0, '0810000001', published.document.sequence);
    assert.equal(first.status, 200);
    // Pressed at the same moment on the same copy: refused, with nothing written.
    const second = await answer(1, '0810000002', published.document.sequence);
    assert.equal(second.status, 403);
    assert.equal(((await second.json()) as { error: { message: string } }).error.message, 'The till is still handling the answer already sent.');
    const shown = await Promise.all(streams.map(next => next()));
    const taken = { type: 'identify', actionId: 'answer-0', phone: '0810000001', nickname: '', contactChannel: 'whatsapp' };
    for (const message of shown) assert.deepEqual(message.document.prompt?.answer, taken);
    // Sent again on the newer copy, the other display's answer waits for the till to take the first.
    const waiting = await answer(1, '0810000002', shown[1]!.document.sequence);
    assert.equal(waiting.status, 403);
    const read = await (await fetch(`${base}/session`, { headers: headersOf(2) })).json() as { document: { prompt: { answer: unknown } } };
    assert.deepEqual(read.document.prompt.answer, taken);

    // Past the presence window a display that stopped calling is still listed, with when it was seen.
    for (const controller of controllers.slice(1)) controller.abort();
    const lastCall = store.now().getTime();
    store.setNow(new Date(lastCall + 11_000).toISOString());
    await fetch(`${base}/session`, { headers: headersOf(0) });
    const later = await presence();
    assert.deepEqual(later.map(row => row.connected), [true, false, false]);
    assert.equal(later[1]!.lastSeenAt !== null && Date.parse(later[1]!.lastSeenAt!) <= lastCall, true);

    // Removing one display: it stops, the others go on.
    await configure([0, 2]);
    assert.equal((await fetch(`${base}/session`, { headers: headersOf(1) })).status, 401);
    assert.equal((await fetch(`${base}/session`, { headers: headersOf(0) })).status, 200);
    assert.equal((await fetch(`${base}/session`, { headers: headersOf(2) })).status, 200);
    assert.deepEqual((await presence()).map(row => row.id), ['display-1', 'display-3']);
  } finally {
    for (const controller of controllers) controller.abort();
    await server.close();
    store.close();
  }
});
