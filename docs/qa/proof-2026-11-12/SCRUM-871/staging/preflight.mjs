// Read-only preflight on staging. No secrets printed; nanny names reported only as test-like or not.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const pos = 'https://oto-pos-web-staging.onrender.com';
for (const origin of [pos, 'https://oto-pos-staging.onrender.com']) {
  const html = await (await fetch(origin + '/', { cache: 'no-store' })).text();
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
  let marks = { several_saved: 0, several_slots: 0 }, files = 0; const seen = new Set(scripts); const queue = [...scripts];
  while (queue.length && files < 120) {
    const s = queue.shift(); files += 1;
    const text = await (await fetch(new URL(s, origin + '/'), { cache: 'no-store' })).text();
    for (const k of Object.keys(marks)) marks[k] += text.split(k).length - 1;
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
  for (let n = 10; n <= 30; n += 1) {
    const phone = '08987100' + n;
    const r = await get(`/members/lookup?phone=${encodeURIComponent(phone)}`);
    console.log('lookup', phone, r.status, r.body?.member === null ? 'unused' : 'TAKEN');
  }
  const config = (await get(`/checkin/config?branchId=${branch.id}`)).body;
  console.log('bands', JSON.stringify(config.policy.bands));
  console.log('nannies', config.nannies.length, 'on shift', config.nannies.filter(n => n.onShift).length, 'nanny keys', Object.keys(config.nannies[0] ?? {}).join(','));
  console.log('nanny test-like', JSON.stringify(config.nannies.map(n => ({ onShift: n.onShift, load: n.load, testLike: /zz|test|demo|sample|qa/i.test(n.name), len: n.name.length }))));
  const regs = (await get(`/checkin/registrations?branchId=${branch.id}`)).body.registrations ?? [];
  console.log('waiting registrations', regs.length, 'ZZ TEST', regs.filter(r => /^ZZ TEST/.test(r.guardianName ?? '')).length);
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  console.log('active ZZ tills', JSON.stringify(stations.filter(s => !s.archived && /ZZ TEST/.test(s.name)).map(s => s.name)));
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  console.log('me', (await admin.get('/api/me')).status());
  await admin.dispose();
}
