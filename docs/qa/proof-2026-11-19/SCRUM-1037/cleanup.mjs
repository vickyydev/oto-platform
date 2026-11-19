// Removes ZZ TEST profiles a crashed proof run left (ids from a receipt's
// "made" list, ZZ TEST names only), through the app's own delete route.
// Usage: node cleanup.mjs <receipt.json> <out.json>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const lane = 'C:/oto-lanes/codex-app-reliability-983-20261114';
const { chromium, expect } = createRequire(resolve(lane, 'apps/pos/package.json'))('@playwright/test');
const [, , receiptPath, outPath] = process.argv;
const made = JSON.parse(readFileSync(receiptPath, 'utf8')).made.filter(m => m.kind === 'employee' && m.name.startsWith('ZZ TEST'));
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage(); page.setDefaultTimeout(30000);
const result = { at: new Date().toISOString(), removed: [] };
try {
  await page.goto(origins.launcher);
  await page.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const handoff = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await page.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await page.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  await (await handoff).finished();
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  for (const m of made) {
    const before = await context.request.get(`${origins.app}/api/employees/${m.id}`);
    const body = before.status() === 200 ? await before.json() : null;
    if (body) assert.ok(String(body.fullName).startsWith('ZZ TEST'), 'only ZZ TEST profiles are removed');
    const del = before.status() === 200 ? (await context.request.delete(`${origins.app}/api/employees/${m.id}`, { headers: { origin: origins.app } })).status() : null;
    const after = (await context.request.get(`${origins.app}/api/employees/${m.id}`)).status();
    result.removed.push({ name: m.name, id: m.id, before: before.status(), del, after });
  }
} finally {
  for (const [origin, path] of [[origins.app, '/api/logout'], [origins.launcher, '/api/auth/sign-out']]) {
    await context.request.post(origin + path, { data: {}, headers: { origin } }).catch(() => {});
  }
  await browser.close();
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
