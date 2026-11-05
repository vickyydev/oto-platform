import { expect, request as playwrightRequest, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-768 follow-up — A FREE REGULAR SOCKS ON THE ORDER PANEL'S SOCKS COUNTER.
 *
 * A ZZ TEST ticket is created through the route the admin app's ticket form
 * saves with, bundling one free Regular Socks (the branch's socks product,
 * code AO-SOCKS) for Tourist only. A walk-in Tourist family of one child and
 * one adult, who give their number on the customer half, takes two socks on
 * the order panel's counter: the panel charges one at the socks product's
 * price and says one is free, the customer display lists "Regular Socks
 * (free)" at ฿0, the platform files both, and the receipt the station's
 * printer draws prints both. The ticket is archived afterwards.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/ticket-free-socks.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';
const TICKET = 'ZZ TEST 768 Socks';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function adminContext(baseURL: string): Promise<APIRequestContext> {
  const admin = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  return admin;
}

const key = () => `s768-socks-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The branch, its Regular Socks product, and a new ZZ TEST ticket bundling one free for Tourist. */
async function createTicket(admin: APIRequestContext): Promise<{ branchId: string; ticketId: string; socksId: string; socksSatang: number }> {
  const listed = await admin.get('/api/branches');
  expect(listed.status(), await listed.text()).toBe(200);
  const branch = ((await listed.json()) as { branches: Array<{ id: string; code: string }> }).branches.find(
    (b) => b.code === BRANCH_CODE,
  )!;
  const menu = await admin.get(`/api/branches/${branch.id}/menu`);
  expect(menu.status(), await menu.text()).toBe(200);
  const socks = ((await menu.json()) as { products: Array<{ id: string; code: string | null; priceSatang: number }> }).products.find(
    (p) => p.code === 'AO-SOCKS',
  )!;
  expect(socks, 'the branch sells Regular Socks').toBeTruthy();
  const created = await admin.post(`/api/branches/${branch.id}/ticket-packages`, {
    data: {
      name: TICKET,
      durationLabel: '2 Hours',
      hours: 2,
      prices: {
        tourist: { weekday: 50_000, weekend: 60_000 },
        expat: { weekday: 50_000, weekend: 60_000 },
        thai: { weekday: 50_000, weekend: 60_000 },
      },
      adultRules: {
        tourist: { kind: 'same_as_kid' },
        expat: { kind: 'same_as_kid' },
        thai: { kind: 'same_as_kid' },
      },
      freebies: [{ id: 'zz-test-free-socks', kind: 'addon', addOnId: socks.id, quantity: 1, tiers: ['tourist'] }],
      gateAccess: true,
      active: true,
    },
    headers: { 'idempotency-key': key() },
  });
  expect(created.status(), await created.text()).toBe(200);
  return { branchId: branch.id, ticketId: ((await created.json()) as { id: string }).id, socksId: socks.id, socksSatang: socks.priceSatang };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
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

/**
 * Step one of the order panel's steppers to `target`. The panel is named:
 * Regular Socks is also a card in the add-on grid beside it, and the socks
 * counter is the one on the order panel.
 */
async function stepTo(panel: Locator, label: 'Kids' | 'Adults' | 'Regular Socks', target: number): Promise<void> {
  const add = panel.getByRole('button', { name: `Add one ${label}` }).first();
  const remove = panel.getByRole('button', { name: `Remove one ${label}` }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 6; i += 1) {
    const now = Number(await value.textContent());
    if (now === target) return;
    await (now < target ? add : remove).click();
  }
  await expect(value).toHaveText(String(target));
}

test('a free Regular Socks on the ticket comes off the socks counter, which charges the socks price', async ({ page, baseURL }) => {
  requireFixture();
  const admin = await adminContext(baseURL!);
  const made = await createTicket(admin);
  const socksBaht = made.socksSatang / 100;
  try {
    await signIn(page);
    await walkInByPhone(page, '812076208');
    await page.getByRole('heading', { name: 'Tourist' }).click();
    await page.getByRole('heading', { name: TICKET }).click();
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
    const order = page.getByRole('heading', { name: 'Current Order' }).locator('../..');
    await stepTo(order, 'Kids', 1);
    await stepTo(order, 'Adults', 1);
    await stepTo(order, 'Regular Socks', 2);

    // The order panel: the counter charges the socks product's price and says
    // one of the two is free; the customer display lists the free one at ฿0.
    await expect(order.getByText(`฿${socksBaht} each · 1 free`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Regular Socks (free)').first()).toBeVisible({ timeout: 15_000 });
    await shot(page, '01-order-panel-and-display-one-socks-free');

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const payButton = page.getByRole('button', { name: /^Pay ฿/ });
    await expect(payButton).toBeEnabled({ timeout: 20_000 });
    const due = ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').replace(/,/g, '').trim();
    await payButton.click();
    // A walk-in hands the display over for a phone number; Done hands it back.
    const done = page.getByRole('button', { name: 'Done', exact: true });
    if (await done.isVisible().catch(() => false)) await done.click();
    await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });
    await shot(page, '02-amount-due-one-socks-charged');
    await page.getByRole('heading', { name: 'Cash' }).click();
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
    await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
    await shot(page, '03-paid-one-socks-charged-one-free');

    // The ledger: the figure the till showed, one sock at its price and the free one at ฿0.
    const listed = (await (await page.request.get('/api/sales?limit=5')).json()) as { sales: Array<{ id: string }> };
    const saleId = listed.sales[0]!.id;
    const read = (await (await page.request.get(`/api/sales/${saleId}`)).json()) as {
      sale: { status: string; stationId: string; totals: { grossSatang: number } };
      lines: Array<{ kind: string; label: string; quantity: number; grossSatang: number }>;
    };
    expect(read.sale.status).toBe('finalised');
    expect(read.sale.totals.grossSatang).toBe(Math.round(Number(due) * 100));
    // One child and one adult at the ticket's weekday or weekend price, and one sock.
    expect([2 * 50_000, 2 * 60_000].map((t) => t + made.socksSatang)).toContain(read.sale.totals.grossSatang);
    // Both are the counter's socks, not an add-on from the grid.
    expect(
      read.lines
        .filter((l) => l.label.startsWith('Regular Socks'))
        .map((l) => [l.kind, l.label, l.quantity, l.grossSatang]),
    ).toEqual([
      ['socks', 'Regular Socks', 1, made.socksSatang],
      ['socks', 'Regular Socks (free)', 1, 0],
    ]);

    // The receipt the station's printer drew, as the Console's printer panel shows it.
    if (SHOTS) {
      const printers = (await (await page.request.get(`/api/stations/${read.sale.stationId}/printers`)).json()) as {
        printers: Array<{ deviceId: string; role: string }>;
      };
      const receiptPrinter = printers.printers.find((p) => p.role === 'receipt');
      expect(receiptPrinter, 'the till has a receipt printer').toBeTruthy();
      let preview: string | null = null;
      await expect
        .poll(
          async () => {
            const res = await admin.get(`/api/devices/${receiptPrinter!.deviceId}/printouts?limit=20`);
            if (res.status() !== 200) return false;
            const body = (await res.json()) as {
              printouts: Array<{ seq: number; heightDots: number; previewUrl: string }>;
            };
            // Newest last; a printout with no dots is the printer's own set-up, not a receipt.
            preview = body.printouts.filter((p) => p.heightDots > 0).at(-1)?.previewUrl ?? null;
            return preview !== null;
          },
          { timeout: 45_000 },
        )
        .toBe(true);
      const png = await admin.get(`/api${preview!}`);
      expect(png.status()).toBe(200);
      await writeFile(resolve(SHOTS, '04-receipt-printed-socks-and-free-socks.png'), await png.body());
    }
  } finally {
    const archived = await admin.delete(`/api/branches/${made.branchId}/ticket-packages/${made.ticketId}`, {
      headers: { 'idempotency-key': key() },
    });
    expect(archived.status(), await archived.text()).toBe(200);
    await admin.dispose();
  }
});
