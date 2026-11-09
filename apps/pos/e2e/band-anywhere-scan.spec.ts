import { expect, test, type Page } from '@playwright/test';
import { bandShortCode, mintBookingQr, mintBoothCode } from '@oto/shared';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * SCRUM-766 — A WRISTBAND SCANNED FROM ANYWHERE ON THE SCREEN.
 *
 * With the scanner's cradle in the iPad, the scanner types as a keyboard. A
 * band used to be caught only while the wristband box was selected. The staff
 * app now has one listener at its shell, so a band typed at a scanner's pace
 * with no box selected opens what the counter box's scan of it opens: the tab
 * at F&B and the shop, its orders at History, and at the ticket till a word on
 * where it opens. These flows type a real band's code the way the scanner does
 * (15 ms a key, then Enter) with nothing selected, and read what each screen
 * does; and they check the box and the shell never both act on one scan, and
 * that the same listener still hands the till a Lucky Wheel voucher and a
 * booking QR as the page listener it replaced did.
 *
 * `pnpm --filter @oto/pos e2e e2e/band-anywhere-scan.spec.ts` builds a
 * disposable database and signs in the seeded reception account. The child and
 * the band are made through the routes the till calls.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const DATABASE_URL = process.env.POS_E2E_DATABASE_URL ?? '';
const root = resolve(import.meta.dirname, '../../..');
const PROOF = resolve(root, 'docs/qa/proof-2026-11-09/SCRUM-766/local');

test.use({
  trace: 'off',
  video: 'off',
  screenshot: 'off',
  viewport: { width: 1280, height: 860 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
test.setTimeout(300_000);

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

const CHILD = 'ZZ TEST Anywhere Scan Child';
const ALLERGY = 'ZZ TEST kiwi allergy';

/** A child with an allergy, registered, paid for and in the park: the band's signed code. */
async function childInPark(page: Page): Promise<string> {
  const at = await fromDatabase(async (pool) => {
    const { rows } = await pool.query(
      `select s.id, s.branch_id from core.station s where s.code_prefix = 'T1' and s.name = 'Reception Till 1' limit 1`,
    );
    const packages = await pool.query(
      `select id from pos.ticket_package where branch_id = $1 and archived_at is null and name = '2 Hours Play'`,
      [rows[0]!.branch_id],
    );
    return { stationId: rows[0]!.id!, branchId: rows[0]!.branch_id!, packageId: packages.rows[0]!.id! };
  });
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
    children: [
      {
        checkinId,
        ageYears: 6,
        service: 'drop_off',
        foodProvision: { mode: 'none', paidSatang: 0 },
        name: CHILD,
        allergies: ALLERGY,
        foodRestrictions: null,
      },
    ],
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

/** The scanner: the code at its pace, then its Enter. Typed into whatever has focus. */
async function scan(page: Page, code: string, { enter = true } = {}) {
  // A scanner types a code in a burst (each key within 80 ms of the one before). 5 ms leaves CI's slower keystrokes well inside that pace; 15 ms once stretched past it under load.
  await page.keyboard.type(code, { delay: 5 });
  if (enter) await page.keyboard.press('Enter');
}

/** Nothing selected: what a tap on the screen's empty space leaves. */
async function selectNothing(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? 'BODY')).toBe('BODY');
}

/** Every look-up a screen asks the platform for, by path. */
function countLookups(page: Page) {
  const seen = { wallet: 0, sales: 0 };
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/wallets/scan') seen.wallet += 1;
    if (path === '/api/sales/lookup') seen.sales += 1;
  });
  return seen;
}

const theTabIsOpen = (page: Page) =>
  expect(page.getByText(`Allergy / medical alert · ${CHILD}`)).toBeVisible({ timeout: 15_000 });

test('a wristband scanned with no box selected opens on F&B, the shop, History and the till, once', async ({
  page,
  baseURL,
}) => {
  test.skip(!PHONE || !PASSWORD || !DATABASE_URL, 'Runs on the disposable stack: pnpm --filter @oto/pos e2e e2e/band-anywhere-scan.spec.ts');
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local only');
  await mkdir(PROOF, { recursive: true });
  const shot = async (name: string) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(PROOF, `${name}.png`) });
  };

  await signIn(page);
  const bandCode = await childInPark(page);
  const short = bandShortCode(bandCode)!;
  const lookups = countLookups(page);

  // --- F&B, nothing selected: the scan opens the tab, on one look-up. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  const box = page.getByPlaceholder(/Wristband code/);
  await selectNothing(page);
  await expect(box).not.toBeFocused();
  lookups.wallet = 0;
  await scan(page, bandCode);
  await theTabIsOpen(page);
  await expect(page.getByText(ALLERGY, { exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  expect(lookups.wallet, 'one look-up for one scan').toBe(1);
  await shot('1-fnb-nothing-selected-opens-the-tab');

  // --- F&B with the box selected: the box acts and the shell does not, so still one look-up. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  await box.click();
  lookups.wallet = 0;
  await scan(page, bandCode);
  await theTabIsOpen(page);
  await page.waitForTimeout(600);
  expect(lookups.wallet, 'the box and the shell never both act').toBe(1);

  // --- F&B, nothing selected, a band code that opens nothing: the box shows it, with its words. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  await selectNothing(page);
  await scan(page, 'T1-ZZZZZZ');
  await expect(page.getByText('No tab found for "T1-ZZZZZZ"')).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveValue('T1-ZZZZZZ');
  await shot('2-fnb-unknown-band-shows-in-the-box');

  // --- F&B, nothing selected, typed by hand: nothing happens. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  await selectNothing(page);
  lookups.wallet = 0;
  await page.keyboard.type(bandCode, { delay: 140 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_200);
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible();
  expect(lookups.wallet).toBe(0);

  // --- F&B, nothing selected, the code pasted (how a tester stands in for the scanner). ---
  await selectNothing(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), bandCode);
  await page.keyboard.press('ControlOrMeta+V');
  await theTabIsOpen(page);

  // --- F&B, a scan with no Enter after it: the tab opens once the scanner goes quiet. ---
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  await selectNothing(page);
  await scan(page, bandCode, { enter: false });
  await theTabIsOpen(page);

  // --- The shop, nothing selected: the sale on the child's tab. ---
  await page.goto('/merch-station');
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeVisible({ timeout: 20_000 });
  await selectNothing(page);
  await scan(page, bandCode);
  await expect(page.getByRole('heading', { name: 'Retail Sale' })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(CHILD).first()).toBeVisible({ timeout: 15_000 });
  await shot('3-shop-nothing-selected-opens-the-sale');

  // --- History, nothing selected: the band's orders. ---
  await page.goto('/history');
  await expect(page.getByLabel('Search transactions')).toBeVisible({ timeout: 20_000 });
  await selectNothing(page);
  lookups.sales = 0;
  await scan(page, bandCode);
  await expect(page.getByText(`#${short}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Total spent').first()).toBeVisible();
  await page.waitForTimeout(600);
  expect(lookups.sales).toBe(1);
  await shot('4-history-nothing-selected-opens-its-orders');

  // --- History, the phone box selected: a scan is the scanner's, not a phone number. ---
  await page.getByRole('button', { name: 'Back to all transactions' }).first().click();
  await page.getByRole('button', { name: 'Find by phone' }).click();
  const phone = page.locator('input[type="tel"], input[inputmode="tel"]').first();
  await phone.click();
  await scan(page, bandCode);
  await expect(page.getByText(`#${short}`)).toBeVisible({ timeout: 15_000 });

  // --- History, its search box selected: the box reads bands itself, and is left to. ---
  await page.getByRole('button', { name: 'Back to all transactions' }).first().click();
  const search = page.getByLabel('Search transactions');
  await search.click();
  await scan(page, bandCode);
  await expect(page.getByTestId('search-lookup')).toContainText(`Bracelet ${short}`, { timeout: 15_000 });
  await expect(page.getByText(`#${short}`)).toHaveCount(0);
  await expect(search).toHaveValue(bandCode);

  // --- The ticket till, nothing selected: it says where the band opens; the sale is untouched. ---
  await page.goto('/');
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
  await selectNothing(page);
  await scan(page, bandCode);
  await expect(page.getByText(`That is wristband ${short}`).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
  await shot('5-ticket-till-says-where-the-band-opens');

  // --- The same listener still takes a Lucky Wheel voucher and a booking QR at the till. ---
  // The voucher goes to the till's voucher path, which asks for the customer type first.
  let ordinal = 0;
  await selectNothing(page);
  await scan(page, mintBoothCode('B1', (max) => ordinal++ % max));
  await expect(page.getByText('Choose the customer type first — then redeem the voucher').first()).toBeVisible({
    timeout: 10_000,
  });
  // A booking QR opens Redeem booking, where the platform checks it.
  await selectNothing(page);
  await scan(page, mintBookingQr(randomUUID(), 'zz-test-key-not-this-parks'));
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
});
