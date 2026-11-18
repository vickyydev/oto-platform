// SCRUM-1010 staging proof: the park's day runs midnight to midnight.
// Run from the Desktop checkout's helpers after the deploy is live:
//   node docs/qa/proof-2026-11-19/SCRUM-1010/proof.mjs <phase>
// phases: reads | sale | console | till
// Reads print statuses and fields only; no cookie, key, phone or password is
// printed or saved. The one write is a cash sale labelled ZZ TEST on the
// station "ZZ TEST setup traps 20261102" (Virtual box 1).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const out = import.meta.dirname;
const root = resolve(out, '../../../..');
const helperRoot = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/env.mjs')));
const { chromium, request } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const POS = 'https://oto-pos-web-staging.onrender.com';
const CONSOLE = 'https://oto-console-staging.onrender.com';
const STATION = 'ZZ TEST setup traps 20261102';
const receiptFile = resolve(out, 'receipt.json');
const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : { unit: 'SCRUM-1010', steps: {} };
const save = () => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
mkdirSync(out, { recursive: true });

/** UUIDv7 from the clock and random bits, as the till mints one. */
const v7 = () => {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const bangkokDate = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(d);

async function apiAs(base, who) {
  const ctx = await request.newContext({ baseURL: base });
  const r = await ctx.post('/api/auth/sign-in', {
    data: { phone: need(`STAGING_${who}_PHONE`), password: need(`STAGING_${who}_PASSWORD`) },
  });
  assert.equal(r.status(), 200, `${who} sign-in`);
  const call = async (method, path, data, headers = {}) => {
    const res = await ctx.fetch('/api' + path, { method, data, headers });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status(), body };
  };
  const signOut = async () => {
    const s = await ctx.post('/api/auth/sign-out');
    const me = await ctx.get('/api/me');
    await ctx.dispose();
    return { signOut: s.status(), meAfter: me.status() };
  };
  return { call, signOut };
}

const phase = process.argv[2];

if (phase === 'reads') {
  const admin = await apiAs(POS, 'ADMIN');
  const branches = await admin.call('GET', '/branches');
  const parks = (branches.body?.branches ?? []).filter((b) => !b.archived);
  const hkt = parks.find((p) => p.code === 'hkt-central');
  const pricing = await admin.call('GET', `/branches/${hkt.id}/pricing-mode`);
  const eod = await admin.call('GET', `/branches/${hkt.id}/end-of-day?date=${pricing.body.date}`);
  const health = await admin.call('GET', '/ops/health');
  const vbox = (health.body?.boxes ?? []).find((b) => b.slot === 'virtual-1');
  receipt.steps.reads = {
    at: new Date().toISOString(),
    bangkokCalendarDate: bangkokDate(),
    branchesStatus: branches.status,
    parks: parks.map((p) => ({ code: p.code, name: p.name, timezone: p.timezone, businessDayStart: p.businessDayStart })),
    pricingStatus: pricing.status,
    pricing: pricing.body,
    endOfDay: { status: eod.status, businessDate: eod.body?.businessDate ?? eod.body?.date ?? null, state: eod.body?.status ?? null },
    virtualBox: vbox ? { name: vbox.name, status: vbox.status, lastHeartbeatAt: vbox.lastHeartbeatAt, configVersion: vbox.configVersion } : null,
    session: await admin.signOut(),
  };
  save();
  console.log(JSON.stringify(receipt.steps.reads, null, 1));
}

if (phase === 'sale') {
  const admin = await apiAs(POS, 'ADMIN');
  const branches = await admin.call('GET', '/branches');
  const hkt = (branches.body?.branches ?? []).find((b) => b.code === 'hkt-central');
  const stations = await admin.call('GET', `/branches/${hkt.id}/stations`);
  const station = (stations.body?.stations ?? []).find((s) => s.name === STATION);
  assert.ok(station, 'the ZZ TEST station');
  const menu = await admin.call('GET', `/branches/${hkt.id}/menu`);
  const product = (menu.body?.products ?? []).find((p) => p.code === 'CF-7' && !p.archivedAt && p.active !== false
    && (p.variants ?? []).length === 0 && (p.linkedModifierGroupIds ?? []).length === 0);
  assert.ok(product, 'a plain menu item');
  await admin.signOut();

  const till = await apiAs(POS, 'RECEPTION');
  const seat = await till.call('PUT', '/me/session/station', { stationId: station.id });
  assert.equal(seat.status, 200, 'seated at the ZZ TEST station: ' + JSON.stringify(seat.body?.error ?? null));
  const pricing = await till.call('GET', `/branches/${hkt.id}/pricing-mode`);
  const saleId = v7();
  const commit = await till.call('POST', '/sales', {
    id: saleId,
    branchId: hkt.id,
    stationId: station.id,
    channel: process.argv[3] || undefined,
    items: [{ id: v7(), productId: product.id, quantity: 1 }],
    customerNickname: 'ZZ TEST SCRUM-1010',
  }, { 'idempotency-key': `zz-s1010-commit-${saleId}` });
  console.log('commit', commit.status, JSON.stringify(commit.body?.error ?? null));
  assert.equal(commit.status, 200);
  const paid = await till.call('POST', `/sales/${saleId}/finalise`, {}, { 'idempotency-key': `zz-s1010-finalise-${saleId}` });
  console.log('finalise', paid.status, JSON.stringify(paid.body?.error ?? null));
  const read = await till.call('GET', `/sales/${saleId}`);
  const sale = read.body?.sale ?? read.body;
  receipt.steps.sale = {
    at: new Date().toISOString(),
    bangkokCalendarDate: bangkokDate(),
    station: { id: station.id, name: station.name },
    product: { code: product.code, name: product.name },
    pricing: pricing.body,
    commitStatus: commit.status,
    finaliseStatus: paid.status,
    readStatus: read.status,
    sale: sale ? { id: sale.id, status: sale.status, businessDate: sale.businessDate, occurredAt: sale.occurredAt,
      receiptNo: sale.receiptNo ?? sale.receiptNumber ?? null, grossSatang: sale.grossSatang ?? sale.totals?.grossSatang ?? null,
      pricingMode: sale.pricingMode ?? null } : null,
    session: await till.signOut(),
  };
  save();
  console.log(JSON.stringify(receipt.steps.sale, null, 1));
}

if (phase === 'console') {
  // The Console's Branches page, HKT Central's Edit drawer: "Business day start".
  const label = process.argv[3] ?? 'after';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' });
  const page = await ctx.newPage();
  const signIn = await page.request.post(CONSOLE + '/api/auth/sign-in', {
    data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') },
  });
  assert.equal(signIn.status(), 200, 'Console sign-in');
  await page.goto(CONSOLE + '/organisation/branches', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const row = page.locator('tr, li, div').filter({ hasText: 'Central Floresta' }).filter({ has: page.getByRole('button', { name: 'Edit' }) }).last();
  await row.getByRole('button', { name: 'Edit' }).first().click();
  await page.waitForTimeout(2000);
  const field = page.locator('label', { hasText: 'Business day start' }).locator('input');
  const value = await field.inputValue();
  await field.scrollIntoViewIfNeeded();
  const file = resolve(out, `01-console-business-day-start-${label}.png`);
  await page.screenshot({ path: file });
  receipt.steps[`console-${label}`] = { at: new Date().toISOString(), value, file: file.slice(root.length + 1).split(String.fromCharCode(92)).join('/') };
  save();
  console.log('Business day start reads', value);
  const out1 = await page.request.post(CONSOLE + '/api/auth/sign-out');
  const me = await page.request.get(CONSOLE + '/api/me');
  console.log('sign-out', out1.status(), 'me after', me.status());
  await browser.close();
}

if (phase === 'till') {
  // The till at the ZZ TEST station: the pricing chip, then Today / End of Day.
  const label = process.argv[3] ?? 'after';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Bangkok' });
  const page = await ctx.newPage();
  await page.goto(POS, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const phone = need('STAGING_RECEPTION_PHONE');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(phone.replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: resolve(out, `zz-till-step1-${label}.png`) });
  const pick = page.getByRole('button', { name: STATION, exact: false }).first();
  if (await pick.count()) { await pick.click(); await page.waitForTimeout(6000); }
  const file = resolve(out, `02-till-pricing-chip-${label}.png`);
  await page.screenshot({ path: file });
  // End of Day, which opens on the day the platform names as today.
  await page.goto(POS + '/end-of-day', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  const eodFile = resolve(out, `03-till-end-of-day-${label}.png`);
  await page.screenshot({ path: eodFile });
  const rel = (p) => p.slice(root.length + 1).split(String.fromCharCode(92)).join('/');
  receipt.steps[`till-${label}`] = { at: new Date().toISOString(), bangkokCalendarDate: bangkokDate(), file: rel(file), endOfDay: rel(eodFile) };
  save();
  const outRes = await page.request.post(POS + '/api/auth/sign-out');
  const me = await page.request.get(POS + '/api/me');
  console.log('sign-out', outRes.status(), 'me after', me.status());
  await browser.close();
}

if (phase === 'finish') {
  // Close the ZZ TEST sale in cash with a pick-up code (food needs one).
  const saleId = receipt.steps.sale.sale.id;
  const stationId = receipt.steps.sale.station.id;
  const till = await apiAs(POS, 'RECEPTION');
  const seat = await till.call('PUT', '/me/session/station', { stationId });
  assert.equal(seat.status, 200);
  const paid = await till.call('POST', `/sales/${saleId}/finalise`, { pickupCode: 'Z1010' }, { 'idempotency-key': `zz-s1010-finalise-pickup-${saleId}` });
  console.log('finalise', paid.status, JSON.stringify(paid.body?.error ?? null));
  const read = await till.call('GET', `/sales/${saleId}`);
  const sale = read.body?.sale ?? read.body;
  const hkt = sale.branchId;
  const eod = await till.call('GET', `/branches/${hkt}/end-of-day?date=${sale.businessDate}`);
  receipt.steps.finish = {
    at: new Date().toISOString(),
    bangkokCalendarDate: bangkokDate(),
    finaliseStatus: paid.status,
    sale: { id: sale.id, status: sale.status, businessDate: sale.businessDate, occurredAt: sale.occurredAt,
      receiptNo: sale.receiptNo ?? sale.receiptNumber ?? null, grossSatang: sale.grossSatang ?? null, pricingMode: sale.pricingMode ?? null,
      businessDayStart: sale.businessDayStart ?? null },
    endOfDay: { status: eod.status, businessDate: eod.body?.businessDate ?? eod.body?.date ?? null, state: eod.body?.status ?? null },
    session: await till.signOut(),
  };
  save();
  console.log(JSON.stringify(receipt.steps.finish, null, 1));
}
