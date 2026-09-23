import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json' };
// Every service that builds from the repository root and so deploys on every
// green push. The OTO App (rootDir apps/oto-app) deploys only when its own
// files change, so it is not expected on the target sha and is left out —
// the launcher sat three days stale unnoticed while this list held three.
const WANT = ['oto-api-staging', 'oto-pos-staging', 'oto-console-staging', 'oto-launcher-staging', 'oto-booth-staging'];
const TARGET = process.argv[2];
const svcs = (await (await fetch('https://api.render.com/v1/services?limit=50', { headers: H })).json())
  .map((r) => r.service ?? r)
  .filter((s) => WANT.includes(s.name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = Date.now() + 15 * 60_000;
for (;;) {
  const rows = [];
  for (const s of svcs) {
    const d = await (await fetch(`https://api.render.com/v1/services/${s.id}/deploys?limit=1`, { headers: H })).json();
    const dep = d[0]?.deploy;
    rows.push({ name: s.name, status: dep?.status, sha: (dep?.commit?.id ?? '').slice(0, 7) });
  }
  console.log(rows.map((r) => `${r.name}=${r.status}@${r.sha}`).join('  '));
  const onTarget = rows.filter((r) => r.sha === TARGET);
  if (onTarget.length === rows.length && onTarget.every((r) => r.status === 'live')) {
    console.log('ALL LIVE ON', TARGET);
    break;
  }
  if (rows.some((r) => /failed|canceled/.test(r.status ?? ''))) {
    console.log('A DEPLOY FAILED');
    break;
  }
  if (Date.now() > DEADLINE) { console.log('TIMED OUT WAITING'); break; }
  await sleep(30_000);
}
