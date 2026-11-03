import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { BoxAgent } from '../src/agent';
import { StationBridge } from '../src/station-bridge';
import { StationSessionManager } from '../src/station-session';
import { createBridgeServer } from '../src/runner/bridge-server';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, STATION_ID, openTestStore } from './_support';

test('display channel: credential-only, initial and changed redacted snapshots, revocation and cleanup', async () => {
  const store = openTestStore();
  await store.store.init(BOX_ID);
  const credential = randomBytes(32).toString('hex');
  const configure = (paired: boolean) => store.store.writeBundle(BOX_ID, {
    scope: 'station_config', schemaVersion: 1, cursorSeq: 0, appliedAt: store.now().toISOString(),
    payload: { items: [{ id: STATION_ID, displays: paired ? [{ id: 'display-1', credentialHash: createHash('sha256').update(credential).digest('hex') }] : [] }] },
  });
  await configure(true);
  const sessions = new StationSessionManager({ store: store.store, boxId: BOX_ID, now: store.now,
    resolveStation: id => id === STATION_ID ? { stationId: id, boxId: BOX_ID, branchId: BRANCH_ID, operatorId: OPERATOR_ID } : null });
  const bridge = new StationBridge({ boxId: BOX_ID, store: store.store, sessions,
    station: id => id === STATION_ID ? { id, name: 'ZZ TEST counter', kind: 'till', branchId: BRANCH_ID, operatorId: OPERATOR_ID } : null,
    branch: () => ({ id: BRANCH_ID, operatorId: OPERATOR_ID, timezone: 'Asia/Bangkok', businessDayStart: '05:00' }),
    signingKeys: () => [], link: () => ({ up: false, offline: false }), sealer: () => null, verifyPassword: async () => false, now: store.now });
  const server = createBridgeServer({ agent: () => ({ bridge: () => bridge }) as BoxAgent, origins: ['https://pos.example'], port: 0 });
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}/box/v1/station/${STATION_ID}/display`;
  const controller = new AbortController();
  try {
    const presenceUrl = base.replace(/\/display$/, '/displays');
    assert.equal((await fetch(presenceUrl)).status, 401);
    await store.store.writeBundle(BOX_ID, { scope: 'deny_list', schemaVersion: 1, cursorSeq: 0,
      appliedAt: store.now().toISOString(), payload: { items: [{ revokedAccountIds: [], revokedTokenIds: [] }] } });
    const staffSession = bridge.issue(STATION_ID, { accountId: OPERATOR_ID, method: 'offline_token',
      offlineFresh: false, jti: null, expiresAt: store.now().getTime() + 60_000, permissions: new Set() });
    const presence = async () => {
      const response = await fetch(presenceUrl, { headers: { authorization: `Bearer ${staffSession}` } });
      assert.equal(response.status, 200);
      const body = await response.json() as { displays: Array<{ connected: boolean }> };
      assert.equal(JSON.stringify(body).includes('credentialHash'), false);
      return body.displays;
    };
    assert.equal((await presence())[0]?.connected, false);
    for (const authorization of ['', 'Bearer bs_staff', `Bearer ${'b'.repeat(64)}`]) {
      assert.equal((await fetch(`${base}/channel`, { headers: { authorization } })).status, 401);
    }
    const headers = { authorization: `Bearer ${credential}` };
    const response = await fetch(`${base}/channel`, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let buffer = '';
    const next = async () => {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const part = await reader.read();
        assert.equal(part.done, false);
        buffer += new TextDecoder().decode(part.value);
      }
    };
    const first = await next();
    const read = await (await fetch(`${base}/session`, { headers })).json() as { document: unknown };
    assert.equal((await presence())[0]?.connected, true);
    store.setNow(new Date(store.now().getTime() + 11_000).toISOString());
    assert.equal((await presence())[0]?.connected, false);
    await fetch(`${base}/session`, { headers });
    assert.equal((await presence())[0]?.connected, true);
    assert.deepEqual(first.document, read.document);
    const caller = { kind: 'till' as const, accountId: 'staff', can: () => true, method: 'platform' as const, offlineFresh: false, jti: null };
    const lease = await bridge.claim(STATION_ID, caller, 'test', null);
    await next();
    await bridge.intent(STATION_ID, caller, { type: 'session.publish_display', leaseId: lease.lease.leaseId,
      lastSeenSequence: lease.document.sequence, actionId: 'publish', payload: {
        stage: 'identify', step: 1, cart: null, totals: null, payment: null,
        member: { id: 'member', nickname: 'ZZ TEST', notes: 'PRIVATE', tier: 'tourist' },
        prompt: { kind: 'identify', requestId: 'request', phone: '', nickname: '', contactChannel: 'whatsapp' },
      } });
    const changed = await next();
    assert.equal(changed.document.stage, 'identify');
    assert.equal(changed.document.lease, null);
    assert.equal(changed.document.step, null);
    assert.equal(JSON.stringify(changed).includes('PRIVATE'), false);
    assert.equal(changed.actionId, null);
    await configure(false);
    assert.deepEqual(await presence(), []);
    const deadline = setTimeout(() => controller.abort(), 7_000);
    try { let ended = false; while (!ended) ended = (await reader.read()).done; assert.equal(ended, true); }
    finally { clearTimeout(deadline); }
    assert.equal(sessions.subscriberCount(), 0);
    assert.equal((await fetch(`${base}/channel`, { headers })).status, 401);
  } finally { controller.abort(); await server.close(); store.close(); }
});
