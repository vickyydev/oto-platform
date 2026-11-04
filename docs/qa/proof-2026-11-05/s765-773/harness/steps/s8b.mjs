export default async function (S) {
  const page = S.pages.till.page;
  const st = S.st.steps.s8;
  const dlg = page.getByRole('dialog');
  await dlg.locator('#tier-evidence-note').fill('Work permit');
  await dlg.locator('#tier-evidence-expiry').fill('2025-01-31');
  await page.waitForTimeout(600);
  const verify = dlg.getByRole('button', { name: /^Verify Thai/ });
  st.pastDate = { value: '2025-01-31', verifyDisabled: await verify.isDisabled(), dialog: (await dlg.innerText()).slice(0, 1200) };
  if (!st.pastDate.verifyDisabled) {
    await verify.click();
    await page.waitForTimeout(1500);
    st.pastDate.afterClick = (await dlg.count()) ? (await dlg.innerText()).slice(0, 1200) : 'dialog closed';
  }
  await S.shot('till', 's773-st-08b-other-past-expiry-refused');
  S.save();
  return st.pastDate;
}
