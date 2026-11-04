export default async function (S) {
  const { text, LOOK, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  let phone = null;
  for (let n = 77321; n < 77330; n += 1) {
    const p = '+668976' + String(n).padStart(5, '0');
    const look = await S.pageApi('till', 'GET', '/members/lookup?phone=' + encodeURIComponent(p));
    if (look.status === 404 || (look.status === 200 && !look.body?.member)) { phone = p; break; }
  }
  if (!phone) throw new Error('no free phone');
  S.st.fixture.walkInPhone = phone; S.save();
  const digits = phone.replace(/^\+66/, '');
  for (const d of digits) await page.getByRole('button', { name: d, exact: true }).last().click();
  const nick = page.getByPlaceholder(/nickname/i).last();
  const nickCount = await nick.count();
  if (nickCount) await nick.fill('ZZ TEST 773 Walk-in');
  else await page.locator('input').last().fill('ZZ TEST 773 Walk-in');
  await page.waitForTimeout(600);
  await page.screenshot({ path: LOOK });
  return { nickCount, text: (await text(page, 5000)).split('YOUR TURN')[1]?.slice(0, 400) };
}
