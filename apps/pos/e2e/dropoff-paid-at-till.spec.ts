import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-740 — A CHILD PAID FOR AT THE TILL IS NEVER OFFERED A SECOND CHARGE.
 *
 * Two walk-in families registered for drop-off, each child paid for at the
 * till in cash through the routes the till calls: one left as booked, one with
 * no choice made after the payment. The till's Add drop-off picker then lists
 * both children as paid at the till with no Add to sale, a second sale for
 * either is refused before any money is taken, and the board checks the child
 * in with no payment.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/dropoff-paid-at-till.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(150_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
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

interface PaidFamily {
  stayId: string;
  saleId: string;
  receiptNumber: string;
}

/**
 * A walk-in family registered and its child paid for in cash, through the
 * routes the till itself calls, as the signed-in reception account. With
 * `leaveAsBooked` the counter then chose "Leave as booked"; without it the
 * choice after payment was never made.
 */
async function paidAtTill(page: Page, parentName: string, childName: string, leaveAsBooked: boolean): Promise<PaidFamily> {
  const answer = await page.evaluate(
    async ({ parentName, childName, leaveAsBooked, branchCode }) => {
      const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
      const uuid = () => {
        const random = crypto.getRandomValues(new Uint8Array(10));
        const tail = Array.from(random, (b) => hex(b, 2)).join('');
        const ms = hex(Date.now(), 12);
        const variant = hex((random[2]! & 0x3f) | 0x80, 2);
        return `${ms.slice(0, 8)}-${ms.slice(8)}-7${tail.slice(0, 3)}-${variant}${tail.slice(6, 8)}-${tail.slice(8, 20)}`;
      };
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'idempotency-key': `s740-${uuid()}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
      };
      const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
      const stationId = me.operatorContext.stationId as string;
      const catalog = await (await fetch(`/api/public/branches/${branchCode}/catalog`)).json();
      const pkg = catalog.packages.find((p: { name: string }) => p.name === '2 Hours Play');
      const confirmations = catalog.supervision.policy.confirmations
        .filter((c: { required: boolean }) => c.required)
        .map((c: { id: string }) => c.id);
      const stayId = uuid();
      const reg = await post('/api/checkin/registrations', {
        id: uuid(),
        branchId: me.branch.id,
        stationId,
        guardianName: parentName,
        guardianPhone: '0897400740',
        contactChannel: 'whatsapp',
        consentAcknowledged: true,
        acknowledgedConfirmationIds: confirmations,
        children: [
          {
            checkinId: stayId,
            name: childName,
            ageYears: 6,
            service: 'drop_off',
            allergies: null,
            foodRestrictions: null,
            foodProvision: { mode: 'none', paidSatang: 0 },
          },
        ],
      });
      if (reg.status !== 200) return { error: `registration ${reg.status} ${JSON.stringify(reg.body)}` };
      const saleId = uuid();
      const line = { id: stayId, packageId: pkg.id, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } };
      const sale = await post('/api/sales', { id: saleId, stationId, lines: [line] });
      if (sale.status !== 200) return { error: `sale ${sale.status} ${JSON.stringify(sale.body)}` };
      const paid = await post(`/api/sales/${saleId}/finalise`, {});
      if (paid.status !== 200) return { error: `finalise ${paid.status} ${JSON.stringify(paid.body)}` };
      if (leaveAsBooked) {
        const left = await post('/api/checkin/leave-as-booked', { saleId, entries: [{ checkinId: stayId }] });
        if (left.status !== 200) return { error: `leave as booked ${left.status} ${JSON.stringify(left.body)}` };
      }
      const read = await (await fetch(`/api/sales/${saleId}`, { credentials: 'same-origin' })).json();
      return { stayId, saleId, receiptNumber: (read.sale?.receiptNumber ?? '') as string };
    },
    { parentName, childName, leaveAsBooked, branchCode: BRANCH_CODE },
  );
  expect('error' in answer ? answer.error : null).toBeNull();
  return answer as PaidFamily;
}

/** A second sale for the same child, as a stale screen would send it. */
async function ringUpAgain(page: Page, stayId: string): Promise<{ status: number; code: string; message: string }> {
  return page.evaluate(
    async ({ stayId, branchCode }) => {
      const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
      const catalog = await (await fetch(`/api/public/branches/${branchCode}/catalog`)).json();
      const pkg = catalog.packages.find((p: { name: string }) => p.name === '2 Hours Play');
      const id = crypto.randomUUID();
      const res = await fetch('/api/sales', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s740-again-${id}` },
        body: JSON.stringify({
          id,
          stationId: me.operatorContext.stationId,
          lines: [{ id: stayId, packageId: pkg.id, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } }],
        }),
      });
      const body = await res.json();
      return { status: res.status, code: body.error?.code ?? '', message: body.error?.message ?? '' };
    },
    { stayId, branchCode: BRANCH_CODE },
  );
}

test.describe.configure({ mode: 'serial' });

const suffix = Date.now().toString(36).slice(-4);
const booked = { parent: `ZZ TEST Khun Ploy ${suffix}`, child: 'ZZ TEST Mint' };
const noChoice = { parent: `ZZ TEST Khun Dao ${suffix}`, child: 'ZZ TEST Bua' };
let bookedFamily: PaidFamily;
let noChoiceFamily: PaidFamily;

test('the Add drop-off picker lists a child paid for at the till as paid, with no Add to sale', async ({ page }) => {
  requireFixture();
  await signIn(page);
  bookedFamily = await paidAtTill(page, booked.parent, booked.child, true);
  noChoiceFamily = await paidAtTill(page, noChoice.parent, noChoice.child, false);

  await walkInByPhone(page, '812076206');
  await page.getByRole('heading', { name: 'Tourist' }).click();
  await page.getByRole('button', { name: 'Add drop-off child' }).click();
  const dialog = page.getByRole('dialog');
  for (const [family, paid] of [
    [booked, bookedFamily],
    [noChoice, noChoiceFamily],
  ] as const) {
    const card = dialog
      .locator('div')
      .filter({ hasText: `${family.parent}'s booking` })
      .filter({ has: page.getByRole('button', { name: 'Add sibling' }) })
      .last();
    await expect(card.getByText(family.child)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('button', { name: 'Paid at till', exact: true })).toBeDisabled();
    await expect(card.getByText(`Paid at till · ${paid.receiptNumber}`, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Add to sale' })).toHaveCount(0);
  }
  await shot(page, '01-picker-paid-at-till');
});

test('a second sale for the same child is refused before any money is taken', async ({ page }) => {
  requireFixture();
  await signIn(page);
  for (const [family, paid] of [
    [booked, bookedFamily],
    [noChoice, noChoiceFamily],
  ] as const) {
    const again = await ringUpAgain(page, paid.stayId);
    expect(again.status).toBe(409);
    expect(again.code).toBe('CHECKIN_PAID_AT_TILL');
    expect(again.message).toContain(family.child);
    expect(again.message).toContain(paid.receiptNumber);
  }
});

test('the board checks the child in with no payment', async ({ page }) => {
  requireFixture();
  await signIn(page);
  await page.getByRole('button', { name: 'Check-in', exact: true }).click();
  await page.getByPlaceholder('Search child, parent or phone…').fill(noChoice.parent);
  const card = page
    .locator('[class*="bg-card"]')
    .filter({ hasText: noChoice.parent })
    .filter({ has: page.getByRole('button', { name: 'Check in', exact: true }) })
    .last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Booked & paid · no payment needed')).toBeVisible();
  await shot(page, '02-board-booked-and-paid');
  await card.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check in & issue band' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Amount Due', includeHidden: true })).toHaveCount(0);
  await shot(page, '03-board-checks-in-with-no-payment');
});
