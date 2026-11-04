export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = S.st.steps.s5;
  st.network = [];
  page.on('response', (res) => { const u = new URL(res.url()); if (/\/api\/sales/.test(u.pathname) && res.request().method() !== 'GET') st.network.push({ at: new Date().toISOString(), method: res.request().method(), path: u.pathname, status: res.status() }); });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForTimeout(1500);
  await S.shot('till', 's765-st-05b-no-wallet-order-with-two-pairs-of-socks');
  await page.locator('h3', { hasText: /^Cash$/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await page.getByRole('heading', { name: 'Payment Successful' }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(4000);
  st.afterPay = (await text(page, 5000)).split('Review →').pop()?.slice(0, 2000);
  await S.shot('till', 's765-st-05c-no-wallet-payment-successful-socks-card');
  st.paidAt = new Date().toISOString();
  S.save();
  return st;
}
