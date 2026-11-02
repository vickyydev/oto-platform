import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BoxAgent } from '../src/agent';
import { BOX_AGENT_BUILD } from '../src/build';
import { StationBridge } from '../src/station-bridge';
import { StationSessionManager } from '../src/station-session';
import { createKioskServer } from '../src/runner/kiosk-server';
import { createLocalDisplayHttp } from '../src/runner/display-http';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, STATION_ID, openTestStore } from './_support';

test('local paired display boots without the cloud, redacts, rejects other callers and detaches streams', async () => {
  const store = openTestStore(); await store.store.init(BOX_ID);
  const credential = randomBytes(32).toString('hex');
  const configure = (paired: boolean) => store.store.writeBundle(BOX_ID, { scope: 'station_config', schemaVersion: 1, cursorSeq: 0, appliedAt: store.now().toISOString(),
    payload: { items: [{ id: STATION_ID, displays: paired ? [{ id: 'display-713', credentialHash: createHash('sha256').update(credential).digest('hex') }] : [] }] } });
  await configure(true);
  const station = { id: STATION_ID, name: 'ZZ TEST local display', kind: 'till', branchId: BRANCH_ID, operatorId: OPERATOR_ID };
  const sessions = new StationSessionManager({ store: store.store, boxId: BOX_ID, now: store.now,
    resolveStation: id => id === STATION_ID ? { stationId: id, boxId: BOX_ID, branchId: BRANCH_ID, operatorId: OPERATOR_ID } : null });
  const bridge = new StationBridge({ boxId: BOX_ID, store: store.store, sessions, station: id => id === STATION_ID ? station : null,
    branch: () => ({ id: BRANCH_ID, operatorId: OPERATOR_ID, timezone: 'Asia/Bangkok', businessDayStart: '05:00' }),
    signingKeys: () => [], link: () => ({ up: false, offline: false }), sealer: () => null, verifyPassword: async () => false, now: store.now });
  const agent = { bridge: () => bridge, config: () => ({ stations: [station] }) } as unknown as BoxAgent;
  const dir = mkdtempSync(join(tmpdir(), 'oto-display-713-'));
  mkdirSync(join(dir, 'assets')); writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ZZ TEST paired display</title>');
  writeFileSync(join(dir, 'assets/display-hash.js'), '/* local asset */');
  let cloudCalls = 0;
  const kiosk = createKioskServer({ port: 0, pageDir: null, displayPageDir: dir,
    display: (req, res) => local(req, res), booth: () => null,
    state: async () => ({ registered: true, online: false, booths: [], selectedStationId: null, agentVersion: 'test' }),
    claim: async () => ({ ok: false, reason: 'invalid' }), selectBooth: async () => false });
  const { port } = await kiosk.listen(); const origin = `http://127.0.0.1:${port}`;
  const local = createLocalDisplayHttp({ agent: () => agent, apiBaseUrl: 'https://api.invalid', origins: [origin], fetch: async () => { cloudCalls++; throw new Error('offline'); } });
  const headers = { authorization: `Bearer ${credential}` };
  try {
    const page = await fetch(origin + '/display/'); assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(await page.text(), /ZZ TEST paired display/);
    assert.equal((await fetch(origin + '/display/assets/missing-hash.js')).status, 404);
    assert.equal((await fetch(origin + '/display/%2e%2e%2foutside.txt')).status, 404);
    assert.deepEqual(await (await fetch(origin + '/api/display/version')).json(), { build: BOX_AGENT_BUILD.id });
    const paired = await fetch(origin + '/api/display/pairing', { headers });
    assert.equal(paired.status, 200); assert.equal((await paired.json() as { status: string }).status, 'paired');
    const caller = { kind: 'till' as const, accountId: 'staff', can: () => true, method: 'platform' as const, offlineFresh: false, jti: null };
    const lease = await bridge.claim(STATION_ID, caller, 'test', null);
    await bridge.intent(STATION_ID, caller, { type: 'session.publish_display', leaseId: lease.lease.leaseId, lastSeenSequence: lease.document.sequence,
      actionId: 'local-publish', payload: { stage: 'identify', step: 1, cart: null, totals: null, payment: null,
        member: { id: 'member', nickname: 'ZZ TEST', notes: 'PRIVATE STAFF NOTE', tier: 'tourist' },
        prompt: { kind: 'identify', requestId: 'request', phone: '', nickname: '', contactChannel: 'whatsapp' } } });
    const snapshot = await (await fetch(origin + '/api/display/session', { headers })).json() as { document: { lease: unknown; stage: string } };
    assert.equal(snapshot.document.stage, 'identify'); assert.equal(snapshot.document.lease, null);
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE STAFF NOTE'), false); assert.equal(cloudCalls, 0);
    for (const authorization of ['', 'Bearer bs_staff', `Bearer ${'b'.repeat(64)}`]) {
      assert.equal((await fetch(origin + '/api/display/session', { headers: { authorization } })).status, 401);
    }
    const scoped = `/api/box/v1/station/${STATION_ID}/display`;
    assert.equal((await fetch(origin + `/api/box/v1/station/${STATION_ID}/session`, { headers })).status, 404);
    for (const path of ['/api/display/session', scoped + '/channel']) {
      const denied = await fetch(origin + path, { headers: { ...headers, origin: 'https://evil.invalid' } });
      assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
      // fetch owns Host; use an actual forged HTTP header for this guard.
      const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(origin + path, { headers: { ...headers, host: `evil.invalid:${port}` } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); req.end();
      });
      assert.equal(hostStatus, 403);
    }
    assert.equal((await fetch(origin + scoped + '/intents', { method: 'POST', headers: { ...headers, origin, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(origin + scoped + '/intents', { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'sale.finalise', payload: {} }) })).status, 400);
    for (let i = 0; i < 30; i++) {
      const controller = new AbortController();
      const stream = await fetch(origin + scoped + '/channel', { headers, signal: controller.signal });
      assert.equal(stream.status, 200); assert.equal(stream.headers.get('content-encoding'), null);
      await stream.body!.getReader().read(); controller.abort();
      for (let n = 0; n < 100 && sessions.subscriberCount(); n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(sessions.subscriberCount(), 0);
    }
    await configure(false);
    assert.equal((await fetch(origin + scoped + '/session', { headers })).status, 401);
    assert.equal((await fetch(origin + '/api/display/pairing', { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: '{}' })).status, 503);
    assert.equal(cloudCalls, 1, 'a failed pairing write is never retried');
  } finally { await kiosk.close(); store.close(); }
});
