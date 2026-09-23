import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json' };
const svcs = (await (await fetch('https://api.render.com/v1/services?limit=50', { headers: H })).json()).map((r) => r.service ?? r).filter((s) => /staging/.test(s.name));
for (const s of svcs) {
  const ds = (await (await fetch(`https://api.render.com/v1/services/${s.id}/deploys?limit=4`, { headers: H })).json()).map((r) => r.deploy ?? r);
  console.log(s.name.padEnd(24), 'autoDeploy=' + (s.autoDeploy ?? s.serviceDetails?.autoDeploy ?? '?'));
  for (const d of ds) console.log('   ', (d.commit?.id ?? '').slice(0, 7), d.status.padEnd(14), (d.createdAt ?? '').slice(0, 16), (d.commit?.message ?? '').split('\n')[0].slice(0, 50));
}
