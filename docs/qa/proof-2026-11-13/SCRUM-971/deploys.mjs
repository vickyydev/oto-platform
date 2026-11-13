// SCRUM-971 staging proof: what each staging service the proof touches is live at. Never prints the key.
// Read-only: it only lists deploys of the *-staging services named below (copied from the SCRUM-952 proof).
//   node deploys.mjs <out.json>
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => { const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : { _status: r.status }; };
const LANDED = '1b9885a321ff7799ba122caa2a0adff30aa99807';
const names = ['oto-api-staging', 'oto-console-staging', 'oto-pos-web-staging'];
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
const now = { landedCommit: LANDED };
for (const name of names) {
  if (!/-staging$/.test(name)) throw new Error('staging only');
  const s = services.find(x => x.name === name);
  const list = (await get(`/services/${s.id}/deploys?limit=5`)).map(x => x.deploy ?? x);
  const live = list.find(x => x.status === 'live');
  now[name] = { live: live ? { id: live.id, sha: live.commit?.id, createdAt: live.createdAt, finishedAt: live.finishedAt } : null,
    latest: list[0] ? { id: list[0].id, status: list[0].status, sha: list[0].commit?.id } : null, readAt: new Date().toISOString() };
}
writeFileSync(resolve(import.meta.dirname, process.argv[2] ?? 'deploys.json'), JSON.stringify(now, null, 2) + '\n');
console.log(names.map(k => `${k.padEnd(22)} live ${now[k].live?.id} ${now[k].live?.sha?.slice(0, 9)} ${now[k].live?.finishedAt} latest=${now[k].latest?.status} ${now[k].latest?.sha?.slice(0, 9)}`).join('\n'));
