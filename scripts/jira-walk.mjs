#!/usr/bin/env node
/**
 * Move Jira tickets along the board — and REFUSE to move one to Deployed
 * without a screenshot on it, and LINK the commits that shipped it when it
 * gets there.
 *
 * The board's order is To Do → In Progress → Testing → Deployed, and *Done*
 * is the owner's alone. A naive loop that re-picks the first transition
 * stalls at In Progress, so this walks one step at a time and prints where
 * each ticket ended, read back from the API.
 *
 * Two protocol requirements from the park owner are enforced here rather
 * than remembered:
 *
 *  - Screenshot (2026-09-22): a ticket is not Deployed until a picture on the
 *    ticket shows the fixed thing on staging as a person sees it. `Deployed`
 *    checks `fields.attachment` for an `image/*` entry and stops if none.
 *  - Commits (2026-09-23, GitHub now linked to Jira): a ticket moving to
 *    Deployed carries the commits that shipped it — every commit on `main`
 *    whose message names the key (our `Refs:` footer) is added to the ticket
 *    as a web link to GitHub, and one comment lists them with their subjects.
 *    The GitHub-for-Jira app picks the keys out of the messages on its own;
 *    the links and the comment are what a reader sees without opening the
 *    Development panel. Idempotent: links already on the ticket are skipped.
 *
 *   node scripts/jira-walk.mjs SCRUM-203=Deployed SCRUM-204=Testing
 *   node scripts/jira-walk.mjs --force SCRUM-185=Deployed   # infra ticket, no screen to show
 *   node scripts/jira-walk.mjs --link-only SCRUM-307        # just add the commit links
 *
 * Credentials come from the gitignored .env and are never printed.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const BASE = process.env.JIRA_BASE_URL.replace(/\/+$/, '');
const REPO_URL = 'https://github.com/vickyydev/oto-platform';
const H = {
  authorization: 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64'),
  'content-type': 'application/json',
};
const ORDER = ['To Do', 'In Progress', 'Testing', 'Deployed'];

const issue = async (key) =>
  (await (await fetch(`${BASE}/rest/api/3/issue/${key}?fields=status,attachment,summary`, { headers: H })).json()).fields;

const imageCount = (fields) => (fields.attachment ?? []).filter((a) => /^image\//.test(a.mimeType ?? '')).length;

/** Every commit on main that names the key, oldest first: [sha, subject]. */
function commitsFor(key) {
  const out = execSync(`git log origin/main --reverse --format=%H%x09%s --grep="${key}\\b" -E`, { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([sha]) => /^[0-9a-f]{40}$/.test(sha))
    // docs(qa) evidence commits and docs(progress) checkpoints are not the fix.
    .filter(([, subject]) => !/^docs\(/.test(subject));
}

/** Add the commits as web links on the ticket and one comment naming them. */
async function linkCommits(key) {
  const commits = commitsFor(key);
  if (commits.length === 0) return { linked: 0, note: 'no commit on main names this key' };
  const existing = await (await fetch(`${BASE}/rest/api/3/issue/${key}/remotelink`, { headers: H })).json();
  const have = new Set((Array.isArray(existing) ? existing : []).map((l) => l.object?.url));
  let linked = 0;
  for (const [sha, subject] of commits) {
    const url = `${REPO_URL}/commit/${sha}`;
    if (have.has(url)) continue;
    const r = await fetch(`${BASE}/rest/api/3/issue/${key}/remotelink`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        globalId: `github-commit-${sha}`,
        relationship: 'shipped in',
        object: { url, title: `${sha.slice(0, 7)} ${subject}`, summary: 'Commit on main', icon: { url16x16: 'https://github.com/favicon.ico', title: 'GitHub' } },
      }),
    });
    if (r.ok) linked += 1;
  }
  if (linked > 0) {
    const body =
      `Commits on main that shipped this, linked on the ticket:\n` +
      commits.map(([sha, subject]) => `- ${sha.slice(0, 7)} — ${subject} (${REPO_URL}/commit/${sha})`).join('\n');
    await fetch(`${BASE}/rest/api/2/issue/${key}/comment`, { method: 'POST', headers: H, body: JSON.stringify({ body }) });
  }
  return { linked, total: commits.length };
}

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
    if (next === 'Deployed') {
      const l = await linkCommits(key);
      const f2 = await issue(key);
      return { end: f2.status.name, images: imageCount(f2), links: l };
    }
  }
  const f = await issue(key);
  return { end: f.status.name, images: imageCount(f) };
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const linkOnly = args.includes('--link-only');
if (linkOnly) {
  const keys = args.filter((a) => /^SCRUM-\d+$/.test(a));
  for (const key of keys) {
    const l = await linkCommits(key);
    console.log(`${key.padEnd(10)} links +${l.linked ?? 0} of ${l.total ?? 0} ${l.note ?? ''}`);
  }
  process.exit(0);
}
const moves = args.filter((a) => /^SCRUM-\d+=/.test(a)).map((a) => a.split('='));
if (moves.length === 0) {
  console.log('usage: node scripts/jira-walk.mjs [--force] SCRUM-<n>=<To Do|In Progress|Testing|Deployed> ...   |   --link-only SCRUM-<n> ...');
  process.exit(2);
}
let refused = 0;
for (const [key, target] of moves) {
  const r = await walkTo(key, target, force);
  const ok = r.end === target;
  if (!ok) refused += 1;
  const links = r.links ? ` commits +${r.links.linked}/${r.links.total ?? 0}` : '';
  console.log(`${key.padEnd(10)} -> ${r.end.padEnd(12)} ${String(r.images).padStart(2)} img${links} ${ok ? '' : `(wanted ${target}) ${r.note ?? ''}`}`);
}
process.exit(refused ? 1 : 0);
