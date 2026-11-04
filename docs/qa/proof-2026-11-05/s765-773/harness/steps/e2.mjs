export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.till.page;
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: LOOK });
  return { text: (await text(page, 4000)).split('Review →')[1] };
}
