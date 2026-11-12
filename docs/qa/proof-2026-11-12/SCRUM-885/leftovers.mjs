// Read-only: what this proof's run left on staging. No secrets printed.
//   node leftovers.mjs out-01/receipt.json   (writes leftovers.json beside this file)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { request } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = { readAt: new Date().toISOString(), runs: [] };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branch = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
  const waiting = (await get(`/checkin/registrations?branchId=${branch}`)).body.registrations ?? [];
  out.waitingNow = { families: waiting.length, ofThisProof: waiting.filter(r => /^ZZ TEST (SCRUM-888|Ploy 888|885)/.test(r.guardianName ?? '')).length };
  const stations = (await get(`/branches/${branch}/stations?includeArchived=true`)).body.stations.filter(s => /^ZZ TEST SCRUM-885 proof till/.test(s.name));
  out.tills = stations.map(s => ({ prefix: s.codePrefix, archived: Boolean(s.archived), devices: s.devices.length }));
  for (const file of process.argv.slice(2)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    const run = { receipt: file, registrations: [], numbers: [], sales: null };
    for (const c of r.created.filter(c => c.kind === 'registration')) {
      const reg = (await get(`/checkin/registrations/${c.id}`)).body;
      const child = reg?.children?.[0] ?? {};
      run.registrations.push({ key: c.key, guardian: reg?.guardianName, children: (reg?.children ?? []).map(x => x.status),
        reasonFields: Object.fromEntries(Object.entries(child).filter(([k]) => /reason|cancel/i.test(k))) });
    }
    for (const [key, phone] of Object.entries(r.numbers)) run.numbers.push({ key, number: phone, liveMember: Boolean((await get(`/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member) });
    const st = r.created.find(c => c.kind === 'station');
    run.sales = ((await get(`/sales?branchId=${branch}&stationId=${st.id}&limit=50`)).body.sales ?? []).map(s => ({ status: s.status }));
    const display = r.created.find(c => c.kind === 'display');
    run.display = display ? { id: display.id, revokedInRun: r.cleanup.some(x => x.kind === 'display' && x.revoked) } : null;
    out.runs.push(run);
  }
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminSignedOut = (await admin.get('/api/me')).status() === 401;
  await admin.dispose();
}
writeFileSync(resolve(import.meta.dirname, 'leftovers.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
