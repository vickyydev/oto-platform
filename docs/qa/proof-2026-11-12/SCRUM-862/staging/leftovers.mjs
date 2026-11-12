// Read-only: what this proof's runs left on staging. No secrets printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = { readAt: new Date().toISOString(), runs: {} };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branch = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
  const waiting = (await get(`/checkin/registrations?branchId=${branch}`)).body.registrations ?? [];
  out.waitingListToday = { total: waiting.length, ofThisProof: waiting.filter(r => /^ZZ TEST 862/.test(r.guardianName ?? '')).length };
  const stations = (await get(`/branches/${branch}/stations?includeArchived=true`)).body.stations.filter(s => /^ZZ TEST SCRUM-862 proof till/.test(s.name));
  out.tills = stations.map(s => ({ prefix: s.codePrefix, archived: Boolean(s.archived), devices: s.devices.length }));
  for (const run of ['01', '02']) {
    const r = JSON.parse(readFileSync(`out-${run}/receipt.json`, 'utf8'));
    const st = r.created.find(c => c.kind === 'station');
    const sales = (await get(`/sales?branchId=${branch}&stationId=${st.id}&limit=50`)).body.sales;
    const regs = [];
    for (const reg of r.created.filter(c => c.kind === 'registration')) regs.push({ tag: reg.tag, children: (await get('/checkin/registrations/' + reg.id)).body.children.map(c => c.status) });
    const members = [];
    for (const [k, phone] of Object.entries(r.numbers)) members.push({ k, live: Boolean((await get(`/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member) });
    out.runs[run] = { till: st.prefix, sales: sales.map(s => `${s.status} ${s.totals.grossSatang / 100}`), registrations: regs, liveMembers: members.filter(m => m.live).length };
  }
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminMe = (await admin.get('/api/me')).status();
  await admin.dispose();
}
writeFileSync('leftovers.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
