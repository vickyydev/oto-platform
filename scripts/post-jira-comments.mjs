// Posts each jira-comments/SCRUM-<n>.md as a comment on the matching Jira
// issue. Credentials come from the environment or /oto-platform/.env:
//   JIRA_BASE_URL  e.g. https://yourteam.atlassian.net
//   JIRA_EMAIL     the Atlassian account email
//   JIRA_API_TOKEN from https://id.atlassian.com/manage-profile/security/api-tokens
// Optional: JIRA_PROJECT_KEY (default SCRUM) if your keys differ.
// Usage: node scripts/post-jira-comments.mjs [--dry-run] [SCRUM-30 SCRUM-31 ...]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Minimal .env loader (no dependency).
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
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
const only = args.filter((a) => a.startsWith('SCRUM-'));

const dir = join(ROOT, 'jira-comments');
const files = readdirSync(dir)
  .filter((f) => f.match(/^SCRUM-\d+\.md$/))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

/** Upload one screenshot as an issue attachment; returns the stored filename. */
async function uploadAttachment(key, filePath, name) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: 'image/png' }), name);
  const res = await fetch(`${BASE}/rest/api/2/issue/${key}/attachments`, {
    method: 'POST',
    headers: { authorization: auth, 'X-Atlassian-Token': 'no-check' },
    body: form,
  });
  if (!res.ok) {
    console.error(`  ✘ attachment ${name}: HTTP ${res.status}`);
    return null;
  }
  const json = await res.json();
  return json[0]?.filename ?? name;
}

let posted = 0;
for (const file of files) {
  const ticket = file.replace('.md', '');
  const key = ticket.replace('SCRUM', PROJECT);
  if (only.length > 0 && !only.includes(key) && !only.includes(ticket)) continue;
  let body = readFileSync(join(dir, file), 'utf8').trim();

  // Screenshot evidence: upload everything in jira-comments/attachments/<ticket>/
  // and embed it in the comment (wiki markup).
  const attachDir = join(dir, 'attachments', ticket);
  const shots = existsSync(attachDir) ? readdirSync(attachDir).filter((f) => f.endsWith('.png')) : [];
  if (dryRun) {
    console.log(`[dry-run] ${key}: ${body.length} chars, ${shots.length} screenshot(s)`);
    continue;
  }
  const embedded = [];
  for (const shot of shots) {
    const stored = await uploadAttachment(key, join(attachDir, shot), shot);
    if (stored) embedded.push(stored);
  }
  if (embedded.length > 0) {
    body += '\n\nScreenshots:\n' + embedded.map((n) => `!${n}|width=720!`).join('\n');
  }
  // REST v2 accepts plain-text/wiki bodies (v3 would need ADF).
  const res = await fetch(`${BASE}/rest/api/2/issue/${key}/comment`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (res.ok) {
    posted++;
    console.log(`✔ ${key} (${embedded.length} screenshot(s))`);
  } else {
    console.error(`✘ ${key}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  }
}
console.log(dryRun ? 'Dry run complete.' : `Posted ${posted} comments.`);
