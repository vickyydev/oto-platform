// Read-only leftover check for the SCRUM-857 part 1 proof: own tills, waiting registrations, members on the numbers used.
// No secret printed; signs out at the end.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const pos = 'https://oto-pos-web-staging.onrender.com';
const admin = await request.newContext({ baseURL: pos });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const out = {};
try {
  if ((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status() !== 200) throw new Error('sign-in refused');
  const branches = (await get('/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations.filter(s => /ZZ TEST SCRUM-857/.test(s.name));
  out.ownTills = stations.map(s => ({ id: s.id, prefix: s.codePrefix, archived: s.archived, devices: s.devices.length }));
  const regs = (await get(`/checkin/registrations?branchId=${branch.id}`)).body?.registrations ?? [];
  out.waitingRegistrationsOfThisProof = regs.filter(r => /SCRUM-857/.test(r.guardianName ?? '')).map(r => r.id);
  const board = (await get(`/checkin/board?branchId=${branch.id}`)).body;
  out.boardChildrenOfThisProof = (board?.families ?? []).flatMap(f => f.children).filter(c => /SCRUM-857/.test(c.childName ?? '')).map(c => ({ id: c.id, status: c.status }));
  const used = [10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 60, 61].map(n => '08985701' + n);
  out.membersOnUsedNumbers = [];
  for (const n of used) { const m = (await get(`/members/lookup?phone=${n}`)).body?.member; if (m) out.membersOnUsedNumbers.push({ n, id: m.id }); }
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminMeAfterSignOut = (await admin.get('/api/me')).status();
  await admin.dispose();
  out.readAt = new Date().toISOString();
  console.log(JSON.stringify(out, null, 1));
}
