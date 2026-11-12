import { expect, test, type Page } from '@playwright/test';

/**
 * SCRUM-900 — A REFUND SAYS WHEN THE BAR WAS NOT SENT ITS VOID SLIP.
 *
 * A hot dog for the kitchen and a juice for the bar are rung up at Reception
 * Till 1 while it has a bar printer, and paid in cash: the kitchen and the bar
 * each get their ticket. The bar printer is then taken off the till, and the
 * sale is refunded whole from History on the real till. The kitchen's void
 * slip goes; the bar's cannot, and the till says so in the toast a sale's
 * printing notes use — "Some items not printed: Void slip for the bar not
 * printed — no bar printer at Reception Till 1" — where until now it said
 * nothing and the bar went on making the juice.
 *
 * Runs on the isolated harness as the seeded owner, who may refund without a
 * manager's approval and set a station up:
 * `pnpm --filter @oto/pos e2e e2e/refund-void-slip-note.spec.ts`.
 */

const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(ADMIN_PHONE.replace(/^\+66/, ''));
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect
    .poll(async () => (await picker.isVisible()) || (await page.getByText('Membership Check', { exact: true }).isVisible()), {
      timeout: 30_000,
    })
    .toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
}

const key = () => `s900-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const uuid = () => crypto.randomUUID();

type Assignment = { role: string; deviceId: string };

test('a refund whose bar slip cannot print says so on the till, as a sale’s printing notes do', async ({ page, baseURL }) => {
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
  await signIn(page);
  const headers = { origin: baseURL! };

  const me = await page.request.get('/api/me', { headers });
  expect(me.status(), await me.text()).toBe(200);
  const meBody = (await me.json()) as { branch: { id: string } | null; operatorContext: { stationId: string | null } };
  const branchId = meBody.branch!.id;
  const stationId = meBody.operatorContext.stationId!;
  expect(stationId, 'the till holds a station').toBeTruthy();

  // Reception Till 1 as seeded: a kitchen printer, no bar printer. Give it one.
  const read = await page.request.get(`/api/stations/${stationId}`, { headers });
  expect(read.status(), await read.text()).toBe(200);
  const station = (await read.json()).station as { name: string; devices: Assignment[] };
  const seeded = station.devices.map(({ role, deviceId }) => ({ role, deviceId }));
  const receipt = seeded.find((d) => d.role === 'receipt');
  expect(receipt, 'the till has a receipt printer').toBeTruthy();
  const setDevices = async (devices: Assignment[]) => {
    const res = await page.request.patch(`/api/stations/${stationId}`, {
      headers: { ...headers, 'idempotency-key': key() },
      data: { devices },
    });
    expect(res.status(), await res.text()).toBe(200);
  };
  await setDevices([...seeded.filter((d) => d.role !== 'bar'), { role: 'bar', deviceId: receipt!.deviceId }]);

  // The order, paid in full in cash: its kitchen and bar tickets go to the till's printers.
  const menu = await page.request.get(`/api/branches/${branchId}/menu`, { headers });
  expect(menu.status(), await menu.text()).toBe(200);
  const products = ((await menu.json()) as { products: Array<{ id: string; code: string | null }> }).products;
  const hotdog = products.find((p) => p.code === 'FB-HOTDOG');
  const juice = products.find((p) => p.code === 'FB-JUICE');
  expect(hotdog && juice, 'the branch sells a hot dog and a juice').toBeTruthy();
  const saleId = uuid();
  const created = await page.request.post('/api/sales', {
    headers: { ...headers, 'idempotency-key': key() },
    data: {
      id: saleId,
      stationId,
      channel: 'fnb',
      pickupCode: '78',
      items: [
        { id: uuid(), productId: hotdog!.id, quantity: 1 },
        { id: uuid(), productId: juice!.id, quantity: 1 },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const gross = ((await created.json()) as { sale: { totals: { grossSatang: number } } }).sale.totals.grossSatang;
  const paid = await page.request.post(`/api/sales/${saleId}/finalise`, {
    headers: { ...headers, 'idempotency-key': key() },
    data: { method: 'cash', kind: 'cash', amountSatang: gross, tenderedSatang: gross, actionId: uuid() },
  });
  expect(paid.status(), await paid.text()).toBe(200);
  const closed = (await paid.json()) as {
    finalised: boolean;
    sale: { receiptNumber: string };
    printing: { jobs: Array<{ kind: string; status: string }> };
  };
  expect(closed.finalised).toBe(true);
  expect(closed.printing.jobs.filter((j) => j.kind === 'bar_ticket').map((j) => j.status)).toEqual(['queued']);

  // The bar printer is taken off the till before the refund.
  await setDevices(seeded.filter((d) => d.role !== 'bar'));

  await page.goto('/history');
  await expect(page.getByLabel('Search transactions')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button').filter({ hasText: closed.sale.receiptNumber }).first().click();
  const refundButton = page.getByTestId('refund-sale');
  await expect(refundButton).toBeEnabled({ timeout: 20_000 });
  await refundButton.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();

  const sent = page.waitForResponse(
    (res) => res.url().includes(`/api/sales/${saleId}/refunds`) && res.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: /^Refund ฿/ }).click();
  const answer = await sent;
  expect(answer.status(), await answer.text()).toBe(200);
  const note = `Void slip for the bar not printed — no bar printer at ${station.name}`;
  expect(((await answer.json()) as { printing?: { notes: string[] } }).printing).toEqual({ notes: [note] });

  // On the till: recorded, and the bar's slip said not printed, as a sale's notes are.
  await expect(page.getByTestId('refund-recorded')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Some items not printed').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(note).first()).toBeVisible();
});
