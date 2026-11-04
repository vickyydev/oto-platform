// Plan step 1: the order with two pairs of socks from the add-ons grid and one non-socks add-on.
export default async function (S) {
  const { text } = S.lib;
  const page = S.pages.till.page;
  const st = (S.st.steps.s1 = { startedAt: new Date().toISOString() });
  await S.shot('till', 's765-st-01a-configure-two-grip-socks-and-bracelet-workshop');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForTimeout(1500);
  st.orderText = (await text(page, 5000)).split('Current Order')[1]?.slice(0, 700);
  await S.shot('till', 's765-st-01-order-with-two-pairs-of-socks');
  S.save();
  return st;
}
