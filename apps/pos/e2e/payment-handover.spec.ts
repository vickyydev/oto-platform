import { expect, request, test, type Page } from '@playwright/test';

// Real disposable API, two seeded accounts, real session revocation and gateway
// simulator. No route interception, credentials in artifacts, or staging target.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);
const phone = process.env.POS_E2E_PHONE ?? '';
const password = process.env.POS_E2E_PASSWORD ?? '';
const adminPhone = process.env.POS_E2E_ADMIN_PHONE ?? '';
const adminPassword = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
async function signIn(page: Page, second = false) {
  await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(second ? adminPhone.replace(/^\+66/, '') : phone)
    .catch(() => { throw new Error('Sign-in phone field unavailable'); });
  await page.locator('input[type="password"]').first().fill(second ? adminPassword : password)
    .catch(() => { throw new Error('Sign-in password field unavailable'); });
  const response = page.waitForResponse(r => r.url().endsWith('/api/auth/sign-in') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
}

for (const ending of ['paid', 'cancelled-then-cash'] as const) {
  test(`SCRUM-982 F&B: another account continues waiting QR, ${ending}, one sale`, async ({ page, baseURL }) => {
    if (!process.env.POS_E2E_DATABASE_URL || process.env.PAYMENTS_SIMULATOR !== 'on' || !baseURL
      || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Requires disposable local simulator harness');
    const admin = await request.newContext({ baseURL });
    expect((await admin.post('/api/auth/sign-in', { data: { phone: adminPhone, password: adminPassword } })).status()).toBe(200);
    const sales: string[] = [];
    page.on('response', async r => {
      if (new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST' && r.ok()) {
        const body = await r.json(); if (body.sale?.id) sales.push(body.sale.id);
      }
    });
    try {
      await page.goto('/'); await signIn(page);
      await page.getByRole('button', { name: /Reception Till 1/ }).click();
      await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
      const me = await (await page.request.get('/api/me')).json();
      const link = await (await page.request.get('/api/me/station/link')).json();
      expect((await admin.patch(`/api/stations/${link.stationId}`, { data: { paymentRouting: { card: 'manual', qr: 'gateway' } },
        headers: { 'Idempotency-Key': crypto.randomUUID() } })).status()).toBe(200);
      // Refresh before the order so the station's route is read from the API.
      await page.reload();
      await page.getByRole('button', { name: 'F&B', exact: true }).click();
      await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
      await page.getByPlaceholder('Search dish\u2026').fill('French Fries');
      await page.getByRole('button', { name: /French Fries/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^Add to order/ }).click();
      await page.getByRole('button', { name: /^Charge / }).click();
      const pickup = page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
      await pickup.getByRole('button', { name: '1', exact: true }).click();
      await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
      await page.getByRole('button', { name: /^(PromptPay|QR)/ }).click();
      const started = page.waitForResponse(r => r.url().endsWith('/api/payments/attempts') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Show payment QR', exact: true }).click();
      const response = await started; expect(response.status()).toBe(200);
      const { attempt } = await response.json();
      expect((await admin.post(`/api/accounts/${me.account.id}/sessions/revoke`, { headers: { 'Idempotency-Key': crypto.randomUUID() } })).status()).toBe(200);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 30_000 });
      await signIn(page, true);
      await page.getByRole('button', { name: 'Continue this sale', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Cancel payment QR', exact: true })).toBeVisible();
      if (ending === 'paid') {
        expect((await admin.post('/api/webhooks/2c2p/simulator', { data: { attemptId: attempt.id, event: 'paid' },
          headers: { 'Idempotency-Key': crypto.randomUUID() } })).status()).toBe(200);
      } else {
        await page.getByRole('button', { name: 'Cancel payment QR', exact: true }).click();
        await page.getByRole('button', { name: /^Cash / }).click();
        await page.getByRole('button', { name: 'Record cash', exact: true }).click();
      }
      await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible({ timeout: 30_000 });
      const detail = await (await admin.get(`/api/sales/${attempt.saleId}`)).json();
      expect(detail.sale.status).toBe('finalised');
      expect([...new Set(sales)]).toEqual([attempt.saleId]);
      const paid = detail.attempts.filter((a: { status: string }) => a.status === 'approved');
      expect(paid).toHaveLength(1);
      expect(paid[0].method).toBe(ending === 'paid' ? 'qr' : 'cash');
      const history = await (await admin.get(`/api/sales?stationId=${link.stationId}&limit=100`)).json();
      expect(history.sales.find((sale: { id: string }) => sale.id === attempt.saleId)?.soldBy?.accountId).toBe(me.account.id);
      await expect(page.getByText(ending === 'paid' ? 'Thai QR / PromptPay' : 'Cash', { exact: true }).first()).toBeVisible();
    } finally {
      await page.request.post('/api/auth/sign-out');
      await admin.post('/api/auth/sign-out');
      await admin.dispose();
    }
  });
}
