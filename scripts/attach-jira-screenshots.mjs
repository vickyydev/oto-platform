// Uploads each ticket's screenshots from jira-comments/attachments/SCRUM-<n>/
// as REAL Jira attachments and posts one "Screenshot evidence" comment per
// ticket with the images embedded (they render as previews in the comment).
//
// Needs (in the environment or /oto-platform/.env):
//   JIRA_BASE_URL   e.g. https://oto-suite-dev.atlassian.net
//   JIRA_EMAIL      the Atlassian account email
//   JIRA_API_TOKEN  from https://id.atlassian.com/manage-profile/security/api-tokens
// Optional: JIRA_PROJECT_KEY (default SCRUM).
//
// Usage: node scripts/attach-jira-screenshots.mjs [--dry-run] [SCRUM-30 ...]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const BASE = process.env.JIRA_BASE_URL?.replace(/\/+$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY ?? 'SCRUM';
if (!BASE || !EMAIL || !TOKEN) {
  console.error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN (env or oto-platform/.env).');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.filter((a) => a.includes('-') && !a.startsWith('--'));

const attachRoot = join(ROOT, 'jira-comments', 'attachments');
const ticketDirs = readdirSync(attachRoot)
  .filter((d) => d.match(/^SCRUM-\d+$/))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

let ok = 0;
for (const ticket of ticketDirs) {
  const key = ticket.replace('SCRUM', PROJECT);
  if (only.length > 0 && !only.includes(key) && !only.includes(ticket)) continue;
  const dir = join(attachRoot, ticket);
  const shots = readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (shots.length === 0) continue;

  if (dryRun) {
    console.log(`[dry-run] ${key}: would attach ${shots.length} image(s): ${shots.join(', ')}`);
    continue;
  }

  const uploaded = [];
  for (const shot of shots) {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(join(dir, shot))], { type: 'image/png' }), shot);
    const res = await fetch(`${BASE}/rest/api/2/issue/${key}/attachments`, {
      method: 'POST',
      headers: { authorization: auth, 'X-Atlassian-Token': 'no-check' },
      body: form,
    });
    if (res.ok) {
      const json = await res.json();
      uploaded.push(json[0]?.filename ?? shot);
    } else {
      console.error(`  ✘ ${key} ${shot}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
  }
  if (uploaded.length === 0) continue;

  // Wiki-markup embeds render as inline previews in the comment.
  const body =
    `*Screenshot evidence* (steps in the QA Test Case comment above):\n\n` +
    uploaded.map((n) => `!${n}|width=720!`).join('\n');
  const res = await fetch(`${BASE}/rest/api/2/issue/${key}/comment`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (res.ok) {
    ok++;
    console.log(`✔ ${key}: ${uploaded.length} image(s) attached + preview comment posted`);
  } else {
    console.error(`✘ ${key} comment: HTTP ${res.status}`);
  }
}
console.log(dryRun ? 'Dry run complete.' : `Done — ${ok} tickets updated with image previews.`);
