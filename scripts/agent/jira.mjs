// Jira helpers for the delivery protocol: status, plain-words comments,
// screenshots, and step-by-step status moves.
//
// Library:  import { comment, walkTo, attach } from './scripts/agent/jira.mjs'
// CLI:      node scripts/agent/jira.mjs status SCRUM-494
//           node scripts/agent/jira.mjs comment SCRUM-494 "text"
//           node scripts/agent/jira.mjs walk SCRUM-494 Testing
//           node scripts/agent/jira.mjs attach SCRUM-494 a.png b.png
//           node scripts/agent/jira.mjs images SCRUM-494
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { need, ROOT } from './env.mjs';

const base = () => need('JIRA_BASE_URL').replace(/\/+$/, '');
const auth = () =>
  'Basic ' + Buffer.from(`${need('JIRA_EMAIL')}:${need('JIRA_API_TOKEN')}`).toString('base64');

export const jget = async (p) => {
  const r = await fetch(`${base()}${p}`, { headers: { authorization: auth() } });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _status: r.status, _body: t.slice(0, 400) };
  }
};

const send = (method) => async (p, body) => {
  const r = await fetch(`${base()}${p}`, {
    method,
    headers: { authorization: auth(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 600) };
};
export const jpost = send('POST');
export const jput = send('PUT');
export const jdelete = send('DELETE');

export const statusOf = async (key) => {
  const j = await jget(`/rest/api/3/issue/${key}?fields=status,summary`);
  return { status: j?.fields?.status?.name, summary: j?.fields?.summary };
};

/** The board's order. "Done" belongs to the owner and is never set here. */
export const ORDER = ['To Do', 'In Progress', 'Testing', 'Deployed'];

/** Image attachments on an issue. */
export const images = async (key) => {
  const j = await jget(`/rest/api/3/issue/${key}?fields=attachment`);
  return (j?.fields?.attachment ?? []).filter((a) => /^image\//.test(a.mimeType));
};

const REPO_URL = 'https://github.com/vickyydev/oto-platform';

/** Every commit on main that names the key, oldest first, without docs commits: [sha, subject]. */
const commitsFor = (key) =>
  execFileSync('git', ['log', 'origin/main', '--reverse', '--format=%H%x09%s', '-E', `--grep=${key}\\b`], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([sha]) => /^[0-9a-f]{40}$/.test(sha))
    // docs(qa) evidence commits and docs(progress) checkpoints are not the fix.
    .filter(([, subject]) => !/^docs\(/.test(subject));

/**
 * Add the commits that shipped a ticket as web links, and one comment naming
 * them (owner's protocol, 2026-09-23). Links already on the ticket are skipped,
 * and no comment is posted when nothing new was linked.
 */
export const linkCommits = async (key) => {
  const commits = commitsFor(key);
  if (commits.length === 0) return { linked: 0, note: 'no commit on main names this key' };
  const existing = await jget(`/rest/api/3/issue/${key}/remotelink`);
  const have = new Set((Array.isArray(existing) ? existing : []).map((l) => l.object?.url));
  let linked = 0;
  for (const [sha, subject] of commits) {
    const url = `${REPO_URL}/commit/${sha}`;
    if (have.has(url)) continue;
    const r = await jpost(`/rest/api/3/issue/${key}/remotelink`, {
      globalId: `github-commit-${sha}`,
      relationship: 'shipped in',
      object: { url, title: `${sha.slice(0, 7)} ${subject}`, summary: 'Commit on main', icon: { url16x16: 'https://github.com/favicon.ico', title: 'GitHub' } },
    });
    if (r.status < 300) linked += 1;
  }
  if (linked > 0) {
    const body = `Commits on main that shipped this, linked on the ticket:\n${commits
      .map(([sha, subject]) => `- ${sha.slice(0, 7)} — ${subject} (${REPO_URL}/commit/${sha})`)
      .join('\n')}`;
    await jpost(`/rest/api/2/issue/${key}/comment`, { body });
  }
  return { linked, total: commits.length };
};

/**
 * Walk one step at a time, re-reading after each hop; never backwards.
 * Refuses to reach Deployed while the issue has no screenshot attached, and
 * links the commits that shipped the ticket when it gets there.
 */
export const walkTo = async (key, target) => {
  if (target === 'Deployed' && (await images(key)).length === 0) {
    throw new Error(`${key}: no screenshot attached; Deployed needs one.`);
  }
  let moved = false;
  for (let hop = 0; hop < 6; hop += 1) {
    const { status: cur } = await statusOf(key);
    if (cur === target) {
      if (moved && target === 'Deployed') {
        const l = await linkCommits(key);
        console.log(`${key}: commit links +${l.linked} of ${l.total ?? 0}${l.note ? ` (${l.note})` : ''}`);
      }
      return cur;
    }
    const ci = ORDER.indexOf(cur);
    const ti = ORDER.indexOf(target);
    if (ci < 0 || ti < 0 || ci >= ti) return cur;
    const want = ORDER[ci + 1];
    const t = await jget(`/rest/api/3/issue/${key}/transitions`);
    const list = t.transitions || [];
    const step = list.find((x) => x.to.name === target) ?? list.find((x) => x.to.name === want);
    if (!step) {
      console.log(`${key}: no transition from ${cur} towards ${want}; available: ${list.map((x) => x.to.name).join(', ')}`);
      return cur;
    }
    await jpost(`/rest/api/3/issue/${key}/transitions`, { transition: { id: step.id } });
    moved = true;
  }
  return (await statusOf(key)).status;
};

/** Plain-text paragraphs to ADF. A block of lines starting "- " becomes a bullet list. */
export const adf = (text) => {
  const content = [];
  for (const b of text.trim().split(/\n\s*\n/)) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => l.startsWith('- '))) {
      content.push({
        type: 'bulletList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: l.slice(2) }] }],
        })),
      });
    } else {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: lines.join(' ') }] });
    }
  }
  return { type: 'doc', version: 1, content };
};

export const comment = (key, text) => jpost(`/rest/api/3/issue/${key}/comment`, { body: adf(text) });

/** Attach files (absolute or repo-relative paths). */
export const attach = async (key, paths) => {
  const fd = new FormData();
  for (const p of paths) fd.append('file', new Blob([readFileSync(p)], { type: 'image/png' }), basename(p));
  const r = await fetch(`${base()}/rest/api/3/issue/${key}/attachments`, {
    method: 'POST',
    headers: { authorization: auth(), 'X-Atlassian-Token': 'no-check' },
    body: fd,
  });
  const t = await r.text();
  try {
    return { status: r.status, files: (JSON.parse(t) || []).map((x) => ({ id: x.id, name: x.filename })) };
  } catch {
    return { status: r.status, body: t.slice(0, 400) };
  }
};

/** Comment that embeds images already attached (wiki-renderer API v2). */
export const commentWithImages = (key, text, filenames) =>
  jpost(`/rest/api/2/issue/${key}/comment`, {
    body: `${text}\n\n${filenames.map((f) => `!${f}|width=760!`).join('\n')}`,
  });

export const ACTIVE_SPRINT = 3;
export const DEFECT_EPIC = 'SCRUM-324';

/** Create an issue in the active sprint (description in wiki markup). */
// Every new ticket is assigned to Waqar Aziz (owner's standing rule, 2026-10-21).
export const DEFAULT_ASSIGNEE = '62948e77658d58006887827d';

export const createInSprint = async ({ type = 'Bug', summary, description, priority = 'Medium', area = 'pos', extra = [], parent, assignee = DEFAULT_ASSIGNEE }) => {
  const labels = [...new Set([type === 'Bug' ? 'defect' : 'gap', 'sprint-2', area, ...extra])];
  const parentKey = parent ?? (type === 'Bug' ? DEFECT_EPIC : 'SCRUM-181');
  const r = await jpost('/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, issuetype: { name: type }, parent: { key: parentKey }, summary, description, priority: { name: priority }, labels, customfield_10020: ACTIVE_SPRINT, assignee: { id: assignee } },
  });
  let key = null;
  try {
    key = JSON.parse(r.body).key;
  } catch {
    key = null;
  }
  return { key, status: r.status, body: r.body };
};

/** Create a subtask under a story (subtasks follow the parent's sprint). */
export const createSubtask = async ({ parent, summary, description, priority = 'Medium', labels = ['gap', 'sprint-2', 'pos'], assignee = DEFAULT_ASSIGNEE }) => {
  const r = await jpost('/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, issuetype: { name: 'Subtask' }, parent: { key: parent }, summary, description, priority: { name: priority }, labels, assignee: { id: assignee } },
  });
  let key = null;
  try {
    key = JSON.parse(r.body).key;
  } catch {
    key = null;
  }
  return { key, status: r.status, body: r.body };
};

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('jira.mjs')) {
  const [cmd, key, ...rest] = process.argv.slice(2);
  if (cmd === 'status') console.log(key, (await statusOf(key)).status);
  else if (cmd === 'comment') console.log((await comment(key, rest.join(' '))).status);
  else if (cmd === 'walk') console.log(key, await walkTo(key, rest.join(' ')));
  else if (cmd === 'attach') console.log(JSON.stringify(await attach(key, rest)));
  else if (cmd === 'images') console.log((await images(key)).map((a) => a.filename).join('\n') || '(none)');
  else if (cmd) console.log('commands: status | comment | walk | attach | images');
}
