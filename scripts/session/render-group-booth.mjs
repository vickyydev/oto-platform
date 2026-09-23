import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
// This script CHANGES Render configuration. It is inert without --apply so that
// a bare run (or a stray shell-history recall) cannot silently re-patch staging.
if (!process.argv.includes('--apply')) {
  console.log('render-group-booth.mjs: read-only guard. Re-run with --apply to change Render.');
  process.exit(0);
}
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json', 'content-type': 'application/json' };
const ENV = 'evm-danh1brtqb8s73bt5pk0'; // OTO Platform → staging
const r = await fetch(`https://api.render.com/v1/environments/${ENV}/resources`, { method: 'POST', headers: H, body: JSON.stringify({ resourceIds: ['srv-dapkbobtqb8s73delilg'] }) });
console.log('add-resources', r.status, (await r.text()).slice(0, 200));
const e = await (await fetch(`https://api.render.com/v1/environments/${ENV}`, { headers: H })).json();
const env = e.environment ?? e;
console.log('staging environment now holds', (env.serviceIds ?? []).length, 'services; booth included:', (env.serviceIds ?? []).includes('srv-dapkbobtqb8s73delilg'));
const s = await (await fetch('https://api.render.com/v1/services/srv-dapkbobtqb8s73delilg', { headers: H })).json();
console.log('oto-booth-staging environmentId:', (s.service ?? s).environmentId ?? '(none)');
