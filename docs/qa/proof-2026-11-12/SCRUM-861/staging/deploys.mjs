// Read the four SCRUM-861 deploys by id and what each staging service serves now. Never prints the key.
//   node deploys.mjs [out.json]
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
const want = {
  'oto-api-staging': 'dep-dbqk5ojrjlhs738i12f0',
  'oto-pos-staging': 'dep-dbqk5pdg1s2s73ej596g',
  'oto-pos-web-staging': 'dep-dbqk5r5g1s2s73ej5e5g',
  'oto-console-staging': 'dep-dbqk5sgae00c738l7njg',
};
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
const state = {};
for (const [name, dep] of Object.entries(want)) {
  const s = services.find(x => x.name === name);
  const d = await get(`/services/${s.id}/deploys/${dep}`);
  const list = (await get(`/services/${s.id}/deploys?limit=5`)).map(x => x.deploy ?? x);
  const live = list.find(x => x.status === 'live');
  state[name] = { named: { id: d.id, status: d.status, sha: d.commit?.id, createdAt: d.createdAt, finishedAt: d.finishedAt },
    live: live ? { id: live.id, sha: live.commit?.id, createdAt: live.createdAt, finishedAt: live.finishedAt } : null,
    latest: list[0] ? { id: list[0].id, status: list[0].status, sha: list[0].commit?.id } : null, readAt: new Date().toISOString() };
}
writeFileSync(resolve(import.meta.dirname, process.argv[2] ?? 'deploys.json'), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(state, null, 1));
