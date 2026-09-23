import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json' };
const projects = (await (await fetch('https://api.render.com/v1/projects?limit=20', { headers: H })).json()).map((r) => r.project ?? r);
for (const p of projects) {
  console.log('project', p.id, p.name, 'environments:', (p.environmentIds ?? []).join(','));
  for (const eid of p.environmentIds ?? []) {
    const e = await (await fetch(`https://api.render.com/v1/environments/${eid}`, { headers: H })).json();
    const env = e.environment ?? e;
    console.log('  env', env.id, env.name, 'services:', (env.serviceIds ?? []).length, 'dbs:', (env.databaseIds ?? []).length);
  }
}
const svcs = (await (await fetch('https://api.render.com/v1/services?limit=50', { headers: H })).json()).map((r) => r.service ?? r);
for (const s of svcs.filter((s) => /staging/.test(s.name))) console.log('service', s.id, s.name, 'environmentId:', s.environmentId ?? '(none)');
