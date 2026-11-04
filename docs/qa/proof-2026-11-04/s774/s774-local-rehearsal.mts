/**
 * SCRUM-774 local browser rehearsal: Hold sale, Save as partly paid, Held
 * sales on two tills of one branch, the midnight void, and the End of Day's
 * refusal. Real local API (embedded Postgres, dropped after), a ZZ TEST
 * virtual box run by the in-process edge agent, the Vite POS and Playwright.
 * Every record is ZZ TEST; nothing reaches staging; no SMS.
 *
 * Run from apps/api with: pnpm exec tsx ../../docs/qa/proof-2026-11-04/s774/s774-local-rehearsal.mts
 * (S774_LANE names another checkout.)
 */
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const lane = (process.env.S774_LANE ?? 'C:/oto-lanes/holdsale774-20261104').replace(/\\/g, '/');
const imp = (p: string) => import(pathToFileURL(`${lane}/${p}`).href);
const H = await imp('apps/api/test/helpers.ts');
const BOX = await imp('apps/api/src/services/box.ts');
const ENV = await imp('apps/api/src/env.ts');
const HOLDS = await imp('apps/api/src/services/sale-holds.ts');
const shared = await imp('packages/shared/src/index.ts');
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
const out = `${lane}/docs/qa/proof-2026-11-04/s774`;
mkdirSync(out, { recursive: true });
const r: Record<string, any> = { mode: 'local', source, startedAt: new Date().toISOString(), cases: [], screens: [], outcome: 'incomplete' };
const save = () => writeFileSync(`${out}/receipt.json`, JSON.stringify(r, null, 2) + '\n');
save();

const ctx = await H.createTestContext({ env: { DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge', PGW_PROVIDER: 'simulator', ALLOWED_ORIGINS: origin, COOKIE_SECURE: 'false' } });
let vite: any, browser: any, code = 1;
const pages: any[] = [];
try {
  await ctx.app.listen({ port: apiPort, host: '127.0.0.1' });
  const adminCookie = await H.signInAs(ctx.app, H.ADMIN.phone, H.ADMIN.password);
  const as = (cookie: string) => async (method: string, url: string, payload?: unknown) => {
    const res = await ctx.app.inject({ method, url, payload: payload as any,
      headers: { cookie, ...(method === 'GET' ? {} : { 'idempotency-key': `zz-test-${randomUUID()}` }) } });
    return { status: res.statusCode, body: res.json() };
  };
  const admin = async (method: string, url: string, payload?: unknown) => {
    const res = await as(adminCookie)(method, url, payload);
    assert.ok([200, 201].includes(res.status), `${method} ${url.split('?')[0]}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  };
  const branchId = await H.branchIdByCode(ctx.db, H.CENTRAL_BRANCH_CODE);

  // A ZZ TEST virtual box and two ZZ TEST tills on it: the branch's two counters.
  r.phase = 'fixture'; save();
  const slot = 'zz-test-774-local';
  const made = await admin('POST', `/branches/${branchId}/boxes`, { name: 'ZZ TEST SCRUM-774 virtual box', slot, role: 'virtual' });
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
  const tills: Record<'A' | 'B', { id: string; name: string }> = {} as never;
  for (const [key, codePrefix] of [['A', 'ZHA'], ['B', 'ZHB']] as const) {
    const name = `ZZ TEST SCRUM-774 till ${key}`;
    const res = await admin('POST', `/branches/${branchId}/stations`, { name, kind: 'till', codePrefix, boxId,
      paymentRouting: { card: 'manual', qr: 'gateway' }, capabilities: [], accessScope: 'all_staff', staffAccountIds: [], devices: [] });
    tills[key] = { id: res.station.id, name };
  }
  r.fixture = { boxId, tills }; save();

  // The Vite POS, proxied to this API.
  process.env.API_PORT = String(apiPort); process.env.POS_PORT = String(posPort);
  const { createServer: createVite } = await import(pathToFileURL(posRequire.resolve('vite')).href);
  vite = await createVite({ configFile: `${lane}/apps/pos/vite.config.ts`, root: `${lane}/apps/pos`, server: { port: posPort, host: '127.0.0.1', strictPort: true } });
  await vite.listen();
  browser = await chromium.launch();
  r.browser = browser.version();

  const shot = async (label: string, page: any) => {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
    // Filling a field can leave a column scrolled sideways; the picture is of the screen as staff see it.
    await page.evaluate(() => { for (const el of Array.from(document.querySelectorAll('*'))) if ((el as HTMLElement).scrollLeft) (el as HTMLElement).scrollLeft = 0; });
    const row = page.getByTestId('hold-sale-buttons');
    if (await row.count()) r.holdRowOverflow = { ...(r.holdRowOverflow ?? {}), [label]: await row.evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth) };
    await page.screenshot({ path: `${out}/${label}.png`, fullPage: true, mask: [page.locator('input[type=password], input[type=tel]')] });
    r.screens.push(`${label}.png`); save();
  };
  const tillPage = async (till: { id: string; name: string }) => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    context.setDefaultTimeout(30_000);
    const signIn = await context.request.post(`${origin}/api/auth/sign-in`, { data: { phone: H.RECEPTION.phone, password: H.RECEPTION.password } });
    assert.equal(signIn.status(), 200);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Which station are you on?' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(escapeRe(till.name)) }).click();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
    return page;
  };
  const read = async (saleId: string) => admin('GET', `/sales/${saleId}`);
  const seen = new Set<string>();
  /** A walk-in ticket rung up to the payment screen, with the guest's name on the display. */
  const ringUp = async (page: any, guest: string): Promise<string> => {
    await page.goto(origin);
    await page.getByRole('button', { name: /Skip.*walk-in/ }).click();
    await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
    await page.getByRole('heading', { name: '2 Hours Play', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const amountDue = page.getByRole('heading', { name: 'Amount Due' });
    for (let i = 0; i < 4 && !(await amountDue.isVisible().catch(() => false)); i += 1) {
      const nick = page.getByPlaceholder('e.g. Mama, John');
      const pay = page.getByRole('button', { name: /^Pay ฿/ });
      await expect(nick.or(pay).or(amountDue).first()).toBeVisible();
      if (await nick.isVisible().catch(() => false)) {
        await nick.fill(guest);
        await page.getByRole('button', { name: 'Done', exact: true }).last().click();
      } else if (await pay.isVisible().catch(() => false)) {
        await pay.click();
      }
      await sleep(500);
    }
    await expect(amountDue).toBeVisible();
    // Pay records the sale: wait for the new tendering row the screen rang up.
    for (let i = 0; i < 40; i += 1) {
      const listed = await admin('GET', `/sales?branchId=${branchId}&status=tendering&limit=20`);
      const fresh = listed.sales.find((s: any) => !seen.has(s.id));
      if (fresh) { seen.add(fresh.id); return fresh.id as string; }
      await sleep(500);
    }
    throw new Error('the payment screen did not record the sale');
  };
  const payCash = async (page: any, bahtAmount?: string) => {
    await page.getByRole('heading', { name: 'Cash', exact: true }).click();
    if (bahtAmount) {
      await page.locator('#payment-part-amount').fill(bahtAmount);
      await page.locator('#payment-cash-received').fill(bahtAmount);
    }
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  };
  const heldRow = (page: any, label: string) => page.getByTestId('held-sale').filter({ hasText: label });
  const refreshHeld = async (page: any) => {
    // A finished sale is handed over first, as staff do: Start New Sale.
    const next = page.getByRole('button', { name: 'Start New Sale' });
    if (await next.isVisible().catch(() => false)) await next.click();
    await page.getByRole('button', { name: 'Read Held sales again' }).click();
    await sleep(800);
  };

  const pageA = await tillPage(tills.A);
  const pageB = await tillPage(tills.B);

  // 1 — Hold sale on till A, resumed on till B, paid there: bands only then.
  r.phase = 'hold'; save();
  const anna = 'ZZ TEST Khun Anna';
  const annaSale = await ringUp(pageA, anna);
  await expect(pageA.getByTestId('hold-sale-buttons')).toBeVisible();
  await expect(pageA.getByTestId('part-paid-reason')).toHaveText('Take a part payment first — nothing has been paid on this sale yet.');
  await shot('s774-01-payment-step-hold-buttons', pageA);
  await pageA.getByRole('button', { name: 'Hold sale', exact: true }).click();
  const dialog = pageA.getByTestId('hold-sale-dialog');
  await expect(dialog.getByLabel('Customer’s name or band')).toHaveValue(anna);
  await dialog.getByLabel('Note (optional)').fill('Back after lunch');
  await shot('s774-02-hold-dialog', pageA);
  await dialog.getByRole('button', { name: 'Hold sale', exact: true }).click();
  await expect(pageA.getByText('Membership Check', { exact: true })).toBeVisible();
  await expect(heldRow(pageA, anna)).toBeVisible();
  let detail = await read(annaSale);
  assert.equal(detail.sale.status, 'tendering');
  assert.equal(detail.bands.length, 0, 'a held sale issued bands');
  assert.equal(detail.sale.receiptNumber ?? null, null, 'a held sale was numbered');
  await shot('s774-03-held-list-till-a', pageA);

  r.phase = 'resume on another till'; save();
  await refreshHeld(pageB);
  await expect(heldRow(pageB, anna)).toBeVisible();
  await shot('s774-04-held-list-till-b', pageB);
  await heldRow(pageB, anna).getByRole('button', { name: /^Resume/ }).click();
  await expect(pageB.getByTestId('resumed-held-notice')).toBeVisible();
  detail = await read(annaSale);
  assert.equal(detail.sale.stationId, tills.B.id, 'the resumed sale did not move to till B');
  assert.equal(detail.bands.length, 0);
  await shot('s774-05-resumed-on-till-b', pageB);
  await payCash(pageB);
  await expect(pageB.getByRole('heading', { name: 'Payment Successful' })).toBeVisible();
  detail = await read(annaSale);
  assert.equal(detail.sale.status, 'finalised');
  assert.ok(detail.bands.length > 0, 'no bands when the balance reached zero');
  await shot('s774-06-paid-on-till-b-bands-issued', pageB);
  r.cases.push({ name: 'Hold sale on till A, resumed on till B, paid there', saleId: annaSale, receipt: detail.sale.receiptNumber,
    bandsWhileHeld: 0, bandsAfterPayment: detail.bands.length, passed: true }); save();

  // 2 — Part payment, Save as partly paid, resumed for the balance only.
  r.phase = 'part pay'; save();
  const ben = 'ZZ TEST Khun Ben';
  const benSale = await ringUp(pageA, ben);
  const gross = (await read(benSale)).sale.totals.grossSatang as number;
  await payCash(pageA, '200');
  await expect(pageA.getByTestId('hold-sale-reason')).toHaveText('฿200 has been paid on this sale — use Save as partly paid.');
  detail = await read(benSale);
  assert.equal(detail.sale.status, 'tendering');
  assert.equal(detail.bands.length, 0, 'a part payment issued bands');
  await shot('s774-07-part-payment-taken', pageA);
  await pageA.getByRole('button', { name: 'Save as partly paid', exact: true }).click();
  const partDialog = pageA.getByTestId('hold-sale-dialog');
  await expect(partDialog.getByLabel('Customer’s name or band')).toHaveValue(ben);
  await partDialog.getByRole('button', { name: 'Save as partly paid', exact: true }).click();
  await expect(pageA.getByText('Membership Check', { exact: true })).toBeVisible();
  await expect(heldRow(pageA, ben)).toContainText(`฿200 paid · balance ฿${((gross - 20_000) / 100).toLocaleString('en-US')}`);
  await shot('s774-08-part-paid-in-held-sales', pageA);

  r.phase = 'resume for the balance'; save();
  await refreshHeld(pageB);
  await heldRow(pageB, ben).getByRole('button', { name: 'Resume — take the balance' }).click();
  await expect(pageB.getByTestId('resumed-held-notice')).toContainText('฿200 already paid');
  await expect(pageB.getByRole('heading', { name: 'Amount Due' }).locator('..')).toContainText(`฿${(gross - 20_000) / 100}`);
  await shot('s774-09-resumed-asks-balance-only', pageB);
  await payCash(pageB);
  await expect(pageB.getByRole('heading', { name: 'Payment Successful' })).toBeVisible();
  detail = await read(benSale);
  assert.equal(detail.sale.status, 'finalised');
  assert.ok(detail.bands.length > 0);
  await shot('s774-10-balance-paid-bands-issued', pageB);
  r.cases.push({ name: 'Save as partly paid, resumed on till B for the balance only', saleId: benSale, grossSatang: gross,
    paidFirstSatang: 20_000, bandsAfterBalance: detail.bands.length, passed: true }); save();

  // 3 — The End of Day refuses to close over a part-paid sale, and says why.
  r.phase = 'end of day'; save();
  const gail = 'ZZ TEST Khun Gail';
  const gailSale = await ringUp(pageA, gail);
  await payCash(pageA, '350');
  await pageA.getByRole('button', { name: 'Save as partly paid', exact: true }).click();
  await pageA.getByTestId('hold-sale-dialog').getByRole('button', { name: 'Save as partly paid', exact: true }).click();
  await expect(pageA.getByText('Membership Check', { exact: true })).toBeVisible();
  const eve = 'ZZ TEST Khun Eve';
  const eveSale = await ringUp(pageA, eve);
  await pageA.getByRole('button', { name: 'Hold sale', exact: true }).click();
  await pageA.getByTestId('hold-sale-dialog').getByRole('button', { name: 'Hold sale', exact: true }).click();
  await expect(heldRow(pageA, eve)).toBeVisible();
  await pageA.goto(`${origin}/end-of-day`);
  const card = pageA.getByTestId('eod-open-sales');
  await expect(card).toBeVisible();
  await expect(pageA.getByTestId('eod-part-paid-count')).toContainText('1');
  await expect(pageA.getByTestId('eod-held-count')).toContainText('1');
  await expect(pageA.getByTestId('close-day-blocked-reason')).toContainText('End of Day cannot close: 1 sale is partly paid — ZZ TEST Khun Gail (in Held sales), ฿350 paid, balance');
  await expect(pageA.getByRole('button', { name: 'Close Day' })).toBeDisabled();
  await pageA.getByTestId('eod-open-sales').scrollIntoViewIfNeeded();
  await shot('s774-11-end-of-day-counts-and-refusal', pageA);
  await pageA.getByRole('button', { name: 'Close Day' }).scrollIntoViewIfNeeded();
  await shot('s774-12-close-day-shut-with-its-reason', pageA);
  const date = (await read(gailSale)).sale.businessDate as string;
  const managerCookie = await H.signInAs(ctx.app, H.BRANCH_MANAGER.phone, H.BRANCH_MANAGER.password);
  const close = await as(managerCookie)('POST', `/branches/${branchId}/end-of-day/close`, { date, actuals: [], countedSatang: null, floatLeftSatang: null });
  assert.equal(close.status, 409);
  assert.equal(close.body.error.code, 'PART_PAID_SALES');
  r.cases.push({ name: 'End of Day shows the counts and refuses to close over a part-paid sale', counts: { held: 1, partPaid: 1 },
    apiStatus: close.status, apiCode: close.body.error.code, apiMessage: close.body.error.message, passed: true }); save();

  // 4 — Midnight: the held sale is voided "not collected"; the part-paid one is flagged.
  r.phase = 'midnight'; save();
  const holds = await ctx.db.select().from((await imp('packages/db/src/index.ts')).saleHold);
  const eveHold = holds.find((h: any) => h.saleId === eveSale && h.releasedAt === null);
  assert.ok(eveHold, 'Eve is held');
  const nextDay = shared.addDaysToIsoDate(shared.isoDateInTz(eveHold.heldAt, 'Asia/Bangkok'), 1);
  const midnight = new Date(`${nextDay}T00:00:00+07:00`);
  const before = await HOLDS.runHeldSalesMidnight(ctx.db, { ALERT_FLAP_WINDOW_S: 300 }, new Date(midnight.getTime() - 1000));
  assert.equal(before.voided, 0);
  const summary = await HOLDS.runHeldSalesMidnight(ctx.db, { ALERT_FLAP_WINDOW_S: 300 }, midnight);
  const eveAfter = await read(eveSale);
  assert.equal(eveAfter.sale.status, 'voided');
  assert.equal(eveAfter.sale.voidReason, 'not collected');
  const gailAfter = await read(gailSale);
  assert.equal(gailAfter.sale.status, 'tendering', 'the part-paid sale was voided');
  await pageB.goto(origin);
  await refreshHeld(pageB);
  await expect(heldRow(pageB, eve)).toHaveCount(0);
  await expect(heldRow(pageB, gail)).toContainText('Flagged for the manager');
  await shot('s774-13-after-midnight-held-voided-part-paid-flagged', pageB);
  r.cases.push({ name: 'midnight: held sale voided as not collected, part-paid flagged and kept', clock: midnight.toISOString(),
    summary, eve: { status: eveAfter.sale.status, voidReason: eveAfter.sale.voidReason }, gail: { status: gailAfter.sale.status }, passed: true }); save();

  r.smsCount = ctx.smsLog.length;
  assert.equal(ctx.smsLog.length, 0);
  r.outcome = 'passed'; code = 0;
} catch (error) {
  r.failure = { phase: r.phase ?? null, name: (error as Error).name, message: String((error as Error).message).split('\n').slice(0, 4).join(' | ').replace(/postgres[^\s]*/gi, '[db]').slice(0, 700) };
  console.error(JSON.stringify(r.failure));
  for (const [i, page] of pages.entries()) await page.screenshot({ path: `${out}/failure-${i}.png`, fullPage: true }).catch(() => {});
} finally {
  r.finishedAt = new Date().toISOString(); save();
  await browser?.close().catch(() => {});
  try { await BOX.stopVirtualBox?.(); } catch { /* the database drop ends it too */ }
  await vite?.close().catch(() => {});
  await ctx.close().catch(() => {});
  await H.teardownAll().catch(() => {});
  r.databaseDropped = true; save();
}
console.log(JSON.stringify({ out, outcome: r.outcome, failure: r.failure, cases: r.cases, screens: r.screens }));
process.exit(code);
