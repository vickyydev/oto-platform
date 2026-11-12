// Read-only: what the SCRUM-886 proof runs left on staging, and the board's Upcoming list after them.
// Families that are not ZZ TEST are counted, never named; no number but the run's own ZZ TEST ones is printed. No secret printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(repo + '/scripts/agent/env.mjs'));
const { request } = createRequire(repo + '/apps/pos/package.json')('@playwright/test');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const get = async path => { const r = await admin.get('/api' + path); return { status: r.status(), body: await r.json().catch(() => null) }; };
const isZz = s => /^ZZ TEST/.test(String(s ?? '').trim());
const here = import.meta.dirname;
const out = { readAt: new Date().toISOString() };
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const branch = '01a0bbdc-8c42-7753-b7e3-5ae19fb66d33';
  const board = (await get(`/checkin/board?branchId=${branch}`)).body;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const upcoming = board.families.filter(f => f.children.some(c => c.status === 'registered'));
  const allZz = f => isZz(f.guardianName) && f.children.every(c => isZz(c.childName)) && (f.checkedInChildNames ?? []).every(isZz);
  const row = f => { const w = f.children.filter(c => c.status === 'registered'); return { waiting: w.length, paid: w.filter(c => c.paidOnline || c.paidAtTill).length, checkedInOrCollected: (f.checkedInChildNames ?? []).length, bookedFor: [...new Set(w.map(c => c.bookedForDate ?? 'today'))] }; };
  out.board = { today, counts: board.counts, upcomingFamilies: upcoming.length,
    zz: upcoming.filter(allZz).map(f => ({ guardian: f.guardianName, children: f.children.filter(c => c.status === 'registered').map(c => c.childName), ...row(f) })),
    notZz: upcoming.filter(f => !allZz(f)).map(row) };
  out.board.zzEarlierDayStillCancellable = upcoming.filter(f => allZz(f)).filter(f => { const r = row(f); return r.paid === 0 && r.checkedInOrCollected === 0 && !f.children.some(c => c.status === 'in_park') && r.bookedFor.every(d => d !== 'today' && d < today); }).length;
  const stations = (await get(`/branches/${branch}/stations?includeArchived=true`)).body.stations.filter(s => /^ZZ TEST SCRUM-886 proof till/.test(s.name));
  out.tills = [];
  for (const st of stations) {
    const sales = (await get(`/sales?branchId=${branch}&stationId=${st.id}&limit=50`)).body.sales;
    out.tills.push({ prefix: st.codePrefix, archived: Boolean(st.archived), devices: st.devices.length, sales: sales.map(s => `${s.status} ${s.totals.grossSatang / 100}`) });
  }
  out.ownBookings = [];
  for (const [run, file] of [['03', 'receipt-run-03.json'], ['04', 'receipt-run-04-retake.json']]) {
    // Beside this file in the repo; out-NN/receipt.json in the scratch folder the runs wrote.
    const path = existsSync(resolve(here, file)) ? resolve(here, file) : resolve(here, `out-${run}/receipt.json`);
    const r = JSON.parse(readFileSync(path, 'utf8'));
    for (const reg of r.created.filter(c => c.kind === 'registration')) {
      const g = (await get('/checkin/registrations/' + reg.id)).body;
      out.ownBookings.push({ run, tag: reg.tag, guardian: g.guardianName, children: g.children.map(c => c.status) });
    }
  }
  out.numbers = {};
  for (let n = 10; n <= 18; n++) { const phone = '08988600' + n; out.numbers[phone] = (await get(`/members/lookup?phone=${phone}`)).body?.member ? 'LIVE MEMBER' : 'none'; }
} finally {
  await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } });
  out.adminMe = (await admin.get('/api/me')).status();
  await admin.dispose();
}
writeFileSync(resolve(here, 'leftovers.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
