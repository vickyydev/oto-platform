// SCRUM-1037: read-only. The staging admin's park group's leave types as they
// stand BEFORE the deploy that runs migration 0053, so the after-read can say
// exactly what 0053 changed. Writes nothing to staging. No personal data:
// leave type rows only (code, name, active), and the running version.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const lane = 'C:/oto-lanes/codex-app-reliability-983-20261114';
const { chromium, expect } = createRequire(resolve(lane, 'apps/pos/package.json'))('@playwright/test');
const origins = { app: 'https://oto-app-staging.onrender.com', launcher: 'https://oto-launcher-staging.onrender.com' };
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' });
const app = await context.newPage(); app.setDefaultTimeout(30000);
try {
  await app.goto(origins.launcher);
  await app.locator('input[type="tel"]').fill(need('STAGING_ADMIN_PHONE').replace(/^\+66/, '0'));
  await app.locator('input[type="password"]').fill(need('STAGING_ADMIN_PASSWORD'));
  await app.getByRole('button', { name: 'Sign in', exact: true }).click();
  const handoff = app.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/handoff');
  await app.getByRole('button', { name: 'Open OTO App', exact: true }).click();
  await app.waitForURL(url => url.origin === origins.app && !url.hash.includes('handoff'));
  await (await handoff).finished();
  await expect.poll(() => app.evaluate(async () => (await fetch('/api/user')).status)).toBe(200);
  const get = async path => { const r = await context.request.get(origins.app + path); assert.equal(r.status(), 200, path); return r.json(); };
  const version = (await get('/api/qa-reports/config')).version;
  const user = await get('/api/user');
  const types = (await get('/api/leave-types')).map(({ code, name, isActive, managersOnly }) => ({ code, name, isActive, managersOnly: managersOnly ?? '(no such field yet)' }));
  const receipt = { readAt: new Date().toISOString(), appVersion: version, adminRole: user.role, leaveTypes: types };
  writeFileSync(resolve(import.meta.dirname, 'before.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  for (const [origin, path] of [[origins.app, '/api/logout'], [origins.launcher, '/api/auth/sign-out']]) {
    await context.request.post(origin + path, { data: {}, headers: { origin } }).catch(() => {});
  }
} finally {
  await browser.close();
}
