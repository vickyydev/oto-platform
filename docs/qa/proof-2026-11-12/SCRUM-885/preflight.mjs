// Read-only preflight for the SCRUM-885 / SCRUM-888 staging proof. No secrets printed.
//   node preflight.mjs   (writes preflight.json beside this file)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { request } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = { readAt: new Date().toISOString() };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await get('/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  out.branch = { id: branch.id, name: branch.name, code: branch.code ?? branch.slug ?? null, keys: Object.keys(branch) };
  const range = [];
  for (let i = 10; i < 40; i++) { const n = '08988500' + i; const m = (await get(`/members/lookup?phone=${n}`)).body?.member; range.push({ n, member: Boolean(m) }); }
  out.numbersInUse = range.filter(r => r.member).map(r => r.n);
  out.numbersChecked = range.length;
  const waiting = (await get(`/checkin/registrations?branchId=${branch.id}`)).body.registrations ?? [];
  out.waiting = { families: waiting.length, zz: waiting.filter(r => /^ZZ TEST/.test(r.guardianName ?? '')).length,
    ownBefore: waiting.filter(r => /SCRUM-888|ZZ TEST Ploy 888|ZZ TEST 885/.test(r.guardianName ?? '')).length,
    zzNames: waiting.filter(r => /^ZZ TEST/.test(r.guardianName ?? '')).map(r => r.guardianName) };
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  out.ownTillsBefore = stations.filter(s => /^ZZ TEST SCRUM-885/.test(s.name)).map(s => ({ prefix: s.codePrefix, archived: Boolean(s.archived) }));
  const boxes = (await get(`/branches/${branch.id}/boxes`)).body.boxes;
  out.virtualBox = boxes.filter(b => b.role === 'virtual').map(b => ({ slot: b.slot, status: b.status, archived: Boolean(b.archived) }));
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminSignedOut = (await admin.get('/api/me')).status() === 401;
  await admin.dispose();
}
writeFileSync(resolve(import.meta.dirname, 'preflight.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
