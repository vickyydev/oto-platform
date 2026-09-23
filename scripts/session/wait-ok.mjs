/**
 * Same as render-wait.mjs but "beacb6d or later": any sha in the accepted list
 * counts, because the CI queue may roll past the target to a newer push.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const H = { authorization: `Bearer ${process.env.RENDER_API_KEY}`, accept: 'application/json' };
const WANT = ['oto-api-staging', 'oto-pos-staging', 'oto-console-staging'];
const OK = new Set(process.argv.slice(2));
const svcs = (await (await fetch('https://api.render.com/v1/services?limit=50', { headers: H })).json())
  .map((r) => r.service ?? r)
  .filter((s) => WANT.includes(s.name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = Date.now() + 40 * 60_000;
for (;;) {
  const rows = [];
  for (const s of svcs) {
    const d = await (
      await fetch(`https://api.render.com/v1/services/${s.id}/deploys?limit=6`, { headers: H })
    ).json();
    const deploys = d.map((x) => x.deploy ?? x);
    const latest = deploys[0];
    const liveOk = deploys.find((dep) => dep.status === 'live' && OK.has((dep.commit?.id ?? '').slice(0, 7)));
    rows.push({
      name: s.name,
      status: latest?.status,
      sha: (latest?.commit?.id ?? '').slice(0, 7),
      ok: Boolean(liveOk),
      okSha: (liveOk?.commit?.id ?? '').slice(0, 7),
    });
  }
  console.log(
    new Date().toTimeString().slice(0, 8),
    rows.map((r) => `${r.name}=${r.status}@${r.sha}${r.ok ? ` [ok:${r.okSha}]` : ''}`).join('  '),
  );
  if (rows.every((r) => r.ok)) {
    console.log('ALL LIVE ON AN ACCEPTED COMMIT');
    break;
  }
  if (Date.now() > DEADLINE) {
    console.log('TIMED OUT WAITING');
    break;
  }
  await sleep(30_000);
}
