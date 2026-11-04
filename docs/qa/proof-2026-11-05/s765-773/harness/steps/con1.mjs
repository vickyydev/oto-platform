export default async function (S) {
  const { LOOK, text } = S.lib;
  const { page } = await S.newPage('console', { width: 1500, height: 1000 });
  await page.goto(S.CONSOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (await page.locator('input[type="password"]').count()) {
    const field = page.locator('input[type="tel"], input[inputmode="tel"]').last();
    const prefix = await field.evaluate((el) => /\+(\d{1,4})/.exec(el.parentElement?.textContent ?? '')?.[1] ?? null).catch(() => null);
    const phone = S.need('STAGING_ADMIN_PHONE');
    await field.fill(prefix === '66' || !prefix ? phone.replace(/^\+66/, '0') : phone.slice(prefix.length + 1));
    await page.locator('input[type="password"]').last().fill(S.need('STAGING_ADMIN_PASSWORD'));
    await page.getByRole('button', { name: /sign in/i }).first().click();
    await page.waitForTimeout(6000);
  }
  if (await page.locator('input[type="password"]').count()) throw new Error('Console still on the sign-in screen');
  await page.screenshot({ path: LOOK });
  const links = await page.getByRole('link').evaluateAll((els) => els.map((e) => (e.textContent.trim() + ' ' + e.getAttribute('href'))).slice(0, 80));
  return { url: page.url(), links };
}
