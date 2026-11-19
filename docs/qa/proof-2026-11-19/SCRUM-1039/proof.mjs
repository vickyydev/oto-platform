// SCRUM-1039 staging proof: the option editor has a wide name and one price.
// Run from the lane worktree after the Console and api deploys are live:
//   node docs/qa/proof-2026-11-19/SCRUM-1039/proof.mjs <phase> [full-sha]
// phases: reads | console | mixed | cleanup
// The one write is a shared modifier group named "ZZ TEST SCRUM-1039 sauces",
// made and deleted through the Console's own screens. An option holding two
// different stored prices is only looked at, never saved. No cookie, phone or
// password is printed or saved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = import.meta.dirname;
const root = resolve(out, '../../../..');
const helperRoot = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/render.mjs')));
const { chromium, request } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const CONSOLE = 'https://oto-console-staging.onrender.com';
const GROUP = 'ZZ TEST SCRUM-1039 sauces';
const LONG = 'ZZ TEST Extra-large sweet chilli and roasted garlic dipping sauce';
const SHORT = 'ZZ TEST No sauce';
const receiptFile = resolve(out, 'receipt.json');
const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : { unit: 'SCRUM-1039', steps: {} };
const save = () => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
mkdirSync(out, { recursive: true });
const rel = (p) => p.slice(root.length + 1).split(String.fromCharCode(92)).join('/');
const phase = process.argv[2];
const sha = process.argv[3];

async function deployments(names) {
  const result = {};
  for (const name of names) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
    result[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
    if (sha) assert.equal(d?.commit?.id, sha, `${name} runs the proved source`);
    assert.equal(d?.status, 'live', `${name} is live`);
  }
  return result;
}

async function apiAsAdmin() {
  const ctx = await request.newContext({ baseURL: CONSOLE });
  const r = await ctx.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } });
  assert.equal(r.status(), 200, 'admin sign-in');
  const call = async (method, path, data, headers = {}) => {
    const res = await ctx.fetch('/api' + path, { method, data, headers });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status(), body };
  };
  const signOut = async () => { await ctx.post('/api/auth/sign-out'); const me = await ctx.get('/api/me'); await ctx.dispose(); return me.status(); };
  return { call, signOut };
}

/** Every option on the operator's menus, with its stored prices, by park. */
async function readOptions(admin) {
  const branches = (await admin.call('GET', '/branches')).body?.branches ?? [];
  const parks = branches.filter((b) => !b.archived && !b.archivedAt);
  const rows = [];
  for (const park of parks) {
    const menu = (await admin.call('GET', `/branches/${park.id}/menu`)).body ?? {};
    const products = new Map((menu.products ?? []).map((p) => [p.id, p]));
    for (const g of menu.modifierGroups ?? []) {
      for (const o of g.options ?? []) {
        rows.push({
          park: park.name, parkId: park.id, groupId: g.id, group: g.name, productId: g.productId ?? null,
          product: g.productId ? products.get(g.productId)?.name ?? null : null,
          productArchived: g.productId ? Boolean(products.get(g.productId)?.archivedAt) : null,
          optionId: o.id, option: o.name, priceSatang: o.priceSatang, priceWeekendSatang: o.priceWeekendSatang ?? null,
        });
      }
    }
  }
  return { parks: parks.map((p) => ({ id: p.id, name: p.name, code: p.code })), rows };
}
const twoPrices = (r) => r.priceWeekendSatang !== null && r.priceWeekendSatang !== r.priceSatang;

async function consolePage() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  const signIn = await page.request.post(CONSOLE + '/api/auth/sign-in', {
    data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') },
  });
  assert.equal(signIn.status(), 200, 'Console sign-in');
  const close = async () => {
    const o = await page.request.post(CONSOLE + '/api/auth/sign-out');
    const me = await page.request.get(CONSOLE + '/api/me');
    await browser.close();
    return { signOut: o.status(), meAfter: me.status() };
  };
  return { page, close };
}

if (phase === 'reads') {
  const admin = await apiAsAdmin();
  const { parks, rows } = await readOptions(admin);
  receipt.steps.reads = {
    at: new Date().toISOString(),
    deployments: await deployments(['oto-api-staging', 'oto-console-staging']),
    parks,
    optionCount: rows.length,
    twoPriceOptions: rows.filter(twoPrices),
    zzGroupBefore: rows.filter((r) => r.group === GROUP).length,
    meAfterSignOut: await admin.signOut(),
  };
  save();
  console.log(JSON.stringify({ ...receipt.steps.reads, parks: parks.length }, null, 1));
}

if (phase === 'console') {
  const { page, close } = await consolePage();
  await page.goto(CONSOLE + '/catalogue/modifiers', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Shared modifier groups' }).waitFor();
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Group name').fill(GROUP);
  await dialog.getByLabel('Option name').first().fill(LONG);
  await dialog.getByLabel('Option price delta').first().fill('20');
  await dialog.getByLabel('Option cost').first().fill('6');
  await dialog.getByRole('button', { name: 'Add option', exact: true }).click();
  await dialog.getByLabel('Option name').nth(1).fill(SHORT);
  await dialog.getByLabel('Option price delta').nth(1).fill('0');
  const shot1 = resolve(out, '01-console-new-group-wide-name-one-price.png');
  await dialog.screenshot({ path: shot1 });
  const fields = {
    nameWidth: await dialog.getByLabel('Option name').first().evaluate((el) => el.getBoundingClientRect().width),
    priceWidth: await dialog.getByLabel('Option price delta').first().evaluate((el) => el.getBoundingClientRect().width),
    priceFieldsPerOption: await dialog.getByLabel('Option price delta').count() / 2,
    oldWeekdayField: await dialog.getByLabel('Option weekday price delta').count(),
    oldWeekendField: await dialog.getByLabel('Option weekend price delta').count(),
  };
  await dialog.getByRole('button', { name: 'Add group', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('cell', { name: GROUP, exact: true }).waitFor();
  // Open it again: what was saved, as the editor reads it back.
  await page.getByRole('button', { name: `Edit ${GROUP}`, exact: true }).click();
  const again = page.getByRole('dialog');
  await again.getByLabel('Option name').first().waitFor();
  const reopened = {
    names: await again.getByLabel('Option name').evaluateAll((els) => els.map((e) => e.value)),
    prices: await again.getByLabel('Option price delta').evaluateAll((els) => els.map((e) => e.value)),
    costs: await again.getByLabel('Option cost').evaluateAll((els) => els.map((e) => e.value)),
  };
  const shot2 = resolve(out, '02-console-saved-group-reopened.png');
  await again.screenshot({ path: shot2 });
  await again.getByRole('button', { name: 'Cancel', exact: true }).click();
  receipt.steps.console = { at: new Date().toISOString(), fields, reopened, pictures: [rel(shot1), rel(shot2)], session: await close() };
  // What the platform holds for the new group: one price written to both days.
  const admin = await apiAsAdmin();
  const { rows } = await readOptions(admin);
  receipt.steps.console.stored = rows.filter((r) => r.group === GROUP)
    .map((r) => ({ park: r.park, option: r.option, priceSatang: r.priceSatang, priceWeekendSatang: r.priceWeekendSatang }));
  receipt.steps.console.meAfterSignOut = await admin.signOut();
  save();
  console.log(JSON.stringify(receipt.steps.console, null, 1));
}

if (phase === 'mixed') {
  // An option already holding two different stored prices, opened and left
  // unsaved. Shared groups open from Modifiers; a product's own group opens
  // from its menu item at its park.
  const target = (receipt.steps.reads?.twoPriceOptions ?? []).find((r) => r.productId === null)
    ?? (receipt.steps.reads?.twoPriceOptions ?? []).find((r) => r.productId && !r.productArchived);
  if (!target) {
    receipt.steps.mixed = { at: new Date().toISOString(), found: false };
    save();
    console.log('no option with two different stored prices on staging');
    process.exit(0);
  }
  const { page, close } = await consolePage();
  let dialog;
  if (target.productId === null) {
    await page.goto(CONSOLE + '/catalogue/modifiers', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Shared modifier groups' }).waitFor();
    await page.getByRole('button', { name: `Edit ${target.group}`, exact: true }).click();
    dialog = page.getByRole('dialog');
  } else {
    await page.goto(CONSOLE + '/catalogue/menu', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const chip = page.getByRole('combobox', { name: /Park/ });
    if (await chip.count()) await chip.first().selectOption({ label: target.park }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.getByRole('button', { name: `Edit ${target.product}`, exact: true }).first().click();
    dialog = page.getByRole('dialog');
  }
  const row = dialog.getByLabel('Option name').and(page.locator(`[value="${target.option.replace(/"/g, '\\"')}"]`));
  await row.first().waitFor();
  await row.first().scrollIntoViewIfNeeded();
  const shot = resolve(out, '03-console-two-stored-prices-untouched.png');
  await dialog.screenshot({ path: shot });
  const note = await dialog.getByText('Type a price to set both.').allTextContents();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const session = await close();
  const admin = await apiAsAdmin();
  const after = (await readOptions(admin)).rows.find((r) => r.optionId === target.optionId);
  receipt.steps.mixed = {
    at: new Date().toISOString(), found: true, target, notes: note, picture: rel(shot), session,
    afterRead: after ? { priceSatang: after.priceSatang, priceWeekendSatang: after.priceWeekendSatang } : null,
    unchanged: Boolean(after) && after.priceSatang === target.priceSatang && after.priceWeekendSatang === target.priceWeekendSatang,
    meAfterSignOut: await admin.signOut(),
  };
  save();
  console.log(JSON.stringify(receipt.steps.mixed, null, 1));
}

if (phase === 'cleanup') {
  const { page, close } = await consolePage();
  await page.goto(CONSOLE + '/catalogue/modifiers', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Shared modifier groups' }).waitFor();
  await page.getByRole('button', { name: `Delete ${GROUP}`, exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  await page.getByRole('cell', { name: GROUP, exact: true }).waitFor({ state: 'detached' });
  const session = await close();
  const admin = await apiAsAdmin();
  const left = (await readOptions(admin)).rows.filter((r) => r.group === GROUP).length;
  receipt.steps.cleanup = { at: new Date().toISOString(), session, zzOptionsLeft: left, meAfterSignOut: await admin.signOut() };
  save();
  console.log(JSON.stringify(receipt.steps.cleanup, null, 1));
}
