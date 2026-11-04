export default async function (S) {
  const { LOOK, text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  const unlocked = await unlockIfLocked(S, page);
  if (await page.getByRole('button', { name: 'Start New Sale' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Start New Sale' }).click();
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: LOOK });
  return { unlocked, text: (await text(page, 5000)).split('Review →')[1]?.slice(0, 2500) };
}
