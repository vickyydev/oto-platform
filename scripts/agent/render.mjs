// Render staging helpers. The dashboard/API settings are what runs;
// render.yaml only documents them.
//
// node scripts/agent/render.mjs status              latest deploy of every staging service
// node scripts/agent/render.mjs deploys <name>      recent deploys of one service (e.g. oto-api-staging)
// node scripts/agent/render.mjs deploy <name|all> [sha]  trigger a deploy (staging does not follow main by itself)
// node scripts/agent/render.mjs job "<command>"     one-off job on oto-api-staging, waits, prints its logs
//
// One-off job commands run from the repo root on the api image: use
// `cd apps/api && node -e "<one-line JS>"` (pg resolves there), schema `core`
// for branches, no shell `$` expansions, no newlines in the JS.
import { need } from './env.mjs';

const API = 'https://api.render.com/v1';
const headers = () => ({ authorization: `Bearer ${need('RENDER_API_KEY')}`, accept: 'application/json', 'content-type': 'application/json' });
export const render = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _status: r.status, _body: t.slice(0, 400) };
  }
};

export const stagingServices = async () =>
  (await render('GET', '/services?limit=50')).map((row) => row.service ?? row).filter((s) => /staging/.test(s.name));

export const service = async (name) => (await stagingServices()).find((s) => s.name === name);

async function status() {
  for (const s of await stagingServices()) {
    const d = await render('GET', `/services/${s.id}/deploys?limit=1`);
    const dep = d[0]?.deploy;
    console.log(s.name.padEnd(26), (dep?.status ?? '?').padEnd(14), (dep?.commit?.id ?? '').slice(0, 8).padEnd(9), (dep?.commit?.message ?? '').split('\n')[0].slice(0, 50));
  }
}

async function deploys(name) {
  const s = await service(name);
  if (!s) throw new Error(`no staging service named ${name}`);
  for (const row of await render('GET', `/services/${s.id}/deploys?limit=8`)) {
    const d = row.deploy;
    console.log(d.id, d.status.padEnd(14), (d.commit?.id ?? '').slice(0, 8), d.finishedAt ?? d.createdAt);
  }
}

async function deploy(name, sha) {
  const names = name === 'all' ? ['oto-api-staging', 'oto-pos-staging', 'oto-console-staging', 'oto-launcher-staging', 'oto-booth-staging'] : [name];
  for (const n of names) {
    const s = await service(n);
    if (!s) throw new Error(`no staging service named ${n}`);
    const d = await render('POST', `/services/${s.id}/deploys`, sha ? { commitId: sha } : {});
    console.log(n, d.id ?? JSON.stringify(d).slice(0, 200), d.status ?? '');
  }
}

async function job(cmd) {
  const s = await service('oto-api-staging');
  const j = await render('POST', `/services/${s.id}/jobs`, { startCommand: cmd });
  if (!j.id) throw new Error(`job not created: ${JSON.stringify(j).slice(0, 300)}`);
  let cur = j;
  for (let i = 0; i < 60 && !['succeeded', 'failed', 'canceled'].includes(cur.status); i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    cur = await render('GET', `/services/${s.id}/jobs/${j.id}`);
  }
  console.log('job', j.id, cur.status);
  const start = new Date(Date.now() - 15 * 60_000).toISOString();
  const qs = new URLSearchParams({ ownerId: s.ownerId, resource: j.id, startTime: start, limit: '100', direction: 'forward' });
  const logs = await render('GET', `/logs?${qs}`);
  for (const l of logs.logs ?? []) console.log(l.message);
}

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1]?.endsWith('render.mjs')) {
  if (cmd === 'status') await status();
  else if (cmd === 'deploys') await deploys(rest[0]);
  else if (cmd === 'deploy') await deploy(rest[0], rest[1]);
  else if (cmd === 'job') await job(rest.join(' '));
  else if (cmd) console.log('commands: status | deploys <name> | deploy <name|all> [sha] | job "<command>"');
}
