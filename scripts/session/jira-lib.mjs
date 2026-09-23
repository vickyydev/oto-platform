import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
export const BASE = process.env.JIRA_BASE_URL.replace(/\/+$/, '');
export const auth =
  'Basic ' +
  Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

export const jget = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { authorization: auth } });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _status: r.status, _body: t.slice(0, 400) };
  }
};

export const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 600) };
};

export const jput = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PUT',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 600) };
};

export const statusOf = async (key) => {
  const j = await jget(`/rest/api/3/issue/${key}?fields=status,summary`);
  return { status: j?.fields?.status?.name, summary: j?.fields?.summary };
};

const ORDER = ['To Do', 'In Progress', 'Testing', 'Deployed'];

/** Walk one step at a time, re-reading after each hop. Never goes backwards. */
export const walkTo = async (key, target) => {
  for (let hop = 0; hop < 6; hop += 1) {
    const { status: cur } = await statusOf(key);
    if (cur === target) return cur;
    const ci = ORDER.indexOf(cur);
    const ti = ORDER.indexOf(target);
    if (ci < 0 || ti < 0 || ci >= ti) return cur;
    const want = ORDER[ci + 1];
    const t = await jget(`/rest/api/3/issue/${key}/transitions`);
    const step =
      (t.transitions || []).find((x) => x.to.name === target) ??
      (t.transitions || []).find((x) => x.to.name === want);
    if (!step) {
      console.log(
        `   ${key}: no transition from ${cur} towards ${want}; available:`,
        (t.transitions || []).map((x) => x.to.name).join(', '),
      );
      return cur;
    }
    await jpost(`/rest/api/3/issue/${key}/transitions`, { transition: { id: step.id } });
  }
  return (await statusOf(key)).status;
};

/** Plain-text paragraphs -> ADF. Lines starting with "- " become a bullet list. */
export const adf = (text) => {
  const content = [];
  const blocks = text.trim().split(/\n\s*\n/);
  for (const b of blocks) {
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
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: lines.join(' ') }],
      });
    }
  }
  return { type: 'doc', version: 1, content };
};

export const comment = (key, text) =>
  jpost(`/rest/api/3/issue/${key}/comment`, { body: adf(text) });

/** Attach files to an issue. paths: array of absolute paths. */
export const attach = async (key, paths) => {
  const { readFileSync: rf } = await import('node:fs');
  const { basename } = await import('node:path');
  const fd = new FormData();
  for (const p of paths) {
    const buf = rf(p);
    fd.append('file', new Blob([buf], { type: 'image/png' }), basename(p));
  }
  const r = await fetch(`${BASE}/rest/api/3/issue/${key}/attachments`, {
    method: 'POST',
    headers: { authorization: auth, 'X-Atlassian-Token': 'no-check' },
    body: fd,
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    return { status: r.status, body: t.slice(0, 400) };
  }
  return { status: r.status, files: (j || []).map((x) => ({ id: x.id, name: x.filename })) };
};

/** Comment with inline images already attached to the issue. */
export const commentWithImages = (key, text, filenames) => {
  const doc = adf(text);
  for (const fn of filenames) {
    doc.content.push({
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{ type: 'media', attrs: { type: 'file', id: fn.id, collection: '' } }],
    });
  }
  return jpost(`/rest/api/3/issue/${key}/comment`, { body: doc });
};

/** Sprint 2 – Complete build. Bugs and Tasks do not join a sprint by themselves. */
export const ACTIVE_SPRINT = 3;
/** Create an issue in the sprint with the labels the owner asked for. */
/** Bugs sit under the red Defects epic; gaps under the Sprint 2 platform story. */
export const DEFECT_EPIC = 'SCRUM-324';
export const createInSprint = async ({ type = 'Bug', summary, description, priority = 'Medium', area = 'pos', extra = [], parent }) => {
  const labels = [...new Set([type === 'Bug' ? 'defect' : 'gap', 'sprint-2', area, ...extra])];
  const parentKey = parent ?? (type === 'Bug' ? DEFECT_EPIC : 'SCRUM-181');
  const r = await jpost('/rest/api/2/issue', { fields: { project: { key: 'SCRUM' }, issuetype: { name: type }, parent: { key: parentKey }, summary, description, priority: { name: priority }, labels, customfield_10020: ACTIVE_SPRINT } });
  let key = null; try { key = JSON.parse(r.body).key; } catch {}
  return { key, status: r.status, body: r.body };
};
