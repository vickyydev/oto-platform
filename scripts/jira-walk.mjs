#!/usr/bin/env node
/**
 * Move Jira tickets along the board — and REFUSE to move one to Deployed
 * without a screenshot on it.
 *
 * The board's order is To Do → In Progress → Testing → Deployed, and *Done*
 * is the owner's alone. A naive loop that re-picks the first transition
 * stalls at In Progress, so this walks one step at a time and prints where
 * each ticket ended, read back from the API.
 *
 * The screenshot rule is the park owner's protocol requirement (2026-09-22):
 * a ticket is not Deployed until a picture on the ticket shows the fixed
 * thing on staging as a person sees it. On the 22nd, 22 Deployed tickets had
 * no image. So `Deployed` here checks `fields.attachment` for an `image/*`
 * entry and stops with a message if there is none — it is easier to make
 * the tool refuse than to remember every time.
 *
 *   node scripts/jira-walk.mjs SCRUM-203=Deployed SCRUM-204=Testing
 *   node scripts/jira-walk.mjs --force SCRUM-185=Deployed   # infra ticket, no screen to show
 *
 * Credentials come from the gitignored .env and are never printed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const BASE = process.env.JIRA_BASE_URL.replace(/\/+$/, '');
const H = {
  authorization: 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64'),
  'content-type': 'application/json',
};
const ORDER = ['To Do', 'In Progress', 'Testing', 'Deployed'];

const issue = async (key) =>
  (await (await fetch(`${BASE}/rest/api/3/issue/${key}?fields=status,attachment,summary`, { headers: H })).json()).fields;

const imageCount = (fields) => (fields.attachment ?? []).filter((a) => /^image\//.test(a.mimeType ?? '')).length;

async function walkTo(key, target, force) {
  for (let hop = 0; hop < 6; hop += 1) {
    const f = await issue(key);
    const cur = f.status.name;
    if (cur === target) return { end: cur, images: imageCount(f) };
    const ci = ORDER.indexOf(cur);
    const ti = ORDER.indexOf(target);
    if (ci < 0 || ti < 0 || ci >= ti) return { end: cur, images: imageCount(f), note: 'not a forward move on this board' };
    const next = ORDER[ci + 1];
    if (next === 'Deployed' && imageCount(f) === 0 && !force) {
      return {
        end: cur,
        images: 0,
        note: 'REFUSED — no screenshot on the ticket. Attach one that shows the fix on staging, or pass --force for an infrastructure ticket with no screen.',
      };
    }
    const t = await (await fetch(`${BASE}/rest/api/3/issue/${key}/transitions`, { headers: H })).json();
    const step = (t.transitions ?? []).find((x) => x.to.name === target) ?? (t.transitions ?? []).find((x) => x.to.name === next);
    if (!step) return { end: cur, images: imageCount(f), note: `no transition from ${cur} towards ${next}` };
    await fetch(`${BASE}/rest/api/3/issue/${key}/transitions`, { method: 'POST', headers: H, body: JSON.stringify({ transition: { id: step.id } }) });
  }
  const f = await issue(key);
  return { end: f.status.name, images: imageCount(f) };
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const moves = args.filter((a) => /^SCRUM-\d+=/.test(a)).map((a) => a.split('='));
if (moves.length === 0) {
  console.log('usage: node scripts/jira-walk.mjs [--force] SCRUM-<n>=<To Do|In Progress|Testing|Deployed> ...');
  process.exit(2);
}
let refused = 0;
for (const [key, target] of moves) {
  const r = await walkTo(key, target, force);
  const ok = r.end === target;
  if (!ok) refused += 1;
  console.log(`${key.padEnd(10)} -> ${r.end.padEnd(12)} ${String(r.images).padStart(2)} img ${ok ? '' : `(wanted ${target}) ${r.note ?? ''}`}`);
}
process.exit(refused ? 1 : 0);
