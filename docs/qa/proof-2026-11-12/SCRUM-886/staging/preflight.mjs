// Read-only preflight for SCRUM-886 on staging: the board's Upcoming families, classified.
// Prints ZZ TEST names only; a family that is not ZZ TEST is counted, never named. No secret printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const pos = 'https://oto-pos-web-staging.onrender.com';
const admin = await request.newContext({ baseURL: pos });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const zzName = s => /^ZZ TEST/.test(String(s ?? '').trim());
const out = { readAt: new Date().toISOString() };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branches = (await get('/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  out.branch = branch.id;
  const board = (await get(`/checkin/board?branchId=${branch.id}`)).body;
  out.counts = board.counts;
  out.newApi = { familiesWithCheckedInChildNames: board.families.filter(f => Array.isArray(f.checkedInChildNames)).length, families: board.families.length,
    waitingChildrenWithBookedForKey: board.families.flatMap(f => f.children).filter(c => c.status === 'registered' && 'bookedForDate' in c).length,
    waitingChildren: board.families.flatMap(f => f.children).filter(c => c.status === 'registered').length };
  const dayOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(iso));
  out.today = dayOf(new Date().toISOString());
  const upcoming = board.families.filter(f => f.children.some(c => c.status === 'registered'));
  out.upcomingFamilies = upcoming.length;
  out.upcomingChildren = upcoming.flatMap(f => f.children).filter(c => c.status === 'registered').length;
  const rows = upcoming.map(f => {
    const waiting = f.children.filter(c => c.status === 'registered');
    const zz = zzName(f.guardianName) && f.children.every(c => zzName(c.childName)) && (f.checkedInChildNames ?? []).every(zzName);
    const days = [...new Set(waiting.map(c => c.bookedForDate ?? null))];
    return {
      zz, registrationId: zz ? f.registrationId : undefined, guardian: zz ? f.guardianName : undefined, children: zz ? f.children.map(c => `${c.childName}:${c.status}`) : undefined,
      tab: f.tab, source: f.source, createdDay: dayOf(f.createdAt), waiting: waiting.length, bookedFor: days,
      earlier: waiting.every(c => c.bookedForDate && c.bookedForDate < out.today), later: waiting.some(c => c.bookedForDate && c.bookedForDate > out.today), today: waiting.some(c => !c.bookedForDate),
      paid: waiting.filter(c => c.paidOnline || c.paidAtTill).length, inParkSibling: f.children.some(c => c.status === 'in_park'), checkedIn: (f.checkedInChildNames ?? []).length,
    };
  });
  out.zzFamilies = rows.filter(r => r.zz);
  out.nonZz = rows.filter(r => !r.zz).map(({ zz, registrationId, guardian, children, ...rest }) => rest);
  out.summary = { zzFamilies: out.zzFamilies.length, zzWaitingChildren: out.zzFamilies.reduce((n, r) => n + r.waiting, 0),
    nonZzFamilies: out.nonZz.length, nonZzWaitingChildren: out.nonZz.reduce((n, r) => n + r.waiting, 0),
    zzEarlierUnpaidNoCheckedIn: out.zzFamilies.filter(r => r.earlier && r.paid === 0 && r.checkedIn === 0 && !r.inParkSibling).length };
  for (let n = 10; n <= 30; n += 1) {
    const phone = '08988600' + n;
    const r = await get(`/members/lookup?phone=${encodeURIComponent(phone)}`);
    (out.numbers ??= {})[phone] = r.body?.member === null ? 'unused' : 'TAKEN';
  }
  const stations = (await get(`/branches/${branch.id}/stations?includeArchived=true`)).body.stations;
  out.activeZzTills = stations.filter(s => !s.archived && /ZZ TEST/.test(s.name)).map(s => s.name);
  out.prefixesZ886 = stations.filter(s => /^Z886/.test(s.codePrefix ?? '')).map(s => s.codePrefix);
} finally {
  const o = await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.signOut = o.status(); out.me = (await admin.get('/api/me')).status();
  await admin.dispose();
}
writeFileSync(resolve(import.meta.dirname, process.argv[2] ?? 'preflight.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
