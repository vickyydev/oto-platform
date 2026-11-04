// Plan step 9, the sale's own document line: a walk-in Thai claim on Other (Work permit) with an expiry,
// the customer leaves their details empty (so the claim stays on the sale), paid in cash.
export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = (S.st.steps.s9n = { startedAt: new Date().toISOString(), network: [], why: 'A sale shows its own document line only when the rate was claimed on the sale itself: a walk-in who leaves their details empty. A member sale (09c) and a walk-in who entered their details (09f) are priced from the member profile, which carries the document instead.' });
  page.on('response', (res) => { const u = new URL(res.url()); if (/\/api\/sales/.test(u.pathname) && res.request().method() !== 'GET') st.network.push({ at: new Date().toISOString(), method: res.request().method(), path: u.pathname, status: res.status() }); });
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
  await page.getByRole('heading', { name: 'Thai', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Other', exact: true }).click();
  await dlg.locator('#tier-evidence-note').fill('Work permit');
  await dlg.locator('#tier-evidence-expiry').fill('2029-12-31');
  await page.waitForTimeout(500);
  st.dialog = (await dlg.innerText()).slice(0, 800);
  await S.shot('till', 's773-st-09g-walk-in-claim-other-work-permit-with-expiry');
  await dlg.getByRole('button', { name: /^Verify Thai — Other — Work permit/ }).click();
  await dlg.waitFor({ state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.getByRole('heading', { name: 'Full Day Pass', exact: true }).click();
  await page.getByRole('heading', { name: /^Configure:/ }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForTimeout(1500);
  st.step4 = (await text(page, 6000)).split('Current Order')[1]?.slice(0, 900);
  // The customer presses Done on their own display without entering a phone or a nickname.
  await page.getByRole('button', { name: 'Done', exact: true }).last().click();
  await page.getByText('Select Payment Method').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  st.orderText = (await text(page, 6000)).split('Current Order')[1]?.slice(0, 700);
  await S.shot('till', 's773-st-09h-walk-in-thai-rate-order-no-details');
  await page.locator('h3', { hasText: /^Cash$/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await page.getByRole('heading', { name: 'Payment Successful' }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(3000);
  st.afterPay = (await text(page, 5000)).split('Review →').pop()?.slice(0, 900);
  st.receipt = /Receipt (T1-\d+)/.exec(st.afterPay ?? '')?.[1] ?? null;
  await S.shot('till', 's773-st-09i-walk-in-thai-rate-paid');
  S.save();
  return st;
}
