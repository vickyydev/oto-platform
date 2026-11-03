import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = 'C:/oto-lanes/codex-qr-review-phone-20261104';
const require = createRequire(root + '/apps/pos/package.json');
const { chromium, expect } = require('@playwright/test');
const POS = process.env.S739_POS;
if (process.env.S739_MODE !== 'local' || !['127.0.0.1', 'localhost'].includes(new URL(POS).hostname)) throw Error('Local proof only');
const stamp = Date.now().toString(36);
const out = 'C:/oto-lanes/s739-native-local/' + stamp;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const result = { mode: 'local', source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceFiles: Object.fromEntries(['apps/pos/src/App.tsx', 'apps/pos/src/components/mobile/MobileShell.tsx',
    'apps/pos/src/pages/MerchStation.tsx', 'apps/pos/src/lib/usePaymentStage.ts', 'apps/pos/dist/public/index.html']
    .map(p => [p, createHash('sha256').update(readFileSync(root + '/' + p)).digest('hex')])),
  cases: [], images: [], failures: [] };
const api = async (method, path, data) => {
  const action = randomUUID();
  const r = await ctx.request.fetch(POS + '/api' + path, { method, ...(data ? { data } : {}), headers: { 'idempotency-key': action, 'x-oto-action-id': action } });
  const b = await r.json();
  if (!r.ok()) throw Error(`${method} ${path.split('?')[0]}: ${r.status()} ${b.error?.code ?? ''}`);
  return b;
};
const shot = async name => { const path = out + '/' + name + '.png'; await page.screenshot({ path, fullPage: true, animations: 'disabled',
  mask: [page.locator('input[type=password]'), page.locator('[data-testid="display-pairing-code"]')] }); result.images.push(path); };
let phase = 'sign in';
try {
  await page.goto(POS);
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(process.env.S739_PHONE.replace(/^\+66/, '0'));
  await page.locator('input[type="password"][autocomplete="current-password"]').fill(process.env.S739_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which station are you on?' })).toBeVisible();
  const me = await api('GET', '/me');
  const branchId = me.operatorContext.branchId;
  phase = 'fixture';
  const createdBox = await api('POST', `/branches/${branchId}/boxes`, { name: 'ZZ TEST SCRUM-739 ' + stamp, slot: 'zz-test-s739-' + stamp, role: 'counter' });
  const boxId = createdBox.box.id;
  const created = await api('POST', `/branches/${branchId}/stations`, { name: 'ZZ TEST SCRUM-739 ' + stamp,
    kind: 'till', boxId, codePrefix: 'Z39', paymentRouting: { card: 'manual', qr: 'gateway' }, accessScope: 'all_staff', capabilities: [], devices: [] });
  const stationId = created.station.id;
  result.fixture = { boxId, stationId };
  await page.reload();
  await page.getByRole('button', { name: new RegExp('ZZ TEST SCRUM-739 ' + stamp) }).click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  for (const [kind, mobile] of [['food', false], ['shop', false], ['tickets', false], ['food', true], ['shop', true], ['tickets', true]]) {
  const label = kind + (mobile ? '-phone' : '-desktop');
  const current = { kind, mobile };
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.goto(POS + (kind === 'food' ? '/order-station' : kind === 'shop' ? '/merch-station' : '/'));
  phase = label + ' cart';
  if (kind === 'tickets') {
    if (!mobile) await page.getByRole('button', { name: /Skip.*walk-in/ }).click();
    await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
    await page.getByRole('heading', { name: '2 Hours Play', exact: true }).click();
    await page.getByRole('button', { name: 'Remove one Kids', exact: true }).first().click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    if (mobile) await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    await page.getByPlaceholder('e.g. Mama, John').fill('ZZ TEST SCRUM-739 ' + label);
    await page.getByRole('button', { name: 'Done', exact: true }).last().click();
    if (mobile) await page.getByRole('button', { name: /^Pay/ }).click();
  } else {
  await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  if (kind === 'food') {
  await page.getByPlaceholder('Search dish…').fill('French Fries');
  await page.getByRole('button', { name: /French Fries/ }).click();
  await page.getByRole('dialog').getByPlaceholder('e.g. no pickles, extra crispy').fill('ZZ TEST SCRUM-739 late QR');
  await page.getByRole('dialog').getByRole('button', { name: /^Add to order/ }).click();
  if (mobile) {
    await page.getByRole('button', { name: 'Open cart', exact: true }).click();
    await page.getByRole('button', { name: /^Checkout/ }).click();
  } else await page.getByRole('button', { name: /^Charge ฿/ }).click();
  const pickup = page.getByRole('dialog', { name: 'Pick-up Code' });
  await pickup.getByRole('button', { name: '7', exact: true }).click();
  await pickup.getByRole('button', { name: '9', exact: true }).click();
  await pickup.getByRole('button', { name: /^Continue to Payment/ }).click(); await expect(pickup).toBeHidden();
  if (mobile) {
    await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    await page.getByRole('button', { name: 'Customer confirmed — return phone to staff', exact: true }).click();
  }
  } else {
    await page.getByRole('button', { name: /Grip Socks/ }).click();
    const sizes = page.getByRole('dialog', { name: /Choose size.*Grip Socks/ });
    await sizes.getByRole('button').filter({ has: page.getByText('M', { exact: true }) }).click();
    await page.getByRole('button', { name: /^Charge ฿/ }).click();
  }
  }
  phase = label + ' QR choice';
  await shot(label + '-01-payment');
  await page.getByText('PromptPay', { exact: true }).first().click();
  const opened = page.waitForResponse(r => r.url().endsWith('/api/payments/attempts') && r.request().method() === 'POST').catch(() => null);
  await page.getByRole('button', { name: 'Show payment QR' }).click();
  const shown = await (await opened).json();
  if (shown.route !== 'gateway' || !shown.attempt?.id) throw Error('Gateway attempt not opened');
  current.saleId = shown.attempt.saleId; current.attemptId = shown.attempt.id;
  if (mobile && kind !== 'shop') {
    await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    await page.getByRole('button', { name: 'Done — return phone to staff', exact: true }).click();
  }
  const late = await api('POST', '/webhooks/2c2p/simulator', { attemptId: current.attemptId, event: 'late_paid' });
  if (late.webhookOutcome !== 'late_paid') throw Error('Simulator did not report late payment');
  const held = await api('GET', '/sales/' + current.saleId);
  if (held.sale.status !== 'tendering' || held.sale.receiptNumber) throw Error('Sale released before review');
  phase = label + ' review';
  await expect(page.getByTestId('payment-cancel-qr')).toHaveCount(0);
  // The phone ticket screen also has a separate button for showing the same
  // QR to the guest. Check the submit inside the payment step, not that door.
  await expect(page.getByTestId('payment-stage').locator('..')
    .getByRole('button', { name: 'Show payment QR', exact: true })).toBeDisabled();
  await shot(label + '-02-held');
  if (mobile && kind === 'shop') {
    await page.getByLabel('Lock screen').click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
    await expect(page.getByTestId('payment-stage')).toHaveCount(0);
    await shot(label + '-02b-staff-locked');
    await page.locator('input[type="password"][autocomplete="current-password"]').fill(process.env.S739_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Review the QR payment', exact: true })).toBeVisible();
    const resumed = await api('GET', '/sales/' + current.saleId);
    if (resumed.attempts.length !== 1 || resumed.attempts[0].id !== current.attemptId) throw Error('Shop lock replaced the attempt');
    current.staffLockPreservedAttempt = true;
  }
  await page.getByRole('button', { name: 'Review the QR payment' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toHaveCSS('opacity', '1');
  await expect(dialog.getByRole('button', { name: 'Money taken', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'No money taken', exact: true })).toBeDisabled();
  await shot(label + '-03-review-locked');
  await dialog.locator('#payment-confirm-note').fill('ZZ TEST checked simulator bank slip and gateway report');
  await expect(dialog.getByRole('button', { name: 'Money taken', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await shot(label + '-04-review-ready');
  const confirmed = page.waitForResponse(r => r.url().endsWith(`/api/payments/attempts/${current.attemptId}/confirm`) && r.request().method() === 'POST').catch(() => null);
  await dialog.getByRole('button', { name: 'Money taken', exact: true }).click();
  if ((await confirmed).status() !== 200) throw Error('Review refused');
  await expect.poll(async () => (await api('GET', '/sales/' + current.saleId)).sale.status).toBe('finalised');
  const readback = await api('GET', '/sales/' + current.saleId);
  current.readback = { saleId: readback.sale.id, status: readback.sale.status, receiptNumber: readback.sale.receiptNumber,
    attempts: readback.attempts.map(a => ({ id: a.id, status: a.status, amountSatang: a.amountSatang })) };
  if (readback.attempts.length !== 1 || readback.attempts[0].status !== 'approved') throw Error('Payment count differs');
  await expect(page.getByTestId('payment-stage')).toHaveCount(0);
  await shot(label + '-05-completed');
  result.cases.push(current);
  console.log(label + ': held, reviewed, finished and read back once');
  }
} catch (e) {
  result.failures.push({ phase, type: e.name, message: String(e.message).split('\n')[0].slice(0, 250) });
  await shot('failure-' + phase.replaceAll(' ', '-')).catch(() => {});
  process.exitCode = 1;
} finally {
  await api('POST', '/auth/sign-out', {}).catch(() => {});
  await browser.close();
  writeFileSync(out + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, phase, cases: result.cases, failures: result.failures }));
}
