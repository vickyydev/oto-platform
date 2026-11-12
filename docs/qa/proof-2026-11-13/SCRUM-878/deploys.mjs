// Read the three SCRUM-878 session-end lane deploys by id (each service's serving deploy beside it). Staging only;
// read, never changed. Never prints the key.
//   node deploys.mjs [out.json]
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { need } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs'));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
// The deploys triggered 00:56 Bangkok, 13 Nov, at f0a47eb79.
const want = { 'oto-api-staging': 'dep-dbqvrloae00c73bf4da0', 'oto-pos-web-staging': 'dep-dbqvrm08v5cc73ebl5rg', 'oto-pos-staging': 'dep-dbqvrmjl550s73dv35mg' };
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
const state = {};
for (const [name, dep] of Object.entries(want)) {
  const s = services.find(x => x.name === name);
  const latest = (await get(`/services/${s.id}/deploys?limit=1`))[0]?.deploy;
  const d = await get(`/services/${s.id}/deploys/${dep}`);
  state[name] = { named: { id: d.id, status: d.status, sha: d.commit?.id, createdAt: d.createdAt, finishedAt: d.finishedAt },
    serving: { id: latest?.id, status: latest?.status, sha: latest?.commit?.id, createdAt: latest?.createdAt, finishedAt: latest?.finishedAt }, readAt: new Date().toISOString() };
}
writeFileSync(resolve(import.meta.dirname, process.argv[2] ?? 'deploys.json'), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(state, null, 1));
