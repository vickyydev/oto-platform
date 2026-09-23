import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json' };
const svcs = (await (await fetch('https://api.render.com/v1/services?limit=50', { headers: H })).json()).map((r) => r.service ?? r);
const api = svcs.find((s) => s.name === 'oto-api-staging');
const vars = (await (await fetch(`https://api.render.com/v1/services/${api.id}/env-vars?limit=100`, { headers: H })).json()).map((r) => r.envVar ?? r);
console.log('api service', api.id);
console.log('env var NAMES:', vars.map((v) => v.key).sort().join(' '));
const sp = vars.find((v) => v.key === 'SEED_PROFILE');
console.log('SEED_PROFILE:', sp ? sp.value : '(not set)');
