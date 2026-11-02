// Render staging helpers. The dashboard/API settings are what runs;
// render.yaml only documents them.
//
// node scripts/agent/render.mjs status              latest deploy of every staging service
// node scripts/agent/render.mjs deploys <name>      recent deploys of one service (e.g. oto-api-staging)
// node scripts/agent/render.mjs deploy <name|all> [sha]  trigger a specific-source deploy
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
  // The old static POS remains available by its explicit service name for
  // rollback. Normal suite operations use the staging web service (SCRUM-725).
  const names = name === 'all' ? ['oto-api-staging', 'oto-pos-web-staging', 'oto-console-staging', 'oto-launcher-staging', 'oto-booth-staging'] : [name];
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

/**
 * One env var's value, whatever shape the API answers with. The flat and the
 * wrapped shapes both occur, and mistaking one for the other once emptied
 * HANDOFF_APP_ORIGINS on staging (2026-10-14) — every read goes through here.
 */
export const envValue = async (serviceId, key) => {
  const r = await render('GET', `/services/${serviceId}/env-vars/${key}`);
  return r?.envVar?.value ?? r?.value ?? null;
};

/**
 * Append to a comma-list env var, refusing the write when the current value
 * cannot be read: an append that starts from '' silently REPLACES the list,
 * which is how the launcher lost one sign-on for every app.
 */
export const appendEnvList = async (serviceId, key, entry) => {
  const old = await envValue(serviceId, key);
  if (old === null || old === '') throw new Error(`${key}: current value unreadable or empty — refusing to append`);
  if (old.includes(entry)) return { key, unchanged: true };
  return render('PUT', `/services/${serviceId}/env-vars/${key}`, { value: `${old},${entry}` });
};

/**
 * SCRUM-725: replace the single POS hand-off destination, including rollback.
 * Every other entry and separator keeps its exact bytes. Refuse unreadable,
 * empty, duplicate or unexpected input; never use Render's bulk env endpoint.
 * The caller separately checks every service setting and redeploys the same SHA.
 */
export const replacePosHandoffOrigin = async (serviceId, expectedOrigin, nextOrigin) => {
  for (const origin of [expectedOrigin, nextOrigin]) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('POS hand-off needs an HTTPS origin'); }
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('POS hand-off needs an HTTPS origin');
  }
  const key = 'HANDOFF_APP_ORIGINS';
  const old = await envValue(serviceId, key);
  if (typeof old !== 'string' || old.trim() === '') throw new Error(`${key}: current value unreadable or empty`);
  const entries = old.split(',');
  const positions = entries.flatMap((entry, index) => entry.trim().startsWith('pos=') ? [index] : []);
  if (positions.length !== 1) throw new Error(`${key}: exactly one pos entry is required`);
  const index = positions[0];
  if (entries[index].trim() !== `pos=${expectedOrigin}`) throw new Error(`${key}: POS destination changed; refusing replacement`);
  if (expectedOrigin === nextOrigin) return { key, unchanged: true };
  entries[index] = entries[index].replace(expectedOrigin, nextOrigin);
  const next = entries.join(',');
  await render('PUT', `/services/${serviceId}/env-vars/${key}`, { value: next });
  if (await envValue(serviceId, key) !== next) throw new Error(`${key}: replacement read-back did not match`);
  return { key, unchanged: false, otherEntriesPreserved: true };
};
