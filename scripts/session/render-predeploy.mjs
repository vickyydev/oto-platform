import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
// This script CHANGES Render configuration. It is inert without --apply so that
// a bare run (or a stray shell-history recall) cannot silently re-patch staging.
if (!process.argv.includes('--apply')) {
  console.log('render-predeploy.mjs: read-only guard. Re-run with --apply to change Render.');
  process.exit(0);
}
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json', 'content-type': 'application/json' };
const id = 'srv-danh2ljtqb8s73bt9en0';
const r = await fetch(`https://api.render.com/v1/services/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ serviceDetails: { preDeployCommand: 'pnpm db:migrate && pnpm db:platform-sync' } }) });
console.log('PATCH', r.status);
const s = await (await fetch(`https://api.render.com/v1/services/${id}`, { headers: H })).json();
console.log('now pre:', s.serviceDetails?.preDeployCommand, '| autoDeploy:', s.autoDeploy, s.serviceDetails?.autoDeployTrigger ?? '');
