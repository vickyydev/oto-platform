// Plan step 9: a Thai-rate ticket sold to the Other (Work permit) member, cash.
export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = (S.st.steps.s9 = { startedAt: new Date().toISOString(), network: [] });
  page.on('response', (res) => { const u = new URL(res.url()); if (/\/api\/sales/.test(u.pathname) && res.request().method() !== 'GET') st.network.push({ at: new Date().toISOString(), method: res.request().method(), path: u.pathname, status: res.status() }); });
  await page.getByRole('heading', { name: 'Full Day Pass', exact: true }).click();
  await page.getByRole('heading', { name: /^Configure:/ }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Select Payment Method').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  st.orderText = (await text(page, 5000)).split('Current Order')[1]?.slice(0, 600);
  await S.shot('till', 's773-st-09a-thai-rate-order-other-work-permit');
  await page.locator('h3', { hasText: /^Cash$/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await page.getByRole('heading', { name: 'Payment Successful' }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(3000);
  st.afterPay = (await text(page, 5000)).split('Review →').pop()?.slice(0, 1200);
  await S.shot('till', 's773-st-09b-thai-rate-paid');
  S.save();
  return st;
}
