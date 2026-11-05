import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-745 — ON THE TILL'S CUSTOMER DISPLAY, THE LANGUAGE BUTTON NEVER COVERS
 * "YOUR ORDER".
 *
 * The order screen's heading sits top right, where the prototype floated the
 * language button. With a ticket on the till, every language's heading and the
 * button are measured on the screen: the two boxes never meet, at a desktop
 * width and at the narrowest width that still shows the display beside the till.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/display-language-button.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(120_000);

/** Each language's switcher label, its "Change language" and its "Your Order" (`i18n/dictionary.ts`). */
const LANGUAGES = [
  { code: 'th', label: 'ไทย', change: 'เปลี่ยนภาษา', heading: 'คำสั่งซื้อของคุณ' },
  { code: 'ru', label: 'Русский', change: 'Сменить язык', heading: 'Ваш заказ' },
  { code: 'zh', label: '中文', change: '更改语言', heading: '您的订单' },
  { code: 'fr', label: 'Français', change: 'Changer de langue', heading: 'Votre commande' },
  { code: 'en', label: 'English', change: 'Change language', heading: 'Your Order' },
] as const;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function ticketOnTheTill(page: Page): Promise<void> {
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
  await walkInByPhone(page, '812076205');
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  // At an iPad's portrait width the staff side's ticket cards overlap one another
  // (the till's own layout, not this check's), so the press goes to the card itself.
  await page.getByRole('heading', { name: '1 Hour Play', exact: true }).dispatchEvent('click');
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Switch the display to `lang` from whatever it shows now, through its own button. */
async function choose(page: Page, current: Locator, lang: (typeof LANGUAGES)[number]): Promise<void> {
  await current.click();
  await page.getByRole('button', { name: lang.label, exact: true }).click();
}

async function measure(page: Page, lang: (typeof LANGUAGES)[number]) {
  const button = page.getByRole('button', { name: lang.change, exact: true });
  const heading = page.getByText(lang.heading, { exact: true });
  await expect(button).toHaveCount(1);
  await expect(heading).toBeVisible({ timeout: 10_000 });
  const [b, h] = [await button.boundingBox(), await heading.boundingBox()];
  expect(b && h, 'both the button and the heading are on the screen').toBeTruthy();
  return { button, buttonBox: b!, headingBox: h! };
}

for (const width of [1440, 1024, 768]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 1024 : 900 } });

    test('every language: the language button sits beside "Your Order", never over it', async ({ page }) => {
      test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
      await ticketOnTheTill(page);
      let current = page.getByRole('button', { name: 'Change language', exact: true });
      await expect(current).toHaveCount(1, { timeout: 20_000 });
      for (const lang of LANGUAGES) {
        await choose(page, current, lang);
        const { button, buttonBox, headingBox } = await measure(page, lang);
        expect(overlap(buttonBox, headingBox), `${lang.code}: the button covers the heading`).toBe(false);
        expect(headingBox.x + headingBox.width, `${lang.code}: the heading ends before the button starts`).toBeLessThanOrEqual(buttonBox.x);
        expect(buttonBox.x + buttonBox.width, `${lang.code}: the button stays on the screen`).toBeLessThanOrEqual(width);
        if (lang.code === 'th' || lang.code === 'ru' || lang.code === 'en') await shot(page, `s745-${width}-${lang.code}`);
        current = button;
      }
    });
  });
}
