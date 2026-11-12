// SCRUM-897: read back, after all runs, that nothing this proof made is left live on staging. Read-only; no secrets printed.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const branchId = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
const out = { at: new Date().toISOString() };
try {
  if ((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status() !== 200) throw new Error('sign-in');
  const stations = (await get(`/branches/${branchId}/stations?includeArchived=true`)).body.stations.filter(s => /^ZZ TEST SCRUM-897/.test(s.name));
  out.tills = stations.map(s => ({ prefix: s.codePrefix, archived: s.archived, devices: s.devices.length }));
  out.codes = (await get('/menu/discounts?includeArchived=true')).body.discounts.filter(d => /^ZZTEST897/.test(d.code)).map(d => ({ code: d.code, archived: Boolean(d.archivedAt), active: d.active, usedCount: d.usedCount }));
  out.liveCodes = (await get('/menu/discounts')).body.discounts.filter(d => /^ZZTEST897/.test(d.code)).length;
  out.numbers = {};
  for (const n of [...Array(5).keys()].flatMap(i => [10 + i, 20 + i, 30 + i])) {
    const phone = '08988970' + n;
    out.numbers[phone] = (await get(`/members/lookup?phone=${encodeURIComponent(phone)}`)).body?.member ? 'MEMBER FOUND' : 'none';
  }
  out.heldOwn = ((await get(`/sales/held?branchId=${branchId}`)).body.sales ?? []).filter(h => /897/.test(h.label ?? '')).length;
  const regIds = ['out-run-02', 'out-run-03'].flatMap(d => JSON.parse(readFileSync(resolve(import.meta.dirname, d, 'receipt.json'), 'utf8')).created.filter(c => c.kind === 'registration').map(c => c.id));
  out.registrations = [];
  for (const id of regIds) out.registrations.push({ id, children: ((await get('/checkin/registrations/' + id)).body?.children ?? []).map(c => c.status) });
  const sales = [];
  for (const d of ['out-run-01', 'out-run-02', 'out-run-03']) for (const c of JSON.parse(readFileSync(resolve(import.meta.dirname, d, 'receipt.json'), 'utf8')).created.filter(c => /sale/.test(c.kind))) {
    const s = (await get('/sales/' + c.id)).body;
    sales.push({ run: d.slice(-2), kind: c.kind, status: s?.sale?.status, grossSatang: s?.sale?.totals?.grossSatang ?? s?.sale?.grossSatang ?? null, payments: (s?.attempts ?? []).map(a => `${a.method} ${a.status} ${a.amountSatang}`), printJobs: (s?.printJobs ?? []).map(j => j.status) });
  }
  out.sales = sales;
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminMeAfter = (await admin.get('/api/me')).status();
  await admin.dispose();
  writeFileSync(resolve(import.meta.dirname, 'final-readback.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 1));
}
