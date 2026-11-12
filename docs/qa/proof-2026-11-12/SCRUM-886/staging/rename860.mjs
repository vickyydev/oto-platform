// SCRUM-860 fix check, carried by the SCRUM-886 api deploy (b627077e, bcaf07eaf "a contact rename logs its thread on
// both sides"): the ZZ TEST simulator contact the SCRUM-860 proof left ("ZZ TEST sim profile 860B", +66898600001,
// Demo WhatsApp) is renamed once more from the inbox's own Edit name dialog, and the Console's Activity row for that
// rename is opened: the conversation must stand on both sides (no "was — now" conversation line). The contact is then
// set back to its profile name, as the SCRUM-860 proof left it.
// Adapted from the SCRUM-860 harness (docs/qa/proof-2026-11-12/SCRUM-860/staging/proof.mjs): launcher sign-in and
// hand-off, staff names held in memory for masking only (never written or printed), other conversations masked.
// Credentials by NAME only (STAGING_ADMIN_PHONE, STAGING_ADMIN_PASSWORD through scripts/agent/env.mjs).
//
//   node rename860.mjs <out-dir>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.env.OTO_REPO ?? 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(REPO, 'scripts/agent/env.mjs')));
const { chromium } = createRequire(resolve(REPO, 'apps/pos/package.json'))('@playwright/test');
const OUT = resolve(process.argv[2] ?? resolve(import.meta.dirname, 'out-860'));
mkdirSync(OUT, { recursive: true });
const CONSOLE = 'https://oto-console-staging.onrender.com';
const LAUNCHER = 'https://oto-launcher-staging.onrender.com';
const INBOX = 'https://oto-inbox-staging.onrender.com';
const CONV = '01a1cdf0-4cbb-7338-82e6-b377a8aec01b';
const CONTACT = '01a1cdf0-4cb9-757a-97a1-e15cc73f9ae1';
const NEW_NAME = 'ZZ TEST 886 rename check';
const st = { unit: 'SCRUM-860 fix (rename audit names the conversation on both sides), checked on the SCRUM-886 api deploy', startedAt: new Date().toISOString(), conversation: CONV, contact: CONTACT, steps: {}, images: [], errors: [] };
const save = () => writeFileSync(resolve(OUT, 'receipt-860.json'), JSON.stringify(st, null, 2) + '\n');

const NAMES = new Set();
const addNames = (...vals) => { for (const v of vals) { if (typeof v !== 'string') continue; const t = v.trim(); if (t.length >= 2 && !/^ZZ TEST/i.test(t)) NAMES.add(t); } };

const call = async (ctx, origin, method, path, body) => {
  const headers = method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() };
  const r = await ctx.request.fetch(origin + '/api' + path, { method, data: body, headers, timeout: 120000 });
  const text = await r.text();
  let b = null; try { b = JSON.parse(text); } catch { b = text.slice(0, 200); }
  return { status: r.status(), body: b };
};
const handTo = async (ctx, app) => {
  const h = await call(ctx, LAUNCHER, 'POST', '/auth/handoff', { app });
  assert.equal(h.status, 200, 'handoff refused: ' + h.status);
  const page = await ctx.newPage();
  const exchange = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/handoff/exchange' && r.request().method() === 'POST', { timeout: 90000 });
  await page.goto(h.body.launchUrl);
  const response = await exchange;
  assert.equal(response.status(), 200, app + ' handoff refused');
  await response.finished();
  await page.waitForURL((u) => !u.hash.includes('handoff'), { timeout: 60000 });
  return page;
};
/** Staff names redacted in the page (text, fields, titles) and two-letter initials chips; returns how many runs. */
const redact = async (page) => page.evaluate((strings) => {
  const needles = [...new Set(strings)].sort((a, b) => b.length - a.length);
  if (!needles.length) return 0;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(needles.map(esc).join('|'), 'gi');
  let n = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) { const t = walker.currentNode; if (t.parentElement?.closest('[data-redacted]')) continue; re.lastIndex = 0; if (re.test(t.nodeValue || '')) hits.push(t); }
  for (const t of hits) {
    let html = (t.nodeValue || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    html = html.replace(re, (m) => { n += 1; return `<span data-redacted="1" style="background:#3f3f46;color:#3f3f46;border-radius:3px">${m.replace(/./g, '█')}</span>`; });
    const span = document.createElement('span'); span.setAttribute('data-redacted', 'wrap'); span.innerHTML = html; t.parentNode.replaceChild(span, t);
  }
  for (const el of document.querySelectorAll('input, textarea')) { re.lastIndex = 0; if (re.test(el.value || '')) { el.style.color = '#3f3f46'; el.style.background = '#3f3f46'; n += 1; } }
  return n;
}, [...NAMES]);
const leaks = async (page) => page.evaluate((strings) => {
  const text = document.body.innerText.toLowerCase();
  const fields = [...document.querySelectorAll('input, textarea')].map((e) => (e.style.color === 'rgb(63, 63, 70)' ? '' : e.value).toLowerCase()).join(' ');
  return strings.filter((s) => text.includes(s.toLowerCase()) || fields.includes(s.toLowerCase())).length;
}, [...NAMES]);
const maskInitials = async (page) => {
  const initials = new Set();
  for (const n of NAMES) { const w = n.split(/\s+/).filter(Boolean); if (w.length >= 2) initials.add((w[0][0] + w[1][0]).toUpperCase()); else if (w[0]?.length >= 2) initials.add(w[0].slice(0, 2).toUpperCase()); }
  return page.evaluate((list) => {
    const set = new Set(list); let n = 0; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
    while (walker.nextNode()) { const t = walker.currentNode; if (set.has((t.nodeValue || '').trim())) hits.push(t); }
    for (const t of hits) { const s = document.createElement('span'); s.setAttribute('data-redacted', '1'); s.style.cssText = 'background:#3f3f46;color:#3f3f46;border-radius:3px'; s.textContent = '██'; t.parentNode.replaceChild(s, t); n += 1; }
    return n;
  }, [...initials]);
};
/** Every conversation row that is not a ZZ TEST contact is marked for masking. */
const maskOthers = (page) => page.locator('section[aria-label="Conversations"]').evaluate((root) => {
  const items = root.querySelectorAll('li, [role="option"], button[data-conversation-id], a[href*="?c="]');
  const seen = new Set(); let n = 0;
  for (const el of items) {
    if ([...seen].some((s) => s.contains(el) || el.contains(s))) continue;
    const t = (el.innerText || '').trim(); if (!t) continue; seen.add(el);
    if (!/^ZZ TEST/i.test(t.split('\n')[0])) { el.setAttribute('data-mask-row', '1'); n += 1; }
  }
  return n;
}).catch(() => 0);
const shot = async (page, name, shows, mask = []) => {
  await page.waitForTimeout(600);
  await maskInitials(page);
  const masked = await redact(page);
  assert.equal(await leaks(page), 0, 'a staff name is still readable; picture not taken: ' + name);
  await page.screenshot({ path: resolve(OUT, name), mask: [page.locator('[data-mask-row="1"]'), ...mask], maskColor: '#3f3f46' });
  st.images.push({ file: name, shows, namesMasked: masked }); save();
  console.log('picture', name);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', colorScheme: 'light' });
ctx.setDefaultTimeout(30000);
let consolePage = null;
try {
  const s = await call(ctx, LAUNCHER, 'POST', '/auth/sign-in', { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') });
  assert.equal(s.status, 200, 'launcher sign-in ' + s.status);
  const inbox = await handTo(ctx, 'inbox');
  inbox.on('pageerror', (e) => { st.errors.push({ page: 'inbox', text: String(e.message).split('\n')[0].slice(0, 200) }); });
  const me = await call(ctx, INBOX, 'GET', '/inbox/me');
  assert.equal(me.status, 200);
  addNames(me.body.name); for (const p of me.body.people ?? []) addNames(p.name);
  const accounts = await call(ctx, CONSOLE, 'GET', '/accounts?limit=500').catch(() => null);
  for (const a of accounts?.body?.accounts ?? accounts?.body?.items ?? []) addNames(a.employee?.name, a.employee?.nickname);
  st.namesHeld = NAMES.size;

  // The contact as the SCRUM-860 proof left it: ZZ TEST names, the simulator number.
  const before = await call(ctx, INBOX, 'GET', `/inbox/conversations/${CONV}/contact`);
  assert.equal(before.status, 200);
  assert.ok(/^ZZ TEST/.test(before.body.displayName ?? '') && /^ZZ TEST/.test(before.body.profileName ?? ''), 'a ZZ TEST contact');
  assert.equal(before.body.handle, '+66898600001');
  st.steps.before = { id: before.body.id, displayName: before.body.displayName, profileName: before.body.profileName, nameSetByStaff: before.body.nameSetByStaff ?? null, handle: before.body.handle };
  assert.equal(before.body.id, CONTACT);

  // Edit name from the chat header's pencil.
  await inbox.goto(`${INBOX}/?c=${CONV}`);
  await inbox.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 60000 });
  const hide = inbox.getByRole('button', { name: 'Hide', exact: true });
  if (await hide.isVisible().catch(() => false)) await hide.click().catch(() => {});
  await inbox.getByRole('textbox', { name: 'Search' }).fill('ZZ TEST');
  await inbox.waitForTimeout(2500);
  const section = inbox.locator('section[aria-label="Conversation"]');
  await section.waitFor({ timeout: 60000 });
  await section.getByRole('button', { name: 'Edit name', exact: true }).click();
  const dlg = inbox.getByRole('dialog').filter({ has: inbox.locator('#contact-name-form') });
  await dlg.waitFor({ timeout: 15000 });
  await dlg.getByTestId('profile-name-line').filter({ hasNotText: 'Reading the contact' }).waitFor({ timeout: 20000 });
  await dlg.getByRole('textbox', { name: 'Name' }).fill(NEW_NAME);
  await maskOthers(inbox);
  await shot(inbox, '06a-inbox-edit-name-zz-test-contact-renamed-once-more.png', `the inbox's Edit name on the ZZ TEST simulator contact, the name typed: ${NEW_NAME}`);
  const [resp] = await Promise.all([
    inbox.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/contact') && r.request().method() === 'PATCH', { timeout: 60000 }),
    dlg.getByRole('button', { name: 'Save name' }).click(),
  ]);
  st.steps.rename = { route: 'PATCH /api/inbox/conversations/:id/contact', status: resp.status(), sent: resp.request().postDataJSON() };
  assert.equal(resp.status(), 200);
  await dlg.waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await inbox.waitForTimeout(1500);

  // The rename's audit row: the conversation on both sides.
  let row = null;
  for (let i = 0; i < 10 && !row; i++) {
    const a = await call(ctx, LAUNCHER, 'GET', `/audit?entityType=inbox.contact&entityId=${CONTACT}&limit=50`);
    row = (a.body?.entries ?? []).filter((e) => e.action === 'inbox.contact.rename' && e.after?.displayName === NEW_NAME).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0] ?? null;
    if (!row) await inbox.waitForTimeout(1500);
  }
  assert.ok(row, 'the rename has its audit row');
  st.steps.auditRow = { action: row.action, createdAt: row.createdAt, requestId: row.requestId, before: row.before, after: row.after,
    conversationBefore: row.before?.conversationId ?? null, conversationAfter: row.after?.conversationId ?? null };
  save();

  // The Console's Activity, filtered by the rename's request id, the row opened.
  consolePage = await handTo(ctx, 'console');
  const cme = await call(ctx, CONSOLE, 'GET', '/me');
  addNames(cme.body?.employee?.name, cme.body?.employee?.nickname, cme.body?.name);
  await consolePage.setViewportSize({ width: 1440, height: 1100 });
  await consolePage.goto(CONSOLE + '/activity');
  const rid = consolePage.getByLabel('Request id', { exact: true });
  await rid.waitFor({ timeout: 60000 });
  await rid.fill(row.requestId);
  await consolePage.waitForTimeout(3500);
  await shot(consolePage, '06b-console-activity-filtered-by-the-rename.png', 'the Console Activity filtered by the rename\'s request id', [consolePage.locator('input[type="tel"]')]);
  await consolePage.getByText('inbox.contact.rename', { exact: true }).last().click();
  await consolePage.waitForTimeout(2500);
  const drawer = consolePage.locator('[role="dialog"], aside, [data-drawer]').last();
  const lines = (await drawer.innerText().catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean);
  await shot(consolePage, '06c-console-activity-rename-row-no-conversation-change.png', 'the rename\'s row opened: Changes lists the name fields only; the conversation is not a change', [consolePage.locator('input[type="tel"]')]);
  const changes = lines.slice(lines.indexOf('Changes'));
  st.steps.console = { requestIdFilled: true, changesTab: changes.slice(0, 30),
    conversationLine: changes.some((l) => /^CONVERSATION ID$/i.test(l)), wasDashLines: changes.filter((l) => /^was —$/.test(l)).length };

  // Set back to the profile name, as the SCRUM-860 proof left it.
  await inbox.bringToFront();
  await inbox.goto(`${INBOX}/?c=${CONV}`);
  await inbox.locator('section[aria-label="Conversation"]').waitFor({ timeout: 60000 });
  await inbox.locator('section[aria-label="Conversation"]').getByRole('button', { name: 'Edit name', exact: true }).click();
  await dlg.waitFor({ timeout: 15000 });
  await dlg.getByTestId('profile-name-line').filter({ hasNotText: 'Reading the contact' }).waitFor({ timeout: 20000 });
  const [back] = await Promise.all([
    inbox.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/contact') && r.request().method() === 'PATCH', { timeout: 60000 }),
    dlg.getByRole('button', { name: /Use the profile name|Clear the name/ }).click(),
  ]);
  const after = await call(ctx, INBOX, 'GET', `/inbox/conversations/${CONV}/contact`);
  st.steps.restore = { status: back.status(), displayName: after.body?.displayName, profileName: after.body?.profileName, nameSetByStaff: after.body?.nameSetByStaff ?? null };
  st.pass = st.steps.rename.status === 200 && st.steps.auditRow.conversationBefore === CONV && st.steps.auditRow.conversationAfter === CONV
    && !st.steps.console.conversationLine && st.steps.restore.status === 200;
} catch (e) {
  st.failure = String(e?.message ?? e).split('\n')[0].slice(0, 300);
  console.log('FAILED', st.failure);
} finally {
  const safe = (p) => p.catch((e) => ({ status: 'error ' + e.message }));
  st.signOut = {
    inbox: (await safe(call(ctx, INBOX, 'POST', '/auth/sign-out', {}))).status,
    console: (await safe(call(ctx, CONSOLE, 'POST', '/auth/sign-out', {}))).status,
    launcher: (await safe(call(ctx, LAUNCHER, 'POST', '/auth/sign-out', {}))).status,
  };
  st.readBack = { inbox: (await safe(call(ctx, INBOX, 'GET', '/inbox/me'))).status, console: (await safe(call(ctx, CONSOLE, 'GET', '/me'))).status, launcher: (await safe(call(ctx, LAUNCHER, 'GET', '/me'))).status };
  await browser.close();
  // No staff name stays in the receipt.
  const names = [...NAMES].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = names.length ? new RegExp(names.map(esc).join('|'), 'gi') : null;
  const walk = (v) => typeof v === 'string' ? (re ? v.replace(re, '(staff name)') : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  for (const k of Object.keys(st)) st[k] = walk(st[k]);
  st.finishedAt = new Date().toISOString();
  NAMES.clear();
  save();
  console.log(JSON.stringify({ pass: st.pass ?? false, failure: st.failure ?? null, auditRow: st.steps.auditRow && { before: st.steps.auditRow.conversationBefore, after: st.steps.auditRow.conversationAfter }, console: st.steps.console, restore: st.steps.restore, signOut: st.signOut, readBack: st.readBack }, null, 1));
}
