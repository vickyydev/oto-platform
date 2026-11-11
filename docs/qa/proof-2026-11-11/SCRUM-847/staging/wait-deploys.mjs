// Poll two Render deploys by id; one request per 90 s per deploy. Never prints the key.
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { need } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs'));
const headers = { authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json' };
const get = async path => {
  const r = await fetch('https://api.render.com/v1' + path, { headers, signal: AbortSignal.timeout(90000) });
  if (!r.ok) return { _status: r.status };
  return r.json();
};
const want = { 'oto-pos-staging': 'dep-dbq99ctg1s2s7380osu0', 'oto-pos-web-staging': 'dep-dbq99dajnfac73d8eu8g' };
const services = (await get('/services?limit=50')).map(r => r.service ?? r);
const ids = {};
for (const name of Object.keys(want)) { const s = services.find(x => x.name === name); if (!s) throw new Error('no service ' + name); ids[name] = s.id; }
console.log('services', JSON.stringify(ids));
const state = {};
const out = resolve(import.meta.dirname, 'deploys.json');
const terminalBad = ['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed', 'deactivated'];
for (let round = 0; round < 30; round += 1) {
  for (const [name, dep] of Object.entries(want)) {
    if (state[name]?.status === 'live') continue;
    try {
      const d = await get(`/services/${ids[name]}/deploys/${dep}`);
      state[name] = d._status ? { httpStatus: d._status } : { id: d.id, status: d.status, sha: d.commit?.id, createdAt: d.createdAt, finishedAt: d.finishedAt, readAt: new Date().toISOString() };
    } catch (e) { state[name] = { ...(state[name] ?? {}), readError: e.name }; }
    console.log(new Date().toISOString(), name, JSON.stringify(state[name]));
  }
  writeFileSync(out, JSON.stringify({ ids, state }, null, 2) + '\n');
  const all = Object.keys(want).map(n => state[n]?.status);
  if (all.some(s => terminalBad.includes(s))) { console.log('FAILED'); process.exit(2); }
  if (all.every(s => s === 'live')) { console.log('ALL LIVE'); process.exit(0); }
  await new Promise(r => setTimeout(r, 90000));
}
console.log('TIMEOUT'); process.exit(3);
