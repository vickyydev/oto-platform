export default async function (S) {
  const { text, LOOK, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = S.st.steps.s9w;
  await page.getByRole('button', { name: 'Done', exact: true }).last().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: LOOK });
  st.afterDetails = (await text(page, 5000)).split('Review →').pop()?.slice(0, 1200);
  S.save();
  return { text: st.afterDetails, network: st.network };
}
