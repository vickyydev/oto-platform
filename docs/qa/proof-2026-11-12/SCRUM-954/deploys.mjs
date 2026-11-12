// Read the two SCRUM-954 / 956 / 953 small-points lane deploys by id (each service's serving deploy beside it), and the
// api's serving deploy (no api change in this lane). Staging only; read, never changed. Never prints the key.
//   node deploys.mjs [out.json]
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { need } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs'));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
// The deploys of 23:58 Bangkok, 12 Nov, at e4989a0d6.
const want = { 'oto-pos-web-staging': 'dep-dbqv06ei0phs738luh7g', 'oto-pos-staging': 'dep-dbqv06rl550s73dsgssg', 'oto-api-staging': null };
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
const state = {};
for (const [name, dep] of Object.entries(want)) {
  const s = services.find(x => x.name === name);
  const latest = (await get(`/services/${s.id}/deploys?limit=1`))[0]?.deploy;
  const d = dep ? await get(`/services/${s.id}/deploys/${dep}`) : null;
  state[name] = { named: d ? { id: d.id, status: d.status, sha: d.commit?.id, createdAt: d.createdAt, finishedAt: d.finishedAt } : null,
    serving: { id: latest?.id, status: latest?.status, sha: latest?.commit?.id, createdAt: latest?.createdAt, finishedAt: latest?.finishedAt }, readAt: new Date().toISOString() };
}
writeFileSync(resolve(import.meta.dirname, process.argv[2] ?? 'deploys.json'), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(state, null, 1));
