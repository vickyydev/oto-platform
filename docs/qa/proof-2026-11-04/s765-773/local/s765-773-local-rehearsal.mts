/**
 * SCRUM-765 / SCRUM-773 local browser rehearsal: the real local API (embedded
 * Postgres, dropped after), the seeded virtual box run by the in-process edge
 * agent with its simulated printers, the Vite POS, and Playwright. Nothing
 * here reaches staging; no SMS is sent.
 *
 *   SCRUM-765 — a walk-in ticket sale with two pairs of Regular Socks picked
 *   from the ticket's add-ons, paid in cash on the till: the receipt printer
 *   prints the receipt only (socks on it, no socks slip), the band printers
 *   print the bands.
 *   SCRUM-773 — the verify-tier step offers Driving licence where Residence
 *   certificate was, and shows the expiry date under Other; a walk-in claim
 *   on Other carries the date to the platform.
 *   SCRUM-765 again, at that Thai rate — a Full Day Pass for a kid and the
 *   free adult, with socks: nobody earns a wallet, so the payment screen's
 *   "Credit Grants to Print" card shows only because the receipt carries the
 *   socks to collect; the receipt and the bands print, no socks slip.
 *
 * Run from apps/api with: pnpm exec tsx <this file>; S765_LANE names the checkout.
 */
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const lane = (process.env.S765_LANE ?? 'C:/oto-lanes/qapos765-20261104').replace(/\\/g, '/');
const imp = (p: string) => import(pathToFileURL(`${lane}/${p}`).href);
const H = await imp('apps/api/test/helpers.ts');
const BOX = await imp('apps/api/src/services/box.ts');
const ENV = await imp('apps/api/src/env.ts');
const DB = await imp('packages/db/src/index.ts');
const ORM = await import(pathToFileURL(createRequire(`${lane}/packages/db/package.json`).resolve('drizzle-orm')).href);
const posRequire = createRequire(`${lane}/apps/pos/package.json`);
const { chromium, expect } = posRequire('@playwright/test');

const free = () => new Promise<number>((resolve, reject) => {
  const s = netServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); assert.ok(a && typeof a !== 'string'); s.close(() => resolve(a.port)); });
});
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const apiPort = await free(), posPort = await free(), origin = `http://127.0.0.1:${posPort}`;
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: lane, encoding: 'utf8' }).trim();
const stamp = Date.now().toString(36);
const out = `${lane}/docs/qa/proof-2026-11-04/s765-773/local/${stamp}`;
mkdirSync(out, { recursive: true });
const r: Record<string, any> = { mode: 'local', source, startedAt: new Date().toISOString(), cases: [], screens: [], printouts: [], outcome: 'incomplete' };
const save = () => writeFileSync(`${out}/receipt.json`, JSON.stringify(r, null, 2) + '\n');
save();

const ctx = await H.createTestContext({ env: { DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge', ALLOWED_ORIGINS: origin, COOKIE_SECURE: 'false' } });
let vite: any, browser: any, code = 1;
const pages: any[] = [];
try {
  await ctx.app.listen({ port: apiPort, host: '127.0.0.1' });
  const cookie = await H.signInAs(ctx.app, H.ADMIN.phone, H.ADMIN.password);
  const admin = async (method: string, url: string) => {
    const res = await ctx.app.inject({ method, url, headers: { cookie } });
    assert.equal(res.statusCode, 200, `${method} ${url.split('?')[0]}: ${res.statusCode} ${res.body.slice(0, 300)}`);
    return res;
  };
  const branchId = await H.branchIdByCode(ctx.db, H.CENTRAL_BRANCH_CODE);

  // The seeded virtual box, run by the ordinary in-process edge agent; its
  // printers are on the simulated transport.
  r.phase = 'box'; save();
  process.env.BOX_HEARTBEAT_INTERVAL_S = '5';
  const env = ENV.loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge' });
  const agent = await BOX.startVirtualBox({ db: ctx.db, env, log: ctx.app.log, port: apiPort });
  assert.ok(agent, 'virtual box agent did not start');
  let online: any;
  for (let i = 0; i < 60 && !online; i += 1) {
    online = (await admin('GET', `/branches/${branchId}/boxes`)).json().boxes.find((b: any) => b.slot === 'virtual-1' && b.status === 'online');
    if (!online) await sleep(1000);
  }
  assert.ok(online, 'the virtual box did not come online');
  r.box = { id: online.id, name: online.name, status: online.status };

  const { and, eq } = ORM;
  const [till] = await ctx.db.select().from(DB.station).where(and(eq(DB.station.branchId, branchId), eq(DB.station.codePrefix, 'T1')));
  assert.ok(till, 'the seeded T1 till');
  const wired = await ctx.db.select({ role: DB.stationDevice.role, deviceId: DB.stationDevice.deviceId, label: DB.device.label, transport: DB.device.transport })
    .from(DB.stationDevice).innerJoin(DB.device, eq(DB.device.id, DB.stationDevice.deviceId)).where(eq(DB.stationDevice.stationId, till.id));
  const printer = (role: string) => { const d = wired.find((w: any) => w.role === role); assert.ok(d, `T1 has no ${role} printer`); return d; };
  const receiptPrinter = printer('receipt'), kidsPrinter = printer('kids_band'), adultPrinter = printer('adult_band');
  r.till = { id: till.id, name: till.name, codePrefix: till.codePrefix, printers: [receiptPrinter, kidsPrinter, adultPrinter].map((d: any) => ({ role: d.role, label: d.label, transport: d.transport })) };
  save();
  const printoutsOf = async (deviceId: string) => (await admin('GET', `/devices/${deviceId}/printouts?limit=20`)).json().printouts as any[];
  const seqBefore = async (deviceId: string) => Math.max(0, ...(await printoutsOf(deviceId)).map((p) => p.seq));
  const before = { receipt: await seqBefore(receiptPrinter.deviceId), kids: await seqBefore(kidsPrinter.deviceId), adult: await seqBefore(adultPrinter.deviceId) };

  // Vite POS, proxied to this API.
  process.env.API_PORT = String(apiPort); process.env.POS_PORT = String(posPort);
  const { createServer: createVite } = await import(pathToFileURL(posRequire.resolve('vite')).href);
  vite = await createVite({ configFile: `${lane}/apps/pos/vite.config.ts`, root: `${lane}/apps/pos`, server: { port: posPort, host: '127.0.0.1', strictPort: true } });
  await vite.listen();

  browser = await chromium.launch();
  r.browser = browser.version();
  const shot = async (label: string, page: any) => {
    // Off every button, so no hover tint or transition is caught mid-way.
    await page.mouse.move(2, 990);
    await sleep(500);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
    await page.screenshot({ path: `${out}/${label}.png`, fullPage: true, mask: [page.locator('input[type=password], input[type=tel]')] });
    r.screens.push(`${label}.png`); save();
  };
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  context.setDefaultTimeout(30_000);
  const signIn = await context.request.post(`${origin}/api/auth/sign-in`, { data: { phone: H.RECEPTION.phone, password: H.RECEPTION.password } });
  assert.equal(signIn.status(), 200);
  const page = await context.newPage();
  pages.push(page);
  const openTill = async () => {
    await page.goto(origin);
    const picker = page.getByRole('heading', { name: 'Which station are you on?' });
    const asked = await picker.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (asked) await page.getByRole('button', { name: new RegExp(till.name) }).first().click();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  };

  // --- SCRUM-765: ticket sales with socks, paid in cash ----------------------
  // Socks are sold from the ticket's add-ons on the configure step.
  const startSale = async () => {
    await openTill();
    await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
    await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
    await page.getByRole('heading', { name: '2 Hours Play', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible();
  };
  const addTwoPairsOfSocks = async () => {
    await page.getByRole('button', { name: 'Add one Regular Socks' }).first().click();
    await page.getByRole('button', { name: 'Add one Regular Socks' }).first().click();
    await expect(page.getByText('Regular Socks × 2')).toBeVisible();
  };
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  const payCashAndRead = async () => {
    await payButton.click();
    const done = page.getByRole('button', { name: 'Done', exact: true });
    if (await done.isVisible().catch(() => false)) await done.click();
    await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible();
    await page.getByRole('heading', { name: 'Cash' }).click();
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
    await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible();
    const listed = await page.request.get(`${origin}/api/sales?limit=1`);
    const saleId = (await listed.json()).sales[0].id as string;
    let detail: any;
    for (let i = 0; i < 40; i += 1) {
      detail = await (await page.request.get(`${origin}/api/sales/${saleId}`)).json();
      if ((detail.printJobs ?? []).length > 0 && detail.printJobs.every((j: any) => j.status !== 'queued')) break;
      await sleep(500);
    }
    return { saleId, detail };
  };
  const [socksProduct] = await ctx.db.select({ id: DB.product.id }).from(DB.product).where(eq(DB.product.code, 'AO-SOCKS'));
  const saleRecord = (saleId: string, detail: any) => {
    const socks = detail.lines.filter((l: any) => l.kind === 'socks' || l.productId === socksProduct?.id);
    const jobs = (detail.printJobs ?? []).filter((j: any) => j.reprintOf === null).map((j: any) => ({ kind: j.kind, status: j.status, device: j.deviceLabel ?? null }));
    return { id: saleId, receiptNumber: detail.sale.receiptNumber, status: detail.sale.status, socksQuantity: socks.reduce((n: number, l: any) => n + l.quantity, 0),
      walletGrants: (detail.grants ?? []).length,
      lines: detail.lines.map((l: any) => ({ kind: l.kind, label: l.label, quantity: l.quantity })), printJobs: jobs };
  };
  // What each simulated printer drew since `from`, as PNGs; the paper count per printer.
  const drawPrintouts = async (tag: string, from: { receipt: number; kids: number; adult: number }) => {
    const counts: Record<string, number> = {};
    for (const [name, device, since] of [['receipt-printer', receiptPrinter, from.receipt], ['kids-band-printer', kidsPrinter, from.kids], ['adult-band-printer', adultPrinter, from.adult]] as const) {
      const fresh = (await printoutsOf((device as any).deviceId)).filter((p) => p.seq > (since as number));
      // A cash sale also opens the drawer through the receipt printer: a session
      // with no dots and no cut, which the simulator keeps as an empty printout.
      const paper = fresh.filter((p) => p.heightDots > 0);
      for (const p of paper) {
        const png = await admin('GET', `/devices/${(device as any).deviceId}/printouts/${p.seq}/preview.png`);
        const file = `${tag}-${name}-${p.seq}.png`;
        writeFileSync(`${out}/${file}`, png.rawPayload);
        r.printouts.push({ sale: tag, printer: (device as any).label, seq: p.seq, heightDots: p.heightDots, truncated: p.truncated, file });
      }
      counts[name] = paper.length;
      if (name === 'receipt-printer') counts['receipt-printer-empty-sessions'] = fresh.length - paper.length;
    }
    save();
    return counts;
  };
  const creditCard = page.getByRole('heading', { name: 'Credit Grants to Print', exact: true });

  // A kid and an adult on 2 Hours Play, with two pairs of socks.
  r.phase = 'socks sale'; save();
  await startSale();
  await addTwoPairsOfSocks();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(payButton).toBeVisible();
  await shot('s765-order-with-two-pairs-of-socks', page);
  const first = await payCashAndRead();
  r.sale = saleRecord(first.saleId, first.detail);
  save();
  assert.equal(first.detail.sale.status, 'finalised');
  assert.equal(r.sale.socksQuantity, 2, 'the sale carries two pairs of socks');
  assert.deepEqual(r.sale.printJobs.map((j: any) => j.kind).sort(), ['adult_wristband', 'kids_wristband', 'receipt']);
  assert.ok(r.sale.printJobs.every((j: any) => j.status === 'printed'), `print jobs: ${JSON.stringify(r.sale.printJobs)}`);
  await expect(creditCard).toBeVisible();
  await sleep(1500);
  await shot('s765-payment-successful-receipt-and-bands-only', page);
  r.phase = 'printouts'; save();
  const firstPaper = await drawPrintouts('s765', before);
  r.salePaper = firstPaper;
  assert.equal(firstPaper['receipt-printer'], 1, 'the receipt printer printed the receipt and no socks slip');
  assert.equal(firstPaper['kids-band-printer'], 1);
  assert.equal(firstPaper['adult-band-printer'], 1);
  r.cases.push({ name: 'SCRUM-765 socks sale prints the receipt and the bands, no socks slip', passed: true });
  save();

  // --- SCRUM-773: the verify-tier step ---------------------------------------
  r.phase = 'verify step'; save();
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
  await page.getByRole('heading', { name: 'Thai', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Verify Thai rate/ })).toBeVisible();
  const offered = (await dialog.getByRole('button').allTextContents()).map((t: string) => t.trim()).filter((t: string) => ['Passport', 'Driving licence', 'Residence certificate', 'School card', 'Other'].includes(t));
  r.offered = offered;
  assert.deepEqual(offered, ['Passport', 'Driving licence', 'School card', 'Other']);
  await dialog.getByRole('button', { name: 'Driving licence', exact: true }).click();
  await expect(dialog.getByLabel('Document expiry date')).toBeVisible();
  await shot('s773-verify-step-driving-licence', page);

  await dialog.getByRole('button', { name: 'Other', exact: true }).click();
  await expect(dialog.getByLabel(/What did you check/)).toBeVisible();
  await expect(dialog.getByLabel('Document expiry date')).toBeVisible();
  const expiry = `${new Date().getUTCFullYear() + 1}-06-30`;
  await dialog.getByLabel(/What did you check/).fill('Work permit');
  await dialog.getByLabel('Document expiry date').fill(expiry);
  await shot('s773-verify-step-other-with-expiry', page);
  const claimed = page.waitForResponse((res: any) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/sales/tier-claims');
  await dialog.getByRole('button', { name: /^Verify Thai — Other — Work permit/ }).click();
  const claim = await claimed;
  assert.equal(claim.status(), 200, 'the walk-in claim is recorded');
  const body = (await claim.json()).claim;
  r.claim = { evidenceType: body.evidenceType, evidenceExpiresAt: body.evidenceExpiresAt, note: body.note, toTier: body.toTier };
  assert.deepEqual(r.claim, { evidenceType: 'Other', evidenceExpiresAt: expiry, note: 'Work permit', toTier: 'thai' });
  await expect(dialog).toBeHidden();
  await sleep(800);
  await shot('s773-thai-rate-on-other-with-expiry', page);
  r.cases.push({ name: 'SCRUM-773 verify step offers Driving licence and takes an expiry on Other', passed: true });

  // --- SCRUM-765: socks on a sale where nobody earns a wallet ----------------
  // The first sale's adult earns a wallet (2 Hours Play credits adults at full
  // price), and a wallet alone shows the "Credit Grants to Print" card. Here,
  // at the Thai rate just verified, the Full Day Pass's adult is the one free
  // adult, whose credit is read from a price of nothing, and kids earn none:
  // so the card shows only because the receipt carries the socks to collect.
  r.phase = 'no-wallet socks sale'; save();
  const beforeNoWallet = { receipt: await seqBefore(receiptPrinter.deviceId), kids: await seqBefore(kidsPrinter.deviceId), adult: await seqBefore(adultPrinter.deviceId) };
  await page.getByRole('heading', { name: 'Full Day Pass', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible();
  await addTwoPairsOfSocks();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(payButton).toBeVisible();
  await shot('s765-thai-full-day-order-with-two-pairs-of-socks', page);
  const second = await payCashAndRead();
  r.noWalletSale = saleRecord(second.saleId, second.detail);
  save();
  assert.equal(second.detail.sale.status, 'finalised');
  assert.equal(r.noWalletSale.socksQuantity, 2, 'the sale carries two pairs of socks');
  assert.ok(r.noWalletSale.lines.some((l: any) => l.kind === 'adults_free'), 'the adult is the free adult');
  assert.ok(!r.noWalletSale.lines.some((l: any) => l.kind === 'adults_paid'), 'no paid adult on the sale');
  assert.equal(r.noWalletSale.walletGrants, 0, 'nobody on the sale earns a wallet');
  assert.deepEqual(r.noWalletSale.printJobs.map((j: any) => j.kind).sort(), ['adult_wristband', 'kids_wristband', 'receipt']);
  assert.ok(r.noWalletSale.printJobs.every((j: any) => j.status === 'printed'), `print jobs: ${JSON.stringify(r.noWalletSale.printJobs)}`);
  // The card shows, with the socks as its one row and no credit row.
  await expect(creditCard).toBeVisible();
  const card = page.locator('div.flex-col', { has: creditCard }).last();
  await expect(card.getByText('1 total', { exact: true })).toBeVisible();
  await expect(card.getByText('Regular Socks', { exact: true })).toBeVisible();
  await expect(card.getByText('to collect', { exact: true })).toBeVisible();
  await expect(card.getByText('credit', { exact: true })).toHaveCount(0);
  r.noWalletCard = { shown: true, total: '1 total', rows: ['Regular Socks ×2 to collect'] };
  await sleep(1500);
  await shot('s765-no-wallet-payment-successful-socks-card', page);
  const noWalletPaper = await drawPrintouts('s765-no-wallet', beforeNoWallet);
  r.noWalletSalePaper = noWalletPaper;
  assert.equal(noWalletPaper['receipt-printer'], 1, 'the receipt printer printed the receipt and no socks slip');
  assert.equal(noWalletPaper['kids-band-printer'], 1);
  assert.equal(noWalletPaper['adult-band-printer'], 1);
  r.cases.push({ name: 'SCRUM-765 socks sale with no wallet: the card shows the socks; receipt and bands only', passed: true });
  save();

  r.smsCount = ctx.smsLog.length;
  assert.equal(ctx.smsLog.length, 0);
  r.outcome = 'passed'; code = 0;
} catch (error) {
  r.failure = { phase: r.phase ?? null, name: (error as Error).name, message: String((error as Error).message).split('\n').slice(0, 4).join(' | ').replace(/postgres[^\s]*/gi, '[db]').slice(0, 700) };
  console.error(JSON.stringify(r.failure));
  for (const [i, p] of pages.entries()) await p.screenshot({ path: `${out}/failure-${i}.png`, fullPage: true }).catch(() => {});
} finally {
  r.finishedAt = new Date().toISOString(); save();
  await browser?.close().catch(() => {});
  try { BOX.stopVirtualBox?.(); } catch { /* the database drop ends it too */ }
  await vite?.close().catch(() => {});
  await ctx.close().catch(() => {});
  await H.teardownAll().catch(() => {});
  r.databaseDropped = true; save();
}
console.log(JSON.stringify({ out, outcome: r.outcome, failure: r.failure, cases: r.cases, screens: r.screens, printouts: r.printouts }));
process.exit(code);
