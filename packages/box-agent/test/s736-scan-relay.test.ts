import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StationScanMessage } from '../src/contract';
import type { AgentRequestInit, AgentResponse } from '../src/transport';
import { fakeBoxCloud, openTestAgent, tillBundle, STATION_ID } from './_support';

test('SCRUM-736: local delivery never waits for a bounded online relay and uses the same identity', async () => {
  const cloud = fakeBoxCloud(tillBundle()); const normal = cloud.fetch;
  const relayed: Array<{ stationId: string; scan: StationScanMessage }> = [];
  const requests: AgentRequestInit[] = [];
  const finish: Array<(answer: AgentResponse) => void> = [];
  cloud.fetch = (url, init) => {
    if (!url.endsWith('/box/v1/scans')) return normal(url, init);
    requests.push(init); relayed.push(JSON.parse(init.body!));
    return new Promise(resolve => finish.push(resolve));
  };
  const held = await openTestAgent(cloud);
  const local: StationScanMessage[] = [];
  const stop = held.agent.sessions()!.subscribe(STATION_ID, 'staff', message => {
    if (message.kind === 'scan') local.push(message);
  });
  try {
    for (let i = 0; i < 10; i++) await held.agent.scanner()!.deliver(STATION_ID, { code: 'ZZ TEST unreadable code', source: 'box_hid' });
    assert.equal(local.length, 10, 'a slow cloud must not hold the counter scanner');
    assert.equal(relayed.length, 8, 'concurrent relays are bounded without a backlog');
    assert.equal(new Set(local.map(message => message.scanId)).size, 10, 'same code read twice is two events');
    assert.deepEqual(relayed.map(row => row.scan), local.slice(0, 8));
    assert.ok(requests.every(request => request.answerTimeoutMs === 2000));
    for (const done of finish) done({ status: 503, json: async () => null, text: async () => '', header: () => null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(relayed.length, 8, 'a refused delivery is never retried');
    assert.equal((await held.harness.store.depth(held.agent.state.boxId!)).queued, 0);
  } finally { stop(); held.close(); }
});

test('SCRUM-736: when the platform is unreachable the real scanner still publishes on the local bridge', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  let relays = 0, blocked = false;
  const normal = cloud.fetch;
  cloud.fetch = (url, init) => {
    if (url.endsWith('/box/v1/scans')) relays++;
    if (blocked) return Promise.reject(new Error('platform unreachable'));
    return normal(url, init);
  };
  const held = await openTestAgent(cloud);
  blocked = true;
  await held.agent.syncConfig().catch(() => undefined);
  assert.equal(held.agent.state.linkUp, false);
  const local: StationScanMessage[] = [];
  const stop = held.agent.sessions()!.subscribe(STATION_ID, 'staff', message => { if (message.kind === 'scan') local.push(message); });
  try {
    await held.agent.scanner()!.deliver(STATION_ID, { code: 'ZZ TEST offline code', source: 'box_serial' });
    assert.equal(local.length, 1); assert.equal(relays, 0);
  } finally { stop(); held.close(); }
});
