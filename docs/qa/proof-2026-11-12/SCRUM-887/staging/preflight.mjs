// Read-only preflight on staging for SCRUM-887. No secrets printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const pos = 'https://oto-pos-web-staging.onrender.com';
// Run 04 adds the follow-up fix's strings (9df18d68): the door retry words and the box's own refusal cause.
const keys = ['Connection dropped — retrying', 'finishing their registration online', 'finishing this sale online under the same sale number', 'The connection dropped and has not come back yet', 'UPSTREAM_UNAVAILABLE', 'finishing their check-in online', 'box-not-synced'];
for (const origin of [pos, 'https://oto-pos-staging.onrender.com']) {
  const html = await (await fetch(origin + '/', { cache: 'no-store' })).text();
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
  const marks = Object.fromEntries(keys.map(k => [k, 0])); let files = 0; const seen = new Set(scripts); const queue = [...scripts];
  while (queue.length && files < 150) {
    const s = queue.shift(); files += 1;
    let text = await (await fetch(new URL(s, origin + '/'), { cache: 'no-store' })).text();
    try { text = text.replace(/\u2014/g, '—'); } catch {}
    for (const k of keys) marks[k] += text.split(k).length - 1;
    for (const m of text.matchAll(/["'](?:\.\/|\/assets\/)?([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js)["']/g)) { const u = '/assets/' + m[1]; if (!seen.has(u)) { seen.add(u); queue.push(u); } }
  }
  console.log(origin, 'entry', scripts.map(s => s.split('/').pop()).join(','), 'files', files, 'markers', JSON.stringify(marks));
}
const admin = await request.newContext({ baseURL: pos });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await get('/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  console.log('branch', branch?.id, branch?.code);
  for (let n = Number(process.env.FROM ?? 10); n <= Number(process.env.TO ?? 25); n += 1) {
    const phone = '08988700' + n;
    const r = await get(`/members/lookup?phone=${encodeURIComponent(phone)}`);
    console.log('lookup', phone, r.status, r.body?.member === null ? 'unused' : 'TAKEN');
  }
  const boxes = (await get(`/branches/${branch.id}/boxes`)).body.boxes;
  console.log('boxes', JSON.stringify(boxes.map(b => ({ role: b.role, slot: b.slot, status: b.status, archived: b.archived }))));
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  console.log('active ZZ tills', JSON.stringify(stations.filter(s => !s.archived && /ZZ TEST/.test(s.name)).map(s => s.name)));
  const regs = (await get(`/checkin/registrations?branchId=${branch.id}`)).body.registrations ?? [];
  console.log('waiting registrations', regs.length, 'ZZ TEST 887', regs.filter(r => /887/.test(r.guardianName ?? '')).length);
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  console.log('me', (await admin.get('/api/me')).status());
  await admin.dispose();
}
