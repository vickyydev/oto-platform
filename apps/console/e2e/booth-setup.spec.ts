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

/**
 * SCRUM-409 (the closing audit's L10): the till reads what a voucher is worth
 * from its type when the slip is scanned, so changing the 100 THB Voucher to
 * 80 reprices every slip already printed under it. The editor asks first,
 * names both worths, how many of its vouchers are still unredeemed (none, on
 * a park this fresh) and the wheel the type is on, points at "New voucher
 * type" as the safer choice, and sends nothing until the change is confirmed.
 * A change to the words alone asks nothing — the Kids Pizza case above already
 * shows the first product link is not asked about either.
 */
test('Voucher types: changing what the 100 THB Voucher is worth asks first, “Keep as it is” puts the amount back, and confirming reprices it', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Voucher types');

  const hundred = page.getByRole('button', { name: /100 THB Voucher/ });
  await expect(hundred).toBeVisible({ timeout: 30_000 });
  await expect(hundred).toContainText('฿100 off the ticket order');
  await hundred.click();
  const edit = page.getByRole('dialog', { name: '100 THB Voucher' });
  await expect(edit).toBeVisible();

  await edit.getByLabel('Amount off').fill('80');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  // Nothing was sent: the drawer stays, asking in the till's words.
  await expect(edit).toContainText(
    'Change what it is worth, from ฿100 off the ticket order to ฿80 off the ticket order?',
  );
  // Nothing has been won on this park yet, and the question says so rather
  // than promising to reprice slips that do not exist.
  await expect(edit).toContainText(
    'No voucher of this type is unredeemed, so no printed slip changes with it — it is on the wheel at Booth 1 (100 THB Voucher)',
  );
  await expect(edit).toContainText('create the new worth with “New voucher type”');
  await expect(edit.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

  // The safer press puts the stored amount back, and the question goes with it.
  await edit.getByRole('button', { name: 'Keep as it is', exact: true }).click();
  await expect(edit.getByLabel('Amount off')).toHaveValue('100');
  await expect(edit).not.toContainText('Change what it is worth');
  await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

  // Asked again and confirmed, the list reads the new worth.
  await edit.getByLabel('Amount off').fill('80');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await edit.getByRole('button', { name: 'Change it anyway', exact: true }).click();
  await expect(edit).toHaveCount(0, { timeout: 30_000 });
  await expect(hundred).toContainText('฿80 off the ticket order');

  // The words alone are saved without a question.
  await hundred.click();
  const words = page.getByRole('dialog', { name: '100 THB Voucher' });
  await words.getByLabel('Title (English)').fill('100 THB OFF YOUR TICKETS');
  await words.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(words).toHaveCount(0, { timeout: 30_000 });
  await expect(hundred).toContainText('Slip: the park’s own words, once a booth using it is published');
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

/**
 * The booth's closing audit, H2, M1 and M2: the Pi's booth, set up the way the
 * bench test sets it up. A box added on Devices with the role Booth is a
 * Raspberry Pi not yet claimed, so its booth runs on that box and not inside
 * this api — the booth whose Console pages were wrong. The code prefix could
 * be left empty, which made a booth that refused every press; the Screens
 * panel asked for a pairing the Pi does not use; and the wheel preview drew a
 * switched-off prize the television leaves out.
 *
 * Serial, because the second and third cases open the booth the first one
 * creates.
 */
test.describe.serial('The Pi booth, set up in the Console', () => {
  const BOX = 'Bench Pi box';
  const SLOT = 'booth-pi';
  const BOOTH = 'Pi Booth';

  test('Devices: a booth station is refused without a two-character code prefix, and the api’s own refusal is shown', async ({
    page,
  }) => {
    await signInAndWait(page);
    await openSection(page, 'Devices');
    await chooseBranch(page, CENTRAL_FLORESTA);

    // The box, as the Pi guide adds it: a name, a slot, the role Booth.
    const boxes = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Boxes', exact: true }) });
    await boxes.getByRole('button', { name: 'Add a box', exact: true }).click();
    const addBox = page.getByRole('dialog', { name: 'Add a box' });
    await addBox.getByLabel(/^Name/).fill(BOX);
    await addBox.getByLabel(/^Slot/).fill(SLOT);
    await addBox.getByLabel(/^Role/).selectOption({ label: 'Booth' });
    await addBox.getByRole('button', { name: 'Add the box', exact: true }).click();
    await addBox.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(boxes.getByRole('button', { name: BOX, exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // The booth's station on it.
    await page.getByRole('button', { name: 'New station', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'New station' });
    await drawer.getByLabel(/^Box/).selectOption({ label: `${BOX} — ${SLOT}` });
    await drawer.getByLabel(/^Name/).fill(BOOTH);
    await drawer.getByLabel(/^Kind/).selectOption({ label: 'Booth' });

    const prefix = drawer.getByLabel(/^Code prefix/);
    const create = drawer.getByRole('button', { name: 'Create the station', exact: true });
    // Empty — the form's own starting value, and what made a dead booth — is
    // refused before anything is sent, and so is one character.
    await expect(prefix).toHaveValue('');
    await expect(drawer).toContainText(
      'Required for a booth: the first two characters of every voucher code.',
    );
    await expect(create).toBeDisabled();
    await prefix.fill('B');
    await expect(create).toBeDisabled();

    // Two characters no box can print: the api refuses, and the drawer shows
    // its words, which name the rule.
    await prefix.fill('B-');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(drawer.getByRole('alert')).toContainText(/code prefix/i, { timeout: 30_000 });

    await prefix.fill('B7');
    await expect(drawer).toContainText('The first two characters of every voucher code.');
    await create.click();
    await expect(drawer).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: BOOTH, exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('Booths: the Pi booth’s Screens panel asks for no pairing, while Booth 1 on the virtual box still offers it', async ({
    page,
  }) => {
    await signInAndWait(page);
    await openSection(page, 'Booths');
    await chooseBranch(page, CENTRAL_FLORESTA);
    const screens = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Screens', exact: true }) });

    await page.getByRole('button', { name: new RegExp(BOOTH) }).click();
    await expect(screens).toContainText(
      'This booth runs on its own box; its television needs no pairing.',
      { timeout: 30_000 },
    );
    await expect(screens.getByRole('button', { name: 'Pair a screen' })).toHaveCount(0);
    await expect(screens).not.toContainText('refuses every press');

    // The control: Booth 1's box is the virtual box inside this api, whose
    // television is paired — so there the panel still offers it.
    await page.getByRole('button', { name: /Booth 1/ }).click();
    await expect(screens).toContainText('Until one is, the television shows', { timeout: 30_000 });
    await expect(screens.getByRole('button', { name: 'Pair a screen', exact: true })).toBeVisible();
    await expect(screens).not.toContainText('needs no pairing');
  });

  test('Booths: a switched-off prize draws no wedge in the preview, and stays in its list as off the wheel', async ({
    page,
  }) => {
    await signInAndWait(page);
    await openSection(page, 'Booths');
    await chooseBranch(page, CENTRAL_FLORESTA);
    await page.getByRole('button', { name: new RegExp(BOOTH) }).click();

    const prizes = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Prizes and odds', exact: true }) });
    await expect(prizes).toBeVisible({ timeout: 30_000 });
    const addPrize = async (name: string, chance: string, onTheWheel: boolean) => {
      await prizes.getByRole('button', { name: 'Add prize', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'New prize' });
      await editor.getByLabel(/^Name \(English\)/).fill(name);
      await editor.getByLabel(/^Chance/).fill(chance);
      if (!onTheWheel) await editor.getByLabel(/^On the wheel/).uncheck();
      await editor.getByRole('button', { name: 'Add prize', exact: true }).click();
      await expect(editor).toHaveCount(0, { timeout: 30_000 });
    };
    // In wheel order, with the switched-off prize between the two that are on.
    await addPrize('Sticker', '60', true);
    await addPrize('Mystery Box', '0', false);
    await addPrize('Balloon', '40', true);

    const preview = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Wheel preview', exact: true }) });
    const wheel = preview.getByRole('img', { name: /^Wheel preview/ });
    await expect(wheel).toHaveAttribute(
      'aria-label',
      'Wheel preview: 2 slices in order — Sticker, Balloon',
      { timeout: 30_000 },
    );
    await expect(wheel.locator('path')).toHaveCount(2);
    // The list under the wheel keeps it, named for what it is.
    await expect(preview.getByRole('listitem').filter({ hasText: 'Mystery Box' })).toContainText(
      'off the wheel',
    );
    await expect(preview).not.toContainText('still drawn on the television');
  });
});
