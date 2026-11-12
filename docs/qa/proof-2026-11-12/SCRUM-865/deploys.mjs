// Read the three deploys (api, till, till web) by id and what each staging service serves now. Never prints the key.
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
const want = { 'oto-api-staging': 'dep-dbqiorgae00c738h8rl0', 'oto-pos-staging': 'dep-dbqiosdbedkc73dodch0', 'oto-pos-web-staging': 'dep-dbqiosui0phs73cq99mg' };
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
const state = {};
for (const [name, dep] of Object.entries(want)) {
  const s = services.find(x => x.name === name);
  const d = dep ? await get(`/services/${s.id}/deploys/${dep}`) : null;
  const list = (await get(`/services/${s.id}/deploys?limit=5`)).map(x => x.deploy ?? x);
  const live = list.find(x => x.status === 'live');
  state[name] = { ...(d ? { named: { id: d.id, status: d.status, sha: d.commit?.id, createdAt: d.createdAt, finishedAt: d.finishedAt } } : {}),
    live: live ? { id: live.id, sha: live.commit?.id, createdAt: live.createdAt, finishedAt: live.finishedAt } : null,
    latest: list[0] ? { id: list[0].id, status: list[0].status, sha: list[0].commit?.id } : null, readAt: new Date().toISOString() };
}
writeFileSync(resolve(process.cwd(), process.argv[2] ?? 'deploys.json'), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(state, null, 1));
