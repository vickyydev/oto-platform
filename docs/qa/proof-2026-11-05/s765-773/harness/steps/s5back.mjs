export default async function (S) {
  const { text, LOOK, tendering } = S.lib;
  const page = S.pages.till.page;
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: LOOK });
  const mine = (await tendering(S));
  return { text: (await text(page, 5000)).split('Review →').pop()?.slice(0, 1500), tendering: mine.length, network: S.st.steps.s5.network };
}
