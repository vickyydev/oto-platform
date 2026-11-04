export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = S.st.steps.s9w;
  await S.shot('till', 's773-st-09e-walk-in-thai-rate-saved-other-work-permit', { wait: 200 });
  const look = await S.pageApi('till', 'GET', '/members/lookup?phone=' + encodeURIComponent(S.st.fixture.walkInPhone));
  const m = look.body?.member;
  if (m) { S.st.fixture.members.walkin = { id: m.id, nickname: m.nickname, phone: m.phone, createdAt: new Date().toISOString() }; S.st.created.push({ kind: 'member', id: m.id, name: m.nickname }); }
  await page.locator('h3', { hasText: /^Cash$/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await page.getByRole('heading', { name: 'Payment Successful' }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);
  st.afterPay = (await text(page, 5000)).split('Review →').pop()?.slice(0, 400);
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.waitForTimeout(3000);
  const list = (await text(page, 6000)).split('sales recorded')[1]?.slice(0, 500);
  S.save();
  return { member: S.st.fixture.members.walkin, afterPay: st.afterPay, list, network: st.network };
}
