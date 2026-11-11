// Read-only: what this proof's runs left on staging. No secrets printed.
//   node leftovers.mjs receipt-run-01.json receipt.json   (writes leftovers.json beside this file)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { request } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = { readAt: new Date().toISOString(), runs: [] };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branch = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
  const waiting = (await get(`/checkin/registrations?branchId=${branch}`)).body.registrations ?? [];
  out.waitingRegistrationsOfThisProof = waiting.filter(r => /^ZZ TEST SCRUM-858/.test(r.guardianName ?? '') || (r.children ?? []).some(c => /^ZZ TEST SCRUM-858/.test(c.childName ?? ''))).length;
  const stations = (await get(`/branches/${branch}/stations?includeArchived=true`)).body.stations.filter(s => /^ZZ TEST SCRUM-858 proof till/.test(s.name));
  out.tills = stations.map(s => ({ name: s.name, prefix: s.codePrefix, archived: Boolean(s.archived), devices: s.devices.length }));
  for (const file of process.argv.slice(2)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    const st = r.created.find(c => c.kind === 'station');
    const sales = (await get(`/sales?branchId=${branch}&stationId=${st.id}&limit=50`)).body.sales;
    const members = [];
    for (const [key, phone] of Object.entries(r.numbers)) { const m = (await get(`/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member; members.push({ key, number: phone, liveMember: Boolean(m) }); }
    const grants = [];
    for (const s of sales) { const b = (await get('/sales/' + s.id)).body; grants.push(...(b.grants ?? []).map(g => ({ sale: s.receiptNumber ?? s.id, role: g.role, creditSatang: g.creditSatang }))); }
    out.runs.push({ receipt: file, till: st.prefix, sales: sales.map(s => ({ receipt: s.receiptNumber ?? null, status: s.status, baht: s.totals.grossSatang / 100, tier: s.customerTier ?? null })), walletGrants: grants, numbers: members });
  }
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminSignedOut = (await admin.get('/api/me')).status() === 401;
  await admin.dispose();
}
writeFileSync(resolve(import.meta.dirname, 'leftovers.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
