// Staging proof for four visual fixes landed together (SCRUM-879, 880, 881, 882).
// Adapted from the committed SCRUM-863 and SCRUM-858 harnesses (docs/qa/proof-2026-11-12/SCRUM-8{63,58}/staging).
// Own ZZ TEST till, invented ZZ TEST numbers (08987900xx), walk-in sales only, cash only.
// No credential, pairing code or raw response body enters the receipt or the console.
//
//   node proof.mjs <sha> <out-dir>
//
// As run on 12 November 2026 against the till at 6660dd4d: four runs, ZZ_BASE=11, 21, 31, 41 (out-01..04); every point passed
// in all four. The pictures and receipt.json here are run 4 (`ZZ_BASE=41 node proof.mjs <sha> out-04`); 03e-03g and
// receipt-run-03.json are run 3's Check-in pictures without the printer chip. Runs 1-3 refined the read-out close-up
// (scrolled into view), the cash-chosen pictures and the board masks.
//
// The staff theme is kept on the signed-in account (SCRUM-653) and the shared reception account is used by other
// proofs at the same time, so the harness never writes it: when the account follows the device ('system') the
// browser's colour scheme is switched; otherwise the root's light/dark class is switched in this page only, exactly
// as the theme controller paints it (packages/shared/src/ui-preferences.ts). The customer half's theme is this
// tab's own and is switched with the till's real Display toggle.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.OTO_REPO ?? resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const T = '879';
const base = Number(process.env.ZZ_BASE ?? 11);
const zz = i => '08987900' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { tickets: ['SCRUM-879', 'SCRUM-880', 'SCRUM-881', 'SCRUM-882'], sha, startedAt: new Date().toISOString(), phase: 'preflight',
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')) : null,
  points: {}, requests: [], created: [], checks: {}, odd: [], pageErrors: [], cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { await adminSignIn(); response = await once(); }
  const body = await response.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0], status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};

// ZZ TEST only; confirmed unused before use. readout = typed on the first screen only (never sent).
const numbers = { readout: zz(1), dropoff: zz(2), sale: zz(3) };
const longest = numbers.readout + '34567890'; // more than the keypad takes: it keeps what it accepts
receipt.numbers = numbers;
const spaced = n => `+66 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const fixtureName = `ZZ TEST SCRUM-${T} proof till ${Date.now()}`;
const childName = `ZZ TEST SCRUM-${T} child ${Date.now() % 100000}`;
const knownSales = new Set();
let browser = null, till = null, station = null, branchId = null, failed = false, themeMode = null;

const firstLine = error => `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`;
const masks = page => [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
  page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'), page.getByText(/^QR-[A-Z0-9]+$/),
  page.locator('div.grid.gap-px'), page.locator('span.font-mono.font-semibold'), page.getByText(/^Z\d{5}-[A-Z0-9]{4,8}$/)];
const shot = async (page, name, extra = []) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled', mask: [...masks(page), ...extra] });
  console.log('picture', name);
};
/** A close picture of one element, with a little room around it. */
async function closeUp(page, locator, name, pad = 16, extra = []) {
  try {
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    await page.screenshot({ path: resolve(out, name), animations: 'disabled',
      mask: [...masks(page), ...extra], clip: { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) } });
    console.log('picture', name);
    return { picture: name, width: Math.round(box.width), height: Math.round(box.height) };
  } catch (error) { return { picture: null, failure: firstLine(error) }; }
}
const point = (key, pass, picture, shows, seen = {}) => { receipt.points[key] = { pass, picture, shows, seen }; save(); console.log('POINT', key, pass ? 'PASS' : 'FAIL', '|', shows); if (!pass) console.log('  seen', JSON.stringify(seen).slice(0, 1500)); };
const odd = (what, extra = {}) => { receipt.odd.push({ at: receipt.phase, what, ...extra }); save(); console.log('ODD', what, JSON.stringify(extra).slice(0, 400)); };

function watch(page, label) {
  page.on('pageerror', e => { receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'pageerror', text: String(e.message).split('\n')[0].slice(0, 240) }); });
  page.on('console', m => { if (m.type() === 'error') receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'console.error', text: m.text().split('\n')[0].slice(0, 240) }); });
  page.on('response', r => {
    const u = new URL(r.url());
    if (r.status() >= 400 && /\/api\/|\/display\//.test(u.pathname)) receipt.pageErrors.push({ page: label, at: receipt.phase, kind: 'http',
      text: `${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} ${r.status()}` });
  });
}

const stationSales = async () => (await call('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`)).body.sales;
const newSales = async () => (await stationSales()).filter(s => !knownSales.has(s.id));
const halfOf = locator => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
const landing = page => page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first();
const paymentStep = () => till.getByTestId('payment-step');
const typeStep = () => till.getByRole('heading', { name: 'Select Customer Type', exact: true });
const keypad = async (scope, digits) => { for (const digit of digits) await scope.getByRole('button', { name: digit, exact: true }).last().click(); };
const fit = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), textCut: el.scrollWidth > el.clientWidth + 1, text: (el.textContent ?? '').trim().slice(0, 60) }; });

/** The colour an element's text paints and the colour behind it, composited through every see-through layer, and their WCAG contrast. */
const tone = locator => locator.evaluate(el => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = css => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const layers = [];
  for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
  let back = [255, 255, 255, 1];
  for (const layer of layers.reverse()) back = over(layer, back);
  const style = getComputedStyle(el);
  const ink = over([...rgba(style.color).slice(0, 3), rgba(style.color)[3] * Number(style.opacity)], back);
  const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [hi, lo] = [lum(ink), lum(back)].sort((a, b) => b - a);
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  return { text: (el.textContent ?? '').trim().slice(0, 50), color: style.color, ink: hex(ink), background: hex(back), contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
    rootClass: document.documentElement.className.split(/\s+/).filter(c => c === 'dark' || c === 'light').join(' ') };
});

async function signInAtTill(page, phone, password) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(phone.replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pick = page.getByRole('button', { name: fixtureName, exact: false }).first();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const deadline = Date.now() + 60000; let steady = 0;
  while (Date.now() < deadline) {
    if (await picker.isVisible()) { if (await pick.isVisible()) { await pick.click(); break; } steady = 0; }
    else if (await landing(page).isVisible()) { steady += 1; if (steady >= 6) break; } else steady = 0;
    await page.waitForTimeout(500);
  }
  await page.locator('a[href="/history"]').first().waitFor();
  await landing(page).waitFor({ timeout: 15000 }).catch(async () => { await page.goto('/'); await landing(page).waitFor(); });
}

// ---- theme ----
async function staffPreference() {
  await till.getByRole('button', { name: 'Theme settings', exact: true }).first().click();
  const staff = till.getByRole('button', { name: /^Switch staff theme to/ });
  await staff.waitFor();
  const preference = await staff.getAttribute('data-theme-preference');
  await till.keyboard.press('Escape');
  return preference;
}
async function setDisplayTheme(want) {
  await till.getByRole('button', { name: 'Theme settings', exact: true }).first().click();
  const toggle = till.getByRole('button', { name: /^Switch display theme to/ });
  await toggle.waitFor();
  if (await toggle.getAttribute('data-theme-preference') !== want) await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme-preference', want);
  await till.keyboard.press('Escape');
}
async function setTheme(want) {
  if (themeMode === 'system') await till.emulateMedia({ colorScheme: want });
  else await till.evaluate(w => { const r = document.documentElement; r.classList.toggle('dark', w === 'dark'); r.classList.toggle('light', w === 'light'); }, want);
  await setDisplayTheme(want);
  await till.waitForTimeout(500);
  const painted = await till.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  assert.equal(painted, want, `the staff screens paint ${want}`);
}

// ---- the first screen, the walk-in, the ticket ----
async function firstScreenScope() {
  await landing(till).waitFor();
  if (await till.getByTestId('language-choice').isVisible()) await till.getByTestId('language-choice-en').click();
  await till.getByTestId('identify-safety').waitFor();
  return halfOf(till.getByTestId('identify-safety'));
}
async function clearReadout(scope) {
  const clear = scope.getByRole('button', { name: 'Clear', exact: true }).last();
  if (await clear.isVisible().catch(() => false)) await clear.click();
}
async function readout(scope, name) {
  const box = scope.locator('div.tracking-wider').first();
  // The customer half scrolls while the keypad is pressed: bring the read-out back into view first.
  await box.scrollIntoViewIfNeeded();
  await till.waitForTimeout(300);
  const measured = await box.evaluate(el => {
    const span = el.querySelector('span');
    const lh = parseFloat(getComputedStyle(span).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
    const sr = span.getBoundingClientRect(), br = el.getBoundingClientRect();
    return { text: el.innerText.replace(/\s+/g, ' ').trim(), fontSizePx: parseFloat(getComputedStyle(el).fontSize), sizeClass: [...el.classList].find(c => /^text-(base|lg|xl|2xl|3xl)$/.test(c)) ?? null,
      lines: Math.round(sr.height / lh), spanWidth: Math.round(sr.width), spanRight: Math.round(sr.right), boxWidth: Math.round(br.width), boxRight: Math.round(br.right),
      boxHeight: Math.round(br.height), insideTheBox: sr.right <= br.right + 0.5 && sr.left >= br.left - 0.5 && sr.top >= br.top - 0.5 && sr.bottom <= br.bottom + 0.5,
      overflowsItsBox: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 };
  });
  measured.closeUp = await closeUp(till, box.locator('xpath=..'), name, 20);
  return measured;
}
async function identifyWalkIn(scope, number) {
  await clearReadout(scope);
  await keypad(scope, number);
  const whatsapp = scope.getByTitle('WhatsApp', { exact: true });
  if (await whatsapp.isVisible().catch(() => false)) await whatsapp.click();
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = till.getByRole('dialog', { name: 'New member?', exact: true });
  await expect(offer).toContainText(spaced(number));
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  await typeStep().waitFor();
}
async function ticket(kids, adults) {
  await till.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
  const quantity = async (label, target) => {
    const add = till.getByRole('button', { name: `Add one ${label}`, exact: true }).first();
    const remove = till.getByRole('button', { name: `Remove one ${label}`, exact: true }).first();
    const value = add.locator('xpath=preceding-sibling::span[1]');
    for (let count = 0; count < 8; count++) {
      const current = Number(await value.textContent());
      if (current === target) return;
      await (current < target ? add : remove).click();
      await till.waitForTimeout(200);
    }
    assert.equal(Number(await value.textContent()), target);
  };
  await quantity('Kids', kids); await quantity('Adults', adults);
  await till.getByRole('button', { name: 'Continue', exact: true }).first().click();
}
async function setAge(page, scope, age) {
  await scope.getByRole('button', { name: /Tap to set age/ }).last().click();
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: String(age), exact: true }).click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /^Jan/ }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: '1', exact: true }).first().click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: /Confirm/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function cancelSale() {
  let how = 'reload';
  const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) {
    await cancel.click(); how = 'Cancel button';
    const back = await landing(till).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!back) { how = 'Cancel button, then reload'; await till.goto('/'); }
  } else await till.goto('/');
  await landing(till).waitFor();
  return how;
}

// ---- the three amber surfaces (SCRUM-879) ----
const banner = () => till.getByText('Hide customer display', { exact: true }).locator('xpath=ancestor::div[contains(@class, "border-b")][1]');
const overdueBar = () => till.getByRole('button', { name: /overdue|due soon/ }).filter({ hasText: 'Review' }).first();
const beforePayment = () => till.getByText('Before payment', { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]');
async function amberTones(theme, prefix) {
  const seen = { theme };
  seen.banner = { label: await tone(banner().locator('span.truncate').first()), hideButton: await tone(till.getByText('Hide customer display', { exact: true })) };
  seen.bannerPicture = await closeUp(till, banner(), `${prefix}-banner-hide-customer-display-${theme}.png`, 0);
  if (await overdueBar().isVisible().catch(() => false)) {
    seen.overdue = { bar: await tone(overdueBar().locator('span').first()), review: await tone(overdueBar().getByText(/Review/)) };
    seen.overduePicture = await closeUp(till, overdueBar(), `${prefix}-overdue-bar-review-${theme}.png`, 8);
  } else seen.overdue = 'no overdue or due-soon child on the branch board now: the bar is not drawn';
  if (await beforePayment().isVisible().catch(() => false)) {
    seen.beforePayment = { heading: await tone(till.getByText('Before payment', { exact: true })), items: [] };
    for (const li of await beforePayment().locator('li').all()) seen.beforePayment.items.push(await tone(li));
    seen.beforePaymentPicture = await closeUp(till, beforePayment(), `${prefix}-before-payment-list-${theme}.png`, 12);
  } else seen.beforePayment = 'not on screen';
  return seen;
}

// ---- point 1 + 2 + 5a: first screen, read-out, the drop-off step in light and dark ----
async function passDropOff() {
  phase('first screen (light): banner and overdue bar; the read-out');
  await till.goto('/');
  const scope = await firstScreenScope();
  await till.waitForTimeout(1500);
  await shot(till, '01a-first-screen-light-banner-overdue.png');
  // Point 2 (SCRUM-880): ten digits with the leading 0, then the longest the keypad takes.
  await clearReadout(scope);
  await keypad(scope, numbers.readout);
  const ten = await readout(scope, '02a-readout-ten-digits-leading-zero.png');
  await shot(till, '02b-first-screen-ten-digits-full.png');
  await clearReadout(scope);
  await keypad(scope, longest);
  const long = await readout(scope, '02c-readout-longest-the-keypad-takes.png');
  long.digitsAccepted = long.text.replace(/^\+66\s*/, '').replace(/\D/g, '').length;
  await shot(till, '02d-first-screen-longest-full.png');
  const ok2 = ten.lines === 1 && ten.insideTheBox && !ten.overflowsItsBox && ten.text.replace(/\s/g, '') === '+66' + numbers.readout
    && long.lines === 1 && long.insideTheBox && !long.overflowsItsBox;
  point('2', ok2, '02a-readout-ten-digits-leading-zero.png', `First screen, customer half: "${ten.text}" reads on one line inside its box (${ten.sizeClass}); the longest the keypad takes, ${long.digitsAccepted} digits, "${long.text}", one line (${long.sizeClass}) — 02c`, { ten, long });

  phase('walk-in, customer type step, ticket with one child and no adult');
  await identifyWalkIn(scope, numbers.dropoff);
  await till.waitForTimeout(800);
  await shot(till, '05a-customer-type-step-light.png');
  await ticket(1, 0);
  await till.getByRole('heading', { name: 'Children playing alone', exact: true }).waitFor({ timeout: 30000 });
  const nameField = till.getByPlaceholder('Full name', { exact: true }).first();
  await nameField.waitFor();
  const half = halfOf(nameField);
  await nameField.fill(childName);
  await setAge(till, half, 6);
  await half.getByPlaceholder('Your full name', { exact: true }).waitFor();
  await till.waitForTimeout(800);
  await beforePayment().waitFor({ timeout: 15000 }).catch(() => {});
  await shot(till, '01b-dropoff-step-light.png');
  const light = await amberTones('light', '01c');

  phase('the same step on dark');
  await setTheme('dark');
  await shot(till, '01d-dropoff-step-dark.png');
  const dark = await amberTones('dark', '01e');
  await setTheme('light');
  await till.waitForTimeout(500);

  // Readable on light: every amber text at least 4.5:1; dark: the classes the prototype had (amber-300 / amber-200 at 90 %).
  const all = s => [s.banner?.label, s.banner?.hideButton, s.overdue?.bar, s.overdue?.review, s.beforePayment?.heading, ...(s.beforePayment?.items ?? [])].filter(x => x && typeof x === 'object');
  const lowest = s => Math.min(...all(s).map(x => x.contrast));
  const darkTones = all(dark).map(x => x.ink);
  const ok1 = typeof light.beforePayment === 'object' && light.beforePayment.items.length > 0 && lowest(light) >= 4.5 && typeof dark.beforePayment === 'object' && lowest(dark) >= 4.5;
  point('1', ok1, '01b-dropoff-step-light.png', `Drop-off step at 1440x900: the banner, the overdue bar and the "Before payment" list on light (lowest contrast ${lowest(light)}:1) and dark (01d, lowest ${lowest(dark)}:1); close-ups 01c-*/01e-*`, { light, dark, darkInks: darkTones });

  phase('leave the drop-off step without writing anything: Back, then cancel the sale');
  await till.getByRole('button', { name: 'Back', exact: true }).first().click().catch(() => {});
  await till.waitForTimeout(800);
  receipt.checks.leftDropOff = await cancelSale();
}

// ---- point 4 + 5: an ordinary sale, the payment step, paid in cash ----
async function passSale() {
  phase('ordinary sale: walk-in, one child and one adult');
  await till.goto('/');
  const scope = await firstScreenScope();
  const mark = (await stationSales()).map(s => s.id);
  mark.forEach(id => knownSales.add(id));
  await identifyWalkIn(scope, numbers.sale);
  await ticket(1, 1);
  await expect(paymentStep()).toBeVisible({ timeout: 30000 });
  await till.waitForTimeout(1500);
  const measure = async () => {
    const tiles = {};
    for (const m of ['Cash', 'Card', 'PromptPay']) {
      const h = till.getByRole('heading', { name: m, exact: true }).first();
      tiles[m] = await h.evaluate(el => { const r = el.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(el).lineHeight); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), lines: Math.round(r.height / lh), cut: el.scrollWidth > el.clientWidth + 1 }; });
    }
    const confirm = await fit(till.getByRole('button', { name: 'Confirm Payment Received', exact: true }));
    const back = await fit(till.getByRole('button', { name: 'Back', exact: true }).first());
    const scroll = await paymentStep().evaluate(el => { let n = el; const s = []; while (n) { if (n.scrollTop) s.push(n.scrollTop); n = n.parentElement; } return { scrolled: s.length > 0, pageY: window.scrollY }; });
    const rows = [...new Set(Object.values(tiles).map(t => t.y))].length;
    return { tiles, rows, confirm, back, scroll, viewport: till.viewportSize() };
  };
  const split = await measure();
  await shot(till, '04a-payment-step-split-view-light.png');
  const tilesClose = await closeUp(till, till.getByRole('heading', { name: 'Select Payment Method', exact: true }).locator('xpath=..'), '04b-payment-tiles-split-view-close.png', 8);
  phase('the same step with the customer display hidden');
  await till.getByText('Hide customer display', { exact: true }).click();
  await till.getByText('Show customer display', { exact: true }).waitFor();
  await till.waitForTimeout(800);
  const alone = await measure();
  await shot(till, '04c-payment-step-customer-display-hidden.png');
  await till.getByText('Show customer display', { exact: true }).click();
  await till.getByText('Hide customer display', { exact: true }).waitFor();
  await till.waitForTimeout(600);
  const inView = f => f.y >= 0 && f.bottom <= 900;
  const ok4 = Object.values(split.tiles).every(t => t.lines === 1 && !t.cut) && split.rows === 2 && split.tiles.Cash.y === split.tiles.Card.y && split.tiles.PromptPay.y > split.tiles.Cash.y
    && inView(split.confirm) && inView(split.back) && !split.scroll.scrolled && alone.rows === 1 && Object.values(alone.tiles).every(t => t.lines === 1 && !t.cut);
  let sale = null;
  await expect.poll(async () => { sale = (await newSales()).find(x => ['tendering', 'open'].includes(x.status)); return Boolean(sale); }, { timeout: 30000 }).toBe(true);
  receipt.created.push({ kind: 'sale', id: sale.id }); save();
  phase('pay cash');
  await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20000 });
  await till.waitForTimeout(1000);
  const cashChosen = { confirm: await fit(confirm), back: await fit(till.getByRole('button', { name: 'Back', exact: true }).first()),
    panel: await confirm.evaluate(el => { for (let n = el.parentElement; n; n = n.parentElement) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) return { scrolls: true, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight, scrollTop: n.scrollTop }; } return { scrolls: false }; }) };
  await shot(till, '04d-payment-step-cash-chosen.png');
  if (cashChosen.confirm.bottom > 900) odd(`once Cash is chosen the cash panel opens and Confirm Payment Received moves to y=${cashChosen.confirm.y}..${cashChosen.confirm.bottom}, below the 900-high window: staff scroll the left panel to reach it`, { cashChosen, picture: '04d-payment-step-cash-chosen.png' });
  await confirm.scrollIntoViewIfNeeded();
  await till.waitForTimeout(400);
  await shot(till, '04e-payment-step-cash-chosen-scrolled-to-confirm.png');
  const beforeClick = await fit(confirm);
  await confirm.click();
  await till.getByText('Payment Successful', { exact: true }).waitFor({ timeout: 45000 });
  await till.waitForTimeout(1500);
  await shot(till, '05b-ordinary-sale-paid-cash.png');
  const paid = (await call('GET', `/sales/${sale.id}`)).body.sale;
  knownSales.add(sale.id);
  point('4', ok4, '04a-payment-step-split-view-light.png', `Payment step, split view 1440x900, light: Cash and Card on one row, PromptPay below, each name on one line; Confirm Payment Received ends at y=${split.confirm.bottom} and Back at y=${split.back.bottom} (window 900), nothing scrolled; display hidden (04c): ${alone.rows} row of three`, { split, alone, tilesClose, cashChosen, confirmBeforeClick: beforeClick });
  point('5', paid.status === 'finalised', '05b-ordinary-sale-paid-cash.png', `Ordinary walk-in sale (one child, one adult) paid in cash: ${paid.status}, receipt ${paid.receiptNumber ?? '?'}, ${paid.totals?.grossSatang / 100} baht; customer type step 05a and the drop-off form 01b as before`, { sale: { id: paid.id, status: paid.status, receipt: paid.receiptNumber ?? null, grossSatang: paid.totals?.grossSatang ?? null } });
}

// ---- point 3: the Check-in tab at 1440 and 1280, with the printer chip if a job is waiting ----
async function headerState() {
  return till.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].find(n => n.querySelector('a[href="/history"]') || /History/.test(n.textContent ?? ''));
    const band = nav.getBoundingClientRect();
    const tabs = [...nav.children].map(el => { const r = el.getBoundingClientRect(); return { label: (el.textContent ?? '').trim(), active: el.tagName === 'SPAN',
      whole: r.left >= band.left - 0.5 && r.right <= band.right + 0.5, outLeft: r.right <= band.left + 1, partLeft: r.left < band.left - 0.5 && r.right > band.left + 1,
      outRight: r.left >= band.right - 1, partRight: r.right > band.right + 0.5 && r.left < band.right - 1 }; });
    const chip = [...document.querySelectorAll('header *, body *')].find(el => el.children.length === 0 && /\bjobs? waiting\b|paper low|cover open|offline/i.test(el.textContent ?? '') && el.getBoundingClientRect().top < 120);
    return { band: { left: Math.round(band.left), right: Math.round(band.right), width: Math.round(band.width), scrollLeft: Math.round(nav.scrollLeft), scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth },
      tabs, active: tabs.find(t => t.active), printerChip: chip ? (chip.textContent ?? '').trim().slice(0, 80) : null };
  });
}
// Every family card on the board (each has its own Message button) and every photo: the board holds other people's records.
const boardMasks = () => [till.locator('div').filter({ has: till.getByRole('button', { name: 'Message', exact: true }) }).filter({ hasNot: till.locator('header, nav') }).filter({ hasNotText: 'Search child, parent or phone' }).filter({ hasNotText: 'Upcoming' }), till.locator('main img, [class*="rounded"] img')];
async function passCheckIn() {
  phase('Check-in tab at 1440: catch the printer chip while the sale\'s jobs are queued');
  const next = till.getByRole('button', { name: 'Start New Sale' });
  if (await next.isVisible().catch(() => false)) await next.click();
  await till.getByRole('button', { name: 'Check-in', exact: true }).first().click();
  await till.waitForURL(/drop-off|check/);
  let state = await headerState(); const deadline = Date.now() + 20000; const seenChips = [];
  while (Date.now() < deadline) { state = await headerState(); if (state.printerChip) { seenChips.push(state.printerChip); if (/waiting/.test(state.printerChip)) break; } await till.waitForTimeout(700); }
  const at1440 = state;
  await shot(till, '03a-checkin-tab-1440.png', boardMasks());
  at1440.headerPicture = await closeUp(till, till.locator('nav').filter({ hasText: 'History' }).first(), '03b-checkin-tab-band-1440.png', 6);
  phase('Check-in tab at 1280');
  await till.setViewportSize({ width: 1280, height: 900 });
  await till.waitForTimeout(1200);
  const at1280 = await headerState();
  await shot(till, '03c-checkin-tab-1280.png', boardMasks());
  at1280.headerPicture = await closeUp(till, till.locator('nav').filter({ hasText: 'History' }).first(), '03d-checkin-tab-band-1280.png', 6);
  await till.setViewportSize({ width: 1440, height: 900 });
  await till.waitForTimeout(600);
  const scrolledOut = s => s.tabs.filter(t => t.outLeft || t.partLeft).map(t => t.label);
  const ok3 = at1440.active?.label === 'Check-in' && at1440.active.whole && at1280.active?.label === 'Check-in' && at1280.active.whole;
  point('3', ok3, '03a-checkin-tab-1440.png', `Check-in reads whole at 1440 (band scrolled ${at1440.band.scrollLeft}px; printer chip: ${at1440.printerChip ?? 'none shown'}) and at 1280 (03c, band scrolled ${at1280.band.scrollLeft}px); out of view at the left — 1440: ${scrolledOut(at1440).join(', ') || 'none'}; 1280: ${scrolledOut(at1280).join(', ') || 'none'}`, { at1440, at1280, chipsSeen: [...new Set(seenChips)] });
  if (scrolledOut(at1280).length || scrolledOut(at1440).length) odd('the tab band starts part-way: tabs to the left of Check-in are scrolled out of view (the side effect the builder reported)', { at1440: scrolledOut(at1440), at1280: scrolledOut(at1280) });
  await till.goto('/'); await landing(till).waitFor();
}

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    (receipt.failures ??= []).push({ pass: key, failedAt: receipt.phase, failure: firstLine(error) });
    save(); console.log('PASS FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (till) await shot(till, `failed-${key}-till.png`).catch(() => {});
    try {
      const cancel = till.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await cancel.isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await till.waitForTimeout(3000); }
    } catch { /* cleanup below reads the sales back */ }
    await till.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await till.goto('/').catch(() => {});
  }
};

try {
  phase('sign in and create own till');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  assert.ok(branch); branchId = branch.id;
  const boxes = (await call('GET', `/branches/${branchId}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  const stations = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: printerSource.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  for (const phone of Object.values(numbers)) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  const made = await call('POST', `/branches/${branchId}/stations`, { name: fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); station = made.body.station;
  assert.equal(station.name, fixtureName);
  receipt.created.push({ kind: 'station', id: station.id, name: fixtureName, prefix }); save();

  const video = resolve(import.meta.dirname, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const tillContext = await browser.newContext({ baseURL: pos, viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', colorScheme: 'light', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  till = await tillContext.newPage();
  watch(till, 'till');
  await till.goto(pos);
  phase('reception account signs in at the own till (new browser profile)');
  await signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.(js|css)(\?|$)/.test(n)))];
    const found = { files: urls.map(u => u.split('/').pop().split('?')[0]), markers: {} };
    const markers = { s879HideButton: 'h-7 text-amber-800 hover:text-amber-900 dark:text-amber-300', s879BeforePaymentItems: 'text-amber-900/90 dark:text-amber-200/90',
      s881BandScroll: 'scrollLeft-=', s882ContainerTiles: '@container', s880NoWrapReadout: 'whitespace-nowrap' };
    for (const key of Object.keys(markers)) found.markers[key] = 0;
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      for (const [key, marker] of Object.entries(markers)) found.markers[key] += text.split(marker).length - 1;
    }
    return found;
  });
  save();
  console.log('bundle', JSON.stringify(receipt.checks.bundle.markers));
  assert.ok(receipt.checks.bundle.markers.s879HideButton >= 1 && receipt.checks.bundle.markers.s879BeforePaymentItems >= 1, 'the till serves the SCRUM-879 bundle');
  const preference = await staffPreference();
  themeMode = preference === 'system' ? 'system' : 'class';
  receipt.checks.theme = { accountPreference: preference, darkSwitchedBy: themeMode === 'system' ? 'the browser colour scheme (the account follows the device)' : 'the root class in this page only (the account preference is not written)' };
  save();

  await attempt('dropoff', passDropOff);
  await attempt('sale', passSale);
  await attempt('checkin', passCheckIn);
  receipt.passed = !failed && ['1', '2', '3', '4', '5'].every(k => receipt.points[k]?.pass === true);
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, failure: firstLine(error) };
  console.log('RUN FAILED', '|', receipt.phase, '|', firstLine(error));
  if (till) await shot(till, 'failed-run-till.png').catch(() => {});
} finally {
  phase('clean up');
  const clean = async (step, action) => {
    try { await action(); }
    catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, failure: firstLine(error) }); console.log('CLEANUP FAILED', step, '|', firstLine(error)); }
    save();
  };
  await clean('no drop-off registration of this proof', async () => {
    const regs = (await call('GET', `/checkin/registrations?branchId=${branchId}`)).body.registrations ?? [];
    const mine = regs.filter(r => (r.children ?? []).some(c => c.childName === childName));
    receipt.cleanup.push({ kind: 'registrations-of-this-proof', count: mine.length });
    assert.equal(mine.length, 0);
  });
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => {
      const own = (await call('GET', `/stations/${station.id}`)).body.station;
      assert.equal(own.name, fixtureName); ownsStation = true;
    });
    if (ownsStation) {
      let sales = [];
      await clean('read own sales', async () => {
        sales = await stationSales();
        for (const sale of sales) assert.equal(sale.stationId, station.id);
      });
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        assert.equal((await call('GET', `/sales/${sale.id}`)).body.sale.status, 'voided');
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided', by: 'cleanup' });
      });
      for (const { id } of sales.filter(s => s.status === 'finalised')) await clean(`print ${id}`, async () => {
        let jobs;
        await expect.poll(async () => { jobs = (await call('GET', `/sales/${id}`)).body.printJobs; return jobs.every(j => j.status === 'printed'); }, { timeout: 60000 }).toBe(true);
        receipt.cleanup.push({ kind: 'finalised-test-sale', id, retained: true, printJobs: jobs.map(j => ({ id: j.id, status: j.status })) });
      });
      await clean('final sales read-back', async () => {
        const final = await stationSales();
        receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map(s => ({ id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? null })) });
        assert.ok(final.every(s => ['finalised', 'voided'].includes(s.status)));
      });
      await clean('retire own till', async () => {
        assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
        assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
        const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
        assert.ok(retired.archived); assert.equal(retired.devices.length, 0);
        receipt.cleanup.push({ kind: 'station', id: station.id, archived: true, devices: 0 });
      });
    }
  }
  for (const [key, phone] of Object.entries(numbers)) await clean(`check test number ${key}`, async () => {
    const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member;
    if (member) {
      assert.ok(`${member.nickname ?? ''} ${member.name ?? ''}`.includes(`ZZ TEST SCRUM-${T}`), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
  });
  if (till) await clean('sign out till', async () => {
    const before = (await till.request.get('/api/me')).status();
    if (before === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await till.request.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'till-session', signedInBefore: before === 200, signedOut: true, me: 401 });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await admin.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true, me: 401 });
  });
  await browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, points: Object.fromEntries(Object.entries(receipt.points).map(([k, v]) => [k, v.pass])), odd: receipt.odd.length, pageErrors: receipt.pageErrors.length, cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;
