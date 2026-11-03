import { expect, request, test, type Page } from '@playwright/test';
import { bandShortCode } from '@oto/shared';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * SCRUM-731 — A WRISTBAND AND A CREDIT VOUCHER READ THROUGH THE BOX'S SCANNER.
 *
 * The path is the simulator's, which feeds the code as key events through the
 * reader that reads the real scanner, and it lands on the box running in the
 * api's process (`PROCESS_ROLES=api,edge`). The till then hears it as it hears
 * any scan. So this proves everything from the reader to the screen; the cradle
 * itself, and a box on a Raspberry Pi, are for the bench.
 *
 * It owns no data of its own. `pnpm --filter @oto/pos e2e -- e2e/band-scan.spec.ts`
 * builds a disposable database and signs in the seeded reception account. The
 * family and the voucher below are made through the routes the till calls.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const DATABASE_URL = process.env.POS_E2E_DATABASE_URL ?? '';
const root = resolve(import.meta.dirname, '../../..');
const PROOF = resolve(root, 'docs/qa/proof-2026-11-03/s731');

test.use({ trace: 'off', video: 'off', screenshot: 'off', viewport: { width: 1280, height: 860 } });
test.setTimeout(240_000);

const requireDb = createRequire(resolve(root, 'packages/db/package.json'));
const { Pool } = requireDb('pg') as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>;
    end: () => Promise<void>;
  };
};

async function fromDatabase<T>(run: (pool: InstanceType<typeof Pool>) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
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
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
}

/** One write the way the till sends it, in the signed-in page's session. */
async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api${url}`, {
    headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    data,
  });
  expect(res.status(), `${url}: ${await res.text()}`).toBe(200);
  return (await res.json()) as T;
}

/** The counter scanner, simulated: key events through the reader the real scanner goes through. */
async function scanAtTheBox(page: Page, stationId: string, code: string) {
  return post<{ kind: string; outcome: string; handler: string | null; errorCode: string | null; recognised: boolean }>(
    page,
    `/stations/${stationId}/scan/simulate`,
    { code, mode: 'hid' },
  );
}

/** The till's station, its branch and the two packages these flows sell. */
async function theCounter() {
  return fromDatabase(async (pool) => {
    const { rows } = await pool.query(
      `select s.id, s.branch_id from core.station s where s.code_prefix = 'T1' and s.name = 'Reception Till 1' limit 1`,
    );
    const packages = await pool.query(
      `select name, id from pos.ticket_package where branch_id = $1 and archived_at is null and name in ('2 Hours Play', 'Eat & Play Kids Pass')`,
      [rows[0]!.branch_id],
    );
    const idOf = (name: string) => packages.rows.find((p) => p.name === name)!.id!;
    return {
      stationId: rows[0]!.id!,
      branchId: rows[0]!.branch_id!,
      packageId: idOf('2 Hours Play'),
      creditPackageId: idOf('Eat & Play Kids Pass'),
    };
  });
}

/** A child with an allergy, registered, paid for and in the park: the band's signed code. */
async function childInPark(
  page: Page,
  at: Awaited<ReturnType<typeof theCounter>>,
  child: { name: string; allergies: string; foodRestrictions: string | null },
): Promise<string> {
  const checkinId = randomUUID();
  await post(page, '/checkin/registrations', {
    id: randomUUID(),
    branchId: at.branchId,
    stationId: at.stationId,
    guardianName: 'ZZ TEST Guardian',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [{ checkinId, ageYears: 6, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 }, ...child }],
  });
  const saleId = randomUUID();
  await post(page, '/sales', {
    id: saleId,
    stationId: at.stationId,
    lines: [
      {
        id: checkinId,
        packageId: at.packageId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        foodProvision: null,
      },
    ],
  });
  await post(page, `/sales/${saleId}/finalise`, {});
  await post(page, '/checkin/check-in-now', { saleId, entries: [{ checkinId, nannyId: null }] });
  return fromDatabase(async (pool) => {
    const { rows } = await pool.query(
      `select b.code from pos.checkin c join pos.band b on b.id = c.band_id where c.id = $1`,
      [checkinId],
    );
    return rows[0]!.code!;
  });
}

/** Past the stream's bounded open, so the screen is listening whichever way it reached. */
const screenIsListening = (page: Page) => page.waitForTimeout(5_000);

const onTheDisposableStack = (baseURL: string | undefined) => {
  test.skip(!PHONE || !PASSWORD || !DATABASE_URL, 'Runs on the disposable stack: pnpm --filter @oto/pos e2e -- e2e/band-scan.spec.ts');
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local only');
};

const CHILD = 'ZZ TEST Scan Child';
const ALLERGY = 'ZZ TEST peanut allergy';
const DIET = 'ZZ TEST no dairy';

test('a band and a credit voucher read through the box open what a typed code opens', async ({ page, baseURL }) => {
  onTheDisposableStack(baseURL);
  await mkdir(PROOF, { recursive: true });
  // After the screens' fade-in and the toast's slide, so the picture reads.
  const shot = async (name: string) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(PROOF, `${name}.png`) });
  };

  await signIn(page);
  const at = await theCounter();
  const { stationId } = at;
  const bandCode = await childInPark(page, at, { name: CHILD, allergies: ALLERGY, foodRestrictions: DIET });
  const short = bandShortCode(bandCode)!;

  // --- A credit voucher: the wallet a ticket that pays credit grants. ---
  const voucherSaleId = randomUUID();
  await post(page, '/sales', {
    id: voucherSaleId,
    stationId,
    lines: [{ id: randomUUID(), packageId: at.creditPackageId, kids: 0, adults: 1 }],
  });
  const closed = await post<{ grants?: Array<{ qrCode?: string | null }> }>(page, `/sales/${voucherSaleId}/finalise`, {});
  const walletQr = closed.grants?.find((g) => g.qrCode)?.qrCode ?? '';
  expect(walletQr, 'the ticket granted a wallet with a voucher QR').toMatch(/^QR-/);

  // --- F&B: the band opens the order, with the child's safety banner. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  // The field no longer opens a numbers-first keyboard: band codes carry letters.
  await expect(page.getByPlaceholder(/Wristband code/)).toHaveAttribute('inputmode', 'text');
  await screenIsListening(page);

  const read = await scanAtTheBox(page, stationId, bandCode);
  expect(read).toMatchObject({ kind: 'band', outcome: 'handled', handler: 'band', recognised: true });

  await expect(page.getByText(`Allergy / medical alert · ${CHILD}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ALLERGY, { exact: true })).toBeVisible();
  await expect(page.getByText(`Restriction: ${DIET}`)).toBeVisible();
  await shot('1-fnb-band-opens-the-order');

  // The same band again: already open, and the order is as it was.
  await scanAtTheBox(page, stationId, bandCode);
  await expect(page.getByText('This wristband is already open').first()).toBeVisible({ timeout: 10_000 });

  // A different code mid-order: the order on screen does not change.
  await scanAtTheBox(page, stationId, walletQr);
  await expect(page.getByText('Credit voucher not opened').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`Allergy / medical alert · ${CHILD}`)).toBeVisible();
  await shot('2-fnb-mid-order-changes-nothing');

  // --- F&B: a credit voucher opens its tab, with its credit. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);
  const qrRead = await scanAtTheBox(page, stationId, walletQr);
  expect(qrRead).toMatchObject({ kind: 'wallet', outcome: 'handled', handler: 'wallet-qr' });
  await expect(page.getByText(/฿[\d,.]+ credit/).first()).toBeVisible({ timeout: 15_000 });
  await shot('3-fnb-credit-voucher-opens-its-tab');

  // --- The shop: the same band opens the sale. ---
  await page.goto('/merch-station');
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);
  await scanAtTheBox(page, stationId, bandCode);
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(CHILD).first()).toBeVisible({ timeout: 15_000 });
  await shot('4-shop-band-opens-the-sale');

  // --- History: the band opens its orders, from the day's list. ---
  await page.goto('/history');
  await expect(page.getByLabel('Search transactions')).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);
  await scanAtTheBox(page, stationId, bandCode);
  await expect(page.getByText(`#${short}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Total spent').first()).toBeVisible();
  await shot('5-history-band-opens-its-orders');

  // A credit voucher is not a bracelet there, as its typed form says, and History says so.
  await scanAtTheBox(page, stationId, walletQr);
  await expect(page.getByText('That is a credit voucher, not a bracelet').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`#${short}`)).toBeVisible();

  // --- The ticket till: the band means nothing to the sale, and it says where it goes. ---
  await page.goto('/');
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);
  await scanAtTheBox(page, stationId, bandCode);
  await expect(page.getByText(`That is wristband ${short}`).first()).toBeVisible({ timeout: 10_000 });
  await shot('6-ticket-till-says-where-a-band-goes');
});

test('a band read mid-payment changes nothing, and the sale is what it was', async ({ page, baseURL }) => {
  onTheDisposableStack(baseURL);
  await mkdir(PROOF, { recursive: true });

  await signIn(page);
  const at = await theCounter();
  const bandCode = await childInPark(page, at, {
    name: 'ZZ TEST Second Child',
    allergies: 'ZZ TEST egg allergy',
    foodRestrictions: null,
  });

  // A guest sale with one item on it, at the payment screen.
  await page.goto('/merch-station');
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);
  await page.getByRole('button', { name: /No wristband/ }).click();
  const firstItem = page.getByRole('button', { name: /฿/ }).first();
  await expect(firstItem).toBeVisible({ timeout: 15_000 });
  await firstItem.click();
  // A size to pick, when the first item has sizes.
  const sized = page.getByRole('dialog').getByRole('button', { name: /฿|Add|M\b|S\b/ }).first();
  if (await sized.isVisible().catch(() => false)) await sized.click();
  const charge = page.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 15_000 });
  const owed = (await charge.textContent())!.trim();
  await charge.click();
  await expect(charge).toBeHidden({ timeout: 15_000 });

  await scanAtTheBox(page, at.stationId, bandCode);
  await expect(page.getByText(/^Wristband .* not opened$/).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('ZZ TEST Second Child')).toHaveCount(0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(PROOF, '7-mid-payment-changes-nothing.png') });
  await page.getByRole('button', { name: /^Back/ }).first().click();
  await expect(charge).toBeVisible({ timeout: 10_000 });
  expect((await charge.textContent())!.trim(), 'the sale is what it was').toBe(owed);
  await expect(page.getByText('ZZ TEST Second Child')).toHaveCount(0);
});

test('a band read while Add time is open is ticked, as the typed code ticks it', async ({ page, baseURL }) => {
  onTheDisposableStack(baseURL);
  await mkdir(PROOF, { recursive: true });

  await signIn(page);
  const at = await theCounter();
  const bandCode = await childInPark(page, at, { name: 'ZZ TEST Fourth Child', allergies: 'ZZ TEST sesame allergy', foodRestrictions: null });
  const otherBand = await childInPark(page, at, { name: 'ZZ TEST Fifth Child', allergies: 'ZZ TEST soy allergy', foodRestrictions: null });
  const short = bandShortCode(bandCode)!;

  await page.goto('/history');
  await expect(page.getByLabel('Search transactions')).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);
  await scanAtTheBox(page, at.stationId, bandCode);
  await expect(page.getByText(`#${short}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('button', { hasText: '฿' }).first()).toBeVisible({ timeout: 15_000 });
  await page.locator('button', { hasText: '฿' }).first().click();
  const addTime = page.getByRole('button', { name: 'Add time', exact: true });
  await expect(addTime).toBeEnabled({ timeout: 15_000 });

  // On the sale with no dialog open, another band does not take it off the screen.
  await scanAtTheBox(page, at.stationId, otherBand);
  await expect(page.getByText(/^Bracelet .* not opened$/).first()).toBeVisible({ timeout: 10_000 });
  await expect(addTime).toBeVisible();

  await addTime.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add time' })).toBeVisible({ timeout: 10_000 });
  const bracelet = dialog.getByRole('checkbox', { name: short });
  await bracelet.uncheck();
  await expect(bracelet).not.toBeChecked();

  // The band read by the box ticks it, and the dialog stays where it was.
  await scanAtTheBox(page, at.stationId, bandCode);
  await expect(page.getByText(`Bracelet ${short} added`).first()).toBeVisible({ timeout: 10_000 });
  await expect(bracelet).toBeChecked();
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(PROOF, '8-add-time-takes-the-band.png') });

  // Again: nothing would move on screen, so it says so.
  await scanAtTheBox(page, at.stationId, bandCode);
  await expect(page.getByText(`Bracelet ${short} is already ticked`).first()).toBeVisible({ timeout: 10_000 });

  // A band from another receipt gets the words its typed code gets.
  await scanAtTheBox(page, at.stationId, otherBand);
  await expect(dialog.getByText('This bracelet is not eligible on this receipt.')).toBeVisible({ timeout: 10_000 });
  await expect(bracelet).toBeChecked();

  // Count only has nothing to tick.
  await dialog.getByRole('button', { name: 'Count only' }).click();
  await scanAtTheBox(page, at.stationId, bandCode);
  await expect(page.getByText(/Count only is chosen here/).first()).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Select or scan bracelets' }).click();

  // Once the charge has the bracelets, a scan never reaches what it pays for.
  await dialog.getByRole('button', { name: /\+30 minutes/ }).click();
  await dialog.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(dialog.getByRole('button', { name: 'Continue to payment' })).toBeHidden({ timeout: 15_000 });
  await scanAtTheBox(page, at.stationId, bandCode);
  await expect(page.getByText(/already set for payment/).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(PROOF, '9-add-time-mid-payment-changes-nothing.png') });
});

test('a band read while the station is locked does not land after the unlock', async ({ page, baseURL }) => {
  onTheDisposableStack(baseURL);
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Needs a second session to scan while this one is locked');

  await signIn(page);
  const at = await theCounter();
  const bandCode = await childInPark(page, at, {
    name: 'ZZ TEST Third Child',
    allergies: 'ZZ TEST milk allergy',
    foodRestrictions: null,
  });

  await page.goto('/merch-station');
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeVisible({ timeout: 20_000 });
  await screenIsListening(page);

  await page.getByLabel('Lock screen').click();
  const locked = page.getByRole('heading', { name: 'Locked', exact: true });
  if (!(await locked.isVisible().catch(() => false))) {
    const lockNow = page.getByRole('button', { name: /^Lock/ }).first();
    if (await lockNow.isVisible().catch(() => false)) await lockNow.click();
  }
  await expect(locked).toBeVisible({ timeout: 10_000 });

  // The locked session cannot scan, so a second session does, as the box would.
  const secondSession = await request.newContext({ baseURL: baseURL! });
  const signedIn = await secondSession.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  const heard = await secondSession.post(`/api/stations/${at.stationId}/scan/simulate`, {
    headers: { 'idempotency-key': randomUUID() },
    data: { code: bandCode, mode: 'hid' },
  });
  expect(heard.status(), await heard.text()).toBe(200);
  expect((await heard.json()) as { kind: string }).toMatchObject({ kind: 'band', outcome: 'handled' });
  await secondSession.dispose();

  await page.waitForTimeout(4_000);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(locked).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeVisible();
  await expect(page.getByText('ZZ TEST Third Child')).toHaveCount(0);
});
