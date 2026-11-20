// Staging proof for SCRUM-1051, the serving time per dish or group on the
// till's kitchen and bar slips. Read-only on staging: nothing is edited, no
// payment is taken, no slip is printed (Central Floresta names no party-slip
// station on staging, so the till's "Print party slips now" would record
// "no printer" and change no setting). What it shows:
//
//   1  the party "ZZ TEST 1028 Staff BEO" (Central Floresta, 10 December 2026)
//      read through the platform's own route for the till, GET /parties/:id:
//      its food lines with serviceTime and serviceGroup, Fruit skewers and
//      Mini waffles in "ZZ Dessert" at 13:00;
//   2  the kitchen slip and bar slip composed from exactly that answer by the
//      slip composer the api prints with, rendered by the print package to the
//      80 mm picture the simulated printer would draw.
//
//   node proof.mjs <full-sha> <run-tag>
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '../../../..');
const helper = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helper, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helper, 'scripts/agent/render.mjs')));
const requireApi = createRequire(resolve(repo, 'apps/api/package.json'));
const { register } = requireApi('tsx/esm/api');
register();
const { composePartySlips } = await import(pathToFileURL(resolve(repo, 'packages/shared/src/index.ts')).href);
const { renderJob, previewPng } = await import(pathToFileURL(resolve(repo, 'packages/print/src/index.ts')).href);
const { request } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const tag = process.argv[3] ?? 'run';
const out = resolve(import.meta.dirname, tag);
mkdirSync(out, { recursive: true });
const pos = 'https://oto-pos-web-staging.onrender.com';
const PARTY = /ZZ TEST 1028 Staff BEO/;
const receipt = { ticket: 'SCRUM-1051', sha, startedAt: new Date().toISOString(), phase: 'preflight', points: {}, requests: [], odd: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = (value) => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };
const point = (key, pass, pictures, shows, seen = {}) => { receipt.points[key] = { pass, pictures, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); };
const ID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;

const admin = await request.newContext({ baseURL: pos });
const call = async (method, path, data) => {
  const response = await admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } });
  const body = await response.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0].replace(ID, ':id'), status: response.status() });
  return { status: response.status(), body };
};
let failed = false;
try {
  phase('deployments');
  receipt.deployments = {};
  const { execSync } = await import('node:child_process');
  for (const name of ['oto-app-staging', 'oto-api-staging', 'oto-pos-staging', 'oto-pos-web-staging']) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=10`)).map((x) => x.deploy).find((x) => x.status === 'live');
    receipt.deployments[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
    execSync(`git merge-base --is-ancestor ${sha} ${d.commit.id}`, { cwd: repo });
    receipt.deployments[name].containsProvedSha = true;
  }
  save();
  phase('sign in; find the party through the till\'s events route');
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find((b) => /Central Floresta/.test(b.name));
  assert.ok(branch);
  receipt.branch = { name: branch.name, partySlipsStationId: branch.partySlipsStationId ?? null }; save();
  const day = await call('GET', `/events/?branchId=${branch.id}&date=2026-12-10&type=party`);
  assert.equal(day.status, 200);
  const events = day.body.events ?? day.body.items ?? day.body;
  const party = events.find((e) => PARTY.test(e.title ?? e.name ?? ''));
  assert.ok(party, 'the ZZ TEST 1028 Staff BEO party on 10 December 2026');
  receipt.party = { id: party.id, title: party.title ?? party.name }; save();

  phase('1: the party page\'s route carries each line\'s serving time and group');
  const detail = await call('GET', `/parties/${party.id}?branchId=${branch.id}`);
  assert.equal(detail.status, 200);
  const kp = detail.body.kitchenPlan;
  assert.ok(kp, 'the party has a kitchen plan');
  const lines = kp.setMenu.map((m) => ({ name: m.name, qty: m.qty, note: m.note, serviceTime: m.serviceTime ?? null, serviceGroup: m.serviceGroup ?? null }));
  const bar = kp.barItems.map((m) => ({ name: m.name, qty: m.qty, serviceTime: m.serviceTime ?? null, serviceGroup: m.serviceGroup ?? null }));
  const skewers = lines.find((l) => l.name === 'Fruit skewers');
  const waffles = lines.find((l) => l.name === 'Mini waffles');
  receipt.checks = { routeLines: lines, routeBar: bar, slips: detail.body.slips ? { slipsTime: detail.body.slips.slipsTime, station: detail.body.slips.station } : null }; save();
  const pass1 = skewers?.serviceTime === '13:00' && skewers?.serviceGroup === 'ZZ Dessert' && waffles?.serviceTime === '13:00' && waffles?.serviceGroup === 'ZZ Dessert';
  point('1-route-carries-times', pass1, [], 'GET /parties/:id for the party: Fruit skewers and Mini waffles each carry serviceTime 13:00 and serviceGroup "ZZ Dessert"; the other lines carry what the BEO stores', { skewers, waffles });

  phase('2: the kitchen and bar slips composed from that answer and rendered to 80 mm pictures');
  const prepStationOf = () => null;
  const slips = composePartySlips({ plan: kp, partyName: party.title ?? party.name, location: party.location ?? null, prepStationOf, printedAt: '11:00' });
  receipt.checks.composed = { kitchen: slips.kitchen?.lines ?? null, bar: slips.bar?.lines ?? null }; save();
  const pictures = [];
  const device = { label: 'XP-80 (simulated)', model: 'xp80', language: 'escpos', widthDots: 576, dpi: 203 };
  for (const [station, kind] of [['kitchen', 'kitchen_ticket'], ['bar', 'bar_ticket']]) {
    const document = slips[station];
    if (!document) { receipt.odd.push(`no ${station} slip composed`); continue; }
    const job = renderJob({ kind, data: document }, { device, templates: [] });
    const name = `p2-${station}-slip-rendered.png`;
    writeFileSync(resolve(out, name), previewPng(job.bitmap));
    pictures.push(`SCRUM-1051/${tag}/${name}`);
    console.log('picture', name, 'overflow', job.overflow.length);
    receipt.checks[`${station}Overflow`] = job.overflow;
  }
  const kitchenLines = slips.kitchen?.lines ?? [];
  const dessert = kitchenLines.filter((l) => l.group === 'ZZ Dessert' && l.time === '13:00').map((l) => l.name);
  const timedAfterUntimed = kitchenLines.findIndex((l) => l.time) === -1 || kitchenLines.slice(kitchenLines.findIndex((l) => l.time)).every((l) => l.time);
  point('2-slips-rendered', dessert.length === 2 && timedAfterUntimed && (receipt.checks.kitchenOverflow ?? []).length === 0, pictures,
    'The kitchen slip composed from the route\'s answer prints the two ZZ Dessert dishes together under "ZZ Dessert 13:00", after the lines with no time, with nothing cut off on 80 mm paper; the bar slip beside it', { dessert, kitchenLines });
  receipt.passed = !failed && Object.values(receipt.points).every((p) => p.pass);
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, failure: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}` };
  console.log('RUN FAILED', '|', receipt.phase, '|', receipt.failure.failure);
} finally {
  if ((await admin.get('/api/me')).status() === 200) await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), failure: receipt.failure ?? null }));
if (failed || !receipt.passed) process.exitCode = 1;
