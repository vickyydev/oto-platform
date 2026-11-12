// Read the four SCRUM-898/899/900 deploys by id and what each staging service serves now. Never prints the key.
// Read-only: it only lists deploys of the *-staging services.
//   node deploys.mjs [out.json]          the four deploys named below, and what each service serves now
//   node deploys.mjs <out.json> live     only what each service serves now (used after the 16:00 interruption)
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
const SHA = '7cb06ac6c81407e7673645920b29baec058bcbf8';
const want = {
  'oto-api-staging': 'dep-dbqnj10n74is73co4us0',
  'oto-console-staging': 'dep-dbqnj1bbc2fs73dttgmg',
  'oto-pos-staging': 'dep-dbqnj1t6e07s73fouq4g',
  'oto-pos-web-staging': 'dep-dbqnj2c9v7es73d55b00',
};
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
if (process.argv[3] === 'live') {
  const now = {};
  for (const name of Object.keys(want)) {
    const s = services.find(x => x.name === name);
    const list = (await get(`/services/${s.id}/deploys?limit=5`)).map(x => x.deploy ?? x);
    const live = list.find(x => x.status === 'live');
    now[name] = { live: live ? { id: live.id, sha: live.commit?.id, finishedAt: live.finishedAt } : null, latest: { id: list[0].id, status: list[0].status, sha: list[0].commit?.id }, readAt: new Date().toISOString() };
  }
  writeFileSync(resolve(import.meta.dirname, process.argv[2]), JSON.stringify(now, null, 2) + '\n');
  console.log(Object.entries(now).map(([k, v]) => `${k.padEnd(22)} live ${v.live?.id} ${v.live?.sha?.slice(0, 9)} ${v.live?.finishedAt}`).join('\n'));
  process.exit(0);
}
const state = {};
for (const [name, dep] of Object.entries(want)) {
  if (!/-staging$/.test(name)) throw new Error('staging only');
  const s = services.find(x => x.name === name);
  const d = await get(`/services/${s.id}/deploys/${dep}`);
  const list = (await get(`/services/${s.id}/deploys?limit=5`)).map(x => x.deploy ?? x);
  const live = list.find(x => x.status === 'live');
  state[name] = { named: { id: d.id, status: d.status, sha: d.commit?.id, atLandedCommit: d.commit?.id === SHA, createdAt: d.createdAt, finishedAt: d.finishedAt },
    live: live ? { id: live.id, sha: live.commit?.id, createdAt: live.createdAt, finishedAt: live.finishedAt } : null,
    latest: list[0] ? { id: list[0].id, status: list[0].status, sha: list[0].commit?.id } : null, readAt: new Date().toISOString() };
}
state.allLiveAtLandedCommit = Object.values(state).every(v => v.named?.status === 'live' && v.named?.sha === SHA && v.live?.id === v.named.id);
writeFileSync(resolve(import.meta.dirname, process.argv[2] ?? 'deploys.json'), JSON.stringify(state, null, 2) + '\n');
console.log(Object.entries(state).map(([k, v]) => typeof v === 'boolean' ? `${k}: ${v}` : `${k.padEnd(22)} ${v.named.status} ${v.named.sha?.slice(0, 9)} live=${v.live?.id === v.named.id}`).join('\n'));
