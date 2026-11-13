// Read which commit each of the three staging services of the SCRUM-963 display-fix lane is live at (the serving
// deploy: the newest one whose status is "live"), and the newest deploy beside it. Staging only; read, never changed.
// Never prints the key.
//   node deploys.mjs <start|end>      writes deploys-<start|end>.json beside this file
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { need } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs'));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
const names = ['oto-pos-web-staging', 'oto-pos-staging', 'oto-api-staging'];
const services = (await get('/services?limit=50')).map(r => r.service ?? r).filter(s => /-staging$/.test(s.name));
const state = { readAt: new Date().toISOString(), lane: '92d8e3977b0c8f9b8761558190f8a2ce8724ab85' };
for (const name of names) {
  const s = services.find(x => x.name === name);
  if (!s) { state[name] = { error: 'not found' }; continue; }
  const rows = (await get(`/services/${s.id}/deploys?limit=10`)).map(r => r.deploy ?? r);
  const live = rows.find(d => d.status === 'live');
  const newest = rows[0];
  const pick = d => d ? { id: d.id, status: d.status, sha: d.commit?.id ?? null, createdAt: d.createdAt, finishedAt: d.finishedAt } : null;
  state[name] = { live: pick(live), newest: pick(newest) };
}
const which = process.argv[2] ?? 'start';
writeFileSync(resolve(import.meta.dirname, `deploys-${which}.json`), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify(state, null, 1));
