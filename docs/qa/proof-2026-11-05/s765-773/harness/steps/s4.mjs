// Plan step 4 (screen): History > the sale; the reprint list.
export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  await page.getByText('T1-000084', { exact: true }).click();
  await page.waitForTimeout(3500);
  const st = (S.st.steps.s4screen = { at: new Date().toISOString() });
  st.detail = (await text(page, 8000)).split('Review →').pop()?.slice(0, 3500);
  await S.shot('till', 's765-st-04a-history-sale-detail');
  S.save();
  return st;
}
