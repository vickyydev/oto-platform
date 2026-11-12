// SCRUM-897: clean up what run 01 left on staging when it was stopped at 16:22 Bangkok (before its own clean-up ran).
// Only ids named in out-run-01/receipt.json and the g2 guardian it wrote. No secrets printed; the result goes to out-run-01/cleanup.json.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request, expect } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const run = JSON.parse(readFileSync(resolve(import.meta.dirname, 'out-run-01/receipt.json'), 'utf8'));
const branchId = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const call = async (method, path, data) => { const r = await admin.fetch('/api' + path, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() } }); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = { at: new Date().toISOString(), steps: [] };
const step = (what, fact) => { out.steps.push({ what, ...fact }); console.log(what, JSON.stringify(fact)); };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const station = run.created.find(c => c.kind === 'station');
  const st = (await call('GET', `/stations/${station.id}`)).body.station;
  assert.equal(st.name, station.name, 'only the run\'s own till');
  const sales = (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
  assert.ok(sales.every(s => s.status === 'finalised'), 'no open sale left');
  for (const s of sales) {
    let jobs = [];
    await expect.poll(async () => { jobs = (await call('GET', `/sales/${s.id}`)).body.printJobs; return jobs.every(j => j.status === 'printed'); }, { timeout: 60000 }).toBe(true).catch(() => {});
    step('finalised test sale kept', { id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? s.grossSatang ?? null, printJobs: jobs.map(j => j.status) });
  }
  if (!st.archived) {
    assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
    assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
  }
  const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
  assert.ok(retired.archived); assert.equal(retired.devices.length, 0);
  step('own till retired', { id: station.id, archived: retired.archived, devices: retired.devices.length });
  for (const code of run.created.filter(c => c.kind === 'promo-code')) {
    const row = (await call('GET', '/menu/discounts?includeArchived=true')).body.discounts.find(d => d.id === code.id);
    assert.ok(row && row.code === code.code && /^ZZ TEST SCRUM-897/.test(row.label), 'only the run\'s own code');
    if (!row.archivedAt) assert.equal((await call('DELETE', `/menu/discounts/${code.id}`)).status, 200);
    const after = (await call('GET', '/menu/discounts?includeArchived=true')).body.discounts.find(d => d.id === code.id);
    const live = (await call('GET', '/menu/discounts')).body.discounts.some(d => d.id === code.id);
    assert.ok(after.archivedAt && after.active === false && !live);
    step('code archived', { code: code.code, usedCount: after.usedCount, active: after.active, inLiveList: live });
  }
  for (const [key, phone] of Object.entries(run.numbers)) {
    const m = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member ?? null;
    if (!m) { step('number', { key, member: null }); continue; }
    assert.ok(`${m.nickname ?? ''} ${m.name ?? ''}`.includes('ZZ TEST SCRUM-897'), 'only own named test members');
    for (const c of m.children ?? []) assert.match(c.name, /^ZZ TEST /);
    assert.equal((await call('DELETE', `/members/${m.id}`)).status, 200);
    const again = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member ?? null;
    step('member archived', { key, id: m.id, children: (m.children ?? []).length, lookupAfter: again ? 'STILL FOUND' : 'gone' });
  }
  const held = (await call('GET', `/sales/held?branchId=${branchId}`)).body.sales.filter(h => /897/.test(h.label ?? ''));
  step('held read-back', { own: held.length });
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminMeAfter = (await admin.get('/api/me')).status();
  writeFileSync(resolve(import.meta.dirname, 'out-run-01/cleanup.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('admin me', out.adminMeAfter);
  await admin.dispose();
}
