// Plan step 10: Console > Members > the ZZ TEST member: the proof-type picker (opened, nothing saved),
// then Tier verifications with the Driving licence and Other checks.
export default async function (S) {
  const { text } = S.lib;
  if (!S.pages.console) {
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
  }
  const page = S.pages.console.page;
  const st = (S.st.steps.s10 = { startedAt: new Date().toISOString() });
  await page.goto(S.CONSOLE + '/catalogue/members', { waitUntil: 'domcontentloaded' });
  const edit = page.locator('button[aria-label="Edit ZZ TEST 773 Licence"]:visible').first();
  await edit.waitFor({ timeout: 45000 });
  await edit.scrollIntoViewIfNeeded();
  st.row = (await page.locator('tr', { hasText: 'ZZ TEST 773 Licence' }).first().innerText()).replace(/\s+/g, ' ');
  await edit.click();
  const dlg = page.getByRole('dialog');
  await dlg.getByText('Edit member').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  st.dialog = (await dlg.innerText()).slice(0, 1500);
  await dlg.getByRole('combobox', { name: 'Proof type' }).click();
  const list = page.getByRole('listbox');
  await list.waitFor({ timeout: 15000 });
  st.options = (await list.getByRole('option').allTextContents()).map((t) => t.trim());
  await page.waitForTimeout(600);
  await S.shot('console', 's773-st-10a-console-member-proof-type-list');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  st.dialogClosed = (await page.getByRole('dialog').count()) === 0;
  await page.goto(S.CONSOLE + '/catalogue/tier-verifications', { waitUntil: 'domcontentloaded' });
  await page.getByText('ZZ TEST 773 Other').first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  const t = await text(page, 20000);
  st.verifications = t.split('\n').filter((l) => /ZZ TEST 7(65|73)/.test(l)).slice(0, 12);
  await S.shot('console', 's773-st-10b-console-tier-verifications');
  S.save();
  return st;
}
