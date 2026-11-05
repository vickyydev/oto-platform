/**
 * SCRUM-762 / SCRUM-779 / SCRUM-764 local browser rehearsal, in Microsoft Edge.
 *
 * A real local API (embedded Postgres, dropped after), a ZZ TEST virtual box
 * run by the in-process edge agent, one ZZ TEST till on it, the Vite POS, and a
 * SEPARATE paired customer display in its own browser context — everything the
 * till and the display say to each other goes through the display session.
 * Every record is ZZ TEST; nothing reaches staging; no SMS.
 *
 *   762 — the display asks for the phone once, at the start, required, with
 *         the safety line and no Skip; the details screen shows the kept number.
 *   779 — a walk-in priced at the Thai rate by a document check enters their
 *         name on the display after Pay: ONE sale, under the new member, with
 *         its tier claim; nothing is left unpaid.
 *   764 — the drop-off form on the display, step by step, mirrored on the till;
 *         the agreement ticks are the family's alone.
 *
 * Run from apps/api with: pnpm exec tsx ../../docs/qa/proof-2026-11-05/s762-764/local/s762-764-local-rehearsal.mts
 */
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const lane = (process.env.S762_LANE ?? 'C:/oto-lanes/display762-20261105').replace(/\\/g, '/');
const imp = (p: string) => import(pathToFileURL(`${lane}/${p}`).href);
const H = await imp('apps/api/test/helpers.ts');
const BOX = await imp('apps/api/src/services/box.ts');
const ENV = await imp('apps/api/src/env.ts');
const posRequire = createRequire(`${lane}/apps/pos/package.json`);
const { chromium, expect } = posRequire('@playwright/test');

const free = () => new Promise<number>((resolve, reject) => {
  const s = netServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); assert.ok(a && typeof a !== 'string'); s.close(() => resolve(a.port)); });
});
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const apiPort = await free(), posPort = await free(), origin = `http://127.0.0.1:${posPort}`;
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: lane, encoding: 'utf8' }).trim();
const out = `${lane}/docs/qa/proof-2026-11-05/s762-764/local`;
mkdirSync(out, { recursive: true });
const r: Record<string, any> = { mode: 'local', browser: 'msedge', source, startedAt: new Date().toISOString(), cases: [], screens: [], outcome: 'incomplete' };
const save = () => writeFileSync(`${out}/receipt.json`, JSON.stringify(r, null, 2) + '\n');
save();

const ctx = await H.createTestContext({ env: { DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge', PGW_PROVIDER: 'simulator', ALLOWED_ORIGINS: origin, COOKIE_SECURE: 'false' } });
let vite: any, browser: any, code = 1;
let till: any, display: any;
try {
  await ctx.app.listen({ port: apiPort, host: '127.0.0.1' });
  const adminCookie = await H.signInAs(ctx.app, H.ADMIN.phone, H.ADMIN.password);
  const admin = async (method: string, url: string, payload?: unknown) => {
    const res = await ctx.app.inject({ method, url, payload: payload as any,
      headers: { cookie: adminCookie, ...(method === 'GET' ? {} : { 'idempotency-key': `zz-test-${randomUUID()}` }) } });
    assert.ok([200, 201].includes(res.statusCode), `${method} ${url.split('?')[0]}: ${res.statusCode} ${res.body.slice(0, 300)}`);
    return res.json();
  };
  const branchId = await H.branchIdByCode(ctx.db, H.CENTRAL_BRANCH_CODE);

  r.phase = 'fixture'; save();
  const slot = 'zz-test-762-local';
  const made = await admin('POST', `/branches/${branchId}/boxes`, { name: 'ZZ TEST SCRUM-762 virtual box', slot, role: 'virtual' });
  const boxId = made.box.id as string;
  process.env.BOX_AGENT_SLOT = slot;
  process.env.BOX_HEARTBEAT_INTERVAL_S = '5';
  const env = ENV.loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge', PGW_PROVIDER: 'simulator' });
  const agent = await BOX.startVirtualBox({ db: ctx.db, env, log: ctx.app.log, port: apiPort });
  assert.ok(agent, 'virtual box agent did not start');
  let online: any;
  for (let i = 0; i < 60 && !online; i += 1) {
    online = (await admin('GET', `/branches/${branchId}/boxes`)).boxes.find((b: any) => b.id === boxId && b.status === 'online');
    if (!online) await sleep(1000);
  }
  assert.ok(online, 'the ZZ TEST virtual box did not come online');
  const tillName = 'ZZ TEST SCRUM-762 till';
  const station = (await admin('POST', `/branches/${branchId}/stations`, { name: tillName, kind: 'till', codePrefix: 'ZDT', boxId,
    paymentRouting: { card: 'manual', qr: 'gateway' }, capabilities: [], accessScope: 'all_staff', staffAccountIds: [], devices: [] })).station;
  r.fixture = { boxId, stationId: station.id }; save();

  process.env.API_PORT = String(apiPort); process.env.POS_PORT = String(posPort);
  const { createServer: createVite } = await import(pathToFileURL(posRequire.resolve('vite')).href);
  vite = await createVite({ configFile: `${lane}/apps/pos/vite.config.ts`, root: `${lane}/apps/pos`, server: { port: posPort, host: '127.0.0.1', strictPort: true } });
  await vite.listen();
  // A real Microsoft Edge, as the counter runs it.
  browser = await chromium.launch({ channel: 'msedge' });
  r.browserVersion = browser.version();

  const shot = async (label: string, page: any) => {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
    await sleep(400);
    await page.screenshot({ path: `${out}/${label}.png`, fullPage: true, mask: [page.locator('input[type=password]')] });
    r.screens.push(`${label}.png`); save();
  };

  // The till: reception signs in and takes the ZZ TEST till.
  const tillContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  tillContext.setDefaultTimeout(30_000);
  const signIn = await tillContext.request.post(`${origin}/api/auth/sign-in`, { data: { phone: H.RECEPTION.phone, password: H.RECEPTION.password } });
  assert.equal(signIn.status(), 200);
  till = await tillContext.newPage();
  await till.goto(origin);
  await expect(till.getByRole('heading', { name: 'Which station are you on?' })).toBeVisible();
  await till.getByRole('button', { name: new RegExp(escapeRe(tillName)) }).click();
  await expect(till.getByText('Membership Check', { exact: true })).toBeVisible();
  // Before a display is paired, the till's own split view is the customer's screen.
  await shot('s762-00-harness-phone-first-no-skip', till);
  assert.equal(await till.getByRole('button', { name: /Skip/ }).count(), 0, 'a Skip is still offered');

  // The separate display, paired to this till.
  r.phase = 'pair display'; save();
  const displayContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  displayContext.setDefaultTimeout(30_000);
  display = await displayContext.newPage();
  await display.goto(`${origin}/display`);
  await expect(display.getByRole('heading', { name: 'Set up this display' })).toBeVisible();
  const pairingCode = (await display.getByTestId('display-pairing-code').textContent())?.trim();
  assert.ok(pairingCode && /^\d{6}$/.test(pairingCode));
  await admin('POST', `/stations/${station.id}/displays/claim`, { pairingCode, name: 'ZZ TEST SCRUM-762 display' });
  await expect(display.getByTestId('display-station')).toContainText(tillName, { timeout: 30_000 });

  // ── SCRUM-762: the number once, at the start, required ────────────────────
  r.phase = '762'; save();
  const cont = display.getByRole('button', { name: 'Continue', exact: true });
  await expect(cont).toBeVisible();
  await expect(cont).toBeDisabled();
  await expect(display.getByTestId('identify-safety')).toBeVisible();
  assert.equal(await display.getByRole('button', { name: /skip/i }).count(), 0);
  await shot('s762-01-display-phone-required-no-skip', display);
  await expect(till.getByTestId('identify-phone-required')).toBeVisible();
  await shot('s762-02-till-membership-check-no-skip', till);
  const walkInPhone = '812076290';
  for (const digit of walkInPhone) await display.getByRole('button', { name: digit, exact: true }).click();
  await expect(cont).toBeEnabled();
  await cont.click();
  // Nobody has this number: the till offers a profile; this family stays a walk-in.
  await till.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();

  // ── SCRUM-779: Thai rate by document, the name given after Pay ───────────
  r.phase = '779'; save();
  await till.getByRole('heading', { name: 'Thai', exact: true }).click();
  const verify = till.getByRole('dialog');
  await verify.getByRole('button', { name: 'Driving licence', exact: true }).click();
  await verify.getByRole('button', { name: /^Verify Thai/ }).click();
  await till.getByRole('heading', { name: '2 Hours Play', exact: true }).click();
  await till.getByRole('button', { name: 'Continue', exact: true }).click();
  const before = await admin('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`);
  await till.getByRole('button', { name: /^Pay ฿/ }).click();
  // The number is kept; the details screen asks only for the name the Thai rate's profile needs.
  await expect(display.getByTestId('input-kept-phone')).toBeVisible({ timeout: 30_000 });
  await expect(display.getByTestId('input-kept-phone')).toContainText(walkInPhone.slice(-4));
  await shot('s762-03-display-details-kept-phone-name-only', display);
  const guest = 'ZZ TEST Khun Nok';
  await display.getByPlaceholder('e.g. Mama, John').fill(guest);
  await display.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(till.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 30_000 });
  // The rate is saved to a new profile a moment after the sale was rung up, and the sale takes the member.
  let open: any[] = [];
  let member: any = null;
  for (let i = 0; i < 40; i += 1) {
    const listed = await admin('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`);
    open = listed.sales.filter((s: any) => !before.sales.some((b: any) => b.id === s.id));
    if (open.length === 1 && open[0].memberId) break;
    await sleep(500);
  }
  assert.equal(open.length, 1, `expected one sale, found ${open.length}`);
  const saleId = open[0].id as string;
  let detail = await admin('GET', `/sales/${saleId}`);
  assert.ok(detail.sale.memberId, 'the open sale did not take the member');
  member = (await admin('GET', `/members/${detail.sale.memberId}`)).member;
  assert.equal(member.nickname, guest);
  assert.equal(detail.sale.customerTier, 'thai');
  await shot('s779-01-payment-screen-one-sale-member-attached', till);
  await till.getByRole('heading', { name: 'Cash', exact: true }).click();
  await till.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(till.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 30_000 });
  const after = await admin('GET', `/sales?branchId=${branchId}&stationId=${station.id}&limit=50`);
  const fresh = after.sales.filter((s: any) => !before.sales.some((b: any) => b.id === s.id));
  detail = await admin('GET', `/sales/${saleId}`);
  assert.equal(fresh.length, 1, `the order was rung up ${fresh.length} times`);
  assert.equal(detail.sale.status, 'finalised');
  assert.equal(fresh.filter((s: any) => s.status === 'tendering').length, 0, 'a sale was left unpaid');
  await shot('s779-02-paid-one-sale', till);
  r.cases.push({ name: 'SCRUM-779 walk-in with Thai claim names themselves after Pay', saleId, salesRungUp: fresh.length,
    memberId: detail.sale.memberId, customerTier: detail.sale.customerTier, status: detail.sale.status, passed: true });
  r.cases.push({ name: 'SCRUM-762 phone once, required, kept on the details screen', passed: true }); save();
  // The till comes back with no "left unpaid" notice.
  await till.reload();
  await expect(till.getByText('Membership Check', { exact: true })).toBeVisible();
  await sleep(2500);
  assert.equal(await till.getByText(/left unpaid/i).count(), 0, 'the till found a sale left unpaid');
  await shot('s779-03-till-after-reload-nothing-left-unpaid', till);

  // ── SCRUM-764: the drop-off form on the display ───────────────────────────
  r.phase = '764'; save();
  await expect(display.getByTestId('identify-safety')).toBeVisible({ timeout: 30_000 });
  const parentPhone = '812076291';
  for (const digit of parentPhone) await display.getByRole('button', { name: digit, exact: true }).click();
  await display.getByRole('button', { name: 'Continue', exact: true }).click();
  await till.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  await till.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  await till.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
  // A child with no adult on the sale: Done adding opens the supervision gate.
  await till.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(till.getByRole('heading', { name: 'Children playing alone', exact: true })).toBeVisible({ timeout: 30_000 });
  const form = display.getByTestId('display-consent');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByTestId('consent-child')).toHaveCount(1);
  await shot('s764-01-display-form-opens-on-children-step', display);
  // The family names the child and picks the age on their own screen.
  await form.getByPlaceholder('Full name').fill('ZZ TEST Mai');
  await form.getByRole('button', { name: /Tap to set age/ }).click();
  const picker = display.getByRole('dialog');
  await picker.getByRole('button', { name: '4', exact: true }).click();
  await picker.getByRole('button', { name: 'Jan', exact: true }).click().catch(async () => picker.getByRole('button').filter({ hasText: /^Jan/ }).first().click());
  await picker.getByRole('button', { name: '5', exact: true }).click();
  await picker.getByRole('button', { name: /Confirm/ }).click();
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  // The till's gate shows what the family filled.
  await expect(till.getByPlaceholder("Child's name")).toHaveValue('ZZ TEST Mai', { timeout: 30_000 });
  await shot('s764-02-till-gate-mirrors-the-child', till);
  await expect(form.getByTestId('consent-care')).toBeVisible();
  await form.getByPlaceholder(/^e.g. peanut allergy/).fill('ZZ TEST peanuts');
  await shot('s764-03-display-care-step', display);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(form.getByTestId('consent-kept-phone')).toBeVisible();
  await form.getByLabel('Parent / guardian name', { exact: true }).fill('ZZ TEST Khun Ying');
  await form.getByTestId('consent-kept-phone').scrollIntoViewIfNeeded();
  await shot('s764-04a-display-agreements-number-from-the-start', display);
  for (const box of await form.getByRole('checkbox').all()) await box.check();
  await shot('s764-04-display-agreements-kept-phone', display);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  const status = till.getByTestId('consent-ticks-status');
  await expect(status).toContainText('Supervision and photo consent · ticked', { timeout: 30_000 });
  await shot('s764-05-till-shows-the-family-ticks', till);
  // Staff's own copy: the details are theirs to help with, the ticks are not.
  // A plain script string: the runner's compiled helpers do not exist in the page.
  await till.evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const c = canvas.getContext('2d'); c.fillStyle = '#285646'; c.fillRect(0, 0, 320, 240);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const stream = canvas.captureStream(5);
      const repaint = window.setInterval(() => c.fillRect(0, 0, 320, 240), 100);
      stream.getVideoTracks()[0].addEventListener('ended', () => window.clearInterval(repaint), { once: true });
      return stream;
    } });
  })()`);
  await till.getByRole('button', { name: 'Private child details', exact: true }).click();
  const privateForm = till.getByRole('dialog', { name: 'Private child details', exact: true });
  await expect(privateForm.getByPlaceholder(/^e.g. peanut allergy/)).toHaveValue('ZZ TEST peanuts');
  const staffTick = privateForm.getByTestId('consent-ack');
  await expect(staffTick).toBeDisabled();
  for (const item of await privateForm.getByTestId('consent-confirmation').all()) await expect(item).toBeDisabled();
  await privateForm.getByRole('button', { name: 'Start camera', exact: true }).click();
  await privateForm.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(privateForm.getByAltText('Captured', { exact: true })).toBeVisible();
  // A press on the staff copy's tick changes nothing: it is the family's to give.
  await staffTick.click({ force: true });
  await expect(status).toContainText('Supervision and photo consent · ticked');
  await staffTick.scrollIntoViewIfNeeded();
  await shot('s764-06-staff-copy-ticks-read-only', till);
  await privateForm.getByRole('button', { name: 'Close', exact: true }).click();
  const done = form.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await done.click();
  await expect(form.getByText('Thank you. The team will complete the staff checks.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await shot('s764-07-display-form-finished', display);
  await till.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  // Registered from the family's form: the child, the age they picked and the
  // allergy they typed are on the stay; a nanny child then goes to the nanny
  // assignment, as it always has.
  await expect(till.getByText('ZZ TEST peanuts', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(till.getByText('ZZ TEST Mai', { exact: true }).first()).toBeVisible();
  await expect(till.getByText('ZZ TEST Khun Ying', { exact: true }).first()).toBeVisible();
  await shot('s764-08-registered-from-the-family-form', till);
  r.cases.push({ name: 'SCRUM-764 drop-off form filled on the display, mirrored on the till, ticks from the family only', passed: true });
  r.outcome = 'passed';
  r.finishedAt = new Date().toISOString();
  save();
  code = 0;
} catch (error) {
  r.outcome = 'failed';
  r.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 4000) : String(error);
  save();
  for (const [name, page] of [['till', till], ['display', display]] as const) {
    if (page) await page.screenshot({ path: `${out}/failure-${name}.png`, fullPage: true }).catch(() => undefined);
  }
  console.error(error);
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  await ctx.close().catch(() => undefined);
  await H.teardownAll().catch(() => undefined);
  process.exit(code);
}
