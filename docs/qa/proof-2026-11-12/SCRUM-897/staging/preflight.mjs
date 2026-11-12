// Read-only preflight on staging for SCRUM-897. No secrets printed; nothing written except the admin's own sign-in/out.
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
  console.log(origin, 'entry', [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1].split('/').pop()).join(','));
}
const admin = await request.newContext({ baseURL: pos });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await get('/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  console.log('branch', branch?.id, branch?.code, branch?.timezone);
  for (let n = Number(process.env.FROM ?? 10); n <= Number(process.env.TO ?? 21); n += 1) {
    const phone = '08988970' + String(n).padStart(2, '0');
    const r = await get(`/members/lookup?phone=${encodeURIComponent(phone)}`);
    console.log('lookup', phone, r.status, r.body?.member === null ? 'unused' : 'TAKEN');
  }
  const boxes = (await get(`/branches/${branch.id}/boxes`)).body.boxes;
  console.log('boxes', JSON.stringify(boxes.map(b => ({ role: b.role, slot: b.slot, status: b.status, archived: b.archived }))));
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  console.log('active ZZ tills', stations.filter(s => !s.archived && /ZZ TEST/.test(s.name)).length, 'prefixes Z897xx taken', stations.filter(s => /^Z897/.test(s.codePrefix ?? '')).map(s => s.codePrefix).join(','));
  const held = (await get(`/sales/held?branchId=${branch.id}`));
  console.log('held sales on the branch', held.status, 'count', held.body?.sales?.length, 'counts', JSON.stringify(held.body?.counts), 'labels ZZ', (held.body?.sales ?? []).filter(s => /ZZ TEST/.test(s.label)).length);
  const discounts = (await get('/menu/discounts?includeArchived=true')).body.discounts;
  console.log('discount codes', discounts.length, 'ZZTEST897*', JSON.stringify(discounts.filter(d => /^ZZTEST897/.test(d.code)).map(d => ({ code: d.code, archived: Boolean(d.archivedAt) }))));
  console.log('discount keys', Object.keys(discounts[0] ?? {}).join(','));
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  console.log('me', (await admin.get('/api/me')).status());
  await admin.dispose();
}
