/**
 * SCRUM-747/746 local browser rehearsal: real local API (embedded Postgres,
 * dropped after), a ZZ TEST virtual box run by the in-process edge agent, the
 * Vite POS, and Playwright. Simulator gateway only; no SMS; no staging.
 */
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomInt } from 'node:crypto';

// Run from apps/api with: pnpm exec tsx <this file>; S747_LANE names another checkout.
const lane = (process.env.S747_LANE ?? 'C:/oto-lanes/tillcodes747-20261104').replace(/\\/g, '/');
const imp = (p: string) => import(pathToFileURL(`${lane}/${p}`).href);
const H = await imp('apps/api/test/helpers.ts');
const BOX = await imp('apps/api/src/services/box.ts');
const ENV = await imp('apps/api/src/env.ts');
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
const stamp = Date.now().toString(36);
const out = `${lane}/docs/qa/proof-2026-11-04/s747-746/local/${stamp}`;
mkdirSync(out, { recursive: true });
const r: Record<string, any> = { mode: 'local', source, startedAt: new Date().toISOString(), cases: [], screens: [], requests: [], outcome: 'incomplete' };
const save = () => writeFileSync(`${out}/receipt.json`, JSON.stringify(r, null, 2) + '\n');
save();

const ctx = await H.createTestContext({ env: { DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge', PGW_PROVIDER: 'simulator', ALLOWED_ORIGINS: origin, COOKIE_SECURE: 'false' } });
let vite: any, browser: any, code = 1;
const pages: any[] = [];
try {
  await ctx.app.listen({ port: apiPort, host: '127.0.0.1' });
  const cookie = await H.signInAs(ctx.app, H.ADMIN.phone, H.ADMIN.password);
  const admin = async (method: string, url: string, payload?: unknown) => {
    const res = await ctx.app.inject({ method, url, payload: payload as any,
      headers: { cookie, ...(method === 'GET' ? {} : { 'idempotency-key': `zz-test-${randomUUID()}` }) } });
    r.requests.push({ method, path: url.split('?')[0], status: res.statusCode });
    assert.ok([200, 201].includes(res.statusCode), `${method} ${url.split('?')[0]}: ${res.statusCode} ${res.body.slice(0, 300)}`);
    return res.json();
  };
  const branchId = await H.branchIdByCode(ctx.db, H.CENTRAL_BRANCH_CODE);

  // A dedicated ZZ TEST virtual box, run by the ordinary in-process edge agent.
  const slot = 'zz-test-747-local';
  const made = await admin('POST', `/branches/${branchId}/boxes`, { name: 'ZZ TEST SCRUM-747 virtual box', slot, role: 'virtual' });
  const boxId = made.box.id as string;
  process.env.BOX_AGENT_SLOT = slot;
  process.env.BOX_HEARTBEAT_INTERVAL_S = '5';
  const env = ENV.loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', PAYMENTS_SIMULATOR: 'on', DEPLOY_ENV: 'local', PROCESS_ROLES: 'api,edge', PGW_PROVIDER: 'simulator' });
  const agent = await BOX.startVirtualBox({ db: ctx.db, env, log: ctx.app.log, port: apiPort });
  assert.ok(agent, 'virtual box agent did not start');
  let online: any;
  for (let i = 0; i < 60 && !online; i += 1) {
    online = (await admin('GET', `/branches/${branchId}/boxes`)).boxes.find((b: any) => b.id === boxId && b.status === 'online');
    if (!online) await sleep(1000);
  }
  assert.ok(online, 'the ZZ TEST virtual box did not come online');
  r.box = { id: boxId, name: online.name, role: online.role, status: online.status, devices: Array.isArray(online.devices) ? online.devices.length : null };
  save();

  // Two ZZ TEST tills on it: four and six characters, QR through the gateway.
  const tills: Record<string, { id: string; code: string; name: string }> = {};
  for (const codePrefix of ['ZI7C', 'ZZ747A']) {
    const name = `ZZ TEST SCRUM-747 till ${codePrefix}`;
    const res = await admin('POST', `/branches/${branchId}/stations`, { name, kind: 'till', codePrefix, boxId,
      paymentRouting: { card: 'manual', qr: 'gateway' }, capabilities: [], accessScope: 'all_staff', staffAccountIds: [], devices: [] });
    assert.equal(res.station.codePrefix, codePrefix);
    tills[codePrefix] = { id: res.station.id, code: codePrefix, name };
    r[`till${codePrefix.length}`] = { id: res.station.id, codePrefix, ready: res.station.ready ?? null, invoiceSegment: shared.invoiceStationSegment(codePrefix) };
  }
  save();

  // A paid ticket on the four-character till gives a printed band short code.
  const pkg = (await admin('GET', `/branches/${branchId}/ticket-packages`)).packages.find((p: any) => p.name === '2 Hours Play' && p.active && !p.archivedAt);
  assert.ok(pkg, 'seeded 2 Hours Play package');
  // A ZZ TEST drop-off child checked in on the four-character till: the band's
  // stay is what the F&B band lookup opens (a plain ticket band has no tab).
  r.phase = 'family'; save();
  const config = await admin('GET', `/checkin/config?branchId=${branchId}`);
  const childName = 'ZZ TEST SCRUM-746 child';
  const registrationId = randomUUID(), checkinId = randomUUID(), saleId = randomUUID();
  await admin('PUT', '/me/session/station', { stationId: tills.ZI7C!.id });
  await admin('POST', '/checkin/registrations', {
    id: registrationId, branchId, stationId: tills.ZI7C!.id, guardianName: 'ZZ TEST SCRUM-746 guardian', contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: (config.policy?.confirmations ?? []).map((c: any) => c.id),
    children: [{ checkinId, name: childName, ageYears: 9, service: 'none', foodProvision: { mode: 'none', paidSatang: 0 } }],
  });
  await admin('POST', '/sales', { id: saleId, stationId: tills.ZI7C!.id, lines: [{ id: checkinId, packageId: pkg.id, kids: 1, adults: 1 }] });
  const tender = await admin('POST', '/payments/attempts', { saleId, actionId: randomUUID(), tender: 'qr', method: 'promptpay', kind: 'qr' });
  assert.equal(tender.attempt.provider, 'simulator');
  r.qrOnFourCharacterTill = { invoiceNo: tender.attempt.invoiceNo, segment: shared.invoiceStationSegment('ZI7C') };
  const paid = await admin('POST', '/webhooks/2c2p/simulator', { attemptId: tender.attempt.id, event: 'paid' });
  assert.equal(paid.gatewayState, 'paid');
  await admin('POST', '/checkin/check-in-now', { saleId, entries: [{ checkinId, nannyId: null }] });
  const registration = await admin('GET', `/checkin/registrations/${registrationId}`);
  const child = registration.children.find((c: any) => c.id === checkinId);
  assert.equal(child.status, 'in_park');
  const detail = await admin('GET', `/sales/${saleId}`);
  const bandShort: string | undefined = (detail.bands ?? []).find((b: any) => b.id === child.bandId)?.shortCode;
  assert.ok(bandShort?.startsWith('ZI7C-'), 'the four-character till minted no band short code');
  assert.equal(shared.parseBandShortCode(bandShort!)?.prefix, 'ZI7C');
  r.bandShortCode = bandShort; r.childName = childName; save();

  // A genuine fixed-code voucher (booth code shape) for a seeded menu product.
  const menu = await admin('GET', `/branches/${branchId}/menu`);
  const product = (menu.products ?? []).find((p: any) => p.kind === 'menu' && p.active !== false && !p.archivedAt && (p.priceSatang ?? 0) > 0);
  assert.ok(product, 'a seeded menu product');
  const voucherCode = shared.mintBoothCode('ZZ', (maximum: number) => randomInt(maximum));
  assert.equal(shared.parseBandShortCode(voucherCode), null);
  const definition = await admin('POST', '/voucher-definitions', { code: `zz-test-s747-${stamp}`, nameEn: 'ZZ TEST SCRUM-747 voucher',
    kind: 'free_item', productId: product.id, codeMode: 'fixed', fixedCode: voucherCode, active: true, singleUse: true, expiryDays: 1, offlinePolicy: 'refuse', costSatang: 0 });
  r.voucher = { definitionId: definition.definition.id, product: product.name }; save();

  // Vite POS, proxied to this API.
  process.env.API_PORT = String(apiPort); process.env.POS_PORT = String(posPort);
  const { createServer: createVite } = await import(pathToFileURL(posRequire.resolve('vite')).href);
  vite = await createVite({ configFile: `${lane}/apps/pos/vite.config.ts`, root: `${lane}/apps/pos`, server: { port: posPort, host: '127.0.0.1', strictPort: true } });
  await vite.listen();

  browser = await chromium.launch();
  r.browser = browser.version();
  const shot = async (label: string, page: any) => {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
    await page.screenshot({ path: `${out}/${label}.png`, fullPage: true, mask: [page.locator('input[type=password], input[type=tel]')] });
    r.screens.push(`${label}.png`); save();
  };
  const tillPage = async (till: { id: string; name: string }) => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    context.setDefaultTimeout(30_000);
    const signIn = await context.request.post(`${origin}/api/auth/sign-in`, { data: { phone: H.ADMIN.phone, password: H.ADMIN.password } });
    assert.equal(signIn.status(), 200);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Which station are you on?' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(escapeRe(till.name)) }).click();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
    return { context, page };
  };

  // SCRUM-746: the typed band short code on the four-character till opens its order.
  const four = await tillPage(tills.ZI7C!);
  r.phase = 'typed band'; save();
  await four.page.goto(`${origin}/order-station`);
  const voucherCalls: string[] = [];
  four.page.on('request', (req: any) => { const p = new URL(req.url()).pathname; if (/vouchers/.test(p)) voucherCalls.push(`${req.method()} ${p}`); });
  await four.page.getByPlaceholder('Wristband code e.g. 1001').fill(bandShort!);
  await four.page.getByRole('button', { name: 'Load Tab', exact: true }).click();
  await expect(four.page.getByPlaceholder('Search dish…')).toBeVisible();
  await expect(four.page.getByText(childName, { exact: true }).first()).toBeVisible();
  await sleep(800);
  await expect(four.page.getByText(/Invalid code/)).toHaveCount(0);
  await expect(four.page.getByText(/No tab found/)).toHaveCount(0);
  await shot('s746-typed-band-four-character-till', four.page);
  r.cases.push({ name: 'typed band short code on a four-character till opens the band order', code: bandShort, voucherRequests: [...voucherCalls], passed: voucherCalls.length === 0 });
  assert.equal(voucherCalls.length, 0, 'the typed band reached the voucher path');
  save();

  // SCRUM-746: a genuine voucher typed into the same field still opens its tab.
  r.phase = 'typed voucher'; save();
  await four.page.goto(`${origin}/order-station`);
  await four.page.getByPlaceholder('Wristband code e.g. 1001').fill(voucherCode);
  const held = four.page.waitForResponse((res: any) => res.request().method() === 'POST' && /\/api\/sales\/[^/]+\/vouchers$/.test(new URL(res.url()).pathname));
  await four.page.getByRole('button', { name: 'Load Tab', exact: true }).click();
  const hold = await held;
  assert.equal(hold.status(), 200, 'the genuine voucher is held');
  await expect(four.page.getByRole('button', { name: 'Remove voucher', exact: true })).toBeVisible();
  await expect(four.page.getByText(/Invalid code/)).toHaveCount(0);
  await shot('s746-genuine-voucher-opens-its-tab', four.page);
  r.cases.push({ name: 'genuine voucher typed at F&B opens its tab and is held', passed: true }); save();

  // SCRUM-747: a gateway QR on the six-character till, through the native F&B tender.
  r.phase = 'six-character QR'; save();
  const six = await tillPage(tills.ZZ747A!);
  await six.page.goto(`${origin}/order-station`);
  await six.page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await six.page.getByPlaceholder('Search dish…').fill(product.name);
  await six.page.getByRole('button', { name: new RegExp(escapeRe(product.name)) }).first().click();
  const addToOrder = six.page.getByRole('dialog').getByRole('button', { name: /^Add to order/ });
  if (await addToOrder.isVisible().catch(() => false)) await addToOrder.click();
  await six.page.getByRole('button', { name: /^Charge ฿/ }).click();
  const pickup = six.page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  await sleep(500);
  if (await pickup.isVisible().catch(() => false)) {
    await pickup.getByRole('button', { name: '7', exact: true }).click();
    await pickup.getByRole('button', { name: '4', exact: true }).click();
    await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
  }
  await six.page.getByRole('button', { name: /^PromptPay/ }).click();
  const opened = six.page.waitForResponse((res: any) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/payments/attempts');
  await six.page.getByRole('button', { name: /Show payment QR/ }).click();
  const response = await opened;
  assert.equal(response.status(), 200, 'gateway QR request on the six-character till');
  const qr = await response.json();
  assert.equal(qr.attempt.provider, 'simulator');
  assert.match(qr.attempt.invoiceNo, /^[A-Z0-9]{1,20}$/);
  await expect(six.page.getByTestId('payment-qr').first()).toBeVisible();
  await shot('s747-gateway-qr-six-character-till', six.page);
  r.cases.push({ name: 'gateway QR on a six-character till', invoiceNo: qr.attempt.invoiceNo, segment: shared.invoiceStationSegment('ZZ747A'), passed: true }); save();
  const settled = await admin('POST', '/webhooks/2c2p/simulator', { attemptId: qr.attempt.id, event: 'paid' });
  assert.equal(settled.gatewayState, 'paid');
  await expect(six.page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible();
  await shot('s747-gateway-qr-six-character-till-paid', six.page);

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
