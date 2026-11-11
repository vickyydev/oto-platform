import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-862 — A WAITING DROP-OFF BOOKING CAN BE CANCELLED FROM THE TILL.
 *
 * A ZZ TEST family is registered for drop-off through the route the till
 * calls, and nobody pays. The till's Add drop-off picker lists the family
 * with "Cancel booking"; one confirm with a reason, and the family leaves the
 * list. The platform then refuses a sale under the cancelled child, and the
 * registration with its signed consent is still on file.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/dropoff-cancel-waiting.spec.ts`.
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

interface WaitingFamily {
  registrationId: string;
  stayId: string;
}

/** A walk-in family registered for drop-off through the route the till calls; nobody pays. */
async function registerWaiting(page: Page, parentName: string, childName: string): Promise<WaitingFamily> {
  const answer = await page.evaluate(
    async ({ parentName, childName, branchCode }) => {
      const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
      const uuid = () => {
        const random = crypto.getRandomValues(new Uint8Array(10));
        const tail = Array.from(random, (b) => hex(b, 2)).join('');
        const ms = hex(Date.now(), 12);
        const variant = hex((random[2]! & 0x3f) | 0x80, 2);
        return `${ms.slice(0, 8)}-${ms.slice(8)}-7${tail.slice(0, 3)}-${variant}${tail.slice(6, 8)}-${tail.slice(8, 20)}`;
      };
      const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
      const catalog = await (await fetch(`/api/public/branches/${branchCode}/catalog`)).json();
      const confirmations = catalog.supervision.policy.confirmations
        .filter((c: { required: boolean }) => c.required)
        .map((c: { id: string }) => c.id);
      const registrationId = uuid();
      const stayId = uuid();
      const res = await fetch('/api/checkin/registrations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s862-${uuid()}` },
        body: JSON.stringify({
          id: registrationId,
          branchId: me.branch.id,
          stationId: me.operatorContext.stationId,
          guardianName: parentName,
          guardianPhone: '0898620862',
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
        }),
      });
      if (res.status !== 200) return { error: `registration ${res.status} ${await res.text()}` };
      return { registrationId, stayId };
    },
    { parentName, childName, branchCode: BRANCH_CODE },
  );
  expect('error' in answer ? answer.error : null).toBeNull();
  return answer as WaitingFamily;
}

/** What the platform says about the booking afterwards, read as the signed-in account. */
async function afterwards(page: Page, family: WaitingFamily) {
  return page.evaluate(
    async ({ registrationId, stayId, branchCode }) => {
      const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
      const listed = await (await fetch(`/api/checkin/registrations?branchId=${me.branch.id}`, { credentials: 'same-origin' })).json();
      const reg = await (await fetch(`/api/checkin/registrations/${registrationId}`, { credentials: 'same-origin' })).json();
      const catalog = await (await fetch(`/api/public/branches/${branchCode}/catalog`)).json();
      const pkg = catalog.packages.find((p: { name: string }) => p.name === '2 Hours Play');
      const sale = await fetch('/api/sales', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s862-sale-${stayId}` },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          stationId: me.operatorContext.stationId,
          lines: [{ id: stayId, packageId: pkg.id, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } }],
        }),
      });
      const saleBody = await sale.json();
      return {
        stillListed: (listed.registrations as Array<{ id: string }>).some((r) => r.id === registrationId),
        status: (reg.children as Array<{ id: string; status: string }>).find((c) => c.id === stayId)?.status ?? null,
        consentRecordedAt: reg.consentRecordedAt as string | null,
        sale: { status: sale.status, code: saleBody.error?.code ?? '' },
      };
    },
    { ...family, branchCode: BRANCH_CODE },
  );
}

const suffix = Date.now().toString(36).slice(-4);
const family = { parent: `ZZ TEST Khun Ploy ${suffix}`, child: 'ZZ TEST Mint' };

test('a waiting booking is cancelled from the picker with one confirm, and cannot be sold afterwards', async ({ page }) => {
  requireFixture();
  await signIn(page);
  const waiting = await registerWaiting(page, family.parent, family.child);

  await walkInByPhone(page, '812086202');
  await page.getByRole('heading', { name: 'Tourist' }).click();
  await page.getByRole('button', { name: 'Add drop-off child' }).click();
  const picker = page.getByRole('dialog').filter({ hasText: 'Add drop-off child' });
  const card = picker
    .locator('div')
    .filter({ hasText: `${family.parent}'s booking` })
    .filter({ has: page.getByRole('button', { name: 'Add sibling' }) })
    .last();
  await expect(card.getByText(family.child)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'Add to sale' })).toBeEnabled();
  await shot(page, '01-picker-waiting');

  await card.getByRole('button', { name: 'Cancel booking' }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Cancel this waiting booking' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText('The signed form stays on record.')).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Give a reason to cancel' })).toBeDisabled();
  await confirm.getByLabel('Reason').fill('Family did not come');
  await shot(page, '02-confirm-with-reason');
  await confirm.getByRole('button', { name: 'Cancel the booking' }).click();

  await expect(confirm).toBeHidden({ timeout: 20_000 });
  await expect(picker.getByText(`${family.parent}'s booking`)).toHaveCount(0, { timeout: 20_000 });
  await shot(page, '03-picker-after-cancel');

  const after = await afterwards(page, waiting);
  expect(after.stillListed).toBe(false);
  expect(after.status).toBe('cancelled');
  expect(after.consentRecordedAt).not.toBeNull();
  expect(after.sale).toEqual({ status: 409, code: 'CHECKIN_CANCELLED' });
});
