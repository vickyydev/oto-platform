// Plan step 2: pay cash; Payment Successful with the Credit Grants to Print card listing the socks.
export default async function (S) {
  const { text } = S.lib;
  const page = S.pages.till.page;
  const st = (S.st.steps.s2 = { startedAt: new Date().toISOString() });
  page.on('response', (res) => { const u = new URL(res.url()); if (/\/api\/sales/.test(u.pathname) && res.request().method() !== 'GET') (st.network = st.network ?? []).push({ at: new Date().toISOString(), method: res.request().method(), path: u.pathname, status: res.status() }); });
  await page.locator('h3', { hasText: /^Cash$/ }).click();
  await page.waitForTimeout(800);
  await S.shot('till', 's765-st-02a-cash-chosen');
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await page.getByRole('heading', { name: 'Payment Successful' }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(4000);
  st.afterPay = (await text(page, 5000)).split('Review →')[1]?.slice(0, 2500);
  await S.shot('till', 's765-st-02-payment-successful-socks-card');
  st.finishedAt = new Date().toISOString();
  S.save();
  return st;
}
