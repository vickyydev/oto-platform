// Read-only preflight for SCRUM-862 on staging. No secrets, no names of people printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const pos = 'https://oto-pos-web-staging.onrender.com';
const admin = await request.newContext({ baseURL: pos });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = {};
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const health = await get('/health'); out.health = { status: health.status, version: JSON.stringify(health.body).slice(0, 200) };
  const branches = (await get('/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  out.branch = branch.id;
  // The route exists on the new api: an empty body is refused by validation (400), the old api answers 404.
  const probe = await admin.post(`/api/checkin/registrations/${randomUUID()}/cancel`, { data: {}, headers: { 'idempotency-key': randomUUID() } });
  out.cancelRouteProbe = { status: probe.status(), code: (await probe.json().catch(() => null))?.error?.code ?? null };
  const regs = (await get(`/checkin/registrations?branchId=${branch.id}`)).body.registrations ?? [];
  out.waiting = regs.map(r => ({ zz: /^ZZ TEST/.test(r.guardianName ?? ''), createdAt: r.createdAt ?? null, source: r.source ?? null,
    children: r.children.map(c => ({ status: c.status, scheduledFor: c.scheduledFor, zz: /^ZZ TEST/.test(c.childName ?? '') })) }));
  out.keys = Object.keys(regs[0] ?? {});
  for (let n = 10; n <= 30; n += 1) {
    const phone = '08986200' + n;
    const r = await get(`/members/lookup?phone=${encodeURIComponent(phone)}`);
    (out.numbers ??= {})[phone] = r.body?.member === null ? 'unused' : 'TAKEN';
  }
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  out.activeZz = stations.filter(s => !s.archived && /ZZ TEST/.test(s.name)).map(s => s.name);
  out.prefixesZ862 = stations.filter(s => /^Z862/.test(s.codePrefix ?? '')).map(s => s.codePrefix);
} finally {
  const o = await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.signOut = o.status(); out.me = (await admin.get('/api/me')).status();
  await admin.dispose();
}
writeFileSync(process.argv[2] ?? 'preflight.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
