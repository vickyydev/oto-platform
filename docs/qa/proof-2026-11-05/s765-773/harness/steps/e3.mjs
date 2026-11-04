export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.till.page;
  await page.getByRole('heading', { name: '2 Hours Play', exact: true }).click();
  await page.getByRole('heading', { name: /^Configure:/ }).waitFor();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: LOOK, fullPage: true });
  const buttons = (await page.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim()).filter(Boolean))).slice(0, 120);
  return { text: (await text(page, 5000)).split('Review →')[1]?.split('Current Order')[0], buttons };
}
