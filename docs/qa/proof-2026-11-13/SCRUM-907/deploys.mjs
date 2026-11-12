// READ-ONLY. The four *-staging deploys of the SCRUM-907 / 950 / 951 lane and what each serves now.
// Never prints the key; reads only services whose name ends in -staging.  node deploys.mjs <out.json> [tag]
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async (path) => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
const names = ['oto-app-staging', 'oto-api-staging', 'oto-pos-web-staging', 'oto-pos-staging'];
const expected = { 'oto-app-staging': 'dep-dbr05sh5efls73e0fc20', 'oto-api-staging': 'dep-dbr07guk1f9s73atllu0', 'oto-pos-web-staging': 'dep-dbr0a756e07s738o2kh0', 'oto-pos-staging': 'dep-dbr0a7l6e07s738o2ld0' };
const services = (await get('/services?limit=50')).map((r) => r.service ?? r).filter((s) => /-staging$/.test(s.name));
const out = process.argv[2];
const tag = process.argv[3] ?? 'read';
const state = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const bkk = (d) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(d)) : null);
const snap = { readAt: new Date().toISOString(), lane: 'b229f96e2771e2100a1075766d479edaa9f48bd2', services: {} };
for (const name of names) {
  const s = services.find((x) => x.name === name);
  if (!s) { snap.services[name] = null; continue; }
  const list = (await get(`/services/${s.id}/deploys?limit=5`)).map((x) => x.deploy ?? x);
  const live = list.find((x) => x.status === 'live');
  snap.services[name] = {
    expectedDeploy: expected[name],
    live: live ? { id: live.id, sha: live.commit?.id, finishedAt: live.finishedAt, finishedBangkok: bkk(live.finishedAt), trigger: live.trigger ?? null } : null,
    liveIsExpected: live?.id === expected[name],
    liveIsLaneSha: (live?.commit?.id ?? '').startsWith('b229f96e'),
    latest: list[0] ? { id: list[0].id, status: list[0].status, sha: list[0].commit?.id } : null,
  };
}
state[tag] = snap;
writeFileSync(out, JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(snap, null, 1));
