// Cancel ONE registration this proof made (asserted by its ZZ TEST SCRUM-871 guardian name). No secrets printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const id = process.argv[2];
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const reg = await (await admin.get('/api/checkin/registrations/' + id)).json();
  assert.match(reg.guardianName, /^ZZ TEST SCRUM-871 guardian /);
  for (const c of reg.children) assert.match(c.childName, /^ZZ TEST /);
  console.log('before', reg.children.map(c => `${c.childName}:${c.status}:sale=${Boolean(c.saleId)}`).join(', '));
  const r = await admin.post(`/api/checkin/registrations/${id}/cancel`, { data: { reason: 'ZZ TEST SCRUM-871 proof cleanup (left by the offline-lane retry of run 01)' }, headers: { 'idempotency-key': randomUUID() } });
  console.log('cancel', r.status(), r.status() >= 400 ? (await r.json().catch(() => null))?.error?.code : '');
  const after = await (await admin.get('/api/checkin/registrations/' + id)).json();
  console.log('after', after.children.map(c => `${c.childName}:${c.status}`).join(', '));
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  await admin.dispose();
}
