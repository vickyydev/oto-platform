// Read the three SCRUM-929 deploys by id (each service's serving deploy beside it). Never prints the key.
//   node deploys.mjs [out.json]
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { need } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs'));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
// The deploys of 18:38 Bangkok at 8e7f7d315 (the api's pre-deploy applies 0122, edge.station_session.theme).
const want = { 'oto-api-staging': 'dep-dbqqaeijnfac739er580', 'oto-pos-staging': 'dep-dbqqafbtqb8s73bo3cg0', 'oto-pos-web-staging': 'dep-dbqqaeqjnfac739er7gg' };
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
