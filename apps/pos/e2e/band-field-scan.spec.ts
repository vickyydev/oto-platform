import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * SCRUM-790 — THE WRISTBAND BOX OPENS THE TAB ITSELF.
 *
 * A scanner plugged into the tablet types the code into the wristband box. It
 * used to load only on the scanner's Enter or on Load Tab. These flows type a
 * real band's code into the box the three ways it can arrive (pasted, at a
 * scanner's pace with no Enter, and by hand) and read what the screen does.
 *
 * `pnpm --filter @oto/pos e2e e2e/band-field-scan.spec.ts` builds a disposable
 * database and signs in the seeded reception account. The child and the band
 * are made through the routes the till calls.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const DATABASE_URL = process.env.POS_E2E_DATABASE_URL ?? '';
const root = resolve(import.meta.dirname, '../../..');
const PROOF = resolve(root, 'docs/qa/proof-2026-11-06/SCRUM-790/local');

test.use({
  trace: 'off',
  video: 'off',
  screenshot: 'off',
  viewport: { width: 1280, height: 860 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
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

const CHILD = 'ZZ TEST Field Scan Child';
const ALLERGY = 'ZZ TEST sesame allergy';

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

/** The F&B scan screen, with the wristband box holding the cursor. */
async function atTheScanScreen(page: Page) {
  await page.goto('/order-station');
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible({ timeout: 20_000 });
  const box = page.getByPlaceholder(/Wristband code/);
  await box.click();
  return box;
}

const theTabIsOpen = (page: Page) =>
  expect(page.getByText(`Allergy / medical alert · ${CHILD}`)).toBeVisible({ timeout: 15_000 });

test('the wristband box loads the tab on a paste and on a scan with no Enter, and leaves hand typing alone', async ({
  page,
  baseURL,
}) => {
  test.skip(!PHONE || !PASSWORD || !DATABASE_URL, 'Runs on the disposable stack: pnpm --filter @oto/pos e2e e2e/band-field-scan.spec.ts');
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local only');
  await mkdir(PROOF, { recursive: true });
  const shot = async (name: string) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(PROOF, `${name}.png`) });
  };

  await signIn(page);
  const bandCode = await childInPark(page);

  // --- Pasted: the tab opens with no Enter and no press of Load Tab. ---
  await atTheScanScreen(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), bandCode);
  await page.keyboard.press('ControlOrMeta+V');
  await theTabIsOpen(page);
  await expect(page.getByText(ALLERGY, { exact: true })).toBeVisible();
  await shot('1-pasted-code-opens-the-tab');

  // --- At a scanner's pace, and no Enter after it: the tab opens. ---
  await atTheScanScreen(page);
  await page.keyboard.type(bandCode, { delay: 15 });
  await theTabIsOpen(page);
  await shot('2-scanned-code-with-no-enter-opens-the-tab');

  // --- At a scanner's pace WITH its Enter: one lookup, the tab opens. ---
  await atTheScanScreen(page);
  await page.keyboard.type(bandCode, { delay: 15 });
  await page.keyboard.press('Enter');
  await theTabIsOpen(page);

  // --- By hand: nothing loads until the person presses Enter. ---
  const box = await atTheScanScreen(page);
  await page.keyboard.type(bandCode, { delay: 140 });
  await page.waitForTimeout(1_200);
  await expect(page.getByRole('heading', { name: 'Scan Wristband' })).toBeVisible();
  await expect(box).toHaveValue(bandCode);
  await shot('3-typed-by-hand-waits-for-enter');
  await page.keyboard.press('Enter');
  await theTabIsOpen(page);

  // --- A code that opens nothing stays selected: the next scan replaces it. ---
  const again = await atTheScanScreen(page);
  await page.keyboard.type('ZZ-NOT-A-BAND-9', { delay: 15 });
  await expect(page.getByText(/No tab found for "ZZ-NOT-A-BAND-9"/)).toBeVisible({ timeout: 15_000 });
  await expect(again).toHaveValue('ZZ-NOT-A-BAND-9');
  await shot('4-unknown-code-stays-selected');
  await page.keyboard.type(bandCode, { delay: 15 });
  await theTabIsOpen(page);
});
