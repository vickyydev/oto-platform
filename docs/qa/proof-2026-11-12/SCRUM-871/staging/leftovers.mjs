// Read-only: what this proof's runs left on staging. No secrets printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branch = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
  const waiting = (await get(`/checkin/registrations?branchId=${branch}`)).body.registrations ?? [];
  console.log('waiting registrations', waiting.length, 'of this proof:', JSON.stringify(waiting.filter(r => /SCRUM-871/.test(r.guardianName ?? '')).map(r => ({ id: r.id, g: r.guardianName, kids: r.children.map(c => `${c.childName}:${c.status}`) }))));
  const stations = (await get(`/branches/${branch}/stations?includeArchived=true`)).body.stations.filter(s => /^ZZ TEST SCRUM-871 proof till/.test(s.name));
  for (const st of stations) {
    const sales = (await get(`/sales?branchId=${branch}&stationId=${st.id}&limit=50`)).body.sales;
    console.log('till', st.codePrefix, 'archived', Boolean(st.archived), 'sales', sales.map(s => `${s.status} ${s.totals.grossSatang / 100}`).join(' | ') || '-');
  }
  for (let n = 10; n <= 40; n++) { const phone = '08987100' + n; const m = (await get(`/members/lookup?phone=${phone}`)).body?.member; if (m) console.log('LIVE MEMBER under', phone, (m.children ?? []).length, 'children'); }
  const nannies = (await get(`/checkin/config?branchId=${branch}`)).body.nannies.filter(n => /ZZ TEST/.test(n.name));
  console.log('ZZ nannies', JSON.stringify(nannies));
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  console.log('me', (await admin.get('/api/me')).status());
  await admin.dispose();
}
