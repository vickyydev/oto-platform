import { expect, test, type Page } from '@playwright/test';
import { CENTRAL_FLORESTA, chooseBranch, openSection, signInAndWait } from './console';

/**
 * SCRUM-400 — what the park sets up for a booth before the owner's bench
 * test, in the Console, the way he will do it: the voucher types (what a prize
 * is worth and what its slip says), who may sign in at the booth with which
 * PIN, and how long a sign-in lasts.
 *
 * Each case asserts the reading a manager acts on after the press — the list
 * line that says what the till will do, the staff row that says a PIN is set,
 * the review line that says how long a sign-in will last, the staff note that
 * says how long one lasts now — and not merely that a request went out. The
 * PIN case also asserts where the digits are NOT once they are saved: anywhere
 * on the page.
 */

/** Booth 1 at Central Floresta, open on the Booths page. */
async function openBooth1(page: Page): Promise<void> {
  await openSection(page, 'Booths');
  await chooseBranch(page, CENTRAL_FLORESTA);
  const booth = page.getByRole('button', { name: /Booth 1/ });
  await expect(booth).toBeVisible({ timeout: 30_000 });
  await booth.click();
  await expect(page.getByRole('heading', { name: 'Booth staff', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

test('Voucher types: a 50 THB off type is created, Kids Pizza is linked and worded with no expiry, and a type is archived', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Voucher types');

  // The seeded Kids Pizza points at no product, and the list says what the till would answer.
  const pizza = page.getByRole('button', { name: /Kids Pizza/ });
  await expect(pizza).toBeVisible({ timeout: 30_000 });
  await expect(pizza).toContainText('No product linked');

  // --- A new type: 50 THB off ------------------------------------------------
  await page.getByRole('button', { name: 'New voucher type', exact: true }).click();
  const created = page.getByRole('dialog', { name: 'New voucher type' });
  await expect(created).toBeVisible();
  await created.getByLabel('Name (English)').fill('50 THB off');
  await created.getByLabel('Name (Thai)').fill('ส่วนลด 50 บาท');
  await created.getByRole('button', { name: 'Amount off', exact: true }).click();
  await created.getByLabel('Amount off').fill('50');
  // Left empty, a slip's title is the name of the PRIZE that was won, never the
  // type's — and no prize uses a new type yet, so the preview says so.
  await expect(created.getByLabel('Slip preview')).toContainText('the prize’s name');
  await expect(created.getByLabel('Slip preview')).not.toContainText('50 THB off');
  await created.getByLabel('Title (English)').fill('50 THB OFF YOUR TICKETS');
  await created.getByLabel('Instruction (English)').fill('Show this QR at OTO Reception.');
  await created.getByLabel('Days').fill('30');
  // The reference code is filled in from the name.
  await expect(created.getByLabel('Reference code')).toHaveValue('50-thb-off');
  // The slip preview carries the words in the slip's order.
  await expect(created.getByLabel('Slip preview')).toContainText('50 THB OFF YOUR TICKETS');
  await created.getByRole('button', { name: 'Create voucher type', exact: true }).click();
  await expect(created).toHaveCount(0, { timeout: 30_000 });

  const fifty = page.getByRole('button', { name: /50 THB off/ });
  await expect(fifty).toBeVisible();
  await expect(fifty).toContainText('฿50 off the ticket order');
  await expect(fifty).toContainText('30 days');
  await expect(fifty).toContainText('Slip: the park’s own words, once a booth using it is published');

  // --- Kids Pizza: a product, the park's words in both languages, never expires ---
  await pizza.click();
  const edit = page.getByRole('dialog', { name: 'Kids Pizza' });
  await expect(edit).toBeVisible();
  // Saving the wording alone is closed: a free product needs its product.
  await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await edit
    .getByLabel('Product')
    .selectOption({ label: `Margherita Pizza (FB-PIZZA) — ${CENTRAL_FLORESTA}` });
  await edit.getByLabel('Title (English)').fill('FREE KIDS PIZZA');
  await edit.getByLabel('Title (Thai)').fill('พิซซ่าเด็กฟรี');
  await edit
    .getByLabel('Instruction (English)')
    .fill('Show this slip at the OTO restaurant for one free kids pizza.');
  await edit.getByLabel('Instruction (Thai)').fill('แสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด');
  await edit.getByRole('button', { name: 'Never expires', exact: true }).click();
  await expect(edit.getByLabel('Slip preview')).toContainText('No expiry');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toHaveCount(0, { timeout: 30_000 });

  await expect(pizza).toContainText('Free: Margherita Pizza');
  await expect(pizza).toContainText('Never expires');
  await expect(pizza).toContainText('Slip: the park’s own words, once a booth using it is published');
  await expect(pizza).not.toContainText('No product linked');

  // --- Archive the 50 THB off, and find it again under "Show archived" ---
  await fifty.click();
  const archive = page.getByRole('dialog', { name: '50 THB off' });
  await archive.getByRole('button', { name: 'Archive voucher type', exact: true }).click();
  await archive.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(archive).toHaveCount(0, { timeout: 30_000 });
  await expect(fifty).toHaveCount(0);

  await page.getByLabel('Show archived voucher types').check();
  await expect(fifty).toBeVisible({ timeout: 30_000 });
  await expect(fifty).toContainText('archived');
});

test('Booths: somebody is added to Booth 1, given a PIN that is never shown again, and taken off', async ({
  page,
}) => {
  await signInAndWait(page);
  await openBooth1(page);

  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Booth staff', exact: true }) });
  // The seed puts reception on Booth 1 with a PIN.
  const reception = panel.getByRole('listitem').filter({ hasText: 'Som (Reception)' });
  await expect(reception).toBeVisible({ timeout: 30_000 });
  await expect(reception).toContainText('PIN set');
  await expect(reception).toContainText(/S-[0-9A-Z]{4}/);
  // The note names the roles that may sign in with their own phone and password.
  await expect(panel).toContainText('Reception, Staff');

  await panel.getByLabel('Person').selectOption({ label: 'Khun Lek (Manager) — +66900000004' });
  await panel.getByRole('button', { name: 'Add to booth', exact: true }).click();
  const manager = panel.getByRole('listitem').filter({ hasText: 'Khun Lek (Manager)' });
  await expect(manager).toBeVisible({ timeout: 30_000 });
  await expect(manager).toContainText('no PIN');

  const pin = '5937';
  await manager.getByRole('button', { name: 'Set PIN', exact: true }).click();
  await manager.getByLabel('PIN', { exact: true }).fill(pin);
  await manager.getByLabel('PIN again').fill('5938');
  await expect(manager.getByRole('button', { name: 'Save PIN', exact: true })).toBeDisabled();
  await manager.getByLabel('PIN again').fill(pin);
  await manager.getByRole('button', { name: 'Save PIN', exact: true }).click();

  await expect(panel).toContainText('PIN set for Khun Lek (Manager)', { timeout: 30_000 });
  await expect(manager).toContainText('PIN set');
  // The digits are nowhere on the page once saved, and the fields are gone.
  await expect(manager.getByLabel('PIN again')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(pin);
  const inputs = await page.locator('input').evaluateAll((els) =>
    els.map((el) => (el as HTMLInputElement).value),
  );
  expect(inputs).not.toContain(pin);

  await manager.getByRole('button', { name: 'Remove', exact: true }).click();
  await manager.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(manager).toHaveCount(0, { timeout: 30_000 });
});

test('Booths: the staff session length is saved as 10 hours, is in the review before publishing, and reaches the staff note with the publish', async ({
  page,
}) => {
  await signInAndWait(page);
  await openBooth1(page);

  const settings = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Booth settings', exact: true }) });
  const length = settings.getByLabel('Staff session length');
  await expect(length).toHaveValue('');
  // More than a day is refused before it is sent.
  await length.fill('25');
  await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
  await length.fill('10');
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
  // The booth is read again after the save: the value on screen is the API's.
  await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled({
    timeout: 30_000,
  });
  await expect(length).toHaveValue('10');

  // Until the publish the box still grants the published twelve hours, and the
  // staff panel says both.
  const staffPanel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Booth staff', exact: true }) });
  await expect(staffPanel).toContainText('lasts 12 hours (10 hours for sign-ins after the next publish)');

  const publish = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Publish', exact: true }) });
  await publish.getByRole('button', { name: 'Review and publish', exact: true }).click();
  await expect(publish).toContainText('lasts 10 hours');
  await publish.getByRole('button', { name: /^Publish version \d+$/ }).click();
  await expect(publish).toContainText(/Version \d+ published/, { timeout: 30_000 });
  await expect(staffPanel).toContainText('lasts 10 hours — set under Booth settings', { timeout: 30_000 });
});
