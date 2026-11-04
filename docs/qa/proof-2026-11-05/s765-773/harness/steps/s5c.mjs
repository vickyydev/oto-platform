export default async function (S) {
  const { text, LOOK, lookup, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  await lookup(page, S.st.fixture.members.nowallet.phone);
  await page.getByText('Local pricing', { exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: LOOK });
  return { dialog: (await dlg.innerText()).slice(0, 1500), buttons: await dlg.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim())), inputs: await dlg.locator('input').evaluateAll((els) => els.map((e) => ({ type: e.type, label: e.getAttribute('aria-label'), id: e.id, ph: e.placeholder }))) };
}
