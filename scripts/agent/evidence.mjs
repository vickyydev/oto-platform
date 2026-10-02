/* global document, window */
// Staging evidence for Jira: sign in on the real staging sites, take
// screenshots, and compose an evidence card (title, signed-in identity,
// deploy, rows of what was checked, and the screenshots themselves).
//
// import { launch, posSignIn, me, card, png } from './scripts/agent/evidence.mjs'
// Sign-ins come from STAGING_<WHO>_PHONE / STAGING_<WHO>_PASSWORD
// (WHO = ADMIN, RECEPTION, MANAGER). Never print them.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, need } from './env.mjs';

const require = createRequire(resolve(ROOT, 'apps/pos/package.json'));
const { chromium } = require('@playwright/test');

export const POS = process.env.STAGING_POS_URL ?? 'https://oto-pos-staging.onrender.com';
export const CONSOLE = process.env.STAGING_CONSOLE_URL ?? 'https://oto-console-staging.onrender.com';
/** Screenshots committed with the ticket's evidence. */
export const attachmentsDir = (key) => resolve(ROOT, 'docs/qa/jira-comments/attachments', key);
export const png = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');

export const launch = () => chromium.launch();

const person = (who) => ({
  phone: need(`STAGING_${who.toUpperCase()}_PHONE`),
  password: need(`STAGING_${who.toUpperCase()}_PASSWORD`),
});

const locked = (page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('input[type="password"]')).some((i) => i.offsetParent !== null));

/** Sign in on the POS lock screen as ADMIN | RECEPTION | MANAGER. */
export async function posSignIn(browser, who, { width = 1600, height = 1100 } = {}) {
  const p = person(who);
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page.goto(POS, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    if (!(await locked(page))) break;
    await page.locator('input[type="tel"], input[inputmode="tel"]').last().fill(p.phone).catch(() => {});
    await page.locator('input[type="password"]').last().fill(p.password).catch(() => {});
    await page.getByRole('button', { name: /^sign in$/i }).click().catch(() => {});
    await page.waitForTimeout(6000);
    if (!(await locked(page))) break;
  }
  if (await locked(page)) throw new Error(`POS still on the sign-in screen as ${who}`);
  return { ctx, page };
}

/** The signed-in identity, read live from the page's own session. */
export const me = (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'include' });
    if (!r.ok) return { status: r.status };
    const b = await r.json();
    return { name: b?.employee?.name, branch: b?.branch?.name, station: b?.station?.name ?? null };
  });

/**
 * Compose an evidence card over the current page and save it as a PNG.
 * spec: { title, subtitle, identity, deploy, rows: [{ ok, tag, head, note, body? }],
 *         images: [{ heading, items: [{ label, url?, src }] }] }
 */
export async function card(page, spec, outFile) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate((s) => {
    document.getElementById('zz-ev')?.remove();
    const el = document.createElement('div');
    el.id = 'zz-ev';
    el.style.cssText = 'position:absolute;left:0;top:0;width:1400px;z-index:2147483647;background:#0b1020;color:#e6e9f0;font:14px/1.5 ui-monospace,Consolas,monospace;padding:22px 26px;box-sizing:border-box;text-align:left;';
    const esc = (x) => String(x ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const badge = (t, ok) => `<span style="display:inline-block;min-width:46px;text-align:center;border-radius:6px;padding:2px 8px;font-weight:700;background:${ok ? '#12351f' : '#3a1220'};color:${ok ? '#4ade80' : '#f87171'}">${esc(t)}</span>`;
    const bar = (u) => `<div style="background:#e8eaed;color:#202124;border-radius:18px;padding:5px 14px;font:13px system-ui,sans-serif;margin:4px 0">${esc(u)}</div>`;
    let h = `<div style="font-size:22px;font-weight:800;color:#fff">${esc(s.title)}</div><div style="color:#9aa4bf;margin:2px 0 12px">${esc(s.subtitle)}</div>`;
    h += `<div style="background:#131a2e;border:1px solid #263154;border-radius:8px;padding:10px 12px;margin-bottom:12px"><b style="color:#8bd4ff">Signed-in identity</b><br>${s.identity ?? ''}<br>captured ${esc(new Date().toISOString())}<br>${esc(s.deploy ?? '')}</div>`;
    for (const r of s.rows ?? []) {
      h += `<div style="margin:10px 0;border-left:3px solid ${r.ok ? '#2b6b3f' : '#7a2233'};padding:2px 0 2px 12px"><div>${badge(r.tag, r.ok)} <b>${esc(r.head)}</b> <span style="color:#9aa4bf">- ${esc(r.note)}</span></div>`;
      if (r.body) h += `<pre style="white-space:pre-wrap;margin:4px 0 0;color:#c7ccdb;background:#0f1526;border-radius:6px;padding:8px">${esc(r.body)}</pre>`;
      h += `</div>`;
    }
    for (const g of s.images ?? []) {
      h += `<div style="color:#8bd4ff;font-weight:700;margin:14px 0 6px">${esc(g.heading)}</div><div style="display:flex;gap:12px;align-items:flex-start">`;
      for (const i of g.items) h += `<div style="flex:1;min-width:0"><div style="color:#9aa4bf;margin-bottom:4px">${esc(i.label)}</div>${i.url ? bar(i.url) : ''}<img src="${i.src}" style="width:100%;height:auto;border:1px solid #263154;border-radius:6px;display:block"></div>`;
      h += `</div>`;
    }
    el.innerHTML = h;
    document.body.appendChild(el);
    window.scrollTo(0, 0);
  }, spec);
  await page.waitForFunction(() => [...document.querySelectorAll('#zz-ev img')].every((i) => i.complete && i.naturalWidth > 0));
  const height = await page.evaluate(() => Math.ceil(document.getElementById('zz-ev').getBoundingClientRect().height));
  await page.setViewportSize({ width: 1400, height });
  await page.waitForTimeout(400);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, await page.screenshot({ clip: { x: 0, y: 0, width: 1400, height } }));
  await page.evaluate(() => document.getElementById('zz-ev')?.remove());
  return outFile;
}
